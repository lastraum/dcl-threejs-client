/** Static sky / environment textures served from `public/environment/`. */
export const ENVIRONMENT_TEXTURE_BASE = '/environment/'

export const ENVIRONMENT_TEXTURES = {
  islandShoreGround: `${ENVIRONMENT_TEXTURE_BASE}IslandShoreGround.png`,
  moon: `${ENVIRONMENT_TEXTURE_BASE}SkyboxMoon.png`,
  stars: `${ENVIRONMENT_TEXTURE_BASE}SkyboxStars.png`,
  sun: `${ENVIRONMENT_TEXTURE_BASE}SkyboxSun.png`,
  farClouds: `${ENVIRONMENT_TEXTURE_BASE}SkyboxFarClouds.png`,
  nearClouds: `${ENVIRONMENT_TEXTURE_BASE}SkyboxNearClouds.png`,
  horizonClouds: `${ENVIRONMENT_TEXTURE_BASE}horizon_clouds2.png`,
  topClouds: `${ENVIRONMENT_TEXTURE_BASE}top_clouds.png`
} as const