import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const USER = process.env.PROXY_USER;
const PASS = process.env.PROXY_PASS;
const TOKEN_TTL_MS = Number(process.env.PROXY_TOKEN_TTL_HOURS ?? 12) * 3600_000;
const REFRESH_TTL_MS = Number(process.env.PROXY_REFRESH_TTL_DAYS ?? 90) * 86_400_000;
const REFRESH_GRACE_MS = 30_000; // parallele Requests mit demselben (gerade rotierten) Refresh-Token
const COOKIE = 'ptoken';
const REFRESH_COOKIE = 'prefresh';
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

export const authEnabled = Boolean(USER && PASS);

const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// Token werden nur als SHA-256-Hash gehalten und gespeichert: eine geleakte Datei enthält keine nutzbaren Token.
const hash = (t: string) => createHash('sha256').update(t).digest('base64url');
const tokens = new Map<string, number>(); // Hash -> Ablaufzeit
const fails = new Map<string, { count: number; first: number }>();

interface TokenPair { token: string; refreshToken: string }
interface RefreshEntry { exp: number; rotated?: TokenPair } // rotated nur im Speicher (Karenzzeit)
const refreshTokens = new Map<string, RefreshEntry>(); // Hash -> Eintrag

const STORE = join(process.env.PROXY_DATA_DIR ?? 'data', 'tokens.json');

function loadStore() {
  try {
    const data = JSON.parse(readFileSync(STORE, 'utf8')) as { tokens?: Record<string, number>; refresh?: Record<string, number> };
    const now = Date.now();
    for (const [h, exp] of Object.entries(data.tokens ?? {})) if (exp > now) tokens.set(h, exp);
    for (const [h, exp] of Object.entries(data.refresh ?? {})) if (exp > now) refreshTokens.set(h, { exp });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('token store unreadable, starting empty:', e);
  }
}

function saveStore() {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    const refresh: Record<string, number> = {};
    // Gerade rotierte Token (Karenzzeit) nicht persistieren.
    for (const [h, r] of refreshTokens) if (!r.rotated) refresh[h] = r.exp;
    const tmp = `${STORE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: Object.fromEntries(tokens), refresh }), { mode: 0o600 });
    renameSync(tmp, STORE);
  } catch (e) {
    console.error('could not persist tokens:', e);
  }
}

if (authEnabled) loadStore();

function issueToken(): string {
  const now = Date.now();
  for (const [h, exp] of tokens) if (exp < now) tokens.delete(h);
  const token = randomBytes(32).toString('base64url');
  tokens.set(hash(token), now + TOKEN_TTL_MS);
  return token;
}

function issuePair(): TokenPair {
  const now = Date.now();
  for (const [h, r] of refreshTokens) if (r.exp < now) refreshTokens.delete(h);
  const refreshToken = randomBytes(32).toString('base64url');
  refreshTokens.set(hash(refreshToken), { exp: now + REFRESH_TTL_MS });
  const pair = { token: issueToken(), refreshToken };
  saveStore();
  return pair;
}

/** Tauscht ein Refresh-Token gegen ein neues Token-Paar (Rotation, das alte Token verfällt nach kurzer Karenzzeit). */
function refresh(old: string | undefined): TokenPair | undefined {
  if (!old) return undefined;
  const h = hash(old);
  const r = refreshTokens.get(h);
  if (!r) return undefined;
  const now = Date.now();
  if (r.exp < now) {
    refreshTokens.delete(h);
    return undefined;
  }
  if (r.rotated) return r.rotated;
  r.exp = Math.min(r.exp, now + REFRESH_GRACE_MS);
  r.rotated = issuePair();
  saveStore(); // altes Token ist jetzt "rotated" und wird nicht mehr persistiert
  return r.rotated;
}

/** Widerruft Access- und Refresh-Token (Logout). */
function revoke(token: string | undefined, refreshToken: string | undefined) {
  if (token) tokens.delete(hash(token));
  if (refreshToken) refreshTokens.delete(hash(refreshToken));
  saveStore();
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const h = hash(token);
  const exp = tokens.get(h);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(h);
    return false;
  }
  return true;
}

const cookieValue = (req: { headers: IncomingHttpHeaders }, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`).exec(req.headers.cookie ?? '')?.[1];

