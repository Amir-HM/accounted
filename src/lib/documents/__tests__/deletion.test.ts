import { describe, it, expect } from 'vitest'
import { canDeleteDocument, offersDocumentDelete } from '../deletion'

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

describe('offersDocumentDelete', () => {
  const free = { supplierInvoice: false, expenseClaim: false, inboxItems: [] }
  const unlinked = { journal_entry_id: null, journal_entry_line_id: null }

  it('offers the delete for a document nothing holds', () => {
    expect(offersDocumentDelete(unlinked, free)).toBe(true)
  })

  it('offers it for a document whose inbox item was never booked', () => {
    expect(offersDocumentDelete(unlinked, { ...free, inboxItems: [{ created_journal_entry_id: null, created_supplier_invoice_id: null }] })).toBe(true)
  })

  it('never offers what canDeleteDocument refuses', () => {
    expect(offersDocumentDelete({ journal_entry_id: 'je-1' }, free)).toBe(false)
    expect(offersDocumentDelete({ journal_entry_line_id: 'line-1' }, free)).toBe(false)
  })

  it('does not offer the underlag of a supplier invoice or an utlagg', () => {
    expect(offersDocumentDelete(unlinked, { ...free, supplierInvoice: true })).toBe(false)
    expect(offersDocumentDelete(unlinked, { ...free, expenseClaim: true })).toBe(false)
  })

  it('does not offer a document of a booked inbox item, such as the received Peppol XML', () => {
    expect(offersDocumentDelete(unlinked, { ...free, inboxItems: [{ created_journal_entry_id: 'je-1', created_supplier_invoice_id: null }] })).toBe(false)
    expect(offersDocumentDelete(unlinked, { ...free, inboxItems: [{ created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' }] })).toBe(false)
  })
})
