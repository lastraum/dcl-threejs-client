import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import { disposeVrmRoot, parseVrmBytes } from './VrmLoader'

/** Runtime custom VRM instance attached to the player pivot. */
export class VrmAvatar {
  readonly root: THREE.Group
  readonly vrm: VRM
  readonly height: number

  private constructor(root: THREE.Group, vrm: VRM, height: number) {
    this.root = root
    this.vrm = vrm
    this.height = height
  }

  static async fromBytes(bytes: ArrayBuffer): Promise<VrmAvatar> {
    const parsed = await parseVrmBytes(bytes)
    return new VrmAvatar(parsed.root, parsed.vrm, parsed.height)
  }

  /**
   * Per-frame VRM extras while locomotion drives raw bones via AnimationMixer.
   * Skips humanoid.update() — that would overwrite mixer poses every frame.
   */
  update(delta: number): void {
    this.vrm.nodeConstraintManager?.update()
    this.vrm.springBoneManager?.update(delta)
    this.vrm.materials?.forEach((material) => {
      const m = material as THREE.Material & { update?: (d: number) => void }
      m.update?.(delta)
    })
  }

  dispose(): void {
    disposeVrmRoot(this.vrm, this.root)
  }
}