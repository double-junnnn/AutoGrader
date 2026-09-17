/* AutoGrader · 多引擎交叉验证（Cross-Engine Consensus）
 *
 * 单一引擎打分存在系统性偏差：本地启发式偏保守（认关键词不认语义），
 * 大模型偏宽松且不稳定（同一份报告两次打分可能差 5 分以上）。
 * 与其盲信其一，不如让两者互相监督——分歧本身就是最有价值的信号。
 *
 * 本模块做三件事：
 *   1. 分歧检测：逐维度计算标准化分歧度 D = |S_a − S_b| / max，分级标记
 *   2. 一致性度量：MAE、Pearson 相关、等级一致率，判断两引擎是否"说得上是同一件事"
 *   3. 仲裁融合：按置信度加权给出融合分，并把高分歧维度推入人工复核队列
 *
 * 没有配置 API Key 时，第二意见退化为「Bootstrap 重采样基线」——
 * 用同一引擎在重采样文本上的均值作为参照，依然能暴露"分数是否脆弱"。
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
   * @param {Object} a 结果 A（基准，通常是本地引擎）
   * @param {Object} b 结果 B（对照，通常是大模型或重采样基线）
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
      verdict = '双引擎共识'; verdictColor = '#16a34a';
      advice = '两个引擎结论接近，可直接采用融合分。';
    } else if (agreeRate >= 0.5) {
      verdict = '部分分歧'; verdictColor = '#d97706';
      advice = `有 ${reviewQueue.length} 个维度存在分歧，建议重点复核后再定分。`;
    } else {
      verdict = '显著分歧'; verdictColor = '#dc2626';
      advice = '两引擎判断差异过大，本报告不建议直接采用自动分，请人工评阅。';
    }

    return {
      a: { engine: a.engine, engineLabel: a.engineLabel, total: a.total, grade: a.grade },
      b: { engine: b.engine, engineLabel: b.engineLabel, total: b.total, grade: b.grade },
      dims, totalDiff, mae, correlation: r, agreeRate, gradeAgree,
      reviewQueue, verdict, verdictColor, advice,
      comparedAt: Date.now(),
    };
  }

  /**
   * 仲裁融合：按权重合并两引擎的维度分
   * @param {number} wA A 的权重（默认本地 0.4：稳定但保守）
   */
  function fuse(a, b, rubric, wA) {
    const wa = wA == null ? 0.4 : U.clamp(wA, 0, 1);
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
      engineLabel: `双引擎融合（${a.engineLabel} ${Math.round(wa * 100)}% + ${b.engineLabel} ${Math.round(wb * 100)}%）`,
      total, grade: g.grade, gradeLabel: g.label, gradeColor: g.color,
      dims,
      features: a.features,
      qualityFactor: a.qualityFactor,
      overall: `经双引擎交叉验证并加权融合，综合得分 ${total} 分（${g.grade} 级 · ${g.label}）。`,
      gradedAt: Date.now(),
    };
  }

  /**
   * 无 API Key 时的第二意见：用 Bootstrap 重采样均值作为对照基线。
   * 若某个维度的重采样波动很大，说明本地引擎在该维度上并不稳健。
   */
  function resampleBaseline(doc, rubric, iterations) {
    const bs = AG.reliability.bootstrap(doc, rubric, { iterations: iterations || 60 });
    if (!bs.ok) throw new Error(bs.note || '无法生成重采样基线');

    const dims = (rubric || []).map((d) => {
      const stat = bs.dims.find((x) => x.id === d.id);
      const max = Number(d.max) || 0;
      const m = stat ? stat.mean : 0;
      return {
        id: d.id, name: d.name, max,
        score: U.round(U.clamp(m * max, 0, max), 1),
        ratio: m,
        evidence: [], missing: [], penalties: [],
        comment: stat ? `重采样 ${bs.iterations} 次，得分率波动区间 ${Math.round(stat.ci[0] * 100)}%–${Math.round(stat.ci[1] * 100)}%` : '',
      };
    });

    return {
      docName: doc.name,
      engine: 'resample',
      engineLabel: `重采样基线（${bs.iterations} 次）`,
      total: U.round(bs.mean, 1),
      grade: AG.rubric.gradeOf(bs.mean).grade,
      gradeLabel: AG.rubric.gradeOf(bs.mean).label,
      gradeColor: AG.rubric.gradeOf(bs.mean).color,
      dims,
      features: doc.features,
      qualityFactor: doc.result ? doc.result.qualityFactor : 1,
      overall: `以段落重采样 ${bs.iterations} 次得到的稳健基线：均值 ${bs.mean} 分，95% 置信区间 [${bs.ci[0]}, ${bs.ci[1]}]。`,
      gradedAt: Date.now(),
    };
  }

  AG.consensus = { compare, fuse, resampleBaseline, levelOf, LEVELS };
})(window);
