import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { SdoPathError, SdoStore } from '../src/infra/store.js'

const ROOT = fileURLToPath(new URL('../../node_modules/.sdo-test/store/', import.meta.url))

let store: SdoStore

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  store = new SdoStore(join(ROOT, '.sdo'))
  store.ensureLayout()
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

test('路径沙箱：拒绝逃出项目目录（E2E-07 / NFR-007）', () => {
  assert.throws(() => store.path('..', 'etc', 'passwd'), SdoPathError)
  assert.throws(() => store.path('requirements', '..', '..', 'x.yml'), SdoPathError)
  assert.throws(() => store.path('/etc/passwd'), SdoPathError)
  assert.throws(() => store.path('a\0b'), SdoPathError)
  const ok = store.path('requirements', 'REQ-001.yml')
  assert.ok(ok.endsWith('requirements/REQ-001.yml'))
})

test('原子写：内容落盘、权限 0600、不留临时文件', () => {
  store.writeText(['requirements', 'REQ-001.yml'], 'id: REQ-001')
  const text = store.readText('requirements', 'REQ-001.yml')
  assert.equal(text, 'id: REQ-001\n', '写入统一补行尾换行')
  if (process.platform !== 'win32') {
    // Windows 没有 POSIX 权限位：stat 合成的 mode 恒为 0o666/0o444，
    // 断 0600 会必然失败（实测 438 = 0o666 vs 384 = 0o600）。写入侧的 { mode: 0o600 } 仍然保留，
    // 只是 Windows 上无法观测。
    assert.equal(store.modeOf('requirements', 'REQ-001.yml'), 0o600)
  }
  const leftovers = readdirSync(store.path('requirements')).filter((n) => n.startsWith('.tmp-'))
  assert.deepEqual(leftovers, [], '不应残留临时文件')
})

test('YAML 与 JSON 往返', () => {
  const value = { id: 'REQ-001', title: '标题：含冒号', acceptance: [{ statement: '可判定' }] }
  store.writeYaml(['requirements', 'REQ-001.yml'], value)
  assert.deepEqual(store.readYaml('requirements', 'REQ-001.yml'), value)

  store.writeJson(['project.json'], { id: 'PRJ-001' })
  assert.deepEqual(store.readJson('project.json'), { id: 'PRJ-001' })
  if (process.platform !== 'win32') assert.equal(store.modeOf('project.json'), 0o600)
})

test('追加行与列举、删除', () => {
  store.appendLine(['journal.jsonl'], '{"seq":1}')
  store.appendLine(['journal.jsonl'], '{"seq":2}')
  assert.equal(store.readText('journal.jsonl'), '{"seq":1}\n{"seq":2}\n')
  store.writeYaml(['requirements', 'REQ-001.yml'], { id: 'REQ-001' })
  store.writeYaml(['requirements', 'REQ-002.yml'], { id: 'REQ-002' })
  assert.deepEqual(store.listNames('requirements'), ['REQ-001.yml', 'REQ-002.yml'])
  store.remove('requirements', 'REQ-002.yml')
  assert.equal(store.exists('requirements', 'REQ-002.yml'), false)
  assert.deepEqual(store.listNames('requirements'), ['REQ-001.yml'])
})

test('relativeTo 只给相对路径（NFR-009）', () => {
  const target = store.path('requirements', 'REQ-001.yml')
  assert.equal(store.relativeTo(target), 'requirements/REQ-001.yml')
  assert.equal(existsSync(store.root), true)
})
