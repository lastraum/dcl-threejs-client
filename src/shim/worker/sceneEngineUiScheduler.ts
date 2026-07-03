import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { extractUiTextureSrc } from '../../ui/scene/uiBackgroundStyle'

import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import {
  resolveWorkerUiBackground,
  resolveWorkerUiDropdown,
  resolveWorkerUiInput,
  resolveWorkerUiText,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'

/**
 * Scene UI scheduler — scene-agnostic infrastructure matching Explorer ordering.
 *
 * SDK7 scenes (Planet Angzaar, Genesis, etc.) drive UI through:
 *   closure / timers / onUpdate  →  @dcl/react-ecs reconcile  →  Ui* ECS  →  CRDT  →  renderer
 *
 * Stock @dcl/ecs registers react-ecs @ 1e5, which runs BEFORE default-priority systems that
 * mutate closure state (splash timers, loading screens, menu flags). Explorer avoids stale UI
 * by running UI reconcile after scene logic; we patch the bundled engine system loop to match.
 *
 * Layers:
 * 1. patchEngineSystemLoopPartition — defer @dcl/react-ecs* to end of engine.update (bundle)
 * 2. installSceneEngineUiScheduler — per-engine addSystem idempotency + post-update CRDT flush
 */

export const ENGINE_SYSTEM_LOOP_KEY = '__THREEJS_ENGINE_SYSTEM_LOOP__'

/** System names reconciled after all other systems in a tick. */
const DEFERRED_UI_SYSTEM_NAMES = new Set(['@dcl/react-ecs', '@dcl/react-ecs-ui-scale'])

type SystemItem = { fn: (dt: number) => void; name?: string; priority: number }

/** Installed once in the worker before scene bundle eval. */
export function installEngineSystemLoopPartition(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g[ENGINE_SYSTEM_LOOP_KEY] === 'function') return
  g[ENGINE_SYSTEM_LOOP_KEY] = (systems: SystemItem[], dt: number, runOne: (s: SystemItem, dt: number) => void) => {
    let react: SystemItem | undefined
    let scale: SystemItem | undefined
    for (const system of systems) {
      const name = system.name
      if (name === '@dcl/react-ecs') {
        react = system
        continue
      }
      if (name === '@dcl/react-ecs-ui-scale') {
        scale = system
        continue
      }
      runOne(system, dt)
    }
    if (scale) runOne(scale, dt)
    if (react) runOne(react, dt)
  }
}

/** Seed RootEntity canvas info on the worker — react-ecs ui-scale reads this before main paints. */
export function seedWorkerUiCanvasInformation(engine: IEngine, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  preregisterRendererInjectedComponents(engine)
  const UiCanvasInformation = generated.UiCanvasInformation(engine)
  const w = Math.floor(width)
  const h = Math.floor(height)
  const fullCanvas = { left: 0, top: 0, right: w, bottom: h }
  UiCanvasInformation.createOrReplace(0 as Entity, {
    devicePixelRatio: 1,
    width: w,
    height: h,
    interactableArea: fullCanvas,
    screenInsetArea: { left: 0, top: 0, right: 0, bottom: 0 }
  })
}

let lastWorkerUiFingerprint = ''
const engineUiHooked = new WeakSet<IEngine>()

const DUPLICATE_SYSTEM_RE = /already added to the engine/i

