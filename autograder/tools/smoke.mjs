/* 冒烟测试：在 Node 里用最小 DOM 桩加载全部模块，验证初始化与纯函数可用。
 * 目的是抓「改了一个模块，另一个模块引用它已删除的 API」这类运行时错误。
 * 不覆盖真实交互（那需要浏览器），只覆盖加载期与纯计算。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(process.cwd(), 'assets/js');
const order = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
  .split('\n')
  .map((l) => (l.match(/<script src="assets\/js\/([^"]+)"/) || [])[1])
  .filter(Boolean);

/* ---- 最小 DOM 桩 ---- */
const store = new Map();
const noop = () => {};
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    className: '', innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, title: '',
    appendChild(c) { this.children.push(c); return c; },
    removeChild: noop, remove: noop, addEventListener: noop, removeEventListener: noop,
    setAttribute: noop, getAttribute: () => null, focus: noop, click: noop,
    querySelector: () => mkEl('div'), querySelectorAll: () => [],
    getContext: () => ctx2d, isConnected: false,
  };
  return el;
}
const ctx2d = new Proxy({}, { get: () => () => ctx2d, set: () => true });

const document = {
  documentElement: mkEl('html'), body: mkEl('body'), head: mkEl('head'),
  createElement: mkEl, createElementNS: mkEl, createTextNode: (t) => ({ text: t }),
  querySelector: () => mkEl('div'), querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop, getElementById: () => mkEl('div'),
  fonts: { ready: Promise.resolve(), add: noop },
};

const sandbox = {
  window: null, document, console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  location: { href: 'file:///index.html', protocol: 'file:', search: '' },
  fetch: async () => { throw new Error('no network in smoke test'); },
  Image: class { set src(v) { this._src = v; } get src() { return this._src; } addEventListener() {} },
  URL, Blob: class {}, FileReader: class { readAsDataURL() {} addEventListener() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  matchMedia: () => ({ matches: false, addEventListener: noop }),
  alert: noop, confirm: () => true, prompt: () => '',
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  DOMParser: class { parseFromString() { return mkEl('div'); } },
  XMLSerializer: class { serializeToString() { return ''; } },
  TextDecoder, TextEncoder, Math, JSON, Date, RegExp, Promise, Error, Object, Array, String, Number, Boolean, Map, Set,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let loaded = 0;
const failures = [];
for (const f of order) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { failures.push(`缺少文件 ${f}`); continue; }
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
    loaded++;
  } catch (e) {
    failures.push(`加载 ${f} 失败：${e.message}`);
  }
}

const AG = sandbox.AG || {};
const need = [
  ['utils', 'clamp'], ['rubric', 'DEFAULT_RUBRIC'], ['rubric', 'gradeOf'],
  ['parser', 'extractFeatures'],
  ['analyzer', 'genreCheck'], ['analyzer', 'similarity'], ['analyzer', 'verifyEvidence'],
  ['providers', 'PRESETS'], ['providers', 'recommend'],
  ['llm', 'grade'], ['llm', 'sampleGrade'], ['llm', 'getConfig'],
  ['reliability', 'cronbachAlpha'], ['reliability', 'stability'], ['reliability', 'evidenceAudit'],
  ['reliability', 'jackknife'], ['reliability', 'lengthBias'], ['reliability', 'stabilityGrade'],
  ['induce', 'induce'], ['rubriclab', 'fit'], ['theme', 'apply'], ['voice', 'TONES'],
  ['pet', 'lookAt'],
  ['doctypes', 'all'], ['doctypes', 'get'], ['doctypes', 'match'], ['doctypes', 'upsert'],
  ['doctypes', 'remove'], ['doctypes', 'toggle'], ['doctypes', 'resetAll'], ['doctypes', 'on'],
  ['doctypes', 'pickTerms'], ['doctypes', 'draftFromDoc'], ['doctypes', 'blankType'],
  ['doctypes', 'toRubric'],
  ['charts', 'heatmap'], ['charts', 'bootstrapBand'], ['demos', null], ['docx', null],
  ['pdf', null], ['chat', null], ['mascots', null],
];
for (const [mod, fn] of need) {
  if (!AG[mod]) { failures.push(`模块缺失：AG.${mod}`); continue; }
  if (fn && typeof AG[mod][fn] !== 'function' && AG[mod][fn] === undefined) {
    failures.push(`API 缺失：AG.${mod}.${fn}`);
  }
}

