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

  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,sans-serif';
  const MONO = '"SFMono-Regular",Consolas,"Liberation Mono",monospace';

  /* 打印友好基线：浅底深字、省墨、纸质归档安全 */
  const C_PRINT = {
    page: '#ffffff', ink: '#0f172a', body: '#334155', sub: '#64748b', faint: '#94a3b8',
    line: '#e2e8f0', line2: '#cbd5e1', wash: '#f6f8fb', brand: '#2563eb', brandSoft: '#eff6ff',
    amber: '#b45309', red: '#b91c1c', dark: false, toon: false,
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
      amber: p.amber, red: p.red,
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
      `评阅引擎：${r.engineLabel || '本地启发式引擎'}`,
      `评阅时间：${U.fmtTime(r.gradedAt)}`,
      `篇幅：${r.features.words} 字 · 代码块 ${r.features.codeBlockCount} 个 · 图表引用 ${r.features.figureCount + r.features.tableCount} 处 · 数据点 ${r.features.numberCount} 个`,
    ].join('\n');
    b.text(meta, { size: 11, color: C.sub, lh: 18 });
    b.gap(10);
    b.rule();
    b.gap(12);
  }

  function drawScore(b, r) {
    const p = r.total / 100;
    const color = r.gradeColor || ratioColor(p);
    b.panel(92, (ctx, top) => {
      // 左侧总分
      ctx.font = `700 44px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(String(r.total), M + 24, top + 60);
      const wScore = ctx.measureText(String(r.total)).width;
      ctx.font = `500 13px ${FONT}`;
      ctx.fillStyle = C.sub;
      ctx.fillText('/ 100', M + 24 + wScore + 7, top + 60);

      ctx.font = `600 13px ${FONT}`;
      ctx.fillStyle = C.faint;
      ctx.fillText('综合得分', M + 24, top + 79);

      // 右侧等级 + 条
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

    const wName = 210, wScore = 84, wBar = CW - wName - wScore - 16;
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
    ctx.fillText('得分', M + wName + 12, b.y + 17);
    ctx.fillText('达成率', M + wName + wScore + 12, b.y + 17);
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

      c.font = `600 12px ${FONT}`;
      c.fillStyle = C.body;
      c.fillText(`${d.score}`, M + wName + 12, top + 20);
      const wS = c.measureText(`${d.score}`).width;
      c.font = `400 11px ${FONT}`;
      c.fillStyle = C.faint;
      c.fillText(`/ ${d.max}`, M + wName + 12 + wS + 3, top + 20);

      const p = U.clamp(d.ratio, 0, 1);
      drawBar(c, M + wName + wScore + 12, top + 11, wBar * 0.72, 8, p, ratioColor(p));
      c.font = `500 11px ${FONT}`;
      c.fillStyle = C.sub;
      c.fillText(`${Math.round(p * 100)}%`, M + wName + wScore + 12 + wBar * 0.72 + 8, top + 20);

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
      ctx.fillText(wrapText(ctx, d.name, CW - 180)[0] || '', M + 14, top + 20);

      ctx.font = `600 12.5px ${FONT}`;
      ctx.fillStyle = color;
      const scoreTxt = `${d.score} / ${d.max}`;
      ctx.fillText(scoreTxt, M + CW - 14 - ctx.measureText(scoreTxt).width, top + 20);
      b.y = top + headH + 8;

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
    if (d.evidence && d.evidence.length) h += 18 + d.evidence.length * 36;
    if (d.missing && d.missing.length) h += 19;
    if (d.penalties && d.penalties.length) h += 19;
    if (d.comment) h += 19;
    return h;
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

  AG.pdf = { render, exportDocs, buildPdf };
})(window);
