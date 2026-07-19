# Place analytics (Supabase) — public landing stats

> **Status:** Phase 1–2 shipped on `lastraum` / `dev-latest` (JSONL + optional Supabase mirror, public landing stats modal).  
> **Scope:** explorer **presence / place engagement** (landing, jump-in, `/goto`, dwell, uniques).  
> **Out of scope:** Forge quests/rewards/items, Privy MAU identity for every visitor, spatial heatmaps v1.  
> **Prod client build:** `npm run build:prod` (sets `VITE_ANALYTICS_ENABLED=true`) → deploy to `decentraland.social`.  
> **Local + staging:** `npm run build` (forces analytics **off**) → `dev.decentraland.social` / local.  
> **Dev API (local only):** Vite middleware serves `/api/analytics/*` if you set the flag for a manual opt-in test.  
> **Prod API:** PM2 (`server/ecosystem.config.cjs`) + nginx `/api/analytics/` → `:8787`.

**Product decision:** stats for a place are **public**. Anyone on the **scene landing page** can open a stats panel — not owner/creator only. Creators benefit the same as visitors; social proof is intentional.

---

## 1. Goals

Give **everyone** (visitors, creators, the platform) trustworthy place engagement answers:

| Question | Example metric |
| -------- | -------------- |
| Did people find this place? | Landing page views |
| Did they enter 3D? | Jump-ins, jump-in rate |
| How long did they stay? | Median / p90 time on scene |
| Who came back? | Unique visitors, multi-visit rate |
| How did they arrive / leave? | Source + `/goto` destinations |
| Guest vs wallet mix? | Login kind breakdown |

**Primary surface:** scene/world **landing page** stats modal (bar-chart control next to settings gear).

**Non-goals (v1):**

- Quest/step/reward analytics (Forge owns that when integrated later)
- Forcing Privy or Forge client connect for every session
- Full spatial heatmaps, gaze, or per-entity click maps
- Real-time multiplayer CCU product (can approximate later from heartbeats)
- Replacing DCL Builder’s 7-day land stats (complement, not replace)
- **Private creator-only dashboards** — v1 is public aggregates only (no wallet gate to view)

---

## 2. Architecture principles

### Two lanes

```text
Explorer traffic (everyone)          Forge (later, opt-in / content-gated)
──────────────────────────          ────────────────────────────────────
landing · jump-in · goto · dwell     quests · rewards · items · actions
        │                                      │
        ▼                                      ▼
   Supabase (this doc)                    Forge server analytics
   no Privy required                      Privy only when needed for game state
        │
        ▼
   Public aggregates API
   (anyone may read place summary)
        │
        ▼
   Landing page stats panel
```

Do **not** double-write the same landing/jump-in events into Forge.

### Always-on but never blocking

- Fire-and-forget client emits (`keepalive` on unload).
- Analytics failures must not affect load, play, or navigation.
- Opt-in via env flag (same spirit as `VITE_ANALYTICS_ENABLED` today).
- Stats panel load is lazy (only when user opens the chart icon).

### Guest-first identity (write path)

- Primary unique key: sticky anonymous `visitor_id` (localStorage).
- Optional wallet when the user has one — never required to count a visit.
- Public UI shows **aggregate** uniques only — never a list of wallets or visitor ids.

### Place-centric, public read

Metrics roll up by **`place_key`** (world or parcel). **Read access is public** for pre-aggregated summaries. Raw `place_events` rows stay private (service role only).

---

## 3. Identity model

| Field | Source | Notes |
| ----- | ------ | ----- |
| `visitor_id` | `localStorage` UUID v4 | Created on first visit; survives reloads; not cross-device |
| `session_id` | `sessionStorage` or in-memory UUID | One per tab lifecycle (or per play stint — see below) |
| `wallet` | `login.address` when known | Lowercase `0x` + 40 hex; omit for pure guest |
| `login_kind` | `guest` \| `wallet` | From `LoginResult` |
| `play_session_id` | UUID at successful jump-in / play start | Ties enter → heartbeats → leave for dwell |

**Uniques**

- **Anon unique:** distinct `visitor_id` over a time window (default).
- **Wallet unique:** distinct `wallet` where non-null (undercounts pure guests).
- **Multi-visit:** same `visitor_id` + `place_key` with ≥2 distinct `play_session_id` (or calendar days — pick one and document in dashboard).

