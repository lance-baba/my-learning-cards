/**
 * worker/observe.js 单元测试（项目首个自动化测试，工程评审 P0 第 4 项配套）
 *
 * 为什么先测这个文件：
 *   Sentry 转发是「线上才真正触发」的路径 —— 本地开发没有 DSN，永远走不到。
 *   如果不离线验证，等真出线上故障时才发现 envelope 格式或错误处理写错，
 *   就完全失去了监控的意义。这里用 mock fetch 覆盖全部分支。
 *
 * 运行：npm test
 * 依赖：零（Node 内置 assert + node:test 之外的极简封装），不需要 Vitest。
 *
 * 注意：Worker 是 ES Module（见 worker/package.json 的 type:module），
 *       所以本文件后缀必须是 .mjs，且用 import 而非 require。
 */
import assert from 'node:assert/strict';
import { parseSentryDsn, captureException, requestId } from '../worker/observe.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};
const section = (s) => console.log('\n--- ' + s + ' ---');

/** 临时替换 globalThis.fetch，执行 fn 后恢复 */
async function withFetch(mock, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

// observe.js 未捕获异常时会打结构化日志，测试期静音，保持输出可读
const origErr = console.error, origWarn = console.warn;
console.error = () => {}; console.warn = () => {};

section('parseSentryDsn');
t('合法 DSN 解析出正确的 envelope endpoint', () => {
  const r = parseSentryDsn('https://abc123def@o4507.ingest.sentry.io/6789');
  assert.equal(r.projectId, '6789');
  assert.equal(r.publicKey, 'abc123def');
  assert.equal(r.endpoint,
    'https://o4507.ingest.sentry.io/api/6789/envelope/?sentry_key=abc123def&sentry_version=7');
});
t('自托管 Sentry（带端口）也能解析', () => {
  const r = parseSentryDsn('http://key@10.0.0.5:9000/12');
  assert.equal(r.endpoint, 'http://10.0.0.5:9000/api/12/envelope/?sentry_key=key&sentry_version=7');
});
t('空 / 非法 DSN 返回 null（不抛异常）', () => {
  assert.equal(parseSentryDsn(''), null);
  assert.equal(parseSentryDsn(null), null);
  assert.equal(parseSentryDsn('not-a-url'), null);
  assert.equal(parseSentryDsn('https://noprojectid@ingest.sentry.io/'), null);
});

section('requestId');
t('返回 16 位十六进制且每次不同', () => {
  assert.match(requestId(), /^[0-9a-f]{16}$/);
  assert.notEqual(requestId(), requestId());
});

section('captureException：未配置 DSN（降级为只落日志）');
let noDsnCalled = false;
const r1 = await withFetch(() => { noDsnCalled = true; throw new Error('不应发起请求'); },
  () => captureException({}, new Error('boom'), { rid: 'test' }));
t('sent=false，且绝不发起网络请求', () => {
  assert.equal(r1.sent, false);
  assert.equal(r1.reason, 'SENTRY_DSN 未配置');
  assert.equal(noDsnCalled, false);
});

section('captureException：配置 DSN（转发 Sentry）');
let cap = null;
const r2 = await withFetch(async (u, o) => { cap = { url: u, opt: o }; return { ok: true, status: 200 }; },
  () => captureException({ SENTRY_DSN: 'https://pk@o1.ingest.sentry.io/42', APP_VERSION: '1.2.3' },
    new Error('real boom'), { rid: 'rid123', path: '/api/x' }));
t('sent=true 并返回 32 位 event_id', () => {
  assert.equal(r2.sent, true);
  assert.match(r2.event_id, /^[0-9a-f]{32}$/);
});
t('请求打到 envelope endpoint', () => {
  assert.equal(cap.url,
    'https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=pk&sentry_version=7');
});
t('Content-Type 为 application/x-sentry-envelope', () => {
  assert.equal(cap.opt.headers['Content-Type'], 'application/x-sentry-envelope');
});
t('envelope 三行结构：header / item header / payload', () => {
  const lines = cap.opt.body.split('\n');
  assert.equal(lines.length, 3);
  const head = JSON.parse(lines[0]);
  assert.equal(head.event_id, r2.event_id);
  assert.ok(head.sent_at, 'sent_at 必须存在');
  assert.deepEqual(JSON.parse(lines[1]), { type: 'event' });
  const ev = JSON.parse(lines[2]);
  assert.equal(ev.exception.values[0].value, 'real boom');
  assert.equal(ev.release, '1.2.3');
  assert.equal(ev.extra.rid, 'rid123');
  assert.equal(ev.extra.path, '/api/x');
  assert.equal(ev.environment, 'production');
});

section('captureException：Sentry 不可达（绝不能影响业务）');
const r3 = await withFetch(async () => { throw new Error('network down'); },
  () => captureException({ SENTRY_DSN: 'https://pk@o1.ingest.sentry.io/42' }, new Error('x'), {}));
t('fetch 抛错时返回 sent=false 而不是抛出', () => {
  assert.equal(r3.sent, false);
  assert.equal(r3.reason, 'network down');
});
const r4 = await withFetch(async () => ({ ok: false, status: 429 }),
  () => captureException({ SENTRY_DSN: 'https://pk@o1.ingest.sentry.io/42' }, new Error('x'), {}));
t('Sentry 返回 429 时返回 sent=false 并记 HTTP 429', () => {
  assert.equal(r4.sent, false);
  assert.equal(r4.reason, 'HTTP 429');
});

section('负载上限');
let bigBody = '';
await withFetch(async (u, o) => { bigBody = o.body; return { ok: true, status: 200 }; },
  () => captureException({ SENTRY_DSN: 'https://pk@o1.ingest.sentry.io/42' },
    { name: 'E', message: 'x'.repeat(5000) }, {}));
t('超长 message 截断到 2000 字符以内', () => {
  const ev = JSON.parse(bigBody.split('\n')[2]);
  assert.ok(ev.exception.values[0].value.length <= 2000);
});

console.error = origErr; console.warn = origWarn;
console.log('\n合计 PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
