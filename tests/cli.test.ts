import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { main, parseStatusFilter } from '../src/cli.js'
import { UsageError } from '../src/config.js'
import { loadExport, loadModel } from '../src/model.js'
import { analyze } from '../src/analyze.js'
import { CONFIG_PATH, EXAMPLE_DIR, config, modelFor, tempDir, toExportJson, writeJson } from './helpers.js'

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await main(args, { stdout: (s) => (out += s), stderr: (s) => (err += s) })
  return { code, out, err }
}

async function exportOf(dir: string, name: string): Promise<string> {
  return writeJson(dir, `${name}.json`, toExportJson(await modelFor(name)))
}

describe('exit codes', () => {
  it('0 when nothing is broken, with both reports written', async () => {
    const dir = tempDir()
    const input = await exportOf(dir, 'ok')
    const mdPath = join(dir, 's.md')
    const jsPath = join(dir, 's.json')
    const r = await cli(input, '-c', CONFIG_PATH, '--out', mdPath, '--json', jsPath)
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(mdPath, 'utf8')).toContain('Status: **pass**')
    expect(JSON.parse(readFileSync(jsPath, 'utf8')).exitCode).toBe(0)
    expect(r.err).toContain('pass (0 violations')
  })

  it('1 when a budget is broken', async () => {
    const input = await exportOf(tempDir(), 'down_calls')
    expect((await cli(input, '-c', CONFIG_PATH, '-q')).code).toBe(1)
  })

  it('2 for a model error', async () => {
    const input = await exportOf(tempDir(), 'meta_missing')
    expect((await cli(input, '-c', CONFIG_PATH, '-q')).code).toBe(2)
  })

  it('2 for usage errors', async () => {
    const dir = tempDir()
    const ok = await exportOf(dir, 'ok')
    expect((await cli()).code).toBe(2)
    expect((await cli('/nonexistent.json', '-c', CONFIG_PATH)).code).toBe(2)
    expect((await cli(ok, '-c', CONFIG_PATH, '--project', 'nope')).code).toBe(2)
    expect((await cli(ok, '-c', join(dir, 'missing.json'))).code).toBe(2)
    expect((await cli(ok, '-c', CONFIG_PATH, '--nonsense')).code).toBe(2)
    const notJson = join(dir, 'b.json')
    writeFileSync(notJson, '{not json')
    expect((await cli(notJson, '-c', CONFIG_PATH)).code).toBe(2)
    const emptyConfig = writeJson(dir, 'empty.json', {})
    expect((await cli(ok, '-c', emptyConfig)).code).toBe(2)
  })

  it('prints the Markdown to stdout without --out, and nothing with --quiet', async () => {
    const input = await exportOf(tempDir(), 'ok')
    const r = await cli(input, '-c', CONFIG_PATH)
    expect(r.code).toBe(0)
    for (const section of ['## Warnings', '## Merge candidates', '## Externals', '## Knowledge matrix']) expect(r.out).toContain(section)
    expect((await cli(input, '-c', CONFIG_PATH, '-q')).out).toBe('')
  })

  it('prints --help and exits 0', async () => {
    const r = await cli('--help')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Exit codes: 0 pass')
  })

  it('writes byte-identical reports on two runs', async () => {
    const dir = tempDir()
    const input = await exportOf(dir, 'down_calls')
    const outs: Buffer[][] = []
    for (const i of [1, 2]) {
      const md = join(dir, `${i}.md`)
      const js = join(dir, `${i}.json`)
      await cli(input, '-c', CONFIG_PATH, '--status', 'live,wip', '--out', md, '--json', js)
      outs.push([readFileSync(md), readFileSync(js)])
    }
    expect(outs[0]![0]!.equals(outs[1]![0]!)).toBe(true)
    expect(outs[0]![1]!.equals(outs[1]![1]!)).toBe(true)
  })
})

