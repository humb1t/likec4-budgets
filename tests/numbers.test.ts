import { beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze.js'
import type { Report } from '../src/types.js'
import { addRelation, clone, config, configWith, md, modelFor, run } from './helpers.js'

describe('hand-counted figures of the passing model (examples/shop/model.c4)', () => {
  let ok: Report
  beforeAll(async () => {
    ok = await run('ok')
  })

  it('has the expected structure', () => {
    const s = ok.summary
    expect([s.units, s.entities, s.externals]).toEqual([11, 23, 3])
    expect([s.relationships, s.externalRelationships]).toEqual([17, 4])
    expect([s.violations, s.warnings, s.modelErrors, ok.exitCode]).toEqual([0, 0, 0, 0])
    const u = ok.units['domains.fulfilment.shipping']!
    expect([u.attributes['tier'], u.attributes['cluster'], u.kind, u.attributes['state'], u.attributes['team']]).toEqual([
      'domain', 'fulfilment', 'service', 'live', 'ops-team',
    ])
    expect(u.entityIds).toEqual(['domains.fulfilment.shipping.parcel', 'domains.fulfilment.shipping.route'])
    const a = ok.units['edge.admin.invoicing']!
    expect([a.attributes['tier'], a.attributes['cluster']]).toEqual(['edge', 'admin'])
  })

  it('counts a unit: Ce, Ca, breadth, depth, weights', () => {
    const m = ok.units['domains.fulfilment.shipping']!
    expect(m.out).toEqual({ ids: 1, listens: 1, invokes: 0, replicates: 1 })
    expect(m.in).toEqual({ ids: 0, listens: 1, invokes: 0, replicates: 0 }) // storefront -> shipping
    expect([m.ce, m.ca]).toEqual([2, 1]) // warehouse, ledger | storefront
    expect(m.breadth).toBe(3) // stock, bin, period
    expect(m.depth).toBe('replicates')
    expect(m.weightedOut).toBe(1 * 1 + 1 * 2 + 1 * 6)
    expect(m.weightedPerEntity).toBe(4.5)
    expect(m.internal).toBe(0)
    expect(m.instability).toBe(0.6667)
  })

  it('orders kinds by weight', () => {
    expect(ok.kinds).toEqual(['ids', 'listens', 'invokes', 'replicates'])
  })

  it('has no per-unit cohesion, but has it for groups', () => {
    for (const row of Object.values(ok.units)) expect(row).not.toHaveProperty('cohesion')
    expect(ok.rollups['tier']!['edge']).toHaveProperty('cohesion')
    const sub = md(ok).split('## Units')[1]!.split('## Budget violations')[0]!
    expect(sub).not.toContain('Coh')
  })

  it('divides by entities owned', async () => {
    expect(ok.units['edge.shopping.checkout']!.weightedPerEntity).toBe(6) // 12 over two records
    expect((await run('entity_count_empty')).units['domains.fulfilment.hollow']!.weightedPerEntity).toBeNull()
  })

  it('totals the shopping cluster and splits it into inside and leaving', async () => {
    const total = ok.groupTotals.find((t) => t.rule === 'COUPLING-TOTAL')!
    expect(total.weightedTotal).toBe(7 + 12) // storefront + checkout
    expect(total.weightedLeaving).toBe(total.weightedTotal) // no shopping unit knows a sibling
    expect(total.weightedLeaving).toBe(ok.rollups['cluster']!['shopping']!.weightedOut)
    const sib = await run('siblings')
    const t2 = sib.groupTotals.find((t) => t.rule === 'COUPLING-TOTAL')!
    expect(t2.weightedTotal).toBeGreaterThan(t2.weightedLeaving)
    expect(t2.weightedLeaving).toBe(sib.rollups['cluster']!['shopping']!.weightedOut)
    const inside = t2.weightedTotal - t2.weightedLeaving
    expect(inside).toBe(2)
    expect(md(sib)).toContain(`Of it, ${inside} is between its units and ${t2.weightedLeaving} leaves the group (budget`)
  })

  it('rolls up per tier and per cluster', () => {
    const tier = ok.rollups['tier']!
    const cluster = ok.rollups['cluster']!
    expect(tier['edge']!.units).toBe(4)
    expect(tier['domain']!.units).toBe(5)
    expect(tier['base']!.units).toBe(2)
    expect(cluster['admin']!.units).toBe(2)
    expect(Object.keys(cluster).sort()).toEqual(['admin', 'foundation', 'fulfilment', 'payments', 'shopping'])
    expect(cluster['fulfilment']!.internal).toBe(2) // parcel -> stock, route -> bin
    expect(tier['base']!.ce).toBe(0)
    expect(cluster['shopping']!.parent).toBe('edge')
  })

  it('keeps the strongest kind per pair in the matrix', () => {
    const mx = ok.matrix
    expect(mx['domains.fulfilment.shipping']!['domains.fulfilment.warehouse']).toBe('replicates') // ids + replicates
    expect(mx['edge.shopping.checkout']!['base.settings']).toBe('invokes')
    expect(mx['domains.fulfilment.shipping']).not.toHaveProperty('domains.fulfilment.shipping')
    expect(mx).not.toHaveProperty('clients.feed') // externals are not in the matrix
  })

  it('counts a relationship that ends on a unit as one known node', async () => {
    const m = (await run('unit_end')).units['edge.shopping.checkout']!
    expect(m.out['ids']).toBe(1)
    expect(m.breadth).toBe(4) // entry, claim, option + the unit warehouse itself
  })

  it('lists merge candidates: strictly more shared than inside', async () => {
    const mc = ok.mergeCandidates
    expect(mc).toHaveLength(15)
    expect(mc.slice(0, 2).map((m) => [m.a, m.b, m.shared])).toEqual([
      ['domains.fulfilment.shipping', 'domains.fulfilment.warehouse', 2],
      ['domains.payments.refunds', 'edge.shopping.checkout', 2],
    ])
    expect(mc[0]!.internalB).toBe(0)
    for (const m of mc) {
      expect(m.shared).toBeGreaterThan(m.internalA)
      expect(m.shared).toBeGreaterThan(m.internalB)
    }
    // Inside beats between: once shipping holds one relationship inside, it shares just 1 with ledger.
    expect(mc.map((m) => `${m.a}|${m.b}`)).toContain('domains.fulfilment.shipping|domains.payments.ledger')
    const model = clone(await modelFor('ok'))
    addRelation(model, 'inside', 'ids', 'domains.fulfilment.shipping.parcel', 'domains.fulfilment.shipping.route', ['live'])
    const after = analyze(model, config).mergeCandidates.map((m) => `${m.a}|${m.b}`)
    expect(after).not.toContain('domains.fulfilment.shipping|domains.payments.ledger')
  })
})

describe('externals', () => {
  it('are listed with what they know', async () => {
    const ok = await run('ok')
    const a = ok.externals['clients.webapp']!
    expect([a.attributes['state'], a.attributes['team'], a.relationships]).toEqual(['live', 'web-team', 2])
    expect(a.entityIds).toEqual(['clients.webapp.token', 'clients.webapp.visit'])
    expect(a.knows['invokes']).toEqual(['edge.shopping.storefront.page'])
    expect(a.knows['ids']).toEqual(['domains.payments.ledger'])
    expect(ok.externals['clients.feed']!.knows['invokes']).toEqual(['domains.fulfilment.warehouse.stock'])
    expect(md(ok)).toContain('## Externals')
    expect(md(ok)).toContain('- invokes: `edge.shopping.storefront.page`')
  })

  it('count in no budget and no figure', async () => {
    const base = await run('ok')
    const big = await run('client_unbudgeted')
    expect(big.summary.externalRelationships).toBe(4 + 11)
    for (const key of ['units', 'rollups', 'matrix', 'groupTotals', 'violations', 'warnings'] as const) {
      expect(big[key], key).toEqual(base[key])
    }
    expect(big.summary.relationships).toBe(base.summary.relationships)
    expect(big.exitCode).toBe(0)
  })

  it('do not make a base unit known', async () => {
    const model = clone(await modelFor('w_foundation_unused'))
    addRelation(model, 'x', 'invokes', 'clients.nightly', 'base.audit.audite0')
    const report = analyze(model, config)
    expect(report.modelErrors).toEqual([])
    expect(report.warnings.map((w) => w.rule)).toEqual(['W-FOUNDATION-UNUSED'])
  })

  it('refuse a relationship that enters one, naming it', async () => {
    const e = (await run('client_target')).modelErrors[0]!
    expect(e.rule).toBe('MODEL-EXTERNAL-TARGET')
    expect(e.message).toContain('clients.webapp')
  })

  it('allow a relationship inside one external', async () => {
    const base = await run('ok')
    const r = await run('client_internal')
    expect([r.modelErrors, r.exitCode]).toEqual([[], 0])
    const a = r.externals['clients.webapp']!
    expect([a.relationships, a.internal]).toEqual([3, 1])
    expect(a.entityIds).toEqual(['clients.webapp.draft', 'clients.webapp.token', 'clients.webapp.visit'])
    // what the external knows outside itself is unchanged: its own record is not listed
    expect(a.knows).toEqual(base.externals['clients.webapp']!.knows)
    expect(base.externals['clients.webapp']!.internal).toBe(0)
    expect(r.summary.externalRelationships).toBe(base.summary.externalRelationships + 1)
    for (const key of ['units', 'rollups', 'matrix', 'violations', 'warnings'] as const) expect(r[key], key).toEqual(base[key])
    expect(md(r)).toContain('3 relationships, 1 of them inside the external.')
  })

  it('are refused as a target from any other external or unit', async () => {
    for (const src of ['clients.feed', 'edge.shopping.storefront.page']) {
      const model = clone(await modelFor('client_internal'))
      addRelation(model, 'x', 'ids', src, 'clients.webapp.draft')
      const r = analyze(model, config)
      expect(r.modelErrors.map((e) => e.rule), src).toEqual(['MODEL-EXTERNAL-TARGET'])
      expect(r.exitCode).toBe(2)
    }
  })
})

describe('the status filter', () => {
  it('counts by tag', async () => {
    const full = await run('ok')
    expect(full.filter).toEqual({ status: null, modelled: 21, scored: 21 })
    const table: [string[], number, number][] = [
      [['live'], 10, 3],
      [['wip'], 3, 0],
      [['planned'], 4, 1],
      [['live', 'wip'], 13, 3],
    ]
    for (const [flt, units, externals] of table) {
      const r = await run('ok', flt)
      expect([r.summary.relationships, r.summary.externalRelationships], flt.join()).toEqual([units, externals])
      expect(r.filter.status).toEqual(flt)
      expect(r.filter.modelled).toBe(21)
    }
  })

  it('reads today apart from the target', async () => {
    expect((await run('filter_planned_only')).exitCode).toBe(1)
    expect((await run('filter_planned_only', ['live'])).exitCode).toBe(0)
    expect((await run('filter_planned_only', ['planned'])).exitCode).toBe(1)
  })

  it('is stated in the header', async () => {
    expect(md(await run('ok', ['live']))).toContain('Filter: `--status live`: only relationships tagged live are scored (13 of 21).')
    expect(md(await run('ok'))).toContain('Filter: none. All 21 relationships are scored.')
  })

  it('does not hide model errors', async () => {
    expect((await run('rel_no_tag', ['live'])).exitCode).toBe(2)
    expect((await run('client_target', ['live'])).exitCode).toBe(2)
  })
})

describe('details of rules and warnings', () => {
  it('names the members of a cycle', async () => {
    expect((await run('call_cycle')).cycles).toEqual([['edge.shopping.checkout', 'edge.shopping.storefront']])
  })

  it('finds a cycle when another kind outweighs invokes', async () => {
    // A replicates on a pair that also has an invoke, with replicates weighed above invokes: the matrix
    // shows replicates for the pair, the cycle must stay.
    const model = clone(await modelFor('call_cycle'))
    addRelation(model, 'extra', 'replicates', 'edge.shopping.checkout.receipt', 'edge.shopping.storefront.coupon')
    const r = analyze(model, config)
    expect(r.matrix['edge.shopping.checkout']!['edge.shopping.storefront']).toBe('replicates')
    expect(r.cycles).toEqual([['edge.shopping.checkout', 'edge.shopping.storefront']])
    expect(r.violations.map((v) => v.rule)).toContain('CALL-CYCLE')
  })

  it('names rule, subject and budget in a violation', async () => {
    const v = (await run('cross_cluster')).violations[0]!
    expect(v.rule).toBe('CROSS-CLUSTER')
    expect(v.subject).toBe('domains.payments.ledger.entry -[ids]-> domains.fulfilment.warehouse.stock')
    expect(v.budget).toContain('CROSS-CLUSTER')
    expect(v.what).toBe(config.rules.find((r) => r.id === 'CROSS-CLUSTER')!.description)
  })

  it('takes the up-breadth limit per cluster', async () => {
    const v = (await run('up_breadth_zero')).violations[0]!
    expect(v.budget).toContain('max.fulfilment')
    expect((await run('up_breadth')).violations[0]!.unit).toBe('domains.payments.refunds')
  })

  it('names the identifiers that need an invoke down', async () => {
    const v = (await run('up_needs_down')).violations[0]!
    expect(v.unit).toBe('domains.payments.refunds')
    expect(v.observed).toContain('domains.payments.refunds.claim -[ids]-> edge.shopping.checkout.purchase')
  })

  it('can switch the need for an invoke down off', async () => {
    const model = await modelFor('up_needs_down')
    expect(analyze(model, configWith({ 'UP-NEEDS-DOWN': { enabled: false } })).violations).toEqual([])
  })

  it('does not take an invoke by a unit outside the group as the invoke down', async () => {
    const model = clone(await modelFor('up_needs_down'))
    addRelation(model, 'x', 'invokes', 'domains.fulfilment.shipping.parcel', 'domains.payments.refunds.claim')
    expect(analyze(model, config).violations.map((v) => v.rule)).toContain('UP-NEEDS-DOWN')
  })

  it('names a tagged invoke', async () => {
    expect((await run('w_lookup_call')).warnings[0]!.subject).toBe('edge.shopping.checkout.purchase -[invokes]-> domains.payments.ledger.entry')
  })

  it('names the hub', async () => {
    const w = (await run('w_hub')).warnings[0]!
    expect([w.rule, w.subject]).toEqual(['W-HUB', 'domains.fulfilment.shipping'])
    expect(w.detail).toBe('knows all 2 other units with cluster fulfilment')
  })

  it('prints Off for a switched-off warning', async () => {
    const cfg = configWith(WARNING_OFF)
    const report = analyze(await modelFor('w_single_entity_off'), cfg)
    expect(md(report, cfg)).toContain('### W-SINGLE-ENTITY: units that own one record\n\nOff in the config.')
  })

  it('never lets a warning change the exit code', async () => {
    for (const name of ['w_single_entity', 'w_foundation_unused', 'w_lookup_call', 'w_hub']) {
      const r = await run(name)
      expect([r.status, r.exitCode], name).toEqual(['pass', 0])
      expect(r.warnings).toHaveLength(1)
    }
  })

  it('names the element and key of missing metadata', async () => {
    const e = (await run('meta_missing')).modelErrors[0]!
    expect([e.rule, e.subject]).toEqual(['MODEL-META-MISSING', 'base.identity'])
    expect(e.message).toContain('state')
  })

  it('is an error, not a pass, for an empty model', () => {
    const r = analyze({ projectId: 'x', elements: {}, relations: {} }, config)
    expect(r.modelErrors.map((e) => e.rule)).toEqual(['MODEL-EMPTY'])
    expect(r.exitCode).toBe(2)
  })

  it('reports an unknown endpoint and kind', async () => {
    const model = clone(await modelFor('ok'))
    model.elements['x.weird'] = { id: 'x.weird', kind: 'widget', title: 'W', metadata: {} }
    model.relations['r1'] = { id: 'r1', kind: 'invokes', tags: [], source: 'nope', target: 'edge.shopping.checkout' }
    expect(new Set(analyze(model, config).modelErrors.map((e) => e.rule))).toEqual(new Set(['MODEL-ELEMENT-KIND', 'MODEL-REL-ENDPOINT']))
  })

  it('lets a model error win over a budget violation', async () => {
    const model = clone(await modelFor('rel_no_kind'))
    expect(analyze(model, config).exitCode).toBe(2)
    addRelation(model, 'x', 'replicates', 'edge.shopping.checkout.purchase', 'base.identity.person')
    const r = analyze(model, config)
    expect(r.violations.length).toBeGreaterThan(0)
    expect(r.modelErrors.length).toBeGreaterThan(0)
    expect(r.exitCode).toBe(2)
  })

  it('is deterministic and ignores the key order of the input', async () => {
    for (const name of ['down_calls', 'ok', 'w_hub']) {
      const r = await run(name)
      expect(md(r)).toBe(md(await run(name)))
      expect(JSON.stringify(r)).toBe(JSON.stringify(await run(name)))
    }
    for (const name of ['down_calls', 'ok']) {
      const model = await modelFor(name)
      const reversed = {
        ...model,
        elements: Object.fromEntries(Object.entries(model.elements).reverse()),
        relations: Object.fromEntries(Object.entries(model.relations).reverse()),
      }
      expect(analyze(reversed, config)).toEqual(await run(name))
    }
  })

  it('bites: each counting budget fires when set to -1', async () => {
    const ids = [
      'DOWN-CALLS', 'COUPLING-FRONT', 'COUPLING-TOTAL', 'CLUSTER-BREADTH', 'COUPLING-DOMAIN',
      'COUPLING-BASE', 'SIDE-COUPLING',
    ]
    const model = await modelFor('ok')
    for (const id of ids) {
      expect(analyze(model, configWith({ [id]: { max: -1 } })).violations.length, id).toBeGreaterThan(0)
    }
    expect(analyze(model, configWith({ 'ENTITY-COUNT': { max: -1 } })).violations.length).toBeGreaterThan(0)
  })
})

const WARNING_OFF = { 'W-SINGLE-ENTITY': { enabled: false } }
