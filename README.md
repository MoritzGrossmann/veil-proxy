<div align="center">

<img src="public/icons/icon-256.png" alt="Veil logo" width="128" height="128">

# Veil

**See through the veil.**

A self-hosted rewriting web proxy with encrypted target URLs, SSRF protection and optional login. One container, no setup.

[![Docker Hub](https://img.shields.io/docker/v/moritzgrossmann/veil-proxy?label=Docker%20Hub&logo=docker&logoColor=white&color=7c3aed)](https://hub.docker.com/r/moritzgrossmann/veil-proxy)
[![Docker Pulls](https://img.shields.io/docker/pulls/moritzgrossmann/veil-proxy?color=7c3aed)](https://hub.docker.com/r/moritzgrossmann/veil-proxy)
![Node.js](https://img.shields.io/badge/node-%E2%89%A520-7c3aed?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7c3aed?logo=typescript&logoColor=white)

[Quick start](#quick-start) · [Configuration](#configuration) · [Security](#security) · [Limitations](#known-limitations-mvp)

</div>

---

## What is Veil?

Enter a URL and Veil fetches the page on the server and rewrites every link and resource to flow back through the proxy as `/p/<encrypted target>`. The real destination is sealed with AES-256-GCM, so it cannot be reconstructed without your server key. The key also depends on a hash of the browser fingerprint and the creation time (15-minute window).

Use it to reach sites from a restricted network, keep target URLs out of browser history and logs, or browse through a single trusted exit point.

## Features

| | |
| --- | --- |
| **Full rewriting** | HTML, links and resources are rewritten so everything keeps flowing through the proxy. |
| **Encrypted URLs** | Targets in proxy paths are encrypted with AES-256-GCM. The key is derived from the server secret, a browser fingerprint hash and the creation time (15-minute window): URLs only work in the browser that created them and expire at 00:00 UTC. |
| **SSRF protection** | Private, loopback and link-local addresses are blocked on the connected IP, which also defeats DNS rebinding. Open up trusted targets with `PROXY_ALLOW_HOSTS`. |
| **Address bar** | Built into proxied pages, with a DuckDuckGo fallback for non-URL input. |
| **Session cookies** | Cookies of target sites live in a per-session, server-side jar. |
| **Optional login** | Username/password with Bearer token authentication for browser and API. |
| **Installable** | Ships a web app manifest and icons, so it can be added to your home screen. |
| **Easy to run** | A single Docker image, configured entirely through environment variables. |

## Quick start

### Docker Hub image (recommended)

Tagged releases are published to Docker Hub as [`moritzgrossmann/veil-proxy`](https://hub.docker.com/r/moritzgrossmann/veil-proxy). Pull it with:

```bash
docker pull moritzgrossmann/veil-proxy:latest
```

Run it directly:

```bash
docker run -d --name veil-proxy -p 8080:8080 \
  -e PROXY_USER=admin \
  -e PROXY_PASS='change-me' \
  -e PROXY_SECRET="$(openssl rand -hex 32)" \
  moritzgrossmann/veil-proxy:latest
```

Available tags: `latest`, plus each release as `1.0.0`, `1.0` and `1`. Pin a version in production.

### Docker Compose

To run the pre-built image without cloning the repo, save [docker-compose.example.yml](docker-compose.example.yml) as `docker-compose.yml` in an empty directory and add a `.env` next to it:

```bash
cp .env.example .env   # then edit PROXY_USER / PROXY_PASS / PROXY_SECRET
docker compose up -d   # http://<server>:8080
```

Inside this repository, use `docker compose -f docker-compose.example.yml up -d` so the local `docker-compose.yml` stays untouched.

To update later: `docker compose pull && docker compose up -d`.

To build from source instead, use the `docker-compose.yml` in this repository:

```bash
docker compose up -d --build
```

### Local development

Requires Node.js 20 or newer.

```bash
npm install
npm run dev     # http://localhost:8080
```

Production build: `npm run build && npm start`.

## Configuration

All configuration is done through environment variables.

| Variable       | Default   | Description                                                                                                  |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`         | `8080`    | Port to listen on.                                                                                           |
| `HOST`         | `0.0.0.0` | Interface to bind to.                                                                                        |
| `PROXY_SECRET` | random    | Key used to encrypt target URLs. If unset, a random key is generated on every start (see below).            |
| `PROXY_USER`   | –         | Login username. Authentication is enabled when both `PROXY_USER` and `PROXY_PASS` are set.                   |
| `PROXY_PASS`   | –         | Login password.                                                                                              |
| `PROXY_TOKEN_TTL_HOURS` | `12` | Lifetime of issued tokens in hours.                                                                    |
| `PROXY_ALLOW_HOSTS` | – | Comma-separated hostnames, IP addresses and CIDR ranges that may be reached even if they are private (see below). |

### Stable proxy URLs

Without `PROXY_SECRET`, a random key is generated at each start, which invalidates all previously issued proxy URLs (bookmarks, history). Set `PROXY_SECRET` to a long random value for stable URLs. Independently of that, proxy URLs expire 24 hours after creation (sliding window) and cannot be opened from another browser or device, so bookmarks of `/p/...` links stop working after 24 hours.

### Accessing IP addresses and internal hosts

Public sites, IP addresses and hostnames work out of the box. Private, loopback and link-local targets are blocked by default and must be allowed explicitly with `PROXY_ALLOW_HOSTS`, a comma-separated list of:

- IP addresses, e.g. `192.168.1.10`
- CIDR ranges, e.g. `192.168.1.0/24`
- Hostnames, e.g. `nas.local`, `intranet.example.lan`

```bash
PROXY_ALLOW_HOSTS=192.168.1.0/24,nas.local
```

Only the listed targets are opened up; everything else stays blocked. A listed hostname is allowed regardless of the IP it resolves to. Inside Docker, `localhost` is the container itself; use the host's LAN IP or hostname instead.

### Authentication

If `PROXY_USER` and `PROXY_PASS` are set, every request must be authenticated. Without them the proxy is open, so only run it that way on a trusted network.

- **Browser:** unauthenticated visitors are redirected to `/login`. After signing in, a random Bearer token is stored in an `HttpOnly` cookie (`ptoken`). `/logout` revokes it.
- **API / scripts:** `POST /api/login` with `{"username": "...", "password": "..."}` returns `{"token": "..."}`; send it as `Authorization: Bearer <token>`.
- Tokens are kept in memory, so they are invalidated on restart. After 10 failed logins an IP is locked out for 15 minutes.

With Docker Compose, set the credentials in a `.env` file next to `docker-compose.yml` (see `.env.example`); `PROXY_PASS` is required:

```bash
cp .env.example .env   # then edit PROXY_USER / PROXY_PASS
docker compose up -d --build
```

```bash
TOKEN=$(curl -s -d '{"username":"admin","password":"..."}' -H 'content-type: application/json' http://localhost:8080/api/login | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/
```

Serve the proxy over HTTPS (e.g. behind a reverse proxy) so credentials and tokens are not sent in clear text.

## Security

- **SSRF protection:** private, loopback and link-local addresses are blocked on the IP actually connected to, which also defends against DNS rebinding. Your home or internal network is not reachable through the proxy unless you list it in `PROXY_ALLOW_HOSTS`; only add targets you trust.
- **Cookies:** cookies from target sites are kept server-side in one jar per session (identified by the `psid` cookie).

## Known limitations (MVP)

- No WebSocket or EventSource support.
- JavaScript is not rewritten. Only `fetch`, XHR, DOM setters and the History API are patched in the browser, so heavily JS-driven sites may break.

## Releasing

Pushing a Git tag builds and publishes a Docker image to Docker Hub (see `.github/workflows/docker.yml`).

One-time setup: add these repository secrets under *Settings → Secrets and variables → Actions*:

- `DOCKERHUB_USERNAME`: your Docker Hub username
- `DOCKERHUB_TOKEN`: a Docker Hub access token with read/write permission

Then release with:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This produces the image tags `1.0.0`, `1.0`, `1` and `latest`.
