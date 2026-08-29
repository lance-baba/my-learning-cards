#!/usr/bin/env node
'use strict';
/*
 * sync_kv.js —— 把 data/ 下所有卡片 JSON 一键同步进 Cloudflare KV。
 * 语义就是「名称(键) ← 值(JSON内容)」：重跑即把值替换掉，无需重新部署。
 *
 *   node tools/sync_kv.js            # 真正写入 KV
 *   node tools/sync_kv.js --dry      # 只打印将要写入的键名映射，不实际执行
 *
 * 前置：已 `npm run setup-kv`（建好命名空间并填好 wrangler.toml 的 id）
 *      且已 `npx wrangler login`
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// 跨平台定位 wrangler 可执行文件（优先用本地 node 入口，避免 Windows .cmd 解析问题）
function wranglerBin() {
  const js = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(js)) return { cmd: process.execPath, args: [js] };
  return { cmd: 'npx', args: ['wrangler'] };
}

// 自动算出 KV 键名：app_index.json -> "app:index"；bundle_*.json -> 其 bundle_id
function collectEntries() {
  const entries = [];
  const idx = path.join(DATA_DIR, 'app_index.json');
  if (fs.existsSync(idx)) entries.push({ key: 'app:index', file: idx });

  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^bundle_.*\.json$/.test(f)) {
      const fp = path.join(DATA_DIR, f);
      let j;
      try {
        j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (e) {
        console.warn(`⚠ ${f} 不是合法 JSON，跳过`);
        continue;
      }
      if (!j.bundle_id) {
        console.warn(`⚠ ${f} 缺少 bundle_id 字段，跳过`);
        continue;
      }
      entries.push({ key: j.bundle_id, file: fp });
    }
  }
  return entries;
}

function main() {
  const dry = process.argv.includes('--dry') || process.argv.includes('-n');
  const entries = collectEntries();
  if (entries.length === 0) {
    console.log('未在 data/ 下找到可同步的数据文件');
    process.exit(1);
  }

  console.log(`\n待同步 ${entries.length} 个 KV 键（名称 ← 值来源）：`);
  entries.forEach((e) => console.log(`  • ${e.key}  ←  ${path.relative(ROOT, e.file)}`));

  if (dry) {
    console.log('\n[dry-run] 仅预览，未写入 KV。去掉 --dry 才真正执行。');
    return;
  }

  const { cmd, args } = wranglerBin();
  const base = `"${cmd}" ${args.map((a) => `"${a}"`).join(' ')}`;
  let ok = 0;
  for (const e of entries) {
    const line = `${base} kv:key put --binding=CARD_KV "${e.key}" --path="${e.file}"`;
    console.log(`\n→ 写入 ${e.key}`);
    try {
      execSync(line, { stdio: 'inherit', cwd: ROOT });
      ok++;
    } catch (err) {
      console.error(`✗ ${e.key} 写入失败：${err.message}`);
    }
  }
  console.log(`\n${ok === entries.length ? '✓' : '⚠'} 完成：${ok}/${entries.length} 个键已写入 KV（已存在即被替换）`);
  if (ok !== entries.length) process.exit(1);
}

main();
