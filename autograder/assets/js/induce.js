/* AutoGrader · 量表自动诱导引擎（Rubric Induction）
 *
 * 要解决的问题：评分量表通常由教师凭经验手写，存在两个系统性偏差——
 *   1. 要点选错：把「所有报告都会写」的东西列为得分点（例如"有总结"），这类要素零区分度，占分却拉不开差距
 *   2. 分值拍脑袋：25 分给"代码质量"、2 分给"格式"，往往凭直觉，缺少数据支撑
 *
 * 本引擎的思路（区分度驱动，而非频次驱动）：
 *   Given 教师标注的「优秀组 / 对照组」范文若干，对每个候选评分要点 e 计算
 *       pHi = 优秀组命中率,  pLo = 对照组命中率
 *       Δ(e) = pHi - pLo                    ← 区分度：该要点能否把好坏分开
 *       sup(e) = 命中样本占比                 ← 支持度：样本是否足够，防止单篇偶然
 *   只保留 Δ > 阈值 的要点，权重 w(e) = Δ · √sup，再按语义归维、归一化到 100 分。
 * 这样"人人都写"的要素自动被剔除，真正拉开差距的要素自动获得高分值。
 *
 * 纯前端实现，不依赖分词库：中文术语用 n-gram + 凝固度剪枝抽取。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* 停用词：出现在 n-gram 首尾多半无意义 */
  const STOP = new Set(('的 了 和 是 在 我 有 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 些 么 什 为 与 及 或 但 而 其 之 以 于 对 从 被 把 给 让 使 由 该 此 各 每 该 本 中 下 里 后 前 大 小 多 少 更 最 很 太 再 又 还 只 才 就 都 也 又 as at by for in of on the to is are was were be been it this that these those with we our i you he she they can will may').split(/\s+/));

  /* 维度归属：候选要素关键词 → 标准维度。保证诱导出的量表与默认量表同构、可直接替换 */
  const DIM_ANCHORS = [
    { id: 'purpose', name: '实验目的与原理', keys: ['目的', '目标', '原理', '背景', '意义', '理论', '掌握', '复杂度', '算法思想', '旨在'] },
    { id: 'env', name: '实验环境与步骤', keys: ['环境', '步骤', '配置', '依赖', '版本', '安装', '系统', '操作系统', '过程', '复现', '运行'] },
    { id: 'code', name: '核心实现与代码质量', keys: ['代码', '实现', '函数', '类', '模块', '设计', '架构', '注释', '异常', '边界', '封装'] },
    { id: 'result', name: '实验结果与数据', keys: ['结果', '数据', '输出', '截图', '图表', '测试', '表格', '指标', '运行', '性能', '耗时'] },
    { id: 'analysis', name: '结果分析与讨论', keys: ['分析', '讨论', '对比', '趋势', '原因', '表明', '验证', '差异', '归因', '解释'] },
    { id: 'debug', name: '问题与解决', keys: ['问题', '错误', '报错', '异常', '解决', '调试', '修复', '排查', 'bug', '失败'] },
    { id: 'summary', name: '总结与反思', keys: ['总结', '结论', '收获', '反思', '改进', '展望', '不足', '体会'] },
    { id: 'format', name: '格式规范与引用', keys: ['参考文献', '引用', '格式', '排版', '编号', '标题'] },
  ];

  const STRUCT_SIGNALS = [
    { id: 's_heading', label: '具备多级标题结构', test: (f) => f.headingCount >= 3 },
    { id: 's_code', label: '包含代码块', test: (f) => f.codeBlockCount > 0 },
    { id: 's_codelines', label: '代码量充实（≥20 行）', test: (f) => f.codeLines >= 20 },
    { id: 's_table', label: '含数据表格', test: (f) => f.tableCount > 0 },
    { id: 's_figure', label: '含图表编号与说明', test: (f) => f.figureCount > 0 },
    { id: 's_number', label: '给出量化数据（≥5 处）', test: (f) => f.numberCount >= 5 },
    { id: 's_ref', label: '列出参考文献', test: (f) => f.referenceCount > 0 },
    { id: 's_words', label: '篇幅达标（≥800 字）', test: (f) => f.words >= 800 },
    { id: 's_dense', label: '数据密度高', test: (f) => f.numberDensity >= 1.5 },
  ];

  /* ---------------- 术语抽取 ---------------- */

  /** 切出候选术语：剔除代码块与标点后取 2~4 字 n-gram */
  function extractTerms(text, minFreq) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[A-Za-z0-9_\.\-\/]{2,}/g, ' ')          // 丢掉英文/数字串，避免代码残留
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。；：、,.!?！？;:()（）\[\]【】"'"'“”《》|]/g, '\u0001'); // 标点作硬边界
    const segs = clean.split('\u0001').filter((s) => s.length >= 2);
    const counter = new Map();

    segs.forEach((seg) => {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const g = seg.slice(i, i + n);
          if (STOP.has(g[0]) || STOP.has(g[g.length - 1])) continue;
          counter.set(g, (counter.get(g) || 0) + 1);
        }
      }
    });

    const min = minFreq || 2;
    let grams = Array.from(counter.entries())
      .filter(([g, c]) => c >= min && g.length >= 2)
      .map(([g, c]) => ({ term: g, freq: c }));

    // 凝固度剪枝：若 3-gram 频次与它的 2-gram 前缀完全相同，说明前者没有独立成词，丢弃短的
    const byTerm = new Map(grams.map((x) => [x.term, x.freq]));
    grams = grams.filter((x) => {
      if (x.term.length >= 4) return true;
      const longer = grams.filter((y) => y.term.length > x.term.length && y.term.includes(x.term));
      if (!longer.length) return true;
      const maxLonger = Math.max(...longer.map((y) => byTerm.get(y.term) || 0));
      return x.freq > maxLonger; // 只有明显更高频才保留短词
    });

    grams.sort((a, b) => (b.freq - a.freq) || (b.term.length - a.term.length));
    return grams;
  }

  /**
   * 批次共识术语：这一批作业里「大家都在写」的核心概念。
   *
   * 为什么要做：批次自适应只能在**现有维度**的空间里重分配权重，
   * 不能凭空发现新考点（README 第 12 节记着这条限制）。
   * 但「这批作业到底在写什么」其实可以从作业本身长出来 ——
   * 用已有的 n-gram + 凝固度剪枝抽每份的术语，再取交集，
   * 就得到一份**不需要老师预先编写**的检查清单。
   *
   * 用途是给复核线索，不直接参与打分：
   *   1. 某份报告漏掉了多数同学都写的概念 → 可能真的没覆盖本实验的核心
   *   2. 反过来，覆盖率极高却缺少直接证据 → 留意术语堆砌（这项在 app.js 里结合溯源判定）
   *
   * @param {Array} docs 形如 [{name, text}] 的文档列表
   * @param {Object} opts {minRatio 出现在多少比例的文档里才算共识，默认 0.6；
   *                       minDocs 最少几份文档才统计，默认 3；
   *                       minFreq 单份文档内术语最少出现几次，默认 2}
   */
  function consensusTerms(docs, opts) {
    const o = opts || {};
    const minRatio = o.minRatio || 0.6;
    const minDocs = o.minDocs || 3;
    const minFreq = o.minFreq || 2;

    const list = (docs || []).filter((d) => d && d.text);
    if (list.length < minDocs) {
      return { ok: false, total: list.length, note: '至少需要 ' + minDocs + ' 份带正文的报告才能统计共识术语（当前 ' + list.length + ' 份）' };
    }

    const perDoc = list.map((d) => new Set(extractTerms(d.text, minFreq).map((x) => x.term)));
    const counter = new Map();
    perDoc.forEach((set) => set.forEach((t) => counter.set(t, (counter.get(t) || 0) + 1)));

    const need = Math.ceil(list.length * minRatio);
    const raw = Array.from(counter.entries())
      .filter(([t, c]) => c >= need)
      .map(([term, count]) => ({ term, count, ratio: U.round(count / list.length, 2) }))
      .sort((a, b) => (b.count - a.count) || (b.term.length - a.term.length));

    // 子串合并：「哈希」和「哈希表」同现时只留更长的那个，否则清单会被半截词塞满
    const shared = raw.filter((x) => !raw.some((y) => y.term !== x.term && y.term.indexOf(x.term) >= 0 && y.count >= x.count));

    const missing = list
      .map((d, i) => ({ name: d.name, absent: shared.filter((t) => !perDoc[i].has(t.term)).map((t) => t.term) }))
      .filter((x) => x.absent.length)
      .sort((a, b) => b.absent.length - a.absent.length);

    return { ok: true, total: list.length, need, shared, missing, minFreq };
  }

  /** 抽取章节标题 */
  function extractSections(text) {
    const out = [];
    const re = /(?:^|\n)\s*(?:#{1,6}\s*([^\n]+)|([一二三四五六七八九十]+[、.]\s*[^\n]{1,30})|(\d+(?:\.\d+)?[、.]\s*[^\n]{1,30}))/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = (m[1] || m[2] || m[3] || '').trim().replace(/[：:]\s*$/, '');
      if (t && t.length <= 30) out.push(t);
    }
    return out;
  }

  /** 章节归一化：用于跨文档聚类 */
  function normSection(s) {
    return String(s).replace(/^\d+(\.\d+)*[、.]?\s*/, '').replace(/^[一二三四五六七八九十]+[、.]\s*/, '').trim();
  }

  /* ---------------- 要素命中判定 ---------------- */

  function makeProbe(kind, key) {
    if (kind === 'struct') {
      const s = STRUCT_SIGNALS.find((x) => x.id === key);
      return { label: s.label, hit: (doc) => (s.test(doc.features) ? 1 : 0) };
    }
    if (kind === 'section') {
      return {
        label: '设有「' + key + '」章节',
        hit: (doc) => (doc._sectionsNorm || []).some((s) => s === key || s.includes(key) || key.includes(s)) ? 1 : 0,
      };
    }
    // term
    return { label: '提及「' + key + '」', hit: (doc) => (doc.text || '').includes(key) ? 1 : 0 };
  }

  /* ---------------- 主算法 ---------------- */

  /**
   * 主算法入口。
   * @param {Array} highDocs  优秀组（features 已抽取）
   * @param {Array} lowDocs   对照组
   * @param {Object} opts     { minDelta, minSupport, maxTerms, totalScore, anchors }
   *   anchors —— 语义归维用的维度锚点，形如 [{id, name, keys[]}]。
   *   默认用内置的 8 个「通用编程实验」锚点；批次自适应时应传入**当前量表**的锚点，
   *   否则换了方向（如计算机网络实验）时术语会被强行归到那 8 个维度里，分值会歪。
   */
  function induce(highDocs, lowDocs, opts) {
    opts = opts || {};
    const anchors = opts.anchors || DIM_ANCHORS;
    const minDelta = opts.minDelta == null ? 0.20 : opts.minDelta;
    const minSupport = opts.minSupport == null ? 0.25 : opts.minSupport;
    const maxTerms = opts.maxTerms || 60;
    const maxPerDim = opts.maxItemsPerDim || 5;
    const total = opts.totalScore || 100;
    const SMOOTH = opts.smooth == null ? 0.5 : opts.smooth;

    const prep = (docs) => docs.map((d) => Object.assign({}, d, {
      _sectionsNorm: extractSections(d.text || '').map(normSection),
    }));
    const H = prep(highDocs || []);
    const L = prep(lowDocs || []);
    if (!H.length || !L.length) throw new Error('优秀组与对照组各至少需要 1 份范文');

    /* 1) 构造候选要素池 */
    const candidates = [];
    const MISC = { id: 'misc', name: '综合表现' };

    // 这批作业里连一行代码都没有时，「包含代码块」「代码量充实」对所有文档恒为 0，
    // 既提供零信息，又会在报告里留下让数据库老师莫名其妙的条目 —— 直接不进候选池
    const CODE_STRUCT = new Set(['s_code', 's_codelines']);
    const anyCode = H.concat(L).some((d) =>
      (d.features && ((d.features.codeBlockCount || 0) > 0 || (d.features.codeLines || 0) > 0)));

    // 1a. 结构化信号（固定 9 个，最具解释性、最不易过拟合）
    STRUCT_SIGNALS.forEach((s) => {
      if (!anyCode && CODE_STRUCT.has(s.id)) return;
      candidates.push({ kind: 'struct', key: s.id, dim: guessDim(s.label, anchors) || MISC });
    });

    // 1b. 章节（跨组出现过的；过长的标题是文档名而非章节，过拟合风险高，剔除）
    const secCounter = new Map();
    H.concat(L).forEach((d) => d._sectionsNorm.forEach((s) => secCounter.set(s, (secCounter.get(s) || 0) + 1)));
    const totalDocs = H.length + L.length;
    Array.from(secCounter.entries())
      .filter(([s, c]) => c >= 2 && s.length <= 12)
      .sort((a, b) => b[1] - a[1]).slice(0, 14)
      .forEach(([s]) => {
        const dim = guessDim(s, anchors);
        if (dim) candidates.push({ kind: 'section', key: s, dim });
      });

    // 1c. 术语（优秀组高频；无法归入任何标准维度的一律丢弃，避免堆到单一维度造成分值偏斜）
    const pool = new Map();
    H.forEach((d) => extractTerms(d.text, 2).slice(0, 400).forEach((g) => {
      pool.set(g.term, (pool.get(g.term) || 0) + g.freq);
    }));
    Array.from(pool.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, maxTerms)
      .forEach(([t]) => {
        const dim = guessDim(t, anchors);
        if (dim) candidates.push({ kind: 'term', key: t, dim });
      });

    /**
     * 2) 逐个计算区分度。
     *
     * 命中率做了拉普拉斯平滑（α = 0.5）：样本只有 3 份时，3/3 与 2/3 的原始 Δ 分别是
     * 1.0 和 0.667，而 3/3 与 0/3 全是 1.0 —— 大量要点并列第一，权重分配完全失去信息。
     * 平滑后同一批变成 0.75 / 0.5 / 0.25，差异被拉开，且极端 0/3 与 1/3 不再等价。
     * 代价是把 Δ 压缩了一点，换来的是权重分布可读 —— 对小样本批次这笔交易划算。
     */
    const rate = (docs, probe) => {
      if (!docs.length) return 0;
      const hits = docs.reduce((s, d) => s + probe.hit(d), 0);
      return (hits + SMOOTH) / (docs.length + 2 * SMOOTH);
    };

    const scored = [];
    const dropped = [];
    const seen = new Set();
    candidates.forEach((c) => {
      const sig = c.kind + '|' + c.key;
      if (seen.has(sig)) return;
      seen.add(sig);
      const probe = makeProbe(c.kind, c.key);
      const pHi = rate(H, probe);
      const pLo = rate(L, probe);
      const delta = pHi - pLo;
      const support = (pHi * H.length + pLo * L.length) / totalDocs;
      // 落选的要素也要留痕：批次自适应要靠它向教师解释「为什么这个要点被判零区分度」
      if (delta < minDelta || (support < minSupport && c.kind === 'term')) {
        dropped.push({
          kind: c.kind, key: c.key, dim: c.dim, label: probe.label,
          pHi: U.round(pHi, 3), pLo: U.round(pLo, 3),
          delta: U.round(delta, 3), support: U.round(support, 3),
          reason: support < minSupport ? '样本太少，结论不稳' : '区分度不足（人人会写或人人都写）',
        });
        return;
      }
      scored.push({
        kind: c.kind, key: c.key, dim: c.dim, label: probe.label,
        pHi: U.round(pHi, 3), pLo: U.round(pLo, 3),
        delta: U.round(delta, 3), support: U.round(support, 3),
        // 术语类容易过拟合单批范文（换个题目就不灵），权重打折；结构化信号最稳，足额计入
        weight: U.round(delta * Math.sqrt(support) * (c.kind === 'term' ? TERM_DISCOUNT : 1), 4),
      });
    });

    dedupe(scored);
    capPerDim(scored, maxPerDim, dropped);

    if (!scored.length) {
      throw new Error('两组范文未表现出可区分的特征（Δ 均低于阈值 ' + minDelta + '），请补充更有差异的范文');
    }

    /* 3) 归维并分配分值 */
    const groups = {};
    scored.forEach((s) => { (groups[s.dim.id] = groups[s.dim.id] || { dim: s.dim, items: [] }).items.push(s); });

    const sumW = scored.reduce((s, x) => s + x.weight, 0) || 1;
    let dims = Object.keys(groups).map((id) => {
      const g = groups[id];
      const w = g.items.reduce((s, x) => s + x.weight, 0);
      const raw = (w / sumW) * total;
      return {
        id: g.dim.id, name: g.dim.name,
        rawScore: U.round(raw, 2),
        weightSum: U.round(w, 4),
        share: U.round(w / sumW, 4),
        items: g.items.sort((a, b) => b.weight - a.weight),
      };
    }).filter((d) => d.items.length);

    dims.sort((a, b) => b.weightSum - a.weightSum);
    dims = assignScores(dims, total);

    return {
      dims,
      stats: {
        highCount: H.length, lowCount: L.length,
        candidateCount: candidates.length,
        keptCount: scored.length,
        droppedCount: dropped.length,
        minDelta, minSupport,
      },
      dropped,
      allScored: scored.sort((a, b) => b.weight - a.weight),
      generatedAt: Date.now(),
    };
  }

  /** 术语类要素的权重折扣：0.55 —— 承认它不如结构化信号稳 */
  const TERM_DISCOUNT = 0.55;

  /**
   * 去重：同一语义被拆成多个子串（「归并」「归并排序」「三种排序」）会重复计数，
   * 导致该语义凭数量而非质量拿到高分。若 A ⊂ B 且区分度相同，只保留更具体的 B。
   */
  function dedupe(list) {
    const terms = list.filter((x) => x.kind === 'term');
    const drop = new Set();
    terms.forEach((a) => {
      terms.forEach((b) => {
        if (a === b || drop.has(a)) return;
        if (b.key.length > a.key.length && b.key.includes(a.key) && b.delta >= a.delta) drop.add(a);
      });
    });
    for (let i = list.length - 1; i >= 0; i--) {
      if (drop.has(list[i])) list.splice(i, 1);
    }
  }

  /**
   * 限制单个维度采纳的要素数量。
   *
   * 为什么需要：一个维度只要恰好拥有较多互相关联的结构化信号，分值就会虚高。
   * 实测里「原始数据记录」一口气吃下「含数据表格 / 给出量化数据 / 设有数据处理章节」三条，
   * 再加上几个同义术语，直接冲到 37 分吃掉三分之一总分 —— 而它并没有比其它维度重要三倍。
   *
   * 被挤掉的要素不清空，而是带理由进 dropped，好让教师知道系统看见了它、只是判为冗余。
   */
  function capPerDim(list, max, dropped) {
    const groups = {};
    list.forEach((x) => { (groups[x.dim.id] = groups[x.dim.id] || []).push(x); });
    const keep = new Set();
    Object.keys(groups).forEach((id) => {
      groups[id].sort((a, b) => b.weight - a.weight).forEach((x, i) => {
        if (i < max) keep.add(x);
        else dropped.push(Object.assign({}, x, { reason: '同一维度内已有 ' + max + ' 个区分度更高的要点，本条计为冗余' }));
      });
    });
    for (let i = list.length - 1; i >= 0; i--) {
      if (!keep.has(list[i])) list.splice(i, 1);
    }
  }

  /**
   * 分值分配：先按比例取整（下限 2 分，保证每个保留维度都有意义），
   * 再用「削峰填谷」把单个维度压到 MAX_DIM 以内（防止一权独大），
   * 最后把取整余量从最大维度上增减，使总分精确等于 100。
   */
  const MAX_DIM = 35;

  function assignScores(dims, total) {
    dims.forEach((d) => { d.max = Math.max(2, Math.min(MAX_DIM, Math.round(d.rawScore))); });
    let sum = dims.reduce((s, d) => s + d.max, 0);
    let guard = 0;
    while (sum !== total && guard++ < 200) {
      const idx = sum > total
        ? dims.reduce((bi, d, i) => (dims[bi].max < d.max ? i : bi), 0)   // 超了从最大的砍
        : dims.reduce((bi, d, i) => (dims[bi].max > d.max ? i : bi), 0);   // 不够补给最小的
      dims[idx].max += sum > total ? -1 : 1;
      sum = dims.reduce((s, d) => s + d.max, 0);
    }
    // 丢弃被压到 0 分的维度
    return dims.filter((d) => d.max > 0).map((d) => Object.assign(d, {
      ratio: U.round(d.max / total, 3),
    }));
  }

  /**
   * 把一个要素词归入最可能的维度（按命中关键词长度打分）。
   * 返回 null 表示无法归类 —— 调用方应丢弃该要素，而不是塞进某个兜底维度，
   * 否则「所有无法识别的词」会凭数量把某一个维度顶成畸形高分。
   */
  function guessDim(text, anchors) {
    const t = String(text || '');
    const list = anchors || DIM_ANCHORS;
    let best = null, bestScore = 0;
    list.forEach((a) => {
      let s = 0;
      a.keys.forEach((k) => { if (t.includes(k)) s += k.length; });
      if (s > bestScore) { bestScore = s; best = a; }
    });
    return best ? { id: best.id, name: best.name } : null;
  }

  /**
   * 从任意量表导出锚点。
   * 优先用维度自带的 keys；没有则退化——用维度名切成 2 字词，再从考察要点里抽 2~4 字的关键片段。
   * 退化锚点不如手工写的准，但足以让非编程方向的术语也能归到自己维度，而不是全部堆到「格式规范」。
   */
  function anchorsFromRubric(rubric) {
    const seen = new Set();
    return (rubric || []).map((d) => {
      let keys = (d.keys || []).slice();
      if (!keys.length) {
        const pack = String(d.name || '') + ' ' + (d.signals || []).map((s) => s.label).join(' ');
        keys = Array.from(new Set(pack.split(/[\s、,，。:：（）()\/]+/).filter((w) => w.length >= 2 && w.length <= 5))).slice(0, 8);
      }
      let id = d.id || ('d' + Math.random().toString(36).slice(2, 7));
      while (seen.has(id)) id = id + '_';
      seen.add(id);
      return { id, name: d.name, keys };
    });
  }

  /**
   * 把诱导结果转成可被引擎消费的量表（复用默认量表的信号词典 + 新分值）
   * 说明：分值来自数据，信号词典仍来自领域默认——避免诱导出的术语过拟合单批范文。
   */
  function toRubric(induced, baseRubric) {
    const src = baseRubric || AG.rubric.DEFAULT_RUBRIC;
    const byId = {};
    let byName = null;
    src.forEach((d) => { byId[d.id] = d; });
    return induced.dims.map((d) => {
      // 锚点 id 可能因为去重被改写过后缀，此时按维度名回查，避免整个维度退化成空壳
      let from = byId[d.id];
      if (!from) {
        if (!byName) { byName = {}; src.forEach((d) => { byName[d.name] = d; }); }
        from = byName[d.name];
      }
      const dim = from ? AG.rubric.cloneRubric([from])[0] : {
        id: d.id, name: d.name, desc: '', advice: '',
        signals: [{ label: '包含相关内容', re: /./g, w: 1 }], penalties: [],
      };
      dim.id = d.id;
      dim.name = d.name;
      dim.max = d.max;
      dim.enabled = true;
      dim.inducedFrom = d.items.slice(0, 4).map((i) => i.label);
      return dim;
    });
  }

  AG.induce = {
    induce, toRubric, anchorsFromRubric,
    extractTerms, extractSections, consensusTerms, guessDim,
    STRUCT_SIGNALS, DIM_ANCHORS,
  };
})(window);
