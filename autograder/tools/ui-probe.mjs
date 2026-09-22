/* UI 回归：真实浏览器 + 真实点击 + 真实渲染值
 *
 * 与 smoke.mjs 的分工（两者都要跑，不互相替代）：
 *   smoke.mjs —— 在 Node 里用 DOM 桩加载模块，验「纯函数算得对不对、模块能不能加载」。
 *                快、零外部依赖，但**它验不了"界面真的会变"**。
 *   ui-probe.mjs —— 开一个真 Chrome，注入脚本做**真实点击**（el.click()，走完整事件流），
 *                再用 **getComputedStyle 读浏览器实际算出来的值**，最后断言。
 *
 * 为什么必须有这一层（2026-09-22 的教训）：
 *   壁纸功能当时用「直接调 AG.wallpaper.set() + 读 inline 变量」验证，全绿；
 *   但用户一真实点击就炸 —— 一个 bug 是存储写满后静默失败（读的是存储而非内存），
 *   另一个是点击被外层 label 转发吞掉。**这两类问题只有真浏览器才暴露**：
 *   变量写对了 ≠ 样式生效了；函数能调 ≠ 点击到得了。
 *
 * 零依赖约定：不引 puppeteer。用本机已装的 Chrome（headless）+ --dump-dom 取回结果。
 * 找不到 Chrome 时**跳过并提示**，不算失败 —— 保证在没装浏览器的机器上也能跑通流水线。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
/* 探针页必须写在**和页面资源同一个目录**里：
 * autograder/index.html 引用的是相对路径 assets/js/*.js，
 * 把拼好的页面丢到系统临时目录，那些脚本会全部 404（表现是「AG is not defined」）。
 * 默认测「源码版」（autograder/index.html，改完源码就能跑，不必先打包）；
 * 加 --dist 则测仓库根的打包版（需先跑 build-single.py）。 */
const DIST = process.argv.includes('--dist');
const PAGE_DIR = DIST ? path.resolve(ROOT, '..') : ROOT;
const INDEX = path.join(PAGE_DIR, 'index.html');
const TMP_PAGE = path.join(PAGE_DIR, '.ui-probe.tmp.html');

