/**
 * The order's currency as an ISO 4217 code, or null when it cannot be known.
 *
 * wc/v3 documents `order.currency` as an ISO code, and WooCommerce core
 * writes one, but plugins can write the order currency themselves and some
 * write the store's currency SYMBOL instead, HTML-encoded the way
 * WooCommerce's own symbol table stores it ("&#107;&#114;" is "kr", the SEK
 * symbol). Stored as-is, such a value reached Intl.NumberFormat as a currency
 * code on the Orders page (RangeError, whole page into the error boundary)
 * and left every row without a SEK amount, so it could never be booked.
 *
 * Rules, in order:
 * 1. Decode HTML entities, trim, uppercase. A code Intl recognises is the
 *    answer ("sek" and "SEK" both give SEK).
 * 2. Otherwise, a value that is one of the STORE currency's own symbols is
 *    the store currency: the plugin wrote the symbol of the currency the
 *    store runs in. The store currency comes from the woocommerce_currency
 *    setting, which WooCommerce keeps as a code.
 * 3. Anything else is refused (null). A multi-currency plugin writing "€"
 *    for a EUR order in a SEK store must never be read as SEK; the caller
 *    skips the order and says why.
 */

let supportedCodes: Set<string> | null = null

/** Whether `code` is an ISO 4217 code this runtime's Intl knows. */
export function isKnownCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false
  if (supportedCodes === null) {
    supportedCodes = new Set(Intl.supportedValuesOf('currency'))
  }
  return supportedCodes.has(code)
}

/** Named entities WooCommerce's currency symbol table uses. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  nbsp: ' ',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  dollar: '$',
}

/** Decode the numeric and named HTML entities a currency value can carry. */
export function decodeCurrencyEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Every way the store currency is commonly written as a symbol, lowercased:
 * Intl's symbol and narrow symbol in Swedish and English ("kr" for SEK).
 */
function symbolsOf(code: string): Set<string> {
  const symbols = new Set<string>()
  for (const locale of ['sv-SE', 'en']) {
    for (const currencyDisplay of ['symbol', 'narrowSymbol'] as const) {
      const part = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay })
        .formatToParts(0)
        .find((p) => p.type === 'currency')
      if (part) symbols.add(part.value.trim().toLowerCase())
    }
  }
  return symbols
}

export function resolveOrderCurrency(
  raw: string | null | undefined,
  storeCurrency: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null
  const decoded = decodeCurrencyEntities(raw).trim()
  if (!decoded) return null
  const upper = decoded.toUpperCase()
  if (isKnownCurrencyCode(upper)) return upper

  const store = typeof storeCurrency === 'string' ? storeCurrency.trim().toUpperCase() : ''
  if (!isKnownCurrencyCode(store)) return null
  return symbolsOf(store).has(decoded.toLowerCase()) ? store : null
}
