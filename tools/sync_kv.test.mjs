/**
 * tools/sync_plan.js 单元测试（工程评审 P1 #77：KV 同步原子化纯逻辑）
 *
 * 为什么抽出来单测：sync_kv.js 用 execSync 调 wrangler 真实写 KV，无法在单测里跑；
 * 把『写入顺序 / 本地一致性校验 / prune 计划』三块纯逻辑抽到 sync_plan.js，本文件覆盖。
 *
 * 运行：npm run test:unit   （或 npm test 一并跑 observe/cardflow-logic/ratelimit）
 * 依赖：零（Node 内置 assert + 极简 t() 封装，与既有 *.test.mjs 一致）。
 */
import assert from 'node:assert/strict';
import { buildWriteOrder, validateLocalPlan, planPrune } from '../tools/sync_plan.js';

let pass = 0,
  fail = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log('PASS  ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL  ' + name + '  ->  ' + e.message);
    fail++;
  }
};

// ---- buildWriteOrder：原子化核心不变量「先写 bundle 数据，最后写 app:index 指针」----
t('buildWriteOrder: index 始终排在所有 bundle 之后', () => {
  const entries = [
    { key: 'app:index', kind: 'index' },
    { key: 'bundle:science:v2', kind: 'bundle' },
    { key: 'bundle:geo:v2', kind: 'bundle' },
  ];
  const order = buildWriteOrder(entries);
  assert.equal(order[order.length - 1].key, 'app:index');
  assert.ok(order.filter((e) => e.kind === 'bundle').length === 2);
  assert.ok(order[0].kind === 'bundle');
});

t('buildWriteOrder: 仅单个 index 时也安全（排末尾）', () => {
  const order = buildWriteOrder([{ key: 'app:index', kind: 'index' }]);
  assert.equal(order.length, 1);
  assert.equal(order[0].key, 'app:index');
});

t('buildWriteOrder: 非 bundle/非 index 的 key 排在 index 前', () => {
  const order = buildWriteOrder([
    { key: 'app:index', kind: 'index' },
    { key: 'bundle:x', kind: 'bundle' },
    { key: 'meta:foo', kind: 'meta' },
  ]);
  assert.equal(order[order.length - 1].key, 'app:index');
  assert.ok(order.includes(order.find((e) => e.key === 'meta:foo')));
});

// ---- validateLocalPlan：index↔bundle 引用完整性 ----
t('validateLocalPlan: index 引用全部存在的 bundle 时通过', () => {
  const indexJson = { categories: [{ id: 'science', bundles: ['bundle:science:v1'] }] };
  const { ok, errors } = validateLocalPlan(indexJson, ['bundle:science:v1']);
  assert.equal(ok, true);
  assert.equal(errors.length, 0);
});

t('validateLocalPlan: index 引用缺失 bundle 时报错', () => {
  const indexJson = { categories: [{ id: 'science', bundles: ['bundle:science:v1', 'bundle:ghost:v1'] }] };
  const { ok, errors } = validateLocalPlan(indexJson, ['bundle:science:v1']);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('bundle:ghost:v1')));
});

t('validateLocalPlan: index 非对象 / 无 categories 时报错', () => {
  assert.equal(validateLocalPlan(null, []).ok, false);
  assert.equal(validateLocalPlan({}, []).ok, false); // 无 categories
  assert.equal(validateLocalPlan({ categories: [] }, []).ok, false); // 空 categories
});

// ---- planPrune：只删未引用的 bundle:* 键，绝不误删 app:index 等 ----
t('planPrune: 删除未引用的 bundle 键，保留被引用的与 app:index', () => {
  const all = ['app:index', 'bundle:science:v1', 'bundle:science:v0', 'bundle:geo:v1', 'meta:foo'];
  const refs = ['bundle:science:v1', 'bundle:geo:v1'];
  const del = planPrune(all, refs);
  assert.deepEqual(del, ['bundle:science:v0']);
});

t('planPrune: 全部被引用时无待删', () => {
  const all = ['app:index', 'bundle:science:v1', 'bundle:geo:v1'];
  assert.deepEqual(planPrune(all, ['bundle:science:v1', 'bundle:geo:v1']), []);
});

t('planPrune: 不返回任何非 bundle:* 键', () => {
  const all = ['app:index', 'bundle:old:v1', 'meta:foo', 'config:x'];
  const del = planPrune(all, []);
  assert.ok(del.every((k) => k.startsWith('bundle:')));
  assert.ok(!del.includes('app:index'));
  assert.ok(!del.includes('meta:foo'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