function extractToken(req: { headers: IncomingHttpHeaders }): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (m) return m[1];
  return cookieValue(req, COOKIE);
}

function setAuthCookies(req: FastifyRequest, reply: FastifyReply, pair: TokenPair) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  const attrs = (ttl: number) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${secure}`;
  reply.header('set-cookie', `${COOKIE}=${pair.token}; ${attrs(TOKEN_TTL_MS)}`);
  reply.header('set-cookie', `${REFRESH_COOKIE}=${pair.refreshToken}; ${attrs(REFRESH_TTL_MS)}`);
}

const pairBody = (pair: TokenPair) => ({
  token: pair.token,
  token_type: 'Bearer',
  expires_in: Math.floor(TOKEN_TTL_MS / 1000),
  refresh_token: pair.refreshToken,
  refresh_expires_in: Math.floor(REFRESH_TTL_MS / 1000),
});

/** Für Requests, die nicht durch Fastify laufen (WebSocket-Upgrades). */
export function isAuthorized(req: { headers: IncomingHttpHeaders }): boolean {
  return !authEnabled || validToken(extractToken(req));
}

function rateLimited(ip: string): boolean {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}

function recordFail(ip: string) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

async function readCredentials(req: FastifyRequest): Promise<{ username: string; password: string; next: string }> {
  let data: Record<string, unknown> = {};
  const body = req.body as unknown;
  if (body && typeof (body as Readable).on === 'function') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 16 * 1024) throw new Error('body too large');
      chunks.push(chunk);
    }
    data = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  } else if (body && typeof body === 'object') {
    data = body as Record<string, unknown>;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { username: str(data.username), password: str(data.password), next: str(data.next) };
}

/** Nur lokale Pfade zulassen (kein Open Redirect). */
function safeNext(next: string): string {
  return /^\/(?![/\\])/.test(next) ? next : '/';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Veil – Sign in</title>
  <meta name="theme-color" content="#0B0A12">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/icon-32.png">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='.1' y1='0' x2='.9' y2='1'%3E%3Cstop offset='0' stop-color='%23C4B5FD'/%3E%3Cstop offset='1' stop-color='%236D28D9'/%3E%3C/linearGradient%3E%3CclipPath id='v'%3E%3Cpath d='M10 14H34L48 52 62 14H86L58 84H38Z'/%3E%3C/clipPath%3E%3C/defs%3E%3Cpath d='M10 14H34L48 52 62 14H86L58 84H38Z' fill='url(%23g)'/%3E%3Cg clip-path='url(%23v)'%3E%3Cpath d='M0 46C26 36 50 64 96 50V72C54 86 28 58 0 68Z' fill='%230B0A12' fill-opacity='.5'/%3E%3C/g%3E%3C/svg%3E">
  <style>
    :root {
      color-scheme: dark;
      --void: #0B0A12; --dusk: #1F1B33; --night: #14121F; --line: #2A2542;
      --violet: #7C3AED; --violet-hover: #6D28D9; --veil: #8B5CF6; --lilac: #C4B5FD; --mist: #EDE9FE; --slate: #A9A4C4;
      --font-text: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-display: "Sora", "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    body { font-family: var(--font-text); background: var(--void); color: var(--mist); display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 0 16px; }
    form { box-sizing: border-box; width: min(380px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 32px; background: var(--night); border: 1px solid var(--line); border-radius: 16px; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .brand svg { width: 40px; height: 40px; }
    h1 { margin: 0; font-family: var(--font-display); font-size: 2rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
    input:not([type=hidden]) { padding: 12px 14px; font: inherit; font-size: 1rem; border-radius: 10px; border: 1px solid var(--line); background: var(--dusk); color: var(--mist); }
    input::placeholder { color: var(--slate); }
    input:focus { outline: none; border-color: var(--veil); }
    button { padding: 12px 18px; font: inherit; font-size: 1rem; font-weight: 500; border-radius: 10px; border: 0; background: var(--violet); color: #fff; cursor: pointer; }
    button:hover { background: var(--violet-hover); }
    button:focus-visible { outline: 2px solid var(--lilac); outline-offset: 2px; }
    .err { color: #F87171; margin: 0; font-size: 0.95rem; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <div class="brand">
      <svg viewBox="0 0 96 96" role="img" aria-label="Veil logo">
        <defs>
          <linearGradient id="vg" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#C4B5FD"/><stop offset="1" stop-color="#6D28D9"/></linearGradient>
          <clipPath id="vc"><path d="M10 14H34L48 52 62 14H86L58 84H38Z"/></clipPath>
        </defs>
        <path d="M10 14H34L48 52 62 14H86L58 84H38Z" fill="url(#vg)"/>
        <g clip-path="url(#vc)"><path d="M0 46C26 36 50 64 96 50V72C54 86 28 58 0 68Z" fill="#0B0A12" fill-opacity="0.5"/></g>
      </svg>
      <h1>Veil</h1>
    </div>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <input type="hidden" name="next" value="${esc(next)}">
    <input name="username" placeholder="Username" aria-label="Username" autocomplete="username" autofocus required>
    <input name="password" type="password" placeholder="Password" aria-label="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

export function registerAuth(app: FastifyInstance) {
  if (!authEnabled) return;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.raw.url!.split('?')[0];
    if (path === '/login' || path === '/api/login' || path === '/api/refresh' || path === '/logout' || path === '/manifest.json' || path.startsWith('/icons/')) return;
    if (validToken(extractToken(req))) return;
    // Access-Token abgelaufen, aber Refresh-Cookie vorhanden: transparent erneuern.
    const pair = refresh(cookieValue(req, REFRESH_COOKIE));
    if (pair) {
      setAuthCookies(req, reply, pair);
      return;
    }
    const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) return reply.redirect('/login?next=' + encodeURIComponent(req.raw.url!));
    return reply.code(401).header('www-authenticate', 'Bearer realm="veil"').send('Authentication required');
  });

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as { next?: string }).next ?? '/');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(loginPage(next));
  });

  // Prüft die Zugangsdaten, gibt bei Erfolg ein neues Token zurück (sonst undefined).
  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    if (rateLimited(req.ip)) {
      reply.code(429).header('retry-after', '900');
      return undefined;
    }
    const creds = await readCredentials(req).catch(() => undefined);
    const ok = creds && safeEq(creds.username, USER!) && safeEq(creds.password, PASS!);
    if (!ok) {
      recordFail(req.ip);
      reply.code(401);
      return undefined;
    }
    fails.delete(req.ip);
    return { pair: issuePair(), next: safeNext(creds.next) };
  }

  // Browser-Formular: Token als HttpOnly-Cookie setzen und weiterleiten.
  app.post('/login', async (req, reply) => {
    const result = await authenticate(req, reply);
    if (!result) {
      const msg = reply.statusCode === 429 ? 'Too many attempts. Please try again later.' : 'Incorrect username or password.';
      return reply.type('text/html; charset=utf-8').send(loginPage('/', msg));
    }
    setAuthCookies(req, reply, result.pair);
    return reply.redirect(result.next, 303);
  });

  // API: JSON {username, password} -> {token, refresh_token, ...}; danach "Authorization: Bearer <token>".
  app.post('/api/login', async (req, reply) => {
    const result = await authenticate(req, reply);
    if (!result) return reply.send({ error: reply.statusCode === 429 ? 'too many attempts' : 'invalid credentials' });
    return reply.header('cache-control', 'no-store').send(pairBody(result.pair));
  });

  // API: JSON {refresh_token} -> neues Paar (das Refresh-Token wird rotiert).
  app.post('/api/refresh', async (req, reply) => {
    const body = req.body as { refresh_token?: unknown } | undefined;
    const pair = refresh(typeof body?.refresh_token === 'string' ? body.refresh_token : undefined);
    if (!pair) return reply.code(401).send({ error: 'invalid refresh token' });
    return reply.header('cache-control', 'no-store').send(pairBody(pair));
  });

  app.get('/logout', async (req, reply) => {
    revoke(extractToken(req), cookieValue(req, REFRESH_COOKIE));
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    reply.header('set-cookie', `${REFRESH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.redirect('/login');
  });
}
