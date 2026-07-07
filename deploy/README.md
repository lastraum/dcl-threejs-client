# Droplet nginx — API proxies for custom domain

**Canonical FTP copies:**

| Domain | Config | Web root |
| ------ | ------ | -------- |
| **decentraland.social** (prod) | [`../remote/decentraland.social`](../remote/decentraland.social) | `/var/www/dcl-threejs` |
| **dev.decentraland.social** (staging) | [`../remote/dev.decentraland.social`](../remote/dev.decentraland.social) | `/var/www/dcl-threejs-dev` |
| decentraland.lastslice.co (legacy) | [`../remote/decentraland.lastslice.co`](../remote/decentraland.lastslice.co) | `/var/www/dcl-threejs` |

The v0.5.0 explorer loads places/worlds via **same-origin** `/api/places/*` (see `src/map/mapConfig.ts`). Vite proxies this in dev; production needs nginx.

## Quick fix (add to existing site block)

Place **above** `location / { try_files ... }`:

```nginx
location /api/places/ {
  rewrite ^/api/places/(.*)$ /api/$1 break;
  set $places_host places.decentraland.org;
  proxy_pass https://$places_host;
  proxy_ssl_server_name on;
  proxy_set_header Host places.decentraland.org;
}
```

**Critical:** when `proxy_pass` uses a **variable** (`$places_host`), nginx does **not** strip the location prefix — you must `rewrite … break` first.  
Without rewrite, upstream receives `/api/places/worlds` → Places API `not_found`.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sS 'https://decentraland.social/api/places/worlds?limit=1' | head -c 80
curl -sS 'https://dev.decentraland.social/api/places/worlds?limit=1' | head -c 80
```

## Full site config

See [`nginx.conf`](./nginx.conf) for peers, parcels, worlds live-data, texture proxy, and SPA fallback.

## Dev panel suggestions (production)

The client POSTs same-origin `/api/suggestions`. Nginx forwards to a small Node service on the droplet (token stays server-side).

**1. Sync app + server files on droplet** (not just `dist/`):

```bash
sudo mkdir -p /opt/dcl-threejs-client
sudo rsync -av --delete \
  dist/ server/ scripts/suggestion-dispatch-proxy.mjs package.json \
  /opt/dcl-threejs-client/
sudo chown -R www-data:www-data /opt/dcl-threejs-client
```

**2. Token env** (`/etc/dcl-threejs/suggestion-api.env`):

```bash
sudo mkdir -p /etc/dcl-threejs
sudo tee /etc/dcl-threejs/suggestion-api.env <<'EOF'
SUGGESTION_DISPATCH_TOKEN=github_pat_REPLACE_ME
SUGGESTION_DISPATCH_REPO=lastraum/dcl-threejs-client
SUGGESTION_API_PORT=8788
EOF
sudo chmod 600 /etc/dcl-threejs/suggestion-api.env
```

Fine-grained PAT: **Issues → Read and write** on `lastraum/dcl-threejs-client`.

**3. systemd**

```bash
sudo cp deploy/suggestion-api.service /etc/systemd/system/dcl-suggestion-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now dcl-suggestion-api
sudo systemctl status dcl-suggestion-api
```

**4. nginx** — add `location = /api/suggestions` from [`nginx.conf`](./nginx.conf) or [`../remote/decentraland.social`](../remote/decentraland.social), then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**5. Smoke test**

```bash
curl -sS -X POST https://decentraland.social/api/suggestions \
  -H 'Content-Type: application/json' \
  -d '{"summary":"prod smoke test","category":"Other","details":"ignore — droplet curl smoke test","client_version":"0.5.0"}'
```

Expect `{"ok":true,"issue_number":...,"issue_url":"..."}`.