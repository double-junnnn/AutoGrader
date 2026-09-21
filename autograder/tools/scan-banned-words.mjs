#!/usr/bin/env node
/**
 * scan-banned-words.mjs —— 违禁词体检
 *
 * 用途：人格词库与界面文案的安全自检。改完 voice.js / chat.js / 任意面向用户的文案后必跑。
 *
 * 词库分两级：
 *   一级 —— 绝对禁止（暴力、死亡、血腥、排泄、脏话、歧视类），命中即判定不通过，退出码 1。
 *   二级 —— 灰区（可能带攻击性但需人工判断），只列出，不阻断。
 *
 * 三条刻意的豁免（与 README 第八节一致）：
 *   1. 注释行不扫 —— 注释里写「注意别用 XX 词」是正常的工程行为。
 *   2. 禁令语境行不扫 —— prompt 里必须点名「严禁暴力、死亡……」，否则模型不知道边界在哪。
 *      这类行的作用是在封杀违禁词，不是在用它。
 *   3. 技术术语豁免 —— 「写死」= hard-code，与死亡无关。
 *
 * 用法：
 *   node tools/scan-banned-words.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 词库 ----------
const LEVEL1 = [
  // 死亡 / 暴力 / 血腥
  '死亡', '去死', '该死', '找死', '自杀', '屠杀', '尸体', '血腥', '鲜血', '血淋淋',
  '暴力', '武器', '枪械', '炸弹', '开枪', '打死', '捅死',
  // 排泄
  '屎', '尿', '屁', '大便', '拉稀', '呕吐',
  // 脏话 / 侮辱
  '混蛋', '王八', '杂种', '畜生', '贱人', '婊', '操你', '滚蛋', '白痴',
  'fuck', 'shit', 'bitch', 'damn', 'asshole',
  // 歧视
  '歧视', '侮辱', '智障', '残废', '娘炮',
];

const LEVEL2 = [
  '蠢', '笨', '傻', '呆', '垃圾', '废物', '屁话', '废话', '死', '滚', '你不行',
];

// 技术术语豁免：命中即从该行中摘除，避免误报（与内容安全无关的行业用语）
const TECH_EXEMPT = [
  '写死', '死循环', '死锁', '卡死', '滚雪球', '僵尸', 'kill', 'Kill', 'KILL',
  '回滚',   // 数据库事务术语（ROLLBACK），与「滚」的贬义无关
];

// 禁令语境：出现这些词的行，说明该行是在声明禁令，整行跳过
const PROHIBIT_CTX = ['严禁', '禁止', '不得', '不许', '绝不', '不接受', '不侮辱', '不歧视', '不人身攻击'];

// ---------- 扫描范围 ----------
function collect() {
  const targets = [];
  const html = join(ROOT, 'index.html');
  if (existsSync(html)) targets.push(html);

  const jsDir = join(ROOT, 'assets', 'js');
  if (existsSync(jsDir)) {
    for (const f of readdirSync(jsDir)) {
      if (f.endsWith('.js')) targets.push(join(jsDir, f));
    }
  }
  const cssDir = join(ROOT, 'assets', 'css');
  if (existsSync(cssDir)) {
    for (const f of readdirSync(cssDir)) {
      if (f.endsWith('.css')) targets.push(join(cssDir, f));
    }
  }
  return targets;
}

/**
 * 剥离注释，只留「会被用户看到的内容」。
 *
 * 为什么不按行首判断：`const N = 100; // 防 zip 炸弹` 这类行尾注释同样是注释，
 * 按行首判断会把它当正文扫，产生误报。
 *
 * JS 走一个小状态机（跟踪 ' " ` 三种引号与转义），避免把字符串里的 // 误当注释起点
 * （典型：`https://`、正则字面量）；HTML / CSS 只剥块注释，`//` 在其中不是注释语法。
 */
function stripComments(text, kind) {
  const out = [];
  let inBlock = false;
  let inHtml = false;

  for (const line of text.split('\n')) {
    let kept = '';
    let i = 0;

    while (i < line.length) {
      const rest = line.slice(i);

      if (inBlock) {
        const end = line.indexOf(kind === 'js' ? '*/' : '*/', i);
        if (end === -1) { i = line.length; break; }
        i = end + 2;
        inBlock = false;
        continue;
      }
      if (inHtml) {
        const end = line.indexOf('-->', i);
        if (end === -1) { i = line.length; break; }
        i = end + 3;
        inHtml = false;
        continue;
      }

      if (rest.startsWith('/*')) { inBlock = true; i += 2; continue; }
      if (kind === 'html' && rest.startsWith('<!--')) { inHtml = true; i += 4; continue; }
      if (kind === 'js' && rest.startsWith('//')) break;

      // 字符串字面量：整体保留，内部不解析注释
      if (kind === 'js' && (rest[0] === '"' || rest[0] === "'" || rest[0] === '`')) {
        const q = rest[0];
        let j = 1;
        while (j < rest.length) {
          if (rest[j] === '\\') { j += 2; continue; }
          if (rest[j] === q) { j += 1; break; }
          j += 1;
        }
        kept += rest.slice(0, j);
        i += j;
        continue;
      }

      kept += rest[0];
      i += 1;
    }

    out.push(kept);
  }

  return out;
}

function scanText(text, file, kind) {
  const hits = [];
  const lines = stripComments(text, kind);

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (PROHIBIT_CTX.some((k) => trimmed.includes(k))) return;

    let probe = trimmed;
    for (const t of TECH_EXEMPT) probe = probe.split(t).join('');

    for (const w of LEVEL1) {
      if (probe.includes(w)) hits.push({ file, line: i + 1, word: w, level: 1, text: text.split('\n')[i].trim() });
    }
    for (const w of LEVEL2) {
      if (probe.includes(w)) hits.push({ file, line: i + 1, word: w, level: 2, text: text.split('\n')[i].trim() });
    }
  });

  return hits;
}

const kindOf = (f) => (f.endsWith('.js') ? 'js' : f.endsWith('.html') ? 'html' : 'css');

// ---------- 主流程 ----------
const targets = collect();
let all = [];
for (const f of targets) {
  all = all.concat(scanText(readFileSync(f, 'utf8'), f, kindOf(f)));
}

const l1 = all.filter((h) => h.level === 1);
const l2 = all.filter((h) => h.level === 2);

const fmt = (h) => `  [L${h.level}] ${relative(ROOT, h.file)}:${h.line}  「${h.word}」\n        ${h.text.slice(0, 120)}`;

console.log('违禁词体检 · 扫描范围 %d 个文件\n', targets.length);
if (l1.length) {
  console.log(`一级（绝对禁止）命中 ${l1.length} 处：`);
  l1.forEach((h) => console.log(fmt(h)));
} else {
  console.log('一级（绝对禁止）命中 0 处 ✅');
}
if (l2.length) {
  console.log(`\n二级（灰区，需人工过一眼）命中 ${l2.length} 处：`);
  l2.forEach((h) => console.log(fmt(h)));
} else {
  console.log('二级（灰区）命中 0 处 ✅');
}

console.log('\n结果：%d 处一级 / %d 处二级', l1.length, l2.length);
process.exit(l1.length ? 1 : 0);
