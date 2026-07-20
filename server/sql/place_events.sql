-- Supabase / Postgres schema for place analytics (optional mirror of JSONL).
-- Run in Supabase SQL editor. Client never talks to this table directly.

create table if not exists public.place_events (
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

  props jsonb not null default '{}'::jsonb
);

create index if not exists place_events_place_at_idx on public.place_events (place_key, at desc);
create index if not exists place_events_event_at_idx on public.place_events (event, at desc);
create index if not exists place_events_visitor_at_idx on public.place_events (visitor_id, at desc);
create index if not exists place_events_play_session_idx on public.place_events (play_session_id)
  where play_session_id is not null;

alter table public.place_events enable row level security;

-- No public policies: only service_role (bypasses RLS) inserts via server.
