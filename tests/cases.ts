/**
 * Fixture models for the tests.
 *
 * BASE is examples/shop/model.c4 with insertion markers. It obeys examples/shop/spec.c4, breaks no budget of
 * examples/shop/likec4-budgets.json and raises no warning. Each case is BASE plus a patch: lines appended to
 * the model, or text replaced once. A case holds:
 *
 *   rules          the budget rules, or the model-error rules, it must trigger, exactly
 *   warnings       the warnings it must raise, exactly (default: none)
 *   patch          [old, new] text replaced once in BASE
 *   budgets        overrides on rules of the config, by rule id, for rules the real numbers cannot break
 *   status         a status filter to apply
 *   rulesFiltered  rules that remain with a filter applied, by filter
 *
 * Markers in BASE that patches append at: `// MORE-RELS`, and the element markers `// MORE-SHOPPING`,
 * `// MORE-FULFILMENT`, `// MORE-BASE`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export const SPEC = readFileSync(here('../examples/shop/spec.c4'), 'utf8')
export const EXAMPLE_MODEL = readFileSync(here('../examples/shop/model.c4'), 'utf8')

function mark(text: string, anchor: string, marker: string): string {
  if (!text.includes(anchor)) throw new Error(`anchor not found: ${anchor}`)
  return text.replace(anchor, anchor + marker)
}

export const BASE = [
  (t: string) => mark(t, "        record receipt 'Receipt'\n      }\n", '      // MORE-SHOPPING\n'),
  (t: string) => mark(t, "        record carrier 'Carrier'\n      }\n", '      // MORE-FULFILMENT\n'),
  (t: string) => mark(t, "      record option 'Option'\n    }\n", '    // MORE-BASE\n'),
  (t: string) => t.replace(/\}\n$/, '  // MORE-RELS\n}\n'),
].reduce((t, f) => f(t), EXAMPLE_MODEL)

const P = '  // MORE-RELS'

export type Patch = [string, string]

export function more(...lines: string[]): Patch[] {
  return [[P, lines.map((l) => '  ' + l).join('\n') + '\n' + P]]
}

/** A unit with `ents` records named <id>e0.. */
export function unit(kind: string, id: string, tier: string, cluster: string, ents: number, indent = 6, state = 'planned'): string {
  const pad = ' '.repeat(indent)
  const body = Array.from({ length: ents }, (_, i) => `${pad}  record ${id}e${i} 'E${i}'\n`).join('')
  return `${pad}${kind} ${id} '${id}' {\n${pad}  metadata { tier '${tier}'  cluster '${cluster}'  state '${state}'  team 'tbd' }\n${body}${pad}}`
}

export interface Case {
  rules: string[]
  warnings?: string[]
  patch?: Patch[]
  /** Rule id -> properties merged into that rule or warning of the config. */
  budgets?: Record<string, Record<string, unknown>>
  status?: string[]
  rulesFiltered?: Record<string, string[]>
}

/** The model text of a case: BASE with its patches applied and the markers removed. */
export function modelOf(c: Case): string {
  let text = BASE
  for (const [oldText, newText] of c.patch ?? []) {
    if (!text.includes(oldText)) throw new Error(`patch target not found: ${oldText}`)
    text = text.replace(oldText, newText)
  }
  for (const marker of ['      // MORE-FULFILMENT\n', '      // MORE-SHOPPING\n', '    // MORE-BASE\n', '  // MORE-RELS\n']) {
    text = text.replace(marker, '')
  }
  return text
}

const CLAIM = `-[invokes]-> domains.payments.refunds.claim 'asks to open a claim' #planned`
const REFUND_ID = `domains.payments.refunds.claim -[ids]-> edge.shopping.checkout.purchase #planned`
const PAIR = { from: 'domains.fulfilment.shipping', to: 'domains.payments.ledger', kinds: ['listens'] }

