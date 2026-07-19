/** Explorer In-World Camera defaults (unity-explorer InWorldCameraMovementSettings). */

/** Max distance from local avatar feet (m). */
export const PHOTO_MAX_DISTANCE_FROM_PLAYER = 16

/** Base fly speed m/s. */
export const PHOTO_TRANSLATION_SPEED = 5

/** Shift multiplier (Explorer RunSpeedMultiplayer). */
export const PHOTO_RUN_MULTIPLIER = 2

/** Ctrl multiplier (Explorer WalkSpeedMultiplayer). */
export const PHOTO_WALK_MULTIPLIER = 0.5

/** Mouse look sensitivity (rad per pixel at 100% settings baseline). */
export const PHOTO_LOOK_SENSITIVITY = 0.0022

/** FOV limits while in photo mode. */
export const PHOTO_MIN_FOV = 20
export const PHOTO_MAX_FOV = 100
export const PHOTO_DEFAULT_FOV = 60
/** Degrees of FOV change per wheel deltaY unit (mouse notch ~100 → ~4°). */
export const PHOTO_FOV_SCROLL_SPEED = 0.04

/** Rule-of-thirds frame vs viewport (Explorer ScreenRecorder.FRAME_SCALE). */
export const PHOTO_FRAME_SCALE = 0.87

/** Output capture size (Explorer target). */
export const PHOTO_TARGET_WIDTH = 1920
export const PHOTO_TARGET_HEIGHT = 1080

/** Minimum camera height above y=0 (Explorer blocks under-floor). */
export const PHOTO_MIN_Y = 0.15
