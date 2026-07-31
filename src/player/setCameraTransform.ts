/**
 * ~system/Testing.setCameraTransform — DCL CameraEntity pose (scene space).
 * @see decentraland/kernel/apis/testing.proto SetCameraTransformTestCommand
 */

export type SetCameraTransformRequest = {
  position?: { x: number; y: number; z: number }
  rotation?: { x: number; y: number; z: number; w: number }
}

export type SetCameraTransformResponse = Record<string, never>
