/* AutoGrader · 通用工具库
 * 采用 IIFE + 全局命名空间，保证 file:// 直接双击打开也能运行（无需构建、无需服务器）。
 */
(function (global) {
  'use strict';

  const AG = (global.AG = global.AG || {});

  const U = {
    /* ---------- DOM ---------- */
    $: (sel, root) => (root || document).querySelector(sel),
    $$: (sel, root) => Array.from((root || document).querySelectorAll(sel)),

    el(tag, attrs, children) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const k in attrs) {
          if (k === 'class') node.className = attrs[k];
          else if (k === 'html') node.innerHTML = attrs[k];
          else if (k.startsWith('on') && typeof attrs[k] === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
          } else if (attrs[k] !== null && attrs[k] !== undefined) {
            node.setAttribute(k, attrs[k]);
          }
        }
      }
      (children || []).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return node;
    },

    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[m]));
    },

    /* ---------- 数值 / 文本 ---------- */
    clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
    round(v, n) { const p = Math.pow(10, n || 0); return Math.round(v * p) / p; },

    uid(prefix) {
      return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
    },

    /** 归一化文本：用于相似度计算（忽略空白与标点差异） */
    normalize(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')      // 去掉代码块
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。；：、,.!?！？;:()（）\[\]【】"'"'“”]/g, '')
        .toLowerCase();
    },

    /** 生成字符 n-gram 集合 */
    shingles(text, n) {
      n = n || 5;
      const s = U.normalize(text);
      const set = new Set();
      if (s.length < n) { if (s) set.add(s); return set; }
      for (let i = 0; i <= s.length - n; i++) set.add(s.slice(i, i + n));
      return set;
    },

    /** Jaccard 相似度 0~1 */
    jaccard(a, b) {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      small.forEach((v) => { if (big.has(v)) inter++; });
      return inter / (a.size + b.size - inter);
    },

    /** 统计中文字符 + 英文单词数，作为"字数" */
    countWords(text) {
      const t = String(text || '');
      const cn = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      const en = (t.match(/[A-Za-z]+/g) || []).length;
      return cn + en;
    },

    fmtTime(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    /* ---------- 文件 ---------- */
    /**
     * 触发文件下载。
     *
     * 本应用常在 file:// 下双击运行，此时页面来源是不透明的（null origin）。
     * 若 revokeObjectURL 紧跟在 click 之后同步执行，blob URL 会在浏览器还没
     * 开始读取时就失效；Chrome 通常来得及，Edge 等异步读取的浏览器则放弃下载，
     * 转而把「blob:」当成外部协议交给操作系统 —— 用户会看到
     * 「获取打开此 'blob' 链接的应用 / 请尝试在 Microsoft Store 中查找」。
     * 因此这里：① 旧内核走原生保存接口；② 派发真实鼠标事件；
     * ③ 延迟释放 URL，并留出足够长的存活窗口。
     */
    download(filename, content, mime) {
      // 已是 Blob（如 PDF 字节流）时直接落盘，避免二次包装破坏 MIME 与二进制内容
      const blob = (content instanceof Blob)
        ? content
        : new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });

      // ① 旧版 Edge / IE：原生接口最可靠，且不会走 blob 协议转发
      const nav = global.navigator || {};
      if (typeof nav.msSaveOrOpenBlob === 'function') {
        try { nav.msSaveOrOpenBlob(blob, filename); return; } catch (e) { /* 继续尝试标准路径 */ }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);

      // ② 派发真实鼠标事件，比裸 click() 更容易被判定为「用户手势」而放行
      let ok = false;
      try {
        ok = a.dispatchEvent(new MouseEvent('click', {
          bubbles: false, cancelable: true, view: global,
        }));
      } catch (e) { ok = false; }
      if (!ok) { try { a.click(); } catch (e) { /* 交给调用方兜底 */ } }

      // ③ 30s 后再释放：给异步读取的浏览器留足时间，避免下载到空文件
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);

      return blob;
    },

    /**
     * 检测当前环境是否「下载可能不可靠」——用于 UI 上给出替代路径提示。
     * file:// 且非 Chromium 系内核时，blob 下载在部分实现上会被转交系统处理。
     */
    downloadRisky() {
      const isFile = global.location && global.location.protocol === 'file:';
      const ua = (global.navigator && global.navigator.userAgent) || '';
      const isEdge = /Edg\//.test(ua);
      const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua);
      return !!(isFile && (isEdge || isSafari));
    },

    readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsText(file, 'utf-8');
      });
    },

    readFileAsArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(file);
      });
    },

    /** 动态加载脚本（用于 PDF / DOCX 解析器按需加载） */
    loadScript(src) {
      return new Promise((resolve, reject) => {
        const exist = document.querySelector(`script[data-src="${src}"]`);
        if (exist) return resolve();
        const s = document.createElement('script');
        s.src = src;
        s.dataset.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('加载失败: ' + src));
        document.head.appendChild(s);
      });
    },

    /* ---------- 持久化 ---------- */
    store: {
      get(key, fallback) {
        try {
          const raw = localStorage.getItem('autograder.' + key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      },
      set(key, val) {
        try { localStorage.setItem('autograder.' + key, JSON.stringify(val)); return true; }
        catch (e) { return false; }
      },
      del(key) { try { localStorage.removeItem('autograder.' + key); } catch (e) {} },
    },

    /* ---------- 轻量事件总线 ---------- */
    bus: (function () {
      const map = {};
      return {
        on(evt, fn) { (map[evt] = map[evt] || []).push(fn); },
        emit(evt, payload) { (map[evt] || []).forEach((fn) => fn(payload)); },
      };
    })(),
  };

  AG.utils = U;
})(window);
