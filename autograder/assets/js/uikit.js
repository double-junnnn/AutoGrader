/* ============================================================================
 * uikit.js —— 通用交互套件（锚点路由 / 键盘漫游 / 焦点陷阱 / 实时播报）
 *
 * 为什么单独一个文件：
 *   这些能力要同时服务三个地方——顶部标签页、设置分区条、答疑抽屉。
 *   散在 app.js 里会让「谁负责键盘」变得模糊，抽出来只有一个约定：
 *   容器负责声明结构，uikit 负责把结构翻译成键盘行为。
 *
 * 与 smoke 测试桩的关系（重要）：
 *   桩上没有 closest / matches / getBoundingClientRect / scrollIntoView /
 *   document.activeElement。所以本文件里：
 *     - 从不使用 document.activeElement，改用事件里的 e.target；
 *     - closest 一律做存在性判断后再调；
 *     - scrollIntoView 只在用户点击/按键的回调内触发。
 *   模块加载期只做一件事：定义一个挂在 window.AG 上的对象。不碰 DOM。
 * ========================================================================== */
(function () {
  'use strict';

  const AG = window.AG || (window.AG = {});

  /* ---------------------------------------------------------------- 小工具 */

  // 桩环境里 querySelectorAll 返回的可能是数组而非 NodeList，统一转成真数组
  function list(root, sel) {
    if (!root || !root.querySelectorAll) return [];
    try { return Array.prototype.slice.call(root.querySelectorAll(sel)); } catch (e) { return []; }
  }

  /**
   * 解析「容器」参数：既接受 CSS 选择器（'#chatPanel'），也接受裸 id（'chatPanel'）
   * 或已拿到的元素。
   *
   * 为什么要容错：调用方写 trap('chatPanel') 是很自然的写法（那本来就是元素的 id），
   * 但 querySelector('chatPanel') 会被当成标签名去匹配，静默返回 null ——
   * 焦点陷阱就这么无声无息地失效了，页面上看不出任何异常。
   * 与其让每个调用方都记得带 #，不如在这里一次兜住。
   */
  function resolveEl(container) {
    if (!container) return null;
    if (typeof container !== 'string') return container;
    if (typeof document === 'undefined') return null;
    // 先按选择器解析；失败或没命中时，再按 id 兜一次。
    // 每一步都做能力判断：smoke 的 DOM 桩上这些方法未必都在。
    const tryCall = function (fnName, arg) {
      try {
        const fn = document[fnName];
        if (typeof fn !== 'function') return null;
        return fn.call(document, arg) || null;
      } catch (e) { return null; }
    };
    return tryCall('querySelector', container) || tryCall('getElementById', container);
  }

  function isFn(v) { return typeof v === 'function'; }

  /* ------------------------------------------------------ roving tabindex */

  /**
   * 把一组元素变成「单点停留」的键盘组：整组里只有一个 tabindex="0"，
   * 左右（或上下）箭头在组内移动，Tab 键整组只停一次。
   *
   * 这是 WAI-ARIA 对 tablist / toolbar 的标准做法。朴素地给每个按钮都留
   * tabindex 会让键盘用户按十几次 Tab 才穿得过一个标签栏。
   *
   * 注意：这里刻意只绑一个 keydown 在容器上（事件委托），
   * 因为容器的子元素经常被 innerHTML 整块重建，逐个绑会随重建失效。
   */
  function roving(container, itemSel, opts) {
    const box = resolveEl(container);
    if (!box) return;
    const o = opts || {};
    const vertical = o.orientation === 'vertical';
    const prevKeys = vertical ? ['ArrowUp'] : ['ArrowLeft'];
    const nextKeys = vertical ? ['ArrowDown'] : ['ArrowRight'];

    // 把组内元素的 tabindex 收敛成一个：当前项 0，其余 -1
    function sync(cur) {
      const items = list(box, itemSel);
      if (!items.length) return;
      const active = cur || items.find(function (el) { return el.getAttribute('aria-selected') === 'true'; }) || items[0];
      items.forEach(function (el) {
        el.tabIndex = el === active ? 0 : -1;
      });
    }

    box.addEventListener('keydown', function (e) {
      const items = list(box, itemSel);
      if (!items.length) return;
      // 用 e.target 定位当前项——桩上没有 document.activeElement
      let idx = items.indexOf(e.target);
      if (idx < 0) {
        // 事件来自组内更深层的元素时，向上找最近的合法项
        if (e.target && isFn(e.target.closest)) {
          const hit = e.target.closest(itemSel);
          if (hit) idx = items.indexOf(hit);
        }
      }
      if (idx < 0) return;

      let to = -1;
      if (prevKeys.indexOf(e.key) >= 0) to = (idx - 1 + items.length) % items.length;
      else if (nextKeys.indexOf(e.key) >= 0) to = (idx + 1) % items.length;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = items.length - 1;
      if (to < 0) return;

      e.preventDefault();
      sync(items[to]);
      if (isFn(items[to].focus)) items[to].focus();
      // 有的组同时要「选中」（tab 语义），有的只要求「聚焦」（toolbar 语义）
      if (o.activate && isFn(items[to].click)) items[to].click();
    });

    sync(null);
    return { sync: sync };
  }

  /* ------------------------------------------------------------ 焦点陷阱 */

  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const trapped = [];   // 栈式管理：后开的陷阱优先，关闭后自动回落到上一个

  /**
   * 把 Tab 键关进某个容器里。抽屉/弹窗打开时，Tab 绝不该跑到背后的页面上——
   * 那是键盘用户最容易「迷失」的场景：焦点在视觉上消失了，但页面还在响应。
   *
   * 监听挂在 document 而不是容器上：焦点一旦跑出容器，容器就再也收不到
   * 那个 keydown 了，兜底必须在更外层。挂 document 才能把「已经溜出去」的
   * 焦点拉回来。
   */
  function trap(container, on) {
    const box = resolveEl(container);
    if (!box) return;

    if (on === false) {
      const i = trapped.indexOf(box);
      if (i >= 0) trapped.splice(i, 1);
      return;
    }
    if (trapped.indexOf(box) >= 0) return;   // 已在栈里，别重复绑

    trapped.push(box);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      // 只处理最上层陷阱的按键，下层不去抢
      if (trapped[trapped.length - 1] !== box) return;

      // 计算样式在极老的环境可能没有，取不到就当作可见（宁可多拦，不要漏拦）
      const styleOf = function (el) {
        try {
          if (typeof getComputedStyle !== 'function') return null;
          return getComputedStyle(el);
        } catch (err) { return null; }
      };

      const boxCs = styleOf(box);
      if (boxCs && (boxCs.display === 'none' || boxCs.visibility === 'hidden')) return;

      const items = list(box, FOCUSABLE).filter(function (el) {
        // 不用 offsetParent 判可见：position:fixed 的元素 offsetParent 恒为 null，
        // 抽屉恰好就是 fixed，用它过滤会把整个抽屉的控件全滤掉。
        // 改判 display / visibility，这两项对 fixed 元素同样有效。
        const cs = styleOf(el);
        if (!cs) return true;
        return cs.display !== 'none' && cs.visibility !== 'hidden';
      });
      if (!items.length) { e.preventDefault(); return; }

      const first = items[0];
      const last = items[items.length - 1];
      const cur = e.target;
      // 焦点已经跑到容器外（或落在容器自身）：直接拽回第一个
      const inside = box.contains ? box.contains(cur) : true;
      if (!inside) { e.preventDefault(); if (isFn(first.focus)) first.focus(); return; }

      if (e.shiftKey) {
        if (cur === first || cur === box) { e.preventDefault(); if (isFn(last.focus)) last.focus(); }
      } else if (cur === last) {
        e.preventDefault(); if (isFn(first.focus)) first.focus();
      }
    });
  }

  function release(container) {
    trap(container, false);
  }

  /* --------------------------------------------------------- hash 路由 */

  /**
   * 地址栏路由：`#工作台` / `#成绩汇总` / `#设置/评阅规则/card-model`
   *
   * 用 hash 而不是 History API，是因为本产品要能从 file:// 直接双击打开——
   * file:// 下 pushState 会抛 SecurityError。hash 是唯一在本地也安全的选择，
   * 顺带白送了「刷新后还在原处」和「浏览器后退键」。
   */

  // 路由段名 → 内部视图名（地址栏里用中文更好认，内部仍用英文标识）
  const VIEW_TO_SLUG = { work: 'work', batch: 'batch', settings: 'settings' };
  const SLUG_TO_VIEW = { work: 'work', batch: 'batch', settings: 'settings' };

  /* 自写入计数。
   * 这是个很容易踩的坑：switchView 会写 hash，而写 hash 会触发 hashchange，
   * hashchange 又回头调 switchView —— 形成回环，而且回环里读到的
   * state.setSection 还是上一轮的值，会把刚设好的「卡片直达」路由冲掉。
   *
   * 为什么必须是「计数」：
   *   - 布尔标记撑不住：一次点击常连写两次 hash（先视图名、再分区+卡片），
   *     浏览器给每次写入各排一个 hashchange，标记只能吞掉第一个。
   *   - 比对 hash 值也撑不住：两个事件都在两次写入之后才派发，
   *     此时「最后写入值」已经被第二次写覆盖，第一个事件就对不上了。
   * 计数是唯一与时序无关的做法：写几次就欠几个事件，来一个销一个。 */
  let pendingSelf = 0;

  function writeHash(view, sec, card) {
    if (typeof location === 'undefined') return;
    const parts = [VIEW_TO_SLUG[view] || view];
    if (sec) parts.push(sec);
    if (card) parts.push(card);
    const next = '#' + parts.join('/');
    // 同值不写：既省一次无谓的历史记录，也避免 hashchange 空转
    if (location.hash === next) return;
    pendingSelf += 1;
    try { location.hash = next; } catch (e) { pendingSelf = Math.max(0, pendingSelf - 1); /* 极少见环境限制，静默 */ }
  }

  function readHash(raw) {
    const s = (typeof raw === 'string' ? raw : (typeof location !== 'undefined' ? location.hash : '')) || '';
    const body = s.charAt(0) === '#' ? s.slice(1) : s;
    if (!body) return null;
    let parts;
    try { parts = decodeURIComponent(body).split('/'); } catch (e) { parts = body.split('/'); }
    parts = parts.filter(function (p) { return !!p; });
    if (!parts.length) return null;
    return {
      view: SLUG_TO_VIEW[parts[0]] || parts[0],
      section: parts[1] || null,
      card: parts[2] || null,
    };
  }

  /* ------------------------------------------------------------ 初始装配 */

  function init(deps) {
    const d = deps || {};
    const switchView = d.switchView;
    const switchSettingsSection = d.switchSettingsSection;

    // 顶部标签页：左右箭头切视图
    roving('#tabs', '.tab', { orientation: 'horizontal', activate: true });

    // 设置分区条：同上
    roving('#setSeg', '.seg', { orientation: 'horizontal', activate: true });

    // 地址栏变化 → 切视图。用 hashchange 而不是自己记状态，
    // 这样浏览器前进/后退键也自然生效。
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('hashchange', function () {
        // 自己写 hash 引发的变化要放行，否则会和 switchView 形成回环。
        // 写几次就欠几个事件，来一个销一个——与时序无关。
        if (pendingSelf > 0) { pendingSelf -= 1; return; }
        // 后退到空 hash（首次进入前的那一档）要落回默认视图，
        // 不能因为「解析不出路由」就原地不动——那会让后退键看起来失灵。
        const h = readHash();
        if (!h) { if (isFn(switchView)) switchView('work'); return; }
        if (isFn(switchView)) switchView(h.view || 'work');
        if (h.view === 'settings' && h.section && isFn(switchSettingsSection)) {
          switchSettingsSection(h.card || h.section);
        }
      });
    }

    // 首次进入：如果地址栏带了路由就直接落上去，否则把当前视图写回地址栏
    const boot = readHash();
    if (boot) {
      if (isFn(switchView)) switchView(boot.view || 'work');
      if (boot.view === 'settings' && boot.section && isFn(switchSettingsSection)) {
        // 卡片定位要等 DOM 就位，推到下一帧
        requestAnimationFrame(function () {
          switchSettingsSection(boot.card || boot.section);
        });
      }
    }
  }

  /* --------------------------------------------------------- 屏幕阅读器播报 */

  /**
   * 往实时区域里塞一句话，供读屏软件播报。
   * 分数改了、批量完成了这类「画面变了但没有焦点转移」的变化，
   * 读屏用户是感知不到的——必须显式播报。
   */
  function announce(msg) {
    if (typeof document === 'undefined') return;
    let box = document.getElementById('srLive');
    if (!box) {
      box = document.createElement('div');
      box.id = 'srLive';
      // 视觉上不可见，但读屏可读（不能 display:none，那会连读屏一起藏掉）
      box.setAttribute('aria-live', 'polite');
      box.setAttribute('aria-atomic', 'true');
      box.className = 'sr-only';
      document.body.appendChild(box);
    }
    box.textContent = '';
    // 清空再写入，保证同一句话重复出现时也会重新播报
    setTimeout(function () { box.textContent = msg; }, 30);
  }

  AG.uikit = {
    init: init,
    roving: roving,
    trap: trap,
    release: release,
    writeHash: writeHash,
    readHash: readHash,
    announce: announce,
  };
})();
