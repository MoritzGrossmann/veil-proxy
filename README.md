# httpProxyPage

Rewriting-Web-Proxy: URL eingeben, die Zielseite wird über den Server geladen und alle Links/Ressourcen werden auf `/p/<url-encoded Ziel>` umgeschrieben.

## Start

```bash
docker compose up -d --build   # http://<server>:8080
```

Lokal ohne Docker: `npm install && npm run dev` (Port 8080, änderbar mit `PORT`).

## Optionale Auth

Wenn `PROXY_USER` und `PROXY_PASS` gesetzt sind, wird Basic-Auth verlangt. Ohne sie ist der Proxy offen – dann nur im vertrauenswürdigen Netz betreiben.

## Sicherheit

- SSRF-Schutz: Private, Loopback- und Link-Local-Adressen werden auf der tatsächlich verbundenen IP blockiert (auch gegen DNS-Rebinding). Das Heimnetz ist über den Proxy nicht erreichbar.
- Cookies der Zielseiten liegen serverseitig in einem Jar pro Session (`psid`-Cookie).

## Bekannte Grenzen (MVP)

- Kein WebSocket-/EventSource-Support.
- JS wird nicht umgeschrieben, nur `fetch`/XHR/DOM-Setter/History werden im Browser gepatcht. Stark JS-lastige Seiten können brechen.
