import crypto from 'crypto'

/**
 * AES-256-GCM for mailbox refresh tokens.
 *
 * A mail grant is the hottest credential this product holds: it reads someone's
 * correspondence, not just their backups. So the key is its own env var by
 * preference (MAIL_TOKEN_ENCRYPTION_KEY, 32 bytes hex) and can be rotated
 * without touching the database password, following the Skatteverket
 * token-store rather than cloud-backup's service-role derivation.
 *
 * The derived fallback exists so local development and self-hosted deployments
 * work before anyone sets the variable; it is the same trust boundary as the
 * database itself, and the purpose string keeps it distinct from every other
 * derivation in the codebase.
 */

const ALGORITHM = 'aes-256-gcm'

function getKey(): Buffer {
  const dedicated = process.env.MAIL_TOKEN_ENCRYPTION_KEY
  if (dedicated && dedicated.trim().length > 0) {
    const buf = Buffer.from(dedicated.trim(), 'hex')
    if (buf.length !== 32) {
      throw new Error('MAIL_TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (openssl rand -hex 32)')
    }
    return buf
  }
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('MAIL_TOKEN_ENCRYPTION_KEY or SUPABASE_SERVICE_ROLE_KEY is required')
  return crypto.createHash('sha256').update('mail-connections:v1:' + secret).digest()
}

export function encryptToken(plaintext: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

export function decryptToken(ciphertext: string): string {
  const key = getKey()
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

/**
 * Short-lived signed state for OAuth CSRF protection. Stateless and
 * self-expiring, so a callback needs no database round-trip to be trusted.
 */
const STATE_TTL_MS = 10 * 60 * 1000

interface StatePayload {
  u: string
  c: string
  e: number
  /** PKCE code verifier. Absent from states minted before PKCE. */
  v?: string
}

export function createOAuthState(userId: string, companyId: string, codeVerifier?: string): string {
  const payload: StatePayload = {
    u: userId,
    c: companyId,
    e: Date.now() + STATE_TTL_MS,
    ...(codeVerifier ? { v: codeVerifier } : {}),
  }
  return encryptToken(JSON.stringify(payload))
}

/**
 * A new consent flow: the signed state, carrying a fresh PKCE verifier
 * (RFC 7636) inside its encryption, and the S256 challenge for the
 * authorization URL. The verifier never leaves the server in the clear: the
 * browser only ever holds the encrypted state, so an intercepted code is
 * worthless without the state it was issued with.
 */
export function createOAuthFlow(userId: string, companyId: string): { state: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  return {
    state: createOAuthState(userId, companyId, codeVerifier),
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
  }
}

export function verifyOAuthState(
  state: string,
): { userId: string; companyId: string; codeVerifier: string | null } | null {
  try {
    const payload = JSON.parse(decryptToken(state)) as StatePayload
    if (Date.now() > payload.e) return null
    return { userId: payload.u, companyId: payload.c, codeVerifier: payload.v ?? null }
  } catch {
    return null
  }
}
