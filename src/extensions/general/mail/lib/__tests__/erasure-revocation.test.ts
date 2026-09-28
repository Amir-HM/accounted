/**
 * Account erasure through the core seam: the grants a person connected are
 * read while their tokens exist and revoked only when the route says the
 * erasure succeeded. The route side is in app/api/account/delete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockListGrants, mockRevokeStored } = vi.hoisted(() => ({
  mockListGrants: vi.fn(),
  mockRevokeStored: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ service: true }) }))
vi.mock('../gmail-client', () => ({
  searchMessageIds: vi.fn(),
  getMessageSummary: vi.fn(),
  fetchAttachmentBytes: vi.fn(),
  clearMessageCache: vi.fn(),
  describeAttachment: vi.fn(),
}))
vi.mock('../connections', () => ({
  getAccessToken: vi.fn(),
  listActiveConnections: vi.fn(),
  touchSearched: vi.fn(),
  listGrantsConnectedBy: (...args: unknown[]) => mockListGrants(...args),
  revokeStoredGrant: (...args: unknown[]) => mockRevokeStored(...args),
}))

import { GmailSearchService } from '../search-service'

const grant = (id: string) => ({
  id,
  provider: 'gmail',
  email_address: `${id}@example.se`,
  encrypted_refresh_token: `enc-${id}`,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockRevokeStored.mockResolvedValue('revoked')
})

describe('GmailSearchService.prepareGrantRevocation', () => {
  it('prepares nothing for a person who connected no mailbox', async () => {
    mockListGrants.mockResolvedValue([])
    await expect(new GmailSearchService().prepareGrantRevocation('user-1')).resolves.toBeNull()
  })

  it('reads the grants up front and revokes nothing until asked', async () => {
    mockListGrants.mockResolvedValue([grant('a'), grant('b')])

    const prepared = await new GmailSearchService().prepareGrantRevocation('user-1')

    expect(mockListGrants).toHaveBeenCalledWith({ service: true }, 'user-1')
    expect(prepared?.count).toBe(2)
    // A refused erasure drops this value: nothing may have happened yet.
    expect(mockRevokeStored).not.toHaveBeenCalled()

    await prepared!.revoke()
    expect(mockRevokeStored).toHaveBeenCalledTimes(2)
    expect(mockRevokeStored).toHaveBeenCalledWith({ service: true }, grant('a'))
    expect(mockRevokeStored).toHaveBeenCalledWith({ service: true }, grant('b'))
  })

  it('never throws out of revoke, even when one grant fails unexpectedly', async () => {
    mockListGrants.mockResolvedValue([grant('a'), grant('b')])
    mockRevokeStored.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('revoked')

    const prepared = await new GmailSearchService().prepareGrantRevocation('user-1')

    await expect(prepared!.revoke()).resolves.toBeUndefined()
    expect(mockRevokeStored).toHaveBeenCalledTimes(2)
  })
})
