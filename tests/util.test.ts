import { describe, expect, it } from 'vitest'
import { analyze, cmp, describeSelector, findCycles, round } from '../src/analyze.js'
import type { Config, ModelData } from '../src/types.js'

describe('round', () => {
  it('rounds half to even on exact ties, like other languages do', () => {
    expect(round(0.03125, 4)).toBe(0.0312)
    expect(round(0.09375, 4)).toBe(0.0938)
    expect(round(2.675, 2)).toBe(2.67) // the double is below the tie
    expect(round(1 / 3, 4)).toBe(0.3333)
    expect(round(2 / 3, 4)).toBe(0.6667)
    expect(round(13 / 3, 2)).toBe(4.33)
    expect(round(0, 2)).toBe(0)
    expect(round(1, 4)).toBe(1)
  })
})

describe('findCycles', () => {
  const g = (edges: [string, string][]) => {
    const m = new Map<string, Set<string>>()
    for (const [a, b] of edges) m.set(a, (m.get(a) ?? new Set()).add(b))
    return m
  }
  it('finds components of two or more, sorted', () => {
    expect(findCycles(g([['b', 'a'], ['a', 'b'], ['c', 'd'], ['d', 'e'], ['e', 'c'], ['x', 'a']]))).toEqual([['a', 'b'], ['c', 'd', 'e']])
  })
  it('ignores a chain and a self loop', () => {
    expect(findCycles(g([['a', 'b'], ['b', 'c']]))).toEqual([])
    expect(findCycles(g([['a', 'a']]))).toEqual([])
  })
})

describe('describeSelector and cmp', () => {
  it('describes each matcher', () => {
    expect(describeSelector({ a: 'x', b: ['y', 'z'], c: { not: 'w' }, d: { same: true }, e: { different: true } })).toBe(
      'a=x, b in [y, z], c not w, d same as source, e differs from source',
    )
    expect(describeSelector({})).toBe('any unit')
  })
  it('compares by code point', () => {
    expect(['b', 'B', 'a'].sort(cmp)).toEqual(['B', 'a', 'b'])
  })
})

describe('a config that shares nothing with the example', () => {
  // Services in tiers; a tier may only know the tier below; no weights beyond one kind.
  const cfg: Config = {
    model: {
      unitKinds: ['service'],
      entityKinds: ['table'],
      dimensions: ['tier'],
      metadata: { units: { tier: { values: ['api', 'domain', 'data'] } } },
    },
    relationships: { weights: { uses: 1 } },
    rules: [
      {
        id: 'TIER-DOWN', type: 'allowedKinds', description: 'api may use domain only',
        from: { tier: 'api' }, to: { tier: { not: 'domain' } }, allowed: [],
      },
      { id: 'FAN', type: 'fanOut', description: 'at most one domain per api', from: { tier: 'api' }, to: { tier: 'domain' }, count: 'units', max: 1 },
    ],
    warnings: [{ id: 'W-ISLAND', type: 'unreferenced', description: 'data nobody uses', units: { tier: 'data' } }],
  }
  const model = (rels: [string, string][]): ModelData => {
    const el = (id: string, kind: string, tier?: string) => [id, { id, kind, title: id, metadata: tier ? { tier } : {} }] as const
    return {
      projectId: 'p',
      elements: Object.fromEntries([
        el('web', 'service', 'api'), el('web.t', 'table'),
        el('orders', 'service', 'domain'), el('orders.t', 'table'),
        el('billing', 'service', 'domain'), el('billing.t', 'table'),
        el('db', 'service', 'data'), el('db.t', 'table'),
      ]),
      relations: Object.fromEntries(
        rels.map(([a, b], i) => [`r${i}`, { id: `r${i}`, kind: 'uses', tags: [], source: a, target: b }]),
      ),
    }
  }

  it('passes a clean model and warns about an island', () => {
    const r = analyze(model([['web.t', 'orders.t']]), cfg)
    expect([r.status, r.exitCode]).toEqual(['pass', 0])
    expect(r.warnings.map((w) => w.subject)).toEqual(['db'])
    expect(Object.keys(r.rollups)).toEqual(['tier'])
  })

  it('breaks the allowed-kinds rule and the fan-out rule', () => {
    const r = analyze(model([['web.t', 'db.t'], ['web.t', 'orders.t'], ['web.t', 'billing.t']]), cfg)
    expect(r.violations.map((v) => v.rule)).toEqual(['FAN', 'TIER-DOWN'])
    expect(r.exitCode).toBe(1)
    expect(r.warnings).toEqual([])
  })
})
