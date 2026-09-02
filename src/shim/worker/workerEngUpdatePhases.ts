/**
 * WSP v2 Phase 0 / 0b / 0.5–0.5i — engine.update phase meters (+ sendBinary path tags).
 *
 * @dcl/ecs engine.update is:
 *   await receiveMessages()  →  systems loop  →  await sendMessages()
 *
 * With our systems-loop partition, react-ecs runs at end of systems (Explorer order).
 *
 * Phase 0 meters:
 *   pre     ≈ receiveMessages (before systems loop)
 *   systems = scene systems (excludes react-ecs*)
 *   react   = @dcl/react-ecs + ui-scale
 *   send    = sendMessages wall (after systems loop → update resolves)
 *   crdt*   = rpcCrdt calls nested in send (or elsewhere during update)
 *
 * Phase 0.5 — split send when total ≥ SLOW_MS:
 *   encode  = systemsLoopEnd → first rpcCrdt entry
 *   xport   = sum of rpcCrdt walls (postMessage / ack wait)
 *   path=   = rpcCrdt outcome histogram (present / ack / skip / …)
 *
 * Phase 0.5c — split encode further (Genesis: getCrdt body ~0ms, enc still 80–200ms):
 *   preDump = systemsLoopEnd → start of componentsIter (sendMessages dirty dump)
 *   dump    = full componentsIter for-of (getCrdtUpdates + SDK write/onChange body)
 *   postDump= dump end → first rpcCrdt (transport buffer assembly)
 *   comps/msgs = components visited / dirty messages yielded
 *
 * Genesis capture: systems≈1ms, send≈80–500ms, crdt ack=0 → cost is encode, not systems pie.
 *
 * Does not skip, quarantine, or budget.
 *
 * @see docs/WORKER_SYSTEM_PIE_V2.md
 */

import { patchRendererTransportGuestLww } from './patchRendererTransportGuestLww'

export type EngUpdatePhaseSnapshot = {
  totalMs: number
  preMs: number
  systemsMs: number
  reactMs: number
  /** SDK sendMessages wall (was labeled post). */
  sendMs: number
  /**
   * Phase 0.5 — wall from systems loop end to first rpcCrdt entry.
   * Dominated by component.getCrdtUpdates + transport buffer build when dirty.
   */
  sendEncodeMs: number
  /** Phase 0.5 — sum of rpcCrdt walls (= crdtMs). */
  sendTransportMs: number
  /** Phase 0.5 — residual send after last rpcCrdt returns (usually ~0). */
  sendTailMs: number
  /** Sum of rpcCrdt wall times during this update. */
  crdtMs: number
  crdtCalls: number
  crdtBytes: number
  crdtAckCalls: number
  crdtAckMs: number
  /** rpcCrdt path → call count this update (Phase 0.5). */
  crdtPaths: Record<string, number>
  systemRun: number
  systemCount: number
  systemsLoop: boolean
  dt: number
}

/** rpcCrdt outcome tags — keep short for log lines. */
export type CrdtSendPath =
  | 'eval'
  | 'strip-ui'
  | 'strip-pe'
  | 'defer-ptr'
  | 'empty-dup'
  | 'empty-coal'
  | 'empty-nudge'
  | 'present'
  | 'ack'
  | 'boot'
  | 'other'

const SLOW_MS = 80
const SLOW_LOG_MIN_INTERVAL_MS = 1_500
const TOP_EMA_SIZE = 80
const TOP_LOG = 6

type PhaseGate = {
  active: boolean
  t0: number
  dt: number
  systemsLoopStart: number
  systemsLoopEnd: number
  systemsMs: number
  reactMs: number
  systemRun: number
  systemCount: number
  systemsLoop: boolean
  crdtMs: number
  crdtCalls: number
  crdtBytes: number
  crdtAckCalls: number
  crdtAckMs: number
  /** performance.now when first rpcCrdt note fires this update (0 = none). */
  firstCrdtAt: number
  lastCrdtAt: number
  crdtPaths: Map<string, number>
  /** Phase 0.5c — sendMessages dirty-dump window via componentsIter wrap. */
  dumpStartAt: number
  dumpEndAt: number
  dumpComps: number
  dumpMsgs: number
  getCrdtSumMs: number
  /** Phase 0.5d — transport.filter wall during postDump. */
  transportFilterMs: number
  transportFilterCalls: number
  transportSendNote: string
  /**
   * Phase 0.5i — network sendBinary path tags this eng.update:
   * `fast` (empty, no await) · `poll` (empty kick ≤20Hz) · `wait` (real outbound await).
   */
  sendBinaryNote: string
}

