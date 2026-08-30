/* #82 SW 缓存治理纯逻辑单测（零依赖，node:assert/strict）
 * 覆盖：compareVersion（语义化版本比较）、selectStaleBundleKeys（旧 bundle 版本回收选择）。
 * 风格与 observe.test.mjs / cardflow-logic.test.mjs 一致。
 */
import assert from 'node:assert/strict';
// sw_cache.js 是 UMD（module.exports = mod，根 package.json 非 type:module → 按 CJS 解析），
// 与 cardflow-logic.js 同形，故用默认导入后解构，复用 cjs-module-lexer 的兼容路径。
import SwCache from '../public/sw_cache.js';
const { compareVersion, selectStaleBundleKeys } = SwCache;

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + name + '\n    ' + (e && e.message));
  }
}

console.log('compareVersion:');
t('相等版本返回 0', () => {
  assert.equal(compareVersion('2026.08.28.01', '2026.08.28.01'), 0);
});
t('较新版本返回 1', () => {
  assert.equal(compareVersion('2026.08.29.01', '2026.08.28.01'), 1);
});
t('较旧版本返回 -1', () => {
  assert.equal(compareVersion('2026.08.28.01', '2026.08.29.01'), -1);
});
t('0-padding 下仍正确（.10 > .01）', () => {
  assert.equal(compareVersion('2026.08.28.10', '2026.08.28.01'), 1);
});
t('段数不同按数值补齐比较（2026 > 2026.08 视作相等前缀、长段更大）', () => {
  assert.equal(compareVersion('2026.08.28', '2026.08'), 1);
});
t('缺省 a 视为更小', () => {
  assert.equal(compareVersion(null, '1'), -1);
});
t('缺省 b 视为更小', () => {
  assert.equal(compareVersion('1', null), 1);
});

console.log('selectStaleBundleKeys:');
t('单版本单 id：无需删除', () => {
  const entries = [{ id: 'bundle:science:v1', v: '2026.08.28.01', key: 'k1' }];
  assert.deepEqual(selectStaleBundleKeys(entries, 1), []);
});
t('同 id 两版本 keep=1：删除较旧的', () => {
  const entries = [
    { id: 'bundle:science:v1', v: '2026.08.28.01', key: 'old' },
    { id: 'bundle:science:v1', v: '2026.08.29.01', key: 'new' },
  ];
  assert.deepEqual(selectStaleBundleKeys(entries, 1), ['old']);
});
t('同 id 三版本 keep=1：仅留最新，删两个旧', () => {
  const entries = [
    { id: 'bundle:science:v1', v: '2026.08.27.01', key: 'a' },
    { id: 'bundle:science:v1', v: '2026.08.29.01', key: 'c' },
    { id: 'bundle:science:v1', v: '2026.08.28.01', key: 'b' },
  ];
  const del = selectStaleBundleKeys(entries, 1);
  assert.deepEqual(del.sort(), ['a', 'b']);
});
t('不同 id 互不干扰', () => {
  const entries = [
    { id: 'bundle:science:v1', v: '2026.08.28.01', key: 's-old' },
    { id: 'bundle:science:v1', v: '2026.08.29.01', key: 's-new' },
    { id: 'bundle:math:v1', v: '2026.08.28.01', key: 'm-old' },
    { id: 'bundle:math:v1', v: '2026.08.29.01', key: 'm-new' },
  ];
  const del = selectStaleBundleKeys(entries, 1);
  assert.deepEqual(del.sort(), ['m-old', 's-old']);
});
t('缺 id 的条目被忽略', () => {
  const entries = [
    { id: null, v: '2026.08.28.01', key: 'x' },
    { id: 'bundle:science:v1', v: '2026.08.28.01', key: 'old' },
    { id: 'bundle:science:v1', v: '2026.08.29.01', key: 'new' },
  ];
  assert.deepEqual(selectStaleBundleKeys(entries, 1), ['old']);
});
t('keepPerId=2 时三版本只删最旧', () => {
  const entries = [
    { id: 'bundle:science:v1', v: '2026.08.27.01', key: 'a' },
    { id: 'bundle:science:v1', v: '2026.08.28.01', key: 'b' },
    { id: 'bundle:science:v1', v: '2026.08.29.01', key: 'c' },
  ];
  assert.deepEqual(selectStaleBundleKeys(entries, 2), ['a']);
});

console.log(`\n${fail ? '✗' : '✓'} sw_cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
