#!/usr/bin/env node
/**
 * CardFlow 卡片批量生成管道（零依赖，与 card_tool.js 口径一致）
 *
 * 定位：「源 → 卡片」流水线的「结构化 + 校验」环节。
 *   LLM（人或本助手）负责把原始资料切片成下面的“topic 草稿”JSON；
 *   本脚本负责机械工作：补全局唯一 id/sub_id、校验 knowledge 必带 source、
 *   按分类落盘成 bundle 文件、最后调用 card_tool.js 做合规校验。
 *
 * 输入（manifest）格式：一个 topic 草稿数组，每个草稿：
 *   {
 *     "title": "光合作用",
 *     "tags": ["科学","植物"],
 *     "type": "knowledge",                 // 默认 knowledge；放松卡用 "joke"
 *     "category": "science",               // 可选；决定归到哪个 bundle / id 前缀
 *     "source": { "name":..., "title":..., "url":..., "publish_date":..., "authority_level":"encyclopedia" },
 *     "sub_cards": [
 *        { "layout":"qa_card", "title":..., "content":..., "citation_anchor":... },
 *        { "layout":"flip_card", "title":..., "front_text":..., "back_text":..., "citation_anchor":... },
 *        { "layout":"streaming_text", "title":..., "streaming_content":..., "citation_anchor":... },
 *        { "layout":"list_card", "title":"核心要点", "items":["要点1","要点2"] },
 *        { "layout":"quote_card", "title":"权威摘录", "quote":"...", "citation":"第一章第2条" },
 *        { "layout":"compare_card", "title":"常见误区", "wrong":"误区描述", "right":"正确做法" }
 *     ],
 *     "difficulty": 2                       // 1=入门 2=进阶 3=深入（可选，默认 2）
 *   }
 *
 * 用法：
 *   # 单分类：所有草稿归入一个 bundle
 *   node tools/generate_cards.js --input draft.json --category science --out data/bundle_science.json
 *   # 自动按草稿里的 category 分组，每个分类写一个 bundle（data/bundle_<cat>.json）
 *   node tools/generate_cards.js --input draft.json
 *   # 追加进已有 bundle（自动查重 id）
 *   node tools/generate_cards.js --input draft.json --category science --append data/bundle_science.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VALID_LAYOUTS = ['qa_card', 'streaming_text', 'flip_card', 'joke_text', 'meme_card', 'game_card', 'list_card', 'quote_card', 'compare_card'];
const LAYOUT_REQUIRED = {
  qa_card: ['content'],
  streaming_text: ['streaming_content'],
  flip_card: ['front_text', 'back_text'],
  joke_text: ['content', 'punchline'],
  meme_card: ['caption'],
  game_card: [],
  list_card: ['items'],
  quote_card: ['quote'],
  compare_card: ['wrong', 'right'],
};
const VALID_TYPES = ['knowledge', 'joke'];

let ERR = 0;
function err(msg) { ERR++; console.log(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }

function slugify(s) {
  return (s || 'topic').replace(/[^\w一-龥-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'topic';
}

// 校验单个草稿的字段完整性（不写盘，只报错）
function lintDraft(d, idx) {
  const tag = `草稿[${idx}](${d.title || '?'})`;
  if (!d.title) err(`${tag} 缺少 title`);
  if (!Array.isArray(d.tags) || d.tags.length === 0) warn(`${tag} tags 为空，建议补标签`);
  const type = d.type || 'knowledge';
  if (!VALID_TYPES.includes(type)) err(`${tag} 非法 type "${type}"`);
  if (type === 'knowledge' && !d.source) err(`${tag} type=knowledge 必须带 source`);

  if (!Array.isArray(d.sub_cards) || d.sub_cards.length === 0) {
    warn(`${tag} sub_cards 为空`);
    return;
  }
  const seen = new Set();
  d.sub_cards.forEach((sub, si) => {
    if (!sub.layout) { err(`${tag}.sub[${si}] 缺 layout`); return; }
    if (!VALID_LAYOUTS.includes(sub.layout)) { err(`${tag}.sub[${si}] 非法 layout "${sub.layout}"`); return; }
    if (!sub.title) warn(`${tag}.sub[${si}] 缺 title`);
    (LAYOUT_REQUIRED[sub.layout] || []).forEach((f) => {
      if (sub[f] === undefined || sub[f] === null || sub[f] === '') err(`${tag}.sub[${si}] layout=${sub.layout} 缺字段 "${f}"`);
    });
    if (sub.sub_id) {
      if (seen.has(sub.sub_id)) err(`${tag}.sub[${si}] sub_id 重复 "${sub.sub_id}"`);
      else seen.add(sub.sub_id);
    }
  });
}

function buildItem(d, cat, i) {
  const type = d.type || 'knowledge';
  const category = d.category || cat || 'uncategorized';
  const id = d.id || `${category === 'entertainment' ? 'fun' : category}_topic_${slugify(d.title)}`;
  const sub_cards = (d.sub_cards || []).map((sub, si) => {
    const out = { sub_id: sub.sub_id || `s${si + 1}`, layout: sub.layout, title: sub.title || '' };
    // 拷贝其余字段（content / front_text / streaming_content / image / caption / citation_anchor ...）
    Object.keys(sub).forEach((k) => {
      if (k !== 'sub_id' && k !== 'layout' && k !== 'title') out[k] = sub[k];
    });
    return out;
  });
  const item = { id, title: d.title, tags: d.tags || [], type, sub_cards };
  if (type === 'knowledge' && d.source) item.source = d.source;
  if (d.difficulty) item.difficulty = d.difficulty; // 1=入门 2=进阶 3=深入
  return { item, category, id };
}

function main() {
  const argv = process.argv.slice(2);
  let input = null, category = null, out = null, append = null, version = '1.0.0';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') input = argv[++i];
    else if (argv[i] === '--category') category = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--append') append = argv[++i];
    else if (argv[i] === '--version') version = argv[++i];
  }
  if (!input) { console.log('✗ 需要 --input <草稿JSON>'); process.exit(1); }

  let drafts;
  try {
    drafts = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    console.log(`✗ 读取/解析草稿失败：${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(drafts)) { console.log('✗ 草稿根节点必须是数组'); process.exit(1); }

  console.log(`\n🔧 处理 ${drafts.length} 个 topic 草稿…`);
  drafts.forEach((d, i) => lintDraft(d, i));
  if (ERR > 0) { console.log(`❌ 草稿有 ${ERR} 处错误，已中止（先修复再生成）`); process.exit(1); }

  // 组装 items，按分类分组
  const grouped = new Map(); // category -> [items]
  const idSeen = new Map();  // category -> Set(id)
  drafts.forEach((d) => {
    const { item, category: cat } = buildItem(d, category, 0);
    if (!grouped.has(cat)) { grouped.set(cat, []); idSeen.set(cat, new Set()); }
    // 同 bundle 内 id 唯一
    let finalId = item.id;
    let n = 1;
    while (idSeen.get(cat).has(finalId)) finalId = `${item.id}_${++n}`;
    item.id = finalId;
    idSeen.get(cat).add(finalId);
    grouped.get(cat).push(item);
  });

  // 写入：append / 指定 out / 单分类默认 out / 分组 四种模式
  const written = [];
  const collectAll = () => { const items = []; grouped.forEach((its) => items.push(...its)); return items; };
  if (append) {
    // 追加模式：--append 单独生效，把草稿并入已有 bundle（自动查重 id）
    const items = collectAll();
    const r = JSON.parse(fs.readFileSync(append, 'utf8'));
    if (!Array.isArray(r.items)) r.items = [];
    const existing = new Set(r.items.map((it) => it.id));
    const dup = items.filter((it) => existing.has(it.id));
    if (dup.length) { console.log(`✗ append 检测到重复 id：${dup.map((d) => d.id).join(', ')}`); process.exit(1); }
    r.items = r.items.concat(items);
    if (version && version !== '1.0.0') r.version = version;
    fs.writeFileSync(append, JSON.stringify(r, null, 2) + '\n', 'utf8');
    written.push(append);
    console.log(`✓ 已追加 ${items.length} 个 topic 到 ${append}（现共 ${r.items.length} 个）`);
  } else if (out) {
    const items = collectAll();
    const cat = category || grouped.keys().next().value || 'uncategorized';
    const bundle = { bundle_id: `bundle:${cat}:v1`, category_id: cat, version, items };
    fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    written.push(out);
    console.log(`✓ 已生成 ${out}（${cat}，含 ${items.length} 个 topic）`);
  } else if (category) {
    const out2 = path.join(__dirname, '..', 'data', `bundle_${slugify(category)}.json`);
    const items = collectAll();
    const bundle = { bundle_id: `bundle:${category}:v1`, category_id: category, version, items };
    fs.writeFileSync(out2, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    written.push(out2);
    console.log(`✓ 已生成 ${out2}（${category}，含 ${items.length} 个 topic）`);
  } else {
    // 分组模式：每个分类一个文件
    grouped.forEach((items, cat) => {
      const fp = path.join(__dirname, '..', 'data', `bundle_${slugify(cat)}.json`);
      const bundle = { bundle_id: `bundle:${cat}:v1`, category_id: cat, version, items };
      fs.writeFileSync(fp, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
      written.push(fp);
      console.log(`✓ 已生成 ${fp}（${cat}，含 ${items.length} 个 topic）`);
    });
  }

  // 调用 card_tool.js 校验
  console.log(`\n🔍 调用 card_tool.js 校验产出…`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'card_tool.js'), 'validate', ...written], { stdio: 'inherit' });
  } catch (e) {
    console.log('❌ 校验未通过，请按上面提示修复后再部署。');
    process.exit(1);
  }
  console.log('\n✅ 生成 + 校验完成。记得在 app_index.json 登记新 bundle 与分类。');
}

main();
