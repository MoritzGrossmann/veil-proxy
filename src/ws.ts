import http, { type IncomingMessage, type Server } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { CookieJar } from 'tough-cookie';
import { isAuthorized } from './auth.js';
import { assertUrlAllowed, safeLookup } from './ssrf.js';
import { decryptUrl, keyFromCookie } from './urlcrypt.js';

const FORWARD_WS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'user-agent', 'accept-language', 'pragma', 'cache-control'];

function reject(socket: Duplex, code: number, text: string) {
  if (socket.writable) socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * WebSocket-Tunnel: Der Client verbindet sich mit /p/<token>, der Server öffnet eine Upgrade-Verbindung
 * zum Ziel und reicht danach die rohen Sockets durch (Frames, Subprotokolle und Extensions bleiben unangetastet).
 */
export function registerWebSocketTunnel(server: Server, getJar: (cookieHeader: string | undefined) => CookieJar | undefined) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    tunnel(req, socket, head, getJar).catch(() => reject(socket, 502, 'Bad Gateway'));
  });
}

async function tunnel(req: IncomingMessage, socket: Duplex, head: Buffer, getJar: (cookieHeader: string | undefined) => CookieJar | undefined) {
  if (!req.url?.startsWith('/p/') || String(req.headers.upgrade).toLowerCase() !== 'websocket') return reject(socket, 400, 'Bad Request');
  if (!isAuthorized(req)) return reject(socket, 401, 'Unauthorized');
  // Cross-Site-WebSocket-Hijacking verhindern: nur Seiten von diesem Proxy dürfen verbinden.
  if (req.headers.origin) {
    let originHost: string | undefined;
    try {
      originHost = new URL(req.headers.origin).host;
    } catch {
      /* ungültig */
    }
    if (originHost !== req.headers.host) return reject(socket, 403, 'Forbidden');
  }
  const key = keyFromCookie(req.headers.cookie);
  if (!key) return reject(socket, 400, 'Bad Request');

  let target: URL;
  try {
    const decoded = decryptUrl(req.url.slice(3), key);
    if (decoded === undefined) throw new Error('invalid token');
    target = new URL(decoded.replace(/^ws(s?):/i, 'http$1:'));
    assertUrlAllowed(target);
  } catch {
    return reject(socket, 400, 'Bad Request');
  }

  const headers: Record<string, string> = { connection: 'Upgrade', upgrade: 'websocket', origin: target.origin };
  for (const name of FORWARD_WS) {
    const v = req.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }
  const jar = getJar(req.headers.cookie);
  const cookie = await jar?.getCookieString(target.href);
  if (cookie) headers.cookie = cookie;

  const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', headers, lookup: safeLookup, timeout: 30_000 });

  upstream.on('upgrade', (res, upSocket, upHead) => {
    upstream.setTimeout(0);
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());

    let out = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const name = res.rawHeaders[i];
      if (name.toLowerCase() === 'set-cookie') {
        void jar?.setCookie(res.rawHeaders[i + 1], target.href).catch(() => undefined);
        continue;
      }
      out += `${name}: ${res.rawHeaders[i + 1]}\r\n`;
    }
    socket.write(out + '\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });

  // Ziel lehnt das Upgrade ab: Status durchreichen
  upstream.on('response', (res) => {
    res.resume();
    reject(socket, res.statusCode ?? 502, res.statusMessage || 'Upstream refused');
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => reject(socket, 502, 'Bad Gateway'));
  socket.on('close', () => upstream.destroy());
  upstream.end();
}
