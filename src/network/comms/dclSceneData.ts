import protobuf from 'protobufjs'
import protoSource from './dclSceneCommsProto.proto?raw'

let rootCache: protobuf.Root | null = null

function getRoot(): protobuf.Root {
  if (!rootCache) {
    rootCache = protobuf.parse(protoSource, { keepCase: true }).root
  }
  return rootCache
}

export type DecodedSceneData =
  | { kind: 'position'; x: number; y: number; z: number; rx: number; ry: number; rz: number; rw: number }
  | { kind: 'unknown' }

export function tryDecodeSceneDataPacket(buf: Uint8Array): DecodedSceneData {
  try {
    const Data = getRoot().lookupType('decentraland.kernel.comms.v3.Data')
    const msg = Data.decode(buf) as {
      position?: {
        position_x?: number
        position_y?: number
        position_z?: number
        rotation_x?: number
        rotation_y?: number
        rotation_z?: number
        rotation_w?: number
      }
    }
    const pos = msg.position
    if (!pos) return { kind: 'unknown' }
    const x = typeof pos.position_x === 'number' ? pos.position_x : NaN
    const y = typeof pos.position_y === 'number' ? pos.position_y : NaN
    const z = typeof pos.position_z === 'number' ? pos.position_z : NaN
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { kind: 'unknown' }
    return {
      kind: 'position',
      x,
      y: Number.isFinite(y) ? y : 0,
      z,
      rx: pos.rotation_x ?? 0,
      ry: pos.rotation_y ?? 0,
      rz: pos.rotation_z ?? 0,
      rw: pos.rotation_w ?? 1
    }
  } catch {
    return { kind: 'unknown' }
  }
}

export function encodeScenePositionPacket(world: {
  x: number
  y: number
  z: number
  rx?: number
  ry?: number
  rz?: number
  rw?: number
}): Uint8Array {
  const Data = getRoot().lookupType('decentraland.kernel.comms.v3.Data')
  const payload = {
    position: {
      time: Date.now() / 1000,
      position_x: world.x,
      position_y: world.y,
      position_z: world.z,
      rotation_x: world.rx ?? 0,
      rotation_y: world.ry ?? 0,
      rotation_z: world.rz ?? 0,
      rotation_w: world.rw ?? 1
    }
  }
  const err = Data.verify(payload)
  if (err) throw new Error(err)
  return Data.encode(Data.create(payload)).finish()
}

export function encodeSceneProfileHeartbeat(profileVersion = '0'): Uint8Array {
  const Data = getRoot().lookupType('decentraland.kernel.comms.v3.Data')
  const payload = {
    profile: {
      time: Date.now() / 1000,
      profile_version: profileVersion,
      profile_type: 0
    }
  }
  const err = Data.verify(payload)
  if (err) throw new Error(err)
  return Data.encode(Data.create(payload)).finish()
}

export function yawFromQuaternion(rx: number, ry: number, rz: number, rw: number): number {
  const sinyCosp = 2 * (rw * ry + rx * rz)
  const cosyCosp = 1 - 2 * (ry * ry + rz * rz)
  return Math.atan2(sinyCosp, cosyCosp)
}

export function quaternionFromYaw(yaw: number): { rx: number; ry: number; rz: number; rw: number } {
  const half = yaw * 0.5
  return { rx: 0, ry: Math.sin(half), rz: 0, rw: Math.cos(half) }
}
