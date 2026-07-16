/**
 * THREE.PositionalAudio / AudioListener call AudioParam.linearRampToValueAtTime with
 * world-space position/orientation (and endTime = currentTime + timeDelta).
 * Network/ECS entities can momentarily carry NaN transforms — Chrome throws and aborts
 * the whole updateMatrixWorld / CRDT flush. Guard once on the prototypes.
 */
import * as THREE from 'three'

let patched = false

function wrapSafeUpdateMatrixWorld(
  proto: { updateMatrixWorld(force?: boolean): void },
  label: string
): void {
  const native = proto.updateMatrixWorld
  proto.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean) {
    try {
      native.call(this, force)
    } catch (err) {
      // Still keep the scene graph matrix valid for transforms / raycasts.
      THREE.Object3D.prototype.updateMatrixWorld.call(this, force)
      if (typeof console !== 'undefined' && console.debug) {
        const msg = err instanceof Error ? err.message : String(err)
        // Throttle-ish: only log when non-finite (the known failure mode).
        if (msg.includes('non-finite') || msg.includes('linearRamp')) {
          console.debug(`[audio] ${label}.updateMatrixWorld skipped — ${msg}`)
        }
      }
    }
  }
}

export function patchThreeAudioSafeRamps(): void {
  if (patched) return
  patched = true
  wrapSafeUpdateMatrixWorld(THREE.PositionalAudio.prototype, 'PositionalAudio')
  wrapSafeUpdateMatrixWorld(THREE.AudioListener.prototype, 'AudioListener')
}
