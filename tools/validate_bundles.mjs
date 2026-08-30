import fs from 'fs';
import path from 'path';

const dir = 'F:/项目/网页刷题/cardflow/data';
const cats = ['science','geography','animals','plants','lifehacks','food','tech','movies','travel','home','experiments','entertainment'];

const layouts = {
  qa_card: ['title','content','action_hint','citation_anchor'],
  streaming_text: ['title','streaming_content'],
  flip_card: ['title','front_text','back_text'],
  list_card: ['title','items'],
  compare_card: ['title','wrong','right'],
  quote_card: ['title','quote','citation'],
  meme_card: ['title','caption','punchline'],
};

let totalTopics = 0, totalSubs = 0, errors = [];
for (const cat of cats) {
  const f = path.join(dir, `bundle_${cat}.json`);
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { errors.push(`读不到 ${f}`); continue; }
  let j;
  try { j = JSON.parse(raw); } catch (e) { errors.push(`${cat}: JSON 解析失败 ${e.message}`); continue; }
  if (j.bundle_id !== `bundle:${cat}:v1`) errors.push(`${cat}: bundle_id 不符 -> ${j.bundle_id}`);
  if (j.category_id !== cat) errors.push(`${cat}: category_id 不符 -> ${j.category_id}`);
  const items = j.items || [];
  const ids = new Set();
  let dup = 0, subCount = 0, layoutBad = [];
  for (const t of items) {
    if (ids.has(t.id)) dup++; ids.add(t.id);
    if (!t.title || !Array.isArray(t.tags) || !Array.isArray(t.sub_cards)) { errors.push(`${cat}: topic ${t.id} 缺字段`); continue; }
    for (const s of t.sub_cards) {
      subCount++;
      const req = layouts[s.layout];
      if (!req) { layoutBad.push(s.layout); continue; }
      for (const k of req) if (s[k] === undefined || s[k] === null || (Array.isArray(s[k]) && s[k].length === 0)) layoutBad.push(`${cat}/${t.id}/${s.sub_id}:${s.layout} 缺 ${k}`);
    }
  }
  if (dup) errors.push(`${cat}: topic id 重复 ${dup}`);
  totalTopics += items.length; totalSubs += subCount;
  console.log(`${cat.padEnd(12)} topics=${String(items.length).padStart(3)} subCards=${String(subCount).padStart(3)} ${subCount<90||subCount>110?'<<< 超出90-110':''} ${layoutBad.length?('布局缺字段:'+layoutBad.slice(0,3).join(',')):''}`);
}
console.log('---');
console.log(`合计 topics=${totalTopics} subCards=${totalSubs}`);
console.log(errors.length ? `❌ 错误 ${errors.length} 条:\n` + errors.slice(0,20).join('\n') : '✅ 校验通过（无结构错误）');
