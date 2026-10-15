import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const USER = process.env.PROXY_USER;
const PASS = process.env.PROXY_PASS;
const TOKEN_TTL_MS = Number(process.env.PROXY_TOKEN_TTL_HOURS ?? 12) * 3600_000;
const COOKIE = 'ptoken';
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;

export const authEnabled = Boolean(USER && PASS);

const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const tokens = new Map<string, number>(); // token -> Ablaufzeit
const fails = new Map<string, { count: number; first: number }>();

function issueToken(): string {
  const now = Date.now();
  for (const [t, exp] of tokens) if (exp < now) tokens.delete(t);
  const token = randomBytes(32).toString('base64url');
  tokens.set(token, now + TOKEN_TTL_MS);
  return token;
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const exp = tokens.get(token);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function extractToken(req: FastifyRequest): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (m) return m[1];
  return new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(req.headers.cookie ?? '')?.[1];
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
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Veil – Anmelden</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 0 16px; }
    form { width: min(360px, 100%); display: flex; flex-direction: column; gap: 10px; }
    input { padding: 12px 14px; font-size: 1rem; border-radius: 8px; border: 1px solid #8886; background: transparent; color: inherit; }
    button { padding: 12px 18px; font-size: 1rem; border-radius: 8px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
    h1 { font-size: 1.2rem; text-align: center; font-weight: 600; }
    .err { color: #dc2626; text-align: center; margin: 0; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Anmelden</h1>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <input type="hidden" name="next" value="${esc(next)}">
    <input name="username" placeholder="Benutzername" autocomplete="username" autofocus required>
    <input name="password" type="password" placeholder="Passwort" autocomplete="current-password" required>
    <button type="submit">Anmelden</button>
  </form>
</body>
</html>`;
}

export function registerAuth(app: FastifyInstance) {
  if (!authEnabled) return;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.raw.url!.split('?')[0];
    if (path === '/login' || path === '/api/login' || path === '/logout') return;
    if (validToken(extractToken(req))) return;
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
    return { token: issueToken(), next: safeNext(creds.next) };
  }

  // Browser-Formular: Token als HttpOnly-Cookie setzen und weiterleiten.
  app.post('/login', async (req, reply) => {
    const result = await authenticate(req, reply);
    if (!result) {
      const msg = reply.statusCode === 429 ? 'Zu viele Versuche. Bitte später erneut versuchen.' : 'Benutzername oder Passwort falsch.';
      return reply.type('text/html; charset=utf-8').send(loginPage('/', msg));
    }
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}${secure}`);
    return reply.redirect(result.next, 303);
  });

  // API: JSON {username, password} -> {token}; danach "Authorization: Bearer <token>".
  app.post('/api/login', async (req, reply) => {
    const result = await authenticate(req, reply);
    if (!result) return reply.send({ error: reply.statusCode === 429 ? 'too many attempts' : 'invalid credentials' });
    return reply.header('cache-control', 'no-store').send({ token: result.token, token_type: 'Bearer', expires_in: Math.floor(TOKEN_TTL_MS / 1000) });
  });

  app.get('/logout', async (req, reply) => {
    const token = extractToken(req);
    if (token) tokens.delete(token);
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.redirect('/login');
  });
}
