import * as THREE from 'three'
import { disposeOdkRoot, parseOdkBytes } from './OdkLoader'
import type { MmlAttachmentSpec } from './parseMml'
import type { LoadedOdkAttachment } from './odkAttachments'

/** Runtime ODK / MML character attached to the player pivot. */
export class OdkAvatar {
  readonly root: THREE.Group
  readonly height: number
  readonly attachments: LoadedOdkAttachment[]

  private constructor(root: THREE.Group, height: number, attachments: LoadedOdkAttachment[]) {
    this.root = root
    this.height = height
    this.attachments = attachments
  }

  static async fromBytes(bytes: ArrayBuffer, attachments?: MmlAttachmentSpec[]): Promise<OdkAvatar> {
    const parsed = await parseOdkBytes(bytes, attachments)
    return new OdkAvatar(parsed.root, parsed.height, parsed.attachments)
  }

  update(_delta: number): void {
    /* ODK GLBs have no spring bones — mixer drives the skeleton. */
  }

  dispose(): void {
    disposeOdkRoot(this.root)
  }
}