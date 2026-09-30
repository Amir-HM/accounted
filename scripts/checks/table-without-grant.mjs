#!/usr/bin/env node
/**
 * Guard: a migration that creates a public table, view or sequence without
 * granting it to the Data API roles.
 *
 * Until 2026-09-29 no migration had to: Supabase's platform bootstrap ran
 * `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
 * TABLES TO anon, authenticated, service_role` (and the same on sequences),
 * so every new table was reachable and RLS did the limiting. Supabase withdrew
 * that default for new projects on 2026-05-30 and withdraws it for existing
 * ones on 2026-10-30; migration 20260929220000_own_default_privileges switches
 * it off here now. A
 * new table without an explicit GRANT answers 42501 to every supabase-js
 * client, the service-role one included, and nothing short of a real
 * PostgREST call notices: unit tests mock the client, and a pg-real test only
 * notices when it happens to touch the table as that role.
 *
 * The rule, for every relation a non-grandfathered migration creates in
 * public (CREATE TABLE, CREATE [MATERIALIZED] VIEW, CREATE SEQUENCE):
 *
 *   * service_role and authenticated each get a GRANT on it in the same file,
 *     or an explicit, reasoned waiver in a comment:
 *       -- no-grant: authenticated on public.my_table (service-role only: cron writes it)
 *     anon is never required; grant it only to a table that is meant to be
 *     public.
 *   * a serial column needs a GRANT on its sequence
 *     (`<table>_<column>_seq`); an identity or uuid key needs none.
 *   * `IF NOT EXISTS` / `OR REPLACE` on a relation an earlier migration already
 *     created is a no-op for its ACL and is not checked.
 *
 * And in any non-grandfathered migration, a bulk grant to the API roles fails
 * outright: `GRANT ... ON ALL TABLES|SEQUENCES IN SCHEMA public` re-opens the
 * tables earlier migrations deliberately locked down (REVOKEs on provider
 * tokens, peppol_*, sie_*, ai_usage_events, ...), and `ALTER DEFAULT
 * PRIVILEGES ... GRANT` undoes 20260929220000 for every table after it.
 *
 * Grandfathering is a file set in antipatterns-baseline.json
 * (tableWithoutGrant), not a version cutoff: a branch whose migration was
 * timestamped before 20260929220000 but merges after it would otherwise slip
 * through, and its table would reach production with no grants at all.
 *
 * Comments, string literals and dollar-quoted bodies are blanked before
 * parsing: the seed_agent_atom_bodies migrations carry skill markdown full of
 * example SQL, which must not count as DDL.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Roles every new relation must be granted to, or explicitly waived for. */
