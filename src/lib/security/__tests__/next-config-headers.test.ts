import { describe, expect, it } from 'vitest'
import nextConfig from '../../../../next.config'

describe('next.config.ts response headers', () => {
  it('does not send X-Powered-By', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
