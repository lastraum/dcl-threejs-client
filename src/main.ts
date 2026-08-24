import './rendering/skinnedMeshInstance'
import { bootstrap } from './client/bootstrap'
import { mountPhoneLogHud, shouldMountPhoneLogHud } from './client/debug/phoneLogHud'

if (shouldMountPhoneLogHud()) mountPhoneLogHud()

bootstrap().catch((err: unknown) => {
  const hudStatus = document.getElementById('hud-status')
  const msg = err instanceof Error ? err.message : String(err)
  if (hudStatus) {
    hudStatus.className = 'error'
    hudStatus.textContent = `Failed to load: ${msg}`
  }
  console.error(err)
})
