import { describe, expect, it } from 'vitest'
import { BASE, CASES, EXAMPLE_MODEL, modelOf } from './cases.js'
import { config, modelFor, run } from './helpers.js'
import { MODEL_RULES } from '../src/analyze.js'

describe('base model', () => {
  it('is the example model without markers', () => {
    expect(modelOf({ rules: [] })).toBe(EXAMPLE_MODEL)
    expect(BASE).toContain('// MORE-RELS')
  })
})

describe('each case breaks exactly its rules', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(name, async () => {
      const report = await run(name)
      const budgetRules = [...new Set(report.violations.map((v) => v.rule))].sort()
      const modelRules = [...new Set(report.modelErrors.map((e) => e.rule))].sort()
      expect(modelRules.length ? modelRules : budgetRules, JSON.stringify([...report.violations, ...report.modelErrors])).toEqual(
        [...c.rules].sort(),
      )
      if (c.rules[0]?.startsWith('MODEL-')) {
        expect(budgetRules).toEqual([])
        expect(report.exitCode).toBe(2)
      } else {
        expect(modelRules).toEqual([])
        expect(report.exitCode).toBe(c.rules.length ? 1 : 0)
        // Warnings are asserted on models without errors, and never move the exit code.
        expect([...new Set(report.warnings.map((w) => w.rule))].sort()).toEqual([...(c.warnings ?? [])].sort())
      }
      for (const [flt, rules] of Object.entries(c.rulesFiltered ?? {})) {
        const filtered = await run(name, flt.split(','))
        expect([...new Set(filtered.violations.map((v) => v.rule))].sort(), flt).toEqual([...rules].sort())
      }
    })
  }
})

describe('coverage of the config', () => {
  it('every rule has a case that breaks it', () => {
    const covered = new Set(Object.values(CASES).flatMap((c) => c.rules))
    const wanted = new Set([
      ...config.rules.map((r) => r.id),
      ...Object.keys(MODEL_RULES).filter((r) => !['MODEL-ELEMENT-KIND', 'MODEL-REL-ENDPOINT', 'MODEL-EMPTY'].includes(r)),
    ])
    expect([...covered].sort()).toEqual([...wanted].sort())
  })

  it('every warning has a case that raises it', () => {
    const covered = new Set(Object.values(CASES).flatMap((c) => c.warnings ?? []))
    expect([...covered].sort()).toEqual((config.warnings ?? []).map((w) => w.id).sort())
  })

  it('tags survive the LikeC4 pipeline', async () => {
    const ok = await modelFor('ok')
    for (const rel of Object.values(ok.relations)) {
      expect(rel.tags.filter((t) => ['live', 'wip', 'planned'].includes(t)), rel.id).toHaveLength(1)
    }
    const lookup = Object.values((await modelFor('w_lookup_call')).relations).filter((r) => r.tags.includes('lookup'))
    expect(lookup).toHaveLength(1)
    const handedIn = Object.values((await modelFor('handed_in_exempt')).relations).filter((r) => r.tags.includes('handed-in'))
    expect(handedIn).toHaveLength(1)
  })
})
