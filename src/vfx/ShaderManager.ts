/**
 * Name a file, then the scene `tjs` component references that name.
 */
import * as THREE from 'three'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { dclToThreePos } from '../bridge/dclTransform'
import { getSceneAbilityVfxHost } from './SceneAbilityVfxHost'
import { isShaderSyncParam, parseNumber, parseVec3, shaderToVfxId } from './tjsVfxIds'
import { clearShaderWarmCache, isShaderWarmed, stampShaderWarmed } from './shaderWarmCache'

export type ShaderResolveUrl = (src: string) => string | null

export type ShaderCallCtx = {
  entity: number
  fn: string
  params: Record<string, string>
  origin: THREE.Vector3
  direction: THREE.Vector3
  distance: number
  node: THREE.Object3D | null
  /** Opt onto `d3js-ability-vfx`. Default false — local only. */
  sync?: boolean
  THREE?: typeof THREE
  scene?: THREE.Scene
}

export type ShaderModule = {
  onLoad?: (ctx: ShaderCallCtx) => void
  onStop?: (ctx: ShaderCallCtx) => void
  update?: (dt: number) => void
  dispose?: () => void
  [fn: string]:
    | ((ctx: ShaderCallCtx) => void)
    | ((dt: number, ctx: ShaderCallCtx) => void)
    | ((dt: number) => void)
    | undefined
}

/** What a scene shader file gets. No client spells — just Three.js and the world. */
export type ShaderApi = {
  THREE: typeof THREE
  scene: THREE.Scene
}

const LIFECYCLE = new Set(['update', 'dispose', 'onload', 'onstop'])

/** Path the scene names → the threejs-vfx module at that path. */
const VFX_FILES: Record<string, () => Promise<unknown>> = {
  'abilities/iceability.js': () => import('@vfx/abilities/IceAbility.js'),
  'abilities/meteorability.js': () => import('@vfx/abilities/MeteorAbility.js'),
  'abilities/frost/hailability.js': () => import('@vfx/abilities/frost/HailAbility.js')
}

/** Scene path or vfx path → loader key. `assets/shaders/IceAbility.js` → `abilities/iceability.js`. */
function normalizeVfxPath(src: string): string {
  let s = src.trim().replace(/\\/g, '/')
  s = s.replace(/^\.\//, '')
  s = s.replace(/^@vfx\//, '')
  s = s.replace(/^src\//, '')
  const leaf = (s.split('/').pop() ?? s).toLowerCase()
  if (leaf === 'hailability.js') return 'abilities/frost/hailability.js'
  if (leaf.endsWith('ability.js')) return `abilities/${leaf}`
  if (!s.includes('/')) s = `abilities/${s}`
  return s.toLowerCase()
}

function bindShaderExports(raw: Record<string, unknown>): ShaderModule | null {
  const out: ShaderModule = {}
  let fns = 0
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'default' || typeof value !== 'function') continue
    out[key] = value as ShaderModule[string]
    fns += 1
  }
  return fns > 0 ? out : null
}

/** Pose first (entity or explicit origin/direction/distance), then the file sees that. */
export function buildShaderCtx(
  entity: number,
  fn: string,
  params: Record<string, string>,
  node: THREE.Object3D | null
): ShaderCallCtx {
  const origin = new THREE.Vector3()
  const originDcl = params.origin ? parseVec3(params.origin) : null
  if (originDcl) dclToThreePos(originDcl.x, originDcl.y, originDcl.z, origin)
  else if (node) {
    node.getWorldPosition(origin)
    origin.y = 0
  }

  const direction = new THREE.Vector3(0, 0, 1)
  const dirDcl = params.direction ? parseVec3(params.direction) : null
  if (dirDcl) {
    dclToThreePos(dirDcl.x, dirDcl.y, dirDcl.z, direction)
    direction.y = 0
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1)
    else direction.normalize()
  } else if (node) {
    const q = new THREE.Quaternion()
    node.getWorldQuaternion(q)
    direction.set(0, 0, 1).applyQuaternion(q)
    direction.y = 0
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1)
    else direction.normalize()
  }

  const distance = parseNumber(params.distance ?? params.range ?? '') ?? 32
  return {
    entity,
    fn,
    params,
    origin,
    direction,
    distance,
    node,
    sync: isShaderSyncParam(params.sync)
  }
}

