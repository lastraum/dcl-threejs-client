export type SceneAccessDeniedSource =
  | 'metadata_blacklist'
  | 'gatekeeper_ban'
  | 'gatekeeper_blacklist'

export type SceneAccessDeniedDetails = {
  source: SceneAccessDeniedSource
  sceneTitle?: string
  customMessage?: string
  gatekeeperError?: string
}

/** Thrown before world load when the signed-in wallet cannot enter a scene. */
export class SceneAccessDeniedError extends Error {
  readonly source: SceneAccessDeniedSource
  readonly sceneTitle?: string
  readonly customMessage?: string
  readonly gatekeeperError?: string

  constructor(details: SceneAccessDeniedDetails) {
    const label = details.sceneTitle?.trim() || 'this place'
    super(`Scene access denied for ${label}`)
    this.name = 'SceneAccessDeniedError'
    this.source = details.source
    this.sceneTitle = details.sceneTitle
    this.customMessage = details.customMessage
    this.gatekeeperError = details.gatekeeperError
  }
}