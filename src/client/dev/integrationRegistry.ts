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

/** Browser DOM HUD, settings overlay, loading — not in-scene UiTransform ECS. */
export const CLIENT_UI_INTEGRATION: IntegrationEntry[] = [
  {
    id: 'ui:explorer-auth',
    name: 'Explorer auth sheet',
    status: 'render',
    category: 'client-ui',
    notes: 'Inline wallet/guest sign-in; session resume via resolveInitialLogin (no full-screen splash)'
  },
  {
    id: 'ui:loading-screen',
    name: 'Loading screen + hydration timer',
    status: 'render',
    category: 'client-ui',
    notes: 'In-play teleports / non-landing 3D entry; landing Jump in uses SceneLandingView progress'
  },
  { id: 'ui:sidebar-shell', name: 'Sidebar shell + responsive layout', status: 'render', category: 'client-ui', notes: 'ClientUiLayout CSS tokens' },
  { id: 'ui:chat-panel', name: 'Scene chat panel (3D)', status: 'render', category: 'client-ui', notes: 'LiveKit RFC4, unread badge, people count → inline roster, nav links → teleport, DCM v1 inline images' },
  {
    id: 'ui:social-chat-dock',
    name: '2D social chat dock (multi-room)',
    status: 'render',
    category: 'client-ui',
    notes:
      'Bottom-right FAB expand/collapse; restore last thread/list; SceneChatRoomPool multi-room; × on Explore only (not current landing); idle empty centered text; guest OK'
  },
  {
    id: 'ui:community-hud-toasts',
    name: 'Community HUD toasts',
    status: 'render',
    category: 'client-ui',
    notes: 'Top-center in-world; posts poll + Social WS voice updates; companion-aligned copy; toast → join voice'
  },
  {
    id: 'ui:landing-cast',
    name: 'Landing Join Live / cast stage',
    status: 'render',
    category: 'client-ui',
    notes: 'Stream keys + remote video; guest watch; mute toggle; stream-end → scene details; mobile LIVE above Jump in'
  },
  { id: 'ui:profile-pill', name: 'Profile / name pills + menu', status: 'render', category: 'client-ui', notes: 'Hover, badges row, right-click profile modal' },
  {
    id: 'ui:name-tags',
    name: 'Overhead name tags',
    status: 'render',
    category: 'client-ui',
    notes: 'CSS2D pills; hide via scene.json featureToggles.nameTags or ?nameTags=disabled'
  },
  { id: 'ui:emote-wheel', name: 'Emote wheel (B)', status: 'render', category: 'client-ui', notes: 'Profile + bundled emotes' },
  { id: 'ui:location-card', name: 'Location card', status: 'render', category: 'client-ui', notes: 'Top-left pill — scene name + Genesis parcel coords; width matches minimap when present' },
  {
    id: 'ui:minimap',
    name: 'Circular Genesis minimap',
    status: 'render',
    category: 'client-ui',
    notes: 'Parcel HUD: lod-0/3 satellite circle under pill; click → embedded Map panel centered on player; worlds hide'
  },
  { id: 'ui:debug-panel', name: 'Debug panel (Help)', status: 'render', category: 'client-ui', notes: 'Position HUD, collider toggles, render quality' },
  { id: 'ui:dev-progress', name: 'Dev progress panel (</>)', status: 'render', category: 'client-ui', notes: 'Community claims + parity gaps + PROGRESS.md from GitHub' },
  { id: 'ui:settings-events', name: 'Settings → Events (X)', status: 'render', category: 'client-ui', notes: 'DCL Events API, weekly/calendar' },
  { id: 'ui:settings-map', name: 'Settings → Map (M)', status: 'render', category: 'client-ui', notes: 'Genesis tiles, peers, Jump In; embedded mode hides page HUD when opened from minimap/shell' },
  { id: 'ui:settings-backpack', name: 'Settings → Backpack (I)', status: 'render', category: 'client-ui', notes: 'Avatar preview, equipped wearables' },
  { id: 'ui:preferences-panel', name: 'Preferences panel (P / ⚙)', status: 'render', category: 'client-ui', notes: 'Right rail; world input passes through' },
  { id: 'ui:preferences-graphics', name: 'Preferences → Graphics', status: 'partial', category: 'client-ui', notes: 'Preset L/M/H/Custom, shadows, lights, res scale, FPS, MSAA, FOV, lighting live; VSync hidden; Resolution/Fullscreen stub; bloom/HDR/distance stubs' },
  { id: 'ui:preferences-sounds', name: 'Preferences → Sounds', status: 'render', category: 'client-ui', notes: 'Volume sliders; mic device; PTT vs open-mic; mute-in-background wired to VoiceChatService' },
  { id: 'ui:preferences-controls', name: 'Preferences → Controls', status: 'partial', category: 'client-ui', notes: 'Mouse sensitivity live (10–200%); keybinds still pending' },
  { id: 'ui:preferences-chat', name: 'Preferences → Chat', status: 'none', category: 'client-ui', notes: 'Coming soon placeholder' },
  { id: 'ui:settings-places', name: 'Settings → Places', status: 'render', category: 'client-ui', notes: 'Explore tab — Places + Worlds APIs, category filters, Jump In' },
  {
    id: 'ui:settings-communities',
    name: 'Settings → Communities',
    status: 'render',
    category: 'client-ui',
    notes:
      'Browse + modal; announce/start-voice owner|mod|admin; voice join/end-all; community chat opens SocialChatDock; ADR-208 group text'
  },
  { id: 'ui:settings-gallery', name: 'Settings → Gallery', status: 'render', category: 'client-ui', notes: 'Camera Reel API, month grid, Share on X → reels.decentraland.org' },
  {
    id: 'ui:ecs-scene-ui',
    name: 'In-scene ECS UI (UiTransform…)',
    status: 'partial',
    category: 'client-ui',
    notes:
      'Yoga + DOM · hit-map from layoutBoxes+layoutToScreen · nine-slice border-image (HTTP OK, natural size) · UiInput/UiDropdown writeback · uvs/text-measure polish remain'
  },
  { id: 'ui:voice-ui', name: 'Voice / mic UI', status: 'render', category: 'client-ui', notes: 'Explorer NEARBY VOICE: Hear others + Speak + hold T; mute-in-bg; name-tag bars; 3D PositionalAudio falloff' }
]

