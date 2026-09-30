/**
 * Proof that the table-without-grant guard flags a new public relation that
 * no migration grants, accepts the grant shapes this repo writes, and is not
 * fooled by example SQL inside comments, string literals or dollar-quoted
 * bodies. Offending fixtures live only in these strings and in an OS temp
 * directory the end-to-end case creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  analyzeMigration,
  findTablesWithoutGrant,
  grantHint,
  sanitizeSql,
} from '../table-without-grant.mjs'

type Finding = ReturnType<typeof analyzeMigration>[number]

const analyze = (sql: string, existing = new Set<string>()): Finding[] =>
  analyzeMigration(sql, 'fixture.sql', existing)

const ROOT = path.resolve(__dirname, '..', '..', '..')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('table-without-grant: the shape Supabase stops granting on 2026-10-30', () => {
  it('flags a public table created with RLS and policies but no GRANT', () => {
    // The common shape of the grandfathered migrations: RLS on, policies
    // written, access left to the platform default that is going away.
    const findings = analyze(`
      CREATE TABLE public.widget_notes (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES public.companies(id)
      );
      ALTER TABLE public.widget_notes ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "view" ON public.widget_notes FOR SELECT USING (company_id IN (SELECT user_company_ids()));
    `)
    expect(findings).toEqual([
      {
        file: 'fixture.sql',
        line: 2,
        kind: 'missing-grant',
        relation: 'widget_notes',
        relationKind: 'table',
        roles: ['service_role', 'authenticated'],
      },
    ])
  })

  it('tells the author the exact lines to add, for the missing roles only', () => {
    const [finding] = analyze(`
      CREATE TABLE widget_notes (id uuid PRIMARY KEY);
      GRANT SELECT ON widget_notes TO authenticated;
    `)
    expect(finding.roles).toEqual(['service_role'])
    expect(grantHint(finding)).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widget_notes TO service_role;',
      'or, if a role must not reach it: -- no-grant: service_role on public.widget_notes (<reason>)',
    ])
  })

  it('flags a table that is dropped and created again: a plain CREATE always starts from the default ACL', () => {
    const findings = analyze('DROP TABLE public.old_thing; CREATE TABLE public.old_thing (id int);', new Set(['old_thing']))
    expect(findings.map((f) => f.relation)).toEqual(['old_thing'])
  })

  it('flags a new view and a new sequence', () => {
    const findings = analyze(`
      CREATE VIEW public.widget_totals AS SELECT 1 AS n;
      CREATE SEQUENCE public.widget_counter;
    `)
    expect(findings.map((f) => [f.relation, f.relationKind])).toEqual([
      ['widget_totals', 'view'],
      ['widget_counter', 'sequence'],
    ])
    expect(grantHint(findings[0])[0]).toBe('GRANT SELECT ON public.widget_totals TO service_role;')
  })
})

describe('table-without-grant: the grant shapes this repo writes', () => {
  it.each([
    ['one statement, both roles', 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.t TO authenticated, service_role;'],
    ['TABLE keyword, one statement per role', 'GRANT SELECT ON TABLE public.t TO authenticated; GRANT ALL ON TABLE public.t TO service_role;'],
    ['a list of tables', 'GRANT SELECT ON public.other, public.t TO authenticated; GRANT ALL ON public.other,public.t TO service_role;'],
    ['a column-level grant', 'GRANT SELECT ON public.t TO authenticated; GRANT UPDATE(outcome, claimed_at) ON public.t TO service_role;'],
    ['quoted names and mixed case', 'grant select on "t" to AUTHENTICATED; Grant All On Public.T To Service_Role With Grant Option;'],
  ])('accepts %s', (_label, grants) => {
    expect(analyze(`CREATE TABLE public.t (id uuid PRIMARY KEY); ${grants}`)).toEqual([])
  })

  it('accepts a reasoned waiver for a role that must not reach the table', () => {
    expect(
      analyze(`
        -- no-grant: authenticated on public.t (service-role only: the cron writes it, nobody reads it)
        CREATE TABLE public.t (id uuid PRIMARY KEY);
        REVOKE ALL ON public.t FROM PUBLIC, anon, authenticated;
        GRANT SELECT, INSERT ON public.t TO service_role;
      `),
    ).toEqual([])
  })

  it('refuses a waiver without a reason', () => {
    const findings = analyze(`
      -- no-grant: authenticated, service_role on public.t ()
      CREATE TABLE public.t (id uuid PRIMARY KEY);
    `)
    expect(findings[0].roles).toEqual(['service_role', 'authenticated'])
  })

  it('does not count a grant to anon or to postgres as a grant to the required roles', () => {
    const findings = analyze('CREATE TABLE public.t (id int); GRANT ALL ON public.t TO anon, postgres;')
    expect(findings[0].roles).toEqual(['service_role', 'authenticated'])
  })
})

describe('table-without-grant: serial keys need their sequence granted', () => {
  it('flags a bigserial column with no grant on its sequence', () => {
    const findings = analyze(`
      CREATE TABLE public.log (seq bigserial PRIMARY KEY, body text);
      GRANT SELECT, INSERT ON public.log TO authenticated, service_role;
    `)
    expect(findings).toEqual([
      { file: 'fixture.sql', line: 2, kind: 'serial-without-grant', relation: 'log', sequence: 'log_seq_seq' },
    ])
  })

  it('accepts the sequence grant, and an identity key that needs none', () => {
    expect(
      analyze(`
        CREATE TABLE public.log (seq bigserial PRIMARY KEY);
        GRANT SELECT, INSERT ON public.log TO authenticated, service_role;
        GRANT USAGE, SELECT ON SEQUENCE public.log_seq_seq TO authenticated, service_role;
        CREATE TABLE public.log2 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
        GRANT SELECT, INSERT ON public.log2 TO authenticated, service_role;
      `),
    ).toEqual([])
  })
})

describe('table-without-grant: bulk grants to the API roles', () => {
  it.each([
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
    'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, service_role;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO service_role;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;',
  ])('flags %s', (sql) => {
    expect(analyze(sql).map((f) => f.kind)).toEqual(['bulk-grant'])
  })

  it('leaves the revoke in 20260929220000 and bulk grants to other roles or schemas alone', () => {
    expect(
      analyze(`
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
        GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO authenticated;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
      `),
    ).toEqual([])
  })
})

describe('table-without-grant: what is not a new public relation', () => {
  it('ignores temp tables and other schemas', () => {
    expect(
      analyze(`
        CREATE TEMP TABLE scratch (id int);
        CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.series (n int);
        CREATE TABLE private.secrets (id int);
        CREATE TABLE storage.extra (id int);
      `),
    ).toEqual([])
  })

  it('ignores IF NOT EXISTS / OR REPLACE on a relation an earlier migration created', () => {
    const existing = new Set(['invoices', 'ai_cost_daily'])
    expect(
      analyze(
        `CREATE TABLE IF NOT EXISTS public.invoices (id uuid);
         CREATE OR REPLACE VIEW public.ai_cost_daily AS SELECT 1 AS n;`,
        existing,
      ),
    ).toEqual([])
    // ... but not when the relation is genuinely new.
    expect(analyze('CREATE TABLE IF NOT EXISTS public.brand_new (id uuid);').map((f) => f.relation)).toEqual([
      'brand_new',
    ])
  })

  it('does not read example SQL inside comments, string literals or dollar-quoted bodies', () => {
    // The seed_agent_atom_bodies migrations carry skill markdown full of
    // example DDL as string literals; function bodies are dollar-quoted.
    expect(
      analyze(`
        -- CREATE TABLE public.in_line_comment (id int);
        /* CREATE TABLE public.in_block /* nested */ comment (id int); */
        INSERT INTO public.agent_atom_registry (body) VALUES ('Example: CREATE TABLE public.in_literal (id bigserial); it''s fine');
        INSERT INTO public.agent_atom_registry (body) VALUES (E'escaped \\' CREATE TABLE public.in_escape (id int);');
        CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$
        BEGIN
          CREATE TABLE public.in_dollar (id int);
        END
        $fn$;
        DO $$ BEGIN PERFORM 1; END $$;
      `),
    ).toEqual([])
  })

  it('does not let a comment marker inside a string swallow the real DDL after it', () => {
    const findings = analyze(`SELECT '-- not a comment';\nCREATE TABLE public.real_one (id int);`)
    expect(findings.map((f) => [f.relation, f.line])).toEqual([['real_one', 2]])
  })

  it('blanks comments and literals without moving line numbers', () => {
    const sql = "SELECT 'a\nb'; -- c\nCREATE TABLE x (id int);"
    const { code, comments } = sanitizeSql(sql)
    expect(code.split('\n')).toHaveLength(sql.split('\n').length)
    expect(code).toContain('CREATE TABLE x')
    expect(code).not.toContain("'a")
    expect(comments).toEqual([' c'])
  })
})

describe('table-without-grant: across the migration history', () => {
  it('tracks relations created by earlier files, in apply order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twg-'))
    tempDirs.push(root)
    const dir = path.join(root, 'supabase', 'migrations')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '20260101000000_a.sql'), 'CREATE TABLE public.a (id int);')
    fs.writeFileSync(path.join(dir, '20260102000000_b.sql'), 'CREATE TABLE IF NOT EXISTS public.a (id int);')
    const findings = findTablesWithoutGrant(root)
    expect(findings.map((f: Finding) => [f.file, f.relation])).toEqual([
      ['supabase/migrations/20260101000000_a.sql', 'a'],
    ])
  })

  it('grandfathers exactly the files that have findings today, and 20260929220000 is not one of them', () => {
    // The baseline is a frozen set: migration files never change, so a stale
    // entry would only ever hide a future file of the same name. Keep it
    // equal to what the scanner finds.
    const baseline = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json'), 'utf8'),
    )
    const files = [...new Set(findTablesWithoutGrant(ROOT).map((f: Finding) => f.file))].sort()
    expect(files).toEqual(baseline.tableWithoutGrant.files)
    expect(baseline.tableWithoutGrant.count).toBe(files.length)
    expect(files).not.toContain('supabase/migrations/20260929220000_own_default_privileges.sql')
    // Every grandfathered file was written against the old default, so it
    // predates the migration that ended it. A later file in the set means
    // someone grandfathered a new table instead of granting it.
    const versions = baseline.tableWithoutGrant.files.map((f: string) => path.basename(f).slice(0, 14))
    expect(versions.filter((v: string) => v >= '20260929220000')).toEqual([])
  })
})
