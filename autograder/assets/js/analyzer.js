/* AutoGrader · 文档体检与证据核验（Document Triage & Evidence Verification）
 *
 * 【重大变更 · 2026-09】需求计划待确认问题①「本地评分是否保留」→ 结论：不保留。
 * 本模块原先的本地启发式评分引擎（grade / scoreDimension / qualityFactor /
 * STRUCT_BOOST / depthCap）已整体移除，理由写在文末「为什么删」。
 *
 * 现在它只做三件**不产生分数**的事：
 *   1. 文体门禁 genreCheck —— 回答「这东西能不能评」（闸门，不是分）
 *   2. 查重 similarity —— 回答「这些文档之间像不像」（比对，不是分）
 *   3. 证据核验 verifyEvidence —— 回答「模型引用的原文是不是编的」（查证，不是分）
 *
 * 三件事的共同点：都是**可判定的事实核查**，而不是对质量的估值。
 * 关键词匹配做事实核查尚可（"这段话里有没有'误差分析'四个字"是有标准答案的），
 * 用它给质量估值则不可靠（"提到了就算写到"会漏掉写得对不对）。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ============================================================
   * 一、文体门禁（Genre Gate）
   * ------------------------------------------------------------
   * 为什么本地引擎删了这道闸门还得留：
   * 「有没有资格被评」和「评得多少分」是两类问题。前者是结构性事实，
   * 用统计抓得住；后者需要语义理解，只能交给模型。
   * 没有这道闸门，交一篇小说上来也会被模型认真打一遍分并给出改进建议，
   * 那是比打零分更糟的结果——它会让学生以为自己交的是对的。
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
        lexHit.length + ' 个、数据 ' + (f.numberCount || 0) + ' 处），建议人工确认后再评阅');
    }

    const confidence = (verdict === 'report' && R >= 5) || (verdict === 'offtopic' && N >= 3.5) ? 'high' : 'mid';
    return { verdict, reportEvidence: detail.reportEvidence, narrativeEvidence: detail.narrativeEvidence, confidence, reasons, signals: detail };
  }

  /* ============================================================
   * 二、查重（Similarity）
   * ------------------------------------------------------------
   * 需求计划待确认问题③「查重范围界定」→ 结论：暂不界定，先做成可切换的开关。
   * 原需求原文：「同一文档来自不同用户提交时才触发查重；当前版本仅面向单一用户，
   *              功能范围待定。」
   *
   * 所以这里不预设答案，而是把两种范围都实现好，默认跑「当前批次」，
   * 等范围定下来切一下 scope 即可——比现在拍脑袋定死一个范围更稳。
   *   batch     当前批次内两两比较（默认，单人场景够用）
   *   crossUser 仅当高度相似的文档来自**不同提交者**时才计入可疑
   * ============================================================ */

  const SCOPES = {
    batch: { id: 'batch', label: '当前批次内', desc: '比较本批次录入的全部文档，不区分提交者' },
    crossUser: { id: 'crossUser', label: '跨提交者', desc: '仅当相似文档来自不同提交者时判定为可疑' },
  };

  /** 可疑阈值：5-gram Jaccard ≥ 0.45。定得比"逐字复制"松，因为改写也算抄。 */
  const SUSPICION_THRESHOLD = 0.45;

  /**
   * 计算文档两两相似度（5-gram Jaccard）
   * @param {Array} docs  [{ text, submitter? }]
   * @param {Object} opts { scope: 'batch'|'crossUser', threshold: number }
   * @returns {{matrix:number[][], pairs:Array, suspicious:Array, scope:string, scopeLabel:string}}
   */
  function similarity(docs, opts) {
    opts = opts || {};
    const scope = SCOPES[opts.scope] ? opts.scope : 'batch';
    const threshold = opts.threshold == null ? SUSPICION_THRESHOLD : Number(opts.threshold);

    const sets = docs.map((d) => U.shingles(d.text, 5));
    const n = docs.length;
    const matrix = [];
    const pairs = [];
    for (let i = 0; i < n; i++) {
      matrix[i] = [];
      for (let j = 0; j < n; j++) {
        const v = i === j ? 1 : U.jaccard(sets[i], sets[j]);
        matrix[i][j] = U.round(v, 3);
        if (j > i) {
          pairs.push({
            a: i, b: j, value: U.round(v, 3),
            aName: docs[i].name, bName: docs[j].name,
            aSubmitter: docs[i].submitter || null,
            bSubmitter: docs[j].submitter || null,
          });
        }
      }
    }
    pairs.sort((x, y) => y.value - x.value);

    /* 跨提交者模式：同一人自己交的两版相似文档不算抄袭，过滤掉 */
    const crossUserApplied = scope === 'crossUser';
    const suspicious = pairs.filter((p) => {
      if (p.value < threshold) return false;
      if (!crossUserApplied) return true;
      const sa = p.aSubmitter, sb = p.bSubmitter;
      // 提交者信息缺失时无法判定「跨人」，保守起见仍计入可疑并标注待确认
      if (!sa || !sb) return true;
      return sa !== sb;
    });

    return {
      matrix, pairs, suspicious,
      scope,
      scopeLabel: SCOPES[scope].label,
      threshold,
      // 范围待定：原需求里跨用户维度尚未定稿，UI 需要如实告知而不是假装结论已定
      scopeNote: crossUserApplied
        ? '跨提交者模式：仅当相似文档来自不同提交者时判定为可疑；未标注提交者的文档一律计入，需人工确认。'
        : '当前批次模式：不区分提交者，两两比较。查重范围尚未定稿，可在设置中切换。',
      pendingScope: true,
    };
  }

  /* ============================================================
   * 三、证据核验（Evidence Verification）
   * ------------------------------------------------------------
   * 本地评分砍掉之后，本地计算唯一还值得保留的升级方向就是**给模型挑错**。
   * 模型给的 evidence 是它自己复述的原文，存在两种失真：
   *   1. 幻觉 —— 报告里根本没这句话，它编了一条来支撑自己给的分
   *   2. 改写 —— 用了近义表述，大意对但字面对不上
   * 前者必须标出来（会导致教师误信），后者可以放行（允许模型转述）。
   * 这是字符串比对能做的事：它不判断"这个证据好不好"，只判断"这句话在不在"。
   * ============================================================ */

  /** 归一化：去掉空白与常见标点，避免"误差分析，"和"误差分析"被判成两条 */
  function normalize(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[，。；：、！？,.;:!?""''（）()【】\[\]]/g, '');
  }

  /**
   * 核验一批证据片段是否真实出现在原文。
   * @param {string} text     报告原文
   * @param {Array}  evidence [{ label }] 或字符串数组
   * @returns {{items:Array, verified:number, total:number, rate:number, hallucinated:Array}}
   */
  function verifyEvidence(text, evidence) {
    const src = normalize(text);
    const list = (evidence || []).map((e) => (typeof e === 'string' ? e : (e && e.label) || '')).filter(Boolean);
    const items = list.map((raw) => {
      const q = normalize(raw);
      // 太短的片段（<4 字）不具备判定价值：任何报告里都能找到
      if (q.length < 4) return { text: raw, status: 'unverifiable', note: '片段过短，无法核验' };
      if (src.indexOf(q) >= 0) return { text: raw, status: 'exact' };

      // 退一步：按 2-gram 覆盖率判断是否「改写复述」
      const cov = bigramCoverage(q, src);
      if (cov >= 0.6) return { text: raw, status: 'paraphrased', coverage: U.round(cov, 3) };
      if (cov >= 0.3) return { text: raw, status: 'weak', coverage: U.round(cov, 3) };
      return { text: raw, status: 'hallucinated', coverage: U.round(cov, 3) };
    });

    const count = (s) => items.filter((x) => x.status === s).length;
    const verifiable = items.filter((x) => x.status !== 'unverifiable');
    return {
      items,
      total: items.length,
      verified: count('exact') + count('paraphrased'),
      exact: count('exact'),
      paraphrased: count('paraphrased'),
      weak: count('weak'),
      hallucinated: items.filter((x) => x.status === 'hallucinated'),
      rate: verifiable.length ? U.round((count('exact') + count('paraphrased')) / verifiable.length, 3) : 1,
    };
  }

  /** 查询串的二元组有多大比例出现在目标文本中 */
  function bigramCoverage(query, target) {
    if (query.length < 2) return 0;
    const grams = [];
    for (let i = 0; i < query.length - 1; i++) grams.push(query.slice(i, i + 2));
    if (!grams.length) return 0;
    const hit = grams.filter((g) => target.indexOf(g) >= 0).length;
    return hit / grams.length;
  }

  /* ============================================================
   * 为什么删掉本地评分（存档说明）
   * ------------------------------------------------------------
   * 1. 口径对不齐：需求②「评分准则」要求"指导 AI 给出比直接丢给 AI 更可靠的结果"。
   *    本地引擎靠正则命中给分，与模型的语义判断天然两套口径，
   *    再拿它当"第二意见"，等于拿一个更差的裁判去监督更好的裁判。
   * 2. 篇幅即分数：本地引擎把字数写进了动态满分上限与质量系数，
   *    写得长就分高。这是教育评分里最该避免的偏差，而且它无法自证清白——
   *    reliability.lengthBias 只能"报告"这个偏差，改不掉。
   * 3. 双语代价：信号词典是中文写的，英文报告大面积漏匹配，
   *    原实现只能靠弹一句"我不擅长英文"免责，等于把缺陷转嫁给用户。
   * 4. 维护成本：每加一个专业方向就要补一套词典，而模型的零样本泛化是免费的。
   *
   * 保留下来的三类能力（门禁 / 查重 / 证据核验）都是**事实核查**而非**质量估值**，
   * 关键词匹配干这个活是称职的。
   * ============================================================ */

  AG.analyzer = {
    genreCheck,
    similarity,
    verifyEvidence,
    SCOPES,
    SUSPICION_THRESHOLD,
  };
})(window);