const gate: PhaseGate = {
  active: false,
  t0: 0,
  dt: 0,
  systemsLoopStart: 0,
  systemsLoopEnd: 0,
  systemsMs: 0,
  reactMs: 0,
  systemRun: 0,
  systemCount: 0,
  systemsLoop: false,
  crdtMs: 0,
  crdtCalls: 0,
  crdtBytes: 0,
  crdtAckCalls: 0,
  crdtAckMs: 0,
  firstCrdtAt: 0,
  lastCrdtAt: 0,
  crdtPaths: new Map(),
  dumpStartAt: 0,
  dumpEndAt: 0,
  dumpComps: 0,
  dumpMsgs: 0,
  getCrdtSumMs: 0,
  transportFilterMs: 0,
  transportFilterCalls: 0,
  transportSendNote: '',
  sendBinaryNote: ''
}

const systemMsEma = new Map<string, number>()
/** Per-update getCrdtUpdates wall by component (Phase 0.5b). */
const crdtCompMs = new Map<string, number>()
const crdtCompYields = new Map<string, number>()
/** componentIds already wrapped per engine (re-scan after preregister / onStart). */
const crdtEncodeWrappedIds = new WeakMap<object, Set<number>>()
let lastSnapshot: EngUpdatePhaseSnapshot = emptySnapshot()
let lastSlowLogAt = 0
let passCount = 0

function emptySnapshot(): EngUpdatePhaseSnapshot {
  return {
    totalMs: 0,
    preMs: 0,
    systemsMs: 0,
    reactMs: 0,
    sendMs: 0,
    sendEncodeMs: 0,
    sendTransportMs: 0,
    sendTailMs: 0,
    crdtMs: 0,
    crdtCalls: 0,
    crdtBytes: 0,
    crdtAckCalls: 0,
    crdtAckMs: 0,
    crdtPaths: {},
    systemRun: 0,
    systemCount: 0,
    systemsLoop: false,
    dt: 0
  }
}

export function getEngUpdatePhaseSnapshot(): EngUpdatePhaseSnapshot {
  return { ...lastSnapshot, crdtPaths: { ...lastSnapshot.crdtPaths } }
}

export function getEngUpdateTopSystems(limit = TOP_LOG): { name: string; ms: number }[] {
  return [...systemMsEma.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(1, limit))
}

export function resetEngUpdatePhases(): void {
  systemMsEma.clear()
  crdtCompMs.clear()
  crdtCompYields.clear()
  passCount = 0
  lastSlowLogAt = 0
  lastSnapshot = emptySnapshot()
  gate.crdtPaths.clear()
}

type MeteredComponent = {
  componentId: number
  componentName: string
  getCrdtUpdates: () => Iterable<unknown>
}

/**
 * Phase 0.5d — wrap renderer/network transport filter+send for postDump attribution.
 * Installed via global hook from patched addTransport capture.
 */
export function wrapCrdtTransportForMeters(transport: {
  type?: string
  filter?: (message: unknown) => boolean
  send: (data: unknown) => unknown
}): void {
  const t = transport as {
    type?: string
    filter?: (message: unknown) => boolean
    send: (data: unknown) => unknown
    __wsp0Transport?: boolean
  }
  if (!t || t.__wsp0Transport) return
  patchRendererTransportGuestLww(t)
  t.__wsp0Transport = true
  const kind = String(t.type || '?')
  if (typeof t.filter === 'function') {
    const origFilter = t.filter.bind(t)
    t.filter = (message: unknown) => {
      if (!gate.active || gate.systemsLoopEnd <= 0) return origFilter(message)
      gate.transportFilterCalls++
      const a = performance.now()
      const ok = origFilter(message)
      gate.transportFilterMs += performance.now() - a
      return ok
    }
  }
  const origSend = t.send.bind(t)
  t.send = (data: unknown) => {
    if (gate.active) {
      let bytes = 0
      if (data instanceof Uint8Array) bytes = data.byteLength
      else if (Array.isArray(data)) {
        for (const chunk of data) {
          if (chunk instanceof Uint8Array) bytes += chunk.byteLength
        }
      }
      const note = `${kind[0] ?? '?'}:${bytes}`
      gate.transportSendNote = gate.transportSendNote
        ? `${gate.transportSendNote}|${note}`
        : note
    }
    return origSend(data)
  }
}

