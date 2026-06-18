/**
 * Community integration status — single machine-readable registry.
 * Human doc mirror: docs/INTEGRATION.md (keep in sync when adding entries).
 */

import {
  DCL_ECS_COMPONENTS,
  type ComponentStatus,
  type EcsComponentEntry
} from '../../dcl/ecs/registry'

export type IntegrationStatus = ComponentStatus

/** Statuses shown as parity gaps in the dev panel Community tab. */
export const PARITY_GAP_STATUSES: IntegrationStatus[] = ['none', 'stub', 'partial']

export type IntegrationEntry = {
  id: string
  name: string
  status: IntegrationStatus
  category: string
  phase?: number | string
  notes?: string
}

export type IntegrationCategory = {
  id: string
  title: string
  description?: string
  entries: IntegrationEntry[]
}

function ecsToIntegration(c: EcsComponentEntry): IntegrationEntry {
  return {
    id: `ecs:${c.name}`,
    name: c.name,
    status: c.status,
    category: 'ecs',
    phase: c.phase,
    notes: c.coreId !== undefined ? `ID ${c.coreId}` : undefined
  }
}

/** In-scene ECS components — full list from @dcl/sdk7 (see docs/INTEGRATION.md). */
export const ECS_INTEGRATION: IntegrationEntry[] = DCL_ECS_COMPONENTS.map(ecsToIntegration)

/** Browser DOM HUD, settings overlay, splash — not in-scene UiTransform ECS. */
export const CLIENT_UI_INTEGRATION: IntegrationEntry[] = [
  { id: 'ui:splash-login', name: 'Splash / login', status: 'render', category: 'client-ui', notes: 'Catalyst + wallet session' },
  { id: 'ui:loading-screen', name: 'Loading screen + hydration timer', status: 'render', category: 'client-ui', notes: 'Count-up elapsed, attach stall timeout' },
  { id: 'ui:sidebar-shell', name: 'Sidebar shell + responsive layout', status: 'render', category: 'client-ui', notes: 'ClientUiLayout CSS tokens' },
  { id: 'ui:chat-panel', name: 'Scene chat panel', status: 'render', category: 'client-ui', notes: 'LiveKit RFC4, unread badge, nav links → teleport' },
  { id: 'ui:emote-wheel', name: 'Emote wheel (B)', status: 'render', category: 'client-ui', notes: 'Profile + bundled emotes' },
  { id: 'ui:minimap', name: 'Minimap', status: 'render', category: 'client-ui', notes: 'Scene parcels only' },
  { id: 'ui:world-location-card', name: 'World location card', status: 'render', category: 'client-ui' },
  { id: 'ui:debug-panel', name: 'Debug panel (Help)', status: 'render', category: 'client-ui', notes: 'Position HUD, collider toggles, render quality' },
  { id: 'ui:dev-progress', name: 'Dev progress panel (</>)', status: 'render', category: 'client-ui', notes: 'Community claims + parity gaps + PROGRESS.md from GitHub' },
  { id: 'ui:settings-events', name: 'Settings → Events (X)', status: 'render', category: 'client-ui', notes: 'DCL Events API, weekly/calendar' },
  { id: 'ui:settings-map', name: 'Settings → Map (M)', status: 'render', category: 'client-ui', notes: 'Genesis tiles, peers, Jump In' },
  { id: 'ui:settings-backpack', name: 'Settings → Backpack (I)', status: 'render', category: 'client-ui', notes: 'Avatar preview, equipped wearables' },
  { id: 'ui:preferences-panel', name: 'Preferences panel (P / ⚙)', status: 'render', category: 'client-ui', notes: 'Right rail; world input passes through' },
  { id: 'ui:preferences-graphics', name: 'Preferences → Graphics', status: 'partial', category: 'client-ui', notes: 'Sun/moon light + exposure sliders live; MSAA/bloom stubs' },
  { id: 'ui:preferences-sounds', name: 'Preferences → Sounds', status: 'none', category: 'client-ui', notes: 'Coming soon placeholder' },
  { id: 'ui:preferences-controls', name: 'Preferences → Controls', status: 'none', category: 'client-ui', notes: 'Coming soon placeholder' },
  { id: 'ui:preferences-chat', name: 'Preferences → Chat', status: 'none', category: 'client-ui', notes: 'Coming soon placeholder' },
  { id: 'ui:settings-places', name: 'Settings → Places', status: 'none', category: 'client-ui', notes: 'Placeholder tab' },
  { id: 'ui:settings-communities', name: 'Settings → Communities', status: 'none', category: 'client-ui', notes: 'Placeholder tab' },
  { id: 'ui:settings-gallery', name: 'Settings → Gallery', status: 'none', category: 'client-ui', notes: 'Placeholder tab' },
  { id: 'ui:ecs-scene-ui', name: 'In-scene ECS UI (UiTransform…)', status: 'none', category: 'client-ui', notes: 'React/canvas scene UI — separate from HUD' },
  { id: 'ui:voice-ui', name: 'Voice / mic UI', status: 'none', category: 'client-ui', notes: 'LiveKit audio tracks not exposed in HUD yet' }
]

