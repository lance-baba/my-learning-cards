'use strict';
/*
 * sync_plan.js —— sync_kv.js 的纯逻辑层（工程评审 P1 #77：KV 同步原子化）
 *
 * 为什么抽出来：sync_kv.js 用 execSync 调 wrangler 真正写 KV，无法在单测里跑；
 * 把「顺序 / 校验 / 清理计划」三块纯逻辑抽到这里，既能在 Node 直接 import 单测，
 * 也让 sync_kv.js 的主流程变成「调纯函数 + 执行 wrangler」的薄壳。
 *
 * 原子化核心思想（Cloudflare KV 无事务，用「数据先于指针」模式）：
 *   - 先写所有 bundle 键（数据），最后才写 app:index（指针/目录）。
 *   - 前端只信任 app:index 来枚举 bundle；只要 index 是最后写入的，那么 index
 *     发布时它引用的每个 bundle 都已在 KV 中，不会出现「index 指向不存在的 bundle」。
 *   - 任一 bundle 写入失败 → 中止，绝不写 index，旧 index 继续指向旧（完好）bundle。
 *   残留风险只有跨边缘 KV 传播延迟（bundle 比 index 早写，传播已完成），可接受。
 *
 * 运行环境：根 package.json 非 type:module，按 CJS 解析（与 sync_kv.js 一致）。
 */
const fs = require('fs');
const path = require('path');

/**
 * 扫描 data/ 目录，收集待写入 KV 的条目。
 * 返回 [{ key, file, kind:'index'|'bundle', bundleId?, version?, error? }]
 * - key 为 null 表示该文件有问题（非法 JSON / 缺 bundle_id），由调用方决定如何处理。
 */
function collectEntries(dataDir) {
  const entries = [];
  const idxFile = path.join(dataDir, 'app_index.json');
  if (fs.existsSync(idxFile)) {
    entries.push({ key: 'app:index', file: idxFile, kind: 'index' });
  }

  for (const f of fs.readdirSync(dataDir)) {
    if (!/^bundle_.*\.json$/.test(f)) continue;
    const fp = path.join(dataDir, f);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
      entries.push({ key: null, file: fp, kind: 'bundle', error: 'invalid-json:' + e.message });
      continue;
    }
    if (!j.bundle_id) {
      entries.push({ key: null, file: fp, kind: 'bundle', error: 'missing-bundle_id' });
      continue;
    }
    entries.push({ key: j.bundle_id, file: fp, kind: 'bundle', bundleId: j.bundle_id, version: j.version });
  }
  return entries;
}

/**
 * 构建写入顺序：所有 bundle 在前（先写数据），app:index 在最后（后写指针）。
 * 纯函数，不读写磁盘。多个 index 条目一律排到末尾。
 */
function buildWriteOrder(entries) {
  const bundles = entries.filter((e) => e.kind === 'bundle' && e.key);
  const index = entries.filter((e) => e.kind === 'index');
  // 兜底：非 index 且 key 存在即视为数据键，排到前面
  const others = entries.filter((e) => e.kind !== 'bundle' && e.kind !== 'index' && e.key);
  return [...bundles, ...others, ...index];
}

/**
 * 本地一致性校验：index JSON 中每个分类引用的 bundle 键，必须都能在 bundleKeys 里找到。
 * 纯函数。返回 { ok, errors:[{msg}] }。
 * @param {object} indexJson  解析后的 app_index.json
 * @param {string[]} bundleKeys  本次将要写入的 bundle 键集合（如 ["bundle:science:v1"]）
 */
function validateLocalPlan(indexJson, bundleKeys) {
  const errors = [];
  if (!indexJson || typeof indexJson !== 'object') {
    errors.push('app:index 不是合法 JSON 对象');
    return { ok: false, errors };
  }
  const keySet = new Set(bundleKeys);
  const cats = Array.isArray(indexJson.categories) ? indexJson.categories : [];
  if (cats.length === 0) {
    errors.push('app:index 未包含任何 categories');
  }
  for (const c of cats) {
    const bs = Array.isArray(c.bundles) ? c.bundles : [];
    for (const b of bs) {
      if (!keySet.has(b)) {
        errors.push(`分类 ${c.id || '?'} 引用了不存在的 bundle 键：${b}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 计算待清理（prune）的 KV 键：所有 bundle:* 键中、未被新 index 引用的。
 * 纯函数。绝不返回非 bundle:* 键（避免误删 app:index 等）。
 * @param {string[]} allKvKeys  当前 KV 中全部键名
 * @param {string[]} referencedBundleKeys  新 index 引用的 bundle 键集合
 */
function planPrune(allKvKeys, referencedBundleKeys) {
  const ref = new Set(referencedBundleKeys);
  return allKvKeys.filter((k) => /^bundle:/.test(k) && !ref.has(k));
}

module.exports = { collectEntries, buildWriteOrder, validateLocalPlan, planPrune };