**Do not store (v1):** raw IP, email, Privy id, full user-agent string (optional coarse `ua_class`: `desktop` \| `mobile` \| `unknown`).

---

## 4. Place keys

Every place-scoped event must include a stable `place_key` and structured route fields.

| Place type | `place_kind` | `place_key` | Extra fields |
| ---------- | ------------ | ----------- | ------------ |
| Genesis / parcel | `coords` | `parcel:{x},{y}` | `x`, `y` (integers) |
| World | `world` | `world:{name}` | `world_name` normalized (`foo.dcl.eth`) |
| Non-place shell | `shell` | `shell:{name}` | `explore`, `map`, `events`, `communities`, `profile`, `editor` |

**Normalization rules**

- Worlds: lowercase; bare ENS segment → append `.dcl.eth` when the client already does (see `parseRouteTarget`).
- Coords: no spaces; use resolved route target after parse, not raw URL typos.
- Prefer **landing and play** sharing the same `place_key` for the same target so funnels join.

**Optional later**

- `scene_entity_id` / content hash when resolved from Catalyst (dedupe multi-parcel scenes).
- `title` snapshot for display only (not for joins).

---

## 5. Funnel stages (canonical)

```text
  shell_view (explore/map/…)          optional platform context
        │
        ▼
  landing_view  ───────────────────── scene/world landing page mounted
        │
        ├─ jump_in_click ──────────── user hits Jump In CTA
        │       │
        │       ▼
        │  auth_gate (if needed) ──── sign-in panel shown / completed
        │       │
        │       ▼
        │  scene_load_start
        │       │
        │       ├─ scene_load_fail
        │       └─ scene_enter ────── play mode ready (in-world)
        │               │
        │               ├─ heartbeat (while in play)
        │               ├─ goto / navigate away
        │               └─ scene_leave
        │
        └─ leave landing without jump-in
```

**Jump-in rate** = `jump_in_click` (or successful `scene_enter`) / `landing_view` for the same `place_key` and window.  
Define dashboard default as **`scene_enter / landing_view`** (completed entry), with **`jump_in_click / landing_view`** as intent rate.

---

## 6. Event catalog

All events share a **common envelope**. Place-scoped events also carry place fields.

### 6.1 Common envelope

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `event_id` | uuid | yes | Client-generated; idempotent insert key |
| `event` | text | yes | Event name (below) |
| `at` | timestamptz | yes | Client clock ISO time |
| `received_at` | timestamptz | server | Set on insert |
| `visitor_id` | uuid | yes | Sticky anon id |
| `session_id` | uuid | yes | Tab/session id |
| `play_session_id` | uuid | when in play | Set from jump-in through leave |
| `login_kind` | text | yes | `guest` \| `wallet` |
| `wallet` | text | no | Lowercase address |
| `client_version` | text | yes | `APP_VERSION` |
| `path` | text | yes | `pathname + search`, max 512 chars |
| `source` | text | no | How they got here (see §7) |
| `ua_class` | text | no | `desktop` \| `mobile` \| `unknown` |

### 6.2 Place fields (when applicable)

| Field | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `place_kind` | text | yes | `coords` \| `world` \| `shell` |
| `place_key` | text | yes | Canonical key |
| `world_name` | text | if world | Normalized ENS |
| `x`, `y` | int | if coords | Parcel |

### 6.3 Events to track

#### A. Auth / platform (low volume)

| `event` | When | Place? | Payload extras | Client hook (approx.) |
| ------- | ---- | ------ | -------------- | --------------------- |
| `login` | Guest or wallet session established / changed | no | — | Existing `recordLoginEvent` → migrate to Supabase |
| `logout` | Explicit sign-out | no | — | Sign-out path in `AppController` |
| `auth_gate_show` | Jump In blocked; sign-in panel shown | yes | `reason`: `need_session` | Jump In when `!playSessionReady` |
| `auth_gate_complete` | User completes guest/wallet for play | yes | `login_kind` | After `playSessionReady = true` from auth panel |

#### B. Shell navigation (optional v1.1 — platform only)

