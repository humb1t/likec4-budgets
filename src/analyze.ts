import { metadataFor, unitMetadata } from './config.js'
import type {
  AllowedKindsRule,
  Config,
  ExternalRow,
  FanOutRule,
  GroupRow,
  GroupTotal,
  MaxWeightedLeavingRule,
  MergeCandidate,
  Metrics,
  ModelData,
  ModelError,
  NeedsInboundRule,
  Report,
  Selector,
  UnitRow,
  Violation,
  WarningRow,
} from './types.js'

/** Identifiers of the model errors. They are fixed: they do not depend on the config. */
export const MODEL_RULES: Record<string, string> = {
  'MODEL-EMPTY': 'the model holds no unit (a parse error can cause this)',
  'MODEL-ELEMENT-KIND': 'element kind outside the contract',
  'MODEL-META-MISSING': 'metadata key missing',
  'MODEL-META-VALUE': 'metadata value outside the contract',
  'MODEL-BELONGS-TO': 'a value does not belong to the value of the key it is nested in',
  'MODEL-PLACEMENT': 'element sits under a container it does not declare, or an external sits outside its place',
  'MODEL-NESTED': 'unit or external nested in a unit or external',
  'MODEL-ENTITY-ORPHAN': 'entity without an owning unit or external',
  'MODEL-CONTAINER-REL': 'relationship starts or ends on a container',
  'MODEL-REL-KIND': 'relationship without a kind that has a weight',
  'MODEL-REL-TAG': 'relationship without exactly one status tag',
  'MODEL-REL-ENDPOINT': 'relationship endpoint is not a model element',
  'MODEL-EXTERNAL-TARGET': 'relationship enters an external from outside (nothing outside an external may know it)',
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Python-style round: half to even on the exact value of the double. Keeps reports comparable with other tools. */
export function round(x: number, digits: number): number {
  const exact = x.toFixed(digits + 30)
  const tail = exact.slice(exact.length - 30)
  if (/^50*$/.test(tail)) {
    const head = exact.slice(0, exact.length - 30)
    const down = Number(head)
    return Number(head[head.length - 1]) % 2 === 0 ? down : Number((down + 10 ** -digits).toFixed(digits))
  }
  return Number(x.toFixed(digits))
}

function ancestors(eid: string): string[] {
  const parts = eid.split('.')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('.'))
  return out
}

interface Unit {
  id: string
  title: string
  kind: string
  attrs: Record<string, string | null>
  entities: string[]
}

interface External {
  id: string
  title: string
  attrs: Record<string, string | null>
  entities: string[]
}

interface Rel {
  id: string
  kind: string
  src: string
  dst: string
  srcUnit: string
  dstUnit: string
  label: string
  status: string | null
  tags: Set<string>
}

function matchValue(m: Selector[string], value: string | null, source: string | null | undefined): boolean {
  if (value === null) return false
  if (typeof m === 'string') return value === m
  if (Array.isArray(m)) return m.includes(value)
  if ('not' in m) return !(Array.isArray(m.not) ? m.not : [m.not]).includes(value)
  if ('same' in m) return source != null && value === source
  return source != null && value !== source
}

export function describeSelector(sel: Selector): string {
  const parts = Object.entries(sel).map(([k, m]) => {
    if (typeof m === 'string') return `${k}=${m}`
    if (Array.isArray(m)) return `${k} in [${m.join(', ')}]`
    if ('not' in m) return `${k} not ${Array.isArray(m.not) ? `in [${m.not.join(', ')}]` : m.not}`
    return 'same' in m ? `${k} same as source` : `${k} differs from source`
  })
  return parts.length ? parts.join(', ') : 'any unit'
}

function sorted<T>(items: Iterable<T>, key: (t: T) => string = (t) => String(t)): T[] {
  return [...items].sort((a, b) => cmp(key(a), key(b)))
}

export interface AnalyzeOptions {
  /** Score only relationships whose status tag is in this list. */
  statusFilter?: string[] | null
}

