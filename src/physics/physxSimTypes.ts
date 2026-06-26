/** Phase D — main ↔ PhysX sim worker message protocol. */

export type PhysxSimWorkerInbound =
  | { type: 'init'; id: number }
  | {
      type: 'spawn-player'
      id: number
      position: [number, number, number]
    }
  | {
      type: 'move-player'
      id: number
      displacement: [number, number, number]
      delta: number
      applyPlatformTransfer: boolean
    }
  | {
      type: 'teleport-player'
      id: number
      position: [number, number, number]
    }
  | {
      type: 'register-collider-stream'
      id: number
      entity: number
      convex: boolean
      stream: ArrayBuffer
      /** Row-major 4×4 world matrix for the actor root. */
      matrix: Float32Array
    }
  | {
      type: 'set-actor-pose'
      id: number
      entity: number
      matrix: Float32Array
    }

export type PhysxSimWorkerOutbound =
  | { type: 'ready' }
  | { type: 'init-done'; id: number }
  | { type: 'init-error'; id: number; message: string }
  | {
      type: 'move-result'
      id: number
      position: [number, number, number]
      grounded: boolean
      groundPhysEntity: number | null
    }
  | { type: 'spawn-done'; id: number }
  | { type: 'register-done'; id: number; entity: number }
  | { type: 'pose-done'; id: number }
  | { type: 'error'; id: number; message: string }