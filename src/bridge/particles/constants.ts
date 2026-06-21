/** DCL scene gravity (m/s²) — ParticleSystem.gravity is a multiplier on this. */
export const DCL_SCENE_GRAVITY = -9.81

/** Explorer caps total live particles per scene; scale rates when exceeded. */
export const SCENE_PARTICLE_BUDGET = 1000

/** Matches `PBParticleSystem_PlaybackState` (const enum — literals under isolatedModules). */
export const PS_PLAYING = 0
export const PS_PAUSED = 1
export const PS_STOPPED = 2

/** Matches `PBParticleSystem_SimulationSpace`. */
export const PSS_LOCAL = 0
export const PSS_WORLD = 1

/** Matches `PBParticleSystem_BlendMode`. */
export const PSB_ALPHA = 0
export const PSB_ADD = 1
export const PSB_MULTIPLY = 2

export const TWM_REPEAT = 0
export const TWM_MIRROR = 2
export const TFM_POINT = 0
export const TFM_TRILINEAR = 2