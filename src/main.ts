import './rendering/skinnedMeshInstance'
import { bootstrap } from './client/bootstrap'

bootstrap().catch((err: unknown) => {
  const hudStatus = document.getElementById('hud-status')
  const msg = err instanceof Error ? err.message : String(err)
  if (hudStatus) {
    hudStatus.className = 'error'
    hudStatus.textContent = `Failed to load: ${msg}`
  }
  console.error(err)
})
