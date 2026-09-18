/* AutoGrader · 主题引擎（Theme Engine）
 * 负责：主题应用 / 持久化 / 切换器渲染 / 吉祥物 / 给 PDF 导出提供配色 /
 *       玻璃主题的动态高光（liquidLight：高光斑随元素位置实时偏移）。
 *
 * 设计说明：
 *   1. 视觉全部走 CSS 变量，切换只改 <html data-theme>，无需重排 DOM。
 *   2. 吉祥物为「原创卡通小评审员」——画风借鉴美式动画（大头小身、粗描边、平涂高饱和、
 *      黄衫红领结），但形象本身为原创，不使用任何影视剧角色，避免版权风险。
 *      早期版本是手绘 SVG，现改为位图（见 mascots.js）；下面的 SVG 常量仅作图片加载失败时的兜底。
 *   3. 配色取自 Stewie（饺子）服装取色：内搭浅黄 #FFDD66 / 背带裤红 #E61928 /
 *      纽扣亮黄 #FFEE22 / 鞋子浅蓝 #87C8EE，底色为内搭长袖那个正黄 #FFDD66。
 *   4. 吉祥物只在「动画卡通」主题出现 —— 位图是暖色调的，压进 visionOS 玻璃的深蓝紫空间里
 *      会显得像贴纸。换主题时由 app.js 换成文字标与通用图标。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const THEMES = [
    { id: 'toon', name: '动画卡通', desc: '明黄底 · 平涂高饱和 · 饺子配色' },
    { id: 'classic', name: '浅玻璃', desc: 'visionOS · 白蓝渐变 · 浅底深字' },
    { id: 'tech', name: '深玻璃', desc: 'visionOS · 深蓝紫渐变 · 白字' },
  ];

  const DEFAULT_THEME = 'toon';

  /* ---------------- 吉祥物（原创） ----------------
   * 主体是 mascots.js 里的位图；下面两个 SVG 只在图片加载失败时兜底，
   * 正常情况下不会出现在界面上。
   */
  const M = AG.mascots || {};

  /* 头像版兜底 SVG */
  const MASCOT_HEAD_SVG =
    '<svg class="mascot" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="小评审员">' +
    '<path d="M31 13c-1.5-4 .5-6.5 3-8" fill="none" stroke="#1f1a17" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="13" cy="35" r="5.6" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.4"/>' +
    '<circle cx="59" cy="35" r="5.6" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.4"/>' +
    '<ellipse cx="36" cy="34" rx="22" ry="19" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.8"/>' +
    '<ellipse class="eye" cx="28" cy="33" rx="7" ry="8" fill="#fff" stroke="#1f1a17" stroke-width="2.2"/>' +
    '<ellipse class="eye" cx="45" cy="33" rx="7" ry="8" fill="#fff" stroke="#1f1a17" stroke-width="2.2"/>' +
    '<circle cx="29" cy="34.5" r="3.2" fill="#1f1a17"/>' +
    '<circle cx="46" cy="34.5" r="3.2" fill="#1f1a17"/>' +
    '<circle cx="30.5" cy="33" r="1.15" fill="#fff"/>' +
    '<circle cx="47.5" cy="33" r="1.15" fill="#fff"/>' +
    '<path d="M19.5 22.5q8-4.5 15.5-1.5" fill="none" stroke="#1f1a17" stroke-width="2.9" stroke-linecap="round"/>' +
    '<path d="M38.5 21q7.5-1.5 14 2.5" fill="none" stroke="#1f1a17" stroke-width="2.9" stroke-linecap="round"/>' +
    '<path d="M28.5 45q7.5 6 15.5-1.5" fill="none" stroke="#1f1a17" stroke-width="2.7" stroke-linecap="round"/>' +
    '</svg>';

  /* 全身版兜底 SVG：用于空状态插画 */
  const MASCOT_FULL_SVG =
    '<svg class="mascot bob" viewBox="0 0 96 116" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="小评审员">' +
    /* 身体：黄衫 */
    '<path d="M20 112c0-19 12-30 28-30s28 11 28 30z" fill="#ffdd66" stroke="#1f1a17" stroke-width="2.8" stroke-linejoin="round"/>' +
    /* 手臂 + 红笔 */
    '<path d="M62 92l18 12" stroke="#1f1a17" stroke-width="2.8" stroke-linecap="round" fill="none"/>' +
    '<path d="M76 100l14-16" stroke="#e61928" stroke-width="5.5" stroke-linecap="round" fill="none"/>' +
    '<path d="M89 82l3-4 4 3-3 4z" fill="#1f1a17"/>' +
    /* 领结 */
    '<path d="M48 82l-11-6v13z" fill="#e61928" stroke="#1f1a17" stroke-width="2.4" stroke-linejoin="round"/>' +
    '<path d="M48 82l11-6v13z" fill="#e61928" stroke="#1f1a17" stroke-width="2.4" stroke-linejoin="round"/>' +
    '<circle cx="48" cy="82.5" r="3" fill="#e61928" stroke="#1f1a17" stroke-width="2.2"/>' +
    /* 头 */
    '<path d="M41 12c-1.5-4.5 .5-7 3-8.5" fill="none" stroke="#1f1a17" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="21" cy="34" r="5.6" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.4"/>' +
    '<circle cx="75" cy="34" r="5.6" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.4"/>' +
    '<ellipse cx="48" cy="33" rx="26" ry="22" fill="#f6d2a9" stroke="#1f1a17" stroke-width="2.8"/>' +
    '<ellipse class="eye" cx="38" cy="32" rx="8" ry="9" fill="#fff" stroke="#1f1a17" stroke-width="2.2"/>' +
    '<ellipse class="eye" cx="58" cy="32" rx="8" ry="9" fill="#fff" stroke="#1f1a17" stroke-width="2.2"/>' +
    '<circle cx="39.5" cy="34" r="3.6" fill="#1f1a17"/>' +
    '<circle cx="59.5" cy="34" r="3.6" fill="#1f1a17"/>' +
    '<circle cx="41.2" cy="32.3" r="1.3" fill="#fff"/>' +
    '<circle cx="61.2" cy="32.3" r="1.3" fill="#fff"/>' +
    '<path d="M28 20q11-5.5 20-2" fill="none" stroke="#1f1a17" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M50 18.5q10-2 19 3.5" fill="none" stroke="#1f1a17" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M38 46q10 7 20-2" fill="none" stroke="#1f1a17" stroke-width="2.8" stroke-linecap="round"/>' +
    '</svg>';

  /* 正式使用的吉祥物标记：图片就绪用 <img>，否则退回上面的 SVG */
  /** 顶栏 logo / PDF 印章用的头像 */
  const MASCOT_HEAD = M.HEAD_SRC
    ? '<img class="mascot" src="' + M.HEAD_SRC + '" width="' + M.HEAD_W + '" height="' + M.HEAD_H +
      '" alt="小评审员" draggable="false">'
    : MASCOT_HEAD_SVG;

  /** 空状态插画用的全身像 */
  const MASCOT_FULL = M.FULL_SRC
    ? '<img class="mascot bob" src="' + M.FULL_SRC + '" width="' + M.FULL_W + '" height="' + M.FULL_H +
      '" alt="小评审员" draggable="false">'
    : MASCOT_FULL_SVG;

  /* ---------------- 主题读写 ---------------- */
  /** 校验主题 id：已下线或拼错的一律回落到默认主题
   *  （若用户此前选过后来被删掉的主题，localStorage 里可能残留旧 id） */
  function normalize(id) {
    return THEMES.some((x) => x.id === id) ? id : DEFAULT_THEME;
  }

  function get() {
    const t = normalize(U.store.get('theme', DEFAULT_THEME));
    // 无条件回写：即便存储里是已下线主题的残留值（或因解析失败读到默认值），也一并纠正，
    // 否则皮肤栏会出现"主题生效了但一个色点都不高亮"的错位。写入幂等，开销可忽略。
    U.store.set('theme', t);
    return t;
  }

  function apply(id) {
    const t = normalize(id);
    document.documentElement.setAttribute('data-theme', t);
    liquidLight(t === 'classic' || t === 'tech');
    if (t !== id) U.store.set('theme', t);
    return t;
  }

  function set(id) {
    const t = apply(id);
    U.store.set('theme', t);
    U.bus.emit('theme:change', t);
    return t;
  }

  /* ---------------- Liquid Glass 动态高光 ----------------
   * 苹果的高光不是画死的高光贴图，而是按「光源方向 + 玻璃表面法线」
   * 实时算出来的：控件挪个位置，光在它表面的落点也跟着挪。
   * 纯 CSS 模拟不了这一步，这里用一个极小的循环近似：
   *   1. 算每个玻璃元素中心相对视口中心的偏移：lx（-1 最左 → +1 最右）、
   *      ly（-1 最顶 → +1 最底）；
   *   2. 写进元素级变量，供 --glass-fill 的高光斑用 calc() 消费 ——
   *      光源固定在左上：元素越靠右，入射角越斜，高光斑越压向左缘；
   *      元素滚到视口下部，光越接近平射，高光斑越贴向顶缘。
   * 水平维靠左右布局生效，垂直维靠滚动生效 —— 滚动是页面里的主要运动。
   * 只在玻璃主题激活；rAF 节流（滚动一帧至多算一遍）；prefers-reduced-motion
   * 用户的系统本来就要求少动，直接不启用。卡通主题零监听零写入。
   */
  const LIQUID_SEL = '.topbar, .card, .modal, .chat-panel, .chat-input textarea, ' +
    '.kpi, .stat, .doclist li, .dropzone';
  let liquidOn = false;
  let liquidPending = false;

  function liquidFrame() {
    liquidPending = false;
    const w = global.innerWidth || 1;
    const h = global.innerHeight || 1;
    U.$$(LIQUID_SEL).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      el.style.setProperty('--lx', (((r.left + r.width / 2) / w) * 2 - 1).toFixed(3));
      el.style.setProperty('--ly', (((r.top + r.height / 2) / h) * 2 - 1).toFixed(3));
    });
  }

  function liquidQueue() {
    if (!liquidPending) {
      liquidPending = true;
      global.requestAnimationFrame(liquidFrame);
    }
  }

  /** 开/关动态高光。off 时撤掉监听并清掉元素上的变量，避免残留半套状态。 */
  function liquidLight(on) {
    const want = !!on && !global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (want && !liquidOn) {
      liquidOn = true;
      global.addEventListener('scroll', liquidQueue, { passive: true });
      global.addEventListener('resize', liquidQueue, { passive: true });
      liquidQueue();
    } else if (!want && liquidOn) {
      liquidOn = false;
      global.removeEventListener('scroll', liquidQueue);
      global.removeEventListener('resize', liquidQueue);
      U.$$(LIQUID_SEL).forEach((el) => {
        el.style.removeProperty('--lx');
        el.style.removeProperty('--ly');
      });
    }
  }

  /** 从 CSS 变量实时读取当前主题配色，供 Canvas（PDF/图表）使用。
   *  玻璃主题的 --panel / --surface 是半透 rgba：屏幕上要靠它透出弥散底色，
   *  但 Canvas 与 PDF 要的是实色（半透色打在白纸上会糊成灰），
   *  因此这里优先取同名的 -solid 版本，取不到再回落半透版。 */
  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (k, fb) => (cs.getPropertyValue(k) || '').trim() || fb;
    const solid = (k, fb) => v(k + '-solid', '') || v(k, fb);
    return {
      id: get(),
      bg: v('--bg', '#f5f7fb'),
      panel: solid('--panel', '#ffffff'),
      surface: solid('--surface', '#ffffff'),
      surface2: solid('--surface-2', '#f8fafc'),
      ink: v('--ink', '#0f172a'),
      ink2: v('--ink-2', '#334155'),
      muted: v('--muted', '#64748b'),
      line: v('--line', '#e2e8f0'),
      brand: v('--brand', '#2563eb'),
      brandSoft: v('--brand-soft', '#eff6ff'),
      cyan: v('--cyan', '#0891b2'),
      violet: v('--violet', '#7c3aed'),
      green: v('--green', '#16a34a'),
      amber: v('--amber', '#d97706'),
      red: v('--red', '#dc2626'),
      yellow: v('--yellow', '#ffdd66'),
      fontTitle: v('--font-title', '') || 'sans-serif',
      // 浅玻璃是浅底深字，只有深玻璃按深色画；PDF / 图表据此决定底色与文字色
      dark: document.documentElement.getAttribute('data-theme') === 'tech',
    };
  }

  /** 渲染皮肤切换器（顶栏或设置页通用） */
  function mountSkinBar(container, opts) {
    if (!container) return;
    opts = opts || {};
    container.innerHTML = '';
    THEMES.forEach((t) => {
      const b = U.el('button', {
        type: 'button',
        class: 'skin' + (get() === t.id ? ' on' : ''),
        'data-theme-id': t.id,
        title: t.desc,
      }, [
        U.el('span', { class: 'swatch' }, [U.el('i', { class: 'sw-' + t.id })]),
        document.createTextNode(opts.compact ? '' : t.name),
      ]);
      b.addEventListener('click', () => {
        set(t.id);
        U.$$('.skin', container).forEach((x) => x.classList.toggle('on', x.dataset.themeId === t.id));
        U.$$('.skin').forEach((x) => x.classList.toggle('on', x.dataset.themeId === t.id));
        if (opts.onChange) opts.onChange(t.id);
      });
      container.appendChild(b);
    });
  }

  AG.theme = {
    THEMES, DEFAULT_THEME,
    MASCOT_HEAD, MASCOT_FULL,
    /* 位图吉祥物是否可用（主题判断用，见 app.js 的 setupAppearance） */
    HAS_MASCOT: !!M.HEAD_SRC,
    get, set, apply, palette, mountSkinBar, liquidLight,
  };
})(window);
