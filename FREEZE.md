# 冻结记录 · design-v2.0

> 冻结的是**尺子**，不是代码。从这一版起，实现按这份设计做；设计本身不再原地改。

| 项 | 值 |
|---|---|
| 版本 | `design-v2.0` |
| 提交 | `f37f4dc`（工作树干净） |
| 标签 | `frozen/design-v2.0`（annotated） |
| 冻结范围 | `docs/` + `design/`（含图源 `.puml`/`.dot` 与两个检查器），共 **53** 个文件 |
| 清单摘要 | `sha256:7e2f7ce43e7b14c32b8927e24d26d4903471a1bd2f5850c41ca0ca2984d7f6e3` |
| 冻结依据 | 第 45 轮独立评审判“可以提交”；`make all` 绿（docs 17 篇、probe 25 PASS、design 20 类） |

## 1. 清单怎么复算

```bash
python3 - <<'PY'
import hashlib, os
files = sorted(p for root in ('docs', 'design') for dp, _, fn in os.walk(root)
               for p in (os.path.join(dp, f) for f in fn)
               if p.endswith(('.md', '.py', '.puml', '.dot')))
man = "".join(f"{hashlib.sha256(open(p,'rb').read()).hexdigest()}  {p}\n" for p in files)
print(len(files), hashlib.sha256(man.encode()).hexdigest())
PY
```

应输出 `53 7e2f7ce43e7b14c32b8927e24d26d4903471a1bd2f5850c41ca0ca2984d7f6e3`。
实现仓库的 `sdo_check` 将来要能对这份清单做同样的核对——**冻结不是一句“我们说冻了”，是一个可复算的哈希**。

## 2. 冻结之后什么能动、什么不能

| 对象 | 能改吗 | 怎么改 |
|---|---|---|
| `docs/`、`design/` | **不能**（原地） | 只能另起版本：`design-v2.1` 标签 + 变更理由 + 人签。实现期发现的缺口先记台账（见 §3），攒够一批再改版，不做“边写边改尺子” |
| `probe/`、`Makefile`、`mdtable.py` | 能 | 属于工具与证据，不是尺子。但 probe 的红线是**只增不减**：已有的 25 条不许因为改断言而变绿 |
| `plan/`、实现代码 | 能 | 这是执行面，本来就该动 |

**为什么连检查器一起冻**：`design/check.py` 决定“什么算漂移”。不冻它，就等于允许在实现期悄悄放松尺子——那三条保证里第 3 条（能证明按约定标准做对）会先破。

## 3. 实现期发现设计问题怎么办

一律先记 [plan/03-偏差台账.md](plan/03-偏差台账.md)，**不在实现里私自绕**。台账每条写清：哪条设计、怎么撞上的、绕过去的代价、建议改法。

分流规则（由人定，不由实现者定）：

- **解释得通**：设计没写死，台账记“按 X 解释”，不改设计；
- **设计缺失**：记 `gap`，实现先按最小可行做并标 `TODO(gap)`，进下一个设计版本；
- **设计错了**：立即停相关卡，记 `defect`，改版本后再继续——**不许“先按错的做完再补”**。

## 4. 与 SDO v2 接管的关系

接管后，这份冻结记录就是第一个 `baseline` 的输入：`policy` + 24 条判据 + gate 目录 + 阈值 + assurance + engine + artifact_kinds 冻结成一个 hash，人签。详见 [plan/02-SDO接管方案.md](plan/02-SDO接管方案.md)。

也就是说：**今天我们手工冻结尺子，将来 SDO 自己冻结尺子**——两者的产物形状必须一样，否则接管就是换了个说法。
