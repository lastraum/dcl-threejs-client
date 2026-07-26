export type PhysxColliderDebugOptions = {
  /** ECS MeshCollider primitives (box/sphere/cylinder). */
  sceneMeshColliders: boolean
  /** GLTF cooked hulls + live `_collider` source mesh tint. */
  gltfColliders: boolean
  /**
   * When GLTF colliders are on: solid filled volumes (true) vs wireframe (false).
   * Solid + source tint is deeper than wireframe alone for locating hulls.
   */
  gltfColliderSolids: boolean
  /** Local player PhysX capsule ("pill"). */
  localPlayerCapsule: boolean
  /** Log staticColliderCount + nearest sweep hit each second. */
  collidersPhys: boolean
  /** Runtime world-baked pose-drift recook (off by default — boot + Help manual recook still run). */
  runtimeRecook: boolean
}

type Listener = (options: PhysxColliderDebugOptions) => void

function readUrlDefault(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('colliders')
}

function readCollidersPhysDefault(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('collidersphys')
}

function readRuntimeRecookDefault(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('colliderrecook')
}

function readSolidDefault(): boolean {
  if (typeof window === 'undefined') return false
  // ?colliders=solid or ?collidersolid
  const sp = new URLSearchParams(window.location.search)
  if (sp.has('collidersolid')) return true
  return sp.get('colliders') === 'solid'
}

const urlDefault = readUrlDefault()
const collidersPhysDefault = readCollidersPhysDefault()
const runtimeRecookDefault = readRuntimeRecookDefault()
const solidDefault = readSolidDefault()

const DEFAULT_OPTIONS: PhysxColliderDebugOptions = {
  sceneMeshColliders: urlDefault,
  gltfColliders: urlDefault || solidDefault,
  gltfColliderSolids: solidDefault || urlDefault,
  localPlayerCapsule: urlDefault,
  collidersPhys: collidersPhysDefault,
  runtimeRecook: runtimeRecookDefault
}

/** Shared toggles for PhysX collider debug (Help debug panel + `?colliders` / `?collidersolid`). */
class PhysxColliderDebugStore {
  private options: PhysxColliderDebugOptions = { ...DEFAULT_OPTIONS }
  private readonly listeners = new Set<Listener>()

  getOptions(): PhysxColliderDebugOptions {
    return { ...this.options }
  }

  setOptions(partial: Partial<PhysxColliderDebugOptions>): void {
    const next = { ...this.options, ...partial }
    if (optionsEqual(next, this.options)) return
    this.options = next
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getOptions())
    return () => {
      this.listeners.delete(listener)
    }
  }

  isSceneMeshCollidersVisible(): boolean {
    return this.options.sceneMeshColliders
  }

  isGltfCollidersVisible(): boolean {
    return this.options.gltfColliders
  }

  /** Solid filled cooked hulls (vs wireframe). Default on when GLTF debug is on. */
  isGltfColliderSolids(): boolean {
    return this.options.gltfColliderSolids
  }

  isLocalPlayerCapsuleVisible(): boolean {
    return this.options.localPlayerCapsule
  }

  isCollidersPhysEnabled(): boolean {
    return this.options.collidersPhys
  }

  isRuntimeRecookEnabled(): boolean {
    return this.options.runtimeRecook
  }

  private notify(): void {
    const snapshot = this.getOptions()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function optionsEqual(a: PhysxColliderDebugOptions, b: PhysxColliderDebugOptions): boolean {
  return (
    a.sceneMeshColliders === b.sceneMeshColliders &&
    a.gltfColliders === b.gltfColliders &&
    a.gltfColliderSolids === b.gltfColliderSolids &&
    a.localPlayerCapsule === b.localPlayerCapsule &&
    a.collidersPhys === b.collidersPhys &&
    a.runtimeRecook === b.runtimeRecook
  )
}

export const physxColliderDebug = new PhysxColliderDebugStore()