/** Install global addTransport wrap hook (called from sceneWorker boot). */
export function installCrdtTransportMeterHook(): void {
  const g = globalThis as Record<string, unknown>
  g.__THREEJS_WRAP_CRDT_TRANSPORT__ = wrapCrdtTransportForMeters
}

/**
 * Phase 0.5b/c — wrap getCrdtUpdates so encode attributes to:
 * - per-component produce time (encTop / getCrdt)
 * - dump window = first→last getCrdtUpdates call after systems (includes SDK consumer
 *   between yields — write/onChange). postDump = dump end → first rpcCrdt.
 *
 * Note: componentsIter wrap was unreliable (always dump=0ms); dump is timed from
 * getCrdt entry/exit only. Safe to call multiple times; wraps each componentId once.
 */
export function installCrdtEncodeComponentMeters(engine: {
  componentsIter?: () => Iterable<MeteredComponent>
  // Loose typing — @dcl Transport.send is Promise<void>; we only wrap.
  addTransport?: (transport: never) => void
}): void {
  if (!engine?.componentsIter) return
  const engKey = engine as object
  let wrapped = crdtEncodeWrappedIds.get(engKey)
  if (!wrapped) {
    wrapped = new Set()
    crdtEncodeWrappedIds.set(engKey, wrapped)
  }

  try {
    const engAny = engine as {
      addTransport?: (t: unknown) => void
      __wsp0AddTransportWrapped?: boolean
    }
    if (engAny.addTransport && !engAny.__wsp0AddTransportWrapped) {
      const origAdd = engAny.addTransport.bind(engine)
      engAny.addTransport = (transport: unknown) => {
        wrapCrdtTransportForMeters(
          transport as {
            type?: string
            filter?: (message: unknown) => boolean
            send: (data: unknown) => unknown
          }
        )
        return origAdd(transport)
      }
      engAny.__wsp0AddTransportWrapped = true
    }
  } catch {
    /* ignore */
  }

  const comps = [...engine.componentsIter()]
  for (const comp of comps) {
    if (wrapped.has(comp.componentId)) continue
    const orig = comp.getCrdtUpdates.bind(comp)
    const label =
      shortCrdtComponentLabel(comp.componentName, comp.componentId) || `c${comp.componentId}`
    try {
      comp.getCrdtUpdates = function* wrappedGetCrdtUpdates() {
        if (!gate.active) {
          yield* orig() as Generator
          return
        }
        // sendMessages dirty dump only runs after systemsLoopEnd.
        const inDump = gate.systemsLoopEnd > 0
        if (inDump) {
          if (gate.dumpStartAt <= 0) gate.dumpStartAt = performance.now()
          gate.dumpComps++
        }

        // Produce-only: time next() of underlying generator (serialize/compare).
        let yields = 0
        let produceMs = 0
        const it = orig()[Symbol.iterator]()
        // Wall including consumer between yields (PutComponent write / onChange).
        const wallT0 = performance.now()
        for (;;) {
          const stepT0 = performance.now()
          const step = it.next()
          produceMs += performance.now() - stepT0
          if (step.done) break
          yields++
          yield step.value
        }
        const wallMs = performance.now() - wallT0

        if (inDump) {
          gate.dumpEndAt = performance.now()
          gate.getCrdtSumMs += produceMs
          // dumpWallSum stored in getCrdtSum for produce; wallMs - produce ≈ consumer.
          if (yields > 0) gate.dumpMsgs += yields
          // Track consumer cost under a synthetic encTop bucket when large.
          const consumerMs = Math.max(0, wallMs - produceMs)
          if (consumerMs >= 0.5) {
            const key = `${label}+sdk`
            crdtCompMs.set(key, (crdtCompMs.get(key) ?? 0) + consumerMs)
          }
        }

        if (produceMs < 0.05 && yields === 0) return
        crdtCompMs.set(label, (crdtCompMs.get(label) ?? 0) + produceMs)
        if (yields > 0) {
          crdtCompYields.set(label, (crdtCompYields.get(label) ?? 0) + yields)
        }
      } as typeof comp.getCrdtUpdates
      wrapped.add(comp.componentId)
    } catch {
      /* frozen component — skip */
    }
  }
}

