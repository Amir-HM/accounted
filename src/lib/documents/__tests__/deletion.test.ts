import { describe, it, expect } from 'vitest'
import { canDeleteDocument } from '../deletion'

describe('canDeleteDocument', () => {
  it('allows a document tied to no verifikat', () => {
    expect(canDeleteDocument({ journal_entry_id: null, journal_entry_line_id: null })).toBe(true)
    expect(canDeleteDocument({})).toBe(true)
  })

  it('refuses a document linked to a verifikat (BFL 7 kap 2 §)', () => {
    expect(canDeleteDocument({ journal_entry_id: 'je-1', journal_entry_line_id: null })).toBe(false)
  })

  it('refuses a document linked to a verifikat line, even without the entry link', () => {
    expect(canDeleteDocument({ journal_entry_id: null, journal_entry_line_id: 'line-1' })).toBe(false)
  })
})
