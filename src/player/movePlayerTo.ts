export type MovePlayerToRequest = {
  newRelativePosition?: { x?: number; y?: number; z?: number }
  cameraTarget?: { x?: number; y?: number; z?: number }
  avatarTarget?: { x?: number; y?: number; z?: number }
  duration?: number
}

export type MovePlayerToResponse = {
  success: boolean
}