| `event` | When | Place? | Payload extras | Client hook |
| ------- | ---- | ------ | -------------- | ----------- |
| `shell_view` | Explore / map / events / communities / profile / editor shown | shell | `shell_tab` | `navigateSocialShell` / page mount |

Useful for product analytics; **not** required for creator place dashboards.

#### C. Landing (core v1)

| `event` | When | Place? | Payload extras | Client hook |
| ------- | ---- | ------ | -------------- | ----------- |
| `landing_view` | Scene/world landing UI mounted | yes | `from_history` bool; `had_ban` bool | `showSceneLanding` after mount |
| `landing_chat_ready` | Landing LiveKit/chat ready or terminal status | yes | `status` kind; `jump_in_unlocked` | After `connectSceneLandingChat` unlock logic |
| `landing_cast_live` | Cast/stream goes live or offline on landing | yes | `live` bool | Cast presence watcher (debounce) |

Notes:

- Emit **one** `landing_view` per landing open (not on every cast poll).
- Re-open same place after leaving play → new `landing_view`.
- History back/forward → still count (flag `from_history`).

#### D. Jump-in & load (core v1)

| `event` | When | Place? | Payload extras | Client hook |
| ------- | ---- | ------ | -------------- | ----------- |
| `jump_in_click` | User activates Jump In (or event “Jump in”) | yes | `entry`: `landing_cta` \| `event_card` \| `deep_link` \| `map` \| `other` | `onJumpIn` / `jumpInToScene` entry |
| `scene_load_start` | Play load pipeline begins | yes | `fast_assets` bool; `from_mode`: `landing` \| `play` \| `shell` | Start of `jumpInToScene` |
| `scene_load_fail` | Load/access fails | yes | `error_code` / short message (no stack) | Catch paths; ban → `scene_ban` |
| `scene_ban` | Access denied / ban | yes | short reason | Ban monitor / `assertSceneAccess` failure |
| `scene_enter` | Play mode ready — user in world | yes | `load_ms` optional | After successful jump-in settle / play ready |

`play_session_id` is created at `jump_in_click` or `scene_load_start` and reused until `scene_leave`.

#### E. Dwell / session (core v1)

| `event` | When | Place? | Payload extras | Client hook |
| ------- | ---- | ------ | -------------- | ----------- |
| `heartbeat` | Every **45s** while `appMode === 'play'` and document visible | yes | `seq` int; `visible` bool | Interval in play mode |
| `scene_leave` | Leaving play (teardown, navigate to landing/shell, close) | yes | `dwell_ms` best-effort; `reason`: `navigate` \| `landing` \| `shell` \| `unload` \| `error` | `teardownScene` / `pagehide` |

**Dwell calculation (server or dashboard):**

1. Prefer `scene_leave.dwell_ms` when present.  
2. Else `last_heartbeat.at − scene_enter.at`.  
3. Cap absurd values (e.g. max 6h per session).

Heartbeats keep dwell honest when tabs crash without `scene_leave`.

#### F. In-play navigation (core v1)

| `event` | When | Place? | Payload extras | Client hook |
| ------- | ---- | ------ | -------------- | ----------- |
| `goto` | Chat `/goto …` or equivalent nav command | from + to places | `raw_text` truncated; `to_place_key`; `to_kind` | `route.ts` parse + `navigateHandler` |
| `navigate` | Any route change between places while in client | from + to | `method`: `goto` \| `history` \| `ui` \| `map` \| `event` \| `deep_link` | `navigateTo` / `applyRouteToHistory` |

For `goto` / `navigate`, store:

- `from_place_key` (nullable if shell)
- `to_place_key`
- Optionally emit **two** place-scoped rows is worse — **one event with from/to** is enough.

#### G. Explicit non-goals for event stream (v1)

Do **not** emit:

- Per-frame movement / position samples  
- Pointer/UI hit tests  
- Chat message content  
- Voice / LiveKit internals beyond landing unlock/cast live flags  
- Wearable/backpack browsing (later product)  
- Forge quest events (separate system)

---

## 7. `source` attribution

Set `source` on `landing_view` and `jump_in_click` when known:

