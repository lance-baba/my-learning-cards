#!/usr/bin/env node
'use strict';
/*
 * setup_kv.js —— 一次性初始化 KV：建命名空间 + 把 id 写回 wrangler.toml。
 * 之后日常更新数据只需 `npm run sync`，不再需要碰 KV 的创建与 id。
 *
 * 前置：已 `npx wrangler login`（浏览器授权一次）
 *   node tools/setup_kv.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOML = path.join(ROOT, 'wrangler.toml');

function wranglerBin() {
  const js = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(js)) return { cmd: process.execPath, args: [js] };
  return { cmd: 'npx', args: ['wrangler'] };
}

function main() {
  if (!fs.existsSync(TOML)) {
    console.error('未找到 wrangler.toml');
    process.exit(1);
  }
  let toml = fs.readFileSync(TOML, 'utf8');
  const placeholder = /id\s*=\s*"YOUR_KV_NAMESPACE_ID"/;

  if (!placeholder.test(toml)) {
    console.log('✓ wrangler.toml 已包含真实 KV namespace id，无需再创建。');
    console.log('  直接运行：npm run sync   （灌入/替换全部数据）');
    return;
  }

  const { cmd, args } = wranglerBin();
  const base = `"${cmd}" ${args.map((a) => `"${a}"`).join(' ')}`;
  console.log('→ 创建 KV 命名空间 CARD_KV ...');
  let out;
  try {
    out = execSync(`${base} kv:namespace create CARD_KV`, { cwd: ROOT }).toString();
  } catch (err) {
    console.error('✗ 创建失败。请先确认已执行 `npx wrangler login` 并完成浏览器授权。');
    console.error('  详情：', err.message);
    process.exit(1);
  }

  const m = out.match(/id\s*=\s*"([^"]+)"/);
  if (!m) {
    console.error('未能从命令输出解析出 namespace id：\n' + out);
    process.exit(1);
  }
  const id = m[1];
  toml = toml.replace(placeholder, `id = "${id}"`);
  fs.writeFileSync(TOML, toml);
  console.log(`✓ 已创建命名空间并把 id 写入 wrangler.toml：id = ${id}`);
  console.log('  下一步：npm run sync   （把全部卡片数据灌入 KV）');
}

main();
