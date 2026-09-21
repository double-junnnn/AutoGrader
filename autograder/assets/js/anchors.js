/* AutoGrader · 评分锚点（Scoring Anchors）
 *
 * 解决的问题：旧版把量表下发给模型时，只说了「每个维度给 0 到 max 之间的分数」。
 * 没有行为参照，模型只能凭手感给分——同一份报告今天给 12、明天给 8 都"合规"。
 * 实测中这表现为：同一份作业连评 8 次，总分极差可达十几分。
 *
 * 锚点制是评分科学里最标准的解法：把「分数」翻译成「可观察的行为」。
 * 例如「复杂度分析」满分 16，不写 16，而是写：
 *   最高档：推导了递推式并按数据规模验证，区分最好/最坏情形
 *   次高档：给出正确复杂度结论，推导过程简略
 *   ……
 * 模型必须先选定档位、再在档位区间内取值。分数因此变得可复现、可解释。
 *
 * ── 两条设计取舍 ──
 *
 * 1. 档位边界由满分**自动推导**，不由作者手写。
 *    原因：9 套模板 × 8 维度 ≈ 70 个维度，若每档都手写数字，
 *    改一次分值就要改四处，必然出现「锚点写 13-16 但满分改成 12」这类错位。
 *    现在作者只写行为描述（从高到低排），数字由 bandsOf() 统一算。
 *
 * 2. 档位数按满分自适应（2/3/4 档），不强行统一四档。
 *    原因：2 分的「格式规范」物理上装不下 4 档——四档会切出空区间，
 *    甚至出现 [3-4] [3-2] 这种倒挂。分值不够时少分几档，比硬凑四档诚实。
 */