/** Comms, content, identity — explorer shell (frozen during renderer re-arch). */
export const NETWORKING_INTEGRATION: IntegrationEntry[] = [
  { id: 'net:rfc4-movement', name: 'RFC4 movement (in/out)', status: 'render', category: 'networking', notes: 'Movement + MovementCompressed, Bevy/Unity wire parity' },
  { id: 'net:rfc4-profile', name: 'RFC4 profile request/response', status: 'render', category: 'networking' },
  { id: 'net:rfc4-emote', name: 'RFC4 PlayerEmote + DLE chat fallback', status: 'render', category: 'networking', notes: 'Unity emotes via DLE chat text parsed inbound' },
  { id: 'net:rfc4-chat', name: 'RFC4 scene chat (LiveKit)', status: 'render', category: 'networking', notes: 'Text chat + DCM v1 inline images (dcl.chat.media)' },
  { id: 'net:dcm-chat-media', name: 'DCM v1 chat images', status: 'render', category: 'networking', notes: 'Chunked scene packets, drag-drop, GIF/WebP/JPEG < 1 MiB' },
  { id: 'net:livekit-scene', name: 'LiveKit scene room', status: 'render', category: 'networking' },
  { id: 'net:livekit-world', name: 'LiveKit world room', status: 'render', category: 'networking' },
  { id: 'net:livekit-island', name: 'LiveKit island / archipelago', status: 'render', category: 'networking' },
  {
    id: 'net:multi-room-chat-pool',
    name: 'Multi-room LiveKit chat pool',
    status: 'render',
    category: 'networking',
    notes: 'SceneChatRoomPool + resolveSceneChatAdapter — companion multi-text-chats; primary room for cast'
  },
  { id: 'net:remote-avatars', name: 'Remote avatar load + lerp', status: 'render', category: 'networking', notes: 'RemoteAvatarManager + load queue' },
  {
    id: 'net:double-jump-twirl',
    name: 'Double-jump twirl (DCL/VRM/ODK)',
    status: 'render',
    category: 'networking',
    notes: 'Shared DoubleJumpTwirl clockwise Y spin + jump pose; optional double_jump.glb for DCL'
  },
  { id: 'net:scene-binary', name: 'RFC4 Scene binary packets', status: 'render', category: 'networking', notes: 'comms topic → scene script' },
  { id: 'net:archipelago', name: 'Archipelago adapter', status: 'stub', category: 'networking', notes: 'Scaffold; LiveKit primary path' },
  { id: 'net:voice-tracks', name: 'Voice tracks (WebRTC)', status: 'render', category: 'networking', notes: 'LiveKit mic: worlds=world room; parcels=island+scene; spatial PositionalAudio on peer avatars; archipelago genesis Z; handoff keepLiveKit' },
  { id: 'net:signed-fetch', name: 'SignedFetch (ADR-44)', status: 'render', category: 'networking', notes: 'Worker RPC → main thread' },
  { id: 'net:catalyst-content', name: 'Catalyst content resolution', status: 'render', category: 'networking' },
  { id: 'net:wallet-session', name: 'Wallet / Catalyst session', status: 'render', category: 'networking' },
  { id: 'net:realm-comms-adapter', name: 'Realm comms adapter discovery', status: 'render', category: 'networking' },
  {
    id: 'net:ecs-network-entity',
    name: 'ECS NetworkEntity sync (scene)',
    status: 'render',
    category: 'networking',
    notes: 'P0–P3: wire unwrap, directed LiveKit, RealmInfo REQ, typed NE/NP parent resolve'
  }
]

