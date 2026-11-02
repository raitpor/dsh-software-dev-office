#!/usr/bin/env python3
"""可执行性探针：把 docs/ 的设计当成假设，在 SQLite 上验证它建不建得起来、拦不拦得住。

不是实现。每个探针输出 PASS / FAIL / GAP，最后写 REPORT.md 的依据来自这里的输出。
用法：python3 probe/run.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema.sql")

results = []


def record(tag: str, name: str, detail: str) -> None:
    results.append((tag, name, detail))
    print(f"[{tag:4}] {name}: {detail}")


def expect_fail(fn, label: str, probe: str) -> None:
    """期望抛 IntegrityError。"""
    try:
        fn()
    except sqlite3.IntegrityError as e:
        record("PASS", label, f"被约束拒绝：{str(e)[:60]}")
    except Exception as e:  # noqa: BLE001
        record("FAIL", label, f"抛了非约束错误：{type(e).__name__}: {e}")
    else:
        record("FAIL", label, "没有被拒绝——约束没起作用")


def build(conn: sqlite3.Connection) -> None:
    with open(SCHEMA, encoding="utf-8") as f:
        conn.executescript(f.read())


def seed(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO snapshot VALUES ('snap1','oid_snap1',NULL,'t0')")
    conn.execute("INSERT INTO event_kind VALUES ('test.event','t0','探针用')")
    conn.execute("INSERT INTO intent VALUES ('I1','做一件事','u','u','explicit','b1','h1','t0')")
    conn.execute("INSERT INTO spec (id,intent_id,clause,kind,mech_checkable,created_by,producer,"
                 "content_hash,at) VALUES ('S1','I1','条款一','requirement',0,'u','u','ch1','t0')")
    conn.execute("INSERT INTO spec (id,intent_id,clause,kind,mech_checkable,created_by,producer,"
                 "content_hash,at) VALUES ('S2','I1','条款二','requirement',0,'u','u','ch2','t0')")
    conn.execute("INSERT INTO criterion VALUES ('C1','S1','mech','pass|fail|na','补')")
    conn.execute("INSERT INTO evidence VALUES ('E1','C1','uri','sha1','cmd','od','snap1','t0')")


def probe_schema() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        build(conn)
    except Exception as e:  # noqa: BLE001
        record("FAIL", "1. 建表", f"{type(e).__name__}: {e}")
        return
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    design = [n for n in names if n != 'sqlite_sequence']
    helper = []
    internal = [n for n in names if n == 'sqlite_sequence']
    record("PASS", "1. 建表",
           f"设计表 {len(design)} + 探针辅助 {len(helper)} + SQLite 内部 {len(internal)}")


def probe_composite_fk() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    seed(conn)

    def bad_spec() -> None:
        # criterion C1 属于 S1，却声称挂在 S2
        conn.execute("INSERT INTO work_unit VALUES ('W1','T1','C1','S2','E1','t0')")

    def bad_evidence() -> None:
        # evidence E1 属于 C1，却给了别的判据
        conn.execute("INSERT INTO criterion VALUES ('C2','S2','mech','pass|fail|na','补')")
        conn.execute("INSERT INTO work_unit VALUES ('W2','T1','C2','S2','E1','t0')")

    expect_fail(bad_spec, "2a. work_unit.spec_id 偏离 criterion.spec_id", "复合外键")
    expect_fail(bad_evidence, "2b. work_unit.evidence 属于别的判据", "复合外键")
    ok = conn.execute("INSERT INTO work_unit VALUES ('W3','T1','C1','S1','E1','t0')")
    record("PASS", "2c. 一致的行可插入", "复合外键不误伤")


def probe_ancestry() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    for s in ("S1", "S2", "S3"):
        conn.execute("INSERT INTO snapshot VALUES (?,?,NULL,'t0')", (s, "oid_" + s))
    conn.executemany("INSERT INTO snapshot_parent VALUES (?,?)",
                     [("S2", "S1"), ("S3", "S2")])
    row = conn.execute("""
        WITH RECURSIVE anc(x) AS (
            SELECT 'S3'
            UNION
            SELECT sp.parent_id FROM snapshot_parent sp JOIN anc ON sp.snapshot_id = anc.x
        )
        SELECT count(*) FROM anc WHERE x = 'S1'
    """).fetchone()[0]
    record("PASS" if row else "FAIL", "3a. 快照祖先闭包（递归 CTE）",
           "S3 能找到祖先 S1" if row else "找不到祖先")

    # G1 已定：父链由外键约束——指向不存在的快照会被拒绝
    try:
        conn.execute("INSERT INTO snapshot_parent VALUES ('S3','NOPE')")
    except sqlite3.IntegrityError:
        record("PASS", "3b. 父链完整性（链接表 + 外键）", "指向不存在的父快照被拒绝")
    else:
        record("FAIL", "3b. 父链完整性", "悬空父快照被接受")


def probe_events() -> None:
    def canon(payload: dict) -> str:
        return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    def chain(conn: sqlite3.Connection, payloads: list[dict]) -> None:
        prev = "0" * 64
        for i, p in enumerate(payloads):
            f = f"f{i}"
            h = hashlib.sha256((prev + canon(p)).encode()).hexdigest()
            conn.execute("INSERT INTO event (kind,payload,frontier,prev_hash,hash,at) "
                         "VALUES (?,?,?,?,?,?)", (p["kind"], canon(p), f, prev, h, "t0"))
            prev = h

    conn = sqlite3.connect(":memory:")
    build(conn)
    for k in ("task.created", "task.claimed", "evidence.attached"):
        conn.execute("INSERT INTO event_kind VALUES (?, 't0', '探针用')", (k,))
    payloads = [{"kind": "task.created", "id": "T1"},
                {"kind": "task.claimed", "id": "T1"},
                {"kind": "evidence.attached", "id": "E1"}]
    chain(conn, payloads)
    conn.commit()

    # 折叠：事件数 = 折叠后的状态投影
    folded = conn.execute("SELECT kind, count(*) FROM event GROUP BY kind").fetchall()
    ok = conn.execute("SELECT count(*) FROM event").fetchone()[0] == 3
    record("PASS" if ok else "FAIL", "4a. 追加 + 折叠", f"3 条事件 → {folded}")

    # 篡改检测：改一条 payload，重算链
    conn.execute("UPDATE event SET payload=? WHERE id=1",
                 (canon({"kind": "task.created", "id": "T1X"}),))
    rows = conn.execute("SELECT hash,prev_hash,payload FROM event ORDER BY id").fetchall()
    prev = "0" * 64
    broken = 0
    for h, ph, pl in rows:
        want = hashlib.sha256((prev + pl).encode()).hexdigest()
        if want != h or ph != prev:
            broken += 1
        prev = h
    record("PASS" if broken else "FAIL", "4b. 篡改可发现",
           f"发现 {broken} 处断点" if broken else "篡改后链仍自洽——哈希没绑 payload")


def probe_two_phase() -> None:
    def payload_hash(payload: dict) -> str:
        return hashlib.sha256(json.dumps(payload, sort_keys=True,
                                         ensure_ascii=False,
                                         separators=(",", ":")).encode()).hexdigest()

    preview = {"task": "T1", "files": ["a.ts"]}
    h = payload_hash(preview)
    confirm_wrong = preview | {"files": ["a.ts", "b.ts"]}
    accepted = payload_hash(confirm_wrong) == h
    record("PASS" if not accepted else "FAIL", "5. 两段式：payload 变了就拒",
           "confirm 的 payload 哈希对不上 ⇒ 拒绝（模拟）" if not accepted else "改过的 payload 被接受了")


def probe_gate() -> None:
    def verdict(readings: list[str], policy: str = "all_of") -> str:
        if policy == "all_of":
            return "pass" if all(r in ("pass", "na") for r in readings) else "fail"
        return "pass" if any(r == "pass" for r in readings) else "fail"

    ok = verdict(["pass", "na"]) == "pass"
    bad = verdict(["pass", "fail"]) == "fail"
    hand_filled = "pass"
    computed = verdict(["pass", "fail"])
    mismatch = hand_filled != computed
    record("PASS" if ok and bad and mismatch else "FAIL", "6. 门禁 all_of 与 na",
           f"pass+na→pass={ok}；pass+fail→fail={bad}；手填与算出的差异可检出={mismatch}")


def probe_single_writer() -> None:
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "sdo.db")
        a = sqlite3.connect(path, timeout=0.2, isolation_level=None)
        build(a)
        a.execute("BEGIN IMMEDIATE")
        a.execute("INSERT INTO intent VALUES ('I9','x','u','u','explicit','b','h','t')")
        b = sqlite3.connect(path, timeout=0.2, isolation_level=None)
        t0 = time.time()
        try:
            b.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as e:
            record("PASS", "7. 单写：第二个写者被拒",
                   f"{time.time()-t0:.2f}s 内返回 {str(e)[:40]}")
        else:
            b.execute("ROLLBACK")
            record("FAIL", "7. 单写", "两个写事务同时成功——单写没保证")
        finally:
            a.execute("ROLLBACK")
            a.close()
            b.close()


def probe_derived() -> None:
    """G2 已定：应用层重算 + verify 比对（DB 只管存储）。"""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    seed(conn)
    conn.execute("INSERT INTO work_unit VALUES ('W1','T1','C1','S1','E1','t0')")

    def recompute(spec_id: str) -> str:
        rows = conn.execute("""
            SELECT e.artifact_sha256 FROM work_unit w
            JOIN evidence e ON e.id = w.evidence_id
            WHERE w.spec_id = ? ORDER BY w.evidence_id
        """, (spec_id,)).fetchall()
        blob = "".join(r[0] for r in rows).lower()
        return hashlib.sha256(blob.encode()).hexdigest()

    good = recompute("S1")
    conn.execute("UPDATE spec SET code_artifact_sha256=? WHERE id='S1'", (good,))
    stored = conn.execute("SELECT code_artifact_sha256 FROM spec WHERE id='S1'").fetchone()[0]
    ok = stored == good
    conn.execute("UPDATE spec SET code_artifact_sha256='手填的值' WHERE id='S1'")
    tampered = conn.execute("SELECT code_artifact_sha256 FROM spec WHERE id='S1'").fetchone()[0]
    detected = recompute("S1") != tampered
    record("PASS" if ok and detected else "FAIL", "8. 派生列：应用层重算 + verify 可发现手填",
           f"重算一致={ok}；手填后 verify 能发现={detected}（DB 本身不拦，这是 G2=A 的已知边界）")


def probe_registry() -> None:
    """G3 已定：唯一入口校验（模拟注册器）。"""
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    seed(conn)

    def register(cid: str, spec_id: str) -> str:
        negatives = conn.execute(
            "SELECT count(*) FROM criterion_fixture WHERE criterion_id=? AND polarity='negative'",
            (cid,)).fetchone()[0]
        remedy = conn.execute("SELECT remedy FROM criterion WHERE id=?", (cid,)).fetchone()
        if not remedy or not remedy[0].strip():
            return "remedy_required"
        if negatives == 0:
            return "negative_fixture_required"
        return "ok"

    # C1 无夹具
    first = register("C1", "S1")
    conn.execute("INSERT INTO criterion_fixture VALUES ('F1','C1','negative','bad','fail')")
    second = register("C1", "S1")
    ok = first == "negative_fixture_required" and second == "ok"
    record("PASS" if ok else "FAIL", "10. 判据注册门槛（唯一入口校验）",
           f"无负例被拒={first}；补负例后通过={second}")


def probe_fixture_cardinality() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    seed(conn)
    ok = True
    try:
        conn.execute("INSERT INTO criterion_fixture VALUES ('F1','C1','positive','in1','pass')")
        conn.execute("INSERT INTO criterion_fixture VALUES ('F2','C1','positive','in2','pass')")
    except sqlite3.IntegrityError as e:
        ok = False
        detail = f"同极性第二条被拒：{e}"
    detail = "同极性允许多条（多组负例可用于变异自证）" if ok else detail
    try:
        conn.execute("INSERT INTO criterion_fixture VALUES ('F3','C1','positive','in1','pass')")
    except sqlite3.IntegrityError:
        dup = "同一输入重复被拒"
    else:
        ok = False
        dup = "同一输入重复未被拒"
    record("PASS" if ok else "FAIL", "9. 夹具基数：同极性可多条、同输入不重复", f"{detail}；{dup}")


def probe_single_work_unit() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    build(conn)
    seed(conn)
    conn.execute("INSERT INTO criterion VALUES ('C2','S2','mech','pass|fail|na','补')")
    conn.execute("INSERT INTO evidence VALUES ('E2','C2','uri','sha2','cmd','od','snap1','t0')")
    conn.execute("INSERT INTO work_unit VALUES ('W1','T1','C1','S1','E1','t0')")
    try:
        conn.execute("INSERT INTO work_unit VALUES ('W2','T1','C2','S2','E2','t0')")
    except sqlite3.IntegrityError:
        record("PASS", "11. 一卡一行（UNIQUE(task_id)）", "同一 task 第二行被拒绝")
    else:
        record("FAIL", "11. 一卡一行", "同一 task 插入了两行 work_unit")


def probe_event_kind_closure() -> None:
    conn = sqlite3.connect(":memory:")
    build(conn)
    conn.execute("INSERT INTO event_kind VALUES ('test.event','t0','探针用')")
    try:
        conn.execute("INSERT INTO event (kind,payload,frontier,prev_hash,hash,at) "
                     "VALUES ('whatever.happened','{}','f0','0','h0','t0')")
    except sqlite3.IntegrityError:
        record("PASS", "12. 事件 kind 闭包（event_kind 参考表）", "未知 kind 被外键拒绝")
    else:
        record("FAIL", "12. 事件 kind 闭包", "任意 kind 仍能写入")

def main() -> int:
    print("== 可执行性探针 ==")
    probe_schema()
    probe_composite_fk()
    probe_ancestry()
    probe_events()
    probe_two_phase()
    probe_gate()
    probe_single_writer()
    probe_derived()
    probe_registry()
    probe_fixture_cardinality()
    probe_single_work_unit()
    probe_event_kind_closure()

    fails = [r for r in results if r[0] == "FAIL"]
    gaps = [r for r in results if r[0] == "GAP"]
    passes = [r for r in results if r[0] == "PASS"]
    print(f"\n汇总：PASS {len(passes)} / GAP {len(gaps)} / FAIL {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
