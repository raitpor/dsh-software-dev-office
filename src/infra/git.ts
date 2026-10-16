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
    const raw = run(['status', '--porcelain', '--untracked-files=no'])
    const tracked: string[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const rest = line.slice(3).trim()   // 形如 `XY <path>`；`XY` 恒为两列
      // 改名形态 `R  old -> new`：取新路径（那才是工作区里现在存在的那个）
      const arrow = rest.indexOf(' -> ')
      let path = arrow >= 0 ? rest.slice(arrow + 4) : rest
      if (path.startsWith('"') && path.endsWith('"') && path.length > 1) path = path.slice(1, -1)
      // **porcelain 的路径恒为「仓库根相对」**（实测：在子目录里跑也是仓库根相对）⇒
      // 工作区是仓库子目录时：① 剥掉工作区前缀；② **不属于工作区的改动直接丢掉**
      //（否则"仓库别处的未提交文件"会被当成"压在这张卡写范围上"，把派发面误拦）。
      if (prefix !== '') {
        if (!path.startsWith(prefix)) continue
        path = path.slice(prefix.length)
      }
      if (path !== '') tracked.push(path)
    }
    return { ok: true, tracked: [...new Set(tracked)] }
  } catch (error) {
    return { ok: false, tracked: [], reason: error instanceof Error ? error.message : String(error) }
  }
}
