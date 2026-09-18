/* AutoGrader · 文档类型库（Doc Types）
 *
 * 需求③「类型设置」的数据层。解决的是一件很具体的事：
 * 教师拿到一批作业时，系统得先知道「这到底是什么类型的文档」，
 * 才能给出对得上的评分方向——用编程实验的量表去评化学实验，
 * 「代码片段」那 25 分永远拿不到，分数不是低，是错。
 *
 * 三条设计约束：
 *   1. 内置类型**派生自** rubric-templates.js，不另起炉灶。模板已经有 7 套学科量表和
 *      上百个学科特征词，类型 = 模板的「索引层」：名称 + 特征词 + 评分方向。
 *   2. 用户改动**不直接改内置数据**，而是存 patch（覆写）/ custom（新增）/ disabled（停用）。
 *      这样升级内置模板不会冲掉教师的个性化设置，也支持「恢复默认」。
 *   3. 类型库是**唯一的真源**，设置模块与评分工作台都订阅它的变更事件（on/emit），
 *      任一侧新增或修改都能立刻在另一侧看到——这就是需求里说的「双向同步」。
 *
 * 一句话生成量表（rubriclab）仍按自己的路子走；这里只负责「先认出是哪一类」，
 * 认出之后要不要套用该类型的评分方向，由使用者在 UI 上决定。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const STORE_KEY = 'doctypes';

  /* 命中多少种**不同**特征词才算"认出来了"。
   * 只命中 1 个词（哪怕出现 8 次）多半是巧合：一篇社会学报告也会反复提"数据"。 */
  const MATCH_MIN_SPECIES = 2;
  const MATCH_MIN_HITS = 2;
  /* 第一名与第二名分数过于接近时，标为「存疑」，UI 上应让用户自己选，别自动替他决定 */
  const AMBIGUOUS_GAP = 0.6;

  /* 新建类型时给的默认评分方向。
   * 这四条是所有实验/报告类文档的公约数，先给出来，教师改比从空白写快得多。 */
  const DEFAULT_DIRECTIONS = [
    { id: 'purpose', name: '目的与要求', max: 20, desc: '是否阐明文档要解决的问题与应达成的目标。' },
    { id: 'method', name: '方法与过程', max: 25, desc: '采用的手段、步骤与过程描述是否完整、可复现。' },
    { id: 'result', name: '结果与分析', max: 35, desc: '是否给出结果，并对结果做了有依据的分析而非罗列。' },
    { id: 'norm', name: '结论与规范', max: 20, desc: '结论是否回应目的，格式、引用与行文是否规范。' },
  ];

  /* 抽关键词时的停用词：出现频率高但对"这是什么类型"没有区分度。
   * 注意别把学科词误杀——"数据"在数据科学报告里是核心特征，所以不在表内。 */
  const STOP_TERMS = ['实验', '报告', '我们', '可以', '进行', '通过', '本次', '内容', '一个',
    '没有', '就是', '自己', '他们', '这个', '那个', '因此', '所以', '然后', '如果', '由于',
    '其中', '如下', '所示', '以及', '并且', '对于', '关于', '需要', '应该', '已经', '这些',
    '那些', '什么', '如何', '一些', '很多', '非常', '比较', '主要', '基本', '使用', '利用',
    '完成', '过程', '问题', '方法', '结果', '分析', '说明', '介绍', '包括', '例如', '同时',
    '最后', '首先', '其次', '再次', '本文', '本次实验', '实验中', '实验报告', '实验目的'];

  /* ---------------- 变更订阅（双向同步的总线） ---------------- */
  const listeners = [];
  function on(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit(reason, payload) {
    listeners.forEach((fn) => {
      // 单个订阅者抛错不该连累其他人：一个渲染函数崩了，另一侧的同步还得照常发生
      try { fn(reason, payload); } catch (e) { /* 静默：渲染层的异常不该中断数据层 */ }
    });
  }

  /* ---------------- 内置类型：从学科模板派生 ---------------- */
  let builtinCache = null;

  function builtins() {
    if (builtinCache) return builtinCache;
    const T = (AG.templates && AG.templates.TEMPLATES) || [];
    builtinCache = T.map((t) => ({
      id: t.id,
      name: t.name,
      brief: t.brief || '',
      builtin: true,
      enabled: true,
      // 特征词直接用模板的 aliases：那批词本来就是为"按作业内容识别学科"整理的
      keywords: (t.aliases || []).slice(),
      // 评分方向 = 模板的维度。只取名称/分值/描述三件套，正则细节留给 toRubric 时再展开
      directions: (t.dims || []).map((d) => ({
        id: d.id,
        name: d.name,
        max: Number(d.max) || 10,
        desc: d.desc || '',
      })),
    }));
    return builtinCache;
  }

  /* ---------------- 本地存档 ---------------- */
  let store = null;

  function load() {
    if (store) return store;
    const raw = U.store.get(STORE_KEY, null) || {};
    store = {
      custom: Array.isArray(raw.custom) ? raw.custom : [],
      patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : {},
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
    };
    return store;
  }

  function save() { U.store.set(STORE_KEY, load()); }

  /* ---------------- 读取 ---------------- */

  /**
   * 全量类型列表 = 内置（合并用户覆写）+ 用户新增。
   * @param {Object} opts { includeDisabled: 是否包含已停用的 }
   */
  function all(opts) {
    opts = opts || {};
    const s = load();
    const out = builtins().map((b) => {
      const p = s.patch[b.id] || {};
      return {
        id: b.id,
        name: p.name || b.name,
        brief: p.brief || b.brief,
        builtin: true,
        enabled: s.disabled.indexOf(b.id) < 0,
        keywords: p.keywords || b.keywords,
        directions: p.directions || b.directions,
        edited: !!(p.name || p.brief || p.keywords || p.directions),
      };
    });
    s.custom.forEach((c) => {
      out.push(Object.assign({}, c, {
        builtin: false,
        enabled: c.enabled !== false,
        edited: true,
      }));
    });
    return opts.includeDisabled ? out : out.filter((t) => t.enabled);
  }

  function get(id, opts) {
    return all(opts).find((t) => t.id === id) || null;
  }

  function count() {
    const s = load();
    return { builtin: builtins().length, custom: s.custom.length, disabled: s.disabled.length };
  }

  /* ---------------- 写入 ---------------- */

  /**
   * 新增或更新一个类型。
   * 内置类型走 patch（只存差异），用户类型直接写进 custom。
   * @returns 保存后的类型对象
   */
  function upsert(type) {
    if (!type || !type.id) return null;
    const s = load();
    const clean = normalizeType(type);

    if (clean.builtin) {
      const base = builtins().find((b) => b.id === clean.id);
      if (!base) return null;
      // 只存与内置不同的部分，避免把整套模板抄进 localStorage
      const p = {};
      if (clean.name !== base.name) p.name = clean.name;
      if (clean.brief !== base.brief) p.brief = clean.brief;
      if (!sameArr(clean.keywords, base.keywords)) p.keywords = clean.keywords;
      if (!sameDirs(clean.directions, base.directions)) p.directions = clean.directions;
      if (Object.keys(p).length) s.patch[clean.id] = p; else delete s.patch[clean.id];
      const i = s.disabled.indexOf(clean.id);
      if (clean.enabled === false && i < 0) s.disabled.push(clean.id);
      if (clean.enabled !== false && i >= 0) s.disabled.splice(i, 1);
    } else {
      const i = s.custom.findIndex((c) => c.id === clean.id);
      if (i >= 0) s.custom[i] = Object.assign({}, s.custom[i], clean);
      else s.custom.push(clean);
    }
    save();
    emit('upsert', { id: clean.id, type: clean });
    return clean;
  }

  function remove(id) {
    const s = load();
    const isBuiltin = builtins().some((b) => b.id === id);
    if (isBuiltin) {
      // 内置类型不允许真删除（删了就没法"恢复默认"），语义等同于停用
      const i = s.disabled.indexOf(id);
      if (i < 0) s.disabled.push(id);
      delete s.patch[id];
    } else {
      const i = s.custom.findIndex((c) => c.id === id);
      if (i >= 0) s.custom.splice(i, 1);
    }
    save();
    emit('remove', { id });
    return true;
  }

  function toggle(id, enabled) {
    const s = load();
    const isBuiltin = builtins().some((b) => b.id === id);
    const on = enabled !== false;
    if (isBuiltin) {
      const i = s.disabled.indexOf(id);
      if (!on && i < 0) s.disabled.push(id);
      if (on && i >= 0) s.disabled.splice(i, 1);
    } else {
      const c = s.custom.find((x) => x.id === id);
      if (c) c.enabled = on;
    }
    save();
    emit('toggle', { id, enabled: on });
    return on;
  }

  /** 恢复默认：清掉全部用户新增与覆写（不可撤销，UI 需二次确认） */
  function resetAll() {
    store = { custom: [], patch: {}, disabled: [] };
    save();
    emit('reset', {});
    return true;
  }

  function normalizeType(t) {
    const isBuiltin = !!t.builtin || builtins().some((b) => b.id === t.id);
    const dirs = (t.directions || []).map((d, i) => ({
      id: d.id || dirId(d.name, i),
      name: String(d.name || '').trim() || ('评分方向 ' + (i + 1)),
      max: Number(d.max) || 10,
      desc: String(d.desc || '').trim(),
    }));
    return {
      id: t.id,
      name: String(t.name || '').trim() || '未命名类型',
      brief: String(t.brief || '').trim(),
      builtin: isBuiltin,
      enabled: t.enabled !== false,
      keywords: dedupe((t.keywords || []).map((k) => String(k || '').trim()).filter((k) => k.length >= 2)),
      directions: dirs,
      source: t.source || (isBuiltin ? 'builtin' : 'user'),
      updatedAt: Date.now(),
    };
  }

  function dirId(name, i) {
    const base = String(name || '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
    return base ? 'dir_' + base : 'dir_' + (i + 1);
  }

  function dedupe(arr) {
    const seen = {};
    return arr.filter((x) => {
      const k = String(x).toLowerCase();
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  function sameArr(a, b) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return false;
    return a.every((x, i) => String(x) === String(b[i]));
  }

  function sameDirs(a, b) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return false;
    return a.every((x, i) => x.name === b[i].name && Number(x.max) === Number(b[i].max) && (x.desc || '') === (b[i].desc || ''));
  }

  /* ---------------- 检索：这份文档是什么类型？ ----------------
   *
   * 需求原文：「评分工作台加入文档后，先检索系统自带 + 用户预置的类型，
   * 再按实际情况决定是否新增」。所以这里返回的不只是一个答案，而是
   * 「最像谁 + 像的理由 + 够不够确定」三件事——够确定就直接用，
   * 不够确定就把候选摆出来让用户选，实在都不像才建议新建。
   */
  function buildHay(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')      // 代码块里全是标识符，对判别文体没帮助
      .replace(/[ \t\r\n\u3000]+/g, ' ')
      .toLowerCase();
  }

  function buildCompact(text) {
    // 去掉所有空白与标点：让跨行、跨空格的特征词也能命中（"时间 复杂度" → "时间复杂度"）
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。；：、,.!?！？;:()（）\[\]【】"'"'“”_\-/~|]/g, '')
      .toLowerCase();
  }

  function countIn(hay, needle) {
    if (!needle) return 0;
    let c = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) {
      c++;
      // 单篇文档里同一个词出现几百次没有额外信息量，数到 50 就够用
      if (c >= 50) break;
      i = hay.indexOf(needle, i + needle.length);
    }
    return c;
  }

  function scoreOne(type, hay, compact) {
    const kws = [type.name].concat(type.keywords || []);
    let species = 0;
    let hits = 0;
    const matched = [];
    kws.forEach((k) => {
      const kk = String(k || '').toLowerCase().trim();
      if (kk.length < 2) return;
      const kc = kk.replace(/[\s\u3000]+/g, '');
      let c = countIn(hay, kk);
      if (kc && kc !== kk) c = Math.max(c, countIn(compact, kc));
      if (c > 0) {
        species++;
        hits += c;
        matched.push({ kw: k, count: c });
      }
    });
    matched.sort((a, b) => b.count - a.count);
    // 种的权重远大于次数：命中 5 个不同词 > 一个词命中 20 次
    const score = species * 1 + Math.min(hits - species, 20) * 0.05;
    return {
      id: type.id, name: type.name, builtin: !!type.builtin,
      species, hits, score: U.round(score, 2),
      matched: matched.slice(0, 8),
    };
  }

  /**
   * @param {Object} doc { name, text }
   * @returns { best, ranked, confident, ambiguous }
   */
  function match(doc) {
    const text = String((doc && doc.text) || '');
    const name = String((doc && doc.name) || '');
    const hay = buildHay(text) + ' ' + buildHay(name);
    const compact = buildCompact(text) + buildCompact(name);
    const ranked = all()
      .map((t) => scoreOne(t, hay, compact))
      .filter((r) => r.species > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0] || null;
    const second = ranked[1] || null;
    return {
      best,
      ranked: ranked.slice(0, 4),
      confident: !!(best && best.species >= MATCH_MIN_SPECIES && best.hits >= MATCH_MIN_HITS),
      ambiguous: !!(best && second && best.score - second.score < AMBIGUOUS_GAP),
    };
  }

  /* ---------------- 新建类型的草稿 ---------------- */

  /**
   * 从文档正文里抽候选特征词。
   * 做法：滑窗统计 2~4 字中文串 + 英文词的频次，剔掉被更长高频串"包住"的短串，
   * 再按 频次×(长度-1) 排序——既倾向于"真术语"（长且反复出现），
   * 也避免把"的时"这种无意义组合排到前面。
   */
  function pickTerms(text, limit) {
    limit = limit || 10;
    const s = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .toLowerCase();

    const counts = new Map();
    const bump = (g) => counts.set(g, (counts.get(g) || 0) + 1);

    // 中文：先按非中文切段，避免跨标点造出假词
    s.split(/[^一-龥]+/).forEach((seg) => {
      if (seg.length < 2) return;
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) bump(seg.substr(i, n));
      }
    });
    // 英文/技术词：torch、dataframe 这类整词比 n-gram 更有意义
    (s.match(/[a-z][a-z+#.]{2,}/g) || []).forEach((w) => bump(w));

    const raw = [];
    counts.forEach((c, g) => {
      if (c < 2) return;
      if (g.length < 2) return;
      if (STOP_TERMS.indexOf(g) >= 0) return;
      raw.push({ g, c });
    });

    // 去掉被更长的高频串完全覆盖的短串：出现"神经网络"就不需要再列"神经网"和"经网络"
    const covered = (g) => raw.some((r) => r.g !== g && r.g.length > g.length
      && r.g.indexOf(g) >= 0 && r.c >= counts.get(g) * 0.9);

    const picked = raw
      .filter((r) => !covered(r.g))
      .sort((a, b) => (b.c * (b.g.length - 1)) - (a.c * (a.g.length - 1)));

    const out = [];
    picked.forEach((r) => {
      if (out.length >= limit) return;
      const dup = out.some((p) => p.g.indexOf(r.g) >= 0 || r.g.indexOf(p.g) >= 0);
      if (!dup) out.push(r);
    });
    return out.map((r) => r.g);
  }

  /**
   * 按文档内容起草一个新类型。
   * 注意：**不直接落库**。它是给 UI 的表单初值——需求要的是"按实际情况决定是否新增"，
   * 决定权在人，机器只负责把空白表单填掉一半。
   */
  function draftFromDoc(doc) {
    const terms = pickTerms((doc && doc.text) || '', 10);
    const docName = String((doc && doc.name) || '未命名文档').replace(/\.[a-z0-9]+$/i, '');
    return {
      id: 'type_' + U.uid(''),
      name: terms.length ? terms[0] + '类文档' : (docName.slice(0, 12) + '类型'),
      brief: '由《' + docName + '》自动提取，请核对后保存',
      builtin: false,
      enabled: true,
      keywords: terms,
      directions: DEFAULT_DIRECTIONS.map((d) => Object.assign({}, d)),
      source: 'extract',
      fromDoc: (doc && doc.name) || '',
      createdAt: Date.now(),
    };
  }

  /** 空的新类型（用户在设置模块里手动点「新增类型」时用） */
  function blankType() {
    return {
      id: 'type_' + U.uid(''),
      name: '',
      brief: '',
      builtin: false,
      enabled: true,
      keywords: [],
      directions: DEFAULT_DIRECTIONS.map((d) => Object.assign({}, d)),
      source: 'user',
      createdAt: Date.now(),
    };
  }

  /* ---------------- 类型 → 量表 ---------------- */

  function escapeRe(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function splitKeys(name) {
    // 维度名拆成关键词：给模型的 signals 用，"实验结果与分析" → ["实验结果","结果与分析"]
    const s = String(name || '').replace(/[与和及、,\s]+/g, '|').split('|').filter(Boolean);
    return s.length ? s : [String(name || '')];
  }

  /**
   * 把一个类型的评分方向编译成可直接使用的量表维度。
   * 内置类型优先复用模板里已写好的 signals/penalties/advice（那是"讲清楚这个维度"的成品），
   * 用户改过的部分则以用户为准；用户自建类型只能按维度名生成兜底信号。
   */
  function toRubric(type) {
    if (!type || !(type.directions || []).length) return null;
    const tpl = type.builtin ? AG.templates.get(type.id) : null;
    const compiled = tpl ? AG.templates.compile(tpl) : null;

    const dirs = type.directions.map((d, i) => ({
      id: d.id || dirId(d.name, i),
      name: d.name,
      max: Number(d.max) || 10,
      desc: d.desc || '',
    }));
    AG.templates.normalizeScores(dirs, 100);

    return dirs.map((d) => {
      const base = compiled
        ? (compiled.find((c) => c.id === d.id) || compiled.find((c) => c.name === d.name))
        : null;
      if (!base) {
        return {
          id: d.id, name: d.name, max: d.max, desc: d.desc, advice: '',
          keys: splitKeys(d.name), enabled: true,
          signals: [{ label: '涉及「' + d.name + '」的相关内容', re: new RegExp(escapeRe(d.name), 'g'), w: 1 }],
          penalties: [],
        };
      }
      return Object.assign({}, base, {
        name: d.name,
        max: d.max,
        desc: d.desc || base.desc,
      });
    });
  }

  AG.doctypes = {
    DEFAULT_DIRECTIONS,
    STORE_KEY,
    MATCH_MIN_SPECIES,
    on, emit,
    builtins, all, get, count,
    upsert, remove, toggle, resetAll,
    match, pickTerms, draftFromDoc, blankType,
    toRubric,
  };
})(window);