/** Rendering, physics, load — performance-related systems. */
export const PERFORMANCE_INTEGRATION: IntegrationEntry[] = [
  { id: 'perf:crdt-projection', name: 'CRDT projection + diff consumer', status: 'render', category: 'performance', notes: 'No second main-thread ECS engine' },
  { id: 'perf:entity-store-p4', name: 'EntityStore (Phase 4)', status: 'render', category: 'performance', notes: 'Scene graph + remote avatars in store; mesh attach in ThreeBridge' },
  { id: 'perf:pointer-cache', name: 'PointerEvents cache + throttled raycast', status: 'render', category: 'performance', notes: 'Genesis ~70–110 fps fix' },
  { id: 'perf:light-culling', name: 'LightManager culling + tiers', status: 'render', category: 'performance', notes: '40 m cull, 4/6/10 caps' },
  { id: 'perf:genesis-clouds', name: 'Genesis skybox cloud lighting', status: 'render', category: 'performance', notes: 'Camera-centered dome rays + HDR cloud tint; low-tier worker timing' },
  { id: 'perf:low-end-scene-worker', name: 'Low-end scene worker timing', status: 'render', category: 'performance', notes: 'Tier detection, adaptive abort backoff, single-flight onUpdate' },
  { id: 'perf:boot-hydration', name: 'Boot + hydration pipeline', status: 'render', category: 'performance', notes: 'main.crdt seed, composite preload, unified GLB bytes/parse pool' },
  { id: 'perf:scene-emissives', name: 'Scene GLTF emissive LEDs', status: 'partial', category: 'performance', notes: 'DCL color×intensity; LightLED parity decent' },
  { id: 'perf:user-lighting', name: 'User sun/moon + exposure sliders', status: 'render', category: 'performance', notes: 'SunEnvironmentSettings localStorage' },
  { id: 'perf:gltf-hydration-budget', name: 'GLTF hydration budgets', status: 'render', category: 'performance' },
  { id: 'perf:glb-parse-pool', name: 'Off-thread GLB parse pool', status: 'render', category: 'performance' },
  { id: 'perf:asset-cache-idb', name: 'AssetCache + IndexedDB bytes', status: 'render', category: 'performance' },
  { id: 'perf:physx-lazy', name: 'Lazy PhysX WASM load', status: 'render', category: 'performance' },
  { id: 'perf:collider-prewarm', name: 'Collision prewarm gate', status: 'render', category: 'performance', notes: 'Colliders ready before world.start()' },
  {
    id: 'perf:spawn-floor-settle',
    name: 'Elevated spawn floor settle',
    status: 'render',
    category: 'performance',
    notes:
      'waitForSpawnFloorReady + settleSpawnOntoFloor; PE stage before script; preferNearY probe; reject roof false-grounds (Flagtag deck)'
  },
  { id: 'perf:hyperfy-colliders', name: 'GLTF collider grouped actors', status: 'render', category: 'performance', notes: 'Pose-only sync for movers' },
  { id: 'perf:player-idle-skip', name: 'Idle player physics skip', status: 'render', category: 'performance' },
  { id: 'perf:instancing', name: 'GLTF InstancedMesh path', status: 'none', category: 'performance', notes: 'Phase 6 re-arch' },
  { id: 'perf:shadow-pass', name: 'Shadow pass tuning', status: 'partial', category: 'performance', notes: 'e10 deferred' },
  { id: 'perf:full-resync-interval', name: 'Periodic ThreeBridge full resync', status: 'render', category: 'performance', notes: 'Removed — diff + EntityStore onChange only' },
  { id: 'perf:avatar-attach', name: 'AvatarAttach (Tier B parity)', status: 'render', category: 'performance', notes: 'Bone sampling + worker Transform batch; attach wins over Tween' }
]

