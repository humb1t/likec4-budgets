/** Shared types: the model the tool reads, the config it is given, the report it writes. */

// ---------------------------------------------------------------- model input

export interface ElementData {
  id: string
  kind: string | null
  title: string
  metadata: Record<string, unknown>
}

export interface RelationData {
  id: string
  /** Relationship kind; null for a plain `->` */
  kind: string | null
  tags: string[]
  /** Fully qualified name of the source element, null when the export has none */
  source: string | null
  target: string | null
}

/** What the analysis reads, whether it came from a workspace or from `likec4 export json`. */
export interface ModelData {
  projectId: string
  elements: Record<string, ElementData>
  relations: Record<string, RelationData>
}

// ---------------------------------------------------------------- config

/** One value test on a metadata key. `same` / `different` compare with the source unit (use in `to`). */
export type ValueMatcher =
  | string
  | string[]
  | { not: string | string[] }
  | { same: true }
  | { different: true }

/** Metadata key -> matcher. All keys must match. `{}` matches every unit. */
export type Selector = Record<string, ValueMatcher>

export interface MetadataDef {
  /** Allowed values. Without it any non-empty string is accepted. */
  values?: string[]
  /** The key may be absent; when present it is checked. */
  optional?: boolean
}

export interface RoleOrKindMetadata {
  [key: string]: MetadataDef
}

export interface BelongsTo {
  /** `key` is a value of the child dimension; `within` names the parent dimension; map child value -> parent value. */
  within: string
  map: Record<string, string>
}

export interface Placement {
  /** Metadata keys a unit must agree on with the containers above it. */
  keys: string[]
  /** A container without `key` gets it from another key by this map. */
  implied?: Record<string, { from: string; map: Record<string, string> }>
}

export interface ModelConfig {
  unitKinds: string[]
  entityKinds: string[]
  containerKinds?: string[]
  externalKinds?: string[]
  externalWithin?: { kind: string; metadata: Record<string, string> }
  dimensions: string[]
  metadata: Record<string, RoleOrKindMetadata>
  belongsTo?: Record<string, BelongsTo>
  placement?: Placement
}

export interface RelationshipsConfig {
  /** Kind -> weight. Weakest to strongest is the order of the weights. */
  weights: Record<string, number>
  /** Status tags: every relationship carries exactly one. Enables `--status`. */
  statusTags?: string[]
}

export type MaxValue = number | { by: string; values: Record<string, number>; default?: number }

interface RuleBase {
  id: string
  description: string
  enabled?: boolean
}

export interface AllowedKindsRule extends RuleBase {
  type: 'allowedKinds'
  from: Selector
  to: Selector
  allowed: string[]
  pairs?: { from: string; to: string; kinds: string[] }[]
}

export interface FanOutRule extends RuleBase {
  type: 'fanOut'
  from: Selector
  to: Selector
  kinds?: string[]
  count: 'relationships' | 'units' | 'nodes'
  max: MaxValue
  noun?: string
}

export interface NeedsInboundRule extends RuleBase {
  type: 'needsInbound'
  from: Selector
  to: Selector
  exceptTag?: string
  inbound: { from: Selector; kinds: string[] }
}

export interface MaxWeightedOutRule extends RuleBase {
  type: 'maxWeightedOut'
  units: Selector
  max: number
}

export interface MaxWeightedLeavingRule extends RuleBase {
  type: 'maxWeightedLeaving'
  group: Selector
  max: number
  subject?: string
}

export interface EntitiesPerUnitRule extends RuleBase {
  type: 'entitiesPerUnit'
  min: number
  max: number
}

export interface CallCyclesRule extends RuleBase {
  type: 'callCycles'
  kind: string
  max: number
}

export type Rule =
  | AllowedKindsRule
  | FanOutRule
  | NeedsInboundRule
  | MaxWeightedOutRule
  | MaxWeightedLeavingRule
  | EntitiesPerUnitRule
  | CallCyclesRule

export interface SingleEntityWarning extends RuleBase {
  type: 'singleEntity'
}
export interface UnreferencedWarning extends RuleBase {
  type: 'unreferenced'
  units: Selector
}
export interface TaggedRelationshipsWarning extends RuleBase {
  type: 'taggedRelationships'
  from: Selector
  to: Selector
  kinds?: string[]
  tag: string
}
export interface HubWarning extends RuleBase {
  type: 'hub'
  units: Selector
  /** Units that share this metadata key are peers. */
  peers: string
}

export type Warning =
  | SingleEntityWarning
  | UnreferencedWarning
  | TaggedRelationshipsWarning
  | HubWarning

export interface Config {
  $schema?: string
  model: ModelConfig
  relationships: RelationshipsConfig
  rules: Rule[]
  warnings?: Warning[]
}

// ---------------------------------------------------------------- report

export interface KindCounts {
  [kind: string]: number
}

export interface Metrics {
  units: number
  entities: number
  internal: number
  out: KindCounts
  in: KindCounts
  /** Efferent coupling: distinct foreign units known */
  ce: number
  /** Afferent coupling: distinct foreign units that know it */
  ca: number
  instability: number | null
  /** Distinct foreign nodes (entity or unit) known */
  breadth: number
  /** Strongest kind used outward, by weight */
  depth: string | null
  weightedOut: number
  weightedPerEntity: number | null
  cohesion: number | null
  knownBy: string[]
  known: string[]
}

export type UnitRow = Omit<Metrics, 'cohesion' | 'units'> & {
  id: string
  title: string
  kind: string
  attributes: Record<string, string | null>
  entityIds: string[]
}

export type GroupRow = Omit<Metrics, 'knownBy' | 'known'> & { parent?: string }

export interface ExternalRow {
  id: string
  title: string
  attributes: Record<string, string | null>
  entityIds: string[]
  relationships: number
  internal: number
  knows: Record<string, string[]>
}

export interface Violation {
  rule: string
  subject: string
  unit: string
  budget: string
  observed: string
  what: string
}

export interface WarningRow {
  rule: string
  subject: string
  detail: string
}

export interface ModelError {
  rule: string
  subject: string
  message: string
}

export interface GroupTotal {
  rule: string
  subject: string
  weightedTotal: number
  weightedLeaving: number
  max: number
}

export interface MergeCandidate {
  a: string
  b: string
  shared: number
  internalA: number
  internalB: number
}

export interface Report {
  project: string
  status: 'pass' | 'budget broken' | 'model error'
  exitCode: 0 | 1 | 2
  filter: { status: string[] | null; modelled: number; scored: number }
  summary: {
    units: number
    entities: number
    externals: number
    relationships: number
    externalRelationships: number
    violations: number
    warnings: number
    modelErrors: number
  }
  rollups: Record<string, Record<string, GroupRow>>
  groupTotals: GroupTotal[]
  units: Record<string, UnitRow>
  externals: Record<string, ExternalRow>
  matrix: Record<string, Record<string, string>>
  mergeCandidates: MergeCandidate[]
  cycles: string[][]
  violations: Violation[]
  warnings: WarningRow[]
  modelErrors: ModelError[]
  /** Relationship kinds, weakest first */
  kinds: string[]
}
