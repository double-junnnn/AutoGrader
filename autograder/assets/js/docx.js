/**
 * docx.js —— 零依赖的 .docx 文本抽取器
 *
 * 为什么不用 mammoth：本项目卖点是「纯前端、零第三方依赖、断网可用」，
 * 但 .docx 恰恰是实验报告最可能的格式，一旦走 CDN 就意味着离线场景下
 * 老师手里的报告传不上去。所以这里直接用浏览器原生的
 * DecompressionStream('deflate-raw') 自己解 zip + 取 word/document.xml。
 *
 * docx 本质：
 *   OOXML 包 = ZIP 容器
 *   正文   = word/document.xml
 *   文本   = <w:t> 标签内的内容
 *   段落   = <w:p> ... </w:p>
 *   标题   = <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
 *
 * 关键增强：把 Heading 样式还原为 Markdown 的 #/##/###，
 * 这样下游 parser 的标题识别（章节切分、目录结构）才能正常工作。
 * 纯裸文本抽取会把整份报告的层级信息丢掉，评分准确度会明显下降。
 */
(function (global) {
  'use strict';
  const AG = (global.AG = global.AG || {});

  const MAX_UNCOMPRESSED = 24 * 1024 * 1024; // 单条目解压后上限，防 zip 炸弹

  /* ---------------- ZIP 容器解析 ---------------- */

  /** 从尾部定位 End Of Central Directory 记录 */
  function findEOCD(u8) {
    // EOCD 签名 0x06054b50，小端字节序 50 4B 05 06，后面还有可变长注释
    const maxBack = Math.min(u8.length, 65557); // 22(EOCD最小长) + 65535(注释上限)
    const start = u8.length - maxBack;
    for (let i = u8.length - 22; i >= start; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  function readU16(u8, o) { return u8[o] | (u8[o + 1] << 8); }
  function readU32(u8, o) {
    return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  }

  /**
   * 遍历 Central Directory，收集文件名 → {offset, compSize, method}
   * CD entry 结构：签名(4) + ... + method(10) + compSize(20) + nameLen(28) + extraLen(30) + commentLen(32) + localOffset(42)
   */
  function readCentralDirectory(u8) {
    const eocd = findEOCD(u8);
    if (eocd < 0) throw new Error('不是有效的 docx（未找到 ZIP 结束记录）');

    let count = readU16(u8, eocd + 10);
    let cdOffset = readU32(u8, eocd + 16);

    // ZIP64：数量为 0xffff 或偏移为 0xffffffff 时说明字段溢出，需读 ZIP64 EOCD
    if (count === 0xffff || cdOffset === 0xffffffff) {
      const z64Sig = findBytes(u8, [0x50, 0x4b, 0x06, 0x06], Math.max(0, eocd - 20), eocd);
      if (z64Sig >= 0) {
        // ZIP64 EOCD: 签名(4) + size(8) + ... + disk(32,4) + thisDisk(36,4) + entriesOnDisk(40,8) + totalEntries(48,8) + cdSize(56,8) + cdOffset(64,8)
        const lo = Number(readU64(u8, z64Sig + 48));
        if (lo > count) count = lo;
        cdOffset = Number(readU64(u8, z64Sig + 64));
      }
    }

    const files = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > u8.length) break;
      if (readU32(u8, p) !== 0x02014b50) break; // Central Directory Header 签名
      const method = readU16(u8, p + 10);
      const compSize = readU32(u8, p + 20);
      const nameLen = readU16(u8, p + 28);
      const extraLen = readU16(u8, p + 30);
      const commentLen = readU16(u8, p + 32);
      const localOffset = readU32(u8, p + 42);
      const name = decodeUTF8(u8.subarray(p + 46, p + 46 + nameLen));
      files.set(name, { method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  function readU64(u8, o) {
    // JS 位运算只有 32 位，用乘法拼出安全的 53 位整数
    let v = 0;
    for (let i = 7; i >= 0; i--) v = v * 256 + u8[o + i];
    return v;
  }

  function findBytes(u8, sig, from, to) {
    for (let i = Math.max(0, from); i + sig.length <= Math.min(u8.length, to); i++) {
      let ok = true;
      for (let j = 0; j < sig.length; j++) { if (u8[i + j] !== sig[j]) { ok = false; break; } }
      if (ok) return i;
    }
    return -1;
  }

  /** 根据 local file header 定位数据区起点 */
  function dataOffsetOf(u8, localOffset) {
    // Local Header: 签名(4) + ... + nameLen(26) + extraLen(28)
    const nameLen = readU16(u8, localOffset + 26);
    const extraLen = readU16(u8, localOffset + 28);
    return localOffset + 30 + nameLen + extraLen;
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream');
    }
    // 复制一份，避免管道读取时被底层 buffer 回收影响
    const input = new Uint8Array(u8);
    const ds = new DecompressionStream('deflate-raw');
    const chunks = [];
    // eslint-disable-next-line no-undef
    const writer = ds.writable.getWriter();
    writer.write(input);
    writer.close();

    let total = 0;
    const reader = ds.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_UNCOMPRESSED) {
        await reader.cancel();
        throw new Error('文档内容过大，已中止解压');
      }
      chunks.push(value);
    }
    // 拼接
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach((c) => { out.set(c, pos); pos += c.length; });
    return out;
  }

  /** 读取 docx 包内某个成员，返回 UTF-8 字符串 */
  async function readEntry(u8, files, name) {
    const ent = files.get(name);
    if (!ent) return null;
    const start = dataOffsetOf(u8, ent.localOffset);
    let bytes;
    if (ent.method === 0) {
      bytes = u8.subarray(start, start + ent.compSize); // stored，未压缩
    } else if (ent.method === 8) {
      bytes = await inflateRaw(u8.subarray(start, start + ent.compSize));
    } else {
      throw new Error('不支持的压缩方式：' + ent.method);
    }
    return decodeUTF8(bytes);
  }

  function decodeUTF8(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  }

  /* ---------------- OOXML → 纯文本 ---------------- */

  const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES['&' + e + ';']);
  }

  /** 从 <w:pPr> 中判断该段落是否为标题，返回层级 1-6，非标题返回 0 */
  function headingLevelOf(paraXml) {
    const pStyle = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(paraXml);
    if (!pStyle) return 0;
    const v = pStyle[1] || '';
    let m = /^[Hh]eading\s*(\d)$/.exec(v);          // Heading1 / heading 2
    if (m) return Math.max(1, Math.min(6, Number(m[1])));
    m = /^标题\s*(\d)$/.exec(v);                     // 中文样式名：标题1
    if (m) return Math.max(1, Math.min(6, Number(m[1])));
    if (/^[Hh]eading$/.test(v) || /^标题$/.test(v)) return 1;
    if (/^[Tt]itle$/.test(v)) return 1;              // Title 视为一级标题
    return 0;
  }

  /** 段落 XML → 纯文本（含标题层级还原） */
  function paraText(paraXml) {
    // 去掉数学公式块，避免 OMML 标签污染正文
    let s = paraXml.replace(/<m:oMath[\s\S]*?<\/m:oMath>/g, '');
    s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t')
         .replace(/<w:br\b[^>]*\/?>/g, '\n')
         .replace(/<w:cr\b[^>]*\/?>/g, '\n');
    // 只保留 <w:t>（含 <w:t xml:space="preserve">）的内容，其余标签一律丢弃
    s = s.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, '$1');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s);
  }

  /**
   * 判断一个段落是否为代码。
   *
   * 为什么必须做这件事：Word 里的代码块通常只是「带缩进的普通段落」，
   * 一旦抽取成裸文本就再也认不出是代码，而下游 rubric 的 codeBlock
   * 正则只认 ``` 围栏 —— 结果是同一份报告用 .md 上传能识别代码拿高分，
   * 用 .docx 上传反而大跌分。这是会当场毁掉演示的不一致，必须在解析层补掉。
   *
   * 判据（三条，任一命中即可，先过中英文占比这道闸）：
   *   1. 上下文信号：前一段以「代码如下/源码/实现如下」等结尾
   *   2. 关键字信号：命中 def/class/public/return/include 等
   *   3. 形态信号：多行 + 大量缩进 + 中高符号密度
   */
  const CODE_KEYWORD = /\b(def|class|elif|lambda|function|var|let|const|public|private|protected|static|void|int|float|double|boolean|char|return|import|include|package|namespace|typedef|struct|malloc|printf|cout|println|System\.out|async|await|new|if|for|while|switch|try|catch)\b/;
  const CODE_CONTEXT = /(代码|源码|实现|伪代码|示例)[^\n：:]{0,6}(如下|如下|如下|所示|为|见下)|(如下|下列|以下)(所示|代码)|：\s*$|:\s*$/;

  function looksLikeCode(raw, prevText) {
    const text = String(raw || '');
    if (!text.trim()) return false;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (letters < 4) return false;                       // 连英文都没几个，谈不上代码
    if (chinese / (letters + chinese) > 0.12) return false; // 中文为主 → 是正文不是代码

    const lines = text.split('\n').filter((l) => l.trim());
    const symbols = (text.match(/[{}\[\]();=<>*/+\-&|!?:,]/g) || []).length;
    const indented = lines.filter((l) => /^[ \t]/.test(l)).length;

    if (CODE_KEYWORD.test(text) && (symbols >= 2 || lines.length >= 2 || indented >= 1)) return true;
    if (prevText && CODE_CONTEXT.test(prevText) && (CODE_KEYWORD.test(text) || symbols >= 3)) return true;
    if (lines.length >= 2 && indented >= Math.max(1, Math.floor(lines.length * 0.5)) && symbols >= 3) return true;
    return false;
  }

  /** cell → 文本（单元格内可能有多个段落） */
  function cellText(tcXml) {
    const ps = tcXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*?\/>/g) || [];
    return ps.map((p) => paraText(p).trim()).filter(Boolean)
      .join(' ').replace(/\|/g, '\\|').trim();
  }

  /**
   * 表格还原为 Markdown 表格。
   * 不做这一步，下游 rubric 的 table 正则（只认 |…| 或「表N」）同样检测不到，
   * 「数据支撑充分」这类证据会凭空消失。
   */
  function tableToMd(tblXml) {
    const trs = tblXml.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>|<w:tr\b[^>]*?\/>/g) || [];
    const rows = [];
    trs.forEach((tr) => {
      const tcs = tr.match(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) || [];
      // 同一单元格可能被拆成多个 tc（合并单元格），逐个取
      const cells = tcs.map(cellText).filter((c) => c !== '');
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return '';

    const n = Math.max.apply(null, rows.map((r) => r.length));
    const norm = rows.map((r) => {
      const c = r.slice();
      while (c.length < n) c.push('');
      return c.slice(0, n);
    });
    const head = norm[0];
    const out = [
      '| ' + head.join(' | ') + ' |',
      '| ' + head.map(() => '---').join(' | ') + ' |',
    ];
    norm.slice(1).forEach((r) => out.push('| ' + r.join(' | ') + ' |'));
    return out.join('\n');
  }

  // 顶层块：整块表格优先匹配（避免表格内的 w:p 被当成独立段落重复处理）
  const BLOCK_RE = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*?\/>/g;

  function xmlToText(xml) {
    const m = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
    const bodyXml = m ? m[1] : xml;
    const tokens = bodyXml.match(BLOCK_RE) || [];

    const lines = [];
    let prev = '';
    tokens.forEach((tk) => {
      if (/^<w:tbl/.test(tk)) {
        const md = tableToMd(tk);
        if (md) lines.push(md);
        prev = '';
        return;
      }
      const raw = paraText(tk);              // 保留内部换行，代码要靠它
      const flat = raw.replace(/[ \t]+/g, ' ').trim();
      if (!flat) { lines.push(''); return; }

      const lv = headingLevelOf(tk);
      if (lv) { lines.push('#'.repeat(lv) + ' ' + flat); prev = flat; return; }

      if (looksLikeCode(raw, prev)) {
        lines.push('```\n' + raw.replace(/^\n+|\n+$/g, '') + '\n```');
        prev = flat;
        return;
      }
      lines.push(flat);
      prev = flat;
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------- 对外 API ---------------- */

  /**
   * 解析 .docx
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<string>} 正文文本（失败时抛错，由上层决定是否降级）
   */
  async function parse(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const files = readCentralDirectory(u8);
    const xml = await readEntry(u8, files, 'word/document.xml');
    if (!xml) throw new Error('docx 内缺少 word/document.xml');
    const text = xmlToText(xml);
    if (!text || text.length < 2) throw new Error('未能从 docx 中提取到文本');
    return text;
  }

  /** 是否可用（用于上层决定走本地还是 CDN 兜底） */
  function supported() {
    return typeof DecompressionStream !== 'undefined';
  }

  AG.docx = { parse, supported, xmlToText };
})(window);
