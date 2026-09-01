/**
 * 题库发布器（KV 直写）—— 绕过 HTTP 上传通道，用 wrangler 直接把题库写进真实 KV。
 *
 * 背景：沙箱/CI 的代理不放行自定域与 workers.dev（tunnel 502），
 * `POST /api/bank` 在这些环境不可达；但 wrangler 自身网络（api.cloudflare.com）是通的。
 * 网页端「输入验证码加载」读取的就是 KV 的 `bank:<code>`，直写后效果与上传接口完全等价。
 *
 * 用法：
 *   node tools/publish_bank.mjs <题库JSON> [选项]
 *
 * 选项：
 *   --max-devices <N>   私有分发：验证码最多绑 N 台设备（0=不限制，1~50）
 *   --note <TEXT>       备注（写入 bankmeta 与本地清单）
 *   --namespace-id <ID> KV namespace（默认从 wrangler.toml 读取 CARD_KV 的 id）
 *
 * 与 POST /api/bank 的差异：
 *   - 无 X-Bank-Key 校验与限流（鉴权换成了本机的 CF OAuth 登录态，等同强度）；
 *   - total/types 由本脚本本地统计（服务端入库时也是这两项，形状一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const WRANGLER = path.join(PROJECT_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// ---- 参数 ----
const argv = process.argv.slice(2);
let file = null;
let maxDevices = 0;
let note = '';
let nsOverride = '';

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--max-devices') maxDevices = parseInt(argv[++i], 10) || 0;
  else if (a === '--note') note = argv[++i] || '';
  else if (a === '--namespace-id') nsOverride = argv[++i] || '';
  else if (a === '--help' || a === '-h') {
    console.log('用法：node tools/publish_bank.mjs <题库JSON> [--max-devices N] [--note 文本] [--namespace-id ID]');
    process.exit(0);
  } else if (!file && !a.startsWith('--')) file = a;
}

function fail(msg) {
  console.error('错误：' + msg);
  process.exit(1);
}

if (!file) fail('缺少题库 JSON 路径。用法：node tools/publish_bank.mjs <题库JSON> [--max-devices N] [--note 文本]');
if (!fs.existsSync(file)) fail('文件不存在：' + file);
if (!fs.existsSync(WRANGLER)) fail('找不到 wrangler：' + WRANGLER + '（先在项目里 npm install）');

// ---- 读取 + 校验 + 清洗（与服务端入库形状对齐）----
let bank;
try { bank = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { fail('JSON 解析失败：' + e.message); }
if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) {
  fail('题库格式不正确：需含非空 questions 数组。');
}

const types = {};
for (const q of bank.questions) {
  const t = String(q.type || '未知');
  types[t] = (types[t] || 0) + 1;
}
if (!Number.isFinite(maxDevices) || maxDevices < 0) maxDevices = 0;
if (maxDevices > 50) maxDevices = 50;

const code = crypto.randomBytes(16).toString('hex').slice(0, 16); // 16 位不可猜测
const value = JSON.stringify({
  title: String(bank.title || '').slice(0, 80),
  version: String(bank.version || code).slice(0, 40),
  chapters: Array.isArray(bank.chapters) ? bank.chapters : [],
  shortNames: bank.shortNames && typeof bank.shortNames === 'object' ? bank.shortNames : {},
  questions: bank.questions,
  total: bank.questions.length,
  types,
});
if (Buffer.byteLength(value, 'utf8') > 1_000_000) {
  fail('题库体积超过 1MB（KV 上限），请精简。');
}

// ---- namespace id：优先参数，其次 wrangler.toml ----
let nsId = nsOverride;
if (!nsId) {
  const toml = fs.readFileSync(path.join(PROJECT_ROOT, 'wrangler.toml'), 'utf8');
  const m = toml.match(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"CARD_KV"[\s\S]*?id\s*=\s*"([0-9a-f]+)"/)
    || toml.match(/id\s*=\s*"([0-9a-f]{32})"/);
  if (!m) fail('无法从 wrangler.toml 解析 CARD_KV 的 namespace id，请用 --namespace-id 指定。');
  nsId = m[1];
}

// ---- 写 KV ----
function kvPut(key, valueStr) {
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'cfkv-'));
  const tmpFile = path.join(tmpDir, 'value.txt');
  fs.writeFileSync(tmpFile, valueStr, 'utf8');
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', 'key', 'put', key, '--path', tmpFile,
    '--namespace-id', nsId, '--remote'], { encoding: 'utf8', timeout: 120_000 });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (r.status !== 0) {
    fail(`写 KV 失败（exit ${r.status}）：${key}\n${(r.stderr || r.stdout || '').slice(-800)}`);
  }
}

console.log('→ 发布题库到 KV（绕过 HTTP 上传通道，走 wrangler + CF API）');
console.log(`→ 题库：${file}（${bank.questions.length} 题${bank.title ? '，标题「' + bank.title + '」' : ''}${maxDevices > 0 ? '，设备上限 ' + maxDevices + ' 台' : ''}）`);

kvPut('bank:' + code, value);
if (maxDevices > 0) {
  const meta = JSON.stringify({
    maxDevices, boundDevices: [], note: String(note || '').slice(0, 200),
    title: String(bank.title || '').slice(0, 80), total: bank.questions.length, types,
    createdAt: Date.now(),
  });
  kvPut('bankmeta:' + code, meta);
}

const typeStr = Object.keys(types).map((t) => t + ' ' + types[t]).join(' / ') || '（无）';
console.log('');
console.log('✓ 发布成功！验证码： ' + code);
if (bank.title) console.log('  题库：' + bank.title);
console.log('  题数：' + bank.questions.length);
console.log('  题型：' + typeStr);
console.log('  设备上限：' + (maxDevices > 0 ? maxDevices + ' 台' : '不限制'));
console.log('');
console.log('对方在 exam.html 首页「题库管理 → 输入验证码」填入即可加载（替换内置地基题库）。');

// ---- 本地清单（与 upload_bank.mjs 同一份 codes_manifest.json）----
const manifestPath = path.join(PROJECT_ROOT, 'codes_manifest.json');
let list = [];
try { if (fs.existsSync(manifestPath)) list = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { list = []; }
if (!Array.isArray(list)) list = [];
const entry = {
  code, title: String(bank.title || ''), total: bank.questions.length, types,
  maxDevices, note: note || '', file, source: 'kv-direct', createdAt: new Date().toISOString(),
};
const idx = list.findIndex((e) => e.code === entry.code);
if (idx >= 0) list[idx] = entry; else list.push(entry);
fs.writeFileSync(manifestPath, JSON.stringify(list, null, 2), 'utf8');
console.log('（已记入本地清单 codes_manifest.json，共 ' + list.length + ' 个题库）');
