/**
 * worker/ratelimit.js 单元测试（工程评审 P1 第 3 项「限流」配套）
 *
 * 验证 createRateLimiter 的「窗口内允许 max 次、超出返 429、窗口过期后重置、
 * 不同 IP 互不干扰」核心语义。时间通过注入 now 控制，避免真实 sleep。
 *
 * 运行：npm test
 * 依赖：零（Node 内置 assert + 与 observe.test.mjs 一致的极简封装）。
 */
import assert from 'node:assert/strict';
import { createRateLimiter } from '../worker/ratelimit.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};
const section = (s) => console.log('\n--- ' + s + ' ---');

section('基础语义：窗口内允许 max 次，超出返 false');
t('同一 IP 前 max 次均放行', () => {
  let clock = 1000;
  const lim = createRateLimiter({ windowMs: 60_000, max: 5, now: () => clock });
  for (let i = 0; i < 5; i++) assert.equal(lim.rateOk('1.2.3.4'), true);
});
t('第 max+1 次被拦截', () => {
  let clock = 1000;
  const lim = createRateLimiter({ windowMs: 60_000, max: 5, now: () => clock });
  for (let i = 0; i < 5; i++) lim.rateOk('1.2.3.4');
  assert.equal(lim.rateOk('1.2.3.4'), false);
});

section('隔离性：不同 IP 互不干扰');
t('IP-A 打满后，IP-B 仍可用', () => {
  let clock = 1000;
  const lim = createRateLimiter({ windowMs: 60_000, max: 3, now: () => clock });
  for (let i = 0; i < 3; i++) lim.rateOk('A');
  assert.equal(lim.rateOk('A'), false);
  assert.equal(lim.rateOk('B'), true);
});

section('窗口过期后自动重置');
t('时钟越过 resetAt 后，同一 IP 重新获得配额', () => {
  let clock = 1000;
  const lim = createRateLimiter({ windowMs: 60_000, max: 2, now: () => clock });
  lim.rateOk('X'); lim.rateOk('X');
  assert.equal(lim.rateOk('X'), false); // 窗口内打满
  clock = 1000 + 60_000 + 1; // 推进到窗口之外
  assert.equal(lim.rateOk('X'), true); // 重新计 1
  assert.equal(lim.rateOk('X'), true);
  assert.equal(lim.rateOk('X'), false); // 新一轮又打满
});

section('生产配置：/api/* 120/min 与 /api/log 20/min');
t('apiLimiter 第 120 次放行、第 121 次拦截', () => {
  let clock = 0;
  const lim = createRateLimiter({ windowMs: 60_000, max: 120, now: () => clock });
  for (let i = 0; i < 120; i++) assert.equal(lim.rateOk('ip'), true);
  assert.equal(lim.rateOk('ip'), false);
});
t('logLimiter 第 20 次放行、第 21 次拦截', () => {
  let clock = 0;
  const lim = createRateLimiter({ windowMs: 60_000, max: 20, now: () => clock });
  for (let i = 0; i < 20; i++) assert.equal(lim.rateOk('ip'), true);
  assert.equal(lim.rateOk('ip'), false);
});

section('未知/空 IP 兜底为字符串键，仍可计数');
t('undefined IP 不抛异常且能正常限速', () => {
  let clock = 0;
  const lim = createRateLimiter({ windowMs: 60_000, max: 1, now: () => clock });
  assert.equal(lim.rateOk(undefined), true);
  assert.equal(lim.rateOk(undefined), false);
});

console.log('\n合计 PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
