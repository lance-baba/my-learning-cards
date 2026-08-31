/**
 * 本地上传题库工具 —— 只能在「本机 / 本机程序」运行，绝不在网页上留任何上传接口。
 *
 * 调用 Worker 的 POST /api/bank（需 X-Bank-Key 上传密钥），成功后返回 16 位验证码，
 * 对方在 exam.html 首页「输入验证码」处填入即可加载本题库（替换内置地基题库）。
 *
 * 设计边界（用户拍板）：
 *   - 网页端只保留「验证码加载」入口（exam.js 的 loadByCode）；
 *   - 上传（发布新题库）只能由本机程序完成，密钥不放进任何网页/前端代码；
 *   - 后端 Worker 的 /api/bank 始终需要正确的 X-Bank-Key，否则 401。
 *
 * 用法：
 *   node tools/upload_bank.mjs <题库JSON路径> [选项]
 *
 * 选项：
 *   --key <KEY>      上传密钥（也可走环境变量 BANK_UPLOAD_KEY）
 *   --url <URL>      Worker 地址，默认 https://fwzy.ccwu.cc
 *                    （workers.dev 备选：https://cardflow.huqihang1990.workers.dev）
 *
 * 示例：
 *   BANK_UPLOAD_KEY=xxxx node tools/upload_bank.mjs public/exam/questions.json
 *   node tools/upload_bank.mjs ./my-bank.json --key xxxx --url https://fwzy.ccwu.cc
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_URL = 'https://fwzy.ccwu.cc';

// ---- 解析命令行 ----
const argv = process.argv.slice(2);
let file = null;
let key = process.env.BANK_UPLOAD_KEY || '';
let url = DEFAULT_URL;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--key') { key = argv[++i] || ''; }
  else if (a === '--url') { url = argv[++i] || DEFAULT_URL; }
  else if (!file && !a.startsWith('--')) { file = a; }
  else if (a === '--help' || a === '-h') {
    console.log('用法：node tools/upload_bank.mjs <题库JSON路径> [--key KEY] [--url URL]');
    process.exit(0);
  }
}

function fail(msg) {
  console.error('错误：' + msg);
  process.exit(1);
}

if (!file) fail('缺少题库 JSON 路径。用法见文件头注释或加 --help。');
if (!fs.existsSync(file)) fail('文件不存在：' + file);
if (!key) fail('未提供上传密钥：用 --key <KEY> 或设置环境变量 BANK_UPLOAD_KEY（需先在 Worker 上 `wrangler secret put BANK_UPLOAD_KEY`）。');

// ---- 读取并本地预校验（失败早、报错清，避免把脏数据甩给服务端拿 400）----
let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { fail('读取失败：' + e.message); }

let bank;
try { bank = JSON.parse(raw); }
catch (e) { fail('JSON 解析失败：' + e.message); }

if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) {
  fail('题库格式不正确：需含非空的 questions 数组（与 public/exam/questions.json 同结构）。');
}

const endpoint = String(url).replace(/\/+$/, '') + '/api/bank';
console.log('→ 上传到：' + endpoint);
console.log('→ 题库：' + file + '（' + bank.questions.length + ' 题' + (bank.title ? '，标题「' + bank.title + '」' : '') + '）');

try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bank-Key': key.trim() },
    body: raw,
  });

  if (res.status === 401) fail('上传密钥错误（401 Unauthorized），无权发布。请检查 --key / BANK_UPLOAD_KEY 是否与 Worker 的 BANK_UPLOAD_KEY 一致。');
  if (res.status === 429) fail('限流（429 Too Many Requests）：每 IP 每分钟最多 10 次，请稍后再试。');
  if (res.status === 413) fail('题库过大（413）：需 ≤1MB，请精简后重试。');
  if (res.status === 400) fail('题库被拒（400）：服务端校验未通过，确认 questions 为非空数组且为合法 JSON。');
  if (!res.ok) fail('服务端返回 ' + res.status + '，上传失败。');

  const data = await res.json();
  if (!data || !data.code) fail('响应异常：未返回验证码。');

  console.log('');
  console.log('✓ 上传成功！验证码：');
  console.log('  ' + data.code);
  console.log('');
  console.log('把该验证码发给对方，对方在 exam.html 首页「题库管理 → 输入验证码」处填入即可加载本题库。');
  console.log('（替换的是内置「地基题库」；对方点「恢复内置题库」可切回。）');
  process.exit(0);
} catch (e) {
  if (e.cause && e.cause.code) fail('网络错误：' + e.cause.code + '（' + e.message + '）');
  fail('请求异常：' + e.message);
}
