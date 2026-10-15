import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Zieladressen werden als Token in der Proxy-URL abgelegt: v1.<base64url(iv | tag | ciphertext)>.
 * Der IV wird deterministisch aus der URL abgeleitet (synthetischer IV), damit dieselbe Zieladresse
 * immer dasselbe Token ergibt (Browser-Cache, Verlauf). Ohne den Schlüssel lässt sich die URL nicht lesen.
 */
const SECRET = process.env.PROXY_SECRET;
if (!SECRET) console.warn('PROXY_SECRET not set: using a random key, proxy URLs become invalid after a restart.');

const master = createHash('sha256').update(SECRET ?? randomBytes(32)).digest();
const encKey = createHmac('sha256', master).update('url-enc').digest();
const ivKey = createHmac('sha256', master).update('url-iv').digest();

export const TOKEN_PREFIX = 'v1.';

export function encryptUrl(url: string): string {
  const plain = Buffer.from(url, 'utf8');
  const iv = createHmac('sha256', ivKey).update(plain).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return TOKEN_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Gibt undefined zurück, wenn das Token ungültig oder manipuliert ist. */
export function decryptUrl(token: string): string | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  try {
    const buf = Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url');
    if (buf.length < 29) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
