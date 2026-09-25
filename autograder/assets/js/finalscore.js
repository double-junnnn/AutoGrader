/* AutoGrader · 教师终评分（Final Score）
 *
 * 【为什么单独一个模块】
 * AI 评出的 doc.result 是「模型输出的快照」：重评分时整个对象被新结果覆盖。
 * 教师的人工终评如果也写进 doc.result，一次「重新评分」就会把老师的判断冲掉，
 * 而老师未必记得自己改过哪几个维度。所以终评单独挂在 doc.final 上——
 * 它与 doc.result 生命周期解耦，重评分不会动它，刷新页面也会随 doc 一起存进本机。
 *
 * 【数据形态】
 *   doc.final = {
 *     total: 78.5,                 // 教师覆写的总分（可选；不设则由维度分求和得出）
 *     dims: { code: 20, env: 8 },  // 维度 id → 覆写分（稀疏，只存老师改过的）
 *     at: 1737000000000,           // 最后修改时间
 *   }
 *   doc.final 为 null / undefined 即「未终评」，所有取值回落 AI 原始分。
 *
 * 【撤销语义】
 * 撤销不需要备份：把对应字段删掉即回到 AI 值，全部删净就把 doc.final 置 null。
 *
 * 【取值口径唯一性】
 * 全站（界面 / 成绩汇总 / PDF 导出 / 答疑上下文）一律经由本模块取分，
 * 不再各自读 doc.result.total，否则「界面显示终评分、导出却是 AI 分」这类
 * 不一致迟早会出现。唯一的例外是信度自检（reliability.js）——
 * 它检验的对象本就是 AI 输出的一致性，教师覆写后不该反过来污染 α 与 Jackknife。
 *
 * 本模块是纯函数，不碰 DOM，也不持有状态：入参一律是 doc。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  /** 取工具函数。用取值器而非顶层解构，避免加载顺序变化时拿到 undefined。 */
  function U() { return AG.utils || {}; }
  function clamp(v, lo, hi) {
    const f = U().clamp;
    if (typeof f === 'function') return f(v, lo, hi);
    return Math.max(lo, Math.min(hi, v));
  }
  function round(v, n) {
    const f = U().round;
    if (typeof f === 'function') return f(v, n);
    const p = Math.pow(10, n || 0);
    return Math.round(v * p) / p;
  }

  /** 把输入解析成有限数字；不是数字就返回 null（不把空输入当 0 分） */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** 是否已终评（至少要有一个覆写值才算） */
  function has(doc) {
    const f = doc && doc.final;
    if (!f) return false;
    if (num(f.total) !== null) return true;
    return !!(f.dims && Object.keys(f.dims).length);
  }

  /** AI 原始总分 */
  function aiTotalOf(doc) {
    return doc && doc.result && typeof doc.result.total === 'number' ? doc.result.total : 0;
  }

  /** 把 doc.final 收拾干净：空对象不留残渣，避免 has() 误判为已终评 */
  function tidy(doc) {
    const f = doc.final;
    if (!f) return;
    if (f.dims) {
      Object.keys(f.dims).forEach((k) => {
        if (num(f.dims[k]) === null) delete f.dims[k];
      });
      if (!Object.keys(f.dims).length) delete f.dims;
    }
    if (num(f.total) === null) delete f.total;
    if (!f.dims && num(f.total) === null) doc.final = null;
  }

  /** 由各维度当前取值求和。仅当存在维度覆写时才有意义。 */
  function sumDims(doc) {
    const r = doc && doc.result;
    if (!r || !r.dims) return null;
    const total = r.dims.reduce((acc, d) => acc + (dimScoreOf(doc, d) || 0), 0);
    return clamp(round(total, 1), 0, 100);
  }

  /** 按维度重算总分：老师逐个维度改分时，总分自动跟着走 */
  function recompute(doc) {
    const t = sumDims(doc);
    if (t === null) return aiTotalOf(doc);
    return t;
  }

  /**
   * 终评总分。
   * 优先级：老师显式填的总分 > 维度分求和 > AI 原始分。
   * 显式总分为先，是为了支持「老师只改总分」这种最省事的用法；
   * 若老师想改回由维度决定，界面上的「按维度重算」会清掉显式总分。
   */
  function totalOf(doc) {
    if (!doc) return 0;
    const f = doc.final;
    if (f) {
      const t = num(f.total);
      if (t !== null) return clamp(round(t, 1), 0, 100);
      if (f.dims && Object.keys(f.dims).length) return recompute(doc);
    }
    return aiTotalOf(doc);
  }

  /** 某个维度当前生效的分数 */
  function dimScoreOf(doc, dim) {
    if (!dim) return 0;
    const f = doc && doc.final;
    if (f && f.dims) {
      const v = num(f.dims[dim.id]);
      if (v !== null) return clamp(round(v, 1), 0, Number(dim.max) || 0);
    }
    return Number(dim.score) || 0;
  }

  /** 某个维度当前生效的达成率（雷达图与进度条都读它，必须与分数同步） */
  function dimRatioOf(doc, dim) {
    if (!dim) return 0;
    const max = Number(dim.max) || 0;
    if (max <= 0) return 0;
    return clamp(dimScoreOf(doc, dim) / max, 0, 1);
  }

  /** 等级（按当前生效总分重算，不读 result 里那份可能已过期的 grade） */
  function gradeOf(doc) {
    const g = AG.rubric && AG.rubric.gradeOf;
    if (typeof g === 'function') return g(totalOf(doc));
    return { grade: '', label: '', color: 'var(--muted)', min: 0 };
  }

  function ensureFinal(doc) {
    if (!doc.final) doc.final = { at: 0 };
    doc.final.at = Date.now();
    return doc.final;
  }

  /** 覆写总分。传 null / 空 表示撤销该覆写。 */
  function setTotal(doc, val) {
    if (!doc || !doc.result) return false;
    const v = num(val);
    if (v === null) return revertTotal(doc);
    ensureFinal(doc).total = clamp(round(v, 1), 0, 100);
    tidy(doc);
    return true;
  }

  /** 覆写单个维度分。传 null / 空 表示撤销该维度的覆写。 */
  function setDim(doc, dimId, val) {
    const r = doc && doc.result;
    if (!r || !r.dims) return false;
    const dim = r.dims.find((d) => d.id === dimId);
    if (!dim) return false;
    const v = num(val);
    if (v === null) return revertDim(doc, dimId);
    const f = ensureFinal(doc);
    if (!f.dims) f.dims = {};
    f.dims[dimId] = clamp(round(v, 1), 0, Number(dim.max) || 0);
    tidy(doc);
    return true;
  }

  function revertTotal(doc) {
    if (!doc || !doc.final) return false;
    delete doc.final.total;
    tidy(doc);
    return true;
  }

  function revertDim(doc, dimId) {
    if (!doc || !doc.final || !doc.final.dims) return false;
    delete doc.final.dims[dimId];
    tidy(doc);
    return true;
  }

  /** 全部撤销：回到 AI 原始分。不需要任何备份，置 null 即可。 */
  function revert(doc) {
    if (!doc) return false;
    doc.final = null;
    return true;
  }

  /** 某维度是否被老师改过 */
  function isDimOverridden(doc, dimId) {
    const f = doc && doc.final;
    return !!(f && f.dims && num(f.dims[dimId]) !== null);
  }

  /**
   * 生成「终评口径」的文档浅拷贝，专供 PDF 导出使用。
   *
   * 这样做的用意：PDF 绘制层（pdf.js）只需要一份「分数已经是对的」的 result，
   * 不必知道终评这回事，也就不会在 drawDimTable / renderScoreTable 里
   * 到处散落取值分支。收敛在导出的入口处投影一次，绘制层保持原样。
   *
   * - result.total 保持 AI 原值（PDF 要用它显示「AI 建议 X 分」）
   * - result._final 是终评分（没有则不带这个字段，绘制层自然退回单值）
   * - result.dims 换成各维度终评口径的副本，ratio 与 score 同步改写
   */
  function finalView(doc) {
    if (!doc || !doc.result) return doc;
    const r = doc.result;
    const dims = (r.dims || []).map((d) => Object.assign({}, d, {
      score: dimScoreOf(doc, d),
      ratio: dimRatioOf(doc, d),
    }));
    const view = Object.assign({}, r, { dims: dims });
    if (has(doc)) view._final = totalOf(doc);
    return Object.assign({}, doc, { result: view });
  }

  AG.finalscore = {
    has,
    aiTotalOf,
    totalOf,
    dimScoreOf,
    dimRatioOf,
    gradeOf,
    recompute,
    setTotal,
    setDim,
    revertTotal,
    revertDim,
    revert,
    isDimOverridden,
    finalView,
  };
})(window);