(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  /* ==================================================================
   * 一、档位划分
   * ================================================================== */

  /** 档位名（从高到低）。档位数不足时取前 n 个，所以顺序不能乱。 */
  const LEVEL_NAMES = ['充分达成', '基本达成', '部分达成', '未达成'];

  /**
   * 按满分推导档位数。
   * 阈值依据：一档至少要能容纳 3 分，否则「档」失去了区分意义。
   *   满分 ≥ 12 → 4 档（如 25、20、16、15、12）
   *   满分 ≥ 7  → 3 档（如 11、10、9、8、7）
   *    其余      → 2 档（如 6、5、4、3、2）
   */
  function levelCountOf(max) {
    const m = Number(max) || 0;
    if (m >= 12) return 4;
    if (m >= 7) return 3;
    return 2;
  }

  /**
   * 把满分切成 n 个**连续、无缝、无重叠**的分数区间，从高到低返回。
   *
   * 关键不变量（由 assertBands 校验）：
   *   · bands[0].hi === max        —— 最高档要顶到满分
   *   · bands[n-1].lo === 0        —— 最低档要从 0 起
   *   · bands[i-1].lo === bands[i].hi + 1  —— 相邻档严丝合缝
   *
   * @returns {Array<{lo:number, hi:number, idx:number, name:string}>}
   */
  function bandsOf(max) {
    const m = Math.max(0, Math.round(Number(max) || 0));
    if (!m) return [];
    const n = levelCountOf(m);
    const bands = [];
    let hi = m;
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      // 非末档按等高切；末档一律落到 0，保证覆盖完整
      let lo = isLast ? 0 : Math.round(m * (1 - (i + 1) / n));
      if (lo > hi) lo = hi;
      if (lo < 0) lo = 0;
      bands.push({ lo, hi, idx: i + 1, name: LEVEL_NAMES[i] || ('第 ' + (i + 1) + ' 档') });
      hi = lo - 1;
      if (hi < 0) hi = 0;
    }
    return bands;
  }

  /** 供测试使用的自检：返回不变量是否全部成立 */
  function assertBands(max) {
    const m = Math.round(Number(max) || 0);
    const b = bandsOf(m);
    if (!b.length) return m === 0;
    if (b[0].hi !== m) return false;
    if (b[b.length - 1].lo !== 0) return false;
    for (let i = 1; i < b.length; i++) {
      if (b[i - 1].lo !== b[i].hi + 1) return false;
    }
    return b.every((x) => x.lo <= x.hi);
  }

  /**
   * 判定某个分数落在第几档（1 起）。越界时收敛到最近的档，不返回 null——
   * 模型偶尔会给 max+1 这类越界分，上游虽会 clamp，但这里也要能兜住。
   */
  function levelOf(score, max) {
    const b = bandsOf(max);
    if (!b.length) return null;
    const s = Number(score) || 0;
    const hit = b.find((x) => s >= x.lo && s <= x.hi);
    if (hit) return hit.idx;
    return s > b[0].hi ? b[0].idx : b[b.length - 1].idx;
  }

  /* ==================================================================
   * 二、锚点文案库
   *
   * 结构：ANCHOR_TEXT[维度id] = [最高档描述, 次高档描述, …]
   *   · 数组长度不必等于档位数——档位多时前面的描述会复用/少时自动截断
   *   · 维度 id 在各模板间是复用的（purpose/code/result…），所以这里按 id 共享
   *   · 未收录的 id 会退化成按档位生成的通用描述（见 fallbackText）
   * ================================================================== */

  const ANCHOR_TEXT = {
    /* ---- 通用：几乎所有模板都有这三个 ---- */
    purpose: [
      '写清了实验目标，并给出所依赖的原理/理论依据；能说明"要验证什么"',
      '写清了实验目标，提到原理但未展开',
      '只有一句目的陈述，无原理说明',
      '未说明实验目的',
    ],
    summary: [
      '有明确结论，并指出不足与下一步改进方向',
      '有结论，反思偏空泛',
      '总结为套话（如"收获很大"）',
      '无总结',
    ],
    format: [
      '标题分级清晰，图表/公式有编号，引用规范，无未完成标记',
      '结构清晰，个别图表未编号',
      '结构零散或存在未完成标记',
      '无格式可言',
    ],

    /* ---- 编程类 ---- */
    env: [
      '系统 + 语言/工具版本 + 依赖三项齐全，步骤可复现',
      '给出环境与版本，步骤较简略',
      '只提到部分环境信息',
      '未交代运行环境',
    ],
    code: [
      '核心代码完整且可读性好，有注释，交代了边界与异常处理',
      '核心代码完整，注释较少或未处理边界',
      '只给出片段或伪代码，缺关键实现',
      '无任何代码或伪代码',
    ],
    result: [
      '多组数据 + 表格/图表 + 单位齐全，结果可核对',
      '给出运行数据，但规模单一或缺图表',
      '只有零散结果，无表格支撑',
      '无结果数据',
    ],
    analysis: [
      '结合原理/数据规模解释成因，并作横向对比',
      '有分析且给出原因，对比不充分',
      '仅罗列现象，分析停留在结论层',
      '无分析',
    ],
    debug: [
      '记录真实报错（含错误信息）、定位过程与修复方式',
      '记录问题与解决方式，过程简略',
      '只提到问题，无解决过程',
      '未记录任何问题',
    ],

    /* ---- 数据结构与算法 ---- */
    design: [
      '给出伪代码/算法流程，说明数据结构选型理由，并处理了边界情况',
      '给出算法流程，选型理由或边界处理其一缺失',
      '只贴代码，无设计说明',
      '无设计与选型说明',
    ],
    complexity: [
      '推导了递推式/求和过程，区分最好与最坏情形，并与实测印证',
      '给出正确的复杂度结论，推导过程简略',
      '只写出 O(…) 结论，无任何推导',
      '未提及复杂度',
    ],
    test: [
      '覆盖正常/边界/极端三类用例，给规模—耗时表格，结果与理论吻合',
      '有用例与数据，覆盖面或对比不充分',
      '只有单点测试数据',
      '无测试数据',
    ],

    /* ---- 操作系统 ---- */
    impl: [
      '代码完整，同步原语使用规范，明确交代临界区保护与错误处理',
      '代码完整，同步或错误处理其一不够严谨',
      '只给出部分实现',
      '无实现代码',
    ],
    observe: [
      '用系统工具观测到预期现象，给出真实输出与量化指标',
      '有观测输出，但缺少量化指标或未说明预期',
      '仅有零散输出，无系统工具佐证',
      '无任何验证输出',
    ],

    /* ---- 计算机网络 ---- */
    topology: [
      '拓扑图清晰，IP 规划完整（含子网划分），配置命令可复现',
      '有拓扑与地址规划，配置或划分略有欠缺',
      '只画了拓扑，无地址规划或配置',
      '无拓扑与配置说明',
    ],
    capture: [
      '提供抓包证据，逐字段解读报文，并与协议行为对应',
      '有抓包，但字段解读或协议对应不充分',
      '只有抓包截图，未作解读',
      '无抓包或报文分析',
    ],

    /* ---- 数据库 ---- */
    sql: [
      'SQL 覆盖增删改查，含复杂查询（子查询/连接/聚合），结果可核对',
      'SQL 正确但复杂度有限，或结果展示不完整',
      '只有简单查询语句',
      '未给出任何 SQL',
    ],
    transaction: [
      '验证了隔离级别并复现并发异常，说明锁/MVCC 如何解决',
      '使用事务控制，验证不充分',
      '仅出现事务关键字，无验证',
      '未涉及事务',
    ],
    optimize: [
      '建索引并给出 EXPLAIN 前后对比，量化扫描行数与耗时变化',
      '有索引与优化，但缺少执行计划证据',
      '只建了索引，无效果验证',
      '未做任何优化',
    ],

    /* ---- 数字电路 ---- */
    simulation: [
      '提供仿真波形，逐段对照功能表说明，覆盖关键时序',
      '有仿真波形，对照说明不充分',
      '只有仿真截图，未作对照',
      '无仿真或波形验证',
    ],
    hardware: [
      '有实物流行记录与仪器测量数据，并记录故障排查过程',
      '有实测记录，排查过程简略',
      '只提到"运行正常"',
      '无硬件实测记录',
    ],
  };

  /** 未收录 id 时的通用描述：只交代档位本身的含义，不假装知道学科内容 */
  function fallbackText(idx, total) {
    if (idx === 0) return '该维度要求的内容完整、准确，可作范例';
    if (idx === total - 1) return '该维度几乎未涉及或严重缺失';
    return '该维度部分达成，存在可见的欠缺';
  }

  /**
   * 取某维度的锚点文案（含分数区间）。
   * @param {Object} dim 量表维度 { id, name, max }
   * @returns {Array<{lo,hi,idx,name,text}>} 从高到低
   */
  function anchorsFor(dim) {
    const bands = bandsOf(dim.max);
    if (!bands.length) return [];
    const texts = ANCHOR_TEXT[dim.id] || [];
    return bands.map((b, i) => ({
      lo: b.lo,
      hi: b.hi,
      idx: b.idx,
      name: b.name,
      /* 文案优先取手写描述；不够时：
       *   文案多于档位 → 按比例取样（保住首尾两档，中间均匀取）
       *   文案少于档位 → 用通用描述补齐尾部
       */
      text: pickText(texts, i, bands.length) || fallbackText(i, bands.length),
    }));
  }

  /**
   * 从 texts 中为第 i 档（共 n 档）挑一条描述。
   *
   * 取样规则：
   *   1. 等量      → 直接对应
   *   2. 文案更多  → 保序压缩：按比例映射，首尾必取
   *   3. 文案更少  → 前面的档用文案，余下用通用描述
   *
   * 关于「2 档却给了 4 条文案」这种情况：取首尾是正确的，不是缺陷。
   * 2 档的语义就是「达成 / 未达成」，此时中间两条（"结构清晰，个别图表未编号"）
   * 本就属于细节颗粒度，混进去反而会让模型在只有 5 分的维度上纠结措辞。
   * 需要更细颗粒度的维度就该给更高的分值——分值本身就携带了颗粒度信息。
   */
  function pickText(texts, i, n) {
    if (!texts.length) return '';
    const len = texts.length;
    if (len === n) return texts[i];
    if (len > n) {
      if (n === 1) return texts[0];
      return texts[Math.min(Math.round((i * (len - 1)) / (n - 1)), len - 1)];
    }
    return i < len ? texts[i] : '';
  }

  /**
   * 把锚点渲染成给模型看的文本块（下发给 prompt）。
   * 刻意用「档位 + 区间 + 行为」三段式：模型要同时看见"第几档"和"多少分"，
   * 才能稳定地先选档、再取分。
   */
  function renderForPrompt(dim) {
    const as = anchorsFor(dim);
    if (!as.length) return '';
    return as.map((a) => `  [档位${a.idx}｜${a.lo}-${a.hi}分] ${a.text}`).join('\n');
  }

  /** 校验一套量表所有维度的锚点结构是否自洽，返回问题清单（供测试用） */
  function validateRubric(rubric) {
    const bad = [];
    (rubric || []).forEach((d) => {
      const m = Math.round(Number(d && d.max) || 0);
      // 满分为 0 的维度无法定档，也无法得分 —— 这是量表本身的问题，必须报出来，
      // 否则模型会在 prompt 里收到一个"0 分满分、0–0 区间"的诡异档位。
      if (m <= 0) { bad.push(`${(d && d.name) || '(未命名维度)'} 满分非正数(max=${(d && d.max)}），无法划分档位`); return; }
      if (!assertBands(m)) bad.push(`${d.name}(max=${m}) 档位划分不连续`);
      const as = anchorsFor(d);
      if (as.length && as[as.length - 1].lo !== 0) bad.push(`${d.name} 最低档未覆盖到 0 分`);
      if (as.length && as[0].hi !== m) bad.push(`${d.name} 最高档未顶到满分`);
    });
    return bad;
  }

  AG.anchors = {
    LEVEL_NAMES,
    levelCountOf,
    bandsOf,
    assertBands,
    levelOf,
    anchorsFor,
    renderForPrompt,
    validateRubric,
    ANCHOR_TEXT,
  };
})(window);
