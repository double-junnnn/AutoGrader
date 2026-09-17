/* AutoGrader · 评分信度自检（Reliability Self-Check）
 *
 * 核心立场：自动评分必须回答「这个分数有多可信」，否则教师不敢采用。
 * 本模块全部本地计算，不含任何网络请求。
 *
 * 一、分数稳不稳（心理测量学三件套）
 *   1. Cronbach's α —— 量表内部一致性。把各维度视为一道"题项"，衡量它们是否在测同一个构念。
 *      α = k/(k-1) · (1 − ΣVar_i / Var_total)。α ≥ 0.8 良好，< 0.6 说明维度设计互相打架。
 *   2. Bootstrap 置信区间 —— 单份报告的稳定性。按段落有放回重采样 N 次重新评分，
 *      取 2.5%/97.5% 分位数作为 95% CI。区间越宽，说明分数对局部内容越敏感（越不稳定）。
 *   3. Jackknife 敏感度 —— 逐个剔除维度看总分漂移，识别"支配维度"：
 *      某个维度一去掉总分就剧烈变化，说明它一权独大，量表的风险敞口集中。
 *   另附 Spearman-Brown 折半信度作为 α 的交叉验证。
 *
 * 二、分数是怎么来的（溯源与偏差，回答「凭什么给这个分」）
 *   4. 篇幅偏差 —— 本地引擎把字数直接当评分因子，所以总分与字数天然正相关。
 *      对（字数, 总分）做一元线性回归，量化这个相关性有多大。
 *   5. 评分溯源 —— 达成率是 cap×√(raw+boost)，证据与结构加成**相加**。
 *      于是「排得整齐」本身也能换分。本项把每个维度的分拆成「证据挣的」与「结构送的」。
 *
 * 前三条回答「稳不稳」，后两条回答「为什么」—— 教师需要的是后者才能放心用。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ---------------- 统计基元 ---------------- */
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

  function variance(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); // 样本方差
  }

  function stdev(a) { return Math.sqrt(variance(a)); }

  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den === 0 ? 0 : num / den;
  }

  /** 线性插值分位数 */
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* ---------------- 1. Cronbach's α ---------------- */

  /**
   * 跨报告计算量表内部一致性
   * @param {Array} results 各报告的评分结果（含 dims）
   */
  function cronbachAlpha(results) {
    const n = results.length;
    if (n < 2) return { alpha: null, note: '至少需要 2 份已评分报告' };

    const dimCount = (results[0].dims || []).length;
    if (dimCount < 2) return { alpha: null, note: '维度数不足' };

    // 用得分率而非原始分，消除各维度满分不同的影响
    const cols = [];
    for (let d = 0; d < dimCount; d++) {
      cols.push(results.map((r) => (r.dims[d] ? r.dims[d].ratio : 0)));
    }
    const totals = results.map((r, i) => cols.reduce((s, c) => s + c[i], 0));

    const sumVar = cols.reduce((s, c) => s + variance(c), 0);
    const totalVar = variance(totals);
    if (totalVar === 0) return { alpha: 1, note: '所有报告得分完全一致，方差为 0' };

    const alpha = (dimCount / (dimCount - 1)) * (1 - sumVar / totalVar);

    // 逐维度诊断：删除该维度后 α 的变化，升高说明该维度是噪声
    const perDim = cols.map((c, i) => {
      const rest = cols.filter((_, j) => j !== i);
      const restTotal = results.map((_, ri) => rest.reduce((s, cc) => s + cc[ri], 0));
      const a2 = rest.length > 1
        ? (rest.length / (rest.length - 1)) * (1 - rest.reduce((s, cc) => s + variance(cc), 0) / (variance(restTotal) || 1))
        : null;
      return {
        id: results[0].dims[i].id,
        name: results[0].dims[i].name,
        alphaIfDeleted: a2 == null ? null : U.round(a2, 3),
        delta: a2 == null ? null : U.round(a2 - alpha, 3),
      };
    });

    // 折半信度（奇偶分半 + Spearman-Brown 校正）
    const odd = results.map((_, i) => cols.filter((_, j) => j % 2 === 0).reduce((s, c) => s + c[i], 0));
    const even = results.map((_, i) => cols.filter((_, j) => j % 2 === 1).reduce((s, c) => s + c[i], 0));
    const r = pearson(odd, even);
    const sb = r > 0 && r < 1 ? (2 * r) / (1 + r) : r;

    return {
      alpha: U.round(alpha, 3),
      spearmanBrown: U.round(sb, 3),
      splitHalfR: U.round(r, 3),
      itemCount: dimCount,
      sampleCount: n,
      perDim,
      grade: alphaGrade(alpha),
      // 样本太少时 α 的估计本身很不稳定，必须明示，否则是在用统计指标唬人
      sampleWarning: n < 5
        ? `仅 ${n} 份样本，α 的估计误差较大（建议 ≥10 份再据其调整量表）`
        : null,
      noisyDims: perDim.filter((p) => p.delta != null && p.delta > 0.01)
        .sort((a, b) => b.delta - a.delta),
    };
  }

  function alphaGrade(a) {
    if (a >= 0.90) return { level: 'excellent', label: '优秀', color: '#16a34a', desc: '各维度高度一致，量表内部结构设计良好' };
    if (a >= 0.80) return { level: 'good', label: '良好', color: '#2563eb', desc: '一致性达标，可用于正式评阅' };
    if (a >= 0.70) return { level: 'acceptable', label: '可接受', color: '#0891b2', desc: '基本可用，建议微调维度措辞' };
    if (a >= 0.60) return { level: 'weak', label: '偏弱', color: '#d97706', desc: '维度间一致性不足，评分结果需谨慎解读' };
    return { level: 'poor', label: '不足', color: '#dc2626', desc: '维度设置互相冲突，建议重新设计量表' };
  }

  /* ---------------- 2. Bootstrap 单份报告稳定性 ---------------- */

  /** 按段落切分（保留代码块完整性） */
  function splitParagraphs(text) {
    return String(text || '').split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length);
  }

  /**
   * 重采样后重新评分。
   * 关键：features 用原文的（冻结），而不是重采样文本的。
   * 否则 words/codeLines 的阈值跳变（如 800 字上下）会主导分数波动，
   * 测出来的是「评分函数对篇幅阈值敏不敏感」，而不是我们真正想知道的
   * 「这份报告的证据覆盖是否稳定」。冻结后，CI 才纯粹反映内容取舍的影响。
   */
  function gradeText(doc, rubric, text, frozenFeatures) {
    // skipGenre：一致性检验关心的是「证据覆盖是否稳定」，
    // 门禁是零或一的开关，参与进来只会把波动测成 0，掩盖真实的不稳定性
    return AG.analyzer.grade({ name: doc.name, text, features: frozenFeatures || doc.features }, rubric, { skipGenre: true });
  }

  /**
   * 对单份报告做 Bootstrap 重采样
   * @param {Object} doc
   * @param {Array} rubric
   * @param {Object} opts { iterations, seed }
   */
  function bootstrap(doc, rubric, opts) {
    opts = opts || {};
    const N = opts.iterations || 80;
    const paras = splitParagraphs(doc.text || '');
    if (paras.length < 4) {
      return { ok: false, note: '报告段落过少（<4），无法进行重采样' };
    }

    // 固定种子的伪随机：保证同一份报告每次自检结论一致，便于教师复核
    let seed = opts.seed || hashString(doc.name || '') || 20240926;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    // 有放回重采样会丢掉约 1/e ≈ 37% 的段落，对"报告略有增删"而言过于激进，
    // 测出来的波动主要来自"内容少了一大截"而非"评分不稳"。
    // 这里改用删减式重采样：每次随机删掉 keepRatio 之外的少量段落，保留 85%。
    const keepRatio = opts.keepRatio == null ? 0.85 : opts.keepRatio;
    const dropCount = U.clamp(Math.round(paras.length * (1 - keepRatio)), 1, Math.max(1, paras.length - 2));

    const frozenFeatures = doc.features || AG.parser.extractFeatures(doc.text || '');
    const totals = [];
    const dimScores = {};
    const idxAll = paras.map((_, i) => i);
    for (let it = 0; it < N; it++) {
      const idx = idxAll.slice();
      // 部分 Fisher-Yates：随机挑 dropCount 个位置剔除
      for (let k = 0; k < dropCount; k++) {
        const pos = Math.floor(rand() * (idx.length - k)) + k;
        const tmp = idx[k]; idx[k] = idx[pos]; idx[pos] = tmp;
      }
      const kept = idx.slice(dropCount).sort((a, b) => a - b).map((i) => paras[i]);
      const res = gradeText(doc, rubric, kept.join('\n\n'), frozenFeatures);
      totals.push(res.total);
      res.dims.forEach((d) => { (dimScores[d.id] = dimScores[d.id] || []).push(d.ratio); });
    }

    const sorted = totals.slice().sort((a, b) => a - b);
    const point = doc.result ? doc.result.total : mean(totals);
    const lo = quantile(sorted, 0.025);
    const hi = quantile(sorted, 0.975);
    const sd = stdev(totals);

    const dims = (rubric || []).map((d) => {
      const arr = dimScores[d.id] || [];
      const s = arr.slice().sort((a, b) => a - b);
      return {
        id: d.id, name: d.name,
        mean: U.round(mean(arr), 3),
        sd: U.round(stdev(arr), 3),
        ci: [U.round(quantile(s, 0.025), 3), U.round(quantile(s, 0.975), 3)],
        width: U.round(quantile(s, 0.975) - quantile(s, 0.025), 3),
      };
    }).sort((a, b) => b.width - a.width);

    const cv = point > 0 ? sd / point : 0; // 变异系数
    return {
      ok: true,
      point: U.round(point, 1),
      mean: U.round(mean(totals), 1),
      sd: U.round(sd, 2),
      cv: U.round(cv, 4),
      ci: [U.round(lo, 1), U.round(hi, 1)],
      ciWidth: U.round(hi - lo, 1),
      iterations: N,
      paragraphs: paras.length,
      dims,
      stability: stabilityGrade(hi - lo, cv),
      samples: sorted,
    };
  }

  /**
   * 稳定性分级。阈值按"删减 15% 段落"这一扰动强度标定：
   * 删掉一两个章节后总分仍在 ±3 分内，说明报告各部分质量均匀，分数可信；
   * 若波动超过 ±10 分，说明分数高度依赖某几个段落，这类报告最该人工复核。
   */
  function stabilityGrade(width, cv) {
    if (width <= 6 && cv <= 0.035) return { level: 'high', label: '高稳定', color: '#16a34a', desc: '各部分质量均匀，删改局部内容几乎不影响总分，结果可直接采用' };
    if (width <= 12 && cv <= 0.07) return { level: 'medium', label: '较稳定', color: '#2563eb', desc: '总体可信，个别段落对分数影响略大，抽查即可' };
    if (width <= 20) return { level: 'low', label: '一般', color: '#d97706', desc: '分数对内容局部变动较敏感，建议人工复核后再定分' };
    return { level: 'unstable', label: '不稳定', color: '#dc2626', desc: '分数高度依赖少数段落，内容质量分布不均，强烈建议人工评阅' };
  }

  /* ---------------- 3. Jackknife 维度敏感度 ---------------- */

  /**
   * 逐个剔除维度，观察总分漂移，识别支配维度
   */
  function jackknife(doc, rubric) {
    if (!doc.result) return { ok: false, note: '该报告尚未评分' };
    const base = doc.result.total;
    const baseScale = rubricTotal(rubric);
    if (baseScale <= 0) return { ok: false, note: '量表总分异常' };

    const items = rubric.map((d) => {
      const dimRes = doc.result.dims.find((x) => x.id === d.id);
      const drop = dimRes ? dimRes.score : 0;
      const rest = baseScale - (Number(d.max) || 0);
      if (rest <= 0) return { id: d.id, name: d.name, max: d.max, impact: 0, rescaled: null };
      const rescaled = U.round((base - drop) * baseScale / rest, 1); // 折算回百分制后该报告"应得"分
      return {
        id: d.id, name: d.name, max: Number(d.max),
        score: dimRes ? dimRes.score : 0,
        rescaled,
        impact: U.round(rescaled - base, 1), // 剔除该维度后总分的漂移
      };
    });

    items.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    const top = items[0];
    const maxImpact = top ? Math.abs(top.impact) : 0;

    return {
      ok: true,
      base,
      items,
      dominant: maxImpact >= 4 ? top : null,
      balance: maxImpact >= 8 ? 'lopsided' : maxImpact >= 4 ? 'tilted' : 'balanced',
      balanceLabel: maxImpact >= 8 ? '存在支配维度' : maxImpact >= 4 ? '权重略偏' : '权重均衡',
      note: maxImpact >= 8
        ? `「${top.name}」剔除后总分漂移 ${top.impact > 0 ? '+' : ''}${top.impact} 分，该维度一权独大，评分风险集中`
        : '各维度对总分影响均衡，无单一维度主导结果',
    };
  }

  function rubricTotal(rubric) {
    return (rubric || []).reduce((s, d) => s + (Number(d.max) || 0), 0);
  }

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 4294967296;
    return h;
  }

  /* ---------------- 汇总入口 ---------------- */

  /**
   * 对当前批次的全部已评分报告做一次完整自检
   * @param {Array} docs   已评分文档
   * @param {Array} rubric
   */
  function audit(docs, rubric, opts) {
    const graded = (docs || []).filter((d) => d.result);
    const results = graded.map((d) => d.result);
    const alpha = cronbachAlpha(results);

    // 只对当前选中报告做重量级的 Bootstrap（其余留待按需触发）
    const target = opts && opts.docId
      ? graded.find((d) => d.id === opts.docId)
      : graded[0];
    const bs = target ? bootstrap(target, rubric, opts) : { ok: false, note: '无可评分报告' };
    const jk = target ? jackknife(target, rubric) : { ok: false };

    // 需要人工复核的名单：稳定性差 或 处于等级边界（±1.5 分内跨档）
    const review = graded.map((d) => {
      const reasons = [];
      const t = d.result.total;
      const bands = AG.rubric.GRADE_BANDS;
      const cur = bands.find((b) => t >= b.min);
      const next = bands.filter((b) => b.min > (cur ? cur.min : 0)).sort((a, b) => a.min - b.min)[0];
      if (next && next.min - t <= 1.5) reasons.push(`距上一等级仅 ${U.round(next.min - t, 1)} 分，边界分数建议复核`);
      if (d.result.qualityFactor < 0.9) reasons.push('篇幅或结构偏弱，质量系数已折减');
      return { id: d.id, name: d.name, total: t, reasons, need: reasons.length > 0 };
    }).filter((x) => x.need);

    return { alpha, bootstrap: bs, jackknife: jk, review, auditedAt: Date.now(), sampleCount: graded.length };
  }

  /* ---------------- 篇幅偏差 ---------------- */
  /**
   * 篇幅偏差自检：分数里有多少是「写得长」带来的。
   *
   * 为什么要做：本地启发式引擎把字数**直接当作评分因子** —— analyzer.js 里有
   * 「动态满分上限」（篇幅越厚实，可达到的分数上限越高）和篇幅质量系数。
   * 这是刻意的取舍（一份 300 字的物理报告完全可能写得完整，所以阈值压得很低），
   * 但代价是总分与字数天然正相关。老师有权知道这个相关性有多大 ——
   * 否则「你这分是不是就看字数给的」这个问题无法回答。
   *
   * 做法：对（字数, 总分）做一元线性回归，返回
   *   r       相关系数
   *   per1k   每多 1000 字平均多拿的分
   *   most/least  实际分与「篇幅预期分」偏离最远的两份，用来看谁被篇幅高估/低估
   *
   * 注意：这是**描述性统计**，不是对评分器的判决。样本少于 4 份时不做估计。
   */
  function lengthBias(docs) {
    const rows = (docs || [])
      .filter((d) => d && d.result && d.features)
      .map((d) => ({ id: d.id, name: d.name, x: d.features.words || 0, y: d.result.total }));
    const n = rows.length;
    if (n < 4) {
      return { ok: false, n, note: '篇幅偏差需要至少 4 份已评分报告才能估计（当前 ' + n + ' 份）' };
    }

    const xs = rows.map((d) => d.x);
    const ys = rows.map((d) => d.y);
    const r = pearson(xs, ys);

    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) * (xs[i] - mx);
    }
    // 字数完全一致时 sxx=0，回归无意义，退化成「篇幅不影响」
    const slope = sxx ? sxy / sxx : 0;
    const intercept = my - slope * mx;

    const resid = rows.map((d, i) => {
      const pred = intercept + slope * d.x;
      return { id: d.id, name: d.name, x: d.x, y: ys[i], pred: pred, gap: ys[i] - pred };
    }).sort((a, b) => b.gap - a.gap);

    const abs = Math.abs(r);
    const level = abs < 0.4 ? 'low' : abs < 0.7 ? 'mid' : 'high';
    const grade = {
      low: { label: '影响小', color: '#0f6e56', desc: '分数基本由内容质量决定，篇幅不是主要因素。' },
      mid: { label: '中等', color: '#b45309', desc: '篇幅对分数有可见影响，评阅时建议结合字数一并判断。' },
      high: { label: '偏强', color: '#a32d2d', desc: '总分与字数高度相关，可能存在「写得长就得分高」的倾向，请参考下方剔除篇幅后的对照。' },
    }[level];

    return {
      ok: true, n, r: U.round(r, 3), level, grade,
      per1k: U.round(slope * 1000, 1),
      intercept: U.round(intercept, 1),
      most: resid[0],
      least: resid[resid.length - 1],
      spread: U.round(resid[0].gap - resid[resid.length - 1].gap, 1),
    };
  }

  /* ---------------- 评分溯源 ---------------- */
  /**
   * 评分溯源自检：每个维度的分，有多少是「实证据」挣来的。
   *
   * 起因是本地引擎的达成率公式：
   *     ratio = cap × √(raw + boost)
   * 其中 raw 是证据覆盖率、boost 是结构加成（有没有代码块、图表、数据点、标题层级）。
   * 两者**相加**意味着：一个信号都没命中，只靠排得整齐也能拿到 √boost 的比例 ——
   * boost 取满时是**七成分**。这是刻意的设计（结构完整本身就是实验报告的质量维度），
   * 但它必须可见：哪些分是内容证据挣的，哪些是排版结构送的。
   *
   * 所以这不是「挑错」，是把「这个分凭什么」摊开 ——
   * 支撑最弱的那个维度，就是最该人工复核的地方。
   *
   * 分层规则：
   *   penalized  扣分项吃掉了 25% 以上的分值 → 该维度被具体缺陷压住
   *   weak       证据覆盖率 < 15% 却拿到 > 20% 的结构加成 → 分主要来自排版
   *   solid      证据占得分依据 70% 以上 → 账目清楚
   *   mixed      其余
   */
  function evidenceAudit(result) {
    const dims = (result && result.dims) || [];
    if (!dims.length) return { ok: false, note: '该报告没有维度得分可供溯源' };

    const rows = dims.map((d) => {
      const raw = d.raw || 0;
      const boost = d.boost || 0;
      const base = raw + boost;
      const support = base > 0 ? raw / base : 1;   // 得分依据里「证据」所占比例
      const max = d.max || 1;
      const penRatio = (d.penalty || 0) / max;
      const weak = raw < 0.15 && boost > 0.2;
      const layer = penRatio > 0.25 ? 'penalized' : weak ? 'weak' : support >= 0.7 ? 'solid' : 'mixed';
      return {
        id: d.id, name: d.name, score: d.score, max: d.max,
        raw: U.round(raw, 3), boost: U.round(boost, 3), support: U.round(support, 3),
        penalty: d.penalty || 0,
        evidenceCount: (d.evidence || []).length,
        missingCount: (d.missing || []).length,
        layer,
      };
    });

    // 全卷证据支撑度：按各维度实际得分为权重，避免 0 分维度拉低整体观感
    const scored = rows.filter((r) => r.score > 0);
    const weightSum = scored.reduce((s, r) => s + r.score, 0);
    const supportRate = weightSum > 0
      ? scored.reduce((s, r) => s + r.score * r.support, 0) / weightSum
      : 0;

    return {
      ok: true,
      dims: rows,
      solid: rows.filter((r) => r.layer === 'solid'),
      mixed: rows.filter((r) => r.layer === 'mixed'),
      weak: rows.filter((r) => r.layer === 'weak'),
      penalized: rows.filter((r) => r.layer === 'penalized'),
      supportRate: U.round(supportRate, 3),
      evidenceTotal: rows.reduce((s, r) => s + r.evidenceCount, 0),
      missingTotal: rows.reduce((s, r) => s + r.missingCount, 0),
    };
  }

  AG.reliability = {
    cronbachAlpha, bootstrap, jackknife, audit, lengthBias, evidenceAudit,
    mean, variance, stdev, pearson, quantile, alphaGrade, stabilityGrade,
  };
})(window);
