export type PhysxColliderDebugOptions = {
  /** ECS MeshCollider primitives (box/sphere/cylinder). */
  sceneMeshColliders: boolean
  /** GLTF meshes named `_collider*`. */
  gltfColliders: boolean
  /** Local player PhysX capsule ("pill"). */
  localPlayerCapsule: boolean
  /** Log staticColliderCount + nearest sweep hit each second. */
  collidersPhys: boolean
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

const urlDefault = readUrlDefault()
const collidersPhysDefault = readCollidersPhysDefault()

const DEFAULT_OPTIONS: PhysxColliderDebugOptions = {
  sceneMeshColliders: urlDefault,
  gltfColliders: urlDefault,
  localPlayerCapsule: urlDefault,
  collidersPhys: collidersPhysDefault
}

/** Shared toggles for PhysX collider debug wireframes (Help debug panel + `?colliders`). */
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

  isLocalPlayerCapsuleVisible(): boolean {
    return this.options.localPlayerCapsule
  }

  isCollidersPhysEnabled(): boolean {
    return this.options.collidersPhys
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
    a.localPlayerCapsule === b.localPlayerCapsule &&
    a.collidersPhys === b.collidersPhys
  )
}

export const physxColliderDebug = new PhysxColliderDebugStore()