function shortCrdtComponentLabel(name: string, id: number): string {
  const n = (name || '').replace(/^core(::|\/)/, '').replace(/^core-schema::/, '')
  if (!n) return `c${id}`
  // Prefer short stable ids in logs.
  if (n === 'Transform' || n.endsWith('::Transform')) return 'Transform'
  if (n.includes('Material')) return 'Material'
  if (n.includes('MeshRenderer')) return 'MeshRenderer'
  if (n.includes('TweenSequence')) return 'TweenSeq'
  if (n.includes('Tween')) return 'Tween'
  if (n.includes('Physics')) return 'Physics'
  if (n.includes('UiTransform')) return 'UiTransform'
  if (n.includes('UiBackground')) return 'UiBg'
  if (n.includes('UiText')) return 'UiText'
  if (n.includes('Animator')) return 'Animator'
  if (n.includes('GltfContainer')) return 'Gltf'
  if (n.includes('PointerEvents')) return 'PtrEv'
  if (n.includes('Billboard')) return 'Billboard'
  if (n.includes('Visibility')) return 'Vis'
  if (n.includes('AudioSource')) return 'Audio'
  if (n.includes('VideoPlayer')) return 'Video'
  return n.length > 18 ? n.slice(0, 18) : n
}

function recordSystemMs(name: string, ms: number): void {
  if (ms < 0.05) return
  const key = name || 'anonymous'
  const prev = systemMsEma.get(key) ?? 0
  systemMsEma.set(key, prev * 0.65 + ms * 0.35)
  if (systemMsEma.size > TOP_EMA_SIZE) {
    let worst = ''
    let worstMs = Infinity
    for (const [n, v] of systemMsEma) {
      if (v < worstMs) {
        worstMs = v
        worst = n
      }
    }
    if (worst) systemMsEma.delete(worst)
  }
}

/** Call at the start of every engine.update wrap. */
export function beginEngUpdatePhase(dt: number): void {
  gate.active = true
  gate.t0 = performance.now()
  gate.dt = dt
  gate.systemsLoopStart = 0
  gate.systemsLoopEnd = 0
  gate.systemsMs = 0
  gate.reactMs = 0
  gate.systemRun = 0
  gate.systemCount = 0
  gate.systemsLoop = false
  gate.crdtMs = 0
  gate.crdtCalls = 0
  gate.crdtBytes = 0
  gate.crdtAckCalls = 0
  gate.crdtAckMs = 0
  gate.firstCrdtAt = 0
  gate.lastCrdtAt = 0
  gate.crdtPaths.clear()
  gate.dumpStartAt = 0
  gate.dumpEndAt = 0
  gate.dumpComps = 0
  gate.dumpMsgs = 0
  gate.getCrdtSumMs = 0
  gate.transportFilterMs = 0
  gate.transportFilterCalls = 0
  gate.transportSendNote = ''
  gate.sendBinaryNote = ''
  crdtCompMs.clear()
  crdtCompYields.clear()
}

/**
 * Phase 0.5i — tag network sendBinary path for slow [wsp0] lines.
 * `fast` = empty resolve without await · `poll` = kicked empty main hop · `wait` = outbound await.
 */
export function noteSendBinaryPath(tag: 'fast' | 'poll' | 'wait' | 'async'): void {
  if (!gate.active) return
  if (!gate.sendBinaryNote) {
    gate.sendBinaryNote = tag
    return
  }
  if (!gate.sendBinaryNote.split('+').includes(tag)) {
    gate.sendBinaryNote = `${gate.sendBinaryNote}+${tag}`
  }
}

/** Systems-loop partition entered (after receiveMessages). */
export function noteSystemsLoopBegin(systemCount: number): void {
  if (!gate.active) return
  gate.systemsLoop = true
  gate.systemsLoopStart = performance.now()
  gate.systemCount = systemCount
}

/** Time one system.fn invocation (behavior unchanged — only measures). */
export function noteSystemRun(name: string | undefined, run: () => void): void {
  if (!gate.active) {
    run()
    return
  }
  const a = performance.now()
  run()
  const ms = performance.now() - a
  gate.systemRun++
  recordSystemMs(name || 'anonymous', ms)
}

export function addSystemsWallMs(ms: number): void {
  if (!gate.active || ms <= 0) return
  gate.systemsMs += ms
}

