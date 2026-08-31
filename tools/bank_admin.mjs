/**
 * 题库管理 CLI（本机专用，需 X-Bank-Key）—— 配合 Worker POST /api/bank/admin。
 *
 * 用途：
 *   - 设备超限后，对方无法在新设备加载，用本工具 unbind 清空该码的已绑设备，腾出名额；
 *   - delete 彻底删除某个验证码对应的题库（bank:<code> + bankmeta:<code>）。
 *
 * 用法：
 *   node tools/bank_admin.mjs <unbind|delete> <验证码> [--key KEY] [--url URL]
 *
 * 示例：
 *   node tools/bank_admin.mjs unbind aB3xK9mPq2wL8nTv --key xxxx
 *   BANK_UPLOAD_KEY=xxxx node tools/bank_admin.mjs delete aB3xK9mPq2wL8nTv
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'https://fwzy.ccwu.cc';

const argv = process.argv.slice(2);
const action = argv[0];
const code = argv[1];
let key = process.env.BANK_UPLOAD_KEY || '';
let url = DEFAULT_URL;

for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--key') key = argv[++i] || '';
  else if (argv[i] === '--url') url = argv[++i] || DEFAULT_URL;
}

function fail(msg) { console.error('错误：' + msg); process.exit(1); }

if (!action || (action !== 'unbind' && action !== 'delete')) {
  console.log('用法：node tools/bank_admin.mjs <unbind|delete> <验证码> [--key KEY] [--url URL]');
  process.exit(action ? 1 : 0);
}
if (!code || !/^[A-Za-z0-9]{4,32}$/.test(code)) fail('验证码格式不正确（4–32 位字母数字）。');
if (!key) fail('未提供密钥：用 --key <KEY> 或环境变量 BANK_UPLOAD_KEY。');

const endpoint = String(url).replace(/\/+$/, '') + '/api/bank/admin';
const what = action === 'unbind' ? '解绑设备' : '删除题库';
console.log('→ ' + what + '：' + code + '（' + endpoint + '）');

try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bank-Key': key.trim() },
    body: JSON.stringify({ action, code }),
  });
  if (res.status === 401) fail('密钥错误（401），无权操作。');
  if (!res.ok) {
    let msg = '';
    try { const d = await res.json(); msg = d.error || d.message || ''; } catch {}
    fail('操作失败（' + res.status + '）' + (msg ? '：' + msg : ''));
  }
  const data = await res.json();
  console.log('✓ 成功：' + (data.action === 'unbind' ? '已清空该验证码的已绑设备' : '已删除该题库（' + code + '）'));
  process.exit(0);
} catch (e) {
  if (e.cause && e.cause.code) fail('网络错误：' + e.cause.code + '（' + e.message + '）');
  fail('请求异常：' + e.message);
}
