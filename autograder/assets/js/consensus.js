/* AutoGrader · 多模型交叉验证（Cross-Model Consensus）
 *
 * 【2026-09 变更】本地启发式引擎已移除（需求①「本地评分是否保留」→ 不保留），
 * 原先的「本地 vs 大模型」双引擎对比失去了其中一方。
 *
 * 但需求①还点名要解决另一件事：「需解决每次调用模型评分结果差异化的问题」。
 * 所以交叉验证不但要留，还得换个更对题的实现：
 *     旧：本地正则引擎  vs  大模型            —— 拿更差的裁判监督更好的裁判
 *     新：主模型        vs  校验模型（跨族）   —— 两个独立判断互检
 *
 * 为什么强调**跨模型族**：让 Qwen 和 GLM 互检，比让 Qwen 自检有意义得多。
 * 同族模型共享训练数据与偏好，打分偏差方向一致，互检会把系统性偏差误当成共识。
 * AG.providers.pickReviewer() 就是按这个原则挑对照模型的。
 *
 * 本模块做三件事：
 *   1. 分歧检测：逐维度计算标准化分歧度 D = |S_a − S_b| / max，分级标记
 *   2. 一致性度量：MAE、Pearson 相关、等级一致率，判断两模型是否"说得上是同一件事"
 *   3. 仲裁融合：按置信度加权给出融合分，并把高分歧维度推入人工复核队列
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const LEVELS = [
    { max: 0.15, level: 'agree', label: '一致', color: '#16a34a' },
    { max: 0.30, level: 'minor', label: '轻微分歧', color: '#d97706' },
    { max: 1.01, level: 'major', label: '显著分歧', color: '#dc2626' },
  ];

  function levelOf(r) {
    return LEVELS.find((l) => r < l.max) || LEVELS[LEVELS.length - 1];
  }

  /**
   * 对比两份评分结果
   * @param {Object} a 结果 A（主模型，作为基准）
   * @param {Object} b 结果 B（校验模型，作为对照）
   * @param {Array} rubric
   */
  function compare(a, b, rubric) {
    if (!a || !b) throw new Error('需要两份评分结果才能对比');

    const byId = {};
    (b.dims || []).forEach((d) => { byId[d.id] = d; });

    const dims = (a.dims || []).map((d) => {
      const o = byId[d.id];
      const max = Number(d.max) || 1;
      const sb = o ? o.score : 0;
      const diff = U.round(d.score - sb, 1);
      const ratio = U.clamp(Math.abs(diff) / max, 0, 1);
      const lv = levelOf(ratio);
      return {
        id: d.id, name: d.name, max: Number(d.max),
        scoreA: d.score, scoreB: U.round(sb, 1),
        diff, diffRatio: U.round(ratio, 3),
        level: lv.level, levelLabel: lv.label, color: lv.color,
        higher: diff > 0 ? 'A' : diff < 0 ? 'B' : '=',
      };
    }).sort((x, y) => y.diffRatio - x.diffRatio);

    const totalDiff = U.round(a.total - b.total, 1);
    const mae = U.round(dims.reduce((s, d) => s + Math.abs(d.diff), 0) / (dims.length || 1), 2);
    const r = U.round(AG.reliability.pearson(
      dims.map((d) => d.scoreA / (d.max || 1)),
      dims.map((d) => d.scoreB / (d.max || 1)),
    ), 3);
    const agreeRate = U.round(dims.filter((d) => d.level === 'agree').length / (dims.length || 1), 3);
    const gradeAgree = a.grade === b.grade;
    const reviewQueue = dims.filter((d) => d.level !== 'agree');

    let verdict, verdictColor, advice;
    if (agreeRate >= 0.75 && Math.abs(totalDiff) <= 5) {
      verdict = '双模型共识'; verdictColor = '#16a34a';
      advice = '两个模型结论接近，可直接采用融合分。';
    } else if (agreeRate >= 0.5) {
      verdict = '部分分歧'; verdictColor = '#d97706';
      advice = `有 ${reviewQueue.length} 个维度存在分歧，建议重点复核后再定分。`;
    } else {
      verdict = '显著分歧'; verdictColor = '#dc2626';
      advice = '两模型判断差异过大，本报告不建议直接采用自动分，请人工评阅。';
    }

    return {
      a: { engine: a.engine, engineLabel: a.engineLabel, total: a.total, grade: a.grade, model: a.model },
      b: { engine: b.engine, engineLabel: b.engineLabel, total: b.total, grade: b.grade, model: b.model },
      dims, totalDiff, mae, correlation: r, agreeRate, gradeAgree,
      reviewQueue, verdict, verdictColor, advice,
      // 未配校验模型时，第二意见是同模型高温度重采样，结论强度要打折——如实告知
      degraded: !!(b && b.sameModelNote),
      degradedNote: b && b.sameModelNote ? b.sameModelNote : null,
      comparedAt: Date.now(),
    };
  }

  /**
   * 仲裁融合：按权重合并两个模型的维度分
   * @param {number} wA A 的权重（默认 0.5：两个模型地位对等，不再默认偏袒"稳定"的一方）
   *
   * 旧实现默认 0.4 给本地引擎（理由是"稳定但保守"）。本地引擎删掉后，
   * 两个都是模型，没有理由预设谁更可信，所以默认改成对半。
   */
  function fuse(a, b, rubric, wA) {
    const wa = wA == null ? 0.5 : U.clamp(wA, 0, 1);
    const wb = 1 - wa;
    const byId = {};
    (b.dims || []).forEach((d) => { byId[d.id] = d; });

    const dims = (a.dims || []).map((d) => {
      const o = byId[d.id];
      const max = Number(d.max) || 0;
      const score = U.clamp(U.round(d.score * wa + (o ? o.score : d.score) * wb, 1), 0, max);
      return Object.assign({}, d, {
        score,
        ratio: U.round(score / (max || 1), 3),
        fusedFrom: { a: d.score, b: o ? o.score : d.score, wA: wa },
        comment: d.comment,
      });
    });

    const raw = dims.reduce((s, d) => s + d.score, 0);
    const scale = (rubric || []).reduce((s, d) => s + (Number(d.max) || 0), 0) || 100;
    const total = U.clamp(U.round(raw * 100 / scale, 1), 0, 100);
    const g = AG.rubric.gradeOf(total);

    return {
      docName: a.docName,
      engine: 'fused',
      engineLabel: `双模型融合（${a.engineLabel} ${Math.round(wa * 100)}% + ${b.engineLabel} ${Math.round(wb * 100)}%）`,
      total, grade: g.grade, gradeLabel: g.label, gradeColor: g.color,
      dims,
      features: a.features,
      overall: `经双模型交叉验证并加权融合，综合得分 ${total} 分（${g.grade} 级 · ${g.label}）。`,
      gradedAt: Date.now(),
    };
  }

  /**
   * 采样基线：对同一份文档用同一模型评 N 次，看分数散成什么样。
   *
   * 这替代了原先的 Bootstrap 段落重采样基线。旧做法反复调用本地引擎打分，
   * 测的是"删掉 15% 段落分变不变"；本地引擎没了，而且那个问题对教师也不重要——
   * 教师真正想问的是「同一份作业，明天再评一遍会不会换个分」。
   * 直接采样回答的正是这个问题。
   */
  async function samplingBaseline(doc, rubric, opts) {
    opts = opts || {};
    // 统计口径统一交给 reliability.stability，避免两处各算一套分位数
    const st = await AG.reliability.stability(doc, rubric, { iterations: opts.iterations || 5 });
    if (!st.ok) return st;

    return Object.assign({}, st, {
      engine: 'llm-sampled',
      engineLabel: `采样基线（${st.iterations} 次 · ${st.model}）`,
      overall: `同一份报告用 ${st.model} 连续评阅 ${st.iterations} 次：均值 ${st.mean} 分，` +
        `区间 ${st.range[0]}–${st.range[1]} 分（极差 ${st.spread} 分）。`,
      gradedAt: Date.now(),
    });
  }

  AG.consensus = { compare, fuse, samplingBaseline, levelOf, LEVELS };
})(window);
