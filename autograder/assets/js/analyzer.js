/* AutoGrader · 本地启发式评分引擎（Local Engine）
 * 设计目标：在没有大模型 API Key 的情况下，依然能跑通「上传 → 逐项核查 → 得分 → 评语」的完整闭环，
 * 保证演示与断网场景可用；同时它也是 LLM 模式失败时的降级兜底。
 *
 * 评分思路（可解释优先）：
 *   1. 对每个维度，用信号词典做证据匹配，得到覆盖率 raw（命中权重 / 总权重）
 *   2. 叠加结构化特征加成（代码块、图表、数据密度、标题层级等）
 *   3. 减去扣分项，映射到 [0, 维度满分]
 *   4. 用整体质量系数（篇幅 / 结构 / 数据密度）微调总分
 * 所有中间量（命中证据、缺失项、扣分项）都会输出到报告，做到「每一分都有出处」。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* 各维度可叠加的结构化特征加成（上限 0.25） */
  const STRUCT_BOOST = {
    code(f) {
      let b = 0;
      if (f.codeBlockCount > 0) b += 0.15;
      if (f.codeLines >= 20) b += 0.05;
      if (f.codeLines >= 60) b += 0.03;
      return b;
    },
    result(f) {
      let b = 0;
      if (f.numberCount >= 5) b += 0.10;
      if (f.figureCount > 0) b += 0.08;
      if (f.tableCount > 0) b += 0.07;
      return b;
    },
    analysis(f) {
      let b = 0;
      if (f.numberDensity >= 1.5) b += 0.06;
      if (f.words >= 800) b += 0.04;
      return b;
    },
    format(f) {
      let b = 0;
      if (f.headingCount >= 4) b += 0.15;
      if (f.referenceCount > 0) b += 0.10;
      return b;
    },
    env(f) { return f.numberCount >= 3 ? 0.05 : 0; },
  };

  /** 在文本中查找信号，返回证据片段与总命中次数 */
  function findEvidence(text, re, limit) {
    const out = [];
    let count = 0;
    let m;
    const rx = new RegExp(re.source, 'g');
    let guard = 0;
    while ((m = rx.exec(text)) !== null && guard++ < 200) {
      count++;
      if (out.length < (limit || 3)) {
        const start = Math.max(0, m.index - 12);
        const end = Math.min(text.length, m.index + m[0].length + 28);
        let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = '…' + snippet;
        if (end < text.length) snippet = snippet + '…';
        out.push({ hit: m[0].slice(0, 24), snippet });
      }
    }
    out.count = count;
    return out;
  }

  /**
   * 动态满分上限：报告越厚实（篇幅、数据量、代码量、引用），可达到的比例上限越高。
   * 避免出现「关键词都点到就满分」的天花板效应——满分需要深度，不只是覆盖面。
   */
  function depthCap(f) {
    let d = 0;
    if (f.words >= 800) d += 0.30;
    if (f.words >= 1500) d += 0.20;
    if (f.numberCount >= 10) d += 0.20;
    if (f.codeLines >= 30) d += 0.15;
    if (f.referenceCount > 0) d += 0.15;
    return 0.88 + 0.12 * Math.min(1, d);
  }

  /** 计算整体质量系数：只有「过短 / 结构缺失 / 无数据」才拉低，且幅度收敛。
   *  字数阈值刻意压得很低——一份 300 字的物理实验报告完全可能是完整的，
   *  用字数去惩罚精炼的理科写作是不公平的。 */
  function qualityFactor(f) {
    let q = 1.0;
    if (f.words < 80) q -= 0.25;
    else if (f.words < 150) q -= 0.12;
    else if (f.words < 300) q -= 0.05;
    if (f.words >= 300) {
      if (f.headingCount === 0) q -= 0.05;
      if (f.numberCount === 0) q -= 0.05;
    }
    if (f.words > 3000) q += 0.02;
    return U.clamp(q, 0.85, 1.05);
  }

  /* ============================================================
   * 文体门禁（Genre Gate）
   * ------------------------------------------------------------
   * 本地引擎靠关键词匹配，读不懂语义，因此天然分不清
   * 「一份写得很差的实验报告」和「一篇被误传上来的小说」。
   * 但文体特征是结构性的，用统计抓得住：
   *   报告 → 章节标题、数据、实验语域词、参考文献；
   *   小说 → 对话引号、叙事动词、「第 N 章」、比喻密集。
   * 没有这道闸门，零证据维度会靠 ratio 地板白拿 30% 的分，
   * 于是「交一篇小说也能拿三十几分」——这是最伤可信度的一种错。
   * ============================================================ */

  /** 报告语域词：命中即视为报告文体证据（去重后按数量分档）。
   *  中英双语——只放中文会让英文实验报告被误判成离题，那是无法接受的误杀。 */
  const REPORT_LEX = [
    '实验', '目的', '原理', '步骤', '方法', '仪器', '器材', '装置', '设备', '数据',
    '结果', '分析', '讨论', '结论', '误差', '不确定度', '测量', '验证', '测试',
    '摘要', '引言', '背景', '参考文献', '附录', '样本', '问卷', '访谈', '调研',
    '模型', '算法', '实现', '性能', '评估', '对比', '文献', '综述', '假设', '变量',
    '拟合', '标定', '采样', '参数', '指标', '统计', '显著性', '对照组',
    'experiment', 'objective', 'purpose', 'principle', 'procedure', 'method',
    'apparatus', 'equipment', 'setup', 'data', 'result', 'analysis', 'discussion',
    'conclusion', 'error', 'uncertainty', 'measurement', 'abstract', 'introduction',
    'reference', 'figure', 'table', 'algorithm', 'implementation', 'evaluation',
    'dataset', 'accuracy', 'precision', 'calibration', 'hypothesis', 'variable',
  ];

  /** 叙述性标记：小说 / 散文 / 剧本的用词习惯（同样双语） */
  const NARRATIVE_LEX = [
    '他说', '她说', '我说', '问道', '回答', '笑了', '哭了', '心里想', '忽然',
    '转身', '回头', '低声', '喃喃', '叹息', '沉默', '望着', '想起', '记得',
    '微微', '静静', '缓缓', '不由得', '忍不住', '眼神', '嘴角', '指尖', '背影',
    'he said', 'she said', 'whispered', 'smiled', 'sighed', 'gazed', 'stared',
    'once upon', 'suddenly', 'whisper', 'tears', 'glanced',
  ];

  const CHAPTER_RE = /第[一二三四五六七八九十百零\d]+[章节回幕]|chapter\s*\d+/gi;
  const QUOTE_RE = /[“"][^”"]{2,}[”"]/g;
  const HEADING_RE = /^\s*(#{1,6}\s|\d+[.、)]\s|[一二三四五六七八九十]+[、.]\s)/gm;
  const SENT_SPLIT_RE = /[。！？!?\n]/g;
  const SIMILE_RE = /像|仿佛|好似|犹如|如同/g;

  /**
   * 判定文档是否属于「可评阅的报告文体」。
   * @returns {{verdict:'report'|'suspicious'|'offtopic'|'empty',
   *            reportEvidence:number, narrativeEvidence:number,
   *            confidence:string, reasons:string[], signals:Object}}
   */
  function genreCheck(text, features) {
    const src = text || '';
    const f = features || {};
    const reasons = [];
    const detail = {};

    /* —— 闸门 0：内容太少，无从评阅 ——
     * 长度取「中文字数与英文词数的较大者」：只数中文会把英文作业一刀切成空文档，
     * 那种误杀比漏判离题严重得多。 */
    const cjk = (src.match(/[\u4e00-\u9fa5]/g) || []).length;
    const latin = (src.match(/[A-Za-z]+/g) || []).length;
    const words = f.words || 0;
    const len = Math.max(cjk, latin, words);
    if (len < 40) {
      return {
        verdict: 'empty', reportEvidence: 0, narrativeEvidence: 0, confidence: 'high',
        reasons: ['有效内容过少（中文 ' + cjk + ' 字 / 英文 ' + latin + ' 词），不具备评阅基础'],
        signals: { cjk, latin, words },
      };
    }

    /* —— 报告性证据 R —— */
    let R = 0;
    const headings = (src.match(HEADING_RE) || []).length;
    if (headings >= 2) R += 2; else if (headings >= 1) R += 1;
    detail.headings = headings;

    const lower = src.toLowerCase();   // 英文语域词要大小写不敏感，否则 "Experiment" 会被漏掉
    const lexHit = REPORT_LEX.filter((w) => lower.indexOf(w.toLowerCase()) >= 0);
    if (lexHit.length >= 8) R += 3;
    else if (lexHit.length >= 4) R += 2;
    else if (lexHit.length >= 2) R += 1;
    detail.reportLex = lexHit.length;

    if (f.numberCount >= 5 || f.numberDensity >= 0.8) R += 1.5;
    else if (f.numberCount >= 2) R += 0.5;
    detail.numbers = f.numberCount || 0;

    if (f.tableCount > 0 || f.figureCount > 0 || /图\s*\d|表\s*\d/.test(src)) R += 1;
    if (f.referenceCount > 0 || /参考文献|\[\d+\]/.test(src)) R += 1;
    if (/实验|报告|分析|研究|调查|设计|实现|论文|experiment|report|lab|analysis/i.test(src.slice(0, 60))) R += 1;
    detail.reportEvidence = U.round(R, 2);

    /* —— 叙述性证据 N —— */
    let N = 0;
    const quotes = (src.match(QUOTE_RE) || []).length;
    const sentences = Math.max(1, (src.match(SENT_SPLIT_RE) || []).length);
    const quoteRate = quotes / sentences;
    if (quotes >= 3 && quoteRate >= 0.12) N += 2;
    else if (quotes >= 6) N += 1;
    detail.quotes = quotes; detail.quoteRate = U.round(quoteRate, 3);

    const narHit = NARRATIVE_LEX.filter((w) => lower.indexOf(w.toLowerCase()) >= 0);
    if (narHit.length >= 5) N += 1.5;
    else if (narHit.length >= 3) N += 1;
    detail.narrativeLex = narHit.length;

    const chapters = (src.match(CHAPTER_RE) || []).length;
    if (chapters >= 2) N += 1.5;
    else if (chapters === 1) N += 0.5;
    detail.chapters = chapters;

    const simile = (src.match(SIMILE_RE) || []).length;
    if (simile >= 4) N += 1;
    detail.simile = simile;
    detail.narrativeEvidence = U.round(N, 2);

    /* —— 判定 —— */
    let verdict = 'report';
    if (R <= 1.5 && N >= 2.5) {
      verdict = 'offtopic';
      reasons.push('通篇为叙述性文本：对话引号 ' + quotes + ' 处（占句数 ' +
        Math.round(quoteRate * 100) + '%）、叙事性用词 ' + narHit.length + ' 处' +
        (chapters >= 2 ? '、含「第 N 章」章节体 ' + chapters + ' 处' : ''));
      reasons.push('未检出报告文体特征：章节标题 ' + headings + ' 个、实验语域词 ' +
        lexHit.length + ' 个、数据 ' + (f.numberCount || 0) + ' 处');
    } else if (R <= 1) {
      verdict = 'offtopic';
      reasons.push('几乎不含报告文体特征（章节标题 ' + headings + ' 个、实验语域词 ' +
        lexHit.length + ' 个、数据 ' + (f.numberCount || 0) + ' 处），无法按量表评阅');
    } else if (R <= 3) {
      verdict = 'suspicious';
      reasons.push('报告文体特征较弱（章节标题 ' + headings + ' 个、实验语域词 ' +
        lexHit.length + ' 个、数据 ' + (f.numberCount || 0) + ' 处），已按可疑文档降权处理');
    }

    const confidence = (verdict === 'report' && R >= 5) || (verdict === 'offtopic' && N >= 3.5) ? 'high' : 'mid';
    return { verdict, reportEvidence: detail.reportEvidence, narrativeEvidence: detail.narrativeEvidence, confidence, reasons, signals: detail };
  }

  /** 对单个维度评分 */
  function scoreDimension(dim, text, features) {
    let matched = 0, total = 0;
    const evidence = [];
    const missing = [];

    (dim.signals || []).forEach((sig) => {
      total += sig.w;
      const hits = findEvidence(text, sig.re, 2);
      if (hits.count > 0) {
        // 证据强度：命中 1 次算 85%（写到了就该拿大部分分），2 次 92.5%，3 次及以上满分。
        // 旧值是 0.60/0.80/1.00，把「只提了一次但确实写了」的内容压得过狠，
        // 是本地引擎整体分数偏低的主要来源之一。
        const strength = U.clamp(0.85 + 0.075 * (hits.count - 1), 0.85, 1);
        matched += sig.w * strength;
        evidence.push({ label: sig.label, weight: sig.w, strength: U.round(strength, 2), hits: hits.count, snippets: hits });
      } else {
        missing.push({ label: sig.label, weight: sig.w });
      }
    });

    const raw = total > 0 ? matched / total : 0;
    const boost = STRUCT_BOOST[dim.id] ? STRUCT_BOOST[dim.id](features) : 0;
    const cap = depthCap(features);
    // 覆盖率 → 达成率：凹映射。
    // 教育评分里「覆盖了 60% 的要点」通常对应 75% 左右的达成度，而不是 60%——
    // 核心要点写到了就该拿到大部分分，剩下的分留给深度与完整性。
    // 关键改动：不再有 0.30 的无条件地板。零证据就是零分，
    // 否则一篇小说也能靠「每个维度白送三成分」拿到三十几分。
    const ratio = U.clamp(cap * Math.sqrt(U.clamp(raw + boost, 0, 1)), 0, cap);

    let penalty = 0;
    const penalties = [];
    (dim.penalties || []).forEach((p) => {
      if (new RegExp(p.re.source, p.re.flags.replace('g', '')).test(text)) {
        penalty += p.w;
        penalties.push({ label: p.label, weight: p.w });
      }
    });

    const max = Number(dim.max) || 0;
    const score = U.clamp(max * ratio - penalty, 0, max);

    return {
      id: dim.id,
      name: dim.name,
      desc: dim.desc,
      advice: dim.advice,
      max,
      score: U.round(score, 1),
      ratio: U.round(score / (max || 1), 3),
      raw: U.round(raw, 3),
      boost: U.round(boost, 3),
      cap: U.round(cap, 3),
      penalty,
      evidence,
      missing,
      penalties,
    };
  }

  /**
   * 生成该维度的评语。
   * 文案本身交给 AG.voice（语气人格引擎），这里只负责算数——
   * 这样「换语气」不需要动评分逻辑，评分逻辑也不需要关心文案。
   */
  function commentFor(d, idx) {
    if (AG.voice) return AG.voice.dimComment(d, null, idx);
    const r = d.ratio;
    if (r >= 0.85) return `${d.name}：完成度高，${d.evidence.slice(0, 2).map((e) => e.label).join('、')}均有体现。`;
    if (r >= 0.70) return `${d.name}：整体达标，若能补充「${(d.missing[0] || {}).label || '关键要素'}」会更完整。`;
    if (r >= 0.50) return `${d.name}：覆盖一般，缺少 ${d.missing.slice(0, 2).map((m) => '「' + m.label + '」').join('、') || '关键内容'}。${d.advice || ''}`;
    return `${d.name}：明显不足，${d.missing.slice(0, 3).map((m) => '「' + m.label + '」').join('、') || '核心要素缺失'}。${d.advice || ''}`;
  }

  /**
   * 生成总评。文案由 AG.voice 按当前人格输出。
   * 关键点（人格内部已保证）：强/弱项措辞必须看「绝对达成率」而非相对排名——
   * 一份 60 分的报告里最强的维度也可能只有 0.6，此时夸它"表现较好"是失真的。
   */
  function overallComment(total, dims) {
    const g = AG.rubric.gradeOf(total);
    if (AG.voice) return AG.voice.overall(total, dims, g);

    const weak = dims.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 2)
      .map((d) => `${d.name}（${d.score}/${d.max}）`);
    const strong = strongPart(dims);

    // 整体定性与收尾建议：跟随总分档位
    let verdict, tail;
    if (total >= 85) {
      verdict = '整体表现优秀';
      tail = '，可在上述失分项上进一步精修以达到满分水准';
    } else if (total >= 75) {
      verdict = '整体达到良好水平';
      tail = '，建议针对上述失分区补充后再次提交';
    } else if (total >= 60) {
      verdict = '仅达及格线，整体质量偏弱';
      tail = '，上述失分区需实质补充，否则难以满足课程要求';
    } else {
      verdict = '未达及格要求，需要较大幅度修改';
      tail = '，建议根据上述失分区重点重写后再提交';
    }

    return `本报告综合得分 ${total} 分（${g.grade} 级 · ${g.label}），${verdict}。` +
      `${strong}；${weak.join('、')}是主要失分区${tail}。`;
  }

  /** 强项措辞：按最高达成率分档（voice 未加载时的兜底） */
  function strongPart(dims) {
    const byRatio = dims.slice().sort((a, b) => b.ratio - a.ratio);
    const top = byRatio[0], top2 = byRatio[1];
    if (top && top.ratio >= 0.85) {
      const list = [top.name].concat(top2 && top2.ratio >= 0.85 ? [top2.name] : []);
      return `${list.join('、')}完成度高`;
    }
    if (top && top.ratio >= 0.70) {
      const list = [top.name].concat(top2 && top2.ratio >= 0.70 ? [top2.name] : []);
      return `${list.join('、')}基本达标`;
    }
    if (top) return `相对而言 ${top.name} 写得较为完整，但各项均未达理想水平`;
    return '各维度均存在明显欠缺';
  }

  /**
   * 评分主入口
   * @param {{name,text,features}} doc
   * @param {Array} rubric
   * @returns 评分结果对象
   */
  function grade(doc, rubric, opts) {
    opts = opts || {};
    const text = doc.text || '';
    const features = doc.features || AG.parser.extractFeatures(text);
    const dims = (rubric || AG.rubric.DEFAULT_RUBRIC).map((dim) => scoreDimension(dim, text, features));
    dims.forEach((d, i) => { d.comment = commentFor(d, i); });

    const q = qualityFactor(features);
    const rawTotal = dims.reduce((s, d) => s + d.score, 0);
    let total = U.clamp(U.round(rawTotal * q, 1), 0, 100);

    /* —— 文体门禁：不是报告文体的东西，不该拿到「辛苦分」——
     * skipGenre 用于用户手动申诉「我判错了，按正常评分重算」。 */
    const gate = opts.skipGenre ? null : genreCheck(text, features);
    let overall;
    if (gate && (gate.verdict === 'offtopic' || gate.verdict === 'empty')) {
      total = 0;
      dims.forEach((d) => {
        d.score = 0;
        d.ratio = 0;
        d.comment = '未计入评分——文档未通过文体校验。';
      });
      overall = '本文档未通过文体校验，判定为「非实验报告类文档」，总分记为 0 分。' +
        gate.reasons.join('；') + '。若确为误判，可点「按正常评分重算」忽略这道校验。';
    } else if (gate && gate.verdict === 'suspicious') {
      total = U.clamp(U.round(total * 0.6, 1), 0, 100);
      overall = '⚠ 本文档的报告文体特征较弱，总分已按 60% 折算：' +
        gate.reasons.join('；') + '。' + overallComment(total, dims);
    } else {
      overall = overallComment(total, dims);
    }

    const g = AG.rubric.gradeOf(total);

    /* 语言提示：本地信号词典是中文写的，英文报告一条都匹配不上，
     * 分数会低得离谱。与其给个看似客观的低分，不如明说自己不擅长。 */
    let langNote = '';
    const cjkN = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const latN = (text.match(/[A-Za-z]+/g) || []).length;
    if (latN > 60 && cjkN / Math.max(1, latN + cjkN) < 0.25) {
      langNote = '检测到本文档以英文为主（中文 ' + cjkN + ' 字 / 英文 ' + latN +
        ' 词）。本地启发式引擎的信号词典以中文撰写，英文报告会大面积漏匹配，' +
        '分数会明显失真——建议在「量表与模型」中配置大模型 API Key 后重新评阅。';
    }

    return {
      docName: doc.name,
      engine: 'local',
      engineLabel: '本地启发式引擎',
      total,
      langNote,
      qualityFactor: U.round(q, 3),
      grade: g.grade,
      gradeLabel: g.label,
      gradeColor: g.color,
      dims,
      features,
      gate: gate || null,
      overall,
      gradedAt: Date.now(),
    };
  }

  /* ---------- 批量：相似度查重 ---------- */
  /**
   * 计算文档两两相似度（5-gram Jaccard）
   * @returns {{matrix:number[][], pairs:Array}}
   */
  function similarity(docs) {
    const sets = docs.map((d) => U.shingles(d.text, 5));
    const n = docs.length;
    const matrix = [];
    const pairs = [];
    for (let i = 0; i < n; i++) {
      matrix[i] = [];
      for (let j = 0; j < n; j++) {
        const v = i === j ? 1 : U.jaccard(sets[i], sets[j]);
        matrix[i][j] = U.round(v, 3);
        if (j > i) pairs.push({ a: i, b: j, value: U.round(v, 3) });
      }
    }
    pairs.sort((x, y) => y.value - x.value);
    return { matrix, pairs, suspicious: pairs.filter((p) => p.value >= 0.45) };
  }

  AG.analyzer = { grade, similarity, scoreDimension, qualityFactor, findEvidence, genreCheck };
})(window);