| `source` | Meaning |
| -------- | ------- |
| `direct` | Typed URL / bookmark / unknown |
| `explore` | Explorer places list |
| `map` | Map page |
| `events` | Events page / event jump-in |
| `communities` | Communities entry |
| `goto` | In-client `/goto` |
| `history` | Browser back/forward |
| `external` | `document.referrer` non-empty external host (optional host hash only) |
| `unknown` | Default |

Pass source through navigation options where the client already knows the entry point.

---

## 8. Derived metrics (creator dashboard)

Compute from events (SQL views or scheduled rollups). Do not require clients to send aggregates.

### Per `place_key`, window (day / 7d / 30d)

| Metric | Definition |
| ------ | ---------- |
| Landing views | `count(*)` where `event = 'landing_view'` |
| Unique landing visitors | `count(distinct visitor_id)` on landing views |
| Jump-in clicks | `count` `jump_in_click` |
| Scene enters | `count` `scene_enter` |
| Jump-in intent rate | `jump_in_click / landing_view` |
| Jump-in success rate | `scene_enter / landing_view` |
| Load fail rate | `scene_load_fail / scene_load_start` |
| Unique players (anon) | `count(distinct visitor_id)` on `scene_enter` |
| Unique players (wallet) | `count(distinct wallet)` on `scene_enter` where wallet set |
| Multi-visit players | visitors with ≥2 play sessions in window |
| Multi-visit rate | multi-visit / unique players |
| Median dwell | median of per-`play_session_id` dwell |
| p90 dwell | 90th percentile dwell |
| Guest share | `login_kind = guest` / all enters |
| Top entry sources | group by `source` on landing/jump-in |
| Top outbound `/goto` | group `to_place_key` from `goto` where `from_place_key` = place |
| Top inbound | group `from_place_key` where `to_place_key` = place |

### Platform (optional)

- Daily active explorers (`visitor_id`)
- Login mix
- Shell tab popularity
- Version adoption (`client_version`)

---

## 8.5 Public landing stats panel (product UI)

### Decision

| Topic | Choice |
| ----- | ------ |
| Who can see stats? | **Anyone** on the scene/world landing page (guest or wallet) |
| Auth required to view? | **No** |
| Where? | Scene landing card header — **bar chart icon** next to the **settings (gear)** control |
| Owner gear | Unchanged: still **owner-only**, often `hidden` until wallet ∈ `ownerAddresses` |
| Chart icon | **Always visible** on landing (when analytics enabled / data available) |
| Privacy of panel | Aggregates only — no wallet lists, no visitor ids, no IP |

### Placement (existing markup)

Landing card head today (`SceneLandingView` → `scene-watch-dest-scene-card-head`):

```text
[ Title …………………………………  📊  ⚙ ]
                         stats  settings
                         (all)  (owners)
```

- Settings: `button.scene-watch-scene-settings-btn[data-scene-settings]` (owner stream settings).
- **Add:** `button.scene-watch-scene-stats-btn[data-scene-stats]` immediately **before** the settings button (same head row), so layout is `title | stats | settings`.
- Mirror gear styling (icon-only, 18px SVG, same hit target) so the pair feels like one control cluster.
- `aria-label`: e.g. `View place stats` · `title`: `Place stats`.

### Interaction

1. User taps bar-chart icon.  
2. Open **`ScenePlaceStatsModal`** (new; same modal patterns as `SceneUsersModal` / stream settings).  
3. Fetch public summary for current `place_key` + window (default **7 days**).  
4. Show loading → content or empty (“No data yet”) → error retry.  
5. Closing modal does not affect Jump In / chat.

Optional later: window toggle `7d | 30d` inside the modal.

### Modal content (v1 — keep scannable)

**Header:** place title + pointer (`meta.title`, `meta.pointerLabel`).

**Summary chips / big numbers**

| Metric | Notes |
| ------ | ----- |
| Landing views | Total |
| Unique visitors | Anon `visitor_id` distinct |
| Jump-ins (enters) | Prefer `scene_enter` count |
| Jump-in rate | `scene_enter / landing_view` as % |
| Median time in world | Humanized (`12m`, `1h 4m`) |
| Multi-visit rate | Optional secondary line |

**Chart (the “bar chart” promise)**

