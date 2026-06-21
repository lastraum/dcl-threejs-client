/** Matches `@dcl/ecs` MediaState (const enum — use literals under isolatedModules). */
export const MS_NONE = 0
export const MS_ERROR = 1
export const MS_LOADING = 2
export const MS_READY = 3
export const MS_PLAYING = 4
export const MS_BUFFERING = 5
export const MS_SEEKING = 6
export const MS_PAUSED = 7

export type MediaStateValue =
  | typeof MS_NONE
  | typeof MS_ERROR
  | typeof MS_LOADING
  | typeof MS_READY
  | typeof MS_PLAYING
  | typeof MS_BUFFERING
  | typeof MS_SEEKING
  | typeof MS_PAUSED