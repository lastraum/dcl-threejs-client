/** Max GPU upload rate for scene video textures (LiveKit + file/HLS). */
/** Cap canvas upload rate — 15 is enough for plaza screens and half the GPU upload cost. */
export const SCENE_VIDEO_MAX_FPS = 15

/** Cap decoded frame dimensions before WebGL upload. */
export const SCENE_VIDEO_MAX_WIDTH = 1920
export const SCENE_VIDEO_MAX_HEIGHT = 1080

/** Genesis Plaza theatre — one LiveKit `current-stream` decode for all screens. */
export const LIVEKIT_CURRENT_STREAM_DECODER_LIMIT = 1