#!/usr/bin/env node
/**
 * VideoPlayer bind law — Explorer keeps authored GLB albedo until a decoded frame.
 * Binding a 1×1 black canvas on decoder create / occupancy pause is what flashed
 * Burj (place_on_camera video_player.glb) in the camera.
 * Run: node scripts/test-video-texture-bind.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const bridge = readFileSync(join(root, 'src/media/VideoPlayerBridge.ts'), 'utf8')
const player = readFileSync(join(root, 'src/media/WebVideoPlayer.ts'), 'utf8')
const throttled = readFileSync(join(root, 'src/media/ThrottledVideoTexture.ts'), 'utf8')
const materials = readFileSync(join(root, 'src/bridge/material/MaterialApplier.ts'), 'utf8')
const nodeMods = readFileSync(join(root, 'src/bridge/GltfNodeModifiersSync.ts'), 'utf8')

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

console.log('video texture bind law')

assert(
  'getTexture gates on canAttachTexture (no immediate black canvas)',
  /if\s*\(\s*!entry\.player\.canAttachTexture\(\)\s*\)\s*return null/.test(bridge)
)
assert(
  'ensureDecoder does not fire onTextureReady before a frame',
  !/Bind black placeholder immediately/.test(bridge) &&
    /this\.decoders\.set\(entity, \{[\s\S]*?materialsBoundKey: ''\s*\}\)/.test(bridge) &&
    /player\.onFrameReady = \(\) => this\.notifyMaterialsForVideo\(entity\)/.test(bridge)
)
assert(
  'applySpec only rebinds when the texture is attachable (once per play/idle+src)',
  /notifyMaterialsForVideo\(entity, fromUserToggle\)/.test(bridge) &&
    /if \(!force && !entry\.player\.canAttachTexture\(\)\) return/.test(bridge) &&
    /materialsBoundKey === key/.test(bridge)
)
assert(
  'playing=true waits for a painted canvas frame, not 1×1 black',
  /hasPaintedFrame === true/.test(player) || /throttledTexture\?\.hasPaintedFrame/.test(player)
)
assert(
  'ECS playing=false / ended still attach (Explorer idle black)',
  /!this\.wantsPlaying \|\| this\.holdingAtEnd/.test(player)
)
assert(
  'occupancy pause does not paintIdleBlack',
  /private syncPlaybackPause\(\): void \{[\s\S]*?if \(this\.isPlaybackBlocked\(\)\) \{[\s\S]*?this\.syncThrottledPlayback\(\)/.test(
    player
  ) &&
    !/if \(this\.isPlaybackBlocked\(\)\) \{[\s\S]{0,280}this\.paintIdleBlack\(\)/.test(player)
)
assert(
  'applySpec occupancy/visibility pause does not paintIdleBlack',
  /if \(this\.isPlaybackBlocked\(\)\) \{\s*if \(!this\.usesSharedLiveKit\) this\.video\.pause\(\)/.test(
    player
  )
)
assert(
  'ThrottledVideoTexture.stop does not clearToBlack',
  /stop\(\): void \{[\s\S]*?Occupancy[\s\S]*?keep last frame[\s\S]*?\}/.test(throttled) &&
    !/stop\(\): void \{[\s\S]*?this\.clearToBlack\(\)/.test(throttled)
)
assert(
  'uploadFrame does not clearToBlack when there is no decoded size',
  /vw <= 0 \|\| vh <= 0\) \{\s*\/\/ No decoded frame yet[\s\S]*?return/.test(throttled)
)
assert(
  'first drawImage notifies onFrameUploaded',
  /this\.paintedFrame = true\s*this\.onFrameUploaded\?\.\(\)/.test(throttled)
)
assert(
  'MaterialApplier skips scalar swap for VideoTexture (keeps GLB albedo)',
  /if \(this\.materialHasVideoTexture\(pb\)\) return/.test(materials)
)
assert(
  'applyToMesh returns false while video is unresolved',
  /if \(this\.hasUnresolvedVideo\(pb\)\) return false/.test(materials)
)
assert(
  'GltfNodeModifiers skip apply until video textures resolve',
  /materialHasVideoTexture\(pb\) && materials\.texturesPending\(pb\)/.test(nodeMods)
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
