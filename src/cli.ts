#!/usr/bin/env node
import { realpathSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { analyze } from './analyze.js'
import { UsageError, loadConfig } from './config.js'
import { loadModel } from './model.js'
import { renderMarkdown } from './report.js'

const HELP = `likec4-budgets: coupling metrics and budgets for a LikeC4 model

Usage:
  likec4-budgets <model> --config <file> [options]

  <model>  a LikeC4 workspace directory, or the JSON written by \`likec4 export json\`

Options:
  -c, --config <file>   budgets config (default: likec4-budgets.json)
  -p, --project <name>  project of a multi-project workspace or export
      --status <tags>   score only relationships with one of these status tags (comma list)
  -o, --out <file>      write the Markdown report here (default: stdout)
      --json <file>     write the JSON report here
  -q, --quiet           no Markdown on stdout when --out is not given
  -h, --help            this text

Exit codes: 0 pass, 1 at least one rule fails, 2 the model or the arguments are invalid.
Warnings do not affect the exit code.
`

export interface Io {
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const defaultIo: Io = {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
}

export function parseStatusFilter(text: string | undefined, allowed: string[]): string[] | null {
  if (text === undefined) return null
  const parts = [...new Set(text.split(',').map((p) => p.trim()).filter(Boolean))].sort()
  const bad = parts.filter((p) => !allowed.includes(p))
  if (allowed.length === 0) throw new UsageError('--status needs relationships.statusTags in the config')
  if (parts.length === 0 || bad.length) {
    throw new UsageError(`--status takes a comma list of ${allowed.join(', ')}; got '${text}'`)
  }
  return parts
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        project: { type: 'string', short: 'p' },
        status: { type: 'string' },
        out: { type: 'string', short: 'o' },
        json: { type: 'string' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    if (values.help) {
      io.stdout(HELP)
      return 0
    }
    if (positionals.length !== 1) throw new UsageError('give exactly one model path (a workspace directory or an export JSON)')
    const cfg = loadConfig(values.config ?? 'likec4-budgets.json')
    const statusFilter = parseStatusFilter(values.status, cfg.relationships.statusTags ?? [])
    const model = await loadModel(positionals[0]!, values.project)
    const report = analyze(model, cfg, { statusFilter })
    const md = renderMarkdown(report, cfg)
    if (values.out) writeFileSync(values.out, md, 'utf8')
    else if (!values.quiet) io.stdout(md)
    if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n', 'utf8')
    const s = report.summary
    io.stderr(`likec4-budgets: ${report.status} (${s.violations} violations, ${s.warnings} warnings, ${s.modelErrors} model errors)\n`)
    return report.exitCode
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`likec4-budgets: ${(err as Error).message}\n`)
      return 2
    }
    throw err
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`likec4-budgets: ${(err as Error).stack ?? err}\n`)
      process.exit(2)
    },
  )
}
