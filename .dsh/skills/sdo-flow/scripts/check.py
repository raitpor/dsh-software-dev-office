#!/usr/bin/env python3
"""sdo-flow 文本检查器：账本、表格、签字、卡、读数。

用法（在项目根跑）：
  python3 .dsh/skills/sdo-flow/scripts/check.py            # 全部检查
  python3 .dsh/skills/sdo-flow/scripts/check.py --presets  # 额外比对 preset 与设计文档
退出码：0 全过；1 有错误（附 文件:行: 消息）。
只读，不改任何文件。
"""
import os, re, subprocess, sys

ROOT = os.getcwd()
ERR, WARN = [], []
LEDGER_KINDS = {"gap", "defect", "explain"}
LEDGER_STATUS = {"open", "accepted", "fixed", "closed"}

def err(p, ln, msg): ERR.append(f"{p}:{ln}: {msg}")
def warn(p, ln, msg): WARN.append(f"{p}:{ln}: {msg}")

def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read().splitlines()

def md_files():
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "lib", "dist"}]
        for fn in files:
            if fn.endswith(".md"):
                yield os.path.relpath(os.path.join(base, fn), ROOT)

def cells(line):
    s = line.strip()
    if s.startswith("|"): s = s[1:]
    if s.endswith("|"): s = s[:-1]
    out, cur, esc, code = [], "", False, False
    for ch in s:
        if esc: cur += ch; esc = False; continue
        if ch == "\\": cur += ch; esc = True; continue
        if ch == "`": code = not code; cur += ch; continue
        if ch == "|" and not code: out.append(cur); cur = ""; continue
        cur += ch
    out.append(cur)
    return [c.strip() for c in out]

def check_tables(p, lines):
    tbl = None  # (header_len, first_line, seen_data)
    for i, line in enumerate(lines, 1):
        s = line.strip()
        is_row = s.startswith("|")
        if is_row:
            n = len(cells(s))
            if tbl is None:
                if i < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i]):
                    tbl = {"n": n, "at": i, "data": 0}
                else:
                    err(p, i, "表头下一行不是分隔行（| --- |）")
                    tbl = {"n": n, "at": i, "data": 0}
            else:
                if n != tbl["n"]:
                    err(p, i, f"列数 {n} ≠ 表头 {tbl['n']}（表从第 {tbl['at']} 行开始）")
                else:
                    tbl["data"] += 1
        else:
            if tbl is not None:
                if s == "":
                    # 空行后若又出现 | 行，由下一轮重开表时被 orphan 检查抓到
                    tbl = None
                else:
                    tbl = None
            elif s.startswith("|"):
                err(p, i, "游离的表格行（上方没有表头）")

def check_ledger(p):
    if not os.path.exists(os.path.join(ROOT, p)):
        err(p, 0, "缺文件"); return
    lines = read(p)
    hdr_at, cols = None, {}
    alias = {"id": "id", "ID": "id", "kind": "kind", "类型": "kind", "位置": "where",
             "现象": "what", "影响": "why", "处置": "how", "状态": "status", "status": "status"}
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if s.startswith("|") and ("id" in s.lower() or "ID" in s):
            hdr = cells(line)
            if len(hdr) != 7:
                err(p, i, f"表头 {len(hdr)} 列，应为 7 列（id/kind/位置/现象/影响/处置/状态）")
                return
            for idx, name in enumerate(hdr):
                if name in alias: cols[alias[name]] = idx
            need = {"id", "kind", "where", "what", "how", "status"}
            if not need <= set(cols):
                err(p, i, f"表头缺列：{sorted(need - set(cols))}"); return
            hdr_at = i
            break
    if hdr_at is None:
        err(p, 0, "找不到台账表头（含 id 的表）"); return
    seen = []
    for i in range(hdr_at + 2, len(lines) + 1):
        line = lines[i - 1].strip()
        if not line.startswith("|"): continue
        c = cells(line)
        if len(c) != 7: continue
        did = c[cols["id"]].strip("`").strip()
        if not re.fullmatch(r"D-\d+", did):
            err(p, i, f"id 不合法：{did}（应为 D-<数字>）"); continue
        if did in seen:
            err(p, i, f"id 重复：{did}")
        if seen and int(did[2:]) <= int(seen[-1][2:]):
            err(p, i, f"id 未递增：{did} 在 {seen[-1]} 之后")
        seen.append(did)
        if c[cols["kind"]] not in LEDGER_KINDS: err(p, i, f"kind 不合法：{c[cols['kind']]}")
        if c[cols["status"]] not in LEDGER_STATUS: err(p, i, f"状态不合法：{c[cols['status']]}")
        if c[cols["kind"]] == "defect" and c[cols["status"]] == "open":
            warn(p, i, f"{did} 是未修 defect")
        if not c[cols["where"]]: err(p, i, "位置为空")

