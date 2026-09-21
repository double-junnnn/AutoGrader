/* AutoGrader · 零依赖 PDF 评阅报告导出
 *
 * 为什么不用 jsPDF / pdfmake / html2canvas：
 *   1) PDF 要原生渲染中文，必须嵌入 CJK 字体（子集化后仍动辄数 MB），或依赖在线字体服务；
 *   2) 本项目对外承诺「零第三方依赖 + 完全离线可用」，任何 CDN 方案在断网时都会失效。
 *
 * 采用方案：Canvas 按 A4 版心手工排版（系统字体直接渲染中文，无需嵌字体）
 *          → 逐页导出 JPEG → 按 PDF 1.4 规范手工封装字节流（DCTDecode 直嵌）。
 * 已知代价：PDF 内文字不可选中、不可检索（以阅读为主的评阅报告可接受）；
 *          页面本质是 150dpi 位图，放大到 300% 以上会略糊。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  /* ---------------- 版面常量 ---------------- */
  const PW = 794;      // A4 宽（CSS px @96dpi）
  const PH = 1123;     // A4 高
  const PT_W = 595.28; // A4 宽（pt，写入 PDF 用）
  const PT_H = 841.89;
  const SCALE = 1.6;   // 渲染倍率 ≈150dpi；再高体积增长快，收益有限
  const M = 54;        // 页边距
  const CW = PW - M * 2;
  const FOOT = 30;     // 页脚预留高度

  /* 与界面同一套字体栈：Inter 优先（装了就好看），中文退回苹方 / 鸿蒙 / 思源 / 雅黑 */
  const FONT = '"Inter","PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Noto Sans CJK SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  const MONO = '"JetBrains Mono","Cascadia Code","Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace';

  /* 打印友好基线：浅底深字、省墨、纸质归档安全 */
  const C_PRINT = {
    page: '#ffffff', ink: '#0a1020', body: '#2b3550', sub: '#4e597a', faint: '#94a3b8',
    line: '#e2e8f0', line2: '#cbd5e1', wash: '#f6f8fb', brand: '#2563eb', brandSoft: '#eff6ff',
    amber: '#b45309', red: '#b91c1c', green: '#15803d', amberSoft: '#fffbeb',
    dark: false, toon: false,
  };
  /* 当前生效配色。默认跟随界面主题（用户可选），打开「打印友好」开关则锁定浅色基线。 */
  let C = Object.assign({}, C_PRINT);

  function applyPalette() {
    if (!AG.theme || U.store.get('printFriendly', false)) {
      C = Object.assign({}, C_PRINT);
      return C;
    }
    const p = AG.theme.palette();
    C = {
      page: p.surface,
      ink: p.ink, body: p.ink2, sub: p.muted, faint: p.muted,
      line: p.line, line2: p.line, wash: p.surface2,
      brand: p.brand, brandSoft: p.brandSoft,
      amber: p.amber, red: p.red, green: p.green || C_PRINT.green, amberSoft: p.warnSoft || C_PRINT.amberSoft,
      dark: !!p.dark, toon: p.id === 'toon',
    };
    return C;
  }

  /** 分隔线/斑马纹等"发丝级"灰：深浅主题都要能看见，故按主题取黑白半透明 */
  function hair(a) {
    return `rgba(${C.dark ? '255,255,255' : '15,23,42'},${a})`;
  }

  /* ---------------- 工具 ---------------- */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** 中英混排断行：中文逐字断，英文/数字按词断 */
  function wrapText(ctx, text, maxW) {
    const out = [];
    String(text == null ? '' : text).split('\n').forEach((para) => {
      const t = para.replace(/\s+$/, '');
      if (!t) { out.push(''); return; }
      const tokens = t.match(/[A-Za-z0-9_\-./@:%+]+|\s+|[\s\S]/g) || [];
      let line = '';
      tokens.forEach((tk) => {
        const next = line + tk;
        if (line && ctx.measureText(next).width > maxW) {
          out.push(line.replace(/\s+$/, ''));
          line = /^\s+$/.test(tk) ? '' : tk;
        } else {
          line = next;
        }
      });
      if (line) out.push(line.replace(/\s+$/, ''));
    });
    return out;
  }

  /** 按亮度给达成率配色 */
  function ratioColor(p) {
    if (p >= 0.85) return '#16a34a';
    if (p >= 0.7) return '#0ea5e9';
    if (p >= 0.55) return '#f59e0b';
    return '#dc2626';
  }

  /**
   * 证据片段直接取自原文，会带上 Markdown 标记与转义符（## 标题、```围栏、| 表格线、字面 \n）。
   * 这些符号在文本里无所谓，印到报告上很脏，这里统一清掉。
   */
  function cleanSnippet(s) {
    const t = String(s == null ? '' : s)
      .replace(/\\n|\\t/g, ' ')
      .replace(/```[a-zA-Z]*/g, ' ')
      .replace(/#{1,6}/g, ' ')
      .replace(/[`*|]/g, ' ')
      .replace(/\\+/g, '')
      .replace(/…+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // 片段由上下文窗口截取，首尾边界天然参差，掐掉残留的引号与孤立标点
    return t
      .replace(/^["'“”‘’\-\s,，、.。:：；;]+/, '')
      .replace(/["'“”‘’\-\s,，、.。:：；;]+$/, '')
      .trim();
  }

  function shade(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  /* ---------------- 排版器 ---------------- */
  function Builder() {
    this.pages = [];
    this.y = M;
    this.addPage();
  }

  Builder.prototype.addPage = function () {
    const cv = document.createElement('canvas');
    cv.width = Math.round(PW * SCALE);
    cv.height = Math.round(PH * SCALE);
    const ctx = cv.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.textBaseline = 'alphabetic';
    // 白底：JPEG 不支持透明，不铺底色会变黑
    ctx.fillStyle = C.page;   // JPEG 不支持透明，不铺底色会变黑
    ctx.fillRect(0, 0, PW, PH);
    this.cur = { cv, ctx };
    this.pages.push(this.cur);
    this.y = M;
    return this.cur;
  };

  Builder.prototype.ctx = function () { return this.cur.ctx; };
  Builder.prototype.bottom = function () { return PH - M - FOOT; };

  /** 剩余空间不足 h 则翻页 */
  Builder.prototype.ensure = function (h) {
    if (this.y + h > this.bottom()) this.addPage();
    return this;
  };

  /**
   * 绘制一段文字。返回实际占用高度。
   * opts: {size, lh, weight, color, indent, mono, align}
   */
  Builder.prototype.text = function (str, opts) {
    opts = opts || {};
    const size = opts.size || 12.5;
    const lh = opts.lh || Math.round(size * 1.62);
    const weight = opts.weight || 400;
    const color = opts.color || C.body;
    const indent = opts.indent || 0;
    const maxW = CW - indent;
    const x = M + indent;
    const start = this.y;
    const ctx = this.ctx();
    ctx.font = `${weight} ${size}px ${opts.mono ? MONO : FONT}`;
    wrapText(ctx, str, maxW).forEach((ln) => {
      this.ensure(lh);
      const c = this.ctx();
      c.font = `${weight} ${size}px ${opts.mono ? MONO : FONT}`;
      c.fillStyle = color;
      c.fillText(ln, x, this.y + size * 0.84);
      this.y += lh;
    });
    return this.y - start;
  };

  /** 纯测量，不绘制 */
  Builder.prototype.measure = function (str, opts) {
    opts = opts || {};
    const size = opts.size || 12.5;
    const lh = opts.lh || Math.round(size * 1.62);
    const ctx = this.ctx();
    ctx.font = `${opts.weight || 400} ${size}px ${opts.mono ? MONO : FONT}`;
    return wrapText(ctx, str, CW - (opts.indent || 0)).length * lh;
  };

  Builder.prototype.gap = function (h) { this.y += h; return this; };

  Builder.prototype.rule = function (color) {
    this.ensure(10);
    const ctx = this.ctx();
    ctx.strokeStyle = color || C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, this.y + 0.5);
    ctx.lineTo(M + CW, this.y + 0.5);
    ctx.stroke();
    this.y += 1;
    return this;
  };

  /** 带底色/边框的块，回调内可自由绘制（块内自动不翻页） */
  Builder.prototype.panel = function (h, draw, opts) {
    opts = opts || {};
    this.ensure(h + (opts.gapAfter == null ? 14 : opts.gapAfter));
    const top = this.y;
    const ctx = this.ctx();
    roundRect(ctx, M, top, CW, h, opts.radius == null ? 10 : opts.radius);
    ctx.fillStyle = opts.bg || C.wash;
    ctx.fill();
    if (opts.border) {
      ctx.strokeStyle = opts.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    draw(ctx, top, h);
    this.y = top + h + (opts.gapAfter == null ? 14 : opts.gapAfter);
    return this;
  };

  /** 横向进度条 */
  function drawBar(ctx, x, y, w, h, p, color) {
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = hair(0.14);
    ctx.fill();
    const fw = Math.max(h, w * U.clamp(p, 0, 1));
    roundRect(ctx, x, y, fw, h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* ---------------- 报告内容 ---------------- */
  /**
   * 页眉右上角的小评审员印章。
   *
   * 优先用 mascots.js 里预加载好的位图 —— app.js 在 init 时就把它解码成 Image 了，
   * 所以这里是同步绘制，不会打断导出流程；图片万一没就绪就退回下面的手绘版。
   *
   * 位图必须走 base64 data URL 内联：file:// 下 Canvas 加载本地图片会被判为跨源，
   * 画布随即「被污染」，之后 toDataURL 抛安全错误、整个导出报废。
   * data URL 属同源，不污染画布 —— 这与手绘版当年踩的坑是同一件事的两面。
   */
  function drawMascot(ctx, cx, cy, r) {
    const img = AG.mascots && AG.mascots.ready && AG.mascots.ready.head;
    if (img && img.complete && img.naturalWidth) {
      const h = r * 2.12;
      const w = h * (img.naturalWidth / img.naturalHeight);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.1, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
      return;
    }
    drawMascotFallback(ctx, cx, cy, r);
  }

  /**
   * 手绘兜底版。当年就是因为「SVG 转 data URL 再 drawImage 会污染画布」才手写的；
   * 位图接入后它退居二线，只在图片尚未解码完成时顶一下。
   */
  function drawMascotFallback(ctx, cx, cy, r) {
    ctx.save();
    ctx.strokeStyle = '#1f1a17';
    ctx.lineWidth = Math.max(1.1, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.88, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#f6d2a9'; ctx.fill(); ctx.stroke();
    [-1, 1].forEach((s) => {
      ctx.beginPath();
      ctx.ellipse(cx + s * r * 0.36, cy - r * 0.06, r * 0.28, r * 0.33, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + s * r * 0.38, cy - r * 0.02, r * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = '#1f1a17'; ctx.fill();
    });
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.6, cy - r * 0.44);
    ctx.quadraticCurveTo(cx - r * 0.34, cy - r * 0.6, cx - r * 0.06, cy - r * 0.48);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.12, cy - r * 0.5);
    ctx.quadraticCurveTo(cx + r * 0.4, cy - r * 0.42, cx + r * 0.62, cy - r * 0.36);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.3, cy + r * 0.36);
    ctx.quadraticCurveTo(cx + r * 0.02, cy + r * 0.62, cx + r * 0.34, cy + r * 0.34);
    ctx.stroke();
    ctx.restore();
  }

  function drawHead(b, doc, r) {
    const ctx = b.ctx();
    // 卡通主题下盖一个原创吉祥物印章，呼应界面画风
    if (C.toon) drawMascot(ctx, M + CW - 17, b.y + 13, 13);
    // 品牌条
    ctx.fillStyle = C.brand;
    roundRect(ctx, M, b.y, 4, 17, 2);
    ctx.fill();
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = C.brand;
    ctx.fillText('AutoGrader · 实验报告自动评阅', M + 13, b.y + 12.5);
    b.y += 26;

    b.text(doc.name, { size: 20, weight: 700, color: C.ink, lh: 28 });
    b.gap(4);

    const meta = [
      `评阅引擎：${r.engineLabel || '模型引擎'}`,
      `评阅时间：${U.fmtTime(r.gradedAt)}`,
      `篇幅：${r.features.words} 字 · 代码块 ${r.features.codeBlockCount} 个 · 图表引用 ${r.features.figureCount + r.features.tableCount} 处 · 数据点 ${r.features.numberCount} 个`,
    ].join('\n');
    b.text(meta, { size: 11, color: C.sub, lh: 18 });
    b.gap(10);
    b.rule();
    b.gap(12);
  }

  /**
   * 成绩面板。
   * 「评阅副驾驶」定位下，这里给出的是**建议得分区间**而不是一个孤零零的分数：
   * 左侧大字显示区间（如 68–74），右侧给出本档取值与等级，并说明区间是否跨等级。
   * 老师拿这份 PDF 直接就能在区间内定分，不必反过来猜模型为什么给 71.3。
   */
  function drawScore(b, r) {
    const p = r.total / 100;
    const color = r.gradeColor || ratioColor(p);
    const hasRange = Array.isArray(r.range) && r.range.length === 2 && r.range[1] > r.range[0];
    b.panel(hasRange ? 108 : 92, (ctx, top) => {
      // 左侧：区间（有）或总分（无）
      const bigTxt = hasRange ? `${r.range[0]}–${r.range[1]}` : String(r.total);
      ctx.font = `700 ${hasRange ? 38 : 44}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(bigTxt, M + 24, top + 60);
      const wScore = ctx.measureText(bigTxt).width;
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = C.sub;
      ctx.fillText('/ 100', M + 24 + wScore + 7, top + 60);

      ctx.font = `600 13px ${FONT}`;
      ctx.fillStyle = C.faint;
      ctx.fillText(hasRange ? '建议得分区间' : '综合得分', M + 24, top + 79);

      // 右侧：等级 + 达成分条
      const rx = M + 210;
      const rw = CW - 210 - 24;
      ctx.font = `700 22px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(`${r.grade} 级`, rx, top + 40);
      const wGrade = ctx.measureText(`${r.grade} 级`).width;
      ctx.font = `500 14px ${FONT}`;
      ctx.fillStyle = C.body;
      ctx.fillText(r.gradeLabel, rx + wGrade + 8, top + 40);

      drawBar(ctx, rx, top + 54, rw, 10, p, color);
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = C.sub;
      ctx.fillText(`达成率 ${Math.round(p * 100)}%`, rx, top + 78);

      if (hasRange) {
        ctx.font = `500 11px ${FONT}`;
        ctx.fillStyle = C.faint;
        const note = r.straddles
          ? `本档取值 ${r.total} 分 · 区间横跨 ${r.gradeStraddle || ''} 两个等级，最终等级由教师裁定`
          : `本档取值 ${r.total} 分 · 教师可在区间内终评`;
        ctx.fillText(note, M + 24, top + 99);
      }
    });
  }

  function drawOverall(b, r) {
    if (!r.overall) return;
    b.text('总体评语', { size: 13.5, weight: 700, color: C.ink, lh: 24 });
    b.gap(4);
    b.text(r.overall, { size: 12.5, lh: 21, color: C.body });
    b.gap(16);
  }

  function drawDimTable(b, dims) {
    const rowH = 30;
    const headH = 26;
    b.ensure(headH + rowH * 2);
    b.text('分项得分', { size: 13.5, weight: 700, color: C.ink, lh: 24 });
    b.gap(6);

    const wName = 178, wLevel = 96, wScore = 84, wBar = CW - wName - wLevel - wScore - 16;
    const ctx0 = b.ctx();

    // 表头
    b.ensure(headH);
    let ctx = b.ctx();
    ctx.fillStyle = C.brandSoft;
    roundRect(ctx, M, b.y, CW, headH, 6);
    ctx.fill();
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = C.sub;
    ctx.fillText('评分维度', M + 12, b.y + 17);
    ctx.fillText('档位', M + wName + 12, b.y + 17);
    ctx.fillText('得分', M + wName + wLevel + 12, b.y + 17);
    ctx.fillText('达成率', M + wName + wLevel + wScore + 12, b.y + 17);
    b.y += headH;

    dims.forEach((d, i) => {
      b.ensure(rowH);
      const c = b.ctx();
      const top = b.y;
      if (i % 2 === 1) {
        c.fillStyle = hair(0.05);
        c.fillRect(M, top, CW, rowH);
      }
      c.strokeStyle = C.line;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(M, top + rowH + 0.5);
      c.lineTo(M + CW, top + rowH + 0.5);
      c.stroke();

      c.font = `500 12px ${FONT}`;
      c.fillStyle = C.ink;
      const nm = wrapText(c, d.name, wName - 16)[0] || '';
      c.fillText(nm, M + 12, top + 20);

      // 档位列：档位号 + 档名（+ 跨档校正标记），让老师不必读评语就知道扣分落在哪一档
      if (d.level) {
        c.font = `600 11px ${FONT}`;
        c.fillStyle = d.crossBand ? C.red : C.body;
        c.fillText(`${d.level}档 ${d.levelName || ''}`, M + wName + 12, top + 20);
      } else {
        c.font = `400 11px ${FONT}`;
        c.fillStyle = C.faint;
        c.fillText('—', M + wName + 12, top + 20);
      }

      c.font = `600 12px ${FONT}`;
      c.fillStyle = C.body;
      c.fillText(`${d.score}`, M + wName + wLevel + 12, top + 20);
      const wS = c.measureText(`${d.score}`).width;
      c.font = `400 11px ${FONT}`;
      c.fillStyle = C.faint;
      c.fillText(`/ ${d.max}`, M + wName + wLevel + 12 + wS + 3, top + 20);

      const p = U.clamp(d.ratio, 0, 1);
      const bx = M + wName + wLevel + wScore + 12;
      drawBar(c, bx, top + 11, wBar * 0.72, 8, p, ratioColor(p));
      c.font = `500 11px ${FONT}`;
      c.fillStyle = C.sub;
      c.fillText(`${Math.round(p * 100)}%`, bx + wBar * 0.72 + 8, top + 20);

      b.y += rowH;
    });
    b.gap(18);
  }

  function drawDetails(b, dims) {
    b.ensure(60);
    b.text('逐项核查明细', { size: 13.5, weight: 700, color: C.ink, lh: 24 });
    b.gap(8);

    dims.forEach((d, i) => {
      const p = U.clamp(d.ratio, 0, 1);
      const color = ratioColor(p);

      // 维度标题 + 分数（整块不跨页，避免标题与内容分离）
      const headH = 30;
      const bodyEst = estimateDetailHeight(b, d);
      b.ensure(headH + Math.min(bodyEst, 120));

      let ctx = b.ctx();
      const top = b.y;
      ctx.fillStyle = shade(color, 0.1);
      roundRect(ctx, M, top, CW, headH, 7);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, M, top, 4, headH, 2);
      ctx.fill();

      ctx.font = `600 12.5px ${FONT}`;
      ctx.fillStyle = C.ink;
      const nameTxt = wrapText(ctx, d.name, CW - 230)[0] || '';
      const wName = ctx.measureText(nameTxt).width;
      ctx.fillText(nameTxt, M + 14, top + 20);

      // 档位徽标：紧挨维度名，把「落在哪一档」写在标题栏上
      if (d.level) {
        const lvTxt = `${d.level}档 · ${d.levelName || ''}`;
        const crossTxt = d.crossBand ? '跨档已校正' : '';
        ctx.font = `600 10.5px ${FONT}`;
        const lvW = ctx.measureText(lvTxt).width + 12;
        const crossW = crossTxt ? ctx.measureText(crossTxt).width + 8 : 0;
        const lvX = M + 14 + wName + 10;
        // 徽标底板
        ctx.fillStyle = hair(0.09);
        roundRect(ctx, lvX, top + 8, lvW + crossW, 15, 4);
        ctx.fill();
        ctx.fillStyle = d.crossBand ? C.red : C.sub;
        ctx.fillText(lvTxt, lvX + 6, top + 19);
        if (crossTxt) ctx.fillText(crossTxt, lvX + lvW, top + 19);
      }

      ctx.font = `600 12.5px ${FONT}`;
      ctx.fillStyle = color;
      const scoreTxt = `${d.score} / ${d.max}`;
      ctx.fillText(scoreTxt, M + CW - 14 - ctx.measureText(scoreTxt).width, top + 20);
      b.y = top + headH + 8;

      // 定档理由：一句话说明为什么落在这一档，PDF 上也能看懂扣分逻辑
      if (d.levelReason) {
        b.text('定档理由：' + d.levelReason, { size: 11.5, color: C.body, lh: 19 });
      }

      // 判定依据 · 报告原文：强制引用，老师可逐条回原文核对
      const cites = (d.citations || []).filter((c) => c && c.quote);
      if (cites.length) {
        b.text(`判定依据 · 报告原文（${cites.length} 处）`, { size: 11, weight: 600, color: C.sub, lh: 18 });
        cites.slice(0, 4).forEach((c) => {
          const raw = cleanSnippet(c.quote);
          if (!raw) return;
          const clipped = raw.length > 170 ? raw.slice(0, 170) + '…' : raw;
          const q = '“' + clipped + '”' + (c.where ? `（${c.where}）` : '');
          const qh = b.measure(q, { size: 10.5, lh: 17, indent: 22 });
          b.ensure(qh + 6);
          const c2 = b.ctx();
          c2.fillStyle = hair(0.06);
          roundRect(c2, M + 16, b.y - 2, CW - 20, qh + 4, 4);
          c2.fill();
          c2.fillStyle = C.brand;
          c2.fillRect(M + 16, b.y - 2, 2.5, qh + 4);
          b.text(q, { size: 10.5, color: C.sub, lh: 17, indent: 22 });
        });
        b.gap(3);
      } else {
        // 没给原文引用 = 扣分理由不可核对，明确标注出来，而不是悄悄省略
        b.text('⚠ 本维度未给出报告原文引用，扣分理由无法当场核对，建议人工复核',
          { size: 11, color: C.amber, lh: 18 });
      }

      // 命中证据
      const evs = (d.evidence || []).filter((e) => e);
      if (evs.length) {
        b.text('命中证据', { size: 11, weight: 600, color: C.sub, lh: 18 });
        evs.slice(0, 5).forEach((e) => {
          b.text('· ' + e.label, { size: 11.5, color: C.body, lh: 19, indent: 10 });
          const snip = (e.snippets || [])[0];
          if (snip && snip.snippet) {
            const raw = cleanSnippet(snip.snippet);
            if (raw) {
              const clipped = raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
              const q = '“…' + clipped + '…”';
              const qh = b.measure(q, { size: 10.5, lh: 17, indent: 22 });
              b.ensure(qh + 6);
              const c2 = b.ctx();
              c2.fillStyle = hair(0.06);
              roundRect(c2, M + 16, b.y - 2, CW - 20, qh + 4, 4);
              c2.fill();
              c2.fillStyle = C.brand;
              c2.fillRect(M + 16, b.y - 2, 2.5, qh + 4);
              b.text(q, { size: 10.5, color: C.sub, lh: 17, indent: 22 });
            }
          }
        });
        b.gap(3);
      }

      // 缺失要点
      if (d.missing && d.missing.length) {
        b.text('缺失要点：' + d.missing.map((m) => m.label).join('、'),
          { size: 11.5, color: C.amber, lh: 19 });
      }
      // 扣分项
      if (d.penalties && d.penalties.length) {
        b.text('扣分项：' + d.penalties.map((it) => `${it.label}（-${it.weight}）`).join('、'),
          { size: 11.5, color: C.red, lh: 19 });
      }
      // 改进建议
      if (d.comment) {
        b.text('改进建议：' + d.comment, { size: 11.5, color: C.body, lh: 19 });
      }
      b.gap(i === dims.length - 1 ? 6 : 16);
    });
  }

  function estimateDetailHeight(b, d) {
    let h = 30 + 8;
    if (d.levelReason) h += 19;
    if (d.citations && d.citations.length) h += 18 + Math.min(d.citations.length, 4) * 34;
    else h += 18;
    if (d.evidence && d.evidence.length) h += 18 + d.evidence.length * 36;
    if (d.missing && d.missing.length) h += 19;
    if (d.penalties && d.penalties.length) h += 19;
    if (d.comment) h += 19;
    return h;
  }

  /**
   * 本地事实核对（PDF 版）。
   * 与网页端一致：这是不依赖模型的独立信源，因此用虚线框、独立小标题与模型评语区分开，
   * 并明确写出"不参与打分"，避免老师误以为这也是模型的判断。
   */
  function drawFacts(b, doc) {
    if (!doc || !doc.text || !AG.analyzer.objectiveFacts) return;
    let r;
    try { r = AG.analyzer.objectiveFacts(doc.text, doc.features); } catch (e) { return; }
    if (!r || !r.facts || !r.facts.length) return;

    b.ensure(70);
    b.gap(18);
    b.text('本地事实核对', { size: 13.5, weight: 700, color: C.ink, lh: 24 });
    b.gap(2);
    b.text('由本机直接读取报告文本判定，不依赖模型、不参与打分 —— 供您与模型评语交叉验证',
      { size: 10.5, color: C.faint, lh: 17 });
    b.gap(6);

    if (r.dangling.length) {
      b.ensure(34);
      const dh = b.measure(
        `⚠ 检出悬空引用 ${r.dangling.length} 处（${r.dangling.join('、')}）：正文引用了这些编号，全文却找不到对应图表。`,
        { size: 11, lh: 18, indent: 10 });
      b.ensure(dh + 12);
      const c0 = b.ctx();
      c0.fillStyle = C.amberSoft;
      roundRect(c0, M, b.y - 3, CW, dh + 8, 5);
      c0.fill();
      c0.fillStyle = C.amber;
      c0.fillRect(M, b.y - 3, 3, dh + 8);
      b.text(`⚠ 检出悬空引用 ${r.dangling.length} 处（${r.dangling.join('、')}）：正文引用了这些编号，全文却找不到对应图表。`,
        { size: 11, color: C.amber, lh: 18, indent: 10 });
      b.gap(5);
    }

    r.facts.forEach((f) => {
      const mark = f.level === 'warn' ? '⚠' : f.level === 'ok' ? '✓' : '·';
      const color = f.level === 'warn' ? C.red : f.level === 'ok' ? C.green : C.sub;
      const line = `${mark} ${f.label}`;
      b.ensure(18);
      b.text(line, { size: 11.5, color: color, lh: 18 });
      if (f.detail) b.text(f.detail, { size: 10.5, color: C.faint, lh: 16, indent: 14 });
    });
    b.gap(8);
  }

  /** 页脚（所有页统一补画，故最后执行） */
  function stampFooters(b, label) {
    const total = b.pages.length;
    b.pages.forEach((pg, i) => {
      const ctx = pg.ctx;
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M, PH - M - FOOT + 6.5);
      ctx.lineTo(M + CW, PH - M - FOOT + 6.5);
      ctx.stroke();

      ctx.font = `400 9.5px ${FONT}`;
      ctx.fillStyle = C.faint;
      ctx.fillText(label, M, PH - M - FOOT + 21);

      const pgTxt = `第 ${i + 1} / ${total} 页`;
      const w = ctx.measureText(pgTxt).width;
      ctx.fillText(pgTxt, M + CW - w, PH - M - FOOT + 21);
    });
  }

  /* ---------------- PDF 字节流封装 ---------------- */
  const ENC = new TextEncoder();
  const BIN_MARK = new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]);

  /**
   * images: [{ bytes: Uint8Array(JPEG), w, h }]
   * 对象编号布局：1=Catalog  2=Pages  每页占用 3 个：(Page, Content, Image)
   */
  function buildPdf(images) {
    const parts = [];
    const off = [];
    let pos = 0;
    const put = (u8) => { parts.push(u8); pos += u8.length; };
    const putS = (s) => put(ENC.encode(s));
    const begin = (id) => { off[id] = pos; putS(id + ' 0 obj\n'); };
    const end = () => putS('endobj\n');

    putS('%PDF-1.4\n');
    put(BIN_MARK);

    const n = images.length;
    const total = 2 + n * 3;

    begin(1);
    putS('<< /Type /Catalog /Pages 2 0 R >>\n');
    end();

    const kids = [];
    for (let i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    begin(2);
    putS('<< /Type /Pages /Count ' + n + ' /Kids [ ' + kids.join(' ') + ' ] >>\n');
    end();

    for (let i = 0; i < n; i++) {
      const pageId = 3 + i * 3;
      const contId = 4 + i * 3;
      const imgId = 5 + i * 3;
      const im = images[i];

      begin(imgId);
      putS('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
      put(im.bytes);
      putS('\nendstream\n');
      end();

      const content = 'q\n' + PT_W.toFixed(2) + ' 0 0 ' + PT_H.toFixed(2) + ' 0 0 cm\n/Im' + i + ' Do\nQ\n';
      begin(contId);
      putS('<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\n');
      end();

      begin(pageId);
      putS('<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ' + PT_W.toFixed(2) + ' ' + PT_H.toFixed(2) +
        ' ] /Resources << /XObject << /Im' + i + ' ' + imgId + ' 0 R >> >> /Contents ' + contId + ' 0 R >>\n');
      end();
    }

    const xrefPos = pos;
    let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (let id = 1; id <= total; id++) {
      xref += String(off[id]).padStart(10, '0') + ' 00000 n \n';
    }
    putS(xref);
    putS('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');

    return new Blob(parts, { type: 'application/pdf' });
  }

  /** 质量取 0.86：相比 0.9 体积约降 15%，屏幕与打印观感基本无差（实测 0.8 已可见轻微噪点）。 */
  function canvasToJpeg(cv) {
    return new Promise((resolve, reject) => {
      cv.toBlob((blob) => {
        if (!blob) return reject(new Error('画布导出失败'));
        blob.arrayBuffer().then((buf) => {
          resolve({ bytes: new Uint8Array(buf), w: cv.width, h: cv.height });
        }, reject);
      }, 'image/jpeg', 0.86);
    });
  }

  /** 组装：docs 为 [{name, result}]，多篇自动分页续排 */
  async function render(docs) {
    applyPalette();   // 每次导出都重新读主题，避免换肤后仍用旧配色
    const b = new Builder();
    docs.forEach((doc, i) => {
      if (i > 0) b.addPage();
      const r = doc.result;
      drawHead(b, doc, r);
      drawScore(b, r);
      drawOverall(b, r);
      drawDimTable(b, r.dims || []);
      drawDetails(b, r.dims || []);
      drawFacts(b, doc);
    });
    stampFooters(b, 'AutoGrader 自动生成 · 粤港澳大湾区 AI Coding 创新大赛参赛作品');
    // 逐页编码。每 4 页让出一次主线程：一个班的量（数十页）若全程占满，
    // 浏览器会假死、按钮上的进度文案也刷不出来。
    const images = [];
    for (let i = 0; i < b.pages.length; i++) {
      images.push(await canvasToJpeg(b.pages[i].cv));
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return buildPdf(images);
  }

  async function exportDocs(docs, filename) {
    const blob = await render(docs);
    U.download(filename, blob, 'application/pdf');
    return blob;
  }

  /* ---------------- 成绩表 PDF（一行一份，登分 / 归档用） ----------------
   * 与「评阅报告 PDF」是两种东西：
   *   - 评阅报告：一份报告一段，含逐维度得分、证据、评语 —— 给学生看 / 存档。
   *   - 成绩表：一张表把所有报告列完，含总分/等级/各维度分 —— 给老师登分用。
   * 老师登分时真正需要的是「能打印、能对着抄、能一眼看出谁不及格」，
   * 所以这里刻意做窄：不画证据、不写长评语，只保证列对齐、行不错位。
   */
  function drawScoreHeader(b, n, stats) {
    const ctx0 = b.ctx();
    ctx0.font = `800 19px ${FONT}`;
    ctx0.fillStyle = C.ink;
    ctx0.fillText('成绩表', M, b.y + 14);
    b.y += 26;
    ctx0.font = `400 10.5px ${FONT}`;
    ctx0.fillStyle = C.sub;
    ctx0.fillText('共 ' + n + ' 份 · 平均 ' + stats.avg.toFixed(1) +
      ' 分 · 最高 ' + stats.max + ' · 最低 ' + stats.min +
      ' · 及格率 ' + stats.passRate + '%（≥60 分 ' + stats.passN + ' 份）', M, b.y + 6);
    b.y += 18;
    b.rule(C.line2);
    b.y += 6;
  }

  /** 维度列的最小可用宽度：低于它就干脆不铺开（8 维时约 0.0525，正常场景够用） */
  const DIM_MIN_W = 0.05;

  /** 表头一行；返回列定义供后续行复用 */
  function scoreColumns(hasDims, dimNames) {
    const cols = [
      { key: 'name', label: '报告名称', w: hasDims ? 0.22 : 0.34, align: 'left' },
      { key: 'total', label: '得分', w: 0.10, align: 'center' },
      { key: 'range', label: '建议区间', w: 0.13, align: 'center' },
      { key: 'grade', label: '等级', w: 0.10, align: 'center' },
    ];
    if (hasDims) {
      // 维度名最长 9 个字，8 列再怎么挤也放不下 → 表头只放 D1..Dn，全称走表下图例
      const dimW = 0.37 / Math.max(1, dimNames.length);
      dimNames.forEach((dn, i) => cols.push({ key: 'dim:' + dn, label: 'D' + (i + 1), w: dimW, align: 'center' }));
    }
    cols.push({ key: 'words', label: '字数', w: hasDims ? 0.05 : 0.14, align: 'center' });
    cols.push({ key: 'feat', label: '代码/图表', w: hasDims ? 0.06 : 0.18, align: 'center' });
    return cols;
  }

  function drawScoreRow(b, cols, values, opts) {
    opts = opts || {};
    const ctx = b.ctx();
    const fs = cols.length > 8 ? 9 : 10.5;
    const rowH = 22;
    b.ensure(rowH);
    let x = M;
    if (opts.zebra) {
      ctx.fillStyle = hair(0.035);
      ctx.fillRect(M, b.y - 2, CW, rowH);
    }
    cols.forEach((c) => {
      const w = c.w * CW;
      ctx.font = `${opts.bold ? 700 : 400} ${fs}px ${c.key === 'name' ? FONT : MONO_OR_FONT(c)}`;
      ctx.fillStyle = opts.colorFor && opts.colorFor(c) ? opts.colorFor(c) : (opts.bold ? C.ink : C.body);
      let txt = values[c.key] == null ? '' : String(values[c.key]);
      const maxw = w - 6;
      while (ctx.measureText(txt).width > maxw && txt.length > 1) txt = txt.slice(0, -1);
      if (txt !== raw(c.key) && txt.length > 1) txt = txt.slice(0, -1) + '…';
      let tx = x + 3;
      if (c.align === 'center') tx = x + Math.max(3, (w - ctx.measureText(txt).width) / 2);
      else if (c.align === 'right') tx = x + Math.max(3, w - ctx.measureText(txt).width - 3);
      ctx.fillText(txt, tx, b.y + rowH - 8);
      x += w;
    });
    b.y += rowH;
    function raw(f) { const v = values[f]; return v == null ? '' : String(v); }
    // 行分隔线
    ctx.strokeStyle = hair(0.07);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, b.y - 0.5);
    ctx.lineTo(M + CW, b.y - 0.5);
    ctx.stroke();
  }

  /** 数字列用等宽字体对齐，文本列（报告名）用正文字体 */
  function MONO_OR_FONT(c) {
    return c.key === 'name' ? FONT : MONO;
  }

  async function renderScoreTable(docs) {
    applyPalette();
    const b = new Builder();
    const n = docs.length;
    const totals = docs.map((d) => d.result.total);
    const sum = totals.reduce((a, b2) => a + b2, 0);
    const stats = {
      avg: sum / n,
      max: Math.max.apply(null, totals),
      min: Math.min.apply(null, totals),
      passN: totals.filter((t) => t >= 60).length,
      passRate: Math.round((totals.filter((t) => t >= 60).length / n) * 100),
    };

    const dimNames = (docs[0].result.dims || []).map((d) => d.name);
    // 维度铺开的条件：数量不超过 8，且每列宽度不至于挤到认不出名字
    const hasDims = dimNames.length > 0 && dimNames.length <= 8 && 0.42 / dimNames.length >= DIM_MIN_W;
    const cols = scoreColumns(hasDims, dimNames);

    drawScoreHeader(b, n, stats);

    // 表头
    const headVals = {};
    cols.forEach((c) => { headVals[c.key] = c.label; });
    drawScoreRow(b, cols, headVals, { bold: true, colorFor: null });
    b.ctx().fillStyle = C.sub;

    docs.forEach((d, i) => {
      const r = d.result;
      const vals = {
        name: d.name,
        total: r.total,
        range: Array.isArray(r.range) && r.range.length === 2 && r.range[1] > r.range[0]
          ? `${r.range[0]}–${r.range[1]}` : '—',
        grade: r.grade + ' · ' + r.gradeLabel,
        words: r.features.words,
        feat: r.features.codeBlockCount + ' / ' + (r.features.figureCount + r.features.tableCount),
      };
      if (hasDims) (r.dims || []).forEach((dm) => { vals['dim:' + dm.name] = dm.score; });
      // 不及格的整行标红，老师一眼扫到
      const fail = r.total < 60;
      drawScoreRow(b, cols, vals, {
        zebra: i % 2 === 1,
        colorFor: (c) => (fail && (c.key === 'total' || c.key === 'grade') ? C.red : null),
      });
    });

    // 表尾：维度图例（表头只放了 D1..Dn，全称在这里补全），登分时要能对上号
    if (hasDims) {
      b.y += 10;
      b.ensure(20);
      const maxScores = (docs[0].result.dims || []).map((d) => d.max);
      const legend = dimNames
        .map((dn, i) => 'D' + (i + 1) + ' ' + dn + '（' + maxScores[i] + '分）')
        .join('   ');
      b.text(legend, { size: 9.5, color: C.sub, lineH: 14 });
    }

    // 表尾：等级人数汇总，登分时常要对一下人数
    b.y += 10;
    b.ensure(40);
    const tally = {};
    docs.forEach((d) => { const g = d.result.grade || 'F'; tally[g] = (tally[g] || 0) + 1; });
    const order = ['A', 'B', 'C', 'D', 'F'].filter((g) => tally[g]);
    b.text('等级人数：' + order.map((g) => g + ' ' + tally[g] + ' 人').join(' · '), { size: 10.5, color: C.sub });

    stampFooters(b, 'AutoGrader 自动生成 · 成绩表');
    const images = [];
    for (let i = 0; i < b.pages.length; i++) {
      images.push(await canvasToJpeg(b.pages[i].cv));
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return buildPdf(images);
  }

  async function exportScoreTable(docs, filename) {
    const blob = await renderScoreTable(docs);
    U.download(filename, blob, 'application/pdf');
    return blob;
  }

  AG.pdf = { render, exportDocs, renderScoreTable, exportScoreTable, buildPdf };
})(window);
