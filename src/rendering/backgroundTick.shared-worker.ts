/**
 * Shared across same-origin tabs. Chrome does not intensively throttle a
 * SharedWorker while any connected document is visible — so a focused
 * /localpreview tab keeps the hidden one waking for comms + sim.
 */
const ports: MessagePort[] = []
let timer = 0
const INTERVAL_MS = 100

function broadcast(): void {
  for (const port of ports) {
    try {
      port.postMessage(0)
    } catch {
      /* port closed */
    }
  }
}

function ensureTimer(): void {
  if (timer) return
  timer = self.setInterval(broadcast, INTERVAL_MS)
}

function drop(port: MessagePort): void {
  const i = ports.indexOf(port)
  if (i >= 0) ports.splice(i, 1)
  try {
    port.close()
  } catch {
    /* already closed */
  }
  if (!ports.length && timer) {
    self.clearInterval(timer)
    timer = 0
  }
}

self.addEventListener('connect', (event: Event) => {
  const port = (event as MessageEvent).ports[0]
  if (!port) return
  ports.push(port)
  port.onmessage = (ev: MessageEvent) => {
    if (ev.data === 'stop') drop(port)
  }
  port.start()
  ensureTimer()
})