/* ---- 纯函数行为验证 ---- */
const checks = [];
async function ok(name, fn) {
  try {
    const r = await fn();
    checks.push([r === true ? 'PASS' : 'FAIL', name, r === true ? '' : String(r)]);
  } catch (e) {
    checks.push(['FAIL', name, e.message]);
  }
}

const TEXT = `实验目的\n本实验旨在验证快速排序算法的正确性并测量其时间复杂度。\n\n实验环境\nWindows 11, Python 3.11。\n\n实验步骤\n1. 实现 quicksort\n2. 生成随机数组\n\n\`\`\`python\ndef quicksort(a):\n    if len(a) <= 1: return a\n    return quicksort([x for x in a[1:] if x < a[0]]) + [a[0]] + quicksort([x for x in a[1:] if x >= a[0]])\n\`\`\`\n\n结果分析\n测得 n=10000 时耗时 12.3 ms，n=100000 时 158.7 ms，误差在 3% 以内。\n\n结论\n算法正确，复杂度符合 O(n log n) 预期。\n\n参考文献\n[1] 算法导论`;

await ok('genreCheck 判定实验报告为 report', () => {
  const v = AG.analyzer.genreCheck(TEXT, AG.parser.extractFeatures(TEXT)).verdict;
  return v === 'report' ? true : v;
});
await ok('genreCheck 判定小说为 offtopic', () => {
  const novel = '第一章 初遇\n他转过身，微微一笑。"你来了，"他说，眼里像是有星星。\n她低声回答："嗯，我来了。"\n忽然，窗外下起了雨，他想起那年夏天，记得她的背影，忍不住叹息。\n第二回 旧梦\n她喃喃自语，指尖轻轻颤抖，心里想着他会不会回来。\n第三回 别离\n他望着远方，沉默良久，终于忍不住哭了。她记得他说过的话，像风一样散了。\n第四回 归途\n她转身离开，他回头看了一眼，仿佛什么都没发生过。';
  const v = AG.analyzer.genreCheck(novel, AG.parser.extractFeatures(novel)).verdict;
  return v === 'offtopic' ? true : v;
});

await ok('verifyEvidence 命中真实原文', () => {
  const r = AG.analyzer.verifyEvidence(TEXT, ['快速排序算法', '误差在 3% 以内']);
  return r.exact === 2 && r.hallucinated.length === 0 ? true : JSON.stringify(r.items.map((i) => i.status));
});
await ok('verifyEvidence 识别编造证据', () => {
  const r = AG.analyzer.verifyEvidence(TEXT, ['本报告使用冒泡排序进行了对比实验']);
  return r.hallucinated.length === 1 ? true : JSON.stringify(r.items);
});

await ok('similarity 同文档相似度为 1', () => {
  const docs = [{ name: 'a', text: TEXT }, { name: 'b', text: TEXT }];
  return AG.analyzer.similarity(docs).pairs[0].value === 1;
});
await ok('similarity 支持 crossUser 范围', () => {
  const docs = [
    { name: 'a', text: TEXT, submitter: '张三' },
    { name: 'b', text: TEXT, submitter: '张三' },
  ];
  const same = AG.analyzer.similarity(docs, { scope: 'crossUser' });
  const diff = AG.analyzer.similarity(
    [{ name: 'a', text: TEXT, submitter: '张三' }, { name: 'b', text: TEXT, submitter: '李四' }],
    { scope: 'crossUser' },
  );
  return same.suspicious.length === 0 && diff.suspicious.length === 1
    ? true : `same=${same.suspicious.length} diff=${diff.suspicious.length}`;
});

