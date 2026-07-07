import type { LoginResult } from '../../auth/AuthClient'
import type { ResolvedScene } from '../../dcl/content/types'
import { assertSceneAccess } from './assertSceneAccess'
import { SceneAccessDeniedError } from './SceneAccessDeniedError'

/** Non-throwing access probe for periodic ban checks. */
export async function probeSceneAccess(
  scene: ResolvedScene,
  login: LoginResult | null
): Promise<SceneAccessDeniedError | null> {
  try {
    await assertSceneAccess(scene, login)
    return null
  } catch (err) {
    if (err instanceof SceneAccessDeniedError) return err
    throw err
  }
}