export function addReactWallMs(ms: number): void {
  if (!gate.active || ms <= 0) return
  gate.reactMs += ms
}

export function noteSystemsLoopEnd(): void {
  if (!gate.active) return
  gate.systemsLoopEnd = performance.now()
  if (gate.systemsLoopStart > 0 && gate.systemsMs <= 0) {
    gate.systemsMs = Math.max(0, gate.systemsLoopEnd - gate.systemsLoopStart - gate.reactMs)
  }
}

/**
 * Record one crdtSendToRenderer (rpcCrdt) wall time + Phase 0.5 path tag.
 * @param awaitedAck true when the call waited on crdt-outbound-ack / crdt-send response
 * @param path short outcome tag (cold, ack, empty-nudge, …)
 */
export function noteCrdtSendToRenderer(
  ms: number,
  bytes: number,
  awaitedAck: boolean,
  path: CrdtSendPath | string = 'other'
): void {
  if (!gate.active || ms < 0) return
  const now = performance.now()
  if (gate.firstCrdtAt <= 0) gate.firstCrdtAt = now - Math.max(0, ms)
  gate.lastCrdtAt = now
  gate.crdtCalls++
  gate.crdtMs += ms
  gate.crdtBytes += Math.max(0, bytes)
  if (awaitedAck) {
    gate.crdtAckCalls++
    gate.crdtAckMs += ms
  }
  const key = path || 'other'
  gate.crdtPaths.set(key, (gate.crdtPaths.get(key) ?? 0) + 1)
}

function formatCrdtPaths(paths: Map<string, number> | Record<string, number>): string {
  const entries =
    paths instanceof Map
      ? [...paths.entries()]
      : Object.entries(paths)
  if (!entries.length) return '—'
  entries.sort((a, b) => b[1] - a[1])
  return entries
    .slice(0, 8)
    .map(([k, n]) => `${k}:${n}`)
    .join('|')
}