export class ShaderManager {
  private resolveUrl: ShaderResolveUrl | null = null
  private worldScene: THREE.Scene | null = null
  private readonly catalog = new Map<string, string>()
  private readonly loaded = new Map<string, Promise<ShaderModule | null>>()
  private readonly modules = new Map<string, ShaderModule>()
  private readonly blobs: string[] = []

  setResolveUrl(fn: ShaderResolveUrl | null): void {
    this.resolveUrl = fn
  }

  setScene(scene: THREE.Scene | null): void {
    this.worldScene = scene
  }

  /** Scene `tjs` component declares shaders — no bundle comment scan. */
  declare(name: string, src: string): void {
    const key = name.trim().toLowerCase()
    const path = src.trim()
    if (!key || !path) return
    const prev = this.catalog.get(key)
    if (prev === path) return
    this.catalog.set(key, path)
    // Same id+path already compiled this session (/reload / HMR) — keep the module.
    if (isShaderWarmed(key, path) && this.modules.has(key)) return
    this.loaded.delete(key)
    this.modules.delete(key)
    // Do not import AbilityManager / ice-cinder-hail here — first trigger loads.
  }

  async ensure(name: string): Promise<ShaderModule | null> {
    const key = name.trim().toLowerCase()
    const src = this.catalog.get(key)
    if (!src) return null
    let pending = this.loaded.get(key)
    if (!pending) {
      pending = this.load(key, src)
      this.loaded.set(key, pending)
    }
    return pending
  }

  trigger(name: string, fn: string, ctx: ShaderCallCtx): boolean {
    void this.fire(name, fn, ctx)
    return true
  }

  private async fire(name: string, fn: string, ctx: ShaderCallCtx): Promise<void> {
    if (await this.tryVfx(name, fn, ctx)) return
    const hit = await this.resolve(name, fn)
    if (hit) this.call(hit.mod, hit.fn, ctx)
  }

