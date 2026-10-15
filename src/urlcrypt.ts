import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Zieladressen werden als Token in der Proxy-URL abgelegt: v2.<base64url(iv | tag | ciphertext)>.
 * Der Schlüssel entsteht aus dem Server-Geheimnis, einem Hash des Browser-Footprints (pfp-Cookie, von
 * public/fp.js berechnet) und dem aktuellen UTC-Tag. Dadurch sind Tokens nur im Browser, der sie erzeugt hat,
 * und nur bis zum Tageswechsel (00:00 UTC) lesbar.
 * Der IV wird deterministisch aus der URL abgeleitet (synthetischer IV), damit dieselbe Zieladresse am selben Tag
 * dasselbe Token ergibt (Browser-Cache, Verlauf).
 */
const SECRET = process.env.PROXY_SECRET;
if (!SECRET) console.warn('PROXY_SECRET not set: using a random key, proxy URLs become invalid after a restart.');

const master = createHash('sha256').update(SECRET ?? randomBytes(32)).digest();

const DAY_MS = 86_400_000;
const MAX_FINGERPRINT_LENGTH = 2048;
const MAX_CACHED_KEYS = 1000;

export const TOKEN_PREFIX = 'v2.';

export interface UrlKey {
  enc: Buffer;
  iv: Buffer;
}

const keyCache = new Map<string, UrlKey>();

/** Leitet den Schlüssel für Footprint und aktuellen Tag ab. Gibt undefined zurück, wenn kein Footprint vorliegt. */
export function deriveKey(fingerprint: string | undefined, now = Date.now()): UrlKey | undefined {
  if (!fingerprint || fingerprint.length > MAX_FINGERPRINT_LENGTH) return undefined;
  const day = Math.floor(now / DAY_MS);
  const fpHash = createHash('sha256').update(fingerprint).digest('hex');
  const cacheKey = `${day}:${fpHash}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    // Schlüssel anderer Tage sind ohnehin wertlos.
    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    const dayKey = createHmac('sha256', master).update(`day:${day}`).digest();
    const base = createHmac('sha256', dayKey).update(`fp:${fpHash}`).digest();
    key = {
      enc: createHmac('sha256', base).update('url-enc').digest(),
      iv: createHmac('sha256', base).update('url-iv').digest(),
    };
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** Liest den Footprint aus dem pfp-Cookie und leitet daraus den Tagesschlüssel ab. */
export function keyFromCookie(cookieHeader: string | undefined): UrlKey | undefined {
  const raw = /(?:^|;\s*)pfp=([^;]+)/.exec(cookieHeader ?? '')?.[1];
  if (!raw) return undefined;
  try {
    return deriveKey(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

export function encryptUrl(url: string, key: UrlKey): string {
  const plain = Buffer.from(url, 'utf8');
  const iv = createHmac('sha256', key.iv).update(plain).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key.enc, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return TOKEN_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Gibt undefined zurück, wenn das Token ungültig, manipuliert, abgelaufen oder für einen anderen Browser ist. */
export function decryptUrl(token: string, key: UrlKey): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  try {
    const buf = Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url');
    if (buf.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key.enc, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
