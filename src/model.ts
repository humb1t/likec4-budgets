import { readFileSync, statSync } from 'node:fs'
import { LikeC4 } from 'likec4'
import { UsageError } from './config.js'
import type { ElementData, ModelData, RelationData } from './types.js'

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Read the JSON `likec4 export json` writes. A single project is a bare object;
 * a workspace export may be a list of projects (an entry can repeat).
 */
export function loadExport(path: string, project?: string): ModelData {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`cannot read export ${path}: ${(err as Error).message}`)
  }
  const items = Array.isArray(data) ? data : [data]
  const found = new Map<string, Record<string, unknown>>()
  for (const item of items) {
    const rec = asRecord(item)
    if (!('elements' in rec)) throw new UsageError(`${path} is not a likec4 json export (no 'elements')`)
    const pid = String(rec['projectId'] ?? '')
    const prev = found.get(pid)
    if (prev && JSON.stringify(prev) !== JSON.stringify(rec)) {
      throw new UsageError(`${path}: two different exports of project '${pid}'`)
    }
    if (!prev) found.set(pid, rec)
  }
  const ids = [...found.keys()].sort()
  let chosen: Record<string, unknown> | undefined
  if (project) {
    chosen = found.get(project)
    if (!chosen) throw new UsageError(`project '${project}' not in ${path}; has ${JSON.stringify(ids)}`)
  } else {
    if (found.size !== 1) throw new UsageError(`${path} holds projects ${JSON.stringify(ids)}; pass --project`)
    chosen = [...found.values()][0]
  }
  return fromExportObject(chosen as Record<string, unknown>)
}

/** Normalise one parsed export object. Exported for tests that edit an export in memory. */
export function fromExportObject(obj: Record<string, unknown>): ModelData {
  const elements: Record<string, ElementData> = {}
  for (const [id, raw] of Object.entries(asRecord(obj['elements']))) {
    const el = asRecord(raw)
    elements[id] = {
      id,
      kind: typeof el['kind'] === 'string' ? el['kind'] : null,
      title: typeof el['title'] === 'string' ? el['title'] : id,
      metadata: asRecord(el['metadata']),
    }
  }
  const relations: Record<string, RelationData> = {}
  for (const [id, raw] of Object.entries(asRecord(obj['relations']))) {
    const rel = asRecord(raw)
    const src = asRecord(rel['source'])['model']
    const dst = asRecord(rel['target'])['model']
    relations[id] = {
      id,
      kind: typeof rel['kind'] === 'string' ? rel['kind'] : null,
      tags: Array.isArray(rel['tags']) ? rel['tags'].filter((t): t is string => typeof t === 'string') : [],
      source: typeof src === 'string' ? src : null,
      target: typeof dst === 'string' ? dst : null,
    }
  }
  return { projectId: String(obj['projectId'] ?? ''), elements, relations }
}

type Instance = Awaited<ReturnType<typeof LikeC4.fromSource>>

/** Read a compiled LikeC4 instance. Parse errors are a model error for the caller (exit 2). */
export async function fromLikeC4(likec4: Instance, project?: string): Promise<ModelData> {
  if (likec4.hasErrors()) {
    const lines = likec4.getErrors().map((e) => `${e.sourceFsPath}:${e.line}: ${e.message}`)
    throw new UsageError(`the LikeC4 model has errors:\n${lines.join('\n')}`)
  }
  const projects = likec4.projects()
  if (!project && projects.length > 1) {
    throw new UsageError(`workspace holds projects ${JSON.stringify([...projects].sort())}; pass --project`)
  }
  if (project && !(projects as readonly string[]).includes(project)) {
    throw new UsageError(`project '${project}' not in workspace; has ${JSON.stringify([...projects].sort())}`)
  }
  const model = await likec4.computedModel(project)
  const elements: Record<string, ElementData> = {}
  for (const el of model.elements()) {
    elements[el.id] = {
      id: el.id,
      kind: el.kind ?? null,
      title: el.title,
      metadata: asRecord(el.getMetadata()),
    }
  }
  const relations: Record<string, RelationData> = {}
  for (const rel of model.relationships()) {
    relations[rel.id] = {
      id: rel.id,
      kind: rel.kind ?? null,
      tags: [...rel.tags],
      source: rel.source.id,
      target: rel.target.id,
    }
  }
  return { projectId: model.project.id, elements, relations }
}

/** Compile a LikeC4 workspace directory with the Model API. */
export async function loadWorkspace(dir: string, project?: string): Promise<ModelData> {
  let likec4: Instance
  try {
    likec4 = await LikeC4.fromWorkspace(dir, { printErrors: false, logger: false, graphviz: 'wasm' })
  } catch (err) {
    throw new UsageError(`cannot load workspace ${dir}: ${(err as Error).message}`)
  }
  try {
    return await fromLikeC4(likec4, project)
  } finally {
    await likec4.dispose()
  }
}

/** Compile LikeC4 source text. Used by tests and by callers that hold the model in memory. */
export async function loadSource(source: string): Promise<ModelData> {
  const likec4 = await LikeC4.fromSource(source, { printErrors: false, logger: false, graphviz: 'wasm' })
  try {
    return await fromLikeC4(likec4)
  } finally {
    await likec4.dispose()
  }
}

/** A directory is a workspace, anything else an export file. */
export async function loadModel(path: string, project?: string): Promise<ModelData> {
  let st
  try {
    st = statSync(path)
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${(err as Error).message}`)
  }
  return st.isDirectory() ? loadWorkspace(path, project) : loadExport(path, project)
}
