/**
 * **只读式变异复跑钩子**（TASK-072 / REV-038 核实用；不参与任何交付逻辑）。
 *
 * 为什么需要它：卡 `done` 之后沙箱禁止再写 `lib/`，所以"把变异体拷回工作区再原样跑一遍"
 * 这条路被封了（这是对的 —— 交付件不该留可被覆盖的编译产物）。这里改用**模块解析重定向**：
 * 把编译产物 `lib/src/domain/collab.js` 的解析指向留档的变异体
 * `node_modules/.sdo-test/m100-mutation/collab.js.mutant`，**工作区一个字节都不动**。
 *
 * 变异体与编译产物同形（同一份 `tsc` 产物只改了一处判定式），但它在留档目录里，
 * 相对 `import './xxx.js'` 会指错地方 —— 所以 `load` 钩子按「编译产物的原位置
 * `lib/src/domain/`」重算那些相对 specifier，语义与原地替换完全一致。
 *
 * 用法：`node --import ./test/m100-redirect.mjs --test lib/test/m100.test.js`
 */
/** 变异注入点：把「open 也当可闭合」塞进去（与 tdd.yml 第二条第 436 行逐字一致）。 */
const ANCHOR = "status === 'fixed' || status === 'closed'"
const INJECTED = "status === 'fixed' || status === 'closed' || status === 'open'"
const COLLAB_SUFFIX = '/lib/src/domain/collab.js'

/** 变异体 = **当前树**编译产物 + 一处注入。为什么不钉死留档副本：本模块长期在被别的卡编辑，
 *  留档副本的**模块契约**会随新导出漂移（实测：collab.js 新增 `declaredItemGaps` 后，
 *  留档变异体缺该导出 ⇒ 整个测试文件加载失败）。取其源、当场注入，既免疫漂移，
 *  又让「注入了什么」逐字可读 —— 注入串与 tdd.yml 的 target 同一句话。 */
async function mutantSource() {
  const { readFile } = await import('node:fs/promises')
  const { resolve: resolvePath, dirname } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const pkgRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
  const greenPath = resolvePath(pkgRoot, 'lib/src/domain/collab.js')
  const source = await readFile(greenPath, 'utf8')
  const parts = source.split(ANCHOR)
  // 注入点必须**唯一存在**：形状变了就大声失败，绝不静默产出"变异体其实没变异"
  if (parts.length !== 2) throw new Error(`m100-hooks: 变异注入点不唯一（命中 ${parts.length - 1} 次，期望 1 次）—— 判据形状变了，请更新 ANCHOR`)
  const mutated = parts.join(INJECTED)
  const originalDir = resolvePath(pkgRoot, 'lib/src/domain')
  const rewritten = mutated.replace(
    /from\s+'(\.[^']*)'/gu,
    (_all, specifier) => `from '${pathToFileURL(resolvePath(originalDir, specifier)).href}'`,
  )
  return rewritten
}

export async function resolve(specifier, context, nextResolve) {
  const hit = await nextResolve(specifier, context)
  if (typeof hit?.url === 'string' && hit.url.endsWith(COLLAB_SUFFIX)) {
    // 用一个不会与真文件冲突的虚拟 URL 承载变异源（避免自指）
    return { url: new URL('./.m100-mutant.mjs', import.meta.url).href, shortCircuit: true }
  }
  return hit
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/test/.m100-mutant.mjs')) {
    return { format: 'module', source: await mutantSource(), shortCircuit: true }
  }
  return nextLoad(url, context)
}
