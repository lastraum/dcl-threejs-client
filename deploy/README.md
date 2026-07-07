# Droplet nginx — API proxies for custom domain

**Canonical FTP copies:** [`../remote/decentraland.lastslice.co`](../remote/decentraland.lastslice.co) (prod) and [`../remote/decentraland-dev.lastslice.co`](../remote/decentraland-dev.lastslice.co) (staging).

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
curl -sS 'https://decentraland.lastslice.co/api/places/worlds?limit=1' | head -c 80
```

## Full site config

See [`nginx.conf`](./nginx.conf) for peers, parcels, worlds live-data, texture proxy, and SPA fallback.