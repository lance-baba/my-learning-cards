#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================
本地题库生成器（CardFlow 模考模块）
================================================================

把「教材 / 真题 / 练习题」PDF 或纯文本，解析成 CardFlow 标准题库 JSON，
然后（可选地）直接上传到云端 Worker，云端返回 16 位验证码，
对方在 exam.html 首页「输入验证码」处填入即可加载本题库。

数据流（思路源自小树学习平台的 generate_bank.py，输出适配 CardFlow 结构）：
  PDF/TXT ──▶ pdfplumber/纯文本读取 ──▶ 正则解析「题干类型/题目N./答案/选项」
        ──▶ 组装 {title, version, chapters, shortNames, questions}
        ──▶ 本地写 JSON（--out）──▶ [--upload] POST /api/bank（需 X-Bank-Key）

题库 JSON 结构（与 upload_bank.mjs / worker/index.js / exam.js 完全对齐）：
{
  "title": "地基检测",
  "version": "2026-08-31",
  "chapters": ["地基检测基本知识", "静荷载试验"],
  "shortNames": { "地基检测基本知识": "地基" },
  "questions": [
    { "ch":"地基检测基本知识", "type":"单选题", "num":1, "diff":"常规",
      "q":"题干……", "opts":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"}, "ans":"A" }
  ]
}

用法：
  # 仅生成 JSON（不联网）
  python tools/make_bank.py --pdf 地基.pdf --title "地基检测"

  # 多个 PDF 合并成一份题库（每个文件当作一个章节）
  python tools/make_bank.py --pdf a.pdf b.pdf c.pdf --title "全套模考"

  # 纯文本（从 Word / 网页复制粘贴成 .txt 也行；此模式不需要任何依赖）
  python tools/make_bank.py --text 题库.txt --title "练习题"

  # 生成并直接上传到云端（环境变量 BANK_UPLOAD_KEY 或 --key）
  BANK_UPLOAD_KEY=xxxx python tools/make_bank.py --pdf 地基.pdf --title "地基检测" --upload

  # 私有分发：验证码最多绑 3 台设备
  python tools/make_bank.py --pdf 地基.pdf --title "私享题库" --upload --max-devices 3

依赖（本机安装一次即可）：
  pip install pdfplumber
  （--text 纯文本模式不需要任何依赖，开箱即用）

注意：
  - 云端 KV 单题库上限 1MB；上传前若超过 900KB 会拒绝并提示。
  - 刻意不提取 / 不嵌入图片：考试界面（exam.js）只渲染题干与选项文本，
    没有任何图片渲染位，塞 base64 图只会白白把题库撑爆 1MB 上限。
    小树学习平台那条图片流水线在本项目不适用，已主动去掉。
  - 题型识别：默认按「题干类型：X」分段；没有该标记的 PDF 走全文单段模式。
  - 多选题自动识别：答案长度 > 1（如 BD / ABD）即升级为「多选题」。
================================================================
"""
import json
import os
import re
import sys
import argparse
from datetime import datetime
from pathlib import Path
from urllib import request as urllib_request
from urllib.error import URLError, HTTPError

try:
    import pdfplumber
except ImportError:
    pdfplumber = None


# ============================================================
# 路径常量
# ============================================================
SCRIPT_DIR = Path(__file__).resolve().parent          # cardflow/tools
PROJECT_ROOT = SCRIPT_DIR.parent                       # cardflow/
DEFAULT_OUT_DIR = PROJECT_ROOT / "generated_banks"
DEFAULT_URL = "https://fwzy.ccwu.cc"


# ============================================================
# 工具函数
# ============================================================
def fail(msg):
    print("错误：" + msg, file=sys.stderr)
    sys.exit(1)


def safe_name(s, n=40):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", s).strip()
    return s[:n] or "题库"


def format_types(questions):
    stats = {}
    for q in questions:
        t = q.get("type", "?")
        stats[t] = stats.get(t, 0) + 1
    return stats


# ============================================================
# 文本提取
# ============================================================
def extract_pdf_text(pdf_path):
    if pdfplumber is None:
        fail("未安装 pdfplumber。请运行：pip install pdfplumber（或改用 --text 纯文本模式，无需依赖）")
    print(f"  📖 正在读取: {pdf_path}")
    parts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            t = page.extract_text()
            if t and len(t.strip()) > 20:
                parts.append(t)
    text = "\n".join(parts)
    print(f"     {len(parts)} 有效页, {len(text)} 字符")
    return text


# ============================================================
# 解析已有题目（题目+选项+答案格式）
# ============================================================
def parse_exam_questions(raw_text, chapter_name):
    """从文本解析格式化的题目，输出 CardFlow 标准 question 列表（num 由 build_bank 统一重排）。"""
    questions = []

    # ── Step 1: 按「题干类型」拆分为多个段落；无标记则全文单段 ──
    section_pattern = re.compile(r"题干类型[：:]\s*(.+?)(?:\n)")
    sections = [(m.start(), m.group(1).strip()) for m in section_pattern.finditer(raw_text)]
    if not sections:
        sections = [(0, "未知")]

    section_ranges = []
    for i, (pos, stype) in enumerate(sections):
        start = pos
        end = sections[i + 1][0] if i + 1 < len(sections) else len(raw_text)
        section_ranges.append((start, end, stype))

    print(f"    找到 {len(section_ranges)} 个题型段落")

    for sec_start, sec_end, sec_type in section_ranges:
        chunk = raw_text[sec_start:sec_end]

        q_pattern = re.compile(r"题目\s*(\d+)[.、]\s*")
        matches = list(q_pattern.finditer(chunk))
        if not matches:
            continue

        default_type = {"是非题": "判断题"}.get(sec_type, sec_type)
        print(f"    [{default_type}] 本段 {len(matches)} 题")

        for i, m in enumerate(matches):
            block_start = m.end()
            block_end = matches[i + 1].start() if i + 1 < len(matches) else min(block_start + 1500, sec_end)
            block = chunk[block_start:block_end]

            # 答案（括号可有可无）：答案：(A) / 答案：A / 答案：(ABD)
            ans_m = re.search(r"答案[：:]\s*[（(]?\s*([A-Ea-e]+)\s*[）)]?", block)
            if not ans_m:
                continue
            answer = ans_m.group(1).strip().upper()

            # 选项：行首字母(A-D) + 顿号/逗号/点/空格 分隔
            opts = {}
            opt_re = re.compile(
                r"(?:^|\n)([A-D])[、，,.．\s]{1,3}(.+?)"
                r"(?=\n[A-D][、，,.．\s]|\n答案[：:]|\n题干类型|\s*$)",
                re.DOTALL,
            )
            for om in opt_re.finditer(block):
                key = om.group(1).upper()
                val = om.group(2).strip()
                if len(val) >= 1 and not val.startswith("法") and not val.startswith("分析"):
                    opts[key] = val

            if not opts:
                continue

            # 题干 = 第一个选项之前的部分
            first_opt = next(opt_re.finditer(block), None)
            first_opt_pos = first_opt.start() if first_opt else None
            q_text = block[:first_opt_pos].strip() if first_opt_pos is not None else block.strip()

            # 清理难度标签等噪声
            q_text = re.sub(r"[（(](简单题|中等题|困难题)[）)]", "", q_text).strip()
            q_text = re.sub(r"[（(]\s*[简中困]\s*[单等难]\s*[题]?\s*[）)]", "", q_text).strip()
            if len(q_text) < 5:
                continue

            # 多选题自动升级
            answer_clean = answer.replace(" ", "")
            q_type = "多选题" if len(answer_clean) > 1 else default_type

            # 难度
            if "困难" in block:
                diff = "困难题"
            elif "中等" in block:
                diff = "中等题"
            elif "简单" in block:
                diff = "简单题"
            else:
                diff = "常规"

            questions.append({
                "type": q_type,
                "ch": chapter_name,
                "q": q_text,
                "opts": opts,
                "ans": answer_clean,
                "diff": diff,
            })

    # 去重（题干前 30 字）
    seen = set()
    unique = []
    for q in questions:
        k = q["q"][:30].replace("\n", "").replace(" ", "")
        if k not in seen:
            seen.add(k)
            unique.append(q)
    if len(unique) != len(questions):
        print(f"    去重: {len(questions)} → {len(unique)} 题")

    return unique


# ============================================================
# 组装题库
# ============================================================
def build_bank(questions, title, version, short_map):
    # 章节按出现顺序去重
    chapters = []
    for q in questions:
        if q["ch"] not in chapters:
            chapters.append(q["ch"])
    # 全局重编号（源 PDF 里 q.num 按题型分别计数会重复，这里统一连续）
    for i, q in enumerate(questions):
        q["num"] = i + 1

    shortNames = {}
    for ch in chapters:
        if ch in short_map:
            shortNames[ch] = short_map[ch]

    return {
        "title": title,
        "version": version,
        "chapters": chapters,
        "shortNames": shortNames,
        "questions": questions,
    }


def validate_bank(bank):
    """本地质检：返回 (ok, warnings)。答案必须落在选项内，否则前端判分必然错。"""
    warnings = []
    for idx, q in enumerate(bank["questions"], 1):
        opts = q.get("opts") or {}
        if not q.get("ch"):
            warnings.append(f"第 {idx} 题缺章节(ch)")
        if not q.get("q") or len(q.get("q", "")) < 5:
            warnings.append(f"第 {idx} 题题干过短")
        if not opts or len(opts) < 2:
            warnings.append(f"第 {idx} 题选项不足：{list(opts.keys())}")
        ans = str(q.get("ans", "")).upper()
        if not ans:
            warnings.append(f"第 {idx} 题缺答案")
        elif q.get("type") == "多选题" and len(ans) < 2:
            warnings.append(f"第 {idx} 题标记为多选题但答案只有 1 个：{ans}")
        for a in ans:
            if a not in opts:
                warnings.append(f"第 {idx} 题答案 {a} 不在选项 {list(opts.keys())} 中")
    return (len(warnings) == 0, warnings)


# ============================================================
# 上传到云端
# ============================================================
def upload_bank(bank, url, key, max_devices, note):
    endpoint = str(url).rstrip("/") + "/api/bank"
    payload = dict(bank)
    if max_devices and max_devices > 0:
        payload["maxDevices"] = max_devices
    if note:
        payload["note"] = note
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    if len(body) > 1_000_000:
        fail(f"题库体积 {len(body) // 1024}KB 超过云端 1MB 上限，无法上传。请精简题库。")

    req = urllib_request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", "X-Bank-Key": key.strip()},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8"))
            detail = detail.get("message") or detail.get("error") or ""
        except Exception:
            pass
        if e.code == 401:
            fail("上传密钥错误（401）：--key / BANK_UPLOAD_KEY 与 Worker 的 BANK_UPLOAD_KEY 不一致，"
                 "或该 secret 尚未配置（wrangler secret put BANK_UPLOAD_KEY）。")
        if e.code == 429:
            fail("限流（429）：每 IP 每分钟最多 10 次，稍后再试。")
        if e.code == 413:
            fail("题库过大（413）：需 ≤1MB。")
        fail(f"服务端返回 {e.code}：{detail}")
    except URLError as e:
        fail(f"网络错误：{e.reason}")

    if not data or not data.get("code"):
        fail("响应异常：未返回验证码。")
    return data


# ============================================================
# CLI
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="PDF/TXT → CardFlow 标准题库 JSON（可直传云端）")
    parser.add_argument("--pdf", nargs="+", help="刷题类 PDF（可多个，每个文件当一个章节）")
    parser.add_argument("--text", nargs="+", help="纯文本题库（.txt，从 Word/网页复制粘贴）")
    parser.add_argument("--title", default="", help="题库标题（默认取第一个文件名）")
    parser.add_argument("--version", default="", help="版本号（默认当天日期）")
    parser.add_argument("--short", nargs="*", help="章节短名映射，格式 ch:短名（可多次）")
    parser.add_argument("--out", default="", help="输出 JSON 路径（默认 generated_banks/<标题>.json）")
    parser.add_argument("--upload", action="store_true", help="生成后直接上传到云端并返回验证码")
    parser.add_argument("--url", default=DEFAULT_URL, help="Worker 地址（默认 https://fwzy.ccwu.cc）")
    parser.add_argument("--key", default=os.environ.get("BANK_UPLOAD_KEY", ""), help="上传密钥（或环境变量 BANK_UPLOAD_KEY）")
    parser.add_argument("--max-devices", type=int, default=0, help="私有分发：验证码最多绑 N 台设备（0=不限制，1~50）")
    parser.add_argument("--note", default="", help="题库备注（随上传写入云端 bankmeta）")
    args = parser.parse_args()

    if not args.pdf and not args.text:
        parser.print_help()
        sys.exit(1)

    # 章节短名映射
    short_map = {}
    for s in (args.short or []):
        if ":" in s:
            ch, short = s.split(":", 1)
            short_map[ch.strip()] = short.strip()

    sources = (args.pdf or []) + (args.text or [])
    all_qs = []

    for pdf in (args.pdf or []):
        if not os.path.exists(pdf):
            fail(f"文件不存在：{pdf}")
        text = extract_pdf_text(pdf)
        ch = safe_name(os.path.splitext(os.path.basename(pdf))[0], 30)
        qs = parse_exam_questions(text, ch)
        all_qs.extend(qs)
        print(f"    {os.path.basename(pdf)} → {len(qs)} 题")

    for txt in (args.text or []):
        if not os.path.exists(txt):
            fail(f"文件不存在：{txt}")
        with open(txt, "r", encoding="utf-8") as f:
            text = f.read()
        ch = safe_name(os.path.splitext(os.path.basename(txt))[0], 30)
        qs = parse_exam_questions(text, ch)
        all_qs.extend(qs)
        print(f"    {os.path.basename(txt)} → {len(qs)} 题")

    if not all_qs:
        fail("未能从输入解析出任何题目。请检查 PDF/文本是否含「题目 N. ... 答案：(X)」格式。")

    title = args.title or safe_name(os.path.splitext(os.path.basename(sources[0]))[0], 40)
    version = args.version or datetime.now().strftime("%Y-%m-%d")
    bank = build_bank(all_qs, title, version, short_map)

    ok, warnings = validate_bank(bank)
    types = format_types(bank["questions"])
    print(f"\n  题型分布: {', '.join(f'{t}:{n}' for t, n in sorted(types.items()))}")
    if warnings:
        print(f"  ⚠️  质检发现 {len(warnings)} 处：")
        for w in warnings[:20]:
            print("    - " + w)
        if len(warnings) > 20:
            print(f"    …（其余 {len(warnings) - 20} 处略）")
    else:
        print("  ✓ 质检通过（答案均落在选项内）")

    # 输出 JSON
    DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else (DEFAULT_OUT_DIR / (safe_name(title, 40) + ".json"))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(bank, f, ensure_ascii=False, indent=2)
    size_kb = out_path.stat().st_size // 1024
    print(f"\n  ✓ 题库已写出：{out_path}（{size_kb}KB，{len(bank['questions'])} 题，{len(bank['chapters'])} 章）")

    # 上传
    if args.upload:
        if not args.key:
            fail("未提供上传密钥：加 --key <KEY> 或设置环境变量 BANK_UPLOAD_KEY"
                 "（需先 `wrangler secret put BANK_UPLOAD_KEY`）。")
        if size_kb > 900:
            fail(f"题库 {size_kb}KB 已接近/超过 1MB 上限，拒绝上传以免被服务端 413 拦掉。")
        data = upload_bank(bank, args.url, args.key, args.max_devices, args.note)
        print(f"\n  ✅ 上传成功！验证码： {data['code']}")
        if data.get("title"):
            print(f"     题库：{data['title']}")
        print(f"     题数：{data.get('total', len(bank['questions']))}")
        md = data.get("maxDevices", 0)
        print(f"     设备上限：{md if md > 0 else '不限制'} 台")
        print("\n  把验证码发给对方，对方在 exam.html 首页「题库管理 → 输入验证码」填入即可加载。")
    else:
        print("\n  下一步：上传到云端生成验证码 ——")
        print(f"    BANK_UPLOAD_KEY=xxxx python tools/make_bank.py --pdf <源> --title \"{title}\" --upload")
        print(f"  或走专用上传器：node tools/upload_bank.mjs {out_path}")


if __name__ == "__main__":
    main()
