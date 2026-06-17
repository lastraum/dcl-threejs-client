/** Matches `@dcl/ecs` VideoState (const enum — use literals under isolatedModules). */
export const VS_NONE = 0
export const VS_ERROR = 1
export const VS_LOADING = 2
export const VS_READY = 3
export const VS_PLAYING = 4
export const VS_BUFFERING = 5
export const VS_SEEKING = 6
export const VS_PAUSED = 7

export type VideoStateValue =
  | typeof VS_NONE
  | typeof VS_ERROR
  | typeof VS_LOADING
  | typeof VS_READY
  | typeof VS_PLAYING
  | typeof VS_BUFFERING
  | typeof VS_SEEKING
  | typeof VS_PAUSED
