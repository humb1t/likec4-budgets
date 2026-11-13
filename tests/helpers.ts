import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../src/analyze.js'
import { loadConfig } from '../src/config.js'
import { loadSource } from '../src/model.js'
import { renderMarkdown } from '../src/report.js'
import type { Config, ModelData, Report } from '../src/types.js'
import { CASES, SPEC, modelOf, type Case } from './cases.js'

export const EXAMPLE_DIR = fileURLToPath(new URL('../examples/shop', import.meta.url))
export const CONFIG_PATH = join(EXAMPLE_DIR, 'likec4-budgets.json')
export const config: Config = loadConfig(CONFIG_PATH)

/** The shop config with per-rule overrides (by rule or warning id) merged in. */
export function configWith(overrides: Record<string, Record<string, unknown>> | undefined): Config {
  const cfg = structuredClone(config)
  for (const [id, props] of Object.entries(overrides ?? {})) {
    const target = [...cfg.rules, ...(cfg.warnings ?? [])].find((r) => r.id === id)
    if (!target) throw new Error(`no rule or warning ${id}`)
    Object.assign(target, props)
  }
  return cfg
}

const compiled = new Map<string, Promise<ModelData>>()

/** The compiled model of a case, through the real LikeC4 pipeline. Cached. */
export function modelFor(name: string): Promise<ModelData> {
  let p = compiled.get(name)
  if (!p) {
    const c = CASES[name]
    if (!c) throw new Error(`no case ${name}`)
    p = loadSource(SPEC + '\n' + modelOf(c))
    compiled.set(name, p)
  }
  return p
}

export async function run(name: string, status?: string[]): Promise<Report> {
  const c = CASES[name] as Case
  return analyze(await modelFor(name), configWith(c.budgets), { statusFilter: status ?? null })
}

export function md(report: Report, cfg: Config = config): string {
  return renderMarkdown(report, cfg)
}

/** A copy of a model that tests may edit. */
export function clone(model: ModelData): ModelData {
  return structuredClone(model)
}

/** The model in the shape `likec4 export json` writes, for the CLI. */
export function toExportJson(model: ModelData): unknown {
  return {
    projectId: model.projectId,
    elements: model.elements,
    relations: Object.fromEntries(
      Object.entries(model.relations).map(([id, r]) => [
        id,
        { id, kind: r.kind ?? undefined, tags: r.tags, source: { model: r.source }, target: { model: r.target } },
      ]),
    ),
  }
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'likec4-budgets-'))
}

export function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

export function addRelation(model: ModelData, id: string, kind: string, source: string, target: string, tags: string[] = ['planned']) {
  model.relations[id] = { id, kind, tags, source, target }
}
