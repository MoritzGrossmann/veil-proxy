import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { CookieJar } from 'tough-cookie';
import { Agent, request } from 'undici';
import { proxify, rewriteCss, rewriteHtml } from './rewrite.js';
import { assertUrlAllowed, safeLookup } from './ssrf.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const USER = process.env.PROXY_USER;
const PASS = process.env.PROXY_PASS;
const MAX_REWRITE_BYTES = 25 * 1024 * 1024;

const publicDir = new URL('../public/', import.meta.url);
const indexHtml = readFileSync(new URL('index.html', publicDir));
const clientJs = readFileSync(new URL('client.js', publicDir));

const agent = new Agent({ connect: { lookup: safeLookup }, headersTimeout: 30_000, bodyTimeout: 60_000 });

const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] }, trustProxy: true });

// Rohen Request-Body als Stream durchreichen (Formulare, POST/PUT, Uploads).
app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

// ---------- Auth ----------
const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

app.addHook('onRequest', async (req, reply) => {
  if (!USER || !PASS) return;
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const i = decoded.indexOf(':');
    if (i >= 0 && safeEq(decoded.slice(0, i), USER) && safeEq(decoded.slice(i + 1), PASS)) return;
  }
  return reply.code(401).header('www-authenticate', 'Basic realm="proxy"').send('Authentication required');
});

// ---------- Sessions / Cookie-Jars ----------
interface Session {
  jar: CookieJar;
  last: number;
}
const sessions = new Map<string, Session>();

function getSession(req: FastifyRequest, reply: FastifyReply): Session {
  const sid = /(?:^|;\s*)psid=([a-f0-9]{32})/.exec(req.headers.cookie ?? '')?.[1];
  let session = sid ? sessions.get(sid) : undefined;
  if (!session || !sid) {
    const id = randomBytes(16).toString('hex');
    session = { jar: new CookieJar(), last: 0 };
    sessions.set(id, session);
    if (sessions.size > 500) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0];
      sessions.delete(oldest[0]);
    }
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `psid=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }
  session.last = Date.now();
  return session;
}

// ---------- Hilfsfunktionen ----------
const FORWARD_REQ = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'if-range', 'cache-control', 'pragma', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'upgrade-insecure-requests'];
const DROP_RES = new Set([
  'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'report-to', 'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'alt-svc',
  'clear-site-data', 'permissions-policy', 'link', 'content-location', 'location',
]);

function normalizeInput(input: string): string {
  // "https:/x" (zusammengezogene Slashes) reparieren, fehlendes Schema ergänzen
  const s = input.trim().replace(/^(https?):\/(?!\/)/i, '$1://');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

function unproxyUrl(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    const m = /^\/p\/(.+)$/.exec(new URL(header).pathname);
    return m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

function decodeBody(buf: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.toLowerCase()) {
    case 'gzip': return gunzipSync(buf);
    case 'br': return brotliDecompressSync(buf);
    case 'deflate': return inflateSync(buf);
    default: return buf;
  }
}

function toText(buf: Buffer, contentType: string): string {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  cs ??= /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(cs ?? 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function readLimited(body: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      body.destroy();
      throw new Error('response too large to rewrite');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ---------- Routen ----------
app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(indexHtml));
app.get('/__proxy/client.js', async (_req, reply) => reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-cache').send(clientJs));

app.get('/go', async (req, reply) => {
  const input = (req.query as { url?: string }).url;
  if (!input) return reply.redirect('/');
  return reply.redirect('/p/' + encodeURIComponent(normalizeInput(input)));
});

app.all('/p/*', async (req, reply) => {
  let target: URL;
  try {
    target = new URL(normalizeInput(decodeURIComponent(req.raw.url!.slice(3))));
    assertUrlAllowed(target);
  } catch (err) {
    return reply.code(400).type('text/plain; charset=utf-8').send(`Ungültige oder nicht erlaubte URL: ${(err as Error).message}`);
  }

  const session = getSession(req, reply);
  const method = req.method;

  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  for (const name of FORWARD_REQ) {
    const v = req.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }
  const referer = unproxyUrl(req.headers.referer);
  if (referer) headers.referer = referer;
  if (req.headers['sec-fetch-site']) {
    headers['sec-fetch-site'] = !referer ? 'none' : new URL(referer).origin === target.origin ? 'same-origin' : 'cross-site';
  }
  if (req.headers.origin) headers.origin = referer ? new URL(referer).origin : target.origin;
  const cookie = await session.jar.getCookieString(target.href);
  if (cookie) headers.cookie = cookie;

  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const res = await request(target, {
      method: method as 'GET',
      headers,
      body: hasBody ? (req.body as Readable) : undefined,
      dispatcher: agent,
    });

    const setCookies = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) {
      await session.jar.setCookie(c, target.href).catch(() => undefined);
    }

    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v != null && !DROP_RES.has(k)) out[k] = v;
    }
    const location = res.headers.location;
    if (typeof location === 'string') out.location = proxify(location, target.href);

    const ctype = String(res.headers['content-type'] ?? '');
    // Der Browser sagt, wofür er die Ressource lädt; Fonts/Bilder/Skripte nie umschreiben
    // (Google liefert z. B. Schriften mit Content-Type text/html aus).
    const dest = String(req.headers['sec-fetch-dest'] ?? '');
    const neverRewrite = ['font', 'image', 'audio', 'video', 'track', 'script', 'worker', 'object', 'embed'].includes(dest);
    const isHtml = !neverRewrite && /text\/html|application\/xhtml\+xml/i.test(ctype);
    const isCss = !neverRewrite && /text\/css/i.test(ctype);
    const noBody = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;

    if ((isHtml || isCss) && !noBody) {
      const raw = decodeBody(await readLimited(res.body as unknown as Readable, MAX_REWRITE_BYTES), String(res.headers['content-encoding'] ?? ''));
      if (raw.subarray(0, 1024).includes(0)) {
        // Binärdaten mit falschem Content-Type: unverändert durchreichen
        delete out['content-encoding'];
        out['content-length'] = String(raw.length);
        return reply.code(res.statusCode).headers(out).send(raw);
      }
      const text = toText(raw, ctype);
      const rewritten = isHtml ? rewriteHtml(text, target.href) : rewriteCss(text, target.href);
      delete out['content-encoding'];
      delete out['content-length'];
      delete out.etag;
      out['content-type'] = `${isHtml ? 'text/html' : 'text/css'}; charset=utf-8`;
      return reply.code(res.statusCode).headers(out).send(rewritten);
    }

    if (noBody) {
      await res.body.dump();
      return reply.code(res.statusCode).headers(out).send();
    }
    return reply.code(res.statusCode).headers(out).send(res.body);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    const msg = `${e.message} ${e.cause?.message ?? ''}`;
    req.log.warn({ target: target.href, err: msg }, 'upstream error');
    if (msg.includes('blocked')) return reply.code(403).type('text/plain; charset=utf-8').send('Zieladresse nicht erlaubt.');
    return reply.code(502).type('text/plain; charset=utf-8').send(`Upstream-Fehler: ${e.cause?.message ?? e.message}`);
  }
});

await app.listen({ port: PORT, host: HOST });
