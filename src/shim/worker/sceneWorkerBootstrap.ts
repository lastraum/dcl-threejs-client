/** Earliest worker message hook — loads before sceneWorker so inject is never queued behind boot eval. */
const ctx = self

export type SceneWorkerPriorityMessage =
  | { type: 'inject-pointer-click'; body: unknown }
  | { type: 'pointer-crdt-deliver'; data: Uint8Array[] }
  | { type: 'pause-scene-ticks'; paused?: boolean }

const PRIORITY_TYPES = new Set([
  'inject-pointer-click',
  'pointer-crdt-deliver',
  'pause-scene-ticks'
])

const pending: SceneWorkerPriorityMessage[] = []
let dispatch: ((msg: SceneWorkerPriorityMessage) => void) | null = null

export function bindSceneWorkerPriorityDispatch(fn: (msg: SceneWorkerPriorityMessage) => void): void {
  dispatch = fn
  if (!pending.length) return
  const batch = pending.splice(0)
  for (const msg of batch) fn(msg)
}

ctx.addEventListener(
  'message',
  (ev: MessageEvent<SceneWorkerPriorityMessage>) => {
    const msg = ev.data
    const type = (msg as { type?: string })?.type
    if (!type || !PRIORITY_TYPES.has(type)) return
    ev.stopImmediatePropagation()
    if (dispatch) {
      dispatch(msg)
      return
    }
    pending.push(msg)
  },
  { capture: true }
)
