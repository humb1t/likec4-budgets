# likec4-budgets

Coupling metrics and architecture budgets for [LikeC4](https://likec4.dev) models.

It reads a LikeC4 model, counts what each owner unit (a bounded context, a service, a module) knows of the others, and fails when a budget is broken: too many requests into another tier, a data copy where a plain identifier would do, a cycle of requests, a unit that grew too wide. The model is the source of truth, the budgets live in one JSON file, and nothing about your domain is built into the tool.

- Reads a workspace through the LikeC4 Model API (`LikeC4.fromWorkspace`), or the file `likec4 export json` writes.
- One config, generic over your specification: you name the owner-unit kinds, the metadata that classifies them, the relationship kinds and their weights, and the rules.
- Metrics: Ce, Ca, instability, breadth, depth, weighted coupling, cohesion, sibling coupling, merge candidates.
- Output: a Markdown report, a JSON report, exit code 0 pass, 1 budget broken, 2 model error.
- Pinned to `likec4@1.60.0`.

## Quick start

```sh
npm install --save-dev likec4-budgets      # or: npm install -g likec4-budgets

# a workspace directory
likec4-budgets path/to/model --config likec4-budgets.json --out report.md --json report.json

# or the JSON export
npx likec4 export json -o likec4.json path/to/model
likec4-budgets likec4.json --config likec4-budgets.json
```

`examples/shop` is a complete, passing model with its spec and config:

```sh
likec4-budgets examples/shop --config examples/shop/likec4-budgets.json
```

Requires Node 22.22.3 or newer (a LikeC4 requirement).

### Options

| Option | Meaning |
|---|---|
| `<model>` | A workspace directory, or an export JSON. |
| `-c, --config <file>` | The budgets config. Default `likec4-budgets.json`. |
| `-p, --project <name>` | The project, when the workspace or export holds more than one. |
| `--status <tags>` | Score only relationships carrying one of these status tags (comma list). |
| `-o, --out <file>` | Write the Markdown report to a file. Default stdout. |
| `--json <file>` | Write the JSON report. |
| `-q, --quiet` | No Markdown on stdout. |

A one-line status goes to stderr. Output is deterministic: two runs on one input give the same bytes.

**Exit codes.** `0`: no budget is broken. `1`: a budget is broken. `2`: a model error (the model breaks the declared contract, or does not parse) or a usage error. When both a model error and a violation exist the result is `2`, because figures taken from an invalid model cannot be relied on. Warnings have no effect on the exit code.

## The idea

A LikeC4 model says what knows what. This tool turns that into numbers and lets you cap them.

Draw each relationship from the side that depends to the side that is depended on. Its kind says how tightly the two are tied, and you give each kind a weight, loosest first. For example:

| Kind | Weight | Meaning |
|---|---|---|
| `ids` | 1 | keeps an identifier of the other side's record, nothing else |
| `listens` | 2 | is told about events and does not ask back |
| `invokes` | 4 | sends a request and waits for the reply |
| `replicates` | 6 | holds its own copy of the other side's data |

The kinds are yours: any relationship kinds your `specification` declares will do.

A relationship between two entities counts for the units that own them. A relationship that ends on a unit element counts too, as one known node. A relationship inside one unit is internal. "Foreign" means another unit.

## Config

A config is a JSON file; the schema is [`schema/config.schema.json`](schema/config.schema.json), and `examples/shop/likec4-budgets.json` is a full example. Add `"$schema": "./node_modules/likec4-budgets/schema/config.schema.json"` for editor support. A key the tool does not know is refused (exit 2).

```jsonc
{
  "model": {
    "unitKinds": ["service", "job", "library"],      // the owner unit: coupling is measured per unit
    "entityKinds": ["record"],                       // what a unit owns, nested in it
    "containerKinds": ["tier", "cluster"],           // grouping only: a relationship may not touch one
    "externalKinds": ["client"],                     // outsiders: listed, never budgeted, nothing may know them
    "externalWithin": { "kind": "tier", "metadata": { "tier": "outside" } },
    "dimensions": ["tier", "cluster"],               // metadata that classifies a unit; roll-ups per value
    "metadata": {                                    // per kind, or per role: units, externals, containers, entities
      "units": {
        "tier":    { "values": ["edge", "domain", "base"] },
        "cluster": { "values": ["shopping", "admin", "fulfilment", "payments", "foundation"] },
        "state":   { "values": ["live", "wip", "planned"] },
        "team":    {}                                 // no values: any non-empty string
      },
      "tier": { "tier": { "values": ["edge", "domain", "base", "outside"] } }
    },
    "belongsTo": { "cluster": { "within": "tier", "map": { "shopping": "edge", "payments": "domain", "foundation": "base" } } },
    "placement": { "keys": ["tier", "cluster"], "implied": { "cluster": { "from": "tier", "map": { "base": "foundation" } } } }
  },
  "relationships": {
    "weights": { "ids": 1, "listens": 2, "invokes": 4, "replicates": 6 },
    "statusTags": ["live", "wip", "planned"]         // every relationship carries exactly one; enables --status
  },
  "rules": [ /* see below */ ],
  "warnings": [ /* see below */ ]
}
```

What the `model` part controls:

- **Units, entities, containers, externals.** Elements of any other kind are a model error (`MODEL-ELEMENT-KIND`).
- **`dimensions`** classify a unit (for example a tier and a cluster). Units with every dimension valid are *classified* and scored by the rules; the others are reported as model errors. Metrics are rolled up per value of each dimension.
- **`metadata`** declares which metadata keys each kind carries and which values are allowed. A key is required unless `"optional": true`.
- **`belongsTo`** makes two keys agree: each value of `cluster` belongs to one `tier`.
- **`placement`** makes a unit agree with the containers it sits in. A container may get a key from another of its keys (`implied`).

### Selectors

Rules pick units with a selector: a metadata key to a matcher, all of which must hold.

```jsonc
{ "tier": "domain" }                               // equals
{ "cluster": ["fulfilment", "payments"] }          // any of
{ "cluster": { "not": "admin" } }                  // none of
{ "tier": "domain", "cluster": { "same": true } }  // in `to` only: same value as the source unit
{ "cluster": { "different": true } }               // in `to` only: another value than the source unit
{}                                                 // every unit
```

### Rules

Each rule has an `id`, a `type`, a `description` and optionally `"enabled": false`. A violation names the rule, the relationship or unit, the budget and what was observed. Ids are yours and must be unique.

| `type` | Enforces |
|---|---|
| `allowedKinds` | A relationship from a unit matching `from` to another unit matching `to` uses a kind in `allowed`, or is a named pair in `pairs` (`from` and `to` are unit ids, `kinds` the kinds that pair may use). `allowed: []` forbids the crossing. |
| `fanOut` | Per unit matching `from`: at most `max` distinct `relationships`, target `units` or target `nodes` (entities or units) towards what `to` selects, optionally limited to `kinds`. `max` is a number, or `{ "by": key, "values": {…}, "default": n }` for a limit per value of a metadata key. |
| `needsInbound` | A unit that has an outgoing relationship matching `from`/`to` (not tagged `exceptTag`) must be the target of a relationship of `inbound.kinds` from a unit matching `inbound.from`. Typical use: a unit holding an identifier from another tier must be actively asked for it, not merely handed it. |
| `maxWeightedOut` | Weighted outward coupling of every unit matching `units` is at most `max`. |
| `maxWeightedLeaving` | The weight that leaves the group matching `group` is at most `max` in total, however many units hold it. However finely the group is split into units, the total stays visible. |
| `entitiesPerUnit` | Every unit owns between `min` and `max` entities, so both an empty unit and an overstuffed one fail. |
| `callCycles` | At most `max` cycles in the graph of relationships of one `kind`. A cycle is a strongly connected group of two or more units. Built from the relationships, not from the matrix, so a heavier kind on the same pair cannot hide it. |

### Warnings

Reported in their own section, never failing. Same fields as a rule.

| `type` | Reports |
|---|---|
| `singleEntity` | Units that own one entity. Perhaps too small. |
| `unreferenced` | Units matching `units` that no unit knows. Externals are not units, so an external knowing one does not count. |
| `taggedRelationships` | Each relationship from `from` to `to` (of `kinds`) carrying `tag`, by name. |
| `hub` | Units matching `units` that know every other unit sharing their value of the `peers` key. |

## The numbers

Each unit gets the figures below, and each group of units (every value of a dimension) gets them again. For a group, "foreign" means outside the group, and Internal also counts relationships between its members.

| Number | Meaning |
|---|---|
| Entities | How many entities sit inside the unit. |
| Internal | Relationships whose two ends are both inside the unit. |
| Out, In | Relationships going out and coming in, split by kind in weight order. Out shows what the unit depends on, In shows who depends on it. |
| Ce (efferent) | How many other units it depends on. |
| Ca (afferent) | How many other units depend on it. |
| I (instability) | `Ce / (Ca + Ce)`. 0 means only others lean on it. 1 means it leans on others and nothing leans on it. `-` when it has no relationship across its border. |
| Breadth | How many distinct foreign nodes (entities or units) it depends on: the spread of what it has to know. |
| Depth | The heaviest kind it uses outward, by weight: the tightest tie it has. |
| W-out | Weighted outward coupling: each outgoing relationship adds the weight of its kind. |
| W/ent | W-out divided by the entities the unit owns. A high value on a unit with one entity means a lot of dependencies for very little content. |
| Coh (cohesion) | `2 * Internal / (2 * Internal + Out + In)`, for groups only. 1 means closed, 0 means every relationship crosses the border. |

The report also holds:

- **Knowledge matrix.** One cell per pair, row depends on column, showing the heaviest kind between them. A cell does not say how many relationships stand behind it.
- **Merge candidates.** Pairs of units with more relationships between them (either direction) than either has inside itself. Treat it as a hint, not a ruling. A pair with nothing inside qualifies on a single shared relationship, so the top of the list matters most.
- **Group totals.** For each `maxWeightedLeaving` rule: the group's weighted coupling in total, split into what stays among its units and what leaves the group.
- **Externals.** What each external depends on, by kind. Relationships starting in an external enter no budget and no figure. A relationship between two entities of one external is internal to it.
- **Call cycles.** The groups of units caught in a cycle.

## Model errors

Exit code 2, listed beside the budgets. They are found on all relationships, before any filter. The ids are fixed.

| Id | Meaning |
|---|---|
| `MODEL-EMPTY` | No unit in the model. A parse error can cause this; a passing report of nothing proves nothing. |
| `MODEL-ELEMENT-KIND` | An element kind the config does not declare. |
| `MODEL-META-MISSING`, `MODEL-META-VALUE` | A required metadata key is missing, or its value is outside the allowed values. |
| `MODEL-BELONGS-TO` | Two keys contradict each other (a cluster paired with a tier it is not part of). |
| `MODEL-PLACEMENT` | A unit's metadata disagrees with a container above it, or an external sits outside `externalWithin`. |
| `MODEL-NESTED` | A unit or external inside a unit or external. |
| `MODEL-ENTITY-ORPHAN` | An entity with no unit or external above it. |
| `MODEL-CONTAINER-REL` | A relationship starts or ends on a container. |
| `MODEL-REL-KIND` | A relationship with no kind, or a kind without a weight (a plain `->`). |
| `MODEL-REL-TAG` | A relationship without exactly one status tag. |
| `MODEL-REL-ENDPOINT` | A relationship end that is not an element. |
| `MODEL-EXTERNAL-TARGET` | A relationship that enters an external from outside it. |

With a workspace, a LikeC4 parse error is a model error too (the Model API reports it; the CLI exits 2). A JSON export handed in by path is not validated: `likec4 export json` of some versions exits 0 on a file with parse errors and keeps only what came before the error, so run `likec4 validate` first, or hand the workspace in.

## The status filter

With `relationships.statusTags` set, every relationship must carry exactly one of those tags (for example how far it has come). `--status live` (or `live,wip`) scores only the relationships with those tags, which lets what exists today be read apart from the plan. The report header names the filter and how many relationships passed it. Only relationships are filtered; entity rules still see the whole model. `unreferenced`, `hub` and `needsInbound` look at the surviving relationships alone, so they can fire where the full model stays quiet.

## GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: humb1t/likec4-budgets@v0
  with:
    model: docs/architecture
    config: docs/architecture/likec4-budgets.json
```

The action builds the tool from its own checkout, runs it, writes the Markdown report to the job summary and fails the step on exit code 1 or 2. Inputs: `model`, `config`, `project`, `status`, `report-md`, `report-json`, `node-version`. Outputs: `exit-code`, `status`.

## Library

```ts
import { analyze, loadConfig, loadWorkspace, renderMarkdown } from 'likec4-budgets'

const config = loadConfig('likec4-budgets.json')
const report = analyze(await loadWorkspace('docs/architecture'), config)
console.log(renderMarkdown(report, config), report.exitCode)
```

`loadModel`, `loadExport`, `loadSource` (LikeC4 source text) and `fromLikeC4` (a compiled instance) give a `ModelData`, which is all `analyze` reads.

## Known limits

- The figures describe the drawn model, not the code. A unit drawn wrongly, or a relationship nobody drew, goes unnoticed. Status tags are taken on trust.
- Every relationship of a kind counts the same. A request to a steady interface weighs as much as one to a shifting interface; weights order the kinds and are not measured costs.
- W/ent divides two declared quantities. A unit made of many thin entities looks lighter than it is.
- Merge candidates look at counts only, never at meaning.
- Instability depends on position. I = 1 suits an outer tier and signals trouble for a shared base. Read it together with the tier.
- Breadth counts nodes, entity or unit; a relationship ending on a unit adds one node however much the unit contains.
- A budget is a threshold. A unit exactly at the limit and one far below it both pass, so watching trends and reviewing remain human work.
- Named pairs are not checked against the model: a pair naming a unit that was later renamed allows nothing.

## Development

```sh
npm ci
npm run typecheck
npm test            # Vitest; fixtures compile through the real LikeC4 pipeline
npm run build
npm run smoke       # the CLI on examples/shop
```

`tests/cases.ts` holds a passing model (`examples/shop/model.c4`) and one small patch of it per rule, per warning, per external rule, for the filter and for each model error, each asserted to break exactly that rule. A rule or warning without a case fails a test.

## Licence

MIT, see [LICENSE](LICENSE).
