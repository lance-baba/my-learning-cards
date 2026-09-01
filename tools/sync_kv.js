#!/usr/bin/env node
'use strict';
/*
 * sync_kv.js —— 把 data/ 下所有卡片 JSON 一键同步进 Cloudflare KV。
 * 语义就是「名称(键) ← 值(JSON内容)」：重跑即把值替换掉，无需重新部署。
 *
 * 原子化（#77）：Cloudflare KV 无事务。采用「数据先于指针」模式 ——
 *   先写所有 bundle 键，最后才写 app:index（前端只信任 index 枚举 bundle）。
 *   这样 index 发布时它引用的每个 bundle 都已在 KV，不会出现「index 指向不存在 bundle」。
 *   任一 bundle 写入失败 → 立即中止，绝不写 index，旧 index 继续指向旧（完好）bundle。
 *
 * 命令：
 *   node tools/sync_kv.js            # 真正写入 KV（bundles 先，index 最后）
 *   node tools/sync_kv.js --dry      # 仅打印写入顺序，不执行
 *   node tools/sync_kv.js --check    # 本地一致性校验（index↔bundle 引用完整性），不写 KV
 *   node tools/sync_kv.js --verify   # 从 KV 读回 app:index + 每个引用 bundle，校验都存在且可解析
 *   node tools/sync_kv.js --prune    # 发布后删除 KV 中未被新 index 引用的 bundle:* 键（危险，显式）
 *   node tools/sync_kv.js --prune --dry  # 仅列出将要清理的键，不删除
 *
 * 前置：已 `npm run setup-kv`（建好命名空间并填好 wrangler.toml 的 id）
 *      且已 `npx wrangler login`
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { collectEntries, buildWriteOrder, validateLocalPlan, planPrune } = require('./sync_plan.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// 跨平台定位 wrangler 可执行文件（优先用本地 node 入口，避免 Windows .cmd 解析问题）
function wranglerBin() {
  const js = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(js)) return { cmd: process.execPath, args: [js] };
  return { cmd: 'npx', args: ['wrangler'] };
}

function wrangler(args, opts) {
  const { cmd, args: base } = wranglerBin();
  const full = [cmd, ...base, ...args];
  return execSync(full.map((a) => `"${a}"`).join(' '), { stdio: 'inherit', cwd: ROOT, ...opts });
}

function kvKeyGet(key) {
  const { cmd, args } = wranglerBin();
  const line = [cmd, ...args, 'kv', 'key', 'get', '--binding=CARD_KV', '--remote', key].map((a) => `"${a}"`).join(' ');
  return execSync(line, { cwd: ROOT, encoding: 'utf8' });
}

function kvKeyList() {
  const { cmd, args } = wranglerBin();
  const line = [cmd, ...args, 'kv', 'key', 'list', '--binding=CARD_KV', '--remote'].map((a) => `"${a}"`).join(' ');
  const out = execSync(line, { cwd: ROOT, encoding: 'utf8' });
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  return {
    dry: a.includes('--dry') || a.includes('-n'),
    check: a.includes('--check'),
    verify: a.includes('--verify'),
    prune: a.includes('--prune'),
  };
}

/** 本地一致性校验：不写 KV，退出码 0/1 */
function runCheck(entries) {
  const bad = entries.filter((e) => !e.key);
  if (bad.length) {
    console.log('\n⚠ 以下文件无法同步（跳过）：');
    bad.forEach((e) => console.log(`  ✗ ${path.relative(ROOT, e.file)} — ${e.error}`));
  }
  const bundleKeys = entries.filter((e) => e.kind === 'bundle' && e.key).map((e) => e.key);
  const idx = entries.find((e) => e.kind === 'index');
  if (!idx) {
    console.log('\n✗ 未找到 data/app_index.json，无法校验');
    process.exit(1);
  }
  let indexJson;
  try {
    indexJson = JSON.parse(fs.readFileSync(idx.file, 'utf8'));
  } catch (e) {
    console.log(`\n✗ app_index.json 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  const { ok, errors } = validateLocalPlan(indexJson, bundleKeys);
  if (ok) {
    console.log(`\n✓ 本地一致性校验通过：${bundleKeys.length} 个 bundle 均被 app:index 正确引用`);
    process.exit(0);
  }
  console.log('\n✗ 本地一致性校验失败：');
  errors.forEach((er) => console.log('  • ' + er));
  process.exit(1);
}

/** 从 KV 读回校验：确认 app:index + 每个引用 bundle 都存在且可解析 */
function runVerify() {
  console.log('→ 从 KV 读回 app:index …');
  let indexRaw;
  try {
    indexRaw = kvKeyGet('app:index');
  } catch (e) {
    console.log(`\n✗ 读取 app:index 失败：${e.message}`);
    process.exit(1);
  }
  let indexJson;
  try {
    indexJson = JSON.parse(indexRaw);
  } catch (e) {
    console.log(`\n✗ KV 中的 app:index 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  const refs = new Set();
  for (const c of indexJson.categories || []) for (const b of c.bundles || []) refs.add(b);

  let missing = 0;
  console.log(`→ 校验 ${refs.size} 个被引用 bundle 键 …`);
  for (const key of refs) {
    try {
      const raw = kvKeyGet(key);
      JSON.parse(raw);
      console.log(`  ✓ ${key}`);
    } catch (e) {
      missing++;
      console.log(`  ✗ ${key} — ${e.message}`);
    }
  }
  if (missing === 0) {
    console.log(`\n✓ 在线校验通过：app:index 版本 ${indexJson.version || '?'}，${refs.size} 个 bundle 均存在且可解析`);
    process.exit(0);
  }
  console.log(`\n✗ 在线校验失败：${missing} 个 bundle 缺失或不可解析`);
  process.exit(1);
}

function main() {
  const { dry, check, verify, prune } = parseArgs();

  if (verify) return runVerify();

  const entries = collectEntries(DATA_DIR);
  if (entries.length === 0) {
    console.log('未在 data/ 下找到可同步的数据文件');
    process.exit(1);
  }
  const bad = entries.filter((e) => !e.key);
  if (bad.length) {
    console.log('\n⚠ 以下文件无法同步（跳过）：');
    bad.forEach((e) => console.log(`  ✗ ${path.relative(ROOT, e.file)} — ${e.error}`));
  }
  const valid = entries.filter((e) => e.key);
  const bundleKeys = valid.filter((e) => e.kind === 'bundle').map((e) => e.key);

  // 本地一致性校验（任何写操作前先保证 index↔bundle 引用完整）
  const idxEntry = valid.find((e) => e.kind === 'index');
  if (!idxEntry) {
    console.log('\n✗ 未找到 data/app_index.json，无法继续（index 必须先存在才能原子发布）');
    process.exit(1);
  }
  let indexJson;
  try {
    indexJson = JSON.parse(fs.readFileSync(idxEntry.file, 'utf8'));
  } catch (e) {
    console.log(`\n✗ app_index.json 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  const localCheck = validateLocalPlan(indexJson, bundleKeys);
  if (!localCheck.ok) {
    console.log('\n✗ 本地一致性校验失败，已中止（不写 KV）：');
    localCheck.errors.forEach((er) => console.log('  • ' + er));
    process.exit(1);
  }

  // 原子写入顺序：bundles 在前（数据），app:index 在最后（指针）
  const order = buildWriteOrder(valid);

  if (dry || check) {
    console.log(`\n[${dry ? 'dry-run' : 'check'}] 写入顺序（${order.length} 个键，先数据后指针）：`);
    order.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2, '0')}. ${e.key}  ←  ${path.relative(ROOT, e.file)}`));
    console.log(`\n[check] 本地一致性已通过：${bundleKeys.length} 个 bundle 均被 app:index 引用`);
    return;
  }

  console.log(`\n开始同步 ${order.length} 个 KV 键（bundles 先写，app:index 最后写以保证原子发布）…`);
  let ok = 0;
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    const isIndex = e.kind === 'index';
    // 任一 bundle 写入失败 → 立即中止，绝不写 index（保留旧 index 指向旧完好 bundle）
    if (!isIndex) {
      console.log(`\n→ 写入 ${e.key}  [${i + 1}/${order.length}]`);
      try {
        wrangler(['kv', 'key', 'put', '--binding=CARD_KV', '--remote', e.key, '--path=' + e.file]);
        ok++;
      } catch (err) {
        console.error(`\n✗ ${e.key} 写入失败：${err.message}`);
        console.error('⚠ 已中止：app:index 未发布，旧 index 仍指向旧（完好）bundle。请修复后重跑 sync_kv.js。');
        process.exit(1);
      }
    } else {
      // index 放最后，且发布前再确认全部 bundle 已成功写入
      if (ok !== bundleKeys.length) {
        console.error(`\n✗ 不一致：仅 ${ok}/${bundleKeys.length} 个 bundle 写入成功，拒绝发布 app:index（避免指向缺失 bundle）`);
        process.exit(1);
      }
      console.log(`\n→ 写入 ${e.key}  [最后一步：发布目录]  [${i + 1}/${order.length}]`);
      try {
        wrangler(['kv', 'key', 'put', '--binding=CARD_KV', '--remote', e.key, '--path=' + e.file]);
        ok++;
      } catch (err) {
        console.error(`\n✗ ${e.key} 发布失败：${err.message}`);
        console.error('⚠ bundles 已写入，但 index 未发布。请重跑 sync_kv.js（bundles 已存在，index 会安全发布）。');
        process.exit(1);
      }
    }
  }

  console.log(`\n✓ 完成：${ok}/${order.length} 个键已写入 KV（已存在即被替换）。app:index 最后发布，保证原子一致。`);

  // 可选的 prune：删除未被新 index 引用的 bundle:* 键（清理旧版本，防无限增长）
  if (prune) {
    const refs = new Set();
    for (const c of indexJson.categories || []) for (const b of c.bundles || []) refs.add(b);
    const allKeys = kvKeyList();
    const toDelete = planPrune(allKeys, Array.from(refs));
    if (toDelete.length === 0) {
      console.log('\n[prune] 无未引用的 bundle 键，无需清理');
    } else {
      console.log(`\n[prune] 将被删除的未引用 bundle 键（${toDelete.length} 个）：`);
      toDelete.forEach((k) => console.log('  - ' + k));
      const really = !process.argv.includes('--dry');
      if (really) {
        for (const k of toDelete) {
          try {
            wrangler(['kv', 'key', 'delete', '--binding=CARD_KV', '--remote', k]);
            console.log('  ✓ 已删除 ' + k);
          } catch (err) {
            console.error('  ✗ 删除失败 ' + k + '：' + err.message);
          }
        }
      } else {
        console.log('[prune --dry] 仅预览，未删除。去掉 --dry 才真正删除。');
      }
    }
  }
}

main();
