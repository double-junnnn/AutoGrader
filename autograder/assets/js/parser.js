/* AutoGrader · 文档解析层
 * 支持 .txt / .md 原生解析，.docx / .pdf 通过 CDN 按需加载解析器（失败时优雅降级为「粘贴文本」）。
 * 同时抽取结构化特征（标题、代码块、图表、表格、数字密度）供评分引擎使用。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});
  const U = AG.utils;

  const CDN = {
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  };

  function extOf(name) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** 抽取结构化特征 */
  function extractFeatures(text) {
    const P = AG.rubric.STRUCT_PATTERNS;
    const t = String(text || '');
    const codeBlocks = t.match(P.codeBlock) || [];
    const codeText = codeBlocks.join('\n');
    const bodyNoCode = t.replace(P.codeBlock, ' ');

    return {
      words: U.countWords(t),
      chars: t.length,
      lines: t.split(/\r?\n/).filter((l) => l.trim()).length,
      headings: (t.match(P.heading) || []).map((s) => s.replace(/^[\s#]+/, '').trim()).slice(0, 40),
      headingCount: (t.match(P.heading) || []).length,
      codeBlockCount: codeBlocks.length,
      codeLines: codeText ? codeText.split(/\n/).length : 0,
      codeChars: codeText.length,
      figureCount: (t.match(P.figure) || []).length,
      tableCount: (t.match(P.table) || []).length,
      referenceCount: (t.match(P.reference) || []).length,
      numberCount: (bodyNoCode.match(P.number) || []).length,
      numberDensity: bodyNoCode.length ? (bodyNoCode.match(P.number) || []).length / (bodyNoCode.length / 100) : 0,
    };
  }

  /** 兜底：通过 CDN 的 mammoth 解 docx（需要联网） */
  async function mammothRaw(buf) {
    await U.loadScript(CDN.mammoth);
    if (!global.mammoth) throw new Error('mammoth 未就绪');
    const res = await global.mammoth.extractRawText({ arrayBuffer: buf });
    return res.value || '';
  }

  async function parsePdf(file) {
    await U.loadScript(CDN.pdfjs);
    if (!global.pdfjsLib) throw new Error('pdf.js 未就绪');
    const lib = global.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = CDN.pdfjs.replace('pdf.min.js', 'pdf.worker.min.js');
    const buf = await U.readFileAsArrayBuffer(file);
    const pdf = await lib.getDocument({ data: buf }).promise;
    let out = '';
    const max = Math.min(pdf.numPages, 40); // 最多解析 40 页，防止超大文件卡死
    for (let i = 1; i <= max; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((it) => it.str).join(' ') + '\n';
    }
    return out;
  }

  /**
   * 解析单个文件
   * @returns {Promise<{name,text,features,warning}>}
   */
  async function parseFile(file) {
    const ext = extOf(file.name);
    let text = '';
    let warning = '';

    try {
      if (['txt', 'md', 'markdown', 'csv', 'log'].includes(ext)) {
        text = await U.readFileAsText(file);
      } else if (ext === 'docx') {
        // 优先走本地零依赖解析（断网可用），失败再降级 CDN 的 mammoth
        const buf = await U.readFileAsArrayBuffer(file);
        try {
          text = await AG.docx.parse(buf);
        } catch (localErr) {
          console.warn('[parser] 本地 docx 解析失败，降级 mammoth：', localErr.message);
          text = await mammothRaw(buf);
        }
        if (!text || !text.trim()) {
          text = await mammothRaw(buf);
        }
      } else if (ext === 'pdf') {
        text = await parsePdf(file);
      } else {
        // 未知类型：尝试按纯文本读取
        text = await U.readFileAsText(file);
        warning = '非标准格式，已按纯文本解析';
      }
    } catch (e) {
      throw new Error(`「${file.name}」解析失败：${e.message}`);
    }

    if (!text || !text.trim()) {
      throw new Error(`「${file.name}」未提取到文本内容，请改用「粘贴文本」方式录入`);
    }

    return {
      name: file.name,
      text: text.trim(),
      features: extractFeatures(text),
      warning,
    };
  }

  /** 从粘贴文本直接构造文档对象 */
  function fromText(name, text) {
    return {
      name,
      text: String(text || '').trim(),
      features: extractFeatures(text),
      warning: '',
    };
  }

  AG.parser = { parseFile, fromText, extractFeatures, extOf };
})(window);
