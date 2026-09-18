/* AutoGrader · 吉祥物互动（Pet Mode）
 * 让一个「贴纸」变成一只「活的小评审员」，但**不碰眼睛**：
 *   1. 看：指针移动时整个身体有轻微 3D 倾斜，像在探头看你 —— 用整体姿态表达注意，
 *      而不是让眼珠在眼眶里滑；
 *   2. 聊：点它一下会小跳一下，并冒一句评审员口吻的吐槽气泡。
 *
 * 为什么不做眼珠跟随（试过，撤了）：
 *   位图的眼睛是画死的，要让眼珠动只能在眼睛位置上叠一层 DOM 瞳仁。但叠层一旦
 *   位移，边缘就会离开原画的眼睑轮廓 —— 看起来像「眼球凸出来」，很吓人。
 *   把叠层改成软边渐变、缩小尺寸、收敛位移，都只是减轻，无法根治：
 *   静态位图上做眼球转动，本质上是在破坏原画的眼睛形状。
 *   所以眼睛保持原样，注意感交给整体倾斜。
 *
 * 实现约定：
 *   - 倾斜作用在 .pet 容器上，img 自带的 bob 浮动动画（transform 关键帧）不受影响；
 *   - 与 theme.js 的 liquidLight 同一套骨架：全局 pointermove + rAF 节流（带 setTimeout
 *     兜底）+ 元素级 CSS 变量；
 *   - 只在「动画卡通」主题出现 —— 其余主题的 logo 是文字标、空状态用通用图标，
 *     attachAll() 找不到 img.mascot 自然不生效；
 *   - prefers-reduced-motion 直接不启用。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* 点它时随机冒出的评审员吐槽（人设：毒舌但公平）*/
  const LINES = [
    '别戳我，戳「开始评分」',
    '报告传上来，我来评',
    '我在核对参考文献格式',
    '数据表没来源，是要扣分的',
    '结论先行，别让我翻到结尾',
    '实验数据要可复现，懂吗',
    '图表编号对上原文了吗',
    '60 分过线，但我不推荐',
    '摘要不要写成流水账',
    '你的熊都看不下去了',
  ];

  const pets = [];
  let lastX = -9999;
  let lastY = -9999;
  let rafPending = false;
  let started = false;

  function reduced() {
    return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* 清理已从 DOM 摘除的 pet（renderLogo/renderResult 用 innerHTML 重建，
     旧 host 会被丢弃），顺手停掉它的定时器，别让循环空转 */
  function sweep() {
    for (let i = pets.length - 1; i >= 0; i--) {
      if (!pets[i].host.isConnected) {
        clearTimeout(pets[i].hopTimer);
        clearTimeout(pets[i].bubbleTimer);
        pets.splice(i, 1);
      }
    }
  }

  /**
   * 让所有吉祥物"看向"视口坐标 (x, y)：写入 --px/--py（-1~1），
   * CSS 据此做几度的 3D 倾斜。计算只跟「指针相对每只吉祥物中心的位置」有关，
   * 所以同一坐标喂给多个吉祥物，顶栏头像和空状态插画会各自看向自己的方向。
   */
  function lookAt(x, y) {
    sweep();
    pets.forEach((p) => {
      const r = p.host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      p.host.style.setProperty('--px', clamp((x - (r.left + r.width / 2)) / 240, -1, 1).toFixed(3));
      p.host.style.setProperty('--py', clamp((y - (r.top + r.height / 2)) / 200, -1, 1).toFixed(3));
    });
  }

  function frame() {
    rafPending = false;
    lookAt(lastX, lastY);
  }

  /** 指针事件到帧之间做一次节流：rAF 优先，另有 setTimeout 兜底 ——
   *  标签页不可见时浏览器会暂停 rAF，只有 rAF 的话姿态会"卡"在旧角度；
   *  兜底让状态始终跟得上（同一个 frame 是幂等的）。 */
  function queueFrame() {
    if (rafPending) return;
    rafPending = true;
    global.requestAnimationFrame(frame);
    global.setTimeout(frame, 120);
  }

  function hop(pet) {
    if (reduced()) return;
    pet.host.classList.add('hop');
    clearTimeout(pet.hopTimer);
    pet.hopTimer = global.setTimeout(() => pet.host.classList.remove('hop'), 210);
    if (!pet.full) return;  /* 顶栏头像太小，只跳不聊 */
    if (!pet.bubble) {
      pet.bubble = U.el('div', { class: 'pet-bubble', role: 'status' });
      pet.host.appendChild(pet.bubble);
    }
    pet.bubble.textContent = LINES[(Math.random() * LINES.length) | 0];
    pet.bubble.classList.add('show');
    clearTimeout(pet.bubbleTimer);
    pet.bubbleTimer = global.setTimeout(() => pet.bubble.classList.remove('show'), 1700);
  }

  function attach(host, full) {
    if (!host || reduced()) return;
    if (pets.some((p) => p.host === host)) return;
    host.classList.add('pet');
    if (full) host.setAttribute('title', '点我一下');
    const pet = { host: host, full: !!full, bubble: null };
    pets.push(pet);
    host.addEventListener('click', () => hop(pet));
  }

  /** 扫描当前页面上的吉祥物并挂上互动。renderLogo/renderResult 重建 DOM 后都要再调一次。 */
  function attachAll() {
    sweep();
    if (reduced()) return;
    const logo = U.$('#logoBox');
    if (logo && U.$('img.mascot', logo)) attach(logo, false);
    const ic = U.$('#resultCard .empty .ic');
    if (ic && U.$('img.mascot', ic)) attach(ic, true);
  }

  /** 全局指针监听（只注册一次）。指针离开窗口时归正。 */
  function start() {
    if (started || reduced()) return;
    started = true;
    global.addEventListener('pointermove', (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      queueFrame();
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      pets.forEach((p) => {
        p.host.style.setProperty('--px', '0');
        p.host.style.setProperty('--py', '0');
      });
    });
    attachAll();
  }

  AG.pet = { start: start, attachAll: attachAll, lookAt: lookAt };
})(window);