- Simple **bar chart**: last 7 days × `scene_enter` (or landing views) per day.  
- No heavy chart lib required v1 — CSS bars or tiny SVG is fine.  
- Empty days render as zero-height / faint bar.

**Secondary (collapse or footer)**

- Guest vs wallet % (of enters)  
- Top outbound destinations (up to 5 `to_place_key` labels) — optional v1.1  

**Do not show publicly**

- Individual wallets, visitor ids, session ids  
- Load-fail internals / error strings (owners might get this later; not public v1)  
- Raw event log  

### Read API (public)

```text
GET /api/analytics/places/:placeKey/summary?window=7d
```

Response shape (illustrative):

```json
{
  "place_key": "world:rickroll.dcl.eth",
  "window": "7d",
  "landing_views": 1280,
  "unique_visitors": 640,
  "scene_enters": 410,
  "jump_in_rate": 0.32,
  "unique_players": 290,
  "multi_visit_rate": 0.18,
  "median_dwell_ms": 420000,
  "guest_share": 0.55,
  "series": [
    { "day": "2026-07-13", "scene_enters": 52, "landing_views": 180 },
    { "day": "2026-07-14", "scene_enters": 61, "landing_views": 190 }
  ],
  "top_outbound": [
    { "place_key": "parcel:0,0", "count": 12 }
  ]
}
```

Rules:

- **Public** — no auth header required.  
- Served from **rollups / summary table**, never by scanning raw events on every open.  
- Rate-limit by IP.  
- Unknown `place_key` → empty zeros, not 404 noise (or 404 with empty UI).  
- Cache: CDN / short TTL (e.g. 60–300s) is fine; stats need not be real-time.

### Client pieces (UI)

| Piece | Responsibility |
| ----- | -------------- |
| `SceneLandingView` | Stats button next to settings; wire click |
| `ScenePlaceStatsModal` | Fetch summary, render numbers + 7d bars |
| `src/analytics/placeKey.ts` | Same key as write path for fetch URL |
| CSS | Match landing card / modal chrome |

### Tracking the panel itself (optional v1.1)

| `event` | When |
| ------- | ---- |
| `stats_panel_open` | User opens public stats modal |
| `stats_panel_close` | User closes modal |

Useful for “do people care?” — not required for place metrics.

---

## 9. Supabase schema sketch

### 9.1 Raw events

```sql
-- Enable if desired: create extension if not exists "pgcrypto";

create table public.place_events (
  event_id uuid primary key,
  event text not null,
  at timestamptz not null,
  received_at timestamptz not null default now(),

  visitor_id uuid not null,
  session_id uuid not null,
  play_session_id uuid null,

  login_kind text not null check (login_kind in ('guest', 'wallet')),
  wallet text null check (wallet is null or wallet ~ '^0x[a-f0-9]{40}$'),

  client_version text not null,
  path text not null,
  source text null,
  ua_class text null,

  place_kind text null check (place_kind is null or place_kind in ('coords', 'world', 'shell')),
  place_key text null,
  world_name text null,
  x int null,
  y int null,

  from_place_key text null,
  to_place_key text null,

  -- sparse extras (keep small); prefer columns above for filtered fields
  props jsonb not null default '{}'::jsonb
);

create index place_events_place_at_idx on public.place_events (place_key, at desc);
create index place_events_event_at_idx on public.place_events (event, at desc);
create index place_events_visitor_at_idx on public.place_events (visitor_id, at desc);
create index place_events_play_session_idx on public.place_events (play_session_id)
  where play_session_id is not null;
```

### 9.2 Daily rollup (v1.1)

```sql
create table public.place_stats_daily (
  day date not null,
  place_key text not null,
  landing_views int not null default 0,
  unique_visitors int not null default 0,
  jump_in_clicks int not null default 0,
  scene_enters int not null default 0,
  unique_players int not null default 0,
  multi_visit_players int not null default 0,
  median_dwell_ms int null,
  p90_dwell_ms int null,
  load_fails int not null default 0,
  primary key (day, place_key)
);
```

Fill via cron / Edge Function / SQL job — not from the client.

### 9.3 Ingest

**Recommended:** Edge Function or existing droplet Node proxy:

```text
Client POST /api/analytics/events  (same-origin)
  → validate schema, size, rate limit
  → insert service role into place_events
```

