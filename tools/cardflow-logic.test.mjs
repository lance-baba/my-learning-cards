/**
 * public/cardflow-logic.js 单元测试（工程评审 P1 #73：核心纯函数覆盖）
 *
 * 为什么抽出来单测：
 *   原 4 个纯函数嵌在 app.js（Vue 全局脚本）里，无法被 Node 直接 import。
 *   已抽离到 cardflow-logic.js（UMD：浏览器挂 window.CardFlowLogic，
 *   Node 走 module.exports，根 package.json 非 type:module 故按 CJS 解析）。
 *
 * 运行：npm run test:unit   （也可 npm test 一并跑 observe.test.mjs）
 * 依赖：零（Node 内置 assert + 极简 t() 封装，与 observe.test.mjs 一致）。
 *
 * 说明：本环境沙箱会杀掉 npm install，无法装 Vitest，故沿用项目已有的
 *       node:test 风格（零依赖）。若日后本地 npm i -D vitest，
 *       可把本文件改成 import { describe, it } from 'vitest' 即可平滑迁移。
 */
import assert from 'node:assert/strict';
import CardFlowLogic from '../public/cardflow-logic.js';

const { isVersionGt, mixTopics, resolveLayout, weightedOrder } = CardFlowLogic;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '  -> ' + e.message); fail++; }
};

// ---------------------------------------------------------------------------
section('isVersionGt');
t('a 严格大于 b 返回 true', () => assert.equal(isVersionGt('1.0.1', '1.0.0'), true));
t('a 小于 b 返回 false', () => assert.equal(isVersionGt('1.0.0', '1.0.1'), false));
t('跨段比较 2.0 > 1.9.9', () => assert.equal(isVersionGt('2.0', '1.9.9'), true));
t('相等返回 false（非严格大于）', () => assert.equal(isVersionGt('1.0.0', '1.0.0'), false));
t('缺失任一版本返回 false（防 min_app_version 误判）', () => {
  assert.equal(isVersionGt(null, '1.0.0'), false);
  assert.equal(isVersionGt('1.0.0', null), false);
  assert.equal(isVersionGt('', '1.0.0'), false);
});
t('按段数值比较：1.10 > 1.2（不是字符串比较）', () => {
  assert.equal(isVersionGt('1.10', '1.2'), true);
  assert.equal(isVersionGt('1.2', '1.10'), false);
});

// ---------------------------------------------------------------------------
section('mixTopics（relax_ratio 穿插放松卡）');
const mk = (id, type) => ({ id, type });
const sample = [
  mk('s1', 'qa'), mk('s2', 'qa'), mk('s3', 'qa'),
  mk('f1', 'joke'), mk('f2', 'joke'),
];
t('无放松卡时原样返回学习卡', () => {
  const out = mixTopics([mk('s1', 'qa'), mk('s2', 'qa')], 5);
  assert.deepEqual(out.map((x) => x.id), ['s1', 's2']);
});
t('ratio=2 时每 2 张学习卡插 1 张放松卡', () => {
  const out = mixTopics(sample, 2).map((x) => x.id);
  assert.deepEqual(out, ['s1', 's2', 'f1', 's3', 'f2']);
});
t('学习卡相对顺序保持不变', () => {
  const out = mixTopics(sample, 2).map((x) => x.id);
  assert.deepEqual(out.filter((id) => id.startsWith('s')), ['s1', 's2', 's3']);
});
t('放松卡总数守恒（不丢不重）', () => {
  const out = mixTopics(sample, 3);
  assert.equal(out.filter((x) => x.type === 'joke').length, 2);
  assert.equal(new Set(out.map((x) => x.id)).size, 5); // 无重复
});
t('ratio 非法（0/falsy）兜底为 5，放松卡沉底', () => {
  const out = mixTopics(sample, 0).map((x) => x.id);
  assert.deepEqual(out, ['s1', 's2', 's3', 'f1', 'f2']);
});
t('放松卡多于间隔时兜底全部追加，不丢', () => {
  const many = [mk('s1', 'qa'), mk('f1', 'joke'), mk('f2', 'joke'), mk('f3', 'joke')];
  const out = mixTopics(many, 1).map((x) => x.id);
  // ratio=1 -> 每张学习卡后都插一张，f3 在循环结束后兜底
  assert.deepEqual(out, ['s1', 'f1', 'f2', 'f3']);
});

// ---------------------------------------------------------------------------
section('resolveLayout（layout -> 组件名）');
t('已知 layout 映射到组件名', () => {
  assert.equal(resolveLayout('qa_card'), 'qa-card');
  assert.equal(resolveLayout('flip_card'), 'flip-card');
  assert.equal(resolveLayout('streaming_text'), 'stream-card');
  assert.equal(resolveLayout('joke_text'), 'joke-card');
  assert.equal(resolveLayout('meme_card'), 'meme-card');
  assert.equal(resolveLayout('game_card'), 'game-card');
  assert.equal(resolveLayout('list_card'), 'list-card');
  assert.equal(resolveLayout('quote_card'), 'quote-card');
  assert.equal(resolveLayout('compare_card'), 'compare-card');
});
t('未知 layout 兜底 qa-card', () => {
  assert.equal(resolveLayout('unknown_layout'), 'qa-card');
  assert.equal(resolveLayout(null), 'qa-card');
  assert.equal(resolveLayout(''), 'qa-card');
});

// ---------------------------------------------------------------------------
section('weightedOrder（曝光加权混排，注入 exposure + rng 固定输出）');
t('长度与元素集合不变（无丢无重）', () => {
  const topics = [mk('A', 'qa'), mk('B', 'qa'), mk('C', 'qa')];
  const out = weightedOrder(topics);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => x.id).sort(), ['A', 'B', 'C']);
});
t('全部未看 + 固定 rng 时顺序稳定（V8 稳定排序）', () => {
  const topics = [mk('A', 'qa'), mk('B', 'qa'), mk('C', 'qa')];
  const out = weightedOrder(topics, {}, () => 0.5); // jitter 恒=1.0，权重全相等
  assert.deepEqual(out.map((x) => x.id), ['A', 'B', 'C']);
});
t('看过的卡（seen 大）权重低，沉到末尾', () => {
  const topics = [mk('A', 'qa'), mk('B', 'qa'), mk('C', 'qa')];
  const exposure = { B: { seen: 10, last: Date.now() } }; // B 看过很多次
  const out = weightedOrder(topics, exposure, () => 0.5);
  assert.equal(out[0].id, 'B'); // 权重最低，排最前（数组升序）
  assert.deepEqual(out.map((x) => x.id).sort(), ['A', 'B', 'C']); // 集合不变
});
t('缺省参数（无注入）不抛错且返回同长度', () => {
  const topics = [mk('A', 'qa'), mk('B', 'qa')];
  const out = weightedOrder(topics); // 走 localStorage + Math.random
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
console.log('\n合计 PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);

function section(name) { console.log('\n[' + name + ']'); }
