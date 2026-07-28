/**
 * Admin Tools Stream / Video URL / DCL Cast panels only expand when
 * `AdminTools.videoControl.videoPlayers` has linked screens.
 *
 * Creator Hub stores links on the AdminTools component in main.composite.
 * Two common gaps:
 *  1. videoControl enabled but `videoPlayers: []` (never linked a screen)
 *  2. Multiple Admin Tools entities — asset-packs only reads the **first**
 *     `getEntitiesWith(AdminTools)` hit. A second "Admin Tools_2" can hold
 *     the real link while the first still has `videoPlayers: []` (seen on
 *     neat.dcl.eth: entity 512 empty, 514 → screen 513 "screen1").
 *
 * This system:
 *  - Copies non-empty videoPlayers from any sibling AdminTools onto empty ones
 *  - Else discovers `core::VideoPlayer` entities when every list is empty
 */
import type { Entity, IEngine, LastWriteWinElementSetComponentDefinition } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

const ADMIN_TOOLS_CANDIDATES = [
  'asset-packs::AdminTools',
  'asset-packs::AdminTools-v1',
  'asset-packs::AdminTools-v2',
  'asset-packs::AdminTools-v3'
] as const

type VideoPlayerLink = {
  entity: number
  customName: string
}

type AdminToolsVideoControl = {
  isEnabled?: boolean
  linkAllVideoPlayers?: boolean
  videoPlayers?: VideoPlayerLink[] | null
}

type AdminToolsValue = {
  videoControl?: AdminToolsVideoControl | null
}

const installed = new WeakSet<IEngine>()

function tryGetComponent(
  engine: IEngine,
  name: string
): LastWriteWinElementSetComponentDefinition<AdminToolsValue> | null {
  try {
    const c = engine.getComponent(name) as LastWriteWinElementSetComponentDefinition<AdminToolsValue>
    return c ?? null
  } catch {
    return null
  }
}

function resolveAdminTools(
  engine: IEngine
): LastWriteWinElementSetComponentDefinition<AdminToolsValue> | null {
  for (const name of ADMIN_TOOLS_CANDIDATES) {
    const c = tryGetComponent(engine, name)
    if (c) return c
  }
  const anyEngine = engine as IEngine & {
    components?: Iterable<{ componentName?: string; componentId?: number }>
  }
  try {
    const comps = anyEngine.components
    if (comps) {
      for (const c of comps) {
        const n = c?.componentName
        if (typeof n === 'string' && n.startsWith('asset-packs::AdminTools')) {
          const resolved = tryGetComponent(engine, n)
          if (resolved) return resolved
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

function listVideoPlayerEntities(engine: IEngine): Entity[] {
  const VideoPlayer = generated.VideoPlayer(engine)
  const out: Entity[] = []
  for (const [entity] of engine.getEntitiesWith(VideoPlayer)) {
    out.push(entity)
  }
  return out
}

function videoPlayersOf(vc: {
  videoPlayers?: readonly { entity: number; customName: string }[] | null
} | null | undefined): VideoPlayerLink[] {
  const list = vc?.videoPlayers
  if (!list || list.length === 0) return []
  return list.map((p) => ({ entity: p.entity, customName: p.customName }))
}

function needsFill(vc: {
  isEnabled?: boolean
  videoPlayers?: readonly { entity: number; customName: string }[] | null
} | null | undefined): boolean {
  if (!vc || vc.isEnabled === false) return false
  return videoPlayersOf(vc).length === 0
}

/**
 * Install once per scene engine. Idempotent.
 * Returns true if the hook was newly installed.
 */
export function installAdminToolsVideoPlayerAutoLink(engine: IEngine): boolean {
  if (installed.has(engine)) return false
  installed.add(engine)

  let linked = false
  let frames = 0
  const maxFrames = 60 * 45 // ~45s at 60fps

  engine.addSystem(function adminToolsVideoPlayerAutoLinkSystem() {
    if (linked) return
    frames++
    if (frames > maxFrames) {
      linked = true
      return
    }
    // Throttle after first second — AdminTools often appears after first CRDT tick.
    if (frames > 60 && frames % 30 !== 0) return

    const AdminTools = resolveAdminTools(engine)
    if (!AdminTools) return

    const rows = Array.from(engine.getEntitiesWith(AdminTools))
    if (rows.length === 0) return

    // Prefer authoring links already on any AdminTools (e.g. Admin Tools_2).
    let donor: VideoPlayerLink[] = []
    for (const [, value] of rows) {
      const links = videoPlayersOf(value?.videoControl)
      if (links.length > 0) {
        donor = links
        break
      }
    }

    if (donor.length === 0) {
      const players = listVideoPlayerEntities(engine)
      if (players.length === 0) return
      donor = players.map((e, i) => ({
        entity: e as number,
        customName: players.length === 1 ? 'Screen' : `Screen ${i + 1}`
      }))
    }

    let any = false
    for (const [entity, value] of rows) {
      if (!needsFill(value?.videoControl)) continue
      try {
        const mutable = AdminTools.getMutable(entity)
        if (!mutable.videoControl || !needsFill(mutable.videoControl)) continue
        mutable.videoControl.videoPlayers = donor.map((p) => ({ ...p }))
        any = true
        console.log(
          `[admin-tools] filled empty videoPlayers on AdminTools entity ${entity as number} ← ${donor.length} screen(s) (${donor.map((d) => d.customName).join(', ')})`
        )
      } catch (err) {
        console.warn(
          '[admin-tools] fill videoPlayers failed',
          err instanceof Error ? err.message : String(err)
        )
      }
    }

    if (any) linked = true
  })

  return true
}