Rules:

- Batch allowed: array of ≤ 20 events per request.
- Reject body > ~32KB.
- Require `VITE_ANALYTICS_ENABLED=true` (or prod default later).
- Optional shared write secret header for non-browser callers.
- **RLS write:** no public insert on raw table; only service role from proxy.
- **RLS read raw:** deny all public SELECT on `place_events`.
- **Public read:** only **summary/rollup** endpoints (or a restricted view/RPC that returns aggregates for one `place_key`). Never expose raw rows to the browser.

### 9.4 Idempotency

Primary key `event_id` (client UUID). Retries use `on conflict do nothing`.

### 9.5 Public summary materialization

Prefer serving the landing modal from `place_stats_daily` (or a `place_stats_summary` cache row) rather than live `count(distinct …)` on every open.

```text
POST events → place_events
cron / trigger → place_stats_daily
GET summary → aggregate last 7 days from place_stats_daily (+ series bars)
```

---

## 10. Client module plan (implementation later)

| Piece | Responsibility |
| ----- | -------------- |
| `src/analytics/ids.ts` | `visitor_id`, `session_id`, `play_session_id` helpers |
| `src/analytics/placeKey.ts` | `RouteTarget` → `place_key` / place fields |
| `src/analytics/track.ts` | `track(event, props)` queue + flush POST |
| `src/analytics/dwell.ts` | heartbeat timer, leave flush |
| `src/analytics/fetchPlaceSummary.ts` | GET public summary for landing modal |
| `src/analytics/recordLogin.ts` | Keep API; route through `track('login', …)` |
| `AppController` hooks | landing, jump-in, navigate, teardown |
| `route` / chat goto | `goto` + `navigate` method tags |
| `SceneLandingView` | Bar-chart btn next to settings gear |
| `ScenePlaceStatsModal` | Public stats UI (numbers + 7d bars) |

**Env**

| Variable | Role |
| -------- | ---- |
| `VITE_ANALYTICS_ENABLED` | Client emit on/off (+ show stats affordance) |
| `VITE_ANALYTICS_URL` | Optional absolute ingest URL (default same-origin `/api/analytics/events`) |
| Server: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Ingest + summary API only; never in browser |

---

## 11. Implementation phases

### Phase 0 — this document

- [x] Scope, events, schema sketch, Forge boundary  
- [x] **Public** landing stats panel (bar chart next to settings)

### Phase 1 — MVP ingest + core events

- [x] JSONL store + Node/Vite ingest (`server/analytics.mjs`, `scripts/analytics-core.mjs`)  
- [x] Optional Supabase mirror (`server/sql/place_events.sql` + env)  
- [x] Client: ids + `track` + env flag  
- [x] Emit: `login`, `landing_view`, `jump_in_click`, `scene_load_start`, `scene_load_fail`, `scene_enter`, `heartbeat`, `scene_leave`, `goto` / `navigate`  
- [x] Smoke script (`npm run analytics:smoke`)

### Phase 2 — public landing stats UI

- [x] Summary computed from JSONL (`computePlaceSummary`)  
- [x] `GET /api/analytics/places/:placeKey/summary`  
- [x] Landing **bar-chart icon** next to settings (`data-scene-stats`)  
- [x] `ScenePlaceStatsModal` — big numbers + 7-day bar chart  
- [x] Empty / loading / error states  
- [x] No auth on read path  

### Phase 3 — polish

- [ ] `source` attribution end-to-end  
- [ ] Window toggle 7d / 30d in modal  
- [ ] Top outbound list in modal  
- [ ] `stats_panel_open` / close tracking  
- [ ] `landing_chat_ready` / cast (if product cares)  
- [ ] Shell views for platform metrics (internal)  
- [ ] Retention policy (e.g. raw 90d, rollups forever)

### Phase 4 — Forge (separate)

- [ ] Client Forge connect only for quest/game content  
- [ ] No migration of place_events into Forge  
- [ ] Optional offline join: place engagement (Supabase) × quest funnels (Forge)

---

## 12. Privacy, abuse, retention

