/**
 * 把 learnST 的题库转成 CardFlow 考试模块用的标准 JSON。
 *
 * 源：D:\项目开发\小树学习\questions\ch1.js ~ ch8.js
 *     格式 window.CHn = [ {ch,type,num,diff,q,opts,ans}, ... ]（JS 字面量，非严格 JSON）
 * 产出：public/exam/questions.json
 *     { version, title, chapters, shortNames, questions: [...] }
 *
 * 为什么不用 eval：源文件是本地可信文件，但 new Function 会执行任意代码，
 * 这里改用「剥壳 + JSON.parse」，既安全又能在数据格式变化时立刻报错。
 *
 * 用法：node tools/build_exam_bank.mjs [源目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.argv[2] || 'D:/项目开发/小树学习/questions';
const OUT_DIR = path.join(__dirname, '..', 'public', 'exam');

const CH_FILES = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ch7', 'ch8'];

// 章节短名：原项目的 getShortName 会产生「基础基础」「与复合地基静荷载」这类怪值，
// 这里直接手工指定可读的短名，避免把 bug 一起移植过来。
const SHORT_NAMES = {
  地基基础基本知识: '基本知识',
  地基与复合地基静荷载试验: '地基静载',
  基桩低应变反射波法检测: '低应变',
  基桩高应变法检测: '高应变',
  基桩静荷载试验: '静荷载',
  基桩声波透射法检测: '声波透射',
  锚杆试验: '锚杆',
  钻芯法检测: '钻芯法',
};

function extractArray(code, varName) {
  const marker = `window.${varName} =`;
  const at = code.indexOf(marker);
  if (at < 0) throw new Error(`${varName}: 找不到 ${marker}`);
  const start = code.indexOf('[', at);
  if (start < 0) throw new Error(`${varName}: 找不到数组起始`);
  // 从起始括号配对扫描，遇到字符串内的括号要跳过
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`${varName}: 括号未配对`);
}

const all = [];
const chapterOrder = [];
const stats = { type: {}, diff: {}, optCount: {} };
let skipped = 0;

for (const name of CH_FILES) {
  const file = path.join(SRC_DIR, `${name}.js`);
  if (!fs.existsSync(file)) {
    console.warn(`[跳过] 文件不存在：${file}`);
    continue;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const arrStr = extractArray(raw, name.toUpperCase());
  let arr;
  try {
    arr = JSON.parse(arrStr);
  } catch (e) {
    // 少数 JS 字面量带尾逗号或单引号，退回到宽松解析（仅本地可信文件）
    arr = JSON.parse(arrStr.replace(/,(\s*[\]}])/g, '$1'));
  }
  for (const q of arr) {
    // 结构校验：缺任何一个字段都会让前端渲染崩掉，宁可跳过并报警
    if (!q || typeof q.q !== 'string' || !q.q.trim() || !q.ans || !q.ch || !q.type) {
      skipped++;
      console.warn(`[跳过] ${name} 结构不完整：`, JSON.stringify(q).slice(0, 120));
      continue;
    }
    if (!q.opts || Object.keys(q.opts).length === 0) {
      skipped++;
      console.warn(`[跳过] ${name} 无选项：${q.q.slice(0, 40)}`);
      continue;
    }
    all.push({
      ch: q.ch,
      type: q.type,
      num: q.num,
      diff: q.diff || '简单题',
      q: q.q,
      opts: q.opts,
      ans: String(q.ans).trim(),
    });
    if (!chapterOrder.includes(q.ch)) chapterOrder.push(q.ch);
    stats.type[q.type] = (stats.type[q.type] || 0) + 1;
    stats.diff[q.diff || '简单题'] = (stats.diff[q.diff || '简单题'] || 0) + 1;
    const n = Object.keys(q.opts).length;
    stats.optCount[n] = (stats.optCount[n] || 0) + 1;
  }
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const payload = {
  version: '20260622',
  title: '地基基础检测备考题库',
  chapters: chapterOrder,
  shortNames: Object.fromEntries(chapterOrder.map((c) => [c, SHORT_NAMES[c] || c])),
  questions: all,
};

const outFile = path.join(OUT_DIR, 'questions.json');
fs.writeFileSync(outFile, JSON.stringify(payload), 'utf8');

const bytes = fs.statSync(outFile).size;
console.log('--- 题库转换完成 ---');
console.log('输出：', outFile);
console.log('题数：', all.length, '（跳过', skipped, '）');
console.log('章节：', chapterOrder.length, chapterOrder.join(' / '));
console.log('题型：', stats.type);
console.log('难度：', stats.diff);
console.log('选项数分布：', stats.optCount);
console.log('体积：', (bytes / 1024).toFixed(1), 'KB（未压缩）');
