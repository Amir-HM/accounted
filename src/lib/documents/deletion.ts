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
