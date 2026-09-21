/* AutoGrader · 量表实验室（Rubric Lab）
 *
 * 要解决的问题：评分量表不该是死的。
 *   ① 同一个老师这周评「数据结构实验」，下周评「计算机网络实验」，拿代码质量标准去评协议抓包显然失真
 *   ② 同一道题，不同班级的作业水平不同，「人人都会写」的要点不该占分（现有 induce.js 的道理），
 *      但 induce 要求教师手工挑「优秀组 / 对照组」——这一步把大多数人挡在门外
 *   ③ 手动调 8 个维度的分值，没人愿意干第二次
 *
 * 本模块把「智能调标准」拆成三条互不依赖的入口：
 *
 *   A. fromPrompt()  一句话生成量表
 *      本地规则引擎永远可用（不配 API 也能跑），配了 Key 自动切大模型。
 *      安全设计：即使走大模型，也不让它直接写正则——只让它给「关键词列表」，
 *      由本地编译成 `kw1|kw2|...` 的字面量正则。这样杜绝了灾难性回溯，也杜绝了非法正则炸掉评分引擎。
 *
 *   B. fit()         批次自适应（自举诱导）
 *      上传一批作业后不需要任何人工标注：先给每份算一个**无监督质量基线**排出高低分组，
 *      再交给 induce.js 做区分度计算，迭代收敛。产出的量表带完整的「为什么这么调」说明。
 *
 *   C. detectMix()   混批异质性检测
 *      「很多时候不只有一样的作业」——一批里混了不同题目时，同一套标准会让分数失去可比性。
 *      抽出各文档的章节标题做相似度聚簇，发现分簇就提示分批。
 *
 * 三条入口最终都产出同一种东西：**标准量表数组**，交给 AG.rubric 与评分引擎消费。
 * 手动调节仍然保留，且本模块永远不会自动覆盖用户锁定（locked）的维度。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ============================================================
   * 0. 示例提示词（UI 直接消费，同时也是调参时的回归样本）
   * ============================================================ */
  const EXAMPLES = [
    '《数据结构》归并排序实验，重点看代码正确性和复杂度分析，格式别太较真',
    '操作系统实验，进程同步和死锁避免最重要，环境版本可以少扣分',
    '计算机网络实验，抓包报文分析要占大头，拓扑配置和连通性测试也要看',
    '数据库实验，ER 设计和 SQL 正确性是重点，索引优化和事务隔离也要评',
    '软件工程课程设计，需求分析和 UML 设计文档最重要，测试用例要完整',
    '机器学习课程大作业，看重数据集划分和消融实验，不要评课程内容复述',
    '数字电路实验，真值表与卡诺图化简必查，仿真波形要能对上功能表',
  ];

  /* ============================================================
   * 1. 学科 / 文体识别
   * ============================================================ */

  /**
   * 识别提示词描述的是哪类作业。
   * 「通用报告」只会在其它模板一分未得时才被选中——它的别名（通用/综合/其他）
   * 几乎能命中任何句子，若不设这道闸门它会永远抢走第一名。
   */
  function detectDiscipline(text) {
    const t = String(text || '').toLowerCase();
    const scored = AG.templates.TEMPLATES.filter((x) => x.id !== 'general').map((tpl) => {
      let sc = 0;
      const hits = [];
      (tpl.aliases || []).forEach((a) => {
        if (t.indexOf(a.toLowerCase()) >= 0) {
          // 长别名信息量更高（"机器学习" 比 "AI" 更有判别力），但不线性加权，避免叠词刷分
          sc += Math.pow(a.length, 1.3);
          hits.push(a);
        }
      });
      return { tpl, score: U.round(sc, 2), hits };
    }).sort((a, b) => b.score - a.score);

    const list = scored.map((x) => ({ id: x.tpl.id, name: x.tpl.name, score: x.score, hits: x.hits }));
    const top = scored[0] || null;
    const runnerUp = scored[1] ? { id: scored[1].tpl.id, name: scored[1].tpl.name, score: scored[1].score } : null;

    if (top && top.score > 0) {
      return { list, winner: top.tpl, score: top.score, hits: top.hits, runnerUp };
    }
    // 一分未得才落到通用模板 —— 它的别名（通用/综合）几乎能命中任何句子，不能让它参与竞争
    const general = AG.templates.TEMPLATES.find((x) => x.id === 'general');
    return { list, winner: null, general, score: 0, hits: [], runnerUp };
  }

  /* ============================================================
   * 2. 意图提示词的 cue（措辞信号）
   * ============================================================ */

  const CUE = {
    setScore: /(\d{1,2})\s*分/,
    ban: /(?:不要评|不用评|不用管|不需要评|去掉|取消|删掉|剔除|去掉这|不含|不包含)/,
    weaken: /(?:不用|不必|无需|别|不要|别太|不用太|不必太)(?:太)?(?:较真|在意|看重|纠结|强调|管|要求|考虑|扣|给)?|忽略|淡化|次要|无所谓|不在意|弱化|少给|降低|减小/,
    focus: /(?:重点|着重|侧重|主要|特别|尤其|关键|核心|更|最|优先|务必|必须|偏向|看中|强调|看重|考察|关注|考核|这是重点|占大头)/,
  };

  /** 按中文标点切短句 —— 比一条大正则去贪婪匹配整句稳定得多 */
  function splitClauses(prompt) {
    return String(prompt || '')
      .replace(/\s+/g, ' ')
      .split(/[，。；、,.;!！?？\n\r（）()「」【】]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
  }

  /**
   * 把短句里的 cue 前缀剥掉，剩下的才是真正要定位的维度关键词。
   * 反复剥离直到不再变化 —— 「重点不要太看重格式」这种叠加措辞也能一次清干净。
   */
  const CUE_WORDS = [
    '重点', '着重', '侧重', '主要', '特别', '尤其', '关键', '核心', '更加', '最', '优先', '务必', '必须',
    '偏向', '看中', '强调', '看重', '考察', '考核', '关注', '这是重点', '占大头', '这块', '这块内容',
    '不用', '不必', '无需', '不要', '别太', '不用太', '不必太', '较真', '在意', '纠结', '忽略', '淡化',
    '次要', '无所谓', '弱化', '少给', '降低', '减小', '不需要', '去掉', '取消', '删掉', '剔除', '不含',
    '不要评', '不用评', '不用管', '不需要评', '看', '是', '给', '要', '占', '评分', '打分', '还有', '以及',
  ];

  function stripCue(clause) {
    let s = String(clause || '').trim();
    let prev = '';
    let guard = 0;
    while (s !== prev && guard++ < 12) {
      prev = s;
      for (let i = 0; i < CUE_WORDS.length; i++) {
        s = s.replace(new RegExp('^' + escapeRe(CUE_WORDS[i]) + '[的地得是了更太也还就]*'), '');
      }
      s = s.replace(/^[的了很太也还就,，。、]+/, '').trim();
    }
    // 尾缀同样要清：「格式规范可以」「细节这块」这类尾巴留着既不改变定位结果，
    // 又会原样出现在 UI 的「触发词」里 —— 看上去像没解析干净，损害可信度
    let prevTail = '';
    let tailGuard = 0;
    while (s !== prevTail && tailGuard++ < 6) {
      prevTail = s;
      s = s.replace(/(?:可以|就行|即可|好了|罢了|的话|一点|一些|之类|等等|方面|这块|那里|这里)$/, '').trim();
    }
    return s;
  }

  /**
   * 在给定维度里定位某个关键词最可能属于哪个维度。
   * 打分依据两部分：维度自带的 keys 是否命中，以及维度名的 n-gram 是否与关键词重合
   * （越长片段重合越可信，因为「数据」这类两字词几乎能撞上任何维度）
   */
  /**
   * 在给定维度里给某个关键词的所有候选维度打分（内部）。
   */
  function scoreAgainst(t, d) {
    let s = 0;
    (d.keys || []).forEach((k) => {
      if (k && (t.indexOf(k) >= 0 || k.indexOf(t) >= 0)) s += Math.min(k.length, 4) * 1.5;
    });
    const nm = String(d.name || '').replace(/[的和与及、]/g, '');
    for (let n = Math.min(4, t.length); n >= 2; n--) {
      for (let j = 0; j + n <= t.length; j++) {
        const g = t.slice(j, j + n);
        if (nm.indexOf(g) >= 0) s += n * 1.3;
      }
    }
    if (nm.indexOf(t) >= 0 || t.indexOf(nm) >= 0) s += 6;
    return s;
  }

  /**
   * 定位关键词最可能属于的**单个**维度（保留给需要唯一解的场景）。
   */
  function locateDim(kw, dims) {
    const all = locateDims(kw, dims);
    return all.length ? all[0] : null;
  }

  /**
   * 把并列短语拆成若干独立的考察点。
   *
   * 为什么必须先拆：老师写「重点看数据处理和误差分析」时说的是**两件事**，但我们之前把整串
   * 当一个关键词去匹配维度名——结果永远是字面重合度最高的那一个胜出，另一半诉求被静默吞掉。
   * 用户会以为系统听懂了，实际只执行了一半。这种「静默的半懂」比直接说没听懂更伤信任。
   *
   * 单个片段变短之后语义也更纯（「数据处理」vs「误差分析」），「我该归属哪个维度」的答案
   * 反而变得明确。这也是下面 locateOne 敢直接取第一名的原因。
   *
   * 保护措施：**若拆完之后每个碎片都不足 2 字，则保留原串**。例如「参与」「与其」这类词
   * 里的「与」不是并列连词，拆开只会得到两个无意义单字。
   */
  const COORD = /和|与|及|以及|还有|并且|同时|或|或者/;
  function splitCoord(kw) {
    let out = [String(kw || '').trim()].filter(Boolean);
    // 迭代到不动点：处理「A和B以及C」这种二级并列
    for (let pass = 0; pass < 3; pass++) {
      const next = [];
      let changed = false;
      out.forEach((s) => {
        const parts = s.split(COORD).map((x) => x.trim()).filter((x) => x.length >= 2);
        if (parts.length > 1) { next.push.apply(next, parts); changed = true; }
        else next.push(s);
      });
      if (!changed) break;
      out = next;
    }
    return out;
  }

  /**
   * 单个考察点归属哪个维度——取唯一最佳。
   * 片段已经足够短纯，多个候选共存的情况基本消失；此时若还保留「多候选」机制，
   * 反而会把只是碰巧共用一两个字的外围维度一并提权，让调整失去焦点。
   */
  function locateOne(kw, dims) {
    const t = String(kw || '').replace(/[的和与及、了其]/g, '');
    if (!t) return null;
    let best = null;
    dims.forEach((d, i) => {
      const s = scoreAgainst(t, d);
      if (s < 2) return;
      if (!best || s > best.score) best = { index: i, name: d.name, score: U.round(s, 2) };
    });
    return best;
  }

  /**
   * 定位关键词对应的所有维度。
   *
   * 实现路径经历过一次推倒重来，值得记下来（避免后人又走回去）：
   *   v1 —— 整串匹配 + 「相对最佳候选 0.55 倍」阈值多选。
   *         失败：不同维度的锚点词数量天然不同，「数据处理与误差分析」这类长维度名一旦
   *         部分命中就把分数拉到 79.6，第二名只有 5.6，比例阈值再怎么调都救不回来。
   *   v2 —— 先按并列连词拆成片段，每片段取唯一最佳，再合并去重。
   *         片段短、语义纯，「最佳」变得可信，也就不必再用那套脆弱的比例判据。
   *
   * 去重是必须的：网络表里「抓包」和「报文分析」本来就同属一个维度，
   * 不去重的话该维度会被提权两次，等于按了两次按钮。
   */
  function locateDims(kw, dims) {
    const map = new Map();
    splitCoord(kw).forEach((piece) => {
      const best = locateOne(piece, dims);
      if (!best) return;
      const prev = map.get(best.name);
      if (!prev || best.score > prev.score) map.set(best.name, best);
    });
    // 上限 3：一句里真提到三件事的情况存在，但再多就是误判了
    return Array.from(map.values()).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  /* ============================================================
   * 3. 本地意图解析
   * ============================================================ */

  /**
   * 解析一句自然语言。
   * 返回解析结果，**不直接产出量表**——产出动作交给 fromPromptLocal，好让用户看到解析过程。
   */
  function parseIntent(prompt, opts) {
    opts = opts || {};
    const raw = String(prompt || '').trim();
    const disc = detectDiscipline(raw);
    // 用户在下拉里点名了模板就照办 —— 手动选择永远优先于自动识别。
    // 这条不能反过来：一旦让识别结果盖过用户明确指定的类型，用户就会失去对评分标准的最终控制权
    const forced = opts.templateId && opts.templateId !== 'auto' ? AG.templates.get(opts.templateId) : null;
    const tpl = forced || disc.winner || disc.general || AG.templates.get(AG.templates.DEFAULT_ID);
    const base = AG.templates.compile(tpl);
    const dims = base.map((d) => ({ id: d.id, name: d.name, keys: d.keys }));
    const ops = [];        // 解析出来的操作
    const unparsed = [];   // 没听懂的句子（UI 要诚实显示）
    const missed = [];     // 听懂了意图、但在量表里找不到对应维度——比「没听懂」更具体，要分开显示
    const used = new Set();

    splitClauses(raw).forEach((clause) => {
      const hit = (re) => re.test(clause);
      const push = (op, targets) => { ops.push(Object.assign(op, { targets })); used.add(clause); };
      // 意图清楚了但落不了地：不能假装没听见，要告诉老师是哪半句没找到
      const miss = (type, kw) => { missed.push({ type, keyword: kw, clause }); used.add(clause); };

      // (1) 显式指定分值：「安全与废液处理要评 8 分」—— 最具体，优先匹配
      const mScore = clause.match(CUE.setScore);
      if (mScore) {
        const kw = clause.replace(CUE.setScore, '').replace(/(?:占|给|评|打|为|是|的话|可以|要|只|分)+/g, '').trim();
        const targets = locateDims(kw, dims);
        const val = U.clamp(parseInt(mScore[1], 10), 0, MAX_DIM);
        // 指定了分值却配多个维度会造成歧义，只在唯一命中时照办
        if (targets.length === 1 && val > 0) {
          push({ type: 'set', keyword: kw, value: val, clause }, targets);
          return;
        }
      }
      // (2) 明确剔除：「不要评格式规范」
      //     一旦 ban 匹配成功就不再往下试 weaken/focus：两种 cue 同时命中时多半是误判，
      //     而且「不要评 X」和「弱化 X」是不同强度的要求，混着来只会得到说不清的结果
      if (hit(CUE.ban)) {
        const kw = stripCue(clause.replace(CUE.ban, ''));
        const targets = locateDims(kw, dims);
        if (targets.length) { push({ type: 'ban', keyword: kw, clause }, targets); return; }
        miss('ban', kw); return;
      }
      // (3) 降权：「格式别太较真」「可以弱化」「少给点分」
      if (hit(CUE.weaken)) {
        const kw = stripCue(clause.replace(CUE.weaken, ''));
        const targets = locateDims(kw, dims);
        if (targets.length) { push({ type: 'weaken', keyword: kw, clause }, targets); return; }
      }
      // (4) 提权：「重点看代码正确性」
      if (hit(CUE.focus)) {
        const kw = stripCue(clause.replace(CUE.focus, ''));
        const targets = locateDims(kw, dims);
        if (targets.length) { push({ type: 'focus', keyword: kw, clause }, targets); return; }
        miss('focus', kw); return;
      }
      unparsed.push(clause);
    });

    // 未被任何 cue 接管的短句。两类不算「没听懂」：① 整句原样 ② 只是学科名/作业名
    const aliases = disc.hits || [];
    const unparsedClean = unparsed.filter((c) =>
      c !== String(raw).trim() && !aliases.some((a) => c.indexOf(a) >= 0)
    );

    return {
      prompt: raw,
      template: tpl,
      base,
      ops,
      unparsed: unparsedClean,
      missed,
      templateForced: !!forced,
      disciplineScore: disc.score,
      matchedAliases: disc.hits,
      runnerUp: disc.runnerUp,
    };
  }

  /* 提权/降权系数 —— 只动权重，不动考察要点。
   * focus 不能太狠：1.75 会把「论证逻辑」从 22 推到 39，一个维度吃掉近四成分值，
   * 其余维度被压缩到个位数，整个量表就废了。1.5 + 32 分封顶才像个能用的方案。 */
  const BOOST = { focus: 1.5, weaken: 0.45 };
  const MAX_DIM = 32;

  /**
   * 沉默维度保护策略。
   *
   * 「沉默维度」= 本批次里没有表现出任何区分度要素的维度（例如人人都不写或少写对都比懒得写操作步骤）。
   * 早期版本的做法是**直接删除**它，这是个 bug 级的设计错误：
   *
   *   如果「全班都不写的方面就不计分」成立，那么学生很快就学会——只要大家集体不写某个部分，
   *   那个部分就会从评分标准里消失。评分标准反过来被学生的最低公约数牵着走，
   *   这是彻头彻尾的激励错位，比量表不准糟糕得多。
   *
   * 正确做法：**给沉默维度发保底分**。它的含义不是「这个维度值这么多分」，
   * 而是「本批次数据不足以说明它该值多少，先给它留一个位置，等有区分度的批次出现再调」。
   */
  const SILENT_FLOOR = 4;        // 每个沉默维度的保底分（归一化前）
  const SILENT_RESERVE_CAP = 0.3; // 沉默维度合计占比上限，防止「全班摆烂」时它们反客为主

  function keepSilent(next, base) {
    const out = next.slice();
    base.forEach((b) => {
      if (out.some((d) => d.id === b.id || d.name === b.name)) return;
      out.push({
        id: b.id, name: b.name, max: 0, silent: true,
        desc: b.desc || '', advice: b.advice || '',
        signals: b.signals || [], penalties: b.penalties || [],
      });
    });
    const silent = out.filter((d) => d.silent);
    if (!silent.length) return out;
    silent.forEach((d) => { d.max = SILENT_FLOOR; });

    const activeSum = out.filter((d) => !d.silent).reduce((s, d) => s + d.max, 0);
    let silentSum = SILENT_FLOOR * silent.length;
    // 归一化前就把沉默席位的占比压住：activeSum 对应的合法沉默额度 = activeSum * cap/(1-cap)
    const cap = Math.round(activeSum * SILENT_RESERVE_CAP / (1 - SILENT_RESERVE_CAP));
    if (silentSum > cap && cap > 0) {
      const k = cap / silentSum;
      silent.forEach((d) => { d.max = Math.max(1, Math.round(d.max * k)); });
    }
    return out;
  }

  /**
   * 把用户在原话里指定的分值按原值钉回去，剩余分值在其余维度间重新摊平。
   *
   * 顺序上的坑：归一化一定会改写 max，所以得先记下 pin，归一化之后再回填并二次分摊。
   * 若用户给的分数加起来已经吃掉了几乎全部预算（比如四条各写 30 分），再照顾它就会把其余
   * 维度压成负数 —— 总分恒 100 是更强的约束，这种时候放弃钉值，走原比例。
   */
  function honorPinned(dims) {
    const pinned = dims.filter((d) => d.pin != null && d.enabled !== false);
    if (!pinned.length) return dims;
    const pinSum = pinned.reduce((s, d) => s + d.pin, 0);
    const free = dims.filter((d) => d.enabled !== false && d.pin == null);
    if (!free.length || pinSum > 100 - free.length * 2) return dims;   // 预算不够，维持比例
    pinned.forEach((d) => { d.max = d.pin; });
    AG.templates.normalizeScores(free, 100 - pinSum);
    capPeak(free, MAX_DIM, 100 - pinSum);
    return dims;
  }

  /**
   * 本地生成：把解析结果落到分值与开关上。
   * 归一化交给 AG.templates.normalizeScores，保证合计恒为 100。
   */
  function fromPromptLocal(prompt, opts) {
    const it = parseIntent(prompt, opts);
    const dims = it.base;
    const adjustments = [];

    it.ops.forEach((op) => {
      (op.targets || []).forEach((tg) => {
        const d = dims.find((x) => x.name === tg.name);
        if (!d) return;
        const from = d.max;
        if (op.type === 'ban') {
          d.enabled = false;
          adjustments.push({ dim: d.name, type: 'ban', from, to: 0, keyword: op.keyword });
        } else if (op.type === 'set') {
          // pin = 用户原话给的分值。归一化必须绕开它，否则「要评 8 分」最后 scale 成 7 分，
          // 等于当着用户的面打折他刚说的话 —— 明说的分值优先于比例美观
          const v = U.clamp(op.value, 2, MAX_DIM);
          d.max = v;
          d.pin = v;
          d.locked = true;      // 用户明说了分值，后续自动调节不许改
          adjustments.push({ dim: d.name, type: 'set', from, to: d.max, keyword: op.keyword });
        } else {
          const k = BOOST[op.type];
          const next = U.clamp(Math.round(d.max * k), 2, MAX_DIM);
          if (next === from) return;
          d.max = next;
          adjustments.push({ dim: d.name, type: op.type, from, to: next, keyword: op.keyword });
        }
      });
    });

    const enabled = dims.filter((d) => d.enabled !== false);
    AG.templates.normalizeScores(enabled, 100);
    // 归一化可能把某个维度重新顶高，最后再压一次峰值并把让出来的分还回去
    capPeak(enabled, MAX_DIM);
    honorPinned(enabled);

    // 用户亲自点了模板，谈不上「识别置信度」，直接记为 high
    const conf = it.templateForced
      ? 'high'
      : (!it.template || it.template.id === 'general'
        ? 'low'
        : (it.matchedAliases.length >= 2 || adjustments.length >= 2 ? 'high' : 'medium'));

    return {
      rubric: dims,
      meta: {
        engine: 'local',
        templateId: it.template ? it.template.id : '',
        templateName: it.template ? it.template.name : '',
        templateBrief: it.template ? it.template.brief : '',
        templateForced: !!it.templateForced,
        confidence: conf,
        matchedAliases: it.matchedAliases,
        runnerUp: it.runnerUp ? { id: it.runnerUp.id, name: it.runnerUp.name } : null,
        adjustments,
        unparsed: it.unparsed,
        missed: it.missed,
        summary: summarize('local', it, adjustments),
      },
    };
  }

  /**
   * 按批次内容推荐量表模板。
   *
   * 为什么需要：fit() 只在**当前量表**的维度空间里调权重，不会凭空造维度。
   * 拿默认那套通用编程量表去适配网络作业，术语会被 anchors 硬塞进「核心实现与代码质量」
   * 之类的维度里，分值看着合理实则全错。所以排期必须是「先选对基底，再自适应」。
   *
   * 做法不是把全文拼起来跑一次 detectDiscipline（那样长报告会淹没短报告），
   * 而是**逐份投票**：每份作业各投一票，最后按票数取多数，并报告覆盖率。
   * 「9 份里 7 份像计算机网络实验」比一个笼统的分数好解释得多。
   */
  function suggestTemplate(docs, opts) {
    opts = opts || {};
    const items = (docs || []).filter((d) => d && String(d.text || '').trim().length >= 50);
    if (!items.length) return { template: null, votes: [], coverage: 0, confidence: 'low', reason: '没有可用于判断的内容' };

    const votes = [];
    const tally = {};
    let valid = 0;
    items.forEach((d) => {
      // 只看开头 400 字 + 章节标题：这里信息密度最高，也最不容易被正文里的引证带偏
      const probe = String(d.text || '').slice(0, 400) + ' '
        + AG.induce.extractSections(d.text || '').slice(0, 12).join(' ');
      const disc = detectDiscipline(probe);
      const id = disc.winner ? disc.winner.id : 'general';
      if (disc.winner) valid++;
      (tally[id] = tally[id] || { id, name: disc.winner ? disc.winner.name : '通用报告', count: 0, docs: [] }).count++;
      tally[id].docs.push(d.name);
      votes.push({ name: d.name, id, name2: disc.winner ? disc.winner.name : '通用报告', score: disc.score, hits: disc.hits });
    });

    const list = Object.keys(tally).map((k) => tally[k]).sort((a, b) => b.count - a.count);
    const top = list[0];
    const tpl = top ? (AG.templates.get(top.id) || AG.templates.get('general')) : AG.templates.get('general');
    const coverage = U.round(top.count / items.length, 3);
    const runnerUp = list[1] ? { id: list[1].id, name: list[1].name, count: list[1].count } : null;

    return {
      template: tpl,
      templateId: tpl ? tpl.id : '',
      votes: list,
      coverage,
      runnerUp,
      confidence: coverage >= 0.7 ? 'high' : coverage >= 0.4 ? 'medium' : 'low',
      reason: '按批次内容投票：' + list.map((x) => x.name + ' ' + x.count + ' 票').join('、')
        + (coverage < 0.4 ? '（票数分散，这批作业可能不构成同一类作业，建议先看混批检测）' : ''),
    };
  }

  /** 把超过 cap 的维度压回 cap，多出来的分按比例返还给未达上限的维度，保持合计 100 */
  function capPeak(dims, cap, targetTotal) {
    cap = cap || MAX_DIM;
    targetTotal = targetTotal || 100;
    let guard = 0;
    while (guard++ < 60) {
      const over = dims.reduce((s, d) => s + Math.max(0, d.max - cap), 0);
      if (!over) break;
      const rooms = dims.filter((d) => d.max < cap);
      dims.forEach((d) => { if (d.max > cap) d.max = cap; });
      if (!rooms.length) break;                       // 全是上限：总数超了，交给下一轮归一化
      const free = rooms.reduce((s, d) => s + (cap - d.max), 0);
      const give = Math.min(over, free);
      rooms.forEach((d) => { d.max += Math.round((cap - d.max) / free * give); });
      const total = dims.reduce((s, d) => s + d.max, 0);
      if (total !== targetTotal) AG.templates.normalizeScores(dims, targetTotal);
    }
    return dims;
  }

  function summarize(engine, it, adjustments) {
    const tplName = it.template ? it.template.name : '通用报告';
    if (!adjustments.length) {
      return `识别为「${tplName}」，未检测到侧重点调整，已套用该类型的标准分值。`;
    }
    const up = adjustments.filter((a) => a.type === 'focus' || (a.type === 'set' && a.to > a.from));
    const down = adjustments.filter((a) => a.type === 'weaken' || a.type === 'ban');
    const parts = [];
    if (up.length) parts.push('提高 ' + up.map((a) => a.dim).join('、'));
    if (down.length) parts.push('降低或剔除 ' + down.map((a) => a.dim).join('、'));
    return `识别为「${tplName}」，据提示词${parts.join('，')}。`;
  }

  /* ============================================================
   * 4. 大模型生成（可选增强）
   * ============================================================ */

  const LLM_SYSTEM = `你是一名高校课程评估专家，负责把教师的一句自然语言要求转成结构化评分量表。

工作要求：
1. 先判断这是哪类计算机专业实验（通用编程实验 / 数据结构与算法实验 / 操作系统与系统编程 / 计算机网络实验 / 数据库实验 / 软件工程与课程设计 / 人工智能与机器学习 / 数字电路与计算机组成 / 通用报告）。
2. 给出 5~9 个评分维度，每个维度用中文命名（不超过 8 个字），并给出初始分值，所有维度分值合计必须正好等于 100。
3. 每个维度给出 3~6 个**具体可核查的考察要点**。
4. 【重要】考察要点必须写成关键词列表 keywords，不要写正则表达式。每个关键词是 2~8 个字的中文短语或术语，例如 ["计算产率","代入原始数据","三次平行"]。系统会把它们编译成匹配模式，你写正则反而会出错。
5. 权重 w 表示该要点的重要程度，取值 1~5，同一维度内可重复。
6. 如果教师明确说了某个方面的分值或说某方面不重要，必须严格照办。

只输出 JSON，不要输出任何解释或 Markdown 代码块标记。输出格式：
{
  "discipline": "识别出的作业类型（中文）",
  "reason": "一句话说明为什么这么定（50 字以内）",
  "dims": [
    {
      "name": "维度名",
      "max": 20,
      "desc": "该维度考察什么（30 字以内）",
      "advice": "给学生的改进建议（40 字以内）",
      "keywords": ["要点1", "要点2"],
      "weights": [3, 2]
    }
  ]
}`;

  /**
   * 把 LLM 给的关键词列表安全地编译成正则。
   * 关键：`escapeRe` + 纯字面量 alternation，杜绝回溯爆炸与非法语法。
   */
  function compileKeywords(keywords, weights) {
    const kws = (keywords || []).map((k) => String(k || '').trim()).filter((k) => k.length >= 1);
    if (!kws.length) return [];
    const out = [];
    // 每 3 个关键词合成一条 signal，避免要点过多导致单个信号权重被摊薄到看不出差异
    const CHUNK = 3;
    for (let i = 0; i < kws.length; i += CHUNK) {
      const group = kws.slice(i, i + CHUNK);
      const ws = group.map((_, j) => Number((weights || [])[i + j]) || 3);
      out.push({
        label: group.length === 1 ? '提及「' + group[0] + '」' : '涉及 ' + group.join(' / '),
        w: U.round(ws.reduce((s, x) => s + x, 0) / group.length, 2),
        re: new RegExp(group.map(escapeRe).join('|'), 'g'),
      });
    }
    return out;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function idFromName(name, used) {
    let base = String(name || '').replace(/[^一-龥a-zA-Z0-9]/g, '').slice(0, 6) || 'dim';
    let id = base;
    let n = 1;
    while (used.has(id)) id = base + ++n;
    used.add(id);
    return id;
  }

  /** 大模型版生成。任何一步失败都回落到本地解析，不向上抛 */
  async function fromPromptLLM(prompt, opts) {
    opts = opts || {};
    const local = fromPromptLocal(prompt, opts);
    if (!AG.llm || !AG.llm.chat) return local;

    const cfg = AG.llm.getConfig();
    if (!cfg.apiKey) return local;

    try {
      // 量表生成要结构化结果，走 chatJson：优先 response_format，
      // 服务商不支持时自动退化成「靠 prompt 里的『只输出 JSON』指令」再试
      const raw = await AG.llm.chatJson([
        { role: 'system', content: LLM_SYSTEM },
        { role: 'user', content: String(prompt || '').slice(0, 600) },
      ], opts.cfg);
      const parsed = JSON.parse(extractJson(raw));
      const dims = normalizeLlmDims(parsed.dims);
      if (!dims.length) return local;

      AG.templates.normalizeScores(dims, 100);
      return {
        rubric: dims,
        meta: {
          engine: 'llm',
          templateId: 'custom',
          templateName: parsed.discipline || '大模型定制量表',
          templateBrief: parsed.reason || '由提示词直接生成',
          confidence: 'high',
          matchedAliases: [],
          runnerUp: null,
          adjustments: [],
          unparsed: [],
          summary: `大模型识别为「${parsed.discipline || '定制'}」：${parsed.reason || '按提示词生成量表'}`,
          fallbackUsed: false,
        },
      };
    } catch (e) {
      // LLM 挂了不能让整个功能不可用 —— 带着失败原因回落到本地
      local.meta.fallbackUsed = true;
      local.meta.fallbackReason = String(e && e.message ? e.message : e);
      return local;
    }
  }

  function extractJson(text) {
    const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s < 0 || e < 0) throw new Error('模型未返回 JSON');
    return cleaned.slice(s, e + 1);
  }

  function normalizeLlmDims(list) {
    const used = new Set();
    return (list || [])
      .filter((d) => d && String(d.name || '').trim())
      .slice(0, 9)
      .map((d) => {
        const name = String(d.name).trim().slice(0, 12);
        return {
          id: idFromName(name, used),
          name,
          max: U.clamp(Number(d.max) || 10, 1, 60),
          desc: String(d.desc || '').slice(0, 80),
          advice: String(d.advice || '').slice(0, 80),
          keys: (d.keywords || []).slice(0, 8),
          enabled: true,
          source: 'llm',
          signals: compileKeywords(d.keywords, d.weights),
          penalties: [],
        };
      })
      .filter((d) => d.signals.length);   // 没有任何关键词的维度无法被引擎打分，直接丢
  }

  /**
   * 统一入口。
   * @param {String} prompt
   * @param {Object} opts { prefer: 'auto'|'local'|'llm', templateId: 'auto'|模板 id, cfg }
   */
  async function fromPrompt(prompt, opts) {
    opts = opts || {};
    const mode = opts.prefer || 'auto';
    if (mode === 'local') return fromPromptLocal(prompt, opts);
    if (mode === 'llm') return fromPromptLLM(prompt, opts);
    // auto：有 Key 才走大模型，否则本地解析——零依赖是本项目的底線
    const cfg = AG.llm && AG.llm.getConfig ? AG.llm.getConfig() : null;
    if (cfg && cfg.apiKey) return fromPromptLLM(prompt, opts);
    return fromPromptLocal(prompt, opts);
  }

  /* ============================================================
   * 5. 批次自适应：无需人工标注的自举诱导
   *
 * 自举的关键在于「第一步的分组从哪来」。答案是结构化基线 qualityBaseline：
 * 纯结构/篇幅/数据/规范四个可机械统计的方面给出的粗糙排序，不依赖任何量表。
 * 用它排出伪高低组，再用区分度引擎重算权重，然后用新权重重排分组迭代。
 * 这样既绕开了「让人先挑范文」的门槛，也不至于被一份错误量表带偏——
 * 分组依据与量表解耦，正是为了量表本身可以被推翻重来。
   * ============================================================ */

  /**
   * 无监督质量基线（0–100）。
   * 说明：这是**排序用的相对量**，不是作业水平的绝对值——它完全不看内容对错，只看
   * 结构/篇幅/数据/规范四个可机械统计的方面。真正的语义差异由后续 induce 的
   * 区分度引擎在高低组之间算出来，不在这里预估。
   */
  function qualityBaseline(doc) {
    const f = doc.features || AG.parser.extractFeatures(doc.text || '');
    const t = String(doc.text || '');
    let s = 0;
    // 结构 24
    s += Math.min(12, (f.headingCount || 0) * 3);
    if ((f.codeBlockCount || 0) > 0) s += 5;
    if ((f.tableCount || 0) > 0) s += 4;
    if ((f.figureCount || 0) >= 2) s += 3;
    // 篇幅 20
    const w = f.words || 0;
    s += w >= 1500 ? 20 : w >= 1000 ? 17 : w >= 700 ? 14 : w >= 450 ? 10 : w >= 250 ? 6 : 2;
    // 数据 24
    const n = f.numberCount || 0;
    const dn = f.numberDensity || 0;
    s += n >= 40 ? 12 : n >= 20 ? 10 : n >= 10 ? 8 : n >= 4 ? 5 : 1;
    s += dn >= 3 ? 12 : dn >= 1.8 ? 9 : dn >= 1 ? 6 : dn >= 0.5 ? 3 : 0;
    // 规范 12
    if ((f.referenceCount || 0) > 0) s += 6;
    if (!/TODO|待补充|XXX|？？？|略\.\.\./.test(t)) s += 3;
    if ((f.headingCount || 0) >= 4) s += 3;
    // 完成度 20
    if ((f.codeLines || 0) >= 20) s += 6;
    if ((f.lines || 0) >= 40) s += 5;
    if ((f.figureCount || 0) + (f.tableCount || 0) >= 3) s += 5;
    if (w >= 1200) s += 4;
    return U.clamp(Math.round(s), 0, 100);
  }

  /** 保护用户在手动表里锁定的维度：自动调权重不许动锁定的行 —— 明说过分值就得以手说的为准 */
  function applyLocks(next, originalRubric) {
    (originalRubric || []).forEach((o) => {
      if (!o.locked) return;
      const hit = next.find((d) => d.id === o.id || d.name === o.name);
      if (hit) { hit.max = o.max; hit.locked = true; }
    });
    // 回填锁定值会把合计顶出 100。这里必须补一次配平，否则教师在 UI 上看到的「启用维度总分」
    // 会是 107 之类的数，而他会合理地怀疑整套自动调节是不是在乱写。
    // 优先级想清楚了：**尊重手动分值 > 比例美观**，所以只让未锁定的维度去吸收差额。
    const enabled = next.filter((d) => d.enabled !== false);
    const total = enabled.reduce((s, d) => s + d.max, 0);
    if (enabled.length && Math.abs(total - 100) > 0.5) {
      const lockSum = enabled.filter((d) => d.locked).reduce((s, d) => s + d.max, 0);
      const free = enabled.filter((d) => !d.locked);
      if (free.length && lockSum < 100) {
        AG.templates.normalizeScores(free, 100 - lockSum);
        capPeak(free, MAX_DIM, 100 - lockSum);
      } else {
        // 锁定值吃掉了全部预算（用户把多个维度锁成高分）—— 总分恒 100 是更强的约束，
        // 这种情况下只能动锁定值，但这种情况本身说明用户给的分值不自洽
        AG.templates.normalizeScores(enabled, 100);
      }
    }
    return next;
  }

  function sameShape(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((x, i) => x.name === b[i].name && Math.abs(x.max - b[i].max) <= 1);
  }

  /**
   * 生成「为什么这么调」的说明 —— 这是整个功能能否被教师信任的关键。
   * 只丢一句「分值已更新」没人敢用；必须说清每个维度凭什么涨、凭什么跌。
   */
  function buildChanges(baseDims, nextDims, induced) {
    const byName = {};
    (induced.dims || []).forEach((d) => { byName[d.name] = d; });
    const avgDelta = induced.allScored && induced.allScored.length
      ? U.round(induced.allScored.reduce((s, x) => s + x.delta, 0) / induced.allScored.length, 3)
      : 0;

    const out = baseDims.map((b) => {
      const nxt = nextDims.find((d) => d.id === b.id || d.name === b.name);
      const to = nxt ? nxt.max : 0;
      const src = byName[b.name];
      const cnt = src ? src.items.length : 0;
      const items = src ? src.items.slice(0, 3).map((i) => i.label) : [];
      const dimAvg = src ? U.round(src.items.reduce((s, x) => s + x.delta, 0) / (src.items.length || 1), 3) : 0;

      /* Δ 与批次均值的比较必须条件化：分值下调的主因往往是「这个维度只找到 1 个要点」，
       * 而不是「它的 Δ 低」。之前一刀切写「低于批次均值」，实测中出现过
       * 「平均 Δ 0.75，低于批次均值 0.635」这种自相矛盾的解释，教师一眼就会看穿。 */
      const cmp = dimAvg >= avgDelta ? '不低于' : '低于';
      let why;
      if (!nxt) {
        why = '本批次未获得任何具备区分度的考察要点，已按最低分保留';
      } else if (nxt.silent) {
        why = '本批次中该维度没有表现出区分度（人人写法雷同），按 ' + to + ' 分保底保留 —— '
          + '数据量不足以说明它该占多少分；不删除是为了避免「全班都不写的方面就不计分」';
      } else if (to > b.max) {
        why = '采纳 ' + cnt + ' 个高区分度要点（平均 Δ ' + dimAvg + '，' + cmp + '批次均值 ' + avgDelta + '）：'
          + items.join('、');
      } else if (to < b.max) {
        why = '只找到 ' + cnt + ' 个具备区分度的要点，权重合计偏低（平均 Δ ' + dimAvg + '，'
          + cmp + '批次均值 ' + avgDelta + '）';
      } else {
        why = '分值持平：采纳 ' + cnt + ' 个要点，权重与原始量表相当';
      }
      return { dim: b.name, from: b.max, to, delta: to - b.max, why, evidence: items };
    });

    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  /**
   * 批次自适应主入口。
   * @param {Array} docs     [{name, text, features?}]
   * @param {Array} rubric   当前量表
   * @param {Object} opts    { rounds, minDelta, minSupport }
   * @returns {Object} { rubric, changes, rounds, stats, baseline, highNames, lowNames, unchanged }
   */
  function fit(docs, rubric, opts) {
    opts = opts || {};
    const list = (docs || []).filter((d) => d && String(d.text || '').trim().length >= 50);
    if (list.length < 4) {
      const err = new Error('批次自适应至少需要 4 份作业（当前 ' + list.length + ' 份）——样本少于 4 时，'
        + '区分度是拿一篇对另一篇算出来的，得出的权重换个班就不灵了');
      err.code = 'TOO_FEW';
      throw err;
    }
    list.forEach((d) => { if (!d.features) d.features = AG.parser.extractFeatures(d.text); });

    const base = (rubric && rubric.length ? AG.rubric.cloneRubric(rubric) : AG.rubric.cloneRubric())
      .filter((d) => d.enabled !== false);
    if (!base.length) throw new Error('当前量表没有启用任何维度，无法做自适应');

    /* 分组依据：结构化基线 qualityBaseline。
     * 旧实现在这里混入了「用当前量表打一遍分」，而那需要本地启发式引擎——
     * 引擎已按需求下线，这里不再补一个替代打分器，原因有二：
     *   1. 它只是用来排出伪高低组，不是给学生打分，用不上语义级判断；
     *   2. 换成模型打分会让「自适应」变成一次 N 份作业的网络调用，成本与耗时都不可接受。
     * 真正的内容差异本来就是由后续 induce 的区分度引擎在高低组之间算出来的。 */
    const rankWith = () => list.map((d) => {
      const bl = qualityBaseline(d);
      return { doc: d, base: bl, score: null, rank: bl };
    }).sort((a, b) => b.rank - a.rank);

    const k = Math.max(1, Math.min(Math.round(list.length * 0.3), Math.floor(list.length / 2)));
    let cur = base;
    let highDocs = null;
    let lowDocs = null;
    let last = null;
    const rounds = [];
    const maxRound = opts.rounds || 2;

    for (let round = 1; round <= maxRound; round++) {
      if (!highDocs) {
        const ranked = rankWith(cur);
        highDocs = ranked.slice(0, k).map((x) => x.doc);
        lowDocs = ranked.slice(-k).map((x) => x.doc);
      }
      const anchors = AG.induce.anchorsFromRubric(cur);
      let induced;
      try {
        induced = AG.induce.induce(highDocs, lowDocs, {
          anchors,
          totalScore: 100,
          minDelta: opts.minDelta == null ? 0.2 : opts.minDelta,
          minSupport: opts.minSupport == null ? 0.25 : opts.minSupport,
        });
      } catch (e) {
        if (round === 1) {
          /* 「这批作业分不出高下」是一个**合法结论**，不是程序故障。
           * 一道题全班写法高度雷同（或者抄同一份）时本来就没有 learning signal，
           * 此时维持原量表才是正确答案 —— 强行按噪声调权重，比不调更糟。
           * 所以这里不抛错，而是带着 NO_SIGNAL 标记返回，让 UI 能说清楚「为什么没动」。
           *
           * 注意别直接用 induce 的原文：那是给「手动挑范文」场景写的，
           * 会出现「请补充更有差异的范文」这种在自动批次场景下莫名其妙的建议。 */
          return {
            rubric: base, changes: [], rounds: [], unchanged: true,
            blocked: 'NO_SIGNAL',
            reason: '这批作业之间没有表现出可区分的差异，维持当前量表不作调整。'
              + '同一道题写得高度雷同（或互相抄袭）时本就没有可供学习的权重信号，'
              + '强行按噪声调整比不调整更不可靠。',
            detail: String(e && e.message ? e.message : e),
            stats: { docCount: list.length, groupSize: k },
            grouped: { high: (highDocs || []).map((d) => d.name), low: (lowDocs || []).map((d) => d.name) },
            keptTop: [], dropped: [],
          };
        }
        break;                      // 后续轮失败则保留上一轮成果，不连累整体
      }

      // misc 是「归类不进任何维度」的兜底桶，它的 signal 是永真式，所有人满分 → 零区分度，剔除
      let next = AG.induce.toRubric(induced, cur).filter((d) => d.id !== 'misc' && d.max > 0);
      if (!next.length) throw new Error('未诱导出任何有效维度，建议放宽诱导阈值（降低最小区分度）后重试');
      next = keepSilent(next, base);          // 沉默维度留位置，绝不删除
      AG.templates.normalizeScores(next, 100);
      // 归一化会等比放大所有维度，可能把某个维度重新顶过 MAX_DIM，所以必须压在最后
      capPeak(next, MAX_DIM);
      applyLocks(next, rubric);

      rounds.push({
        round,
        kept: induced.stats.keptCount,
        dropped: induced.stats.droppedCount,
        dims: next.map((d) => ({ name: d.name, max: d.max })),
      });
      last = { induced, rubric: next };

      if (round > 1 && sameShape(rounds[round - 2].dims, rounds[round - 1].dims)) break;  // 已收敛

      cur = next;
      const reranked = rankWith(cur);
      highDocs = reranked.slice(0, k).map((x) => x.doc);
      lowDocs = reranked.slice(-k).map((x) => x.doc);
    }

    const finalRubric = last.rubric;
    const changes = buildChanges(base, finalRubric, last.induced);
    const unchanged = changes.every((c) => Math.abs(c.delta) <= 1);
    const dropped = (last.induced.dropped || []).slice(0, 8);
    const keptTop = (last.induced.allScored || []).slice(0, 8);

    return {
      rubric: finalRubric,
      changes,
      rounds,
      unchanged,
      stats: Object.assign({}, last.induced.stats, { docCount: list.length, groupSize: k }),
      grouped: {
        high: highDocs.map((d) => d.name),
        low: lowDocs.map((d) => d.name),
      },
      keptTop,
      dropped,
    };
  }

  /* ============================================================
   * 6. 混批异质性检测
   *
   * 「很多时候不只是上传一样的作业」——一批里混进不同题目时，用同一套标准评出来的
   * 分完全不可比。这里用章节标题的 Jaccard 相似度做单连通聚簇，够轻也够准。
   * ============================================================ */
  /**
   * 章节标题的模糊相等。
   * 严格相等的判据太脆：同一份作业里「实验原理」与「原理」、「数据处理」与「数据处理与误差分析」
   * 本是一回事，精确匹配会把同一道题的好学生与差学生判成两道不同的题。
   */
  function sameSection(a, b) {
    if (a === b) return true;
    const s = a.length <= b.length ? a : b;
    const l = a.length <= b.length ? b : a;
    return s.length >= 2 && l.indexOf(s) >= 0;
  }

  function jaccardFuzzy(setA, setB) {
    let inter = 0;
    setA.forEach((x) => { if (setB.has(x)) inter++; });
    if (inter) return { sim: inter / (setA.size + setB.size - inter), inter, hit: true };
    // 退一步做模糊比对：只在精确交集为空时才付出这份计算
    let fz = 0;
    const arrA = Array.from(setA), arrB = Array.from(setB);
    arrA.forEach((x) => { if (arrB.some((y) => sameSection(x, y))) fz++; });
    return { sim: fz / (arrA.length + arrB.length - fz || 1), inter: fz, hit: fz > 0 };
  }

  function jaccard(setA, setB) {
    let inter = 0;
    setA.forEach((x) => { if (setB.has(x)) inter++; });
    const uni = setA.size + setB.size - inter;
    return uni ? inter / uni : 0;
  }

  /**
   * 混批异质性检测。
   *
   * 相似度为什么不能只看章节标题：第一批原型就是这么写的，结果一份**同题**作业里，
   * 认真写的同学用「数据处理与误差分析」、糊弄的同学用「结果」，两套标题精确交集不够，
   * 系统就把同一道题判成了两道题。这个误报非常致命——它劝教师去做根本不需要做的分批。
   *
   * 现在的判据是两路信号加权：
   *   章节相似度 0.4 —— 结构同构性强，受写作水平影响大，所以权重不能太高
   *   词表相似度 0.6 —— 同一道题的学生自然会共用同一批术语（单摆/摆长/周期），
   *                     换个题目这批词会几乎完全不重合，是最可靠的判别信号
   */
  function detectMix(docs, opts) {
    opts = opts || {};
    const threshold = opts.threshold == null ? 0.30 : opts.threshold;
    const items = (docs || []).filter((d) => d && String(d.text || '').trim().length >= 50);
    if (items.length < 3) return { mixed: false, clusters: [], reason: '样本不足 3 份，不做异质性判断' };
    items.forEach((d) => { if (!d.features) d.features = AG.parser.extractFeatures(d.text); });

    const sets = items.map((d) => {
      const sec = new Set(
        AG.induce.extractSections(d.text || '')
          .map((s) => String(s).replace(/^\d+(\.\d+)*[、.]?\s*/, '').replace(/^[一二三四五六七八九十]+[、.]\s*/, '').trim())
          .filter(Boolean)
      );
      const terms = new Set(AG.induce.extractTerms(d.text || '', 2).slice(0, 40).map((x) => x.term));
      return { name: d.name, sec, terms };
    });
    // 词表少于 3 条的文档（多半是只有几句的空壳）参与聚类只会制造噪声
    const usable = sets.map((s, i) => (s.terms.size >= 3 ? i : -1)).filter((i) => i >= 0);
    if (usable.length < 3) return { mixed: false, clusters: [], reason: '有效内容过少，无法判断题目是否一致' };

    const parent = {};
    usable.forEach((i) => { parent[i] = i; });
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    const simMatrix = [];
    for (let a = 0; a < usable.length; a++) {
      for (let b = a + 1; b < usable.length; b++) {
        const i = usable[a], j = usable[b];
        const sSec = jaccardFuzzy(sets[i].sec, sets[j].sec).sim;
        const sTerm = jaccard(sets[i].terms, sets[j].terms);
        const sim = 0.4 * sSec + 0.6 * sTerm;
        simMatrix.push({ a: sets[i].name, b: sets[j].name, sim: U.round(sim, 3), sSec: U.round(sSec, 3), sTerm: U.round(sTerm, 3) });
        if (sim >= threshold) union(i, j);
      }
    }

    const groups = {};
    usable.forEach((i) => { const r = find(i); (groups[r] = groups[r] || { idx: [] }).idx.push(i); });
    const clusters = Object.keys(groups).map((r) => {
      const idx = groups[r].idx;
      const common = {};
      idx.forEach((i) => sets[i].sec.forEach((s) => { common[s] = (common[s] || 0) + 1; }));
      const top = Object.keys(common).sort((x, y) => common[y] - common[x]).slice(0, 5);
      return { size: idx.length, names: idx.map((i) => items[i].name), sections: top };
    }).sort((a, b) => b.size - a.size);

    const eligible = clusters.filter((c) => c.size >= 2);
    // 判 mixed 还要过一道闸：少数簇得够大才值得惊动教师 —— 只有 1 份作业写了别的题，
    // 更可能是这位同学跑题了，而不是教师传错了批次
    const minoritySize = eligible.slice(1).reduce((s, c) => s + c.size, 0);
    const mixed = eligible.length >= 2 && minoritySize >= 2;

    return {
      mixed,
      clusters,
      dominant: clusters[0] || null,
      minority: eligible.slice(1),
      coverage: clusters[0] ? U.round(clusters[0].size / items.length, 2) : 0,
      simMatrix: opts.debug ? simMatrix : undefined,
      reason: mixed
        ? `这批作业似乎混了 ${eligible.length} 类题目：主体 ${clusters[0].size}/${items.length} 份，`
          + `另有 ${minoritySize} 份的术语与章节结构明显不同 —— 同一套标准下这两拨人的分数不可比`
        : '章节结构与用词基本一致，可以共用一套标准',
    };
  }

  AG.rubriclab = {
    EXAMPLES,
    detectDiscipline, suggestTemplate, parseIntent, locateDim, locateDims, locateOne, splitCoord, splitClauses, capPeak,
    MAX_DIM,
    fromPrompt, fromPromptLocal, fromPromptLLM,
    fit, qualityBaseline, detectMix, applyLocks, keepSilent, SILENT_FLOOR,
    BOOST, escapeRe,
  };
})(window);
