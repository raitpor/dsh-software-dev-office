/**
 * `M212-01`（`DEF-154` 的守卫）：**绝对路径 ⇄ 工作区根**的归属判定必须跨平台一致。
 *
 * 病（Windows CI 实测 39 格红）：`scopePaths.classifyTarget` 用
 * `` `${resolve(root).replace(/\/+$/u, '')}/` `` 拼前缀，而 `resolve()` 在 win32 返回**反斜杠**
 * ⇒ `'D:\\a\\p\\src\\x.ts'.startsWith('D:\\a\\p/')` **恒 false** ⇒ 工作区内的一切写入被判
 * 「工作区之外」⇒ 卡片写范围在 Windows 上**全量误拒**（不是"少拦"，是"干不了活"）。
 *
 * 这一格**不依赖 Windows 机器**：把判定提成纯函数 `workspaceRelation(absolute, root, opts)`，
 * 直接喂 win32 形态的字符串即可复现修前必红、修后必绿。三条口径各一格 + 一条反例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { workspaceRelation } from '../src/domain/scopePaths.js'

test('M212-01 win32 形态：反斜杠绝对路径必须落在反斜杠根之下（修前恒判 outside）', () => {
  // 修前的机制逐字回放：拼前缀用的是 `/`，而 resolve 在 win32 给的是 `\` ⇒ 永不匹配
  assert.equal(
    'D:\\a\\p\\src\\x.ts'.startsWith('D:\\a\\p/'),
    false,
    '这就是修前的 bug 机制：前缀里那个硬编码 `/` 让 Windows 上恒不匹配（本行是**反例锚**，不是产品行为）',
  )
  const relation = workspaceRelation('D:\\a\\p\\src\\x.ts', 'D:\\a\\p')
  assert.equal(relation.kind, 'inside', '反斜杠绝对路径在反斜杠根之下必须判 inside')
  assert.equal(relation.relative, 'src/x.ts', '相对路径要按 `/` 归一（下游写范围判定吃的是这个形态）')
})

test('M212-02 混合分隔符：根写 `/`、路径写 `\\`（宿主与配置写法不一致）也必须判 inside', () => {
  assert.equal(workspaceRelation('D:\\a\\p\\src\\x.ts', 'D:/a/p').kind, 'inside', '两边分隔符写法不同不许影响归属')
  assert.equal(workspaceRelation('D:/a/p/src/x.ts', 'D:\\a\\p').kind, 'inside', '反过来的混合形态同样要成立')
  assert.equal(workspaceRelation('D:\\a\\p', 'D:/a/p/').kind, 'same', '尾部斜杠不影响"就是根本身"的判定')
})

test('M212-03 大小写：win32 忽略、POSIX 不许忽略（口径不许从平台 A 泄漏到平台 B）', () => {
  assert.equal(
    workspaceRelation('d:\\a\\p\\src\\x.ts', 'D:\\a\\p', { caseInsensitive: true }).kind,
    'inside',
    'Windows 路径大小写不敏感：盘符/目录大小写不同仍是同一个工作区',
  )
  assert.equal(
    workspaceRelation('/a/Proj/src/x.ts', '/a/proj').kind,
    'outside',
    'POSIX 上 `/a/Proj` 与 `/a/proj` 是**两个目录**：默认必须大小写敏感（放宽只许 win32 显式打开）',
  )
})

test('M212-04 反例：目录边界必须差一个 `/`（前缀相同的兄弟目录不算工作区内）', () => {
  assert.equal(workspaceRelation('D:\\a\\p2\\x.ts', 'D:\\a\\p').kind, 'outside', '`p2` 不是 `p` 的子路径')
  assert.equal(workspaceRelation('/a/project/x.ts', '/a/proj').kind, 'outside', 'POSIX 上同样不许前缀假命中')
  assert.equal(workspaceRelation('D:\\a\\p\\x.ts', '').kind, 'outside', '根为空 ⇒ 判不了归属（fail-closed 方向）')
})
