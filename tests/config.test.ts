import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UsageError, loadConfig, validateConfig } from '../src/config.js'
import type { Config } from '../src/types.js'
import { CONFIG_PATH, config, tempDir, writeJson } from './helpers.js'

function mutated(fn: (c: Config) => void): unknown {
  const c = structuredClone(config)
  fn(c)
  return c
}

describe('config', () => {
  it('accepts the example', () => {
    expect(() => validateConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))).not.toThrow()
  })

  it('refuses an unknown key anywhere', () => {
    expect(() => validateConfig(mutated((c) => ((c as unknown as Record<string, unknown>)['extra'] = 1)))).toThrow(UsageError)
    expect(() => validateConfig(mutated((c) => ((c.rules[0] as unknown as Record<string, unknown>)['someNewMax'] = 1)))).toThrow(UsageError)
  })

  it('refuses a missing required key', () => {
    for (const key of ['model', 'relationships', 'rules'] as const) {
      const c = structuredClone(config) as unknown as Record<string, unknown>
      delete c[key]
      expect(() => validateConfig(c), key).toThrow(UsageError)
    }
  })

  it('refuses a rule type it does not know, naming the problem', () => {
    expect(() => validateConfig(mutated((c) => ((c.rules[0] as unknown as Record<string, unknown>)['type'] = 'teleport')))).toThrow(/invalid config/)
  })

  it('refuses malformed values', () => {
    const bad = (fn: (c: Config) => void) => expect(() => validateConfig(mutated(fn))).toThrow(UsageError)
    bad((c) => ((c.relationships.weights as Record<string, unknown>)['invokes'] = '4'))
    bad((c) => ((c.rules.find((r) => r.id === 'DOWN-CALLS') as { max: unknown }).max = '2'))
    bad((c) => ((c.rules.find((r) => r.id === 'DOWN-KIND') as { allowed: unknown }).allowed = ['teleport']))
    bad((c) => ((c.rules.find((r) => r.id === 'CROSS-CLUSTER') as { pairs: unknown }).pairs = [{ from: 'a', to: 'b' }]))
    bad((c) => ((c.warnings![0] as { enabled: unknown }).enabled = 'yes'))
  })

  it('refuses names that do not refer to anything', () => {
    const bad = (fn: (c: Config) => void, re: RegExp) => expect(() => validateConfig(mutated(fn))).toThrow(re)
    bad((c) => ((c.rules.find((r) => r.id === 'DOWN-CALLS') as { from: unknown }).from = { nope: 'x' }), /selector key 'nope'/)
    bad((c) => ((c.rules.find((r) => r.id === 'DOWN-CALLS') as { kinds: unknown }).kinds = ['teleport']), /teleport/)
    bad((c) => (c.rules[1]!.id = c.rules[0]!.id), /duplicate id/)
    bad((c) => (c.model.dimensions = ['team']), /team/)
    bad((c) => (c.model.metadata['nope'] = {}), /neither a role nor a declared kind/)
    bad((c) => ((c.rules.find((r) => r.id === 'DOWN-CALLS') as { from: unknown }).from = { cluster: { same: true } }), /only valid in a 'to' selector/)
    bad((c) => delete c.model.belongsTo!['cluster']!.map['foundation'], /must map to a value/)
    bad((c) => (c.model.unitKinds = ['service', 'record']), /more than one/)
  })

  it('loads from a file and names the file in an error', () => {
    const dir = tempDir()
    const bad = writeJson(dir, 'bad.json', { model: {} })
    expect(() => loadConfig(bad)).toThrow(/bad\.json/)
    expect(() => loadConfig(`${dir}/missing.json`)).toThrow(UsageError)
  })

  it('works without the optional parts (no externals, no status tags, no warnings)', () => {
    const c = {
      model: {
        unitKinds: ['unit'],
        entityKinds: ['entity'],
        dimensions: ['tier'],
        metadata: { units: { tier: { values: ['a', 'b'] } } },
      },
      relationships: { weights: { uses: 1 } },
      rules: [{ id: 'CAP', type: 'maxWeightedOut', description: 'cap', units: {}, max: 5 }],
    }
    expect(() => validateConfig(c)).not.toThrow()
  })
})
