/**
 * **工作树状态读取（第六批 §3.6 / `DEF-080`）。**
 *
 * 只做一件事：读出**被跟踪文件的未提交改动**（相对工作区的仓库路径）。
 * 为什么只算被跟踪：未跟踪文件（`??`）不是"别人正在写的交付"—— 它是本地草稿/构建产物/`node_modules`
 * 那一类噪声，把它当"别人的半成品"会把派发面误拦成不可用（语言与项目无关：只看 git 自己的事实）。
 *
 * 读不动时**不许假装干净**：`ok: false` 由调用方按"判不了 ⇒ 不拦"处理（与 `DEF-054`/`R17`
 * 同一方向：认不出不硬猜），并把原因带出去供人判读。
 */
import { execFileSync } from 'node:child_process'

export interface DirtyWorktree {
  /** 判定是否可用：git 不在 / 不是仓库 / 命令失败 ⇒ `false` */
  ok: boolean
  /** **被跟踪**文件里未提交改动的仓库路径（已按工作区前缀归一；未跟踪文件不计） */
  tracked: string[]
  /** `ok === false` 时的可读原因 */
  reason?: string
}

export function readDirtyWorktree(workspace: string): DirtyWorktree {
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    // 工作区可能是仓库的子目录：git 的 porcelain 路径可能带前缀，先取前缀再归一（两次都试，缺前缀则原样）
    let prefix = ''
    try {
      prefix = run(['rev-parse', '--show-prefix']).trim()
    } catch {
      prefix = ''
    }
    // **DEF-084（第七批 §3.2）**：必须用 `-z`。默认出参受 `core.quotePath=true` 影响，会把非 ASCII
    // 文件名**八进制转义**（`文档/说明.md` ⇒ `"\\346\\226\\207…"`）⇒ 与写范围里的真名**永不相等**
    //（违反"语言无关"长期约束；中文名在本仓是常态）。`-z` 直接给**原始字节**、以 `\0` 分隔，
    // 且**改名条目会多一段**（`XY <新路径>\0<旧路径>\0`）⇒ 取新路径并跳过紧随的旧路径段。
    // **不自己写反转义实现**（优先让 git 给原文）：源码里也不许出现八进制反转义。
    const raw = run(['status', '--porcelain', '-z', '--untracked-files=no'])
    const tracked: string[] = []
    const parts = raw.split('\0')
    for (let index = 0; index < parts.length; index += 1) {
      const entry = parts[index] ?? ''
      if (entry === '') continue
      const status = entry.slice(0, 2)
      const path = entry.slice(3)
      // 改名 / 复制：紧随其后的那一段是**旧路径**，跳过（工作区里现在存在的是新路径）
      if (status.startsWith('R') || status.startsWith('C')) index += 1
      // **porcelain 的路径恒为「仓库根相对」**（实测：在子目录里跑也是仓库根相对）⇒
      // 工作区是仓库子目录时：① 剥掉工作区前缀；② **不属于工作区的改动直接丢掉**
      //（否则"仓库别处的未提交文件"会被当成"压在这张卡写范围上"，把派发面误拦）。
      let relative = path
      if (prefix !== '') {
        if (!relative.startsWith(prefix)) continue
        relative = relative.slice(prefix.length)
      }
      if (relative !== '') tracked.push(relative)
    }
    return { ok: true, tracked: [...new Set(tracked)] }
  } catch (error) {
    return { ok: false, tracked: [], reason: error instanceof Error ? error.message : String(error) }
  }
}
