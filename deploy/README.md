# Droplet nginx — API proxies for custom domain

The v0.5.0 explorer loads places/worlds via **same-origin** `/api/places/*` (see `src/map/mapConfig.ts`). Vite proxies this in dev; production needs nginx.

## Quick fix (add to existing site block)

Place **above** `location / { try_files ... }`:

```nginx
location /api/places/ {
  proxy_pass https://places.decentraland.org/api/;
  proxy_ssl_server_name on;
  proxy_set_header Host places.decentraland.org;
}

location /api/marketplace/ {
  proxy_pass https://marketplace-api.decentraland.org/;
  proxy_ssl_server_name on;
  proxy_set_header Host marketplace-api.decentraland.org;
}
```

**Critical:** both `location` and `proxy_pass` must end with `/` so `/api/places/worlds` → `https://places.decentraland.org/api/worlds`.  
Without the trailing slash on `proxy_pass`, nginx forwards `/api/places/worlds` verbatim → Places API `not_found`.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sS 'https://decentraland.lastslice.co/api/places/worlds?limit=1' | head -c 80
```

## Full site config

See [`nginx.conf`](./nginx.conf) for peers, parcels, worlds live-data, texture proxy, and SPA fallback.