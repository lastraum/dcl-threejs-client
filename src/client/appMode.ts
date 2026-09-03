/** Application shell mode — URL alone does not imply 3D (see UX spec). */
export type AppMode =
  | 'explorer'
  | 'map'
  | 'forest'
  | 'communities'
  | 'events'
  | 'live'
  | 'profile'
  | 'lootbag'
  | 'landing'
  | 'play'