/** Outdoor / world shell — landscapes, ocean, scatter (not ECS SkyboxTime). */
export const ENVIRONMENT_INTEGRATION: IntegrationEntry[] = [
  { id: 'env:genesis-sky', name: 'GenesisSky procedural dome', status: 'render', category: 'environment', notes: 'DclGenesisSky shader + cross cubemap clouds' },
  { id: 'env:landscape-parcels', name: 'Landscape parcel tiles', status: 'render', category: 'environment', notes: 'LandscapeSystem + TerrainModel' },
  {
    id: 'env:fft-ocean',
    name: 'FFT ocean water',
    status: 'render',
    category: 'environment',
    notes: 'FftOceanWater; scene.json environment.water; island/open ocean rings'
  },
  { id: 'env:perlin-scatter', name: 'Perlin scatter foliage', status: 'render', category: 'environment', notes: 'EzTreeGrassField + foliage wind' }
]

/** Scene worker ~system/* stubs — not ECS components. */
export const SYSTEM_MODULES_INTEGRATION: IntegrationEntry[] = [
  { id: 'sys:engine-api', name: '~system/EngineApi', status: 'render', category: 'system-modules', phase: 1, notes: 'CRDT + sendBatch/subscribe (comms)' },
  { id: 'sys:runtime', name: '~system/Runtime', status: 'render', category: 'system-modules', phase: 1 },
  { id: 'sys:restricted-actions', name: '~system/RestrictedActions', status: 'render', category: 'system-modules', phase: 2, notes: 'movePlayerTo, teleportTo, changeRealm, emotes, openExternalUrl, openNftDialog, copyToClipboard, setCommunicationsAdapter' },
  { id: 'sys:comms-controller', name: '~system/CommunicationsController', status: 'render', category: 'system-modules', phase: 5 },
  { id: 'sys:user-identity', name: '~system/UserIdentity', status: 'render', category: 'system-modules', phase: 5 },
  { id: 'sys:comms-api', name: '~system/CommsApi', status: 'render', category: 'system-modules', phase: 5, notes: 'getActiveVideoStreams + topics subscribe/publish/consume' },
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
    id: 'environment',
    title: 'World environment',
    description: 'Landscapes, ocean, procedural sky — outside scene ECS bundles.',
    entries: ENVIRONMENT_INTEGRATION
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