  private async tryVfx(name: string, fn: string, ctx: ShaderCallCtx): Promise<boolean> {
    const method = fn.trim().toLowerCase()
    if (LIFECYCLE.has(method)) return false
    // `tjs.ice.spawn(...)` → ability id is the name; spawn/cast is the method.
    const token =
      method === 'spawn' || method === 'cast' || method === 'play'
        ? name.trim() || fn
        : (fn || name).trim()
    if (!token) return false
    const id = shaderToVfxId(token)
    try {
      const { getAbility } = await import('@vfx/abilities/registry.js')
      if (!getAbility(id)) {
        clientDebugLog.log('scene', `shader tryVfx — no ability '${id}'`, {
          level: 'warn',
          alsoConsole: true
        })
        return false
      }
    } catch (err) {
      clientDebugLog.log(
        'scene',
        `shader tryVfx import failed — ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn', alsoConsole: true }
      )
      return false
    }
    const host = getSceneAbilityVfxHost()
    if (!host) {
      clientDebugLog.log('scene', `shader tryVfx — no VFX host for '${id}'`, {
        level: 'warn',
        alsoConsole: true
      })
      return false
    }
    host.cast(id, ctx.origin, ctx.direction, ctx.distance, { publish: ctx.sync === true })
    return true
  }

  tick(name: string, fn: string, dt: number, ctx: ShaderCallCtx): void {
    void this.resolve(name, fn).then((hit) => {
      if (!hit) return
      const hook = hit.mod[hit.fn]
      if (typeof hook === 'function' && hook.length >= 2) {
        ;(hook as (dt: number, ctx: ShaderCallCtx) => void)(dt, ctx)
      }
    })
  }

  /** Advance every loaded scene shader (one-shot trails, lingering crystals, …). */
  update(dt: number): void {
    for (const mod of this.modules.values()) mod.update?.(dt)
  }

  dispose(): void {
    for (const mod of this.modules.values()) mod.dispose?.()
    this.modules.clear()
    for (const url of this.blobs) URL.revokeObjectURL(url)
    this.blobs.length = 0
    this.catalog.clear()
    this.loaded.clear()
  }

  /** `tjs.ice(...)` finds `ice` on any loaded file; `tjs.cinder.cast(...)` hits that alias. */
  private async resolve(
    name: string,
    fn: string
  ): Promise<{ mod: ShaderModule; fn: string } | null> {
    const key = name.trim().toLowerCase()
    const hook = fn.trim()
    if (key) {
      const named = await this.ensure(key)
      if (named && typeof named[hook] === 'function') return { mod: named, fn: hook }
      if (named) return { mod: named, fn: hook }
    }
    await Promise.all([...this.loaded.values()])
    const want = hook || key
    if (!want || LIFECYCLE.has(want.toLowerCase())) return null
    for (const mod of this.modules.values()) {
      if (typeof mod[want] === 'function') return { mod, fn: want }
    }
    const aliased = this.modules.get(want)
    if (aliased) return { mod: aliased, fn: 'cast' }
    return null
  }

  private call(mod: ShaderModule, fn: string, ctx: ShaderCallCtx): void {
    const hook = mod[fn] ?? mod.cast ?? mod.play
    if (typeof hook !== 'function') {
      clientDebugLog.log('scene', `shader ${ctx.entity} missing fn '${fn}'`, {
        level: 'warn',
        alsoConsole: true
      })
      return
    }
    const full: ShaderCallCtx = {
      ...ctx,
      THREE,
      scene: this.worldScene ?? ctx.scene
    }
    if (hook.length >= 2) (hook as (dt: number, ctx: ShaderCallCtx) => void)(0, full)
    else (hook as (ctx: ShaderCallCtx) => void)(full)
  }

  private async load(name: string, src: string): Promise<ShaderModule | null> {
    if (isShaderWarmed(name, src)) {
      const existing = this.modules.get(name)
      if (existing) return existing
    }
    const fileKey = normalizeVfxPath(src)
    const vfxImport = VFX_FILES[fileKey]
    if (vfxImport) {
      if (isShaderWarmed(name, src)) {
        const stub: ShaderModule = {}
        this.modules.set(name, stub)
        return stub
      }
      try {
        await vfxImport()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.loaded.delete(name)
        clientDebugLog.log('scene', `shader '${name}' failed to load file ${src}: ${msg}`, {
          level: 'warn',
          alsoConsole: true
        })
        return null
      }
      const stub: ShaderModule = {}
      this.modules.set(name, stub)
      stampShaderWarmed(name, src)
      const leaf = (src.split('/').pop() ?? src).replace(/\.(js|mjs|ts)$/i, '')
      clientDebugLog.log('scene', `shader '${name}' loaded ${src} → vfx:${shaderToVfxId(leaf)}`, {
        alsoConsole: true
      })
      return stub
    }
    const url = this.resolveUrl?.(src)
    if (!url) {
      this.loaded.delete(name)
      clientDebugLog.log('scene', `shader '${name}' missing file ${src}`, {
        level: 'warn',
        alsoConsole: true
      })
      return null
    }
    const world = this.worldScene
    if (!world) {
      this.loaded.delete(name)
      clientDebugLog.log('scene', `shader '${name}' has no world scene yet`, {
        level: 'warn',
        alsoConsole: true
      })
      return null
    }
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status}`)
      const code = await res.text()
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      this.blobs.push(blobUrl)
      const raw = (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>
      const instance = bindShaderExports(raw)
      if (!instance) throw new Error('shader file must export functions (ice, cinder, …)')
      this.modules.set(name, instance)
      stampShaderWarmed(name, src)
      clientDebugLog.log('scene', `shader '${name}' loaded ${src}`, { alsoConsole: true })
      return instance
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.loaded.delete(name)
      clientDebugLog.log('scene', `shader '${name}' load failed: ${msg}`, {
        level: 'warn',
        alsoConsole: true
      })
      return null
    }
  }
}

let current: ShaderManager | null = null

export function getShaderManager(): ShaderManager {
  if (!current) current = new ShaderManager()
  return current
}

export function resetShaderManager(): void {
  current?.dispose()
  current = null
  clearShaderWarmCache()
}
