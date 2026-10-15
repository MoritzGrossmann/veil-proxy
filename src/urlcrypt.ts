import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Zieladressen werden als Token in der Proxy-URL abgelegt: v3.<Zeitfenster base36>.<base64url(iv | tag | ciphertext)>.
 * Der Schlüssel entsteht aus dem Server-Geheimnis, einem Hash des Browser-Footprints (pfp-Cookie, von
 * public/fp.js berechnet) und dem Zeitfenster der Erzeugung (15 Minuten). Tokens sind nur im Browser lesbar, der sie
 * erzeugt hat, und nur für ein gleitendes Fenster von 24 Stunden (zwischen 23:45 und 24:00 Stunden ab Erzeugung).
 * Der IV wird deterministisch aus der URL abgeleitet (synthetischer IV), damit dieselbe Zieladresse im selben
 * Zeitfenster dasselbe Token ergibt (Browser-Cache, Verlauf).
 */
const SECRET = process.env.PROXY_SECRET;
if (!SECRET) console.warn('PROXY_SECRET not set: using a random key, proxy URLs become invalid after a restart.');

const master = createHash('sha256').update(SECRET ?? randomBytes(32)).digest();

const BUCKET_MS = 15 * 60_000;
const VALID_BUCKETS = 96; // 24 Stunden
const MAX_FINGERPRINT_LENGTH = 2048;
const MAX_CACHED_KEYS = 2000;

export const TOKEN_PREFIX = 'v3.';

/** Footprint des Browsers, aus dem die Zeitfenster-Schlüssel abgeleitet werden. */
export interface UrlKey {
  fpHash: string;
}

interface BucketKey {
  enc: Buffer;
  iv: Buffer;
}

const keyCache = new Map<string, BucketKey>();

/** Gibt undefined zurück, wenn kein (brauchbarer) Footprint vorliegt. */
export function deriveKey(fingerprint: string | undefined): UrlKey | undefined {
  if (!fingerprint || fingerprint.length > MAX_FINGERPRINT_LENGTH) return undefined;
  return { fpHash: createHash('sha256').update(fingerprint).digest('hex') };
}

function bucketKey(key: UrlKey, bucket: number): BucketKey {
  const cacheKey = `${bucket}:${key.fpHash}`;
  let k = keyCache.get(cacheKey);
  if (!k) {
    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    const bucketSecret = createHmac('sha256', master).update(`bucket:${bucket}`).digest();
    const base = createHmac('sha256', bucketSecret).update(`fp:${key.fpHash}`).digest();
    k = {
      enc: createHmac('sha256', base).update('url-enc').digest(),
      iv: createHmac('sha256', base).update('url-iv').digest(),
    };
    keyCache.set(cacheKey, k);
  }
  return k;
}

/** Liest den Footprint aus dem pfp-Cookie. */
export function keyFromCookie(cookieHeader: string | undefined): UrlKey | undefined {
  const raw = /(?:^|;\s*)pfp=([^;]+)/.exec(cookieHeader ?? '')?.[1];
  if (!raw) return undefined;
  try {
    return deriveKey(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

export function encryptUrl(url: string, key: UrlKey, now = Date.now()): string {
  const bucket = Math.floor(now / BUCKET_MS);
  const k = bucketKey(key, bucket);
  const plain = Buffer.from(url, 'utf8');
  const iv = createHmac('sha256', k.iv).update(plain).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', k.enc, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${TOKEN_PREFIX}${bucket.toString(36)}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

/** Gibt undefined zurück, wenn das Token ungültig, manipuliert, älter als 24 Stunden oder für einen anderen Browser ist. */
export function decryptUrl(token: string, key: UrlKey, now = Date.now()): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  try {
    const [bucketStr, data] = token.slice(TOKEN_PREFIX.length).split('.');
    const bucket = parseInt(bucketStr, 36);
    const current = Math.floor(now / BUCKET_MS);
    if (!data || !Number.isInteger(bucket) || bucket > current || current - bucket >= VALID_BUCKETS) return undefined;
    const buf = Buffer.from(data, 'base64url');
    if (buf.length < 29) return undefined;
    const k = bucketKey(key, bucket);
    const decipher = createDecipheriv('aes-256-gcm', k.enc, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