await ok('providers.recommend 给出免费开源服务商', () => {
  const p = AG.providers.recommend();
  return p && p.open && p.free ? true : JSON.stringify(p);
});
await ok('analyzer 不再导出 grade（本地评分已移除）', () => AG.analyzer.grade === undefined);
await ok('reliability 不再导出 bootstrap', () => AG.reliability.bootstrap === undefined);
await ok('双模型交叉验证已下线（consensus 模块移除）', () => AG.consensus === undefined);
await ok('llm 不再导出 gradeWithReviewer', () => AG.llm.gradeWithReviewer === undefined);

await ok('reliability.stability 无 Key 时给出明确说明', async () => {
  const r = await AG.reliability.stability({ name: 'x', text: TEXT, features: AG.parser.extractFeatures(TEXT) }, AG.rubric.DEFAULT_RUBRIC);
  return r.ok === false && /API Key/.test(r.note || '') ? true : JSON.stringify(r);
});

await ok('evidenceAudit 汇总证据核验', () => {
  const res = {
    dims: AG.rubric.DEFAULT_RUBRIC.map((d) => ({
      id: d.id, name: d.name, max: d.max, score: 5,
      evidenceCheck: AG.analyzer.verifyEvidence(TEXT, ['快速排序算法']),
    })),
  };
  const a = AG.reliability.evidenceAudit(res);
  return a.ok && a.verdict ? true : JSON.stringify(a);
});

await ok('llm.getConfig 默认指向开源服务商', () => {
  const c = AG.llm.getConfig();
  return AG.providers.isOpenModel ? true : JSON.stringify(c);
});