/** Comms, content, identity — explorer shell (frozen during renderer re-arch). */
export const NETWORKING_INTEGRATION: IntegrationEntry[] = [
  { id: 'net:rfc4-movement', name: 'RFC4 movement (in/out)', status: 'render', category: 'networking', notes: 'Movement + MovementCompressed, Bevy/Unity wire parity' },
  { id: 'net:rfc4-profile', name: 'RFC4 profile request/response', status: 'render', category: 'networking' },
  { id: 'net:rfc4-emote', name: 'RFC4 PlayerEmote + DLE chat fallback', status: 'render', category: 'networking', notes: 'Unity emotes via DLE chat text parsed inbound' },
  { id: 'net:rfc4-chat', name: 'RFC4 scene chat (LiveKit)', status: 'render', category: 'networking', notes: 'encodeRfc4ChatPacket companion path' },
  { id: 'net:livekit-scene', name: 'LiveKit scene room', status: 'render', category: 'networking' },
  { id: 'net:livekit-world', name: 'LiveKit world room', status: 'render', category: 'networking' },
  { id: 'net:livekit-island', name: 'LiveKit island / archipelago', status: 'render', category: 'networking' },
  { id: 'net:remote-avatars', name: 'Remote avatar load + lerp', status: 'render', category: 'networking', notes: 'RemoteAvatarManager + load queue' },
  { id: 'net:scene-binary', name: 'RFC4 Scene binary packets', status: 'render', category: 'networking', notes: 'comms topic → scene script' },
  { id: 'net:archipelago', name: 'Archipelago adapter', status: 'stub', category: 'networking', notes: 'Scaffold; LiveKit primary path' },
  { id: 'net:voice-tracks', name: 'Voice tracks (WebRTC)', status: 'none', category: 'networking', notes: 'LiveKit connected; no spatial voice UI' },
  { id: 'net:signed-fetch', name: 'SignedFetch (ADR-44)', status: 'render', category: 'networking', notes: 'Worker RPC → main thread' },
  { id: 'net:catalyst-content', name: 'Catalyst content resolution', status: 'render', category: 'networking' },
  { id: 'net:wallet-session', name: 'Wallet / Catalyst session', status: 'render', category: 'networking' },
  { id: 'net:realm-comms-adapter', name: 'Realm comms adapter discovery', status: 'render', category: 'networking' },
  { id: 'net:ecs-network-entity', name: 'ECS NetworkEntity sync (scene)', status: 'stub', category: 'networking', notes: 'Projection decode + parent strip only' }
]

/** Rendering, physics, load — performance-related systems. */
export const PERFORMANCE_INTEGRATION: IntegrationEntry[] = [
  { id: 'perf:crdt-projection', name: 'CRDT projection + diff consumer', status: 'render', category: 'performance', notes: 'No second main-thread ECS engine' },
  { id: 'perf:entity-store-p4', name: 'EntityStore (Phase 4)', status: 'render', category: 'performance', notes: 'Scene graph + remote avatars in store; mesh attach in ThreeBridge' },
  { id: 'perf:pointer-cache', name: 'PointerEvents cache + throttled raycast', status: 'render', category: 'performance', notes: 'Genesis ~70–110 fps fix' },
  { id: 'perf:light-culling', name: 'LightManager culling + tiers', status: 'render', category: 'performance', notes: '40 m cull, 4/6/10 caps' },
  { id: 'perf:genesis-clouds', name: 'Genesis skybox cloud lighting', status: 'render', category: 'performance', notes: 'HDR tint + screen blend, white midday puffs' },
  { id: 'perf:scene-emissives', name: 'Scene GLTF emissive LEDs', status: 'partial', category: 'performance', notes: 'DCL color×intensity; LightLED parity decent' },
  { id: 'perf:user-lighting', name: 'User sun/moon + exposure sliders', status: 'render', category: 'performance', notes: 'SunEnvironmentSettings localStorage' },
  { id: 'perf:gltf-hydration-budget', name: 'GLTF hydration budgets', status: 'render', category: 'performance' },
  { id: 'perf:glb-parse-pool', name: 'Off-thread GLB parse pool', status: 'render', category: 'performance' },
  { id: 'perf:asset-cache-idb', name: 'AssetCache + IndexedDB bytes', status: 'render', category: 'performance' },
  { id: 'perf:physx-lazy', name: 'Lazy PhysX WASM load', status: 'render', category: 'performance' },
  { id: 'perf:collider-prewarm', name: 'Collision prewarm gate', status: 'render', category: 'performance', notes: 'Colliders ready before world.start()' },
  { id: 'perf:hyperfy-colliders', name: 'GLTF collider grouped actors', status: 'render', category: 'performance', notes: 'Pose-only sync for movers' },
  { id: 'perf:player-idle-skip', name: 'Idle player physics skip', status: 'render', category: 'performance' },
  { id: 'perf:instancing', name: 'GLTF InstancedMesh path', status: 'none', category: 'performance', notes: 'Phase 6 re-arch' },
  { id: 'perf:shadow-pass', name: 'Shadow pass tuning', status: 'partial', category: 'performance', notes: 'e10 deferred' },
  { id: 'perf:full-resync-interval', name: 'Periodic ThreeBridge full resync', status: 'partial', category: 'performance', notes: 'Safety net; tune in e10' },
  { id: 'perf:avatar-attach', name: 'AvatarAttach (Tier B parity)', status: 'render', category: 'performance', notes: 'Bone sampling + worker Transform batch; attach wins over Tween' }
]