/** Attach per-engine hooks (idempotent addSystem for duplicate bootstrap paths). */
export function installSceneEngineUiScheduler(engine: IEngine): void {
  if (engineUiHooked.has(engine)) return
  engineUiHooked.add(engine)

  const nativeAdd = engine.addSystem.bind(engine)
  engine.addSystem = (fn, priority, name) => {
    try {
      nativeAdd(fn, priority, name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (DUPLICATE_SYSTEM_RE.test(msg)) return
      throw err
    }
  }
}

/** @deprecated Use installSceneEngineUiScheduler */
export const installWorkerEngineUiHooks = installSceneEngineUiScheduler

export function resetWorkerUiFingerprint(): void {
  lastWorkerUiFingerprint = ''
}

export function seedWorkerUiFingerprint(engine: IEngine): void {
  lastWorkerUiFingerprint = computeWorkerUiFingerprint(engine)
}

export function hasWorkerReactEcsSync(_engine: IEngine): boolean {
  return typeof (globalThis as Record<string, unknown>)[ENGINE_SYSTEM_LOOP_KEY] === 'function'
}

function colorKey(c: { r?: number; g?: number; b?: number; a?: number } | undefined): string {
  if (!c) return ''
  return `${c.r ?? 0},${c.g ?? 0},${c.b ?? 0},${c.a ?? 0}`
}

export function computeWorkerUiFingerprint(engine: IEngine): string {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const UiBackground = resolveWorkerUiBackground(engine)
  const UiText = resolveWorkerUiText(engine)
  const parts: string[] = []
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    const t = UiTransform.getOrNull(entity)
    if (!t) continue
    let line = `${entity}:d${t.display ?? 0}:o${t.opacity ?? 1}:p${t.parent ?? 0}`
    const bg = UiBackground.getOrNull(entity)
    if (bg) {
      line += `:bg${colorKey(bg.color)}:${extractUiTextureSrc(bg.texture) ?? ''}`
    }
    const text = UiText.getOrNull(entity)
    if (text) {
      const value = text.value ?? ''
      line += `:tx${value.length}:${value.slice(0, 32)}`
    }
    parts.push(line)
  }
  parts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return parts.join('|')
}

/** Force LWW PUTs when react-ecs reconciled via getMutable (transport may skip byte-identical rows). */
export function touchWorkerUiComponentsForCrdt(engine: IEngine): number {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const UiBackground = resolveWorkerUiBackground(engine)
  const UiText = resolveWorkerUiText(engine)
  const UiInput = resolveWorkerUiInput(engine)
  const UiDropdown = resolveWorkerUiDropdown(engine)
  let touched = 0
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    const id = entity as Entity
    const transform = UiTransform.getOrNull(id)
    if (transform) {
      UiTransform.createOrReplace(id, { ...transform })
      touched++
    }
    const background = UiBackground.getOrNull(id)
    if (background) {
      UiBackground.createOrReplace(id, { ...background })
      touched++
    }
    const text = UiText.getOrNull(id)
    if (text) {
      UiText.createOrReplace(id, { ...text })
      touched++
    }
    const input = UiInput.getOrNull(id)
    if (input) {
      UiInput.createOrReplace(id, { ...input })
      touched++
    }
    const dropdown = UiDropdown.getOrNull(id)
    if (dropdown) {
      UiDropdown.createOrReplace(id, { ...dropdown })
      touched++
    }
  }
  return touched
}

/** Propagate worker Ui* churn to main when fingerprint changes after a tick. */
export async function flushWorkerSceneUiAfterEngineTick(
  engine: IEngine,
  log?: (message: string) => void
): Promise<boolean> {
  const fingerprint = computeWorkerUiFingerprint(engine)
  if (fingerprint === lastWorkerUiFingerprint) return false

  const prevLen = lastWorkerUiFingerprint.length

  try {
    const touched = touchWorkerUiComponentsForCrdt(engine)
    if (touched > 0) {
      log?.(
        `[sceneWorker] ui fingerprint flush — touched=${touched} fp=${prevLen}→${fingerprint.length}B`
      )
      await engine.update(0)
      lastWorkerUiFingerprint = fingerprint
      return true
    }
    log?.(
      `[sceneWorker] ui fingerprint changed but touch skipped — fp=${prevLen}→${fingerprint.length}B`
    )
    return false
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log?.(`[sceneWorker] ui fingerprint flush failed — ${msg || 'unknown error'}`)
    return false
  }
}

export { DEFERRED_UI_SYSTEM_NAMES }