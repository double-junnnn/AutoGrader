/* AutoGrader · 评分量表（Rubric）
 * 默认量表面向「计算机专业实验报告」，共 8 个维度、满分 100。
 *
 * 【2026-09 变更】本地启发式评分引擎已移除（需求①「本地评分是否保留」→ 不保留），
 * 因此 signals / penalties 里的正则**不再参与任何打分计算**，只作为
 * 「评分准则」的结构化表述下发给大模型，约束它逐项覆盖、不漏维度。
 * 也就是说：它们现在是**给模型看的评分要点清单**，不是给机器算分的特征词典。
 *
 * 这一改动顺带解决了旧版的一个根本矛盾：同一套正则既要驱动本地打分、
 * 又要写进 Prompt，等于让规则引擎和语义引擎共用一套口径——
 * 结果是谁都不准。现在口径只有一套：模型的语义判断，正则只负责把维度讲清楚。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  const DEFAULT_RUBRIC = [
    {
      id: 'purpose', name: '实验目的与原理', max: 15,
      desc: '是否阐明实验目标、背景意义与所依赖的理论/算法原理。',
      keys: ['目的','目标','原理','背景','意义','理论','思想','复杂度','旨在','要求'],
      signals: [
        { label: '明确实验目的', re: /实验目的|实验目标|本次实验|实验要求|旨在|目标是|目的是/g, w: 3 },
        { label: '阐述原理/理论', re: /原理|理论基础|算法原理|基本思想|核心思想|工作机制/g, w: 3 },
        { label: '说明背景与意义', re: /背景|意义|应用场景|应用价值|实际需求/g, w: 2 },
        { label: '给出学习目标', re: /掌握|理解|熟悉|学会|加深对/g, w: 1.5 },
        { label: '涉及复杂度分析', re: /时间复杂度|空间复杂度|O\(|渐进|复杂度分析/g, w: 1.5 },
      ],
      penalties: [{ label: '未出现任何目的性描述', re: /^(?![\s\S]*?(目的|目标|旨在|旨在))/, w: 4 }],
      advice: '建议开篇用 1–2 段写清「为什么做这个实验、要验证什么」，并简述算法原理与复杂度。',
    },
    {
      id: 'env', name: '实验环境与步骤', max: 10,
      desc: '实验环境（系统/语言/依赖版本）与操作步骤是否完整、可复现。',
      keys: ['环境','配置','依赖','版本','安装','步骤','过程','复现','运行','系统'],
      signals: [
        { label: '说明软硬件环境', re: /实验环境|运行环境|开发环境|操作系统|Windows|Linux|macOS|Ubuntu/g, w: 2.5 },
        { label: '语言与版本', re: /Python|Java|C\+\+|Go|JavaScript|Node|版本|version|3\.\d+|JDK/g, w: 2 },
        { label: '依赖与配置', re: /依赖|安装|配置|pip|npm|requirements|环境搭建|编译器|IDE/g, w: 2 },
        { label: '给出实验步骤', re: /实验步骤|操作步骤|实验过程|流程|步骤如下|第一步|首先/g, w: 2.5 },
        { label: '可复现说明', re: /复现|运行方式|启动|执行命令|README/g, w: 1 },
      ],
      penalties: [],
      advice: '建议列出「系统 + 语言版本 + 关键依赖」三元组，并用编号步骤描述实验过程。',
    },
    {
      id: 'code', name: '核心实现与代码质量', max: 25,
      desc: '核心算法/功能是否实现，代码结构、命名、注释与可读性水平。',
      keys: ['代码','实现','函数','类','模块','架构','设计','注释','异常','边界','封装','算法'],
      signals: [
        { label: '包含代码实现', re: /代码|实现|函数|方法|类|模块|接口|算法实现|核心逻辑/g, w: 4 },
        { label: '给出关键代码片段', re: /```|def |class |public |function |#include|int main/g, w: 4 },
        { label: '有注释说明', re: /\/\/|\/\*|#\s*\w|"""|'''|注释/g, w: 2 },
        { label: '体现设计思路', re: /设计|架构|结构|模块划分|封装|解耦|设计模式/g, w: 2 },
        { label: '涉及边界/异常处理', re: /边界|异常|错误处理|try|catch|except|健壮性|鲁棒/g, w: 1.5 },
      ],
      penalties: [{ label: '全文未出现任何代码块', re: /^(?![\s\S]*?```)[\s\S]*$/, w: 8 }],
      advice: '建议贴出核心函数（而非全量代码），配注释说明关键分支，并交代异常/边界处理。',
    },
    {
      id: 'result', name: '实验结果与数据', max: 20,
      desc: '是否给出真实运行结果、截图、测试数据与量化指标。',
      keys: ['结果','输出','截图','图表','测试','数据','指标','性能','表格','运行'],
      signals: [
        { label: '呈现运行结果', re: /运行结果|输出结果|实验结果|控制台|输出如下|运行截图|截图/g, w: 3.5 },
        { label: '含图表编号与说明', re: /图\s*\d|表\s*\d|如图|下表|Figure|Table/g, w: 3 },
        { label: '给出量化数据', re: /\d+(\.\d+)?\s*(ms|毫秒|s|秒|MB|GB|%|次|条|个)|\d+\.\d+/g, w: 3 },
        { label: '有测试用例', re: /测试用例|测试数据|样例|输入：|输出：|case|样例输入/g, w: 2.5 },
        { label: '多组对比数据', re: /对比|对照组|不同规模|规模为|分别测试|多次实验/g, w: 2 },
      ],
      penalties: [{ label: '结果部分几乎无数据支撑', re: /^(?![\s\S]*?\d)[\s\S]*$/, w: 5 }],
      advice: '建议用表格呈现≥3 组不同规模的测试数据（含单位），并配运行截图。',
    },
    {
      id: 'analysis', name: '结果分析与讨论', max: 15,
      desc: '是否对数据作出解释、对比与归因，而非仅罗列结果。',
      keys: ['分析','讨论','对比','趋势','原因','表明','验证','差异','归因','解释'],
      signals: [
        { label: '有结果分析', re: /分析|讨论|可以看出|由此可见|结果表明|说明|原因在/g, w: 4 },
        { label: '做横向对比', re: /相比之下|与之相比|优于|低于|高于|快于|慢于|差距|差异/g, w: 3 },
        { label: '解释趋势与成因', re: /趋势|增长|下降|随着|呈|因为|由于|导致|归因/g, w: 3 },
        { label: '验证理论预期', re: /符合|验证|一致|预期|理论上|复杂度|O\(/g, w: 2.5 },
      ],
      penalties: [],
      advice: '建议回答「数据为什么是这样」：结合复杂度/数据规模解释性能差异，而非只描述现象。',
    },
    {
      id: 'debug', name: '问题与解决', max: 8,
      desc: '是否记录实验中遇到的问题、排查过程与解决方案。',
      keys: ['问题','错误','报错','异常','解决','调试','修复','排查','bug','失败'],
      signals: [
        { label: '描述问题/报错', re: /问题|错误|异常|报错|bug|Bug|Exception|Error|失败/g, w: 3 },
        { label: '给出解决过程', re: /解决|调试|debug|修复|排查|处理方法|改为|调整后/g, w: 3 },
        { label: '总结避坑经验', re: /注意|坑|教训|经验|避免|建议/g, w: 2 },
      ],
      penalties: [],
      advice: '建议记录 1–2 个真实报错（含错误信息、定位过程、修复方式），这是报告含金量的关键。',
    },
    {
      id: 'summary', name: '总结与反思', max: 5,
      desc: '是否有结论、收获与后续改进方向的思考。',
      keys: ['总结','结论','收获','反思','改进','展望','不足','体会','心得'],
      signals: [
        { label: '有总结/结论', re: /总结|小结|结论|总而言之|综上/g, w: 2.5 },
        { label: '写个人收获', re: /收获|心得|体会|感受|学到的/g, w: 1.5 },
        { label: '提出改进方向', re: /不足|改进|优化方向|后续|展望|下一步/g, w: 1.5 },
      ],
      penalties: [
        { label: '总结空洞，仅有套话', re: /收获(很)?大|学到(了)?很多|受益匪浅|加深了(对)?[^，。]{0,10}的?(认识|理解)$/g, w: 1.2 },
      ],
      advice: '建议用 3 句话收尾：做成了什么、还差什么、下一步怎么改。避免「收获很大」这类空话。',
    },
    {
      id: 'format', name: '格式规范与引用', max: 2,
      desc: '排版结构、图表编号、参考文献引用是否规范。',
      keys: ['格式','排版','编号','标题','参考文献','引用','规范','标点'],
      signals: [
        { label: '有标题层级', re: /^#{1,4}\s|\n\s*[一二三四五六七八九十]+、|\n\s*\d+(\.\d+)?[、.]/g, w: 1 },
        { label: '有参考文献', re: /参考文献|参考资料|\[\d+\]|et\s+al|引用/g, w: 1 },
      ],
      penalties: [
        { label: '存在占位符/未完成标记', re: /TODO|待补充|待完善|XXX|占位|略\.\.\.|？？？/g, w: 1 },
      ],
      advice: '建议统一标题编号、图表编号，并补充参考文献。',
    },
  ];

  /* 结构化特征：跨维度使用，用于计算整体质量系数 */
  const STRUCT_PATTERNS = {
    heading: /(^|\n)\s*(#{1,6}\s+.+|[一二三四五六七八九十]+[、.].{0,40}|\d+(\.\d+)?[、.]\s*\S.{0,40})/g,
    codeBlock: /```[\s\S]*?```/g,
    inlineCode: /`[^`\n]+`/g,
    figure: /(图\s*\d+|Figure\s*\d+|!\[|<img)/gi,
    table: /(\|\s*.+\s*\|)|(表\s*\d+)/g,
    reference: /(参考文献|参考资料|\[\d+\])/g,
    number: /\d+(\.\d+)?/g,
  };

  const GRADE_BANDS = [
    { min: 90, grade: 'A', label: '优秀', color: '#16a34a' },
    { min: 80, grade: 'B', label: '良好', color: '#2563eb' },
    { min: 70, grade: 'C', label: '中等', color: '#0891b2' },
    { min: 60, grade: 'D', label: '及格', color: '#d97706' },
    { min: 0, grade: 'F', label: '待改进', color: '#dc2626' },
  ];

  function gradeOf(score) {
    return GRADE_BANDS.find((b) => score >= b.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
  }

  /**
   * 拷贝一份量表。
   * 注意：不能用 JSON 深拷贝 —— 正则对象会被序列化成 {}，导致评分引擎失效。
   */
  function cloneRubric(rubric) {
    const src = rubric || DEFAULT_RUBRIC;
    return src.map((d) => Object.assign({}, d, {
      keys: (d.keys || []).slice(),
      signals: (d.signals || []).map((s) => Object.assign({}, s)),
      penalties: (d.penalties || []).map((p) => Object.assign({}, p)),
    }));
  }

  /** 序列化为可存入 localStorage 的普通对象（正则转为 {source, flags}） */
  function serializeRubric(rubric) {
    const conv = (arr) => (arr || []).map((s) => ({
      label: s.label, w: s.w,
      re: { source: s.re && s.re.source ? s.re.source : '.', flags: s.re && s.re.flags ? s.re.flags : 'g' },
    }));
    return (rubric || []).map((d) => ({
      id: d.id, name: d.name, max: Number(d.max) || 0, desc: d.desc || '', advice: d.advice || '',
      enabled: d.enabled !== false,
      keys: (d.keys || []).slice(),
      locked: !!d.locked,
      signals: conv(d.signals), penalties: conv(d.penalties),
    }));
  }

  /** 反序列化：还原 RegExp，非法正则自动降级为通用匹配，不会中断评分 */
  function deserializeRubric(data) {
    if (!data || !data.length) return cloneRubric();
    const conv = (arr) => (arr || []).map((s) => {
      let re;
      try { re = new RegExp(s.re.source, s.re.flags); } catch (e) { re = /./g; }
      return { label: s.label, w: Number(s.w) || 1, re };
    });
    return data.map((d) => ({
      id: d.id, name: d.name, max: Number(d.max) || 0, desc: d.desc, advice: d.advice,
      enabled: d.enabled !== false,
      keys: (d.keys || []).slice(),
      locked: !!d.locked,
      signals: conv(d.signals), penalties: conv(d.penalties),
    }));
  }

  /** 校验量表总分，返回 { total, valid, message } */
  function validateRubric(rubric) {
    const total = rubric.reduce((s, d) => s + (Number(d.max) || 0), 0);
    return {
      total,
      valid: Math.abs(total - 100) < 0.001,
      message: Math.abs(total - 100) < 0.001 ? '总分 100' : `当前总分 ${total}，需调整为 100`,
    };
  }

  AG.rubric = {
    DEFAULT_RUBRIC,
    STRUCT_PATTERNS,
    GRADE_BANDS,
    gradeOf,
    cloneRubric,
    serializeRubric,
    deserializeRubric,
    validateRubric,
  };
})(window);