export const CASES: Record<string, Case> = {
  ok: {
    rules: [],
  },
  // a relationship may end on a unit itself
  unit_end: {
    rules: [],
    patch: [...more(`edge.shopping.checkout -[ids]-> domains.fulfilment.warehouse #planned`)],
  },
  // a copy held by the shopping cluster of a domain record
  down_kind: {
    rules: ['DOWN-KIND'],
    patch: [...more(`edge.shopping.storefront.page -[replicates]-> domains.fulfilment.warehouse.bin #planned`)],
  },
  // three invokes into the domain tier, one over the limit of two; the weight, 7 + 8, stays under COUPLING-FRONT
  down_calls: {
    rules: ['DOWN-CALLS'],
    patch: [
      ...more(
        `edge.shopping.storefront.cart -[invokes]-> domains.fulfilment.labels.label #planned`,
        `edge.shopping.storefront.cart -[invokes]-> domains.payments.ledger.entry #planned`,
      ),
    ],
  },
  // a lookup is still counted, and warned about
  down_calls_lookup_counted: {
    rules: ['DOWN-CALLS'],
    warnings: ['W-LOOKUP-CALL'],
    patch: [
      [`'asks for availability' #live`, `'asks for availability' #live #lookup`],
      ...more(
        `edge.shopping.storefront.cart -[invokes]-> domains.fulfilment.labels.label #planned`,
        `edge.shopping.storefront.cart -[invokes]-> domains.payments.ledger.entry #planned`,
      ),
    ],
  },
  down_foundation_kind: {
    rules: ['DOWN-FOUNDATION-KIND'],
    patch: [...more(`edge.shopping.storefront.cart -[listens]-> base.settings.flag #planned`)],
  },
  // storefront knows checkout and one more: two, the limit is one
  siblings: {
    rules: ['SIBLINGS'],
    patch: [
      [`      // MORE-SHOPPING`, unit('service', 'extra1', 'edge', 'shopping', 2, 6)],
      ...more(
        `edge.shopping.storefront.page -[ids]-> edge.shopping.checkout.receipt #planned`,
        `edge.shopping.storefront.page -[ids]-> edge.shopping.extra1.extra1e0 #planned`,
      ),
    ],
  },
  // four invokes into the base on top of 7: 23 over 21
  coupling_front: {
    rules: ['COUPLING-FRONT'],
    patch: [
      ...more(
        `edge.shopping.storefront.page -[invokes]-> base.identity.person #planned`,
        `edge.shopping.storefront.page -[invokes]-> base.identity.credential #planned`,
        `edge.shopping.storefront.cart -[invokes]-> base.identity.person #planned`,
        `edge.shopping.storefront.cart -[invokes]-> base.identity.credential #planned`,
      ),
    ],
  },
  // the total is 7 + 12 = 19 in BASE
  coupling_total: {
    rules: ['COUPLING-TOTAL'],
    budgets: { 'COUPLING-TOTAL': { max: 18 } },
  },
  call_cycle: {
    rules: ['CALL-CYCLE'],
    patch: [
      ...more(
        `edge.shopping.checkout.receipt -[invokes]-> edge.shopping.storefront.coupon #planned`,
        `edge.shopping.storefront.page -[invokes]-> edge.shopping.checkout.purchase #planned`,
      ),
    ],
  },
  up_kind: {
    rules: ['UP-KIND'],
    patch: [...more(`domains.payments.refunds.claim -[replicates]-> edge.shopping.checkout.purchase #planned`)],
  },
  // two edge records, payments may know one
  up_breadth: {
    rules: ['UP-BREADTH'],
    patch: [...more(`domains.payments.refunds.payout -[ids]-> edge.shopping.checkout.receipt #planned`)],
  },
  // fulfilment may know none
  up_breadth_zero: {
    rules: ['UP-BREADTH'],
    patch: [...more(`domains.fulfilment.warehouse.stock -[ids]-> edge.shopping.checkout.purchase #planned`)],
  },
  // the invoke that came down is an identifier now
  up_needs_down: {
    rules: ['UP-NEEDS-DOWN'],
    patch: [[CLAIM, `-[ids]-> domains.payments.refunds.claim #planned`]],
  },
  // the same, with the identifier marked as handed in from outside
  handed_in_exempt: {
    rules: [],
    patch: [
      [CLAIM, `-[ids]-> domains.payments.refunds.claim #planned`],
      [REFUND_ID, `${REFUND_ID} #handed-in`],
    ],
  },
  cluster_kind: {
    rules: ['CLUSTER-KIND'],
    patch: [...more(`domains.fulfilment.warehouse.stock -[invokes]-> domains.fulfilment.labels.label #planned`)],
  },
  // shipping knows warehouse and two more: three, the limit is two
  cluster_breadth: {
    rules: ['CLUSTER-BREADTH'],
    patch: [
      [
        `      // MORE-FULFILMENT`,
        `${unit('service', 'extra1', 'domain', 'fulfilment', 2, 6)}
${unit('service', 'extra2', 'domain', 'fulfilment', 2, 6)}`,
      ],
      ...more(
        `domains.fulfilment.shipping.parcel -[ids]-> domains.fulfilment.extra1.extra1e0 #planned`,
        `domains.fulfilment.shipping.parcel -[ids]-> domains.fulfilment.extra2.extra2e0 #planned`,
      ),
    ],
  },
  cross_cluster: {
    rules: ['CROSS-CLUSTER'],
    patch: [...more(`domains.payments.ledger.entry -[ids]-> domains.fulfilment.warehouse.stock #planned`)],
  },
  // a second named pair passes
  cross_cluster_named_pair: {
    rules: [],
    patch: [...more(`domains.payments.ledger.entry -[ids]-> domains.fulfilment.warehouse.stock #planned`)],
    budgets: {
      'CROSS-CLUSTER': { pairs: [PAIR, { from: 'domains.payments.ledger', to: 'domains.fulfilment.warehouse', kinds: ['ids'] }] },
    },
  },
  // the pair names listens only; an identifier on it breaks the rule
  cross_cluster_pair_kind: {
    rules: ['CROSS-CLUSTER'],
    patch: [...more(`domains.fulfilment.shipping.parcel -[ids]-> domains.payments.ledger.entry #planned`)],
  },
  domain_foundation_kind: {
    rules: ['DOMAIN-FOUNDATION-KIND'],
    patch: [...more(`domains.fulfilment.labels.label -[invokes]-> base.settings.option #planned`)],
  },
  // 9 + two listens into the base = 13 over 12
  coupling_domain: {
    rules: ['COUPLING-DOMAIN'],
    patch: [
      ...more(
        `domains.fulfilment.shipping.parcel -[listens]-> base.identity.person #planned`,
        `domains.fulfilment.shipping.route -[listens]-> base.identity.credential #planned`,
      ),
    ],
  },
  foundation_isolated: {
    rules: ['FOUNDATION-ISOLATED'],
    patch: [...more(`base.identity.person -[ids]-> domains.payments.ledger.entry #planned`)],
  },
  // settings knows identity: 1 + 4 + 2 = 7 over 5
  coupling_base: {
    rules: ['COUPLING-BASE'],
    patch: [
      ...more(
        `base.settings.flag -[invokes]-> base.identity.person #planned`,
        `base.settings.flag -[listens]-> base.identity.credential #planned`,
      ),
    ],
  },
  side_foundation_kind: {
    rules: ['SIDE-FOUNDATION-KIND'],
    patch: [...more(`edge.admin.invoicing.tariff -[replicates]-> base.identity.person #planned`)],
  },
  side_other_kind: {
    rules: ['SIDE-OTHER-KIND'],
    patch: [...more(`edge.admin.invoicing.invoice -[ids]-> domains.fulfilment.warehouse.stock #planned`)],
  },
  // 4 + two invokes into the base = 12 over 10
  side_coupling: {
    rules: ['SIDE-COUPLING'],
    patch: [
      ...more(
        `edge.admin.invoicing.invoice -[invokes]-> base.identity.person #planned`,
        `edge.admin.invoicing.tariff -[invokes]-> base.identity.credential #planned`,
      ),
    ],
  },
  entity_count_empty: {
    rules: ['ENTITY-COUNT'],
    patch: [
      [
        `      // MORE-FULFILMENT`,
        `      library hollow 'Hollow' {
        metadata { tier 'domain'  cluster 'fulfilment'  state 'planned'  team 'tbd' }
      }`,
      ],
    ],
  },
  entity_count_fat: {
    rules: ['ENTITY-COUNT'],
    patch: [[`      // MORE-FULFILMENT`, unit('library', 'fat', 'domain', 'fulfilment', 6, 6)]],
  },
  w_single_entity: {
    rules: [],
    warnings: ['W-SINGLE-ENTITY'],
    patch: [[`      // MORE-FULFILMENT`, unit('library', 'solo', 'domain', 'fulfilment', 1, 6)]],
  },
  w_single_entity_off: {
    rules: [],
    patch: [[`      // MORE-FULFILMENT`, unit('library', 'solo', 'domain', 'fulfilment', 1, 6)]],
    budgets: { 'W-SINGLE-ENTITY': { enabled: false } },
  },
  w_foundation_unused: {
    rules: [],
    warnings: ['W-FOUNDATION-UNUSED'],
    patch: [[`    // MORE-BASE`, unit('library', 'audit', 'base', 'foundation', 2, 4)]],
  },
  w_lookup_call: {
    rules: [],
    warnings: ['W-LOOKUP-CALL'],
    patch: [[`'asks to charge' #wip`, `'asks to charge' #wip #lookup`]],
  },
  // shipping knows warehouse and labels: every other unit of fulfilment
  w_hub: {
    rules: [],
    warnings: ['W-HUB'],
    patch: [...more(`domains.fulfilment.shipping.route -[ids]-> domains.fulfilment.labels.label #planned`)],
  },
  // a client that knows and invokes everything breaks no budget
  client_unbudgeted: {
    rules: [],
    patch: [
      ...more(
        `clients.webapp.visit -[invokes]-> edge.shopping.checkout.purchase #planned`,
        `clients.webapp.visit -[invokes]-> edge.shopping.checkout.receipt #planned`,
        `clients.webapp.visit -[invokes]-> edge.shopping.storefront.coupon #planned`,
        `clients.webapp.visit -[invokes]-> edge.admin.staffing.rota #planned`,
        `clients.webapp.visit -[invokes]-> domains.fulfilment.shipping.parcel #planned`,
        `clients.webapp.visit -[invokes]-> domains.fulfilment.warehouse.bin #planned`,
        `clients.webapp.visit -[invokes]-> domains.payments.refunds.claim #planned`,
        `clients.webapp.visit -[invokes]-> base.identity.person #planned`,
        `clients.webapp.visit -[invokes]-> base.settings.flag #planned`,
        `clients.feed -[replicates]-> edge.admin.invoicing.tariff #planned`,
        `clients.nightly -[replicates]-> edge.shopping.storefront.cart #planned`,
      ),
    ],
  },
  // nobody may know a client
  client_target: {
    rules: ['MODEL-EXTERNAL-TARGET'],
    patch: [...more(`edge.shopping.storefront.page -[ids]-> clients.webapp.visit #planned`)],
  },
  // a client knowing a client is the same error
  client_target_by_client: {
    rules: ['MODEL-EXTERNAL-TARGET'],
    patch: [...more(`clients.feed -[ids]-> clients.webapp #planned`)],
  },
  // two records of one client may know each other: nothing outside knows the client
  client_internal: {
    rules: [],
    patch: [
      [
        `      record token 'Token'
`,
        `      record token 'Token'
      record draft 'Draft'
`,
      ],
      ...more(`clients.webapp.draft -[ids]-> clients.webapp.visit 'was written in' #live`),
    ],
  },
  client_placement: {
    rules: ['MODEL-PLACEMENT'],
    patch: [
      [
        `      // MORE-SHOPPING`,
        `      client stray 'Stray' {
        metadata { state 'planned'  team 'tbd' }
      }`,
      ],
    ],
  },
  client_meta_missing: {
    rules: ['MODEL-META-MISSING'],
    patch: [[`metadata { state 'planned'  team 'tbd' }`, `metadata { state 'planned' }`]],
  },
  // checkout invokes the domain tier four times: one wip, three planned
  filter_planned_only: {
    rules: ['DOWN-CALLS'],
    patch: [
      ...more(
        `edge.shopping.checkout.receipt -[invokes]-> domains.fulfilment.labels.label #planned`,
        `edge.shopping.checkout.purchase -[invokes]-> domains.fulfilment.warehouse.bin #planned`,
      ),
    ],
    status: ['live'],
    rulesFiltered: { live: [], 'live,wip': [], planned: ['DOWN-CALLS'] },
  },
  meta_missing: {
    rules: ['MODEL-META-MISSING'],
    patch: [[`state 'live'  team 'platform-team'`, `team 'platform-team'`]],
  },
  meta_value: {
    rules: ['MODEL-META-VALUE'],
    patch: [[`state 'live'  team 'money-team'`, `state 'half'  team 'money-team'`]],
  },
  // admin is an edge cluster; the domain tier does not match
  belongs_to: {
    rules: ['MODEL-BELONGS-TO'],
    patch: [
      [
        `  tier base 'Base' {`,
        `  service loose 'Loose' {
    metadata { tier 'domain'  cluster 'admin'  state 'planned'  team 'tbd' }
    record bit 'Bit'
    record byte 'Byte'
  }
  tier base 'Base' {`,
      ],
    ],
  },
  placement: {
    rules: ['MODEL-PLACEMENT'],
    patch: [[`cluster 'fulfilment'  state 'wip'  team 'ops-team'`, `cluster 'payments'  state 'wip'  team 'ops-team'`]],
  },
  // an admin unit in the shopping cluster
  placement_admin_in_shopping: {
    rules: ['MODEL-PLACEMENT'],
    patch: [[`      // MORE-SHOPPING`, unit('service', 'bills', 'edge', 'admin', 2, 6)]],
  },
  rel_on_container: {
    rules: ['MODEL-CONTAINER-REL'],
    patch: [...more(`edge.shopping.storefront.coupon -[ids]-> domains.fulfilment #planned`)],
  },
  rel_no_kind: {
    rules: ['MODEL-REL-KIND'],
    patch: [...more(`edge.shopping.storefront.coupon -> base.identity.credential #planned`)],
  },
  rel_no_tag: {
    rules: ['MODEL-REL-TAG'],
    patch: [...more(`edge.shopping.storefront.coupon -[ids]-> base.identity.credential`)],
  },
  rel_two_tags: {
    rules: ['MODEL-REL-TAG'],
    patch: [...more(`edge.shopping.storefront.coupon -[ids]-> base.identity.credential #planned #live`)],
  },
  entity_orphan: {
    rules: ['MODEL-ENTITY-ORPHAN'],
    patch: [[`      // MORE-FULFILMENT`, `      record stray 'Stray'`]],
  },
  nested_unit: {
    rules: ['MODEL-NESTED'],
    patch: [
      [
        `        record stock 'Stock'`,
        `        record stock 'Stock'
        library inner 'Inner' {
          metadata { tier 'domain'  cluster 'fulfilment'  state 'planned'  team 'tbd' }
          record bit 'Bit'
        }`,
      ],
    ],
  },
}