/* ---------- 找 Chrome ---------- */
function findChrome() {
  const cands = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

/* ---------- 用例 ----------
 * 每个用例的 body 在页面里执行，可用 AG / document / window；
 * 约定同 smoke.mjs：返回 true 表示通过，返回字符串表示失败原因。
 * sleep 用 setTimeout —— 在 --virtual-time-budget 下会被快进，所以这些等待几乎不耗时。
 */
const CASES = [
  {
    name: '壁纸：真实点击预设，背景真的变了',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      AG.theme.set('classic');
      AG.wallpaper.set('none');
      await sleep(60);
      const before = getComputedStyle(document.body).backgroundImage;
      const chip = Array.from(document.querySelectorAll('#wallpaperBox .wall-chip'))
        .find((c) => (c.textContent || '').indexOf('花影') >= 0);
      if (!chip) return '设置页里找不到「花影」这一格';
      chip.click();                       // ← 真实点击，走完整事件流
      await sleep(80);
      const after = getComputedStyle(document.body).backgroundImage;
      if (after === before) return '点了「花影」但背景没变（点击没生效或样式没应用）';
      if (after.indexOf('228, 120, 166') < 0) return '背景变了但不是花影的色：' + after.slice(0, 70);
      return true;
    `,
  },
  {
    name: '壁纸：上传自己的图 → 切回默认 → 再切回自己的图',
    body: `      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const byName = (n) => Array.from(document.querySelectorAll('#wallpaperBox .wall-chip'))
        .find((x) => (x.textContent || '').indexOf(n) >= 0);
      const waitFor = async (fn, ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(60); }
        return null;
      };
      /* 走真实的「选文件」路径：造一个 File 塞进 input.files 再派发 change，
         而不是直接调 setCustomFromImage —— 后者不会触发界面重建，
         恰恰会漏掉"上传后「我的图片」这一格没出现"这类问题。 */
      const fileInput = document.querySelector('#wallFile');
      if (!fileInput) return '找不到文件选择框（上传按钮没渲染出来）';
      const c = document.createElement('canvas');
      c.width = 900; c.height = 600;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c0392b'; ctx.fillRect(0, 0, 900, 600);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!blob) return 'canvas 生成图片失败';
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      const mine = await waitFor(() => byName('我的图片'), 3000);
      if (!mine) return '上传后没有出现「我的图片」这一格';
      if (AG.wallpaper.get().id !== 'custom') return '上传后当前壁纸不是「我的图片」：' + AG.wallpaper.get().id;
      const none = byName('无');
      if (!none) return '找不到「无」这一格';
      none.click();
      await sleep(120);
      if (AG.wallpaper.get().id !== 'none') return '点「无」之后 id 不是 none：' + AG.wallpaper.get().id;
      const back = await waitFor(() => byName('我的图片'), 1500);
      if (!back) return '切回默认后「我的图片」这一格消失了（图片被清掉了）';
      back.click();
      await sleep(120);
      if (AG.wallpaper.get().id !== 'custom') return '再点「我的图片」切不回去：' + AG.wallpaper.get().id;
      if (getComputedStyle(document.body).backgroundImage.indexOf('data:image') < 0) return '切回去了但背景没用上图片';
      return true;`,
  },
  {
    name: '壁纸：存储写满时切换仍然生效（内存优先）',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try { localStorage.setItem('__probe_fill', new Array(2.4e6).join('x')); } catch (e) { /* 塞满即目的 */ }
      AG.theme.set('classic');
      AG.wallpaper.set('none');
      await sleep(60);
      const before = getComputedStyle(document.body).backgroundImage;
      const chip = Array.from(document.querySelectorAll('#wallpaperBox .wall-chip'))
        .find((c) => (c.textContent || '').indexOf('晚霞') >= 0);
      if (!chip) { try { localStorage.removeItem('__probe_fill'); } catch (e) {} return '找不到「晚霞」'; }
      chip.click();
      await sleep(80);
      const after = getComputedStyle(document.body).backgroundImage;
      try { localStorage.removeItem('__probe_fill'); } catch (e) {}
      if (after === before) return '存储写满时切换失效（运行时状态应优先于持久化）';
      return true;
    `,
  },
  {
    name: '壁纸：有壁纸时卡片开模糊，切到卡通主题则撤回',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      AG.theme.set('classic');
      AG.wallpaper.set('mint');
      await sleep(80);
      const card = document.querySelector('.card');
      if (!card) return '页面上没有 .card';
      const cs = getComputedStyle(card);
      const blur = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
      if (blur === 'none') return '铺了壁纸但卡片没开 backdrop-filter（会变成白雾而不是玻璃）';
      if (!document.documentElement.classList.contains('has-wallpaper')) return 'html 上没有 has-wallpaper 类';
      AG.theme.set('toon');
      await sleep(80);
      if (document.documentElement.style.getPropertyValue('--bg-image')) return '切到卡通主题后壁纸没撤回';
      if (document.documentElement.classList.contains('has-wallpaper')) return '切到卡通主题后 has-wallpaper 没撤';
      AG.theme.set('classic');
      return true;
    `,
  },
  {
    name: '吉祥物：真实点击有反馈（顶栏只跳 · 空状态冒气泡）',
    body: `      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      /* 真实路径换肤：点顶栏的「动画卡通」色点（会触发 renderLogo 重建 logoBox）。
         直接调 AG.theme.set() 不走 onTheme 回调，吉祥物根本不会被重新挂上 ——
         这正是要测的：用户换皮肤时，吉祥物还在不在、还能不能玩。 */
      const toonDot = document.querySelector('.skin[data-theme-id="toon"]');
      if (!toonDot) return '顶栏找不到「动画卡通」色点';
      toonDot.click();
      await sleep(300);
      if (AG.theme.get() !== 'toon') return '点了色点但主题没切到卡通：' + AG.theme.get();

      /* 顶栏那只是小头像：设计上「只跳不聊」（full=false 时直接 return，不弹气泡）。
         所以这里断言跳跃反馈，气泡留给下面空状态那只大的。 */
      const logo = document.querySelector('#logoBox.pet');
      if (!logo) return '卡通主题下顶栏吉祥物没挂上互动';
      logo.click();
      await sleep(60);                       // hop 类在 210ms 后撤掉，要趁早看
      if (!logo.classList.contains('hop')) return '点击顶栏吉祥物没有跳跃反馈';

      /* 空状态那只大的：跳 + 冒评审员吐槽气泡 */
      const emptyPet = document.querySelector('#resultCard .empty .ic.pet');
      if (!emptyPet) return '空状态里没找到吉祥物（可能已有文档，跑这条前应保持空工作台）';
      emptyPet.click();
      await sleep(120);
      const b = emptyPet.querySelector('.pet-bubble');
      if (!b || !b.classList.contains('show')) return '点击空状态吉祥物没有冒出气泡';
      if (!String(b.textContent || '').trim()) return '气泡是空的';

      const classicDot = document.querySelector('.skin[data-theme-id="classic"]');
      if (classicDot) classicDot.click();
      await sleep(150);
      return true;`,
  },
  {
    name: '标志：玻璃主题下顶栏也是吉祥物（不再是 AG 文字）',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const results = [];
      for (const theme of ['classic', 'tech', 'toon']) {
        const dot = document.querySelector('.skin[data-theme-id="' + theme + '"]');
        if (!dot) return '顶栏找不到主题色点：' + theme;
        dot.click();                          // 真实换肤
        await sleep(220);
        const box = document.querySelector('#logoBox');
        if (!box) return '找不到顶栏标志容器';
        /* 只认位图（img.mascot）。SVG 那套是"没有位图时的兜底图形"，不是品牌形象 ——
           第一版用例写成 img.mascot, svg.mascot，结果走了兜底也算通过，等于没测到东西。 */
        const img = box.querySelector('img.mascot');
        if (!img) return theme + ' 主题下顶栏没渲染吉祥物位图（走了 SVG 兜底或文字标）';
        const w = parseFloat(getComputedStyle(img).width);
        if (!(w > 0)) return theme + ' 主题下吉祥物位图宽度是 ' + w + '（图没显示出来）';
        if (!box.classList.contains('is-art')) return theme + ' 主题下标志缺少 is-art 类';
        if (theme !== 'toon' && getComputedStyle(box).boxShadow === 'none') {
          return theme + ' 主题下标志没有玻璃底座（box-shadow 为空）';
        }
        results.push(theme + ':' + Math.round(w));
      }
      const dot = document.querySelector('.skin[data-theme-id="classic"]');
      if (dot) { dot.click(); await sleep(150); }
      return results.length === 3 ? true : '只验证了 ' + results.length + ' 个主题';
    `,
  },
  {
    name: '设置页：页签切换真的切了分区',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const v = document.querySelector('[data-view="settings"]');
      if (!v) return '找不到「设置」页签';
      v.click();
      await sleep(120);
      const seg = document.querySelector('[data-sec="rules"]');
      if (!seg) return '设置页里找不到「评阅规则」';
      seg.click();
      await sleep(120);
      const sec = document.querySelector('#setsec-rules');
      if (!sec || sec.style.display === 'none') return '点了页签但对应分区没显示';
      const other = document.querySelector('#setsec-general');
      if (other && other.style.display !== 'none') return '切了页签但旧分区没收起（分区会重叠）';
      return true;
    `,
  },
  {
    name: '示例：真实点击「加载示例」后结果区渲染出维度',
    body: `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = document.querySelector('#btnDemo');
      if (!b) return '找不到「加载示例」按钮';
      b.click();
      await sleep(900);
      const dims = document.querySelectorAll('.dim').length;
      if (!dims) return '加载示例后没有渲染出任何维度';
      if (document.querySelector('#resultCard .empty')) return '结果区仍然是空状态';
      return true;
    `,
  },
];

/* ---------- 生成探针页 ---------- */
function buildProbeHtml() {
  const src = fs.readFileSync(INDEX, 'utf8');
  const casesJs = CASES.map((c, i) => `  [${JSON.stringify(c.name)}, async function () {\n${c.body}\n  }]`).join(',\n');
  const probe = `
<script>
(function () {
  var CASES = [
${casesJs}
  ];
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  window.addEventListener('load', function () {
    setTimeout(async function () {
      var out = [];
      for (var i = 0; i < CASES.length; i++) {
        var name = CASES[i][0], fn = CASES[i][1], r;
        try { r = await fn(); } catch (e) { r = 'EXC: ' + e.message; }
        out.push([name, r === true ? 'PASS' : 'FAIL', r === true ? '' : String(r)]);
      }
      document.title = 'UI-PROBE::' + JSON.stringify(out);
    }, 700);
  });
})();
</script>
`;
  return src.replace('</head>', probe + '</head>');
}

/* ---------- 跑一个用例集（一次浏览器启动跑完全部用例） ---------- */
function runProbe(chrome) {
  const html = buildProbeHtml();
  fs.writeFileSync(TMP_PAGE, html, 'utf8');
  const url = 'file:///' + TMP_PAGE.replace(/\\/g, '/');
  let out;
  try {
    out = execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--allow-file-access-from-files', '--window-size=1240,900',
      '--virtual-time-budget=20000', '--dump-dom', url,
    ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return { error: '浏览器启动或执行失败：' + (e.message || e) };
  } finally {
    try { fs.unlinkSync(TMP_PAGE); } catch (e) { /* 清理失败不影响结果 */ }
  }

  const m = out.match(/<title>UI-PROBE::([\s\S]*?)<\/title>/);
  if (!m) return { error: '探针没有回传结果（浏览器可能启动失败，或页面脚本报错中断了）' };
  const json = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  try { return { rows: JSON.parse(json) }; } catch (e) { return { error: '结果解析失败：' + e.message + ' :: ' + json.slice(0, 120) }; }
}

/* ---------- 主流程 ---------- */
const chrome = findChrome();
if (!chrome) {
  console.log('⚠️  没找到 Chrome / Edge，跳过 UI 回归。');
  console.log('   （想跑就设环境变量 CHROME 指向浏览器可执行文件；smoke.mjs 不受影响。）');
  process.exit(0);
}
if (!fs.existsSync(INDEX)) {
  console.error(DIST
    ? '✗ 找不到仓库根的 index.html，请先跑 build-single.py 打包'
    : '✗ 找不到 autograder/index.html，请在 autograder/ 目录下运行');
  process.exit(1);
}

console.log('UI 回归（真实浏览器 · 真实点击 · 真实渲染值）');
console.log('浏览器：' + chrome);
console.log('被测页面：' + (DIST ? '打包版（仓库根 index.html）' : '源码版（autograder/index.html）') + '\n');

const { rows, error } = runProbe(chrome);
if (error) {
  console.error('✗ ' + error);
  process.exit(1);
}

let failed = 0;
for (const [name, st, note] of rows) {
  if (st === 'PASS') {
    console.log('  ✅ ' + name);
  } else {
    failed++;
    console.log('  ❌ ' + name + '\n       ' + note);
  }
}
console.log('');
if (failed) {
  console.log(`UI 回归失败：${failed}/${rows.length} 项未通过`);
  process.exit(1);
}
console.log(`UI 回归全部通过（${rows.length} 项）`);
