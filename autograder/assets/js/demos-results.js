/* AutoGrader · 内置示例的**预置评阅结果**
 * ------------------------------------------------------------
 * 为什么需要它（P0）：
 * 本地启发式引擎下线后，评分必须走大模型。可对一个还没配 API Key 的人
 * （评委、刚下载想先看一眼的教师）来说，「加载示例」点下去如果只会弹一条
 * 红字报错、再把人踢到设置页，那整个产品在他眼里就是不存在的——
 * 评阅结果、可视化、导出，一行都看不到。
 *
 * 这里的做法：随源码内置 3 份**与示例报告一一对应的预置评分结果**。
 * 无 Key 时点「加载示例」，直接用这份预置结果渲染出完整结果页，
 * 让人立刻看到产品长什么样；等他自己上传报告要真评分时，才要求配 Key。
 *
 * 三条纪律：
 * 1. 预置结果**只服务内置示例**，绝不冒充真实评分；结果页会挂「示例演示」标记，
 *    并写明「非本次模型输出」，避免把演示分数误当成本次评阅结论。
 * 2. 预置数据只存「各维度得分 + 评语 + 证据要点」，**不存死总分**——
 *    真正的 result 对象在回放时按**当前量表**现组装（见 build()），
 *    这样即使用户改过量表，示例也不会出现「维度对不上」的错位。
 * 3. 证据要点是示例报告里的真实原文，回放时同样走一遍本地证据核验，
 *    与真实评阅保持同一套展示口径。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* 按「示例报告名」索引的预置维度数据。
   * dims 以**维度 id** 为键（purpose/env/code/result/analysis/debug/summary/format）。
   * evidence 里的每条都是<b>示例报告中的逐字原文</b>——回放时会走与真实评阅同一套
   * 本地证据核验，所以这里必须是真原文，不能编，否则演示里会自己亮出「证据存疑」。 */
  const PRESET = {
    '示例A-高质量报告(排序算法).md': {
      total: 94,
      overall: '结构完整、逻辑清晰：三种排序算法均给出实现与复杂度推导，性能对比表格与实际数据一致，分析部分把「渐进复杂度不等于实际性能」解释得很到位。扣分点集中在个别函数缺少边界注释，以及参考文献未标注访问日期。',
      dims: {
        purpose: { score: 15, evidence: ['本次实验旨在掌握冒泡排序、快速排序与归并排序三种经典排序算法', '加深对时间复杂度的理解'], comment: '目的明确，并与后续实验内容一致，符合要求。' },
        env: { score: 10, evidence: ['操作系统：Ubuntu 22.04 LTS', 'Python 3.10.12', 'numpy 1.24.3、matplotlib 3.7.1'], comment: '环境信息完整到版本号，可复现性好。' },
        code: { score: 23, evidence: ['def quick_sort(arr):', 'def merge_sort(arr):'], comment: '核心算法实现正确、命名规范；个别辅助函数缺少边界条件注释。' },
        result: { score: 19, evidence: ['n=50000 的随机数据下，快速排序耗时 0.42 s', '比冒泡排序的 182.34 s 快约 434 倍'], comment: '给出了完整性能数据与对比表，数据翔实。' },
        analysis: { score: 15, evidence: ['归并排序耗时 0.55 s 略高于快排', '需要频繁申请临时数组'], comment: '对差异做了归因，而非仅罗列数字，分析有深度。' },
        debug: { score: 6, evidence: ['RecursionError: maximum recursion depth exceeded', '改为每轮运行 5 次取中位数后数据稳定'], comment: '记录了典型问题与解决过程，略偏简略。' },
        summary: { score: 5, evidence: ['不足之处在于未测试链表结构下的表现'], comment: '有结论、有反思、有后续方向，完整。' },
        format: { score: 1, evidence: [], comment: '章节编号规范；参考文献未标注访问日期，扣 1 分。' },
      },
    },
    '示例B-中等质量报告.md': {
      total: 61,
      overall: '主体内容齐备，能看出确实动手做了实验，但深度不足：结果部分缺少系统性量化指标，分析停留在「符合预期」这类结论上，未对数据做进一步解释。代码可读性尚可，但实验步骤过于笼统，别人照着很难复现。',
      dims: {
        purpose: { score: 12, evidence: ['本次实验的目的是了解几种常见的排序算法'], comment: '目的表述偏笼统，未说明要对比什么、验证什么。' },
        env: { score: 7, evidence: ['Ubuntu 22.04'], comment: '只写了系统与语言，未给库版本，复现性弱。' },
        code: { score: 17, evidence: ['def bubble_sort(arr):'], comment: '核心实现存在，但缺少注释与复杂度说明。' },
        result: { score: 11, evidence: ['n=1000 时冒泡排序耗时 0.52 s，快速排序耗时 0.008 s'], comment: '给了单点数据，但缺少规模梯度与可核对的完整表格。' },
        analysis: { score: 9, evidence: [], comment: '分析停留在结论层，未对数据差异做出解释。' },
        debug: { score: 3, evidence: [], comment: '问题记录很少，缺少排查过程。' },
        summary: { score: 2, evidence: [], comment: '总结过于简短，无反思与改进方向。' },
        format: { score: 0, evidence: [], comment: '图表未编号、无参考文献，格式规范性欠缺。' },
      },
    },
    '示例C-疑似抄袭A的版本.md': {
      total: 58,
      overall: '内容与示例A高度雷同，但在改写过程中出现了明显的信息损耗：删去了复杂度推导与误差讨论，分析段落被压缩成结论式短句。分数偏低不只是因为「抄」，更因为改写后确实丢了原报告最扎实的部分。',
      dims: {
        purpose: { score: 11, evidence: ['本次实验旨在掌握冒泡排序、快速排序与归并排序三种经典排序算法'], comment: '目的与A一致但删去了「加深复杂度理解」的落点。' },
        env: { score: 8, evidence: ['Ubuntu 22.04'], comment: '环境信息与A雷同，缺部分版本号。' },
        code: { score: 16, evidence: ['def quick_sort(arr):'], comment: '代码与A高度相似；注释被删减，可读性下降。' },
        result: { score: 10, evidence: ['n=50000 的随机数据下，快速排序耗时 0.42 s'], comment: '保留了数据但背景说明缺失。' },
        analysis: { score: 8, evidence: [], comment: '删去了A中关于内存分配的归因，分析深度明显削弱。' },
        debug: { score: 3, evidence: [], comment: '问题记录与A不一致，疑似拼接。' },
        summary: { score: 2, evidence: [], comment: '总结被压缩为一句，缺少反思。' },
        format: { score: 0, evidence: [], comment: '格式与A雷同，无独立排版。' },
      },
    },
  };

  /** 预置结果的通用元信息（引擎标签固定标注为「示例演示」，不冒充模型输出） */
  const PRESET_META = {
    engine: 'preset',
    engineLabel: '示例演示 · 预置结果（非模型实时输出）',
    model: '（示例）',
    gradedAt: 0,   // 回放时填当前时间
  };

  /** 默认量表各维度的满分。预置分值按这套满分给出，
   *  回放时若用户改过量表分值，按「得分率」等比重算到新满分。
   *  ⚠ 必须与 rubric-templates.js 的 cs-code（通用编程实验）逐项一致：
   *  该模板是新建量表时的默认选项，两者不一致会导致示例演示的得分率整体偏移。 */
  const DEFAULT_MAX = { purpose: 12, env: 8, code: 25, result: 20, analysis: 15, debug: 8, summary: 7, format: 5 };

  /**
   * 取「要点」在原文中的上下文窗口：向前后各扩一点，让摘录读起来是完整的一句话，
   * 而不是把要点原样再念一遍。找不到时退回要点本身。
   */
  function contextOf(text, needle) {
    const src = String(text || '');
    const i = src.indexOf(needle);
    if (i < 0) return needle;
    const start = Math.max(0, i - 12);
    const end = Math.min(src.length, i + needle.length + 16);
    let out = src.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) out = '…' + out;
    if (end < src.length) out = out + '…';
    return out.slice(0, 90);
  }

  /**
   * 取「判定依据」引用用的**逐字连续原文**。
   * 与 contextOf 的关键区别：contextOf 会加省略号、折叠空白，方便人读；
   * 但引用要做逐字回查，加了 `…` 就不是原文的子串了，核验必然失败。
   * 所以这里返回的必须是报告里真实存在的一段连续文本。
   */
  function exactQuoteOf(text, needle, span) {
    const src = String(text || '');
    const i = src.indexOf(needle);
    if (i < 0) return null;
    const want = span || 70;
    let start = Math.max(0, i - 6);
    let end = Math.min(src.length, i + needle.length + 10);
    // 向前后扩到接近 want 长度，但只在原文内滑动，保证切出来的一定是原文子串
    while (end - start < want && (start > 0 || end < src.length)) {
      if (start > 0) start--;
      if (end - start >= want) break;
      if (end < src.length) end++;
    }
    const out = src.slice(start, end);
    return out.trim() || null;
  }

  /**
   * 组装一份可被 renderResult 直接渲染的 result 对象。
   * @param {String} demoName 示例报告名（PRESET 的键）
   * @param {Array}  rubric   当前生效量表（用于取维度名称/满分/顺序，保证不错位）
   * @param {Object} doc      文档对象（提供 features 与正文，用于证据核验）
   * @returns {Object|null}
   */
  function build(demoName, rubric, doc) {
    const preset = PRESET[demoName];
    if (!preset) return null;
    const rubricDims = (rubric || []).filter((d) => d.enabled !== false);
    if (!rubricDims.length) return null;

    const dims = rubricDims.map((dim) => {
      const p = preset.dims[dim.id] || {};
      const max = Number(dim.max) || 0;
      const baseMax = DEFAULT_MAX[dim.id] || 100;
      // 预置分值按默认满分给出；若用户改过量表分值，按得分率等比重算，避免「得分 > 满分」错位
      const rate = p.score == null ? 0 : U.clamp(Number(p.score) / baseMax, 0, 1);
      const score = U.clamp(U.round(rate * max, 1), 0, max);
      // 每条证据都带上 snippet（原文片段），与真实评阅的展示形态一致：
      // label 用于核验与列表；snippets[0].snippet 用于「命中原文证据」区块。
      // snippet 取要点在原文里的**上下文窗口**（而非重复一遍要点本身），
      // 这样「要点：原文摘录」读起来才有信息增量。
      const evidence = (p.evidence || []).map((t) => {
        const label = String(t).slice(0, 60);
        const ctx = contextOf(doc ? doc.text : '', String(t));
        return { label, snippets: [{ snippet: ctx }] };
      });
      /* 原文引用：真实评阅要求模型必须给出引用原文，示例演示也照同一形态给，
       * 否则老师会以为"这个功能只有真跑模型才有"。这里直接复用预置要点在原文中的
       * 上下文窗口，与 evidence 同源，因此必定真实可查。 */
      const citations = (p.evidence || []).slice(0, 3).map((t) => {
        const label = String(t);
        // 必须用逐字原文：引用要被逐字回查，加了省略号就查不到了
        const quote = exactQuoteOf(doc ? doc.text : '', label);
        return quote ? { quote, where: '示例报告原文', note: '', verified: true } : null;
      }).filter(Boolean);
      const verify = AG.analyzer && AG.analyzer.verifyEvidence
        ? AG.analyzer.verifyEvidence(doc ? doc.text : '', evidence)
        : null;
      /* 档位：预置结果同样走一遍锚点判定，让示例演示与真实评阅的展示口径一致。
       * 否则会出现"示例没有档位、真实评阅有档位"的割裂感。 */
      const A = AG.anchors;
      const bands = A && max ? A.anchorsFor(dim) : [];
      const lv = A && max ? A.levelOf(score, max) : null;
      const hit = bands.find((b) => b.idx === lv) || null;
      return {
        id: dim.id,
        name: dim.name,
        desc: dim.desc,
        advice: dim.advice,
        max,
        score,
        ratio: U.round(score / (max || 1), 3),
        level: hit ? hit.idx : null,
        levelName: hit ? hit.name : '',
        // 示例结果不跑模型，因此没有"模型认为的理由"。与其编一句，不如直说这是预置档位，
        // 让老师一眼分清"演示数据"与"真实评阅理由"。
        levelReason: hit
          ? `预置演示数据：该维度 ${score}/${max} 分落在「${hit.name}」档（${hit.lo}–${hit.hi} 分）。真实评阅时此处会给出模型的定档理由。`
          : '',
        bandRange: hit ? [hit.lo, hit.hi] : null,
        crossBand: false,
        evidence,
        citations,
        missing: [],
        penalties: [],
        comment: p.comment || '',
        evidenceCheck: verify,
      };
    });

    const total = U.clamp(U.round(dims.reduce((s, d) => s + d.score, 0), 1), 0, 100);
    /* 区间口径必须与 llm.js assemble() 完全一致，否则「示例」和「真实评阅」会给出
     * 两种宽度的区间，老师一眼就看出不一致。收窄逻辑同 assemble()：以实际得分
     * 为中心，按各维度档内可浮动空间取半径，夹在 2~8 分内。 */
    const graded = dims.filter((d) => d.bandRange);
    const rawLo = graded.length
      ? Math.min(100, U.round(dims.reduce((s, d) => s + (d.bandRange ? d.bandRange[0] : d.score), 0), 1))
      : total;
    const rawHi = graded.length
      ? Math.min(100, U.round(dims.reduce((s, d) => s + (d.bandRange ? d.bandRange[1] : d.score), 0), 1))
      : total;
    const downRoom = Math.max(0, total - rawLo);
    const upRoom = Math.max(0, rawHi - total);
    let radius = Math.max(downRoom, upRoom) / 2;
    radius = U.clamp(radius, 2, 4);
    radius = Math.min(radius, Math.max(downRoom, upRoom));
    const lo = U.clamp(U.round(total - Math.min(radius, downRoom), 1), 0, 100);
    const hi = U.clamp(U.round(total + Math.min(radius, upRoom), 1), 0, 100);
    const range = graded.length ? [lo, hi] : null;
    const g = AG.rubric.gradeOf(total);
    const gradeAtLo = AG.rubric.gradeOf(lo);
    const gradeAtHi = AG.rubric.gradeOf(hi);
    const straddles = !!(range && gradeAtLo.grade !== gradeAtHi.grade);
    const features = (doc && doc.features) || (doc ? AG.parser.extractFeatures(doc.text) : null);
    // 证据核验汇总：与真实评阅同一口径（引用原文条数 / 其中查无此句的条数）
    const audited = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.total) || 0), 0);
    const hallucinated = dims.reduce((s, d) => s + ((d.evidenceCheck && d.evidenceCheck.hallucinated) || []).length, 0);
    /* 引用核查汇总：与 llm.js assemble() 同一口径。
     * 示例演示若缺这一块，结果页就不会显示「原文引用核查」提示，
     * 老师会以为这个功能只有真跑模型时才有 —— 与"示例即产品全貌"的初衷相悖。 */
    const citeTotal = dims.reduce((s, d) => s + ((d.citations || []).length), 0);
    const citeBad = dims.reduce((s, d) => s + ((d.citations || []).filter((c) => !c.verified).length), 0);
    const citeMissingDims = dims.filter((d) => !(d.citations || []).length).map((d) => d.name);

    return {
      docName: doc ? doc.name : demoName,
      engine: PRESET_META.engine,
      engineLabel: PRESET_META.engineLabel,
      model: PRESET_META.model,
      total,
      range,
      straddles,
      gradeStraddle: straddles ? gradeAtLo.grade + '–' + gradeAtHi.grade : null,
      grade: g.grade,
      gradeLabel: g.label,
      gradeColor: g.color,
      dims,
      features,
      overall: preset.overall || '',
      evidenceAudit: { total: audited, hallucinated },
      citationAudit: {
        total: citeTotal,
        verified: citeTotal - citeBad,
        unverified: citeBad,
        missingDims: citeMissingDims,
      },
      unanswered: [],
      anchorAudit: { graded: graded.length, total: dims.length, crossBands: 0, crossBandNames: [] },
      qualityFactor: '1.00',
      scaled: false,
      isPreset: true,     // renderResult 据此挂「示例演示」标记
      gradedAt: Date.now(),
    };
  }

  AG.demoResults = {
    has: (name) => !!PRESET[name],
    build,
    names: Object.keys(PRESET),
  };
})(typeof window !== 'undefined' ? window : globalThis);
