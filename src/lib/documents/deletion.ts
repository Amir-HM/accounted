/**
 * Whether a document may be deleted by a person or an agent: one rule for
 * every door (deleteDocument() behind DELETE /api/documents/[id], the v1
 * operation documents.delete, and the Arkiv record view that decides whether
 * to offer the action at all), so the UI never offers what the server refuses.
 *
 * A document tied to a verifikat, at the entry or at one of its lines, is
 * räkenskapsinformation under BFL 7 kap 2 § and is kept for 7 years:
 * correcting one means a new version, never a delete. The DB trigger
 * block_document_deletion() is the backstop for the entry link; a line link
 * is always written together with its entry link (linkToJournalEntry), so
 * checking both here only closes a hole no code path opens today.
 *
 * Pins from other records (a bank transaction, an invoice delivery) are not
 * decided here: their foreign keys refuse the delete in the database and
 * deleteDocument() answers that refusal with its own message.
 */
export function canDeleteDocument(doc: { journal_entry_id?: string | null; journal_entry_line_id?: string | null }): boolean {
  return !doc.journal_entry_id && !doc.journal_entry_line_id
}

/** The records that hold a document without a verifikat link, as the Arkiv record reads them. */
export interface DocumentRecordPins {
  /** A supplier invoice has it as its underlag (supplier_invoices.document_id, ON DELETE SET NULL). */
  supplierInvoice: boolean
  /** An expense claim (utlägg) has it as its underlag (expense_claims.document_id, ON DELETE SET NULL). */
  expenseClaim: boolean
  /** Inbox items that carry it, as their file or as the received Peppol XML (channel_context.peppol_xml_document_id). */
  inboxItems: Array<{ created_journal_entry_id: string | null; created_supplier_invoice_id: string | null }>
}

/**
 * Whether the Arkiv record offers "Ta bort": canDeleteDocument(), and no
 * registered record holds the document. The received Peppol XML of a booked
 * e-invoice, and the underlag of a supplier invoice or an utlägg that has no
 * verifikat link yet (kontantmetoden, unpaid), carry no journal_entry_id, so
 * the server rule lets them go; whether it should is a founder question
 * (crm#230). Until it is answered the one-click delete in Arkiv does not
 * offer them. This narrows only what the UI offers, never the server rule.
 */
export function offersDocumentDelete(
  doc: { journal_entry_id?: string | null; journal_entry_line_id?: string | null },
  pins: DocumentRecordPins,
): boolean {
  if (!canDeleteDocument(doc)) return false
  if (pins.supplierInvoice || pins.expenseClaim) return false
  return !pins.inboxItems.some((i) => i.created_journal_entry_id != null || i.created_supplier_invoice_id != null)
}