| Topic | Policy |
| ----- | ------ |
| Public UI | Aggregates only; never wallets, visitor ids, or session lists |
| Raw events | Private; service role only |
| PII in storage | Wallet + routes + timestamps are linkable in DB; not shown in public UI |
| Consent | Document that place engagement stats are public on landings when shipping |
| Retention | Raw events 90 days default; daily rollups longer (public charts use rollups) |
| Deletion | Support delete-by-`visitor_id` / wallet for requests (rebuild rollups) |
| Abuse write | Rate limit per IP + per `visitor_id`; drop oversized batches |
| Abuse read | Rate limit summary GETs; cache responses |
| Content | Never log chat bodies or private profile fields |
| License | Align with non-commercial repo terms — no selling visitor datasets |
| Gaming stats | Expect some inflation risk (refresh bots); later: basic bot filters |

**Why public is OK for v1:** same spirit as Places “user count” / social proof. Uniques are coarse; no identity leak in the panel. If abuse appears, add soft caps or delay (T+1h rollups) without gating the UI behind ownership.

---

## 13. Relationship to existing code

| Existing | Action |
| -------- | ------ |
| `src/analytics/recordLogin.ts` | Keep; back with Supabase track |
| `package.json` → `analytics:server` | Historical JSONL server may be replaced or become Supabase proxy |
| `data/logins.jsonl` | Dev/legacy only; not place product |
| `SceneLandingView` settings gear | Keep owner-only; add **always-visible** stats icon beside it |
| `SceneUsersModal` / stream modal | Pattern reference for `ScenePlaceStatsModal` |
| DCL Builder land analytics | Independent; 7-day owner stats still useful |
| Forge analytics (`analytics-creator.json`, quests) | Separate lane — do not merge v1 |

---

## 14. Success criteria (MVP)

**Data (Phase 1):** for a given `place_key` over 7 days we can compute:

1. Landing views and unique visitors  
2. Jump-in clicks and successful `scene_enter` counts + rates  
3. Median time on scene  
4. Unique vs multi-visit players (anon)  
5. Guest vs wallet split  
6. Top `/goto` destinations **from** that place  

**Product (Phase 2):**

7. Any visitor on the landing page can open stats via the bar-chart control (no login).  
8. Modal shows summary numbers + a simple 7-day bar chart for that place.  
9. Owner settings gear behavior unchanged.  

No Privy MAU growth from this path.

---

## 15. Open decisions (before / during Phase 1)

1. **Ingest host:** Supabase Edge Function only vs droplet Node → Supabase (matches current nginx style).  
2. ~~**Creator auth v1**~~ → **Decided:** public read; no creator auth for landing stats.  
3. **Multi-visit definition:** ≥2 play sessions vs ≥2 calendar days.  
4. ~~**Default product surface**~~ → **Decided:** **public panel on scene landing** (bar chart next to settings).  
5. **Prod default:** analytics on by default in prod builds vs explicit enable forever.  
6. **Hide stats icon when zero data?** Show always with empty state vs hide until first event.  
7. **Summary freshness:** near-real-time vs hourly rollups only.

Record further decisions here when made.

---

## 16. Event checklist (quick reference)

**Must have (Phase 1)**

- [ ] `login`  
- [ ] `landing_view`  
- [ ] `jump_in_click`  
- [ ] `scene_load_start`  
- [ ] `scene_load_fail`  
- [ ] `scene_enter`  
- [ ] `heartbeat`  
- [ ] `scene_leave`  
- [ ] `goto`  
- [ ] `navigate`  

**Should have (Phase 2–3)**

- [ ] `logout`  
- [ ] `auth_gate_show` / `auth_gate_complete`  
- [ ] `scene_ban`  
- [ ] `landing_chat_ready`  
- [ ] `landing_cast_live`  
- [ ] `shell_view`  
- [ ] `source` fully wired  
- [ ] `stats_panel_open` / `stats_panel_close`  

**UI (Phase 2)**

- [ ] Landing bar-chart button next to settings (`data-scene-stats`)  
- [ ] `ScenePlaceStatsModal` public aggregates + 7d bars  

**Won’t have (v1)**

- Position samples, chat content, Forge quest events, Privy for all visitors  
- Private creator-only dashboard (public landing stats instead)  
- Wallet-gated view of place stats  

---

*Last updated: public landing stats panel decision (`feat/supabase-creator-analytics`).*