def check_signs():
    d = os.path.join(ROOT, "sdo/sign")
    if not os.path.isdir(d):
        err("sdo/sign", 0, "缺签字目录"); return
    files = sorted(f for f in os.listdir(d) if f.endswith(".md"))
    if not files: err("sdo/sign", 0, "没有签字文件")
    for fn in files:
        p = f"sdo/sign/{fn}"; lines = read(p); text = "\n".join(lines)
        for field in ["时间", "选项", "被签对象"]:
            if not re.search(rf"^\s*-?\s*{field}[:：]\s*\S", text, re.M):
                err(p, 0, f"缺字段或值为空：{field}（应写成「- {field}：…」）")
        if not re.search(r"选项[:：].*(签|改|不签)", text):
            err(p, 0, "选项不是三选一（签：复述准确 / 改：复述不准 / 不签：先不做）")

def check_cards():
    d = os.path.join(ROOT, "sdo/cards")
    if not os.path.isdir(d):
        warn("sdo/cards", 0, "还没有卡（里程碑早期可接受）"); return
    for fn in sorted(f for f in os.listdir(d) if f.endswith(".md")):
        p = f"sdo/cards/{fn}"; text = "\n".join(read(p))
        for sec in ["## 判据", "## 证据"]:
            if sec not in text: err(p, 0, f"缺段落：{sec}")
        if not re.search(r"^status:\s*(open|done)", text, re.M):
            err(p, 0, "缺 status: open|done")
        if "判定" not in text: err(p, 0, "缺「判定」段")

def check_readings():
    d = os.path.join(ROOT, "sdo/readings")
    if not os.path.isdir(d): warn("sdo/readings", 0, "还没有读数（里程碑门前可接受）"); return
    for fn in sorted(f for f in os.listdir(d) if f.endswith(".md")):
        p = f"sdo/readings/{fn}"; text = "\n".join(read(p))
        if not re.search(r"overall", text, re.I): err(p, 0, "缺 overall 判定")
        if not re.search(r"\bpass\b|\bpartial\b|\bfail\b", text, re.I):
            err(p, 0, "缺逐条 verdict（pass/partial/fail）")

def check_presets():
    try:
        doc = subprocess.run(["git", "show", "main:docs/08-方法论与策略.md"],
                             capture_output=True, text=True, cwd=ROOT)
        if doc.returncode != 0:
            warn("presets", 0, "取不到 main:docs/08，跳过与设计的比对"); return
    except Exception as e:
        warn("presets", 0, f"跳过与设计的比对：{e}"); return
    def gates(text):
        out = {}
        for m in re.finditer(r"(G_[a-z_]+):\s*\{(.*?)\}", text, re.S):
            body = m.group(2)
            cm = re.search(r"criteria:\s*\[(.*?)\]", body, re.S)
            if not cm: continue
            out[m.group(1)] = re.findall(r"[a-z_]+\.[a-z_]+", cm.group(1))
        return out
    want = gates(doc.stdout)
    for fn in ["waterfall.md", "prototype.md", "incremental.md"]:
        p = f".dsh/skills/sdo-flow/presets/{fn}"
        text = "\n".join(read(p))
        got = {}
        for m in re.finditer(r"id:\s*(G_[a-z_]+).*?criteria:\s*\[([^\]]*)\]", text, re.S):
            got[m.group(1)] = re.findall(r"[a-z_]+\.[a-z_]+", m.group(2))
        for gid, crit in got.items():
            if gid not in want:
                warn(p, 0, f"{gid} 在 docs/08 里找不到"); continue
            if crit != want[gid]:
                err(p, 0, f"{gid} 的 criteria 与 docs/08 不一致（本文件 {len(crit)} 条，设计 {len(want[gid])} 条）")

def main():
    if not os.path.isdir(os.path.join(ROOT, "sdo")):
        print("sdo/ 不存在：这不是一个按 sdo-flow 初始化的项目", file=sys.stderr); return 2
    for p in ["sdo/00-意图.md", "sdo/01-计划.md", "sdo/台账.md"]:
        if not os.path.exists(os.path.join(ROOT, p)):
            err(p, 0, "缺必需文件")
    files = list(md_files())
    for p in files:
        check_tables(p, read(p))
    check_ledger("sdo/台账.md")
    check_signs(); check_cards(); check_readings()
    if "--presets" in sys.argv: check_presets()
    for w in WARN: print(f"WARN  {w}")
    for e in ERR: print(f"ERROR {e}")
    print(f"\n检查完成：{len(files)} 个 Markdown，{len(ERR)} 个错误，{len(WARN)} 个警告")
    return 1 if ERR else 0

if __name__ == "__main__":
    sys.exit(main())