export function analyze(model: ModelData, cfg: Config, options: AnalyzeOptions = {}): Report {
  const statusFilter = options.statusFilter ?? null
  const weights = cfg.relationships.weights
  const order = Object.keys(weights).sort((a, b) => (weights[a]! - weights[b]!) || cmp(a, b))
  const statusTags = cfg.relationships.statusTags ?? []
  const m = cfg.model
  const dims = m.dimensions
  const unitKinds = new Set(m.unitKinds)
  const externalKinds = new Set(m.externalKinds ?? [])
  const containerKinds = new Set(m.containerKinds ?? [])
  const entityKinds = new Set(m.entityKinds)
  const allKinds = [...m.unitKinds, ...m.entityKinds, ...(m.containerKinds ?? []), ...(m.externalKinds ?? [])]
  const elements = model.elements
  const errors: ModelError[] = []
  const violations: Violation[] = []
  const merr = (rule: string, subject: string, message: string) => errors.push({ rule, subject, message })

  // -- elements: contract of kinds, metadata, nesting
  const units = new Map<string, Unit>()
  const externals = new Map<string, External>()

  const checkMeta = (kind: string, eid: string, meta: Record<string, unknown>) => {
    const attrs: Record<string, string | null> = {}
    for (const [key, def] of Object.entries(metadataFor(cfg, kind))) {
      if (!(key in meta)) {
        if (!def.optional) merr('MODEL-META-MISSING', eid, `metadata key '${key}' is missing`)
        attrs[key] = null
        continue
      }
      const v = meta[key]
      if (def.values) {
        if (typeof v === 'string' && def.values.includes(v)) attrs[key] = v
        else {
          merr('MODEL-META-VALUE', eid, `metadata ${key}=${JSON.stringify(v)} is not one of ${def.values.join(', ')}`)
          attrs[key] = null
        }
      } else if (typeof v === 'string' && v.trim() !== '') attrs[key] = v
      else {
        merr('MODEL-META-VALUE', eid, `metadata '${key}' must be a non-empty string`)
        attrs[key] = null
      }
    }
    for (const [key, b] of Object.entries(m.belongsTo ?? {})) {
      const child = attrs[key]
      const parent = attrs[b.within]
      if (child && parent && b.map[child] !== parent) {
        merr('MODEL-BELONGS-TO', eid, `${key} '${child}' belongs to ${b.within} '${b.map[child]}', not '${parent}'`)
      }
    }
    return attrs
  }

  const effective = (ancMeta: Record<string, unknown>, key: string): string | undefined => {
    const own = ancMeta[key]
    if (typeof own === 'string' && own !== '') return own
    const implied = m.placement?.implied?.[key]
    if (!implied) return undefined
    const from = ancMeta[implied.from]
    return typeof from === 'string' ? implied.map[from] : undefined
  }

  for (const eid of sorted(Object.keys(elements))) {
    const el = elements[eid]!
    const kind = el.kind
    if (kind === null || !allKinds.includes(kind)) {
      merr('MODEL-ELEMENT-KIND', eid, `kind ${JSON.stringify(kind)} is not one of ${allKinds.join(', ')}`)
      continue
    }
    const attrs = checkMeta(kind, eid, el.metadata)
    if (unitKinds.has(kind) || externalKinds.has(kind)) {
      const isUnit = unitKinds.has(kind)
      let withinOk = !isUnit && !m.externalWithin
      for (const anc of ancestors(eid)) {
        const ael = elements[anc]
        const akind = ael?.kind ?? null
        if (akind !== null && (unitKinds.has(akind) || externalKinds.has(akind))) {
          merr('MODEL-NESTED', eid, `sits inside ${akind} ${anc}`)
        } else if (akind !== null && containerKinds.has(akind) && ael) {
          if (isUnit) {
            for (const key of m.placement?.keys ?? []) {
              const mine = attrs[key]
              const want = effective(ael.metadata, key)
              if (mine && want !== undefined && want !== mine) {
                merr('MODEL-PLACEMENT', eid, `declares ${key} ${mine} but sits under ${akind} ${anc}, which holds ${key} ${want}`)
              }
            }
          } else if (m.externalWithin && akind === m.externalWithin.kind) {
            if (Object.entries(m.externalWithin.metadata).every(([k, v]) => ael.metadata[k] === v)) withinOk = true
          }
        }
      }
      if (!isUnit && m.externalWithin && !withinOk) {
        const want = Object.entries(m.externalWithin.metadata).map(([k, v]) => `${k} '${v}'`).join(', ')
        merr('MODEL-PLACEMENT', eid, `an external sits in a ${m.externalWithin.kind} with ${want}`)
      }
      if (isUnit) units.set(eid, { id: eid, title: el.title, kind, attrs, entities: [] })
      else externals.set(eid, { id: eid, title: el.title, attrs, entities: [] })
    }
  }

  if (units.size === 0) {
    merr('MODEL-EMPTY', model.projectId, 'no unit in the model; a passing report of nothing proves nothing')
  }

  const ownerOf = (eid: string): string | null => {
    for (const cand of [eid, ...ancestors(eid).reverse()]) {
      if (units.has(cand) || externals.has(cand)) return cand
    }
    return null
  }

  for (const eid of sorted(Object.keys(elements))) {
    if (elements[eid]!.kind !== null && entityKinds.has(elements[eid]!.kind!)) {
      const owner = ownerOf(eid)
      if (owner === null) merr('MODEL-ENTITY-ORPHAN', eid, 'no unit or external above this entity')
      else (units.get(owner) ?? externals.get(owner))!.entities.push(eid)
    }
  }

  // -- relationships: validate all, then filter by status tag, then resolve
  const rels: Rel[] = []
  const extRels: Rel[] = []
  let modelled = 0
  for (const rid of sorted(Object.keys(model.relations))) {
    const rel = model.relations[rid]!
    const kind = rel.kind
    const src = rel.source
    const dst = rel.target
    const label = `${src} -[${kind ?? '?'}]-> ${dst}`
    if (src === null || dst === null || !(src in elements) || !(dst in elements)) {
      merr('MODEL-REL-ENDPOINT', label, 'an end is not an element of the model')
      continue
    }
    let bad = false
    if (kind === null || !(kind in weights)) {
      merr('MODEL-REL-KIND', label, `kind ${JSON.stringify(kind)} is not one of ${order.join(', ')}`)
      bad = true
    }
    for (const end of [src, dst]) {
      const ek = elements[end]!.kind
      if (ek !== null && containerKinds.has(ek)) {
        merr('MODEL-CONTAINER-REL', label, `${end} is a ${ek}; relate entities or units`)
        bad = true
      }
    }
    const states = statusTags.filter((t) => rel.tags.includes(t))
    if (statusTags.length > 0 && states.length !== 1) {
      merr('MODEL-REL-TAG', label, `needs exactly one of ${statusTags.join(', ')}, has ${states.join(', ') || 'none'}`)
    }
    const sOwn = ownerOf(src)
    const dOwn = ownerOf(dst)
    // An external may relate its own entities. Anything else that ends in one knows it, and nothing may.
    if (dOwn !== null && externals.has(dOwn) && sOwn !== dOwn) {
      merr('MODEL-EXTERNAL-TARGET', label, `${dst} is in external ${dOwn}; nothing outside an external may know it`)
      bad = true
    }
    if (bad || sOwn === null || dOwn === null) continue
    modelled++
    const state = states.length === 1 ? states[0]! : null
    if (statusFilter !== null && (state === null || !statusFilter.includes(state))) continue
    const row: Rel = {
      id: rid, kind: kind!, src, dst, srcUnit: sOwn, dstUnit: dOwn, label, status: state, tags: new Set(rel.tags),
    }
    ;(externals.has(sOwn) ? extRels : rels).push(row)
  }

  const classified = new Set([...units.values()].filter((u) => dims.every((d) => u.attrs[d] != null)).map((u) => u.id))
  const unitOf = (id: string) => units.get(id)!
  const matches = (sel: Selector, u: Unit, source?: Unit): boolean =>
    Object.entries(sel).every(([k, v]) => matchValue(v, u.attrs[k] ?? null, source?.attrs[k]))

  // -- metrics
  const metrics = (members: Set<string>): Metrics => {
    let ents = 0
    for (const id of members) ents += unitOf(id).entities.length
    let internal = 0
    let outN = 0
    let inN = 0
    const outK: Record<string, number> = {}
    const inK: Record<string, number> = {}
    const knownUnits = new Set<string>()
    const knownBy = new Set<string>()
    const knownNodes = new Set<string>()
    for (const r of rels) {
      const sIn = members.has(r.srcUnit)
      const dIn = members.has(r.dstUnit)
      if (sIn && dIn) internal++
      else if (sIn) {
        outN++
        outK[r.kind] = (outK[r.kind] ?? 0) + 1
        knownUnits.add(r.dstUnit)
        knownNodes.add(r.dst)
      } else if (dIn) {
        inN++
        inK[r.kind] = (inK[r.kind] ?? 0) + 1
        knownBy.add(r.srcUnit)
      }
    }
    const ce = knownUnits.size
    const ca = knownBy.size
    const used = order.filter((k) => outK[k])
    const ends = 2 * internal + outN + inN
    let weighted = 0
    for (const [k, n] of Object.entries(outK)) weighted += weights[k]! * n
    return {
      units: members.size,
      entities: ents,
      internal,
      out: Object.fromEntries(order.map((k) => [k, outK[k] ?? 0])),
      in: Object.fromEntries(order.map((k) => [k, inK[k] ?? 0])),
      ce,
      ca,
      instability: ca + ce ? round(ce / (ca + ce), 4) : null,
      breadth: knownNodes.size,
      depth: used.length ? used[used.length - 1]! : null,
      weightedOut: weighted,
      weightedPerEntity: ents ? round(weighted / ents, 2) : null,
      cohesion: ends ? round((2 * internal) / ends, 4) : null,
      knownBy: sorted(knownBy),
      known: sorted(knownUnits),
    }
  }

  const unitRows: Record<string, UnitRow> = {}
  for (const id of sorted(units.keys())) {
    const u = unitOf(id)
    const { cohesion: _c, units: _n, ...rest } = metrics(new Set([id]))
    void _c
    void _n
    unitRows[id] = { id, title: u.title, kind: u.kind, attributes: u.attrs, entityIds: sorted(u.entities), ...rest }
  }
  const unitMeta = unitMetadata(cfg)
  const rollups: Record<string, Record<string, GroupRow>> = {}
  for (const dim of dims) {
    const rows: Record<string, GroupRow> = {}
    for (const value of unitMeta[dim]!.values!) {
      const members = new Set([...classified].filter((s) => unitOf(s).attrs[dim] === value))
      if (members.size === 0) continue
      const { knownBy: _kb, known: _k, ...rest } = metrics(members)
      void _kb
      void _k
      const row: GroupRow = rest
      const b = m.belongsTo?.[dim]
      if (b?.map[value] !== undefined) row.parent = b.map[value]
      rows[value] = row
    }
    rollups[dim] = rows
  }

  // -- matrix: strongest kind from the knower (row) to the known (column)
  const matrix: Record<string, Record<string, string>> = {}
  for (const r of rels) {
    if (r.srcUnit === r.dstUnit) continue
    const row = (matrix[r.srcUnit] ??= {})
    const cur = row[r.dstUnit]
    if (cur === undefined || order.indexOf(r.kind) > order.indexOf(cur)) row[r.dstUnit] = r.kind
  }

  // -- budgets
  const enabled = <T extends { enabled?: boolean }>(x: T) => x.enabled !== false
  const viol = (rule: { id: string; description: string }, subject: string, unit: string, budget: string, observed: string) =>
    violations.push({ rule: rule.id, subject, unit, budget, observed, what: rule.description })

  // Relationships between two different classified units: what every rule reads.
  const pairs = rels.filter((r) => r.srcUnit !== r.dstUnit && classified.has(r.srcUnit) && classified.has(r.dstUnit))
  const rules = cfg.rules.filter(enabled)

  // The graph of relationships of one kind. Built from the relationships, not from the matrix: the matrix
  // keeps the heaviest kind per pair and would hide a call behind a kind that weighs more.
  const callGraph = (kind: string) => {
    const g = new Map<string, Set<string>>()
    for (const r of rels) {
      if (r.kind === kind && r.srcUnit !== r.dstUnit) {
        if (!g.has(r.srcUnit)) g.set(r.srcUnit, new Set())
        g.get(r.srcUnit)!.add(r.dstUnit)
      }
    }
    return g
  }

  const groupTotals: GroupTotal[] = []
  for (const rule of rules) {
    switch (rule.type) {
      case 'allowedKinds': {
        const r0 = rule as AllowedKindsRule
        for (const r of pairs) {
          const s = unitOf(r.srcUnit)
          const d = unitOf(r.dstUnit)
          if (!matches(r0.from, s) || !matches(r0.to, d, s)) continue
          if (r0.allowed.includes(r.kind)) continue
          if ((r0.pairs ?? []).some((p) => p.from === r.srcUnit && p.to === r.dstUnit && p.kinds.includes(r.kind))) continue
          viol(rule, r.label, r.srcUnit, `${rule.id}.allowed = ${JSON.stringify(r0.allowed)}${r0.pairs?.length ? ' and pairs' : ''}`, `kind ${r.kind}`)
        }
        break
      }
      case 'fanOut': {
        const r0 = rule as FanOutRule
        const seen = new Map<string, Set<string>>()
        for (const r of pairs) {
          const s = unitOf(r.srcUnit)
          const d = unitOf(r.dstUnit)
          if (!matches(r0.from, s) || !matches(r0.to, d, s)) continue
          if (r0.kinds && !r0.kinds.includes(r.kind)) continue
          const item = r0.count === 'relationships' ? r.label : r0.count === 'units' ? r.dstUnit : r.dst
          if (!seen.has(r.srcUnit)) seen.set(r.srcUnit, new Set())
          seen.get(r.srcUnit)!.add(item)
        }
        const noun = r0.noun ?? r0.count
        for (const sid of sorted(seen.keys())) {
          const items = sorted(seen.get(sid)!)
          let limit: number
          let path: string
          if (typeof r0.max === 'number') {
            limit = r0.max
            path = `${rule.id}.max = ${limit}`
          } else {
            const by = unitOf(sid).attrs[r0.max.by] ?? ''
            limit = r0.max.values[by] ?? r0.max.default ?? 0
            path = `${rule.id}.max.${by} = ${limit}`
          }
          if (items.length > limit) viol(rule, sid, sid, path, `${items.length} ${noun}: ${items.join('; ')}`)
        }
        break
      }
      case 'needsInbound': {
        const r0 = rule as NeedsInboundRule
        const need = new Map<string, string[]>()
        const satisfied = new Set<string>()
        for (const r of pairs) {
          const s = unitOf(r.srcUnit)
          const d = unitOf(r.dstUnit)
          if (matches(r0.inbound.from, s) && r0.inbound.kinds.includes(r.kind)) satisfied.add(r.dstUnit)
          if (matches(r0.from, s) && matches(r0.to, d, s) && !(r0.exceptTag && r.tags.has(r0.exceptTag))) {
            if (!need.has(r.srcUnit)) need.set(r.srcUnit, [])
            need.get(r.srcUnit)!.push(r.label)
          }
        }
        for (const sid of sorted(need.keys())) {
          if (satisfied.has(sid)) continue
          viol(
            rule, sid, sid, `${rule.id}`,
            `no ${r0.inbound.kinds.join('/')} into it from a unit matching ${describeSelector(r0.inbound.from)}, and references without the tag ${r0.exceptTag ?? '-'}: ` +
              sorted(new Set(need.get(sid)!)).join('; '),
          )
        }
        break
      }
      case 'maxWeightedOut': {
        for (const sid of sorted(classified)) {
          if (!matches(rule.units, unitOf(sid))) continue
          const wo = unitRows[sid]!.weightedOut
          if (wo > rule.max) viol(rule, sid, sid, `${rule.id}.max = ${rule.max}`, `weighted outward coupling ${wo}`)
        }
        break
      }
      case 'maxWeightedLeaving': {
        const r0 = rule as MaxWeightedLeavingRule
        const group = new Set(sorted(classified).filter((s) => matches(r0.group, unitOf(s))))
        let total = 0
        for (const s of group) total += unitRows[s]!.weightedOut
        // What leaves the group. Knowledge between its members has limits of its own.
        let leaving = 0
        for (const r of rels) if (group.has(r.srcUnit) && !group.has(r.dstUnit)) leaving += weights[r.kind]!
        const subject = r0.subject ?? `group ${describeSelector(r0.group)}`
        groupTotals.push({ rule: rule.id, subject, weightedTotal: total, weightedLeaving: leaving, max: r0.max })
        if (leaving > r0.max) viol(rule, subject, subject, `${rule.id}.max = ${r0.max}`, `weighted coupling leaving the group ${leaving}`)
        break
      }
      case 'entitiesPerUnit': {
        for (const sid of sorted(units.keys())) {
          const n = unitOf(sid).entities.length
          if (n < rule.min || n > rule.max) viol(rule, sid, sid, `${rule.id} = ${rule.min}..${rule.max}`, `${n} entities`)
        }
        break
      }
      case 'callCycles': {
        const found = findCycles(callGraph(rule.kind))
        if (found.length > rule.max) {
          for (const cyc of found) {
            viol(rule, [...cyc, cyc[0]!].join(' -> '), cyc[0]!, `${rule.id}.max = ${rule.max}`, `${found.length} cycle(s)`)
          }
        }
        break
      }
    }
  }

  // The cycle list is independent of the rules: a call graph is always worth showing.
  const cycleKind = (cfg.rules.find((r) => r.type === 'callCycles') as { kind: string } | undefined)?.kind
  const cycles = cycleKind ? findCycles(callGraph(cycleKind)) : []

  // -- warnings: reported, never a failure
  const warns: WarningRow[] = []
  for (const w of (cfg.warnings ?? []).filter(enabled)) {
    switch (w.type) {
      case 'singleEntity':
        for (const sid of sorted(units.keys())) {
          const u = unitOf(sid)
          if (u.entities.length === 1) warns.push({ rule: w.id, subject: sid, detail: `owns one entity: ${u.entities[0]}` })
        }
        break
      case 'unreferenced':
        for (const sid of sorted(classified)) {
          if (matches(w.units, unitOf(sid)) && unitRows[sid]!.knownBy.length === 0) {
            warns.push({ rule: w.id, subject: sid, detail: 'no unit knows it' })
          }
        }
        break
      case 'taggedRelationships': {
        const labels = new Set<string>()
        for (const r of pairs) {
          const s = unitOf(r.srcUnit)
          if (matches(w.from, s) && matches(w.to, unitOf(r.dstUnit), s) && (!w.kinds || w.kinds.includes(r.kind)) && r.tags.has(w.tag)) {
            labels.add(r.label)
          }
        }
        for (const l of sorted(labels)) warns.push({ rule: w.id, subject: l, detail: `a relationship tagged ${w.tag}` })
        break
      }
      case 'hub': {
        const known = new Map<string, Set<string>>()
        for (const r of pairs) {
          const s = unitOf(r.srcUnit)
          const d = unitOf(r.dstUnit)
          if (s.attrs[w.peers] != null && s.attrs[w.peers] === d.attrs[w.peers]) {
            if (!known.has(r.srcUnit)) known.set(r.srcUnit, new Set())
            known.get(r.srcUnit)!.add(r.dstUnit)
          }
        }
        for (const sid of sorted(classified)) {
          const u = unitOf(sid)
          if (!matches(w.units, u)) continue
          const others = [...classified].filter((o) => o !== sid && unitOf(o).attrs[w.peers] === u.attrs[w.peers])
          const mine = known.get(sid) ?? new Set<string>()
          if (others.length > 0 && others.every((o) => mine.has(o))) {
            warns.push({ rule: w.id, subject: sid, detail: `knows all ${others.length} other units with ${w.peers} ${u.attrs[w.peers]}` })
          }
        }
        break
      }
    }
  }
  warns.sort((a, b) => cmp(a.rule, b.rule) || cmp(a.subject, b.subject) || cmp(a.detail, b.detail))

  // -- pairs that share more with each other than either has inside
  const shared = new Map<string, number>()
  for (const r of rels) {
    if (r.srcUnit !== r.dstUnit) {
      const key = [r.srcUnit, r.dstUnit].sort(cmp).join('\u0000')
      shared.set(key, (shared.get(key) ?? 0) + 1)
    }
  }
  const merge: MergeCandidate[] = []
  for (const [key, n] of shared) {
    const [a, b] = key.split('\u0000') as [string, string]
    const ia = unitRows[a]!.internal
    const ib = unitRows[b]!.internal
    if (n > ia && n > ib) merge.push({ a, b, shared: n, internalA: ia, internalB: ib })
  }
  merge.sort((x, y) => y.shared - x.shared || cmp(x.a, y.a) || cmp(x.b, y.b))

  // -- externals: what each one knows of others, by kind. A relationship between two entities of one
  // external is internal and is not something the external knows.
  const externalRows: Record<string, ExternalRow> = {}
  for (const cid of sorted(externals.keys())) {
    const ext = externals.get(cid)!
    const knows: Record<string, Set<string>> = Object.fromEntries(order.map((k) => [k, new Set<string>()]))
    const mine = extRels.filter((r) => r.srcUnit === cid)
    const inside = mine.filter((r) => r.dstUnit === cid)
    for (const r of mine) if (r.dstUnit !== cid) knows[r.kind]!.add(r.dst)
    externalRows[cid] = {
      id: cid,
      title: ext.title,
      attributes: ext.attrs,
      entityIds: sorted(ext.entities),
      relationships: mine.length,
      internal: inside.length,
      knows: Object.fromEntries(order.map((k) => [k, sorted(knows[k]!)])),
    }
  }

  violations.sort((a, b) => cmp(a.rule, b.rule) || cmp(a.subject, b.subject) || cmp(a.observed, b.observed))
  errors.sort((a, b) => cmp(a.rule, b.rule) || cmp(a.subject, b.subject) || cmp(a.message, b.message))
  const status = errors.length ? 'model error' : violations.length ? 'budget broken' : 'pass'
  let entityTotal = 0
  for (const u of units.values()) entityTotal += u.entities.length
  return {
    project: model.projectId,
    status,
    exitCode: errors.length ? 2 : violations.length ? 1 : 0,
    filter: { status: statusFilter, modelled, scored: rels.length + extRels.length },
    summary: {
      units: units.size,
      entities: entityTotal,
      externals: externals.size,
      relationships: rels.length,
      externalRelationships: extRels.length,
      violations: violations.length,
      warnings: warns.length,
      modelErrors: errors.length,
    },
    rollups,
    groupTotals,
    units: unitRows,
    externals: externalRows,
    matrix: Object.fromEntries(sorted(Object.keys(matrix)).map((k) => [k, Object.fromEntries(sorted(Object.entries(matrix[k]!), (e) => e[0]))])),
    mergeCandidates: merge,
    cycles,
    violations,
    warnings: warns,
    modelErrors: errors,
    kinds: order,
  }
}

/**
 * Strongly connected components of two or more units in a call graph (Tarjan).
 * `graph` maps a unit to the units it calls. Members sorted, components sorted.
 */
export function findCycles(graph: Map<string, Set<string>>): string[][] {
  const adj = new Map<string, string[]>()
  for (const [s, ds] of graph) adj.set(s, sorted(ds))
  const nodes = sorted(new Set([...adj.keys(), ...[...adj.values()].flat()]))
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  let counter = 0
  const visit = (v: string) => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      if (comp.length > 1) out.push(comp.sort(cmp))
    }
  }
  for (const v of nodes) if (!index.has(v)) visit(v)
  return out.sort((a, b) => cmp(a.join('\u0000'), b.join('\u0000')))
}
