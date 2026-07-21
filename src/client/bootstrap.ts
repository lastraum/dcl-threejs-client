import { setLogLevel, LogLevel } from 'livekit-client'
import { AppController } from './AppController'
import { installSkinnedMeshSafetyPatch } from '../rendering/skinnedMeshInstance'
import { maybeShowWhatsNewToast } from './whatsNew/WhatsNewToast'

const hud = document.getElementById('hud')!

if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}

// LiveKit SDK defaults to verbose connection/state spam in DevTools.
setLogLevel(LogLevel.warn)

export async function bootstrap(): Promise<void> {
  installSkinnedMeshSafetyPatch()

  const container = document.getElementById('app')
  if (!container) throw new Error('#app missing')

  hud.hidden = true

  const app = new AppController()
  await app.start(container)
  // After first shell paint — version toast (localStorage write off while testing).
  maybeShowWhatsNewToast()
}