/** Scene worker ~system/* stubs — not ECS components. */
export const SYSTEM_MODULES_INTEGRATION: IntegrationEntry[] = [
  { id: 'sys:engine-api', name: '~system/EngineApi', status: 'render', category: 'system-modules', phase: 1, notes: 'CRDT + sendBatch/subscribe (comms)' },
  { id: 'sys:runtime', name: '~system/Runtime', status: 'render', category: 'system-modules', phase: 1 },
  { id: 'sys:restricted-actions', name: '~system/RestrictedActions', status: 'partial', category: 'system-modules', phase: 2, notes: 'movePlayerTo, triggerEmote, openExternalUrl ✅' },
  { id: 'sys:comms-controller', name: '~system/CommunicationsController', status: 'render', category: 'system-modules', phase: 5 },
  { id: 'sys:user-identity', name: '~system/UserIdentity', status: 'render', category: 'system-modules', phase: 5 },
  { id: 'sys:comms-api', name: '~system/CommsApi', status: 'partial', category: 'system-modules', phase: 5, notes: 'topics ✅ · getActiveVideoStreams ⬜' },
  { id: 'sys:signed-fetch', name: '~system/SignedFetch', status: 'render', category: 'system-modules', phase: 3 },
  { id: 'sys:environment-api', name: '~system/EnvironmentApi', status: 'none', category: 'system-modules', phase: 1 },
  { id: 'sys:testing', name: '~system/Testing', status: 'none', category: 'system-modules' }
]

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  {
    id: 'ecs',
    title: 'ECS components',
    description: 'All SDK7 components registered in mirrorComponents / CrdtProjection.',
    entries: ECS_INTEGRATION
  },
  {
    id: 'client-ui',
    title: 'Client UI & settings',
    description: 'Browser HUD and settings overlay — not in-scene UiTransform.',
    entries: CLIENT_UI_INTEGRATION
  },
  {
    id: 'networking',
    title: 'Networking & social',
    description: 'LiveKit, RFC4, Catalyst, avatars, content.',
    entries: NETWORKING_INTEGRATION
  },
  {
    id: 'performance',
    title: 'Performance & rendering',
    description: 'Load, culling, re-arch pipeline, physics cook.',
    entries: PERFORMANCE_INTEGRATION
  },
  {
    id: 'system-modules',
    title: '~system modules',
    description: 'Scene worker shim modules (require from bin/*.js).',
    entries: SYSTEM_MODULES_INTEGRATION
  }
]

export const ALL_INTEGRATION_ENTRIES: IntegrationEntry[] = INTEGRATION_CATEGORIES.flatMap((c) => c.entries)

export function countIntegrationByStatus(entries: IntegrationEntry[]): Record<IntegrationStatus, number> {
  const counts: Record<IntegrationStatus, number> = {
    none: 0,
    stub: 0,
    partial: 0,
    render: 0,
    'client-only': 0
  }
  for (const e of entries) {
    counts[e.status] = (counts[e.status] ?? 0) + 1
  }
  return counts
}

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  none: '⬜ Not started',
  stub: '🟡 Stub / partial',
  partial: '🟡 Partial',
  render: '🟢 Done',
  'client-only': '🔵 Client-only'
}
