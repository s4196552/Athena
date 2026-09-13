/* Session cookie: sign and verify.
 *
 * Web Crypto rather than `jose` or `iron-session`, for one reason that matters:
 * this runs in Edge middleware on every matched request. Web Crypto is
 * available there, needs no polyfill, and adds nothing to the bundle.
 *
 * SIGNED, NOT ENCRYPTED. The payload is a user id, an org id, a workspace id
 * and an expiry -- none of them secret. The signature stops a visitor editing
 * the cookie to become someone else; it does not hide the contents, and this
 * is not a place to put anything that needs hiding.
 */

const COOKIE_NAME = 'athena_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const VERSION = 1;

/* A fresh clone should run with zero configuration, so development falls back
 * to a constant. Production must not: next.config.ts is not the right place to
 * throw for a runtime secret, so the check lives here, at first use. */
const DEV_SECRET = 'athena-dev-secret-not-for-production';

let warned = false;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length > 0) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET is not set. Set it in the Vercel project environment ' +
      'before deploying -- sessions cannot be signed without it.',
    );
  }
  if (!warned) {
    warned = true;
    console.warn('[auth] AUTH_SECRET unset — using the development fallback.');
  }
  return DEV_SECRET;
}

export interface SessionClaims {
  /** user id */
  uid: string;
  /** org id of the active workspace */
  oid: string | null;
  /** active workspace id */
  wid: string | null;
  /** expiry, epoch seconds */
  exp: number;
  v: number;
}

// --- base64url, without Buffer (Edge has no Node globals) ------------------

function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Annotated as Uint8Array<ArrayBuffer>, not bare Uint8Array: the default type
 * parameter is ArrayBufferLike, which includes SharedArrayBuffer, and
 * crypto.subtle refuses that. */
function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// --- sign / verify ---------------------------------------------------------

export async function sign(claims: Omit<SessionClaims, 'exp' | 'v'>): Promise<string> {
  const full: SessionClaims = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    v: VERSION,
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(full)));
  const mac = await crypto.subtle.sign('HMAC', await key(), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

export async function verify(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  // Resolved OUTSIDE the try. A missing AUTH_SECRET must surface as a real
  // error, not be swallowed into "invalid cookie" -- otherwise a production
  // deploy without the secret set rejects every session and presents as an
  // unexplained redirect loop back to /login, with nothing in the logs.
  const signingKey = await key();

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      signingKey,
      fromBase64Url(mac),
      encoder.encode(payload),
    );
  } catch {
    // Malformed base64 in the cookie. That genuinely is an invalid cookie.
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionClaims;
    if (claims.v !== VERSION) return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export const cookieName = COOKIE_NAME;

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}
