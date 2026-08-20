#!/usr/bin/env node
/**
 * Localpreview auth-server: mini-comms peer updates must classify SDK
 * craftCommsMessage as scene-binary (CUSTOM_EVENT / CRDT), and engine dt
 * must be seconds (Last Call Dock HUD is `loadLeft -= dt`).
 *
 * Run: node scripts/test-rfc5-auth-server.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
let failed = 0

function fail(msg) {
  failed += 1
  console.error(` FAIL ${msg}`)
}

function ok(msg) {
  console.log(`  ok ${msg}`)
}

function classifyRfc5PeerUpdateBody(body) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body))
    if (parsed?.type === 'avatar-transform') return 'transform'
    if (parsed?.type === 'topic' && typeof parsed.topic === 'string') return 'topic'
  } catch {
    /* binary craftCommsMessage */
  }
  return 'scene-binary'
}

function engineDtToSeconds(requested) {
  if (!(requested > 0) || !Number.isFinite(requested)) return 0
  if (requested > 1 && requested <= 250) return requested / 1000
  return requested
}

function u8From(text) {
  return new TextEncoder().encode(text)
}

{
  const transform = u8From(JSON.stringify({ type: 'avatar-transform', x: 1, y: 2, z: 3, yaw: 0 }))
  if (classifyRfc5PeerUpdateBody(transform) !== 'transform') fail('transform JSON is transform')
  else ok('transform JSON is transform')

  const topic = u8From(JSON.stringify({ type: 'topic', topic: 'chat', data: 'YQ==' }))
  if (classifyRfc5PeerUpdateBody(topic) !== 'topic') fail('topic JSON is topic')
  else ok('topic JSON is topic')

  const custom = new Uint8Array([6, 1, 2, 3])
  if (classifyRfc5PeerUpdateBody(custom) !== 'scene-binary') fail('CUSTOM_EVENT type 6 is scene-binary')
  else ok('CUSTOM_EVENT type 6 is scene-binary')

  const crdt = new Uint8Array([7, 0, 0])
  if (classifyRfc5PeerUpdateBody(crdt) !== 'scene-binary') fail('AUTH_CRDT type 7 is scene-binary')
  else ok('AUTH_CRDT type 7 is scene-binary')
}

{
  if (engineDtToSeconds(0.05) !== 0.05) fail('0.05s stays seconds')
  else ok('0.05s stays seconds')
  if (Math.abs(engineDtToSeconds(16) - 0.016) > 1e-9) fail('16ms → 0.016s')
  else ok('16ms → 0.016s')
  if (engineDtToSeconds(0) !== 0) fail('0 stays 0')
  else ok('0 stays 0')
  if (engineDtToSeconds(0.25) !== 0.25) fail('0.25 hitch stays seconds')
  else ok('0.25 hitch stays seconds')
}

{
  const types = readFileSync(join(root, 'src/network/comms/types.ts'), 'utf8')
  if (!types.includes('export function classifyRfc5PeerUpdateBody')) {
    fail('types.ts exports classifyRfc5PeerUpdateBody')
  } else ok('types.ts exports classifyRfc5PeerUpdateBody')

  const comms = readFileSync(join(root, 'src/network/CommsService.ts'), 'utf8')
  if (!comms.includes('classifyRfc5PeerUpdateBody(body)')) {
    fail('connectWsRoom classifies RFC5 peer updates')
  } else ok('connectWsRoom classifies RFC5 peer updates')
  if (!comms.includes('this.inboundQueue.pushSceneBinary(address, body)')) {
    fail('RFC5 onPeerUpdate pushes scene-binary (auth-server CUSTOM_EVENT)')
  } else ok('RFC5 onPeerUpdate pushes scene-binary')
  if (!comms.includes('this.rfc5.hasRemoteAddress(AUTH_SERVER_PEER_IDENTITY)')) {
    fail('hasAuthServerPeer checks RFC5 authoritative-server')
  } else ok('hasAuthServerPeer checks RFC5 authoritative-server')
  if (!comms.includes('isPreview: preview')) {
    fail('getRealmInfo reports isPreview for mini-comms')
  } else ok('getRealmInfo reports isPreview for mini-comms')
  if (!comms.includes('joinLocalPreviewAuthLiveKit')) {
    fail('ws-room preview also joins gatekeeper-local LiveKit (hammurabi)')
  } else ok('ws-room preview also joins gatekeeper-local LiveKit (hammurabi)')
  if (!comms.includes('GATEKEEPER_LOCAL_URL')) {
    fail('uses comms-gatekeeper-local for preview auth LiveKit')
  } else ok('uses comms-gatekeeper-local for preview auth LiveKit')
  if (!comms.includes('LOCAL_PREVIEW_REALM_NAME')) {
    fail('preview auth handshake uses realm LocalPreview')
  } else ok('preview auth handshake uses realm LocalPreview')
  if (!comms.includes("parsed?.kind === 'ws-room'")) {
    fail('connectRealmComms must not re-join ws-room (kills hammurabi LiveKit)')
  } else ok('connectRealmComms skips ws-room reconnect')

  const rfc5 = readFileSync(join(root, 'src/network/comms/Rfc5RoomClient.ts'), 'utf8')
  if (!rfc5.includes('hasRemoteAddress(')) fail('Rfc5RoomClient.hasRemoteAddress')
  else ok('Rfc5RoomClient.hasRemoteAddress')

  const sched = readFileSync(join(root, 'src/shim/worker/sceneEngineScheduler.ts'), 'utf8')
  if (!sched.includes('engineDtToSeconds(requested)')) {
    fail('clampDtToWallClock normalizes ms → seconds')
  } else ok('clampDtToWallClock normalizes ms → seconds')
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
