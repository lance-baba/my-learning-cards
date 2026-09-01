#!/usr/bin/env node
/**
 * CardFlow 内容生成 / 校验小工具（零依赖，仅用 Node 内置模块）
 *
 * 用途：
 *   1) validate  —— 校验卡片包 / 索引 JSON，防住我们踩过的坑：
 *                   缺字段、非法 layout、knowledge 缺 source、
 *                   全角引号把 JSON 解析搞崩、重复 id、citation_anchor 含全角逗号等。
 *   2) new       —— 一键生成合规的起始卡片脚手架（topic / subcard / bundle），
 *                   按 layout 自动补齐该有的字段，避免手抄字段名出错。
 *
 * 用法：
 *   node tools/card_tool.js validate [文件路径...]
 *       （不带参数 = 校验 data/ 下所有 bundle_*.json 与 app_index.json，并做跨文件核对）
 *   node tools/card_tool.js new topic "标题" --type knowledge --layouts qa_card,streaming_text,flip_card [--out 数据文件] [--append 已有数据文件] [--id 自定义id]
 *   node tools/card_tool.js new subcard flip_card --title "正面提问"
 *   node tools/card_tool.js new bundle bundle:cat:v1 --category agriculture
 *   node tools/card_tool.js help
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────────────────────────
// 数据契约（必须与 public/app.js 的 layoutMap 保持一致）
// ───────────────────────────────────────────────────────────
const VALID_LAYOUTS = [
  'qa_card',        // 问答卡（左右滑的子卡之一）
  'streaming_text', // 打字机流式卡
  'flip_card',      // 3D 翻牌（独占满屏）
  'joke_text',      // 笑话气泡卡
  'meme_card',      // 梗图卡（独占满屏）
  'game_card',      // 小游戏卡
  'list_card',      // 要点清单（纯文本升级）
  'quote_card',     // 权威摘录（纯文本升级）
  'compare_card',   // 易错对照（纯文本升级）
  'knowledge_card', // 知识卡：钩子 + 点击揭晓要点/公式/备注（降级渲染）
];

// 每个 layout 的“专属必填字段”（sub_id / layout / title 是基础必填，单独处理）
const LAYOUT_REQUIRED = {
  qa_card: ['content'],
  streaming_text: ['streaming_content'],
  flip_card: ['front_text', 'back_text'],
  joke_text: ['content', 'punchline'],
  meme_card: ['caption'],
  game_card: [], // 仅需 title
  list_card: ['items'],
  quote_card: ['quote'],
  compare_card: ['wrong', 'right'],
  knowledge_card: [], // 仅需 title；hook/points/formula/note 可选（前端降级渲染）
};

const VALID_TYPES = ['knowledge', 'joke'];

// 全角字符：这些进了 JSON 字符串大多没问题，但“全角引号”会直接让 JSON.parse 崩溃
const CURLY_QUOTES = ['“', '”', '‘', '’'];

// ───────────────────────────────────────────────────────────
// 通用帮助
// ───────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
CardFlow 内容工具  v1.0.0（零依赖）

命令：
  validate [文件...]        校验 JSON。不带参数时校验 data/ 全量并跨文件核对。
  new topic <标题>          生成一个新的 topic（写进一个 bundle 文件）。
                           --type knowledge|joke   (默认 knowledge)
                           --layouts a,b,c         子卡 layout 列表（默认 qa_card）
                           --out 文件               输出新 bundle 文件
                           --append 文件            追加进已有 bundle 文件（不新建）
                           --id 自定义topicId
  new subcard <layout>     仅打印一张符合规范的子卡 JSON（用于手动粘贴）。
                           --title 标题
  new bundle <bundle_id>   生成一个空 bundle 骨架。
                           --category 分类id
  help                     显示本帮助

示例：
  node tools/card_tool.js validate
  node tools/card_tool.js new topic "玉米锈病识别" --type knowledge \\
      --layouts qa_card,flip_card --append data/bundle_agri.json
  node tools/card_tool.js new subcard meme_card --title "程序员的浪漫"
`);
}

// ───────────────────────────────────────────────────────────
// 校验：文件读取 + 全角引号预检
// ───────────────────────────────────────────────────────────
function readJsonFile(filePath) {
  const result = { filePath, text: null, json: null, parseError: null, curlyQuotes: [] };
  try {
    result.text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    result.parseError = `文件读取失败：${e.message}`;
    return result;
  }
  // 在真正 parse 之前，先扫一遍全角引号——这是最常见、最隐蔽的 JSON 崩溃源
  for (const ch of CURLY_QUOTES) {
    if (result.text.includes(ch)) result.curlyQuotes.push(ch);
  }
  try {
    result.json = JSON.parse(result.text);
  } catch (e) {
    result.parseError = e.message;
  }
  return result;
}

let ERROR_COUNT = 0;
let WARN_COUNT = 0;

function err(loc, msg) {
  ERROR_COUNT++;
  console.log(`  ✗ [错误] ${loc} → ${msg}`);
}
function warn(loc, msg) {
  WARN_COUNT++;
  console.log(`  ! [警告] ${loc} → ${msg}`);
}
function ok(loc, msg) {
  console.log(`  ✓ ${loc}${msg ? ' → ' + msg : ''}`);
}

// ───────────────────────────────────────────────────────────
// 校验：单个子卡
// ───────────────────────────────────────────────────────────
function validateSub(sub, itemId, idx) {
  const loc = `topic(${itemId}).sub_cards[${idx}]`;
  if (typeof sub !== 'object' || sub === null) {
    err(loc, 'sub_card 必须是对象');
    return;
  }
  if (!sub.sub_id) err(loc, '缺少 sub_id');
  if (!sub.title) err(loc, '缺少 title');
  if (!sub.layout) {
    err(loc, '缺少 layout');
  } else if (!VALID_LAYOUTS.includes(sub.layout)) {
    err(loc, `非法 layout "${sub.layout}"（合法值：${VALID_LAYOUTS.join(' | ')}）`);
  } else {
    // 专属必填字段
    const need = LAYOUT_REQUIRED[sub.layout] || [];
    for (const f of need) {
      if (sub[f] === undefined || sub[f] === null || sub[f] === '') {
        err(loc, `layout=${sub.layout} 必须包含字段 "${f}"`);
      }
    }
  }
  // 全角逗号陷阱：citation_anchor 是给人看的引用锚点，用全角逗号很容易是手误
  if (sub.citation_anchor && typeof sub.citation_anchor === 'string' && sub.citation_anchor.includes('，')) {
    warn(loc, `citation_anchor 含全角逗号“，”：${sub.citation_anchor}（确认是否手误）`);
  }
}

// ───────────────────────────────────────────────────────────
// 校验：单个 topic（item）
// ───────────────────────────────────────────────────────────
function validateItem(item, ctx) {
  const loc = `item(${item && item.id ? item.id : '?'})`;
  if (typeof item !== 'object' || item === null) {
    err(loc, 'item 必须是对象');
    return;
  }
  if (!item.id) err(loc, '缺少 id');
  else if (ctx.seenItemIds.has(item.id)) err(loc, `id 重复："${item.id}"`);
  else ctx.seenItemIds.add(item.id);

  if (!item.title) err(loc, '缺少 title');
  if (!Array.isArray(item.tags)) err(loc, 'tags 必须是数组');
  if (!item.type) err(loc, '缺少 type');
  else if (!VALID_TYPES.includes(item.type)) err(loc, `非法 type "${item.type}"（合法值：${VALID_TYPES.join(' | ')}）`);

  // knowledge 必须带权威 source（前端引用抽屉依赖它）
  if (item.type === 'knowledge') {
    if (!item.source) {
      err(loc, 'type=knowledge 必须包含 source（引用抽屉数据）');
    } else {
      const s = item.source;
      const need = ['name', 'title', 'url', 'publish_date', 'authority_level'];
      for (const f of need) {
        if (s[f] === undefined || s[f] === null || s[f] === '') {
          warn(loc, `source 建议包含字段 "${f}"（当前缺失）`);
        }
      }
      if (s.url && !/^https?:\/\//.test(s.url)) warn(loc, `source.url 建议以 http(s):// 开头：${s.url}`);
    }
  }

  if (!Array.isArray(item.sub_cards)) {
    err(loc, 'sub_cards 必须是数组');
  } else if (item.sub_cards.length === 0) {
    warn(loc, 'sub_cards 为空，该 topic 不会有任何可刷卡片');
  } else {
    const seenSub = new Set();
    item.sub_cards.forEach((sub, i) => {
      if (sub && sub.sub_id) {
        if (seenSub.has(sub.sub_id)) err(`item(${item.id}).sub_cards`, `sub_id 重复："${sub.sub_id}"`);
        else seenSub.add(sub.sub_id);
      }
      validateSub(sub, item.id, i);
    });
  }
}

// ───────────────────────────────────────────────────────────
// 校验：bundle 文件
// ───────────────────────────────────────────────────────────
function validateBundle(obj, filePath) {
  const ctx = { seenItemIds: new Set() };
  console.log(`\n📦 ${path.basename(filePath)}`);
  if (typeof obj !== 'object' || obj === null) { err(filePath, '根节点必须是对象'); return; }

  if (!obj.bundle_id) err('bundle', '缺少 bundle_id');
  if (!obj.category_id) err('bundle', '缺少 category_id');
  if (!obj.version) err('bundle', '缺少 version');
  if (!Array.isArray(obj.items)) {
    err('bundle', 'items 必须是数组');
    return;
  }
  if (obj.items.length === 0) warn('bundle', 'items 为空，没有可刷内容');

  obj.items.forEach((it) => validateItem(it, ctx));

  if (ERROR_COUNT === 0 && ctx.seenItemIds.size > 0) ok('bundle', `结构合规，含 ${ctx.seenItemIds.size} 个 topic`);
}

// ───────────────────────────────────────────────────────────
// 校验：app_index.json
// ───────────────────────────────────────────────────────────
function validateAppIndex(obj, filePath, allBundleIds) {
  console.log(`\n🗂  ${path.basename(filePath)}`);
  if (typeof obj !== 'object' || obj === null) { err(filePath, '根节点必须是对象'); return; }
  if (!obj.version) err('app_index', '缺少 version');
  if (!obj.min_app_version) warn('app_index', '缺少 min_app_version（版本强制更新判断依赖它）');
  if (!obj.global_config || typeof obj.global_config.relax_ratio !== 'number') {
    warn('app_index', 'global_config.relax_ratio 缺失或非数字（放松卡穿插比例）');
  }
  if (!Array.isArray(obj.categories) || obj.categories.length === 0) {
    err('app_index', 'categories 必须是非空数组');
    return;
  }
  const catIds = new Set();
  obj.categories.forEach((c, i) => {
    const loc = `categories[${i}]`;
    if (!c.id) err(loc, '缺少 id');
    else if (catIds.has(c.id)) err(loc, `分类 id 重复："${c.id}"`);
    else catIds.add(c.id);
    if (!c.name) err(loc, '缺少 name');
    if (!Array.isArray(c.bundles)) err(loc, 'bundles 必须是数组');
  });

  // 跨文件核对：索引里声明的 bundle 是否都存在
  if (Array.isArray(obj.categories)) {
    obj.categories.forEach((c) => {
      (c.bundles || []).forEach((bid) => {
        if (allBundleIds && !allBundleIds.has(bid)) {
          err('app_index', `分类(${c.id}) 声明了 bundle "${bid}"，但 data/ 下找不到对应文件`);
        }
      });
    });
  }
  if (ERROR_COUNT === 0) ok('app_index', `合规，含 ${obj.categories.length} 个分类`);
}

// ───────────────────────────────────────────────────────────
// 脚手架：生成子卡对象
// ───────────────────────────────────────────────────────────
function scaffoldSub(layout, idx) {
  const subId = `s${idx + 1}`;
  const base = { sub_id: subId, layout, title: `TODO: 子卡标题(${layout})` };
  switch (layout) {
    case 'qa_card':
      return { ...base, content: 'TODO: 填写问答正文', action_hint: '左右滑动查看更多 ➔', citation_anchor: 'TODO: 引用锚点' };
    case 'streaming_text':
      return { ...base, streaming_content: 'TODO: 填写要打字机流式展示的内容', citation_anchor: 'TODO: 引用锚点' };
    case 'flip_card':
      return { ...base, front_text: 'TODO: 正面提问', back_text: 'TODO: 背面答案', citation_anchor: 'TODO: 引用锚点' };
    case 'joke_text':
      return { ...base, content: 'TODO: 笑话铺垫', punchline: 'TODO: 揭晓笑点' };
    case 'meme_card':
      return { ...base, caption: 'TODO: 图片配文（去图方向：可不带 image，仅文案）' };
    case 'game_card':
      return base; // 仅需 title
    case 'list_card':
      return { ...base, title: '核心要点', items: ['TODO: 要点1', 'TODO: 要点2', 'TODO: 要点3'] };
    case 'quote_card':
      return { ...base, title: '权威摘录', quote: 'TODO: 来源原文摘录', citation: 'TODO: 引用锚点（如 第一章第2条）' };
    case 'compare_card':
      return { ...base, title: '常见误区', wrong: 'TODO: 民间常见误区', right: 'TODO: 正确做法' };
    case 'knowledge_card':
      return { ...base, hook: 'TODO: 一句有吸引力的引子', points: ['TODO: 要点1', 'TODO: 要点2'], formula: 'TODO: 公式（可选）', note: 'TODO: 备注（可选）' };
    default:
      return base;
  }
}

function scaffoldSource() {
  return {
    name: 'TODO: 来源机构名',
    title: 'TODO: 来源文档标题',
    url: 'https://TODO.example.com',
    publish_date: '2026-01-01',
    authority_level: 'official',
  };
}

function slugify(s) {
  return (s || 'topic')
    .replace(/[^\w一-龥-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'topic';
}

// ───────────────────────────────────────────────────────────
// 脚手架：new topic
// ───────────────────────────────────────────────────────────
function cmdNewTopic(args) {
  // args: [标题, ...flags]
  const title = args.shift();
  if (!title) { console.log('✗ 需要标题，例如：new topic "玉米锈病识别"'); process.exit(1); }

  let type = 'knowledge';
  let layouts = ['qa_card'];
  let out = null;
  let append = null;
  let customId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type') type = args[++i] || type;
    else if (args[i] === '--layouts') layouts = (args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--append') append = args[++i];
    else if (args[i] === '--id') customId = args[++i];
  }

  // 校验 layout 合法性
  const bad = layouts.filter((l) => !VALID_LAYOUTS.includes(l));
  if (bad.length) {
    console.log(`✗ 非法 layout：${bad.join(', ')}（合法值：${VALID_LAYOUTS.join(' | ')}）`);
    process.exit(1);
  }
  if (!VALID_TYPES.includes(type)) {
    console.log(`✗ 非法 type："${type}"（合法值：${VALID_TYPES.join(' | ')}）`);
    process.exit(1);
  }

  const topicId = customId || `${type === 'joke' ? 'fun' : 'k'}_topic_${slugify(title)}`;
  const item = {
    id: topicId,
    title,
    tags: ['TODO: 标签1', 'TODO: 标签2'],
    type,
    sub_cards: layouts.map((l, i) => scaffoldSub(l, i)),
  };
  if (type === 'knowledge') item.source = scaffoldSource();

  const subCount = item.sub_cards.length;

  // 追加模式：读已有 bundle，push 进去
  if (append) {
    const r = readJsonFile(append);
    if (r.parseError && !r.text) { console.log(`✗ 无法读取已有文件：${r.parseError}`); process.exit(1); }
    if (r.parseError) {
      console.log(`✗ 已有文件 JSON 解析失败（可能含全角引号）：${r.parseError}`);
      if (r.curlyQuotes.length) console.log(`  疑似全角引号：${r.curlyQuotes.join(' ')}`);
      process.exit(1);
    }
    const bundle = r.json;
    if (!Array.isArray(bundle.items)) bundle.items = [];
    if (bundle.items.some((it) => it.id === topicId)) {
      console.log(`✗ 已有 bundle 中已存在 id "${topicId}"，换个 --id 避免冲突`);
      process.exit(1);
    }
    bundle.items.push(item);
    fs.writeFileSync(append, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    console.log(`✓ 已追加 topic "${title}" (${topicId}) 到 ${append}，现共 ${bundle.items.length} 个 topic / 该 topic ${subCount} 张子卡`);
    return;
  }

  // 新建 bundle 文件
  if (!out) out = path.join(__dirname, '..', 'data', `bundle_${slugify(title)}.json`);
  const bundle = {
    bundle_id: `bundle:${slugify(title)}:v1`,
    category_id: type === 'joke' ? 'entertainment' : 'agriculture',
    version: '1.0.0',
    items: [item],
  };
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  console.log(`✓ 已生成 bundle 文件：${out}`);
  console.log(`  topic id = ${topicId}（请按需改名，避免与其它文件冲突）`);
  console.log(`  含 ${subCount} 张子卡：${layouts.join(', ')}`);
  console.log(`  记得把 TODO 占位替换为真实内容，并在 app_index.json 的对应分类 bundles 里登记本 bundle。`);
}

// ───────────────────────────────────────────────────────────
// 脚手架：new subcard（打印单张，便于手动粘贴）
// ───────────────────────────────────────────────────────────
function cmdNewSubcard(args) {
  const layout = args.shift();
  if (!layout || !VALID_LAYOUTS.includes(layout)) {
    console.log(`✗ 需要合法 layout（${VALID_LAYOUTS.join(' | ')}）`);
    process.exit(1);
  }
  let title = `子卡标题(${layout})`;
  for (let i = 0; i < args.length; i++) if (args[i] === '--title') title = args[++i] || title;
  const sub = scaffoldSub(layout, 0);
  sub.title = title;
  console.log(JSON.stringify(sub, null, 2));
}

// ───────────────────────────────────────────────────────────
// 脚手架：new bundle（空骨架）
// ───────────────────────────────────────────────────────────
function cmdNewBundle(args) {
  const bundleId = args.shift();
  if (!bundleId) { console.log('✗ 需要 bundle_id，例如：new bundle bundle:cat:v1'); process.exit(1); }
  let category = 'agriculture';
  for (let i = 0; i < args.length; i++) if (args[i] === '--category') category = args[++i] || category;
  const bundle = { bundle_id: bundleId, category_id: category, version: '1.0.0', items: [] };
  const out = path.join(__dirname, '..', 'data', `bundle_${slugify(bundleId)}.json`);
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  console.log(`✓ 已生成空 bundle 骨架：${out}（category=${category}，items 为空，待追加 topic）`);
}

// ───────────────────────────────────────────────────────────
// 校验入口
// ───────────────────────────────────────────────────────────
function cmdValidate(args) {
  const dataDir = path.join(__dirname, '..', 'data');
  let files;
  if (args.length === 0) {
    // 全量模式
    files = fs.readdirSync(dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dataDir, f));
    if (files.length === 0) { console.log('未在 data/ 下找到 JSON 文件'); process.exit(1); }
  } else {
    files = args.map((f) => (path.isAbsolute(f) ? f : path.resolve(process.cwd(), f)));
  }

  console.log(`\n🔍 校验 ${files.length} 个文件…`);

  // 先全部读取，做跨文件核对
  const readResults = files.map(readJsonFile);
  const allBundleIds = new Set();
  readResults.forEach((r) => { if (r.json && r.json.bundle_id) allBundleIds.add(r.json.bundle_id); });

  readResults.forEach((r) => {
    if (r.parseError) {
      err(r.filePath, `JSON 解析失败：${r.parseError}`);
      if (r.curlyQuotes.length) {
        console.log(`    💡 疑似全角引号导致崩溃，请把这些字符替换为英文半角 " ： ${r.curlyQuotes.join(' ')}`);
      }
      return;
    }
    const base = path.basename(r.filePath);
    if (base === 'app_index.json') validateAppIndex(r.json, r.filePath, allBundleIds);
    else validateBundle(r.json, r.filePath);
  });

  console.log(`\n──────── 校验完成 ────────`);
  console.log(`  错误：${ERROR_COUNT}    警告：${WARN_COUNT}`);
  if (ERROR_COUNT > 0) {
    console.log('  ❌ 存在错误，请修复后再部署。');
    process.exit(1);
  } else if (WARN_COUNT > 0) {
    console.log('  ✅ 可部署（有警告，建议顺手处理）。');
  } else {
    console.log('  ✅ 全部合规，可部署。');
  }
}

// ───────────────────────────────────────────────────────────
// 主分发
// ───────────────────────────────────────────────────────────
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'validate':
      cmdValidate(rest);
      break;
    case 'new': {
      const [kind, ...subArgs] = rest;
      if (kind === 'topic') cmdNewTopic(subArgs);
      else if (kind === 'subcard') cmdNewSubcard(subArgs);
      else if (kind === 'bundle') cmdNewBundle(subArgs);
      else { console.log(`✗ 未知 new 子命令："${kind || ''}"`); printHelp(); process.exit(1); }
      break;
    }
    case 'help':
    case undefined:
      printHelp();
      break;
    default:
      console.log(`✗ 未知命令："${cmd}"`);
      printHelp();
      process.exit(1);
  }
}

main();
