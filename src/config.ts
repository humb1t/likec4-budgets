import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import type { Config, Rule, Selector, Warning } from './types.js'

/** Bad input: not a model problem, not a budget problem. The CLI answers it with exit code 2. */
export class UsageError extends Error {
  override name = 'UsageError'
}

const schemaPath = fileURLToPath(new URL('../schema/config.schema.json', import.meta.url))

let validator: ReturnType<Ajv['compile']> | undefined

function schemaValidator() {
  if (!validator) {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
    const ajv = new Ajv({ allErrors: false, discriminator: true, strict: true })
    validator = ajv.compile(schema)
  }
  return validator
}

export function loadConfig(path: string): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UsageError(`cannot read config ${path}: ${(err as Error).message}`)
  }
  try {
    return validateConfig(raw)
  } catch (err) {
    if (err instanceof UsageError) throw new UsageError(`${path}: ${err.message}`)
    throw err
  }
}

/** Schema check, then the checks a schema cannot make (names that must refer to each other). */
export function validateConfig(raw: unknown): Config {
  const validate = schemaValidator()
  if (!validate(raw)) {
    const e = validate.errors?.[0]
    const where = e?.instancePath ? e.instancePath : '(root)'
    throw new UsageError(`invalid config at ${where}: ${e?.message ?? 'unknown error'}${e?.params ? ' ' + JSON.stringify(e.params) : ''}`)
  }
  const cfg = raw as Config
  const weights = Object.keys(cfg.relationships.weights)
  const kindOk = (k: string) => weights.includes(k)
  const fail = (msg: string): never => {
    throw new UsageError(msg)
  }

  const unitMeta = unitMetadata(cfg)
  for (const dim of cfg.model.dimensions) {
    const def = unitMeta[dim]
    if (!def?.values) fail(`dimension '${dim}' needs a metadata definition with values for units`)
  }
  const roles = new Set(['units', 'externals', 'containers', 'entities'])
  const allKinds = new Set([
    ...cfg.model.unitKinds,
    ...cfg.model.entityKinds,
    ...(cfg.model.containerKinds ?? []),
    ...(cfg.model.externalKinds ?? []),
  ])
  for (const key of Object.keys(cfg.model.metadata)) {
    if (!roles.has(key) && !allKinds.has(key)) fail(`model.metadata.${key} is neither a role nor a declared kind`)
  }
  const overlap = [...cfg.model.unitKinds, ...cfg.model.entityKinds, ...(cfg.model.containerKinds ?? []), ...(cfg.model.externalKinds ?? [])]
  if (new Set(overlap).size !== overlap.length) fail('a kind is listed under more than one of unitKinds, entityKinds, containerKinds, externalKinds')
  for (const [key, b] of Object.entries(cfg.model.belongsTo ?? {})) {
    const child = unitMeta[key]?.values
    const parent = unitMeta[b.within]?.values
    if (!child || !parent) fail(`model.belongsTo.${key}: both '${key}' and '${b.within}' need values for units`)
    for (const v of child ?? []) {
      const to = b.map[v]
      if (to === undefined || !parent?.includes(to)) fail(`model.belongsTo.${key}.map: '${v}' must map to a value of '${b.within}'`)
    }
  }
  for (const key of cfg.model.placement?.keys ?? []) {
    if (!unitMeta[key]) fail(`model.placement.keys: '${key}' is not a unit metadata key`)
  }
  for (const w of Object.values(cfg.relationships.weights)) {
    if (!Number.isFinite(w)) fail('relationships.weights must be finite numbers')
  }

  const ids = new Set<string>()
  const checkSelector = (where: string, sel: Selector, allowRelative: boolean) => {
    for (const [key, m] of Object.entries(sel)) {
      if (!unitMeta[key]) fail(`${where}: selector key '${key}' is not a unit metadata key`)
      const relative = typeof m === 'object' && !Array.isArray(m) && ('same' in m || 'different' in m)
      if (relative && !allowRelative) fail(`${where}: {same}/{different} is only valid in a 'to' selector`)
    }
  }
  const checkKinds = (where: string, kinds: string[] | undefined) => {
    for (const k of kinds ?? []) if (!kindOk(k)) fail(`${where}: '${k}' is not a relationship kind with a weight (${weights.join(', ')})`)
  }
  const checkBase = (where: string, id: string) => {
    if (ids.has(id)) fail(`${where}: duplicate id '${id}'`)
    ids.add(id)
  }
  for (const r of cfg.rules as Rule[]) {
    const where = `rule ${r.id}`
    checkBase(where, r.id)
    switch (r.type) {
      case 'allowedKinds':
        checkSelector(where, r.from, false)
        checkSelector(where, r.to, true)
        checkKinds(where, r.allowed)
        for (const p of r.pairs ?? []) checkKinds(where, p.kinds)
        break
      case 'fanOut':
        checkSelector(where, r.from, false)
        checkSelector(where, r.to, true)
        checkKinds(where, r.kinds)
        if (typeof r.max === 'object' && !unitMeta[r.max.by]) fail(`${where}: max.by '${r.max.by}' is not a unit metadata key`)
        break
      case 'needsInbound':
        checkSelector(where, r.from, false)
        checkSelector(where, r.to, true)
        checkSelector(where, r.inbound.from, false)
        checkKinds(where, r.inbound.kinds)
        break
      case 'maxWeightedOut':
        checkSelector(where, r.units, false)
        break
      case 'maxWeightedLeaving':
        checkSelector(where, r.group, false)
        break
      case 'callCycles':
        checkKinds(where, [r.kind])
        break
      case 'entitiesPerUnit':
        if (r.min > r.max) fail(`${where}: min is above max`)
        break
    }
  }
  for (const w of (cfg.warnings ?? []) as Warning[]) {
    const where = `warning ${w.id}`
    checkBase(where, w.id)
    switch (w.type) {
      case 'unreferenced':
        checkSelector(where, w.units, false)
        break
      case 'taggedRelationships':
        checkSelector(where, w.from, false)
        checkSelector(where, w.to, true)
        checkKinds(where, w.kinds)
        break
      case 'hub':
        checkSelector(where, w.units, false)
        if (!unitMeta[w.peers]) fail(`${where}: peers '${w.peers}' is not a unit metadata key`)
        break
      case 'singleEntity':
        break
    }
  }
  return cfg
}

/** The metadata a unit kind carries: the `units` role. */
export function unitMetadata(cfg: Config): Record<string, { values?: string[]; optional?: boolean }> {
  return cfg.model.metadata['units'] ?? {}
}

/** Metadata definitions that apply to one element kind: its roles first, its own entry last. */
export function metadataFor(cfg: Config, kind: string): Record<string, { values?: string[]; optional?: boolean }> {
  const m = cfg.model
  const out: Record<string, { values?: string[]; optional?: boolean }> = {}
  const role = m.unitKinds.includes(kind)
    ? 'units'
    : m.entityKinds.includes(kind)
      ? 'entities'
      : m.containerKinds?.includes(kind)
        ? 'containers'
        : m.externalKinds?.includes(kind)
          ? 'externals'
          : undefined
  if (role && m.metadata[role]) Object.assign(out, m.metadata[role])
  if (m.metadata[kind]) Object.assign(out, m.metadata[kind])
  return out
}
