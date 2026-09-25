/* AutoGrader · 轻量图表（纯 SVG 手写，零第三方依赖，可离线、可打印） */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ---------------- 主题调色板 ----------------
   * 图表颜色必须跟随页面主题：否则切到卡通主题（番茄红）或深空主题（暗底）时，
   * 一张蓝色的雷达图会像从别的网站上抠下来的。主题切换后由 app 重新渲染图表，
   * 所以这里按需实时取色即可；加 200ms 缓存是为了避免一次渲染里反复 getComputedStyle。
   */
  const FALLBACK = {
    brand: '#2563eb', violet: '#8b5cf6', muted: '#64748b', ink2: '#475569',
    red: '#dc2626', line: '#e2e8f0', dark: false,
  };
  let _palCache = null, _palTs = 0, _palTheme = '';
  function pal() {
    const now = Date.now();
    const themeNow = document.documentElement.getAttribute('data-theme') || '';
    // 缓存里带上主题 id：换肤后立即失效，不然刚切完主题画出来的还是上一套颜色
    if (_palCache && _palTheme === themeNow && now - _palTs < 200) return _palCache;
    const p = (AG.theme && AG.theme.palette) ? AG.theme.palette() : {};
    _palCache = Object.assign({}, FALLBACK, p);
    _palTs = now; _palTheme = themeNow;
    return _palCache;
  }
  function rgba(rgb, a) { return `rgba(${rgb},${a == null ? 1 : a})`; }
  function hexToRgba(hex, a) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6 && h.length !== 3) return hex;
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return rgba(`${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`, a);
  }
  const PAL = {
    brand: () => pal().brand,
    violet: () => pal().violet,
    muted: () => pal().muted,
    ink2: () => pal().ink2,
    red: () => pal().red,
    brandLight: (a) => hexToRgba(pal().brand, a == null ? 0.45 : a),
    brandA: (a) => hexToRgba(pal().brand, a),
    /* 网格线 / 轨道：深色主题下必须用白色半透明，否则灰线在暗底上直接消失 */
    grid: (a) => rgba(pal().dark ? '255,255,255' : '148,163,184', a == null ? 0.28 : a),
    track: (a) => rgba(pal().dark ? '255,255,255' : '148,163,184', a == null ? 0.16 : a),
    whisper: () => rgba(pal().dark ? '255,255,255' : '15,23,42', 0.03),
  };

  const NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    return e;
  }

  /** 雷达图：展示各维度得分率 */
  function radar(dims, opts) {
    opts = opts || {};
    const size = opts.size || 380;
    const cx = size / 2, cy = size / 2 + 6;
    const R = opts.radius || size * 0.32;
    const n = dims.length;
    if (n < 3) return svgEl('svg', { viewBox: `0 0 ${size} ${size}` });

    const svg = svgEl('svg', {
      viewBox: `0 0 ${size} ${size}`, class: 'chart-radar',
      style: `width:100%;height:auto;max-width:${size}px;display:block;margin:0 auto`,
    });

    const defs = svgEl('defs', {});
    const grad = svgEl('radialGradient', { id: 'radarGrad', cx: '50%', cy: '50%', r: '50%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': PAL.brand(), 'stop-opacity': '.45' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': PAL.violet(), 'stop-opacity': '.22' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    const pt = (i, r) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };

    // 网格
    [0.25, 0.5, 0.75, 1].forEach((lv) => {
      const pts = dims.map((_, i) => pt(i, R * lv).join(',')).join(' ');
      svg.appendChild(svgEl('polygon', {
        points: pts, fill: lv === 1 ? PAL.whisper() : 'none',
        stroke: PAL.grid(.28), 'stroke-width': 1,
      }));
    });
    // 轴线
    dims.forEach((_, i) => {
      const [x, y] = pt(i, R);
      svg.appendChild(svgEl('line', {
        x1: cx, y1: cy, x2: x, y2: y, stroke: PAL.grid(.25), 'stroke-width': 1,
      }));
    });

    // 数据多边形
    const dataPts = dims.map((d, i) => pt(i, R * U.clamp(d.ratio, 0.03, 1)));
    /* 数据面（多边形 + 顶点）装进一个 g：入场时整组从图心向外撑开。
       多边形和顶点必须一起缩放，只放大其中一个会出现"面先到、点后到"的错位。 */
    const grow = svgEl('g', { class: 'rgrow' });
    grow.appendChild(svgEl('polygon', {
      points: dataPts.map((p) => p.join(',')).join(' '),
      fill: 'url(#radarGrad)', stroke: PAL.brand(), 'stroke-width': 2, 'stroke-linejoin': 'round',
    }));
    dataPts.forEach(([x, y], i) => {
      const dot = svgEl('circle', { cx: x, cy: y, r: 3.5, fill: '#fff', stroke: PAL.brand(), 'stroke-width': 2 });
      dot.appendChild(svgEl('title', {})).textContent = `${dims[i].name} ${dims[i].score}/${dims[i].max}`;
      grow.appendChild(dot);
    });
    svg.appendChild(grow);

    // 轴标签
    dims.forEach((d, i) => {
      const [x, y] = pt(i, R + 26);
      const cos = Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n);
      const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
      const t = svgEl('text', {
        x: U.clamp(x, 8, size - 8), y: U.clamp(y, 12, size - 6),
        'text-anchor': anchor, 'font-size': 11.5, fill: PAL.muted(),
      });
      t.textContent = d.name.length > 7 ? d.name.slice(0, 7) + '…' : d.name;
      svg.appendChild(t);
      const v = svgEl('text', {
        x: U.clamp(x, 8, size - 8), y: U.clamp(y, 12, size - 6) + 14,
        'text-anchor': anchor, 'font-size': 11, fill: PAL.brand(), 'font-weight': 700,
      });
      v.textContent = `${d.score}/${d.max}`;
      svg.appendChild(v);
    });

    return svg;
  }

  /**
   * 半环仪表盘：展示总分。
   * 「评阅副驾驶」定位下，分数不再是单点，而是一个区间 [lo, hi]：
   * 深色实弧 = 区间下界（保底分），浅色延伸弧 = 区间上界（上限分），
   * 中间额外描一条刻度指向当前采用的分数。老师看到的是「这份报告大概在 68~74 之间」，
   * 而不是一个假装精确的 71.3。
   */
  function gauge(total, opts) {
    opts = opts || {};
    /* 高度按 0.78 而不是 0.62：圆心下方还要摆「等级 / 本档取值 / AI 原判」最多三行小字，
       而 SVG 默认 overflow:hidden，超出 viewBox 的部分会被直接裁掉 —— 之前那几行小字
       其实一直画在框外，所以怎么调颜色都看不清。这里把下方文字区实打实留出来。 */
    const w = opts.size || 260, h = (opts.size || 260) * 0.78;
    const cx = w / 2, cy = h * 0.75, r = w * 0.38;
    const range = opts.range;              // [lo, hi]，可能为 null
    const lo = range && range.length === 2 ? U.clamp(range[0], 0, 100) : total;
    const hi = range && range.length === 2 ? U.clamp(range[1], 0, 100) : total;
    const g = AG.rubric.gradeOf(total);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${w} ${h}`, class: 'chart-gauge',
      style: `width:100%;height:auto;max-width:${w}px;display:block;margin:0 auto`,
    });
    const arc = (from, to, color, width, opacity) => {
      const a0 = Math.PI * (1 - from), a1 = Math.PI * (1 - to);
      const x0 = cx + r * Math.cos(a0), y0 = cy - r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
      return svgEl('path', {
        d: `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`,
        fill: 'none', stroke: color, 'stroke-width': width || 14, 'stroke-linecap': 'round',
        opacity: opacity == null ? 1 : opacity,
      });
    };
    svg.appendChild(arc(0, 1, PAL.track(.18), 14));   // 轨道：常驻，不参与入场
    // 下面这两条弧入场时要从 0 一路画到得分位，先留个引用
    const sweeps = [];
    // 区间上限（浅）：先画浅的一层铺满到上界
    if (hi > lo) {
      const eHi = arc(0, U.clamp(hi / 100, 0.001, 1), g.color, 14, 0.3);
      svg.appendChild(eHi); sweeps.push({ el: eHi, v: hi });
    }
    // 区间下界（实）：保底分用实弧
    const eLo = arc(0, U.clamp(lo / 100, 0.001, 1), g.color, 14, 1);
    svg.appendChild(eLo); sweeps.push({ el: eLo, v: lo });

    const showRange = hi > lo;
    // 有区间时字号收一档，给「68–74」留出宽度
    const num = svgEl('text', {
      class: 'g-num',
      x: cx, y: cy - 22, 'text-anchor': 'middle',
      'font-size': showRange ? 36 : 44, 'font-weight': 800, fill: g.color,
    });
    num.textContent = showRange ? `${U.round(lo, 0)}–${U.round(hi, 0)}` : String(total);
    svg.appendChild(num);
    /* 等级行原本用 muted（52% 透明度），在浅色主题上灰得发虚；
       层级靠字号区分就够了（36 / 13 / 12.5），颜色统一提到 ink-2，先把可读性保住。 */
    const lab = svgEl('text', {
      x: cx, y: cy - 2, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 500, fill: PAL.ink2(),
    });
    // 踩在等级边界上时，两个等级名一起给出，避免"到底算 B 还是 C"的争议
    lab.textContent = opts.gradeStraddle
      ? `${opts.gradeStraddle} 级之间 · 区间跨等级边界`
      : `${g.grade} 级 · ${g.label}`;
    svg.appendChild(lab);
    const fades = [lab];
    /* 下面这两行小字共用一套排版：字号比原来大 1.5 号、颜色取 ink-2（比 muted 深一档），
       并且逐行往下错开 —— 之前它们都写在 cy+16 上，有区间又有终评时会整行叠在一起。 */
    const note = (y, str) => {
      const t = svgEl('text', {
        x: cx, y: y, 'text-anchor': 'middle', 'font-size': 12.5,
        'font-weight': 500, fill: PAL.ink2(),
      });
      t.textContent = str;
      svg.appendChild(t);
      fades.push(t);
    };
    if (showRange) note(cy + 21, `本档取值 ${total} 分 · 老师可在此区间内终评`);
    // 老师已经终评过：弧画的是老师的分，但 AI 的判断不能就此消失——
    // 把它压成一行小字留在下面，复核时才有对照物。
    if (opts.aiTotal != null && Number(opts.aiTotal) !== Number(total)) {
      note(showRange ? cy + 39 : cy + 21,
        `AI 原判 ${opts.aiTotal} 分` + (showRange ? `（区间 ${U.round(lo, 0)}–${U.round(hi, 0)}）` : ''));
    }
    /* 入场：弧从 0 画到得分位，数字在中心位原地放大出现（不再沿弧滚动）。
       终态在上面已经画好了，popIn 只是把初态盖上去再逐帧逼近。 */
    popIn(svg, {
      num: num, numX: cx, numY: cy - 22, numSize: showRange ? 36 : 44, text: num.textContent,
      fade: fades, arcs: sweeps,
      cx: cx, cy: cy, r: r, total: total, lo: lo, hi: hi, showRange: showRange,
    });
    return svg;
  }

  /**
   * 入场动效：弧从 0 一路画到得分位，数字在中心位「由中间放大」出现。
   *
   * 两个刻意的取舍：
   * 1) 数字不再沿弧滚动 —— 滚动时数字位数在变（0 → 68.4），宽度跟着跳，
   *    配合缩放会抖成一团；固定终值只做缩放，出现过程才干净。
   * 2) 缩放中心取数字的视觉中心（基线上方约 1/3 字高），不是基线本身。
   *    按基线缩放数字会先"趴"在下面再往上顶，看着像被顶起来，而不是从中心长出来。
   *
   * 终态在 gauge() 里已经写死，这里只是把初态盖上去再逐帧逼近，
   * 所以动画一旦不正常（老浏览器没有 rAF、冒烟测试的 DOM 桩上时间不推进、
   * 用户开了减弱动效），都只会停在静态终态，不会留下画了一半的弧或缩小的数字。
   */
  function popIn(svg, a) {
    try {
      const win = svg.ownerDocument && svg.ownerDocument.defaultView;
      if (!win || typeof win.requestAnimationFrame !== 'function') return;
      if (win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      const dur = 820;
      // 弧长 = r × 扫描角（整条半圆 = π）。解析算出来即可，
      // 不去调 getTotalLength —— 那个方法在冒烟测试的 DOM 桩上根本不存在。
      a.arcs.forEach((x) => {
        x.len = Math.max(1, (a.r * Math.PI * U.clamp(x.v, 0, 100)) / 100);
        x.el.setAttribute('stroke-dasharray', x.len);
        x.el.setAttribute('stroke-dashoffset', x.len);
      });
      const num = a.num;
      const oy = a.numY - (a.numSize || 44) * 0.34;
      // 用 SVG transform 属性而不是 CSS transform：不依赖 transform-box / transform-origin
      // 的浏览器支持差异，平移到原点再缩放再平移回去，等价于绕 (numX, oy) 缩放。
      const setScale = (s) => num.setAttribute('transform',
        `translate(${a.numX} ${oy}) scale(${s}) translate(${-a.numX} ${-oy})`);
      // easeOutBack：末尾轻微过冲再收回，数字像"弹"出来而不是匀速长出来
      const back = (p) => 1 + 1.8 * Math.pow(p - 1, 3) + 0.8 * Math.pow(p - 1, 2);
      setScale(0.35);
      num.setAttribute('opacity', 0);
      a.fade.forEach((el) => { if (el) el.setAttribute('opacity', 0); });

      let t0 = 0, frames = 0, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        a.arcs.forEach((x) => x.el.setAttribute('stroke-dashoffset', 0));
        num.removeAttribute('transform');
        num.setAttribute('opacity', 1);
        num.textContent = a.text;
        a.fade.forEach((el) => { if (el) el.setAttribute('opacity', 1); });
      };
      const step = (ts) => {
        if (done) return;
        // DOM 桩上 rAF 不推进时间：用帧数兜底，免得回调空转把测试挂死
        if (++frames > 90) { finish(); return; }
        const now = typeof ts === 'number' && isFinite(ts) ? ts : Date.now();
        const raw = U.clamp((now - t0) / dur, 0, 1);
        if (raw >= 1) { finish(); return; }
        const t = 1 - Math.pow(1 - raw, 3);   // 弧：ease-out，起步快、末尾稳稳落位
        a.arcs.forEach((x) => x.el.setAttribute('stroke-dashoffset', x.len * (1 - t)));
        // 数字比弧早一点到位：弧还在收尾时数字已经落定，视线先抓住分数再看弧
        const p = U.clamp(raw / 0.72, 0, 1);
        setScale(0.35 + 0.65 * back(p));
        num.setAttribute('opacity', U.clamp(p / 0.45, 0, 1));
        // 等级、区间说明这些小字等弧画到一半再淡入，不然一上来就糊在一起
        a.fade.forEach((el) => { if (el) el.setAttribute('opacity', U.clamp((t - 0.5) / 0.5, 0, 1)); });
        win.requestAnimationFrame(step);
      };
      win.requestAnimationFrame((ts) => {
        t0 = typeof ts === 'number' && isFinite(ts) ? ts : Date.now();
        step(t0);
      });
    } catch (e) { /* 装饰性动画：出任何岔子都保持静态终态 */ }
  }


  /**
   * Bootstrap 分布直方图 + 置信区间带
   * 目的：让教师一眼看出"这个分数是稳稳落在中间，还是恰好踩在分布的边缘"。
   * 直方图比单纯的 CI 数字更能暴露双峰、长尾等异常形态。
   */
  function bootstrapBand(bs, opts) {
    opts = opts || {};
    const w = opts.width || 620, h = opts.height || 210;
    const padL = 34, padR = 16, padT = 44, padB = 34;
    const iw = w - padL - padR, ih = h - padT - padB;

    const samples = (bs.samples || []).slice().sort((a, b) => a - b);
    if (!samples.length) return svgEl('svg', { viewBox: `0 0 ${w} ${h}` });

    // 横轴聚焦 95% 置信区间：少数"恰好删到关键章节导致暴跌"的极端样本会把整张图压扁，
    // 主体分布反而看不出来。区间外的样本单独计数并在标题中说明，不隐藏、不丢弃。
    const pLo = bs.ci ? bs.ci[0] : samples[Math.floor(samples.length * 0.025)];
    const pHi = bs.ci ? bs.ci[1] : samples[Math.floor(samples.length * 0.975)];
    const lo = Math.min(pLo, bs.point == null ? pLo : bs.point);
    const hi = Math.max(pHi, bs.point == null ? pHi : bs.point);
    const outside = samples.filter((v) => v < lo || v > hi).length;
    const span = Math.max(4, hi - lo);
    const dMin = lo - span * 0.10, dMax = hi + span * 0.10;
    const X = (v) => padL + ((v - dMin) / (dMax - dMin)) * iw;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${w} ${h}`,
      style: `width:100%;height:auto;max-width:${w}px;display:block`,
    });

    // 分箱（只统计显示范围内的样本）
    const bins = 16;
    const counts = new Array(bins).fill(0);
    samples.forEach((v) => {
      if (v < dMin || v > dMax) return;
      let b = Math.floor(((v - dMin) / (dMax - dMin)) * bins);
      b = Math.max(0, Math.min(bins - 1, b));
      counts[b]++;
    });
    const maxC = Math.max.apply(null, counts) || 1;

    // CI 带
    if (bs.ci) {
      svg.appendChild(svgEl('rect', {
        x: X(bs.ci[0]), y: padT, width: Math.max(1, X(bs.ci[1]) - X(bs.ci[0])), height: ih,
        fill: PAL.brandA(.10), rx: 4,
      }));
      [bs.ci[0], bs.ci[1]].forEach((v) => {
        svg.appendChild(svgEl('line', {
          x1: X(v), y1: padT - 4, x2: X(v), y2: padT + ih,
          stroke: PAL.brand(), 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: '.7',
        }));
      });
    }

    // 直方图
    const bw = iw / bins;
    counts.forEach((c, i) => {
      const bh = (c / maxC) * ih;
      if (bh <= 0) return;
      const rect = svgEl('rect', {
        x: padL + i * bw + 0.8, y: padT + ih - bh,
        width: Math.max(1, bw - 1.6), height: bh, rx: 2,
        fill: PAL.brandLight(.55), opacity: '.85',
      });
      rect.appendChild(svgEl('title', {})).textContent = `${(dMin + i * (dMax - dMin) / bins).toFixed(1)} ~ ${(dMin + (i + 1) * (dMax - dMin) / bins).toFixed(1)} 分：${c} 次`;
      svg.appendChild(rect);
    });

    // 原始分竖线（标签锚点随位置翻转，避免贴右边界时文字溢出）
    if (bs.point != null) {
      const px = X(bs.point);
      svg.appendChild(svgEl('line', {
        x1: px, y1: padT - 8, x2: px, y2: padT + ih,
        stroke: PAL.red(), 'stroke-width': 2,
      }));
      const nearRight = px > padL + iw * 0.62;
      const pt = svgEl('text', {
        x: nearRight ? px - 5 : px + 5, y: padT - 11,
        'text-anchor': nearRight ? 'end' : 'start',
        'font-size': 11, 'font-weight': 700, fill: PAL.red(),
      });
      pt.textContent = `实得 ${bs.point}`;
      svg.appendChild(pt);
    }

    // 基线
    svg.appendChild(svgEl('line', {
      x1: padL, y1: padT + ih, x2: padL + iw, y2: padT + ih,
      stroke: PAL.grid(.5), 'stroke-width': 1,
    }));

    // 刻度
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const v = dMin + ((dMax - dMin) * i) / ticks;
      const t = svgEl('text', { x: X(v), y: h - 12, 'text-anchor': 'middle', 'font-size': 10.5, fill: PAL.muted() });
      t.textContent = v.toFixed(0);
      svg.appendChild(t);
    }

    const cap = svgEl('text', { x: padL - 20, y: 15, 'font-size': 11, fill: PAL.muted() });
    cap.textContent = `${bs.methodLabel || '采样'} ${bs.iterations || samples.length} 次的得分分布 · 蓝带 = 95% 置信区间 · 红线 = 实得分`
      + (outside ? ` · 另有 ${outside} 次落在区间外` : '');
    svg.appendChild(cap);
    const sub = svgEl('text', { x: padL - 20, y: 30, 'font-size': 10.5, fill: PAL.muted() });
    sub.textContent = `横轴聚焦置信区间；分布越集中说明重复评阅越一致，出现双峰则意味着模型给分不稳定`;
    svg.appendChild(sub);

    return svg;
  }

  /**
   * 逐维度分歧条：以 A 引擎得分为基准，条形向 B 引擎得分方向延伸
   * 一眼看出"哪个维度两引擎吵得最凶"，这正是需要人工介入的地方。
   */
  function divergence(cmp, opts) {
    opts = opts || {};
    const rowH = 26, padL = 108, padR = 62;
    const w = opts.width || 620;
    const h = padL ? 22 + cmp.dims.length * rowH : 0;
    const barW = w - padL - padR;

    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, style: `width:100%;height:auto;max-width:${w}px;display:block` });

    cmp.dims.forEach((d, i) => {
      const y = 20 + i * rowH;
      const nm = svgEl('text', { x: padL - 8, y: y + 13, 'text-anchor': 'end', 'font-size': 11.5, fill: PAL.ink2() });
      nm.textContent = d.name.length > 7 ? d.name.slice(0, 7) + '…' : d.name;
      svg.appendChild(nm);

      // 底槽：该维度满分
      svg.appendChild(svgEl('rect', {
        x: padL, y: y + 3, width: barW, height: 13, rx: 6.5,
        fill: PAL.track(.14),
      }));

      const xa = padL + (d.scoreA / (d.max || 1)) * barW;
      const xb = padL + (d.scoreB / (d.max || 1)) * barW;
      const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);

      // A 的得分（实心条）
      svg.appendChild(svgEl('rect', {
        x: padL, y: y + 3, width: Math.max(2, xa - padL), height: 13, rx: 6.5,
        fill: PAL.brandA(.55),
      }));
      // 分歧区间
      if (x1 - x0 > 0.5) {
        svg.appendChild(svgEl('rect', {
          x: x0, y: y + 3, width: Math.max(1.5, x1 - x0), height: 13, rx: 3,
          fill: d.color, opacity: '.85',
        }));
      }
      // B 的位置标记
      svg.appendChild(svgEl('circle', { cx: xb, cy: y + 9.5, r: 3.2, fill: '#fff', stroke: d.color, 'stroke-width': 2 }));

      const lab = svgEl('text', { x: w - 6, y: y + 13, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600, fill: d.color });
      lab.textContent = `${d.scoreA} → ${d.scoreB}（${d.diff > 0 ? '+' : ''}${d.diff}）`;
      svg.appendChild(lab);
    });

    return svg;
  }

  /** 分量表对比条：默认量表 vs 诱导量表 的分值差异 */
  function rubricCompare(rows, opts) {
    opts = opts || {};
    const rowH = 30, padL = 116, padR = 40;
    const w = opts.width || 620;
    const h = 26 + rows.length * rowH;
    const barW = (w - padL - padR) / 2 - 10;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, style: `width:100%;height:auto;max-width:${w}px;display:block` });

    const maxV = Math.max.apply(null, rows.map((r) => Math.max(r.a || 0, r.b || 0)).concat([1]));

    rows.forEach((r, i) => {
      const y = 18 + i * rowH;
      const nm = svgEl('text', { x: padL - 8, y: y + 15, 'text-anchor': 'end', 'font-size': 11.5, fill: PAL.ink2() });
      nm.textContent = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
      svg.appendChild(nm);

      [['a', 0, PAL.muted()], ['b', 1, PAL.brand()]].forEach(([k, idx, color]) => {
        const v = r[k] || 0;
        const x = padL + idx * (barW + 20);
        svg.appendChild(svgEl('rect', { x, y: y + 4, width: barW, height: 12, rx: 6, fill: PAL.track(.14) }));
        if (v > 0) {
          svg.appendChild(svgEl('rect', { x, y: y + 4, width: Math.max(2, (v / maxV) * barW), height: 12, rx: 6, fill: color }));
        }
        const t = svgEl('text', { x: x + barW + 5, y: y + 14, 'font-size': 11, 'font-weight': 600, fill: idx ? color : PAL.muted() });
        t.textContent = v;
        svg.appendChild(t);
      });
    });

    const lg1 = svgEl('text', { x: padL, y: 12, 'font-size': 10.5, fill: PAL.muted() });
    lg1.textContent = '默认量表';
    svg.appendChild(lg1);
    const lg2 = svgEl('text', { x: padL + barW + 20, y: 12, 'font-size': 10.5, fill: PAL.brand() });
    lg2.textContent = '数据诱导';
    svg.appendChild(lg2);

    return svg;
  }

  AG.charts = { radar, gauge, bootstrapBand, divergence, rubricCompare };
})(window);