/** Call in finally after nativeUpdate resolves. */
export function endEngUpdatePhase(): EngUpdatePhaseSnapshot {
  const now = performance.now()
  const totalMs = gate.active ? now - gate.t0 : 0
  const preMs =
    gate.systemsLoop && gate.systemsLoopStart > 0
      ? Math.max(0, gate.systemsLoopStart - gate.t0)
      : 0
  const systemsMs = gate.systemsMs
  const reactMs = gate.reactMs
  const sendMs =
    gate.systemsLoop && gate.systemsLoopEnd > 0
      ? Math.max(0, now - gate.systemsLoopEnd)
      : Math.max(0, totalMs - systemsMs - reactMs - preMs)

  // Phase 0.5 — split send wall.
  // encode: systems end → entry into first rpcCrdt (SDK dirty dump + buffer).
  // xport:  nested rpcCrdt walls (usually ~0 in play — fire-and-forget cold buffer).
  // tail:   after last rpcCrdt returns until update resolves.
  let sendEncodeMs = 0
  let sendTransportMs = gate.crdtMs
  let sendTailMs = 0
  if (gate.systemsLoopEnd > 0) {
    if (gate.firstCrdtAt > 0) {
      sendEncodeMs = Math.max(0, gate.firstCrdtAt - gate.systemsLoopEnd)
      sendTailMs = Math.max(0, now - gate.lastCrdtAt)
    } else {
      // No transport call — entire send wall is encode/filter with empty payload.
      sendEncodeMs = sendMs
      sendTransportMs = 0
      sendTailMs = 0
    }
  }

  // Phase 0.5c — encode sub-split.
  let encPreMs = 0
  let encDumpMs = 0
  let encPostMs = 0
  if (gate.systemsLoopEnd > 0 && gate.dumpStartAt > 0 && gate.dumpEndAt > 0) {
    encPreMs = Math.max(0, gate.dumpStartAt - gate.systemsLoopEnd)
    encDumpMs = Math.max(0, gate.dumpEndAt - gate.dumpStartAt)
    const afterDump = gate.firstCrdtAt > 0 ? gate.firstCrdtAt : now
    encPostMs = Math.max(0, afterDump - gate.dumpEndAt)
  } else if (sendEncodeMs > 0) {
    // Dump wrap miss — keep residual visible as post.
    encPostMs = sendEncodeMs
  }

  const pathsObj: Record<string, number> = {}
  for (const [k, v] of gate.crdtPaths) pathsObj[k] = v

  const snap: EngUpdatePhaseSnapshot = {
    totalMs,
    preMs,
    systemsMs,
    reactMs,
    sendMs,
    sendEncodeMs,
    sendTransportMs,
    sendTailMs,
    crdtMs: gate.crdtMs,
    crdtCalls: gate.crdtCalls,
    crdtBytes: gate.crdtBytes,
    crdtAckCalls: gate.crdtAckCalls,
    crdtAckMs: gate.crdtAckMs,
    crdtPaths: pathsObj,
    systemRun: gate.systemRun,
    systemCount: gate.systemCount,
    systemsLoop: gate.systemsLoop,
    dt: gate.dt
  }
  lastSnapshot = snap
  gate.active = false
  passCount++

  if (totalMs >= SLOW_MS) {
    const t = performance.now()
    if (t - lastSlowLogAt >= SLOW_LOG_MIN_INTERVAL_MS) {
      lastSlowLogAt = t
      const top = getEngUpdateTopSystems(TOP_LOG)
        .map((x) => `${x.name.slice(0, 28)}:${x.ms.toFixed(0)}`)
        .join(' ')
      // Phase 0.5b — which components spent time in getCrdtUpdates produce (serialize).
      const encTop = [...crdtCompMs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, ms]) => {
          const y = crdtCompYields.get(name) ?? 0
          return y > 0 ? `${name}:${ms.toFixed(0)}ms×${y}` : `${name}:${ms.toFixed(0)}ms`
        })
        .join(' ')
      // encode vs xport: when encode dominates, split dump vs transport prep —
      // not HOT/COLD systems pie and not main ack (play mode is fire-and-forget).
      console.warn(
        `[wsp0] eng.update ${totalMs.toFixed(0)}ms ` +
          `pre=${preMs.toFixed(0)} systems=${systemsMs.toFixed(0)} react=${reactMs.toFixed(0)} ` +
          `send=${sendMs.toFixed(0)}(enc=${sendEncodeMs.toFixed(0)}` +
          ` preDump=${encPreMs.toFixed(0)} dump=${encDumpMs.toFixed(0)} postDump=${encPostMs.toFixed(0)}` +
          ` xport=${sendTransportMs.toFixed(0)} tail=${sendTailMs.toFixed(0)}) ` +
          `crdt=${snap.crdtMs.toFixed(0)}ms×${snap.crdtCalls}` +
          `(ack=${snap.crdtAckCalls}/${snap.crdtAckMs.toFixed(0)}ms b=${snap.crdtBytes}) ` +
          `path=${formatCrdtPaths(gate.crdtPaths)} ` +
          `dump=${gate.dumpComps}c/${gate.dumpMsgs}m getCrdt=${gate.getCrdtSumMs.toFixed(0)}ms ` +
          `xfilt=${gate.transportFilterMs.toFixed(0)}ms×${gate.transportFilterCalls}` +
          `${gate.transportSendNote ? ` xsend=${gate.transportSendNote}` : ''}` +
          `${gate.sendBinaryNote ? ` sb=${gate.sendBinaryNote}` : ''} ` +
          `encTop=${encTop || '—'} ` +
          `n=${snap.systemRun}/${snap.systemCount} loop=${snap.systemsLoop ? 1 : 0} dt=${snap.dt.toFixed(3)} ` +
          `top=${top || '—'}`
      )
    }
  } else if (
    !!(globalThis as { __THREEJS_SCENEWORKER_PERF__?: boolean }).__THREEJS_SCENEWORKER_PERF__ &&
    passCount % 120 === 0
  ) {
    const top = getEngUpdateTopSystems(4)
      .map((x) => `${x.name.slice(0, 20)}:${x.ms.toFixed(0)}`)
      .join(' ')
    console.info(
      `[wsp0] ok total=${totalMs.toFixed(1)}ms pre=${preMs.toFixed(1)} sys=${systemsMs.toFixed(1)} ` +
        `react=${reactMs.toFixed(1)} send=${sendMs.toFixed(1)}(enc=${sendEncodeMs.toFixed(1)}) ` +
        `crdt=${snap.crdtMs.toFixed(1)}×${snap.crdtCalls} path=${formatCrdtPaths(pathsObj)} ` +
        `top=${top || '—'}`
    )
  }

  return snap
}