export const REQUIRED_ROLES = ['service_role', 'authenticated']
const API_ROLES = new Set(['anon', 'authenticated', 'service_role'])

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`

/**
 * Split SQL into code (comments and literals replaced by spaces, offsets and
 * newlines preserved) and the text of its comments.
 */
export function sanitizeSql(sql) {
  let code = ''
  const comments = []
  let i = 0
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      comments.push(sql.slice(i + 2, stop))
      code += blank(sql.slice(i, stop))
      i = stop
    } else if (ch === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      comments.push(sql.slice(i + 2, j - 2))
      code += blank(sql.slice(i, j))
      i = j
    } else if (ch === "'") {
      // '' is an escaped quote; E'' strings may also escape with a backslash.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      code += blank(sql.slice(i, j + 1))
      i = j + 1
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag && !/\w/.test(sql[i - 1] ?? '')) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const stop = close === -1 ? sql.length : close + tag[0].length
        code += blank(sql.slice(i, stop))
        i = stop
      } else {
        code += ch
        i++
      }
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1)
      const stop = end === -1 ? sql.length : end + 1
      code += sql.slice(i, stop)
      i = stop
    } else {
      code += ch
      i++
    }
  }
  return { code, comments }
}

/** `public.Foo` / `"foo"` / `foo` -> `foo`; null for a relation outside public. */
export function publicName(qualified) {
  const parts = qualified
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase())
  if (parts.length === 2) {
    return unquote(parts[0]) === 'public' ? unquote(parts[1]) : null
  }
  if (parts.length === 1) return unquote(parts[0])
  return null
}

const splitList = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const countNewlines = (text) => {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

const CREATE_TABLE_RE = new RegExp(
  String.raw`^create\s+(?:(?:global|local)\s+)?(temp|temporary|unlogged)?\s*table\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const CREATE_VIEW_RE = new RegExp(
  String.raw`^create\s+(or\s+replace\s+)?(temp|temporary)?\s*(?:recursive\s+)?(?:materialized\s+)?view\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const CREATE_SEQUENCE_RE = new RegExp(
  String.raw`^create\s+(temp|temporary|unlogged)?\s*sequence\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const SERIAL_COLUMN_RE = new RegExp(String.raw`(?:\(|,)\s*(${IDENT})\s+(?:small|big)?serial\b`, 'gi')
const GRANT_RE = /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i
const WAIVER_RE = new RegExp(
  String.raw`no-grant:\s*((?:anon|authenticated|service_role)(?:\s*,\s*(?:anon|authenticated|service_role))*)\s+on\s+(${QUALIFIED})\s*\(([^)]*)\)`,
  'gi',
)
// Object kinds a GRANT can name that are not relations or sequences.
const NON_RELATION_GRANT_RE =
  /^(?:function|procedure|routine|schema|database|domain|foreign|language|large\s+object|parameter|tablespace|type|all\s+(?:functions|procedures|routines)\s+in\s+schema)\b/i

/**
 * Analyse one migration. `existing` is the set of public relations created by
 * earlier migrations; relations this file creates are added to it.
 */
export function analyzeMigration(sql, file, existing = new Set()) {
  const { code, comments } = sanitizeSql(sql)
  const created = [] // { name, kind, line, serialSequences: [] }
  const grants = new Set() // `${name}|${role}`
  const sequenceGrants = new Set() // sequence names granted to any API role
  const waivers = new Set() // `${name}|${role}`
  const findings = []

  for (const comment of comments) {
    for (const m of comment.matchAll(WAIVER_RE)) {
      const name = publicName(m[2])
      if (!name || !m[3].trim()) continue
      for (const role of splitList(m[1].toLowerCase())) waivers.add(`${name}|${role}`)
    }
  }

  let lineAtChunk = 1
  for (const raw of code.split(';')) {
    const line = lineAtChunk + countNewlines(raw.slice(0, raw.length - raw.trimStart().length))
    lineAtChunk += countNewlines(raw)
    const stmt = raw.trim().replace(/\s+/g, ' ')
    if (!stmt) continue

    let m = CREATE_TABLE_RE.exec(stmt)
    if (m) {
      const name = publicName(m[3])
      const temporary = m[1] && /^temp/i.test(m[1])
      if (name && !temporary && !(m[2] && existing.has(name))) {
        const serialSequences = [...stmt.matchAll(SERIAL_COLUMN_RE)].map(
          (s) => `${name}_${publicName(s[1])}_seq`,
        )
        created.push({ name, kind: 'table', line, serialSequences })
      }
      if (name && !temporary) existing.add(name)
      continue
    }

    m = CREATE_VIEW_RE.exec(stmt)
    if (m) {
      const name = publicName(m[4])
      const temporary = Boolean(m[2])
      const noOp = (m[1] || m[3]) && existing.has(name)
      if (name && !temporary && !noOp) created.push({ name, kind: 'view', line, serialSequences: [] })
      if (name && !temporary) existing.add(name)
      continue
    }

    m = CREATE_SEQUENCE_RE.exec(stmt)
    if (m) {
      const name = publicName(m[3])
      const temporary = m[1] && /^temp/i.test(m[1])
      if (name && !temporary && !(m[2] && existing.has(name))) {
        created.push({ name, kind: 'sequence', line, serialSequences: [] })
      }
      if (name && !temporary) existing.add(name)
      continue
    }

    if (/^alter default privileges\b/i.test(stmt) && /\bgrant\b/i.test(stmt)) {
      const roles = /\bto\s+(.+)$/i.exec(stmt)
      if (roles && splitList(roles[1].toLowerCase()).some((r) => API_ROLES.has(r))) {
        findings.push({ file, line, kind: 'bulk-grant', detail: 'ALTER DEFAULT PRIVILEGES ... GRANT' })
      }
      continue
    }

    m = GRANT_RE.exec(stmt)
    if (!m) continue
    const objects = m[2].trim()
    const roles = splitList(m[3].toLowerCase()).map((r) => r.replace(/^group\s+/, ''))
    const apiRoles = roles.filter((r) => API_ROLES.has(r))
    if (!apiRoles.length || NON_RELATION_GRANT_RE.test(objects)) continue

    const bulk = /^all\s+(tables|sequences)\s+in\s+schema\s+(.+)$/i.exec(objects)
    if (bulk) {
      if (splitList(bulk[2]).some((s) => publicName(s) === 'public')) {
        findings.push({ file, line, kind: 'bulk-grant', detail: `GRANT ... ON ALL ${bulk[1].toUpperCase()} IN SCHEMA public` })
      }
      continue
    }

    const sequence = /^sequence\s+(.+)$/i.exec(objects)
    for (const target of splitList(sequence ? sequence[1] : objects.replace(/^table\s+/i, ''))) {
      const name = publicName(target)
      if (!name) continue
      if (sequence) sequenceGrants.add(name)
      for (const role of apiRoles) grants.add(`${name}|${role}`)
    }
  }

  for (const rel of created) {
    if (rel.kind === 'sequence') {
      if (!sequenceGrants.has(rel.name) && !apiGranted(rel.name, grants)) {
        findings.push({ file, line: rel.line, kind: 'missing-grant', relation: rel.name, relationKind: rel.kind, roles: [...REQUIRED_ROLES] })
      }
      continue
    }
    const missing = REQUIRED_ROLES.filter(
      (role) => !grants.has(`${rel.name}|${role}`) && !waivers.has(`${rel.name}|${role}`),
    )
    if (missing.length) {
      findings.push({ file, line: rel.line, kind: 'missing-grant', relation: rel.name, relationKind: rel.kind, roles: missing })
    }
    for (const seq of rel.serialSequences) {
      if (!sequenceGrants.has(seq)) {
        findings.push({ file, line: rel.line, kind: 'serial-without-grant', relation: rel.name, sequence: seq })
      }
    }
  }

  return findings
}

const apiGranted = (name, grants) => [...API_ROLES].some((role) => grants.has(`${name}|${role}`))

/**
 * Every finding across supabase/migrations, in filename (= apply) order. The
 * caller decides which files are grandfathered.
 */
export function findTablesWithoutGrant(root) {
  const dir = path.join(root, 'supabase', 'migrations')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
  const existing = new Set()
  const findings = []
  for (const file of files) {
    const rel = `supabase/migrations/${file}`
    findings.push(...analyzeMigration(fs.readFileSync(path.join(dir, file), 'utf8'), rel, existing))
  }
  return findings
}

/** The exact lines that fix one finding, for the guard's error output. */
export function grantHint(finding) {
  if (finding.kind === 'bulk-grant') {
    return [
      finding.detail.startsWith('ALTER DEFAULT')
        ? 'Re-granting the default undoes 20260929220000 for every table created after it.'
        : 'A bulk grant to an API role re-opens the tables earlier migrations locked down on purpose.',
      'Grant each new relation by name, in the migration that creates it.',
    ]
  }
  if (finding.kind === 'serial-without-grant') {
    return [
      `GRANT USAGE, SELECT ON SEQUENCE public.${finding.sequence} TO service_role, authenticated;`,
      '(or declare the key GENERATED ALWAYS AS IDENTITY / uuid, which needs no sequence grant)',
    ]
  }
  if (finding.relationKind === 'sequence') {
    return [`GRANT USAGE, SELECT ON SEQUENCE public.${finding.relation} TO service_role, authenticated;`]
  }
  const lines = []
  const target = `${finding.relationKind === 'view' ? '' : 'TABLE '}public.${finding.relation}`
  if (finding.roles.includes('service_role')) {
    lines.push(
      finding.relationKind === 'view'
        ? `GRANT SELECT ON ${target} TO service_role;`
        : `GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO service_role;`,
    )
  }
  if (finding.roles.includes('authenticated')) {
    lines.push(
      finding.relationKind === 'view'
        ? `GRANT SELECT ON ${target} TO authenticated;`
        : `GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO authenticated;  -- keep only what its RLS policies allow`,
    )
  }
  lines.push(
    `or, if a role must not reach it: -- no-grant: ${finding.roles.join(', ')} on public.${finding.relation} (<reason>)`,
  )
  return lines
}
