/**
 * Proof that the uninitialized-event-route guard flags a route that can emit
 * without wiring the bus, and accepts each sanctioned way of wiring it. The
 * fixture tree lives in an OS temp directory created and deleted here.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findUninitializedEmittingRoutes } from '../event-route-init.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const WRAPPER_WITH_INIT = `import { ensureInitialized } from '@/lib/init'
export function withRouteContext(op: string, handler: () => Promise<Response>) {
  return async () => {
    ensureInitialized()
    return handler()
  }
}
`
const WRAPPER_WITHOUT_INIT = `export function withRouteContext(op: string, handler: () => Promise<Response>) {
  return async () => handler()
}
`

function fixture(wrapperSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-route-init-'))
  tempDirs.push(root)
  const files: Record<string, string> = {
    'lib/events/bus.ts': 'export const eventBus = { emit: async (_e: unknown) => {} }\n',
    'lib/core/lock.ts': `import { eventBus } from '@/lib/events/bus'
export async function lockPeriod() {
  await eventBus.emit({ type: 'period.locked', payload: {} })
}
export type Lock = { id: string }
`,
    'lib/core/quiet.ts': 'export function add(a: number, b: number) { return a + b }\n',
    // init pulls in an emitter (as it does through the extensions); it must
    // not make every importer of init look like an emitting route.
    'lib/init.ts': `import '@/lib/core/lock'
export function ensureInitialized() {}
`,
    'lib/api/with-route-context.ts': wrapperSource,
    'lib/api/v1/with-api-v1.ts': `import { ensureInitialized } from '@/lib/init'
ensureInitialized()
export function withApiV1(op: string, handler: () => Promise<Response>) { return handler }
`,
    'app/api/wrapped/route.ts': `import { withRouteContext } from '@/lib/api/with-route-context'
import { lockPeriod } from '@/lib/core/lock'
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>('period.lock', async () => {
  await lockPeriod()
  return new Response()
})
`,
    'app/api/raw/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
    'app/api/module-init/route.ts': `import { ensureInitialized } from '@/lib/init'
import { lockPeriod } from '@/lib/core/lock'
ensureInitialized()
export async function POST() { await lockPeriod(); return new Response() }
`,
    'app/api/v1/route.ts': `import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { lockPeriod } from '@/lib/core/lock'
export const POST = withApiV1('period.lock', async () => { await lockPeriod(); return new Response() })
`,
    'app/api/type-only/route.ts': `import type { Lock } from '@/lib/core/lock'
import { type Lock as L2 } from '@/lib/core/lock'
export async function GET() { const x: Lock | L2 | null = null; return Response.json(x) }
`,
    'app/api/dynamic/route.ts': `export async function POST() {
  const { lockPeriod } = await import('../../../lib/core/lock')
  await lockPeriod()
  return new Response()
}
`,
    'app/api/quiet/route.ts': `import { add } from '@/lib/core/quiet'
import { ensureInitialized } from '@/lib/init'
export async function GET() { return Response.json(add(1, 2)) }
export const warm = ensureInitialized
`,
    'app/api/raw/__tests__/route.ts': `import { lockPeriod } from '@/lib/core/lock'
export async function POST() { await lockPeriod(); return new Response() }
`,
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  return root
}

describe('uninitialized-event-route', () => {
  it('flags only the routes that can emit and never wire the bus', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER_WITH_INIT))

    expect(result.wrapperInitializes).toBe(true)
    expect(result.emittingRoutes).toEqual([
      'app/api/dynamic/route.ts',
      'app/api/module-init/route.ts',
      'app/api/raw/route.ts',
      'app/api/v1/route.ts',
      'app/api/wrapped/route.ts',
    ])
    expect(result.uninitialized).toEqual(['app/api/dynamic/route.ts', 'app/api/raw/route.ts'])
  })

  it('measures the pre-fix exposure when the wrapper is not counted', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER_WITH_INIT), { countWrapper: false })

    expect(result.uninitialized).toEqual([
      'app/api/dynamic/route.ts',
      'app/api/raw/route.ts',
      'app/api/wrapped/route.ts',
    ])
  })

  it('stops trusting withRouteContext the moment the wrapper stops initialising', () => {
    const result = findUninitializedEmittingRoutes(fixture(WRAPPER_WITHOUT_INIT))

    expect(result.wrapperInitializes).toBe(false)
    expect(result.uninitialized).toContain('app/api/wrapped/route.ts')
  })
})