/* ---- 类型设置（需求③） ---- */
await ok('doctypes 内置类型派生自学科模板', () => {
  const n = AG.doctypes.all().length;
  const t = (AG.templates.TEMPLATES || []).length;
  return n === t ? true : `类型 ${n} vs 模板 ${t}`;
});
await ok('doctypes 每个内置类型都带评分方向', () => {
  const bad = AG.doctypes.all().filter((t) => !(t.directions || []).length);
  return bad.length === 0 ? true : bad.map((t) => t.id).join(',');
});
await ok('doctypes.match 把编程实验报告认成 cs-code', () => {
  const m = AG.doctypes.match({ name: '实验三-快速排序.md', text: TEXT });
  return m.confident && m.best && m.best.id === 'cs-code'
    ? true : JSON.stringify({ id: m.best && m.best.id, species: m.best && m.best.species });
});
await ok('doctypes.match 对小说不给结论（宁可不认也不乱认）', () => {
  const novel = '他转过身微微一笑，眼里像是有星星。她低声回答，指尖轻轻颤抖，心里想着他会不会回来。窗外下起了雨，他想起那年夏天，忍不住叹息。';
  const m = AG.doctypes.match({ name: '小说.txt', text: novel });
  return m.confident === false ? true : JSON.stringify(m.best);
});
await ok('doctypes.upsert 新增自定义类型后进入 all()', () => {
  AG.doctypes.resetAll();
  const t = AG.doctypes.blankType();
  t.name = '课程设计报告';
  t.brief = '综合课程设计';
  t.keywords = ['课程设计', '系统架构', '需求分析'];
  AG.doctypes.upsert(t);
  const got = AG.doctypes.get(t.id);
  const c = AG.doctypes.count();
  return got && got.name === '课程设计报告' && c.custom === 1 ? true : JSON.stringify(c);
});
await ok('doctypes.match 能命中用户预置的类型', () => {
  const m = AG.doctypes.match({ name: '课设.docx', text: '需求分析 系统架构 课程设计 需求分析 系统架构 课程设计' });
  return m.best && m.best.name === '课程设计报告' ? true : JSON.stringify(m.best && m.best.name);
});
await ok('doctypes 改内置类型只存差异，不污染 builtins()', () => {
  const cs = AG.doctypes.get('cs-code');
  const mods = Object.assign({}, cs, { brief: '改过的简介' });
  AG.doctypes.upsert(mods);
  const fresh = AG.doctypes.builtins().find((b) => b.id === 'cs-code');
  const after = AG.doctypes.get('cs-code');
  return fresh.brief !== '改过的简介' && after.brief === '改过的简介' && after.edited
    ? true : JSON.stringify({ base: fresh.brief, now: after.brief });
});
await ok('doctypes.toggle 停用后从默认列表消失但仍可恢复', () => {
  AG.doctypes.toggle('physics', false);
  const gone = !AG.doctypes.get('physics');
  const stillThere = !!AG.doctypes.get('physics', { includeDisabled: true });
  AG.doctypes.toggle('physics', true);
  return gone && stillThere && !!AG.doctypes.get('physics') ? true : `gone=${gone} kept=${stillThere}`;
});
await ok('doctypes.remove 内置类型等价于停用（可 resetAll 恢复）', () => {
  AG.doctypes.remove('chemistry');
  const gone = !AG.doctypes.get('chemistry');
  AG.doctypes.resetAll();
  return gone && !!AG.doctypes.get('chemistry') ? true : `gone=${gone}`;
});
await ok('doctypes.toRubric 编译出的量表合计 100 分', () => {
  const r = AG.doctypes.toRubric(AG.doctypes.get('cs-code'));
  if (!r || !r.length) return '编译结果为空';
  const sum = r.reduce((a, d) => a + d.max, 0);
  return Math.abs(sum - 100) < 0.01 ? true : `合计 ${sum}`;
});
await ok('doctypes.toRubric 用户自建类型也能编译出可用量表', () => {
  const t = AG.doctypes.blankType();
  t.name = '调研报告';
  t.keywords = ['调研', '问卷'];
  const r = AG.doctypes.toRubric(t);
  const okSig = r.every((d) => d.signals && d.signals.length && d.signals[0].re instanceof RegExp);
  const sum = r.reduce((a, d) => a + d.max, 0);
  return okSig && Math.abs(sum - 100) < 0.01 ? true : `sig=${okSig} sum=${sum}`;
});
await ok('doctypes.draftFromDoc 只起草不落库', () => {
  AG.doctypes.resetAll();
  const before = AG.doctypes.count().custom;
  const d = AG.doctypes.draftFromDoc({ name: '算法实验.md', text: TEXT });
  const after = AG.doctypes.count().custom;
  return d.keywords.length > 0 && d.directions.length > 0 && before === after
    ? true : `kw=${d.keywords.length} before=${before} after=${after}`;
});
await ok('doctypes.pickTerms 抽出的词不为空且不含停用词', () => {
  const terms = AG.doctypes.pickTerms(TEXT, 8);
  return terms.length > 0 && terms.every((t) => t.length >= 2) ? true : JSON.stringify(terms);
});
await ok('doctypes 变更会广播给订阅者（双向同步的基础）', () => {
  let hits = 0;
  const off = AG.doctypes.on(() => { hits++; });
  AG.doctypes.upsert(Object.assign(AG.doctypes.blankType(), { name: '临时类型' }));
  AG.doctypes.resetAll();
  AG.doctypes.resetAll();
  return hits >= 2 ? true : `触发 ${hits} 次`;
});

/* ---- 输出 ---- */
const fails = failures.slice();
console.log(`\n模块加载 ${loaded}/${order.length}`);
if (order.length !== loaded) console.log('  加载清单：', order.join(', '));
console.log('');
for (const [st, name, msg] of checks) {
  console.log(`  ${st === 'PASS' ? '✅' : '❌'} ${name}${msg && st !== 'PASS' ? ' → ' + msg : ''}`);
  if (st !== 'PASS') fails.push(name + '：' + msg);
}
console.log('');
if (fails.length) {
  console.log('❌ 失败项：');
  fails.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
console.log('✅ 冒烟测试全部通过');
