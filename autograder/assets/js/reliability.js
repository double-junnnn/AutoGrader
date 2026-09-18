/* AutoGrader · 评分信度自检（Reliability Self-Check）
 *
 * 核心立场：自动评分必须回答「这个分数有多可信」，否则教师不敢采用。
 *
 * 【2026-09 变更】本地启发式评分引擎已移除，本模块相应调整：
 *   · 稳定性度量从「Bootstrap 段落重采样」换成「对模型连续采样 N 次」。
 *     旧做法反复调用本地打分，测的是"删掉 15% 段落分变不变"；
 *     教师真正想问的是「同一份作业明天再评一遍会不会换个分」，采样直接回答这个。
 *   · 评分溯源从「证据 vs 结构加成」换成「证据核验通过率」。
 *     本地公式没了，但新增了更硬的指标：模型引用的原文到底在不在报告里。
 *   · 篇幅偏差保留。它是描述性统计，测的是结果不是成因；
 *     改成模型评分后同样值得测——模型也偏爱写得长的报告。
 *
 * 一、分数稳不稳（心理测量学三件套）
 *   1. Cronbach's α —— 量表内部一致性。把各维度视为一道"题项"，衡量它们是否在测同一个构念。
 *      α = k/(k-1) · (1 − ΣVar_i / Var_total)。α ≥ 0.8 良好，< 0.6 说明维度设计互相打架。
 *   2. 采样稳定性 —— 同一份报告用同一模型连评 N 次，取 2.5%/97.5% 分位数作为 95% CI。
 *      极差越大，说明模型给分越"随手"，这份分越不该直接采用。
 *   3. Jackknife 敏感度 —— 逐个剔除维度看总分漂移，识别"支配维度"：
 *      某个维度一去掉总分就剧烈变化，说明它一权独大，量表的风险敞口集中。
 *   另附 Spearman-Brown 折半信度作为 α 的交叉验证。
 *
 * 二、分数是怎么来的（溯源与偏差，回答「凭什么给这个分」）
 *   4. 篇幅偏差 —— 对（字数, 总分）做一元线性回归，量化"写得长是不是分更高"。
 *   5. 评分溯源 —— 模型给的每条证据都回查原文，统计逐字命中 / 改写 / 查无此句。
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

  /* ---------------- 2. 单份报告稳定性：模型连续采样 ---------------- */

  /** 按段落切分（保留代码块完整性） */
  function splitParagraphs(text) {
    return String(text || '').split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length);
  }

  /**
   * 对单份报告做采样稳定性检验：同一份输入、同一套量表，让模型连评 N 次。
   *
   * 为什么不再是 Bootstrap 段落重采样：本地打分引擎已删，重采样无法再"重新打分"。
   * 但换个角度想，原来的问题本身也不是教师最关心的——
   * 教师问的是「这个分靠谱吗」，而最能击穿信任的场景是
   * 「同一份作业，上午评 78，下午评 85」。采样直接量化这件事。
   *
   * 采样温度默认 0.7：用评分温度 0.2 采样只会测出"解码器很确定"，
   * 测不出模型判断本身的鲁棒性。
   *
   * @param {Object} doc
   * @param {Array}  rubric
   * @param {Object} opts { iterations, temperature }
   * @returns {Promise<Object>} 与旧 bootstrap 同构，便于图表与渲染层复用
   */
  async function stability(doc, rubric, opts) {
    opts = opts || {};
    if (!AG.llm || !AG.llm.sampleGrade) {
      return { ok: false, note: '模型引擎未就绪，无法做采样稳定性检验' };
    }
    if (!(AG.llm.getConfig().apiKey)) {
      return { ok: false, note: '未配置 API Key，无法做采样稳定性检验（需调用模型多次评阅）' };
    }

    const s = await AG.llm.sampleGrade(doc, rubric, {
      iterations: opts.iterations || 8,
      temperature: opts.temperature == null ? 0.7 : opts.temperature,
    });
    if (!s.ok) return { ok: false, note: s.note || '采样失败' };

    const sorted = s.totals.slice().sort((a, b) => a - b);
    const point = doc.result ? doc.result.total : U.round(mean(sorted), 1);
    const lo = quantile(sorted, 0.025);
    const hi = quantile(sorted, 0.975);
    const sd = stdev(sorted);
    const cv = point > 0 ? sd / point : 0;

    const dims = (rubric || []).map((d) => {
      const arr = (s.dimScores[d.id] || []).slice().sort((a, b) => a - b);
      return {
        id: d.id, name: d.name,
        mean: U.round(mean(arr), 3),
        sd: U.round(stdev(arr), 3),
        ci: [U.round(quantile(arr, 0.025), 3), U.round(quantile(arr, 0.975), 3)],
        width: U.round(quantile(arr, 0.975) - quantile(arr, 0.025), 3),
      };
    }).sort((a, b) => b.width - a.width);

    return {
      ok: true,
      method: 'sampling',
      methodLabel: '模型连续采样',
      point: U.round(point, 1),
      mean: U.round(mean(sorted), 1),
      sd: U.round(sd, 2),
      cv: U.round(cv, 4),
      ci: [U.round(lo, 1), U.round(hi, 1)],
      ciWidth: U.round(hi - lo, 1),
      range: [U.round(sorted[0], 1), U.round(sorted[sorted.length - 1], 1)],
      spread: U.round(sorted[sorted.length - 1] - sorted[0], 1),
      iterations: s.iterations,
      model: s.model,
      // 保留字段名以兼容既有的渲染与图表，但段落采样已不适用，如实置空
      paragraphs: null,
      dims,
      stability: stabilityGrade(hi - lo, cv),
      samples: sorted,
    };
  }

  /**
   * 稳定性分级。阈值按「同一份作业重复评阅应当有多一致」标定：
   * 连评 8 次总分都在 ±3 分内，说明模型判断稳定，分数可直接采用；
   * 若极差超过 ±10 分，说明模型在"随手给分"，这类分数必须人工复核。
   */
  function stabilityGrade(width, cv) {
    if (width <= 6 && cv <= 0.035) return { level: 'high', label: '高稳定', color: '#16a34a', desc: '重复评阅结果高度一致，分数可直接采用' };
    if (width <= 12 && cv <= 0.07) return { level: 'medium', label: '较稳定', color: '#2563eb', desc: '总体可信，个别维度略有波动，抽查即可' };
    if (width <= 20) return { level: 'low', label: '一般', color: '#d97706', desc: '重复评阅波动较明显，建议人工复核后再定分' };
    return { level: 'unstable', label: '不稳定', color: '#dc2626', desc: '重复评阅极差过大，模型判断不稳定，强烈建议人工评阅' };
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
  async function audit(docs, rubric, opts) {
    const graded = (docs || []).filter((d) => d.result);
    const results = graded.map((d) => d.result);
    const alpha = cronbachAlpha(results);

    // 只对当前选中报告做重量级的采样检验（要连评多次，其余留待按需触发）
    const target = opts && opts.docId
      ? graded.find((d) => d.id === opts.docId)
      : graded[0];
    const bs = target ? await stability(target, rubric, opts) : { ok: false, note: '无可评分报告' };
    const jk = target ? jackknife(target, rubric) : { ok: false };

    // 需要人工复核的名单：稳定性差 / 处于等级边界 / 模型证据查无此句
    const review = graded.map((d) => {
      const reasons = [];
      const t = d.result.total;
      const bands = AG.rubric.GRADE_BANDS;
      const cur = bands.find((b) => t >= b.min);
      const next = bands.filter((b) => b.min > (cur ? cur.min : 0)).sort((a, b) => a.min - b.min)[0];
      if (next && next.min - t <= 1.5) reasons.push(`距上一等级仅 ${U.round(next.min - t, 1)} 分，边界分数建议复核`);
      // 本地的"质量系数折减"随本地引擎一并移除，换成更硬的指标：
      // 模型引用的证据里有多少条在原文中查不到——那是它可能没读懂的直接证据
      const hall = (d.result.evidenceAudit && d.result.evidenceAudit.hallucinated) || 0;
      if (hall > 0) reasons.push(`${hall} 条评分证据未在原文中查到，评分依据存疑`);
      return { id: d.id, name: d.name, total: t, reasons, need: reasons.length > 0 };
    }).filter((x) => x.need);

    return { alpha, bootstrap: bs, jackknife: jk, review, auditedAt: Date.now(), sampleCount: graded.length };
  }

  /* ---------------- 篇幅偏差 ---------------- */
  /**
   * 篇幅偏差自检：分数里有多少是「写得长」带来的。
   *
   * 为什么要做：早期版本是本地启发式引擎在打分，它把字数**直接当作评分因子**
   * （动态满分上限 + 篇幅质量系数），总分与字数天然正相关。
   * 现在评分交给模型了，这件事就没那么理所当然了 —— 但也不能假设它消失了：
   * 大模型同样偏爱写得长、写得满的报告，这是训练数据里的普遍偏好。
   * 所以它从"自证清白"变成了"常规体检"：老师有权知道这个相关性有多大，
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
   * 评分溯源自检：模型给的每一条证据，在原文里到底找不找得到。
   *
   * 起因是本地引擎的达成率公式被删了（ratio = cap × √(raw + boost)，
   * 证据覆盖率与结构加成相加，导致"排得整齐也能换分"）。
   * 本地不再打分后，溯源的含义随之改变——从「这个分由哪些因子构成」
   * 变成「这个分有没有站得住的依据」。后者才是教师复核时真正会看的。
   *
   * 核验由 AG.analyzer.verifyEvidence 完成（逐字命中 / 改写复述 / 查无此句），
   * 这里只做汇总与分层。
   *
   * 分层规则：
   *   hallucinated  存在查无此句的证据 → 模型可能没读懂，最该复核
   *   thin          证据总数少于 2 条 → 分数缺少支撑
   *   solid         全部证据逐字命中或属改写 → 账目清楚
   *   mixed         其余
   */
  function evidenceAudit(result) {
    const dims = (result && result.dims) || [];
    if (!dims.length) return { ok: false, note: '该报告没有维度得分可供溯源' };

    const rows = dims.map((d) => {
      const chk = d.evidenceCheck || null;
      const total = chk ? chk.total : 0;
      const exact = chk ? chk.exact : 0;
      const para = chk ? chk.paraphrased : 0;
      const hal = chk ? chk.hallucinated.length : 0;
      const rate = chk ? chk.rate : 1;
      const layer = hal > 0 ? 'hallucinated'
        : total < 2 ? 'thin'
          : rate >= 0.999 ? 'solid'
            : 'mixed';
      return {
        id: d.id, name: d.name, score: d.score, max: d.max,
        evidenceCount: (d.evidence || []).length,
        missingCount: (d.missing || []).length,
        exact, paraphrased: para, hallucinated: hal,
        rate: U.round(rate, 3),
        layer,
      };
    });

    const scored = rows.filter((r) => r.score > 0);
    const weightSum = scored.reduce((s, r) => s + r.score, 0);
    const supportRate = weightSum > 0
      ? scored.reduce((s, r) => s + r.score * r.rate, 0) / weightSum
      : 0;

    const totalHall = rows.reduce((s, r) => s + r.hallucinated, 0);

    return {
      ok: true,
      dims: rows,
      solid: rows.filter((r) => r.layer === 'solid'),
      mixed: rows.filter((r) => r.layer === 'mixed'),
      thin: rows.filter((r) => r.layer === 'thin'),
      hallucinated: rows.filter((r) => r.layer === 'hallucinated'),
      supportRate: U.round(supportRate, 3),
      evidenceTotal: rows.reduce((s, r) => s + r.evidenceCount, 0),
      missingTotal: rows.reduce((s, r) => s + r.missingCount, 0),
      hallucinatedTotal: totalHall,
      // 有一条例证编造，整份评分的可信度就该打折，而不是"大体可信"
      verdict: totalHall > 0
        ? { level: 'warn', label: '存在无法核实的证据', color: '#dc2626', desc: `共 ${totalHall} 条证据未在原文中查到，该报告的评分依据建议逐条人工复核` }
        : supportRate >= 0.8
          ? { level: 'ok', label: '证据扎实', color: '#16a34a', desc: '各维度引用的原文均可查证' }
          : { level: 'mid', label: '证据偏薄', color: '#d97706', desc: '部分维度缺少原文引据，建议补充后再定分' },
    };
  }

  AG.reliability = {
    cronbachAlpha, stability, jackknife, audit, lengthBias, evidenceAudit,
    mean, variance, stdev, pearson, quantile, alphaGrade, stabilityGrade,
  };
})(window);
