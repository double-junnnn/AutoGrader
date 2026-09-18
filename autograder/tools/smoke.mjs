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
  ['providers', 'PRESETS'], ['providers', 'recommend'], ['providers', 'pickReviewer'],
  ['llm', 'grade'], ['llm', 'sampleGrade'], ['llm', 'gradeWithReviewer'], ['llm', 'getConfig'],
  ['reliability', 'cronbachAlpha'], ['reliability', 'stability'], ['reliability', 'evidenceAudit'],
  ['reliability', 'jackknife'], ['reliability', 'lengthBias'], ['reliability', 'stabilityGrade'],
  ['consensus', 'compare'], ['consensus', 'fuse'], ['consensus', 'samplingBaseline'],
  ['induce', 'induce'], ['rubriclab', 'fit'], ['theme', 'apply'], ['voice', 'TONES'],
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
await ok('providers.pickReviewer 跨模型族', () => {
  const a = AG.providers.pickReviewer('siliconflow');
  const b = AG.providers.PRESETS.siliconflow;
  return a && a.family !== b.family ? true : `${a && a.family} vs ${b.family}`;
});

await ok('analyzer 不再导出 grade（本地评分已移除）', () => AG.analyzer.grade === undefined);
await ok('reliability 不再导出 bootstrap', () => AG.reliability.bootstrap === undefined);
await ok('consensus 不再导出 resampleBaseline', () => AG.consensus.resampleBaseline === undefined);

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