describe('--status', () => {
  it('filters through the CLI', async () => {
    const f = await exportOf(tempDir(), 'filter_planned_only')
    expect((await cli(f, '-c', CONFIG_PATH, '-q')).code).toBe(1)
    expect((await cli(f, '-c', CONFIG_PATH, '--status', 'live', '-q')).code).toBe(0)
    expect((await cli(f, '-c', CONFIG_PATH, '--status', 'live,wip', '-q')).code).toBe(0)
    expect((await cli(f, '-c', CONFIG_PATH, '--status', 'planned', '-q')).code).toBe(1)
    for (const bad of ['done', '', 'live,done']) expect((await cli(f, '-c', CONFIG_PATH, '--status', bad, '-q')).code, bad).toBe(2)
    expect((await cli(f, '-c', CONFIG_PATH, '--status', 'live,wip')).out).toContain('Filter: `--status live,wip`')
  })

  it('ignores order and repeats', () => {
    expect(parseStatusFilter('wip, live,live', ['live', 'wip', 'planned'])).toEqual(['live', 'wip'])
    expect(parseStatusFilter(undefined, ['live'])).toBeNull()
    expect(() => parseStatusFilter('live', [])).toThrow(UsageError)
  })
})

describe('inputs', () => {
  it('reads a LikeC4 workspace directory', async () => {
    const r = await cli(EXAMPLE_DIR, '-c', CONFIG_PATH, '-q')
    expect(r.code, r.err).toBe(0)
    expect(r.err).toContain('pass (0 violations, 0 warnings, 0 model errors)')
  })

  it('reads a workspace and a real `likec4 export json` of it alike', async () => {
    const dir = tempDir()
    const out = join(dir, 'likec4.json')
    const bin = fileURLToPath(new URL('../node_modules/.bin/likec4', import.meta.url))
    execFileSync(bin, ['export', 'json', '--skip-layout', '-o', out, EXAMPLE_DIR], { stdio: 'pipe' })
    const fromExport = analyze(loadExport(out), config)
    const fromWorkspace = analyze(await loadModel(EXAMPLE_DIR), config)
    expect(fromExport).toEqual(fromWorkspace)
    expect(fromExport.summary.units).toBe(11)
  })

  it('accepts a list of projects in one export, and picks one by --project', async () => {
    const dir = tempDir()
    const one = toExportJson(await modelFor('ok')) as { projectId: string }
    const other = { ...one, projectId: 'other' }
    const list = writeJson(dir, 'list.json', [one, one, other])
    expect(loadExport(list, 'default').projectId).toBe('default')
    expect(() => loadExport(list)).toThrow(/pass --project/)
    const same = writeJson(dir, 'same.json', [one, one])
    expect(loadExport(same).projectId).toBe('default')
    const clash = writeJson(dir, 'clash.json', [one, { ...one, elements: {} }])
    expect(() => loadExport(clash)).toThrow(/two different exports/)
  })

  it('treats a workspace with a parse error as a model error (exit 2)', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'ws'))
    writeFileSync(join(dir, 'ws', 'spec.c4'), 'specification {\n  element unit\n}\n')
    writeFileSync(join(dir, 'ws', 'model.c4'), "model {\n  unit a 'A' {\n")
    const r = await cli(join(dir, 'ws'), '-c', CONFIG_PATH)
    expect(r.code).toBe(2)
    expect(r.err).toContain('the LikeC4 model has errors')
  })

  it('refuses a JSON that is not an export', async () => {
    const dir = tempDir()
    const p = writeJson(dir, 'x.json', { hello: 1 })
    expect((await cli(p, '-c', CONFIG_PATH)).code).toBe(2)
  })

  it('ships the example with a clean passing model', () => {
    expect(readdirSync(EXAMPLE_DIR).sort()).toEqual(['likec4-budgets.json', 'likec4.config.json', 'model.c4', 'spec.c4'])
  })
})
