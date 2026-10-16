![Veil logo](https://raw.githubusercontent.com/MoritzGrossmann/veil-proxy/master/public/icons/icon-128.png)

# Veil

**See through the veil.**

A self-hosted rewriting web proxy with encrypted target URLs, SSRF protection and optional login. One container, no setup.

Source code and full documentation: [github.com/MoritzGrossmann/veil-proxy](https://github.com/MoritzGrossmann/veil-proxy)

## Tags

- `latest`: the most recent release
- `1.0.0`, `1.0`, `1`: pinned releases (pin a version in production)

Images are available for `linux/amd64` and `linux/arm64`.

## Quick start

```bash
docker run -d --name veil-proxy -p 8080:8080 \
  -e PROXY_USER=admin \
  -e PROXY_PASS='change-me' \
  -e PROXY_SECRET="$(openssl rand -hex 32)" \
  moritzgrossmann/veil-proxy:latest
```

Then open `http://<server>:8080`.

## Docker Compose

Save this as `docker-compose.yml`:

```yaml
services:
  veil-proxy:
    image: moritzgrossmann/veil-proxy:latest   # or pin a release, e.g. :1.0.0
    container_name: veil-proxy
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      PROXY_USER: ${PROXY_USER:-admin}
      PROXY_PASS: ${PROXY_PASS:?PROXY_PASS must be set (e.g. in .env)}
      PROXY_SECRET: ${PROXY_SECRET:-}
      PROXY_TOKEN_TTL_HOURS: ${PROXY_TOKEN_TTL_HOURS:-12}
      PROXY_ALLOW_HOSTS: ${PROXY_ALLOW_HOSTS:-}
```

Add a `.env` file next to it:

```bash
PROXY_USER=admin
PROXY_PASS=change-me
# Long random value (openssl rand -hex 32) keeps proxy URLs valid across restarts
PROXY_SECRET=
```

Start it:

```bash
docker compose up -d
```

Update later:

```bash
docker compose pull && docker compose up -d
```

## Configuration

All configuration is done through environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind to. |
| `PROXY_SECRET` | random | Key used to encrypt target URLs. If unset, a random key is generated on every start and previously issued proxy URLs stop working. |
| `PROXY_USER` | - | Login username. Authentication is enabled when both `PROXY_USER` and `PROXY_PASS` are set. |
| `PROXY_PASS` | - | Login password. |
| `PROXY_TOKEN_TTL_HOURS` | `12` | Lifetime of issued tokens in hours. |
| `PROXY_ALLOW_HOSTS` | - | Comma-separated hostnames, IPs and CIDR ranges that may be reached even if they are private. |

### Reaching internal hosts

Private, loopback and link-local targets are blocked by default. Allow trusted ones explicitly:

```bash
PROXY_ALLOW_HOSTS=192.168.1.0/24,nas.local
```

Inside Docker, `localhost` is the container itself; use the host's LAN IP or hostname instead.

### Authentication

Without `PROXY_USER` and `PROXY_PASS` the proxy is open, so only run it that way on a trusted network. Serve it over HTTPS (e.g. behind a reverse proxy) so credentials and tokens are not sent in clear text.

For scripts, `POST /api/login` with `{"username": "...", "password": "..."}` returns a token to send as `Authorization: Bearer <token>`.
