/* AutoGrader · 吉祥物互动（Pet Mode）
 * 让一个「贴纸」变成一只「活的小评审员」：
 *   1. 看：指针走到哪，它的瞳仁跟到哪（瞳仁层盖在原图眼睛上，同色覆盖不穿帮）；
 *   2. 听：指针靠近时整个身体有轻微 3D 倾斜，像在探头看你；
 *   3. 活：每 2.6~5.8 秒随机眨一次眼（肤色眼皮从上方扫下）；
 *   4. 聊：点它一下会小跳一下，并冒一句评审员口吻的吐槽气泡。
 *
 * 实现约束（为什么长这样）：
 *   - 吉祥物是位图（mascots.js 内联 base64），瞳仁、眼皮都是绝对定位的 DOM 叠层，
 *     坐标用「相对位图的比例」常量，任何显示尺寸下都对齐；
 *   - 倾斜作用在 .pet 容器上，img 自带的 bob 浮动动画（transform 关键帧）不受影响；
 *   - 与 theme.js 的 liquidLight 同一套骨架：全局 pointermove + rAF 节流 + 元素级 CSS 变量；
 *   - 只在「动画卡通」主题出现 —— 其余主题的 logo 是文字标、空状态用通用图标，
 *     attachAll() 找不到 img.mascot 自然不生效；
 *   - prefers-reduced-motion 直接不启用。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ---- 全身位图（139×217）的眼睛参数 ----
   * 由 canvas 采样位图深色像素聚类实测（不是目测）：
   *   左眼深色带中心 (0.313, 0.4095) · 右眼 (0.7233, 0.3923) · 深色带半宽约占图宽 0.0971
   * 注意：深色带 = 上眼睑线 + 瞳仁的混合体。瞳仁层只盖「瞳仁实体」这一部分
   * （约深色带宽的 80%），并整体下移一点点 —— 让原画垂着的眼睑线和睫毛露出来，
   * 否则眼睛会被糊成一对圆睁大眼，表情就丢了。 */
  const EYES = [
    { x: 0.313, y: 0.418 },   /* 左眼（看图方向）*/
    { x: 0.7233, y: 0.401 },  /* 右眼 */
  ];
  const PUPIL_W = 15.6;   /* 瞳仁层直径：相对容器宽度 % */
  const PUPIL_H = 8.8;    /* 按 139:217 换算后再压扁一点（原图是半垂眼） */
  const LID_W = 27;       /* 眼皮要比眼睛整体大一圈（含柔化边），眨眼时能整个盖住 */
  const LID_H = 17;

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
        clearTimeout(pets[i].winkTimer);
        clearTimeout(pets[i].hopTimer);
        clearTimeout(pets[i].bubbleTimer);
        pets.splice(i, 1);
      }
    }
  }

  /**
   * 让所有吉祥物看向视口坐标 (x, y)：写入 --px/--py（整体倾斜方向）
   * 与 --dx/--dy（瞳仁偏移），剩下的交给 CSS。
   * 计算只跟「指针相对每只吉祥物中心的位置」有关，所以同一坐标喂给多个吉祥物，
   * 顶栏头像和空状态插画会各自看向自己的方向，不会串味。
   */
  function lookAt(x, y) {
    sweep();
    pets.forEach((p) => {
      const r = p.host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const nx = clamp((x - cx) / 240, -1, 1);
      const ny = clamp((y - cy) / 200, -1, 1);
      p.host.style.setProperty('--px', nx.toFixed(3));
      p.host.style.setProperty('--py', ny.toFixed(3));
      /* 瞳仁位移（px）：112px 高的空状态插画下 ±2.8px，约等于瞳仁宽度的 1/6，
         是眼珠自然转动的范围；顶栏 44px 头像按显示高度同比缩小，
         不然瞳仁会甩出眼眶 */
      const f = r.height / 112;
      p.host.style.setProperty('--dx', (nx * 2.8 * f).toFixed(2) + 'px');
      p.host.style.setProperty('--dy', (ny * 2.1 * f).toFixed(2) + 'px');
    });
  }

  function frame() {
    rafPending = false;
    lookAt(lastX, lastY);
  }

  /** 指针事件到帧之间做一次节流：rAF 优先，另有 setTimeout 兜底 ——
   *  标签页不可见时浏览器会暂停 rAF，只有 rAF 的话眼睛会"卡"在旧位置；
   *  兜底让状态始终跟得上（同一个 frame 是幂等的）。 */
  function queueFrame() {
    if (rafPending) return;
    rafPending = true;
    global.requestAnimationFrame(frame);
    global.setTimeout(frame, 120);
  }

  function buildLayers(pet) {
    EYES.forEach((e) => {
      const pup = U.el('div', { class: 'pet-pupil' });
      pup.style.left = (e.x * 100) + '%';
      pup.style.top = (e.y * 100) + '%';
      const lid = U.el('div', { class: 'pet-lid' });
      lid.style.left = (e.x * 100) + '%';
      lid.style.top = (e.y * 100) + '%';
      pet.host.appendChild(pup);
      pet.host.appendChild(lid);
    });
  }

  function scheduleWink(pet) {
    pet.winkTimer = global.setTimeout(() => {
      if (pet.host.isConnected && !reduced()) {
        pet.host.classList.add('wink');
        global.setTimeout(() => pet.host.classList.remove('wink'), 130);
      }
      scheduleWink(pet);
    }, 2600 + Math.random() * 3200);
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
    host.setAttribute('title', full ? '点我一下' : '');
    const pet = { host: host, full: !!full, bubble: null };
    pets.push(pet);
    host.addEventListener('click', () => hop(pet));
    if (pet.full) buildLayers(pet);
    scheduleWink(pet);
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

  /** 全局指针监听（只注册一次）。指针离开窗口时归零，吉祥物回正。 */
  function start() {
    if (started || reduced()) return;
    started = true;
    global.addEventListener('pointermove', (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      queueFrame();
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      lastX = -9999;
      lastY = -9999;
      pets.forEach((p) => {
        p.host.style.setProperty('--px', '0');
        p.host.style.setProperty('--py', '0');
        p.host.style.setProperty('--dx', '0px');
        p.host.style.setProperty('--dy', '0px');
      });
    });
    attachAll();
  }

  AG.pet = { start: start, attachAll: attachAll, lookAt: lookAt };
})(window);
