import { AppController } from './AppController'
import { installSkinnedMeshSafetyPatch } from '../rendering/skinnedMeshInstance'

const hud = document.getElementById('hud')!

if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}

export async function bootstrap(): Promise<void> {
  installSkinnedMeshSafetyPatch()

  const container = document.getElementById('app')
  if (!container) throw new Error('#app missing')

  hud.hidden = true

  const app = new AppController()
  await app.start(container)
}
