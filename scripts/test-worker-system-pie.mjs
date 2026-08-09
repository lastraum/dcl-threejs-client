/** Smoke: HOT classification rules for Worker System Pie (no full worker). */
const HOT_SDK = new Set([
  'TriggerAreaResultSystem',
  'EventSystem',
  'observableSystem',
  'sleepSystem',
  'executeTasks',
  'buttonStateUpdateSystem',
  'TestingFrameworkCoroutineRunner'
])
function isHot(name, ema = 0, pointer = false) {
  if (name.startsWith('@dcl/react-ecs')) return false
  if (pointer) return true
  if (!name) return true
  if (name.startsWith('@dcl/')) return true
  if (HOT_SDK.has(name)) return true
  if (ema >= 1.5) return false
  return true
}
const cases = [
  ['TriggerAreaResultSystem', 0, false, true],
  ['EventSystem', 0, false, true],
  ['@dcl/ecs#inputSystem', 0, false, true],
  ['@dcl/react-ecs', 0, false, false],
  ['', 0, false, true],
  ['fishingBobber', 0, false, true],
  ['fishingBobber', 3, false, false],
  ['fishingBobber', 3, true, true],
]
let fail = 0
for (const [n, ema, ptr, want] of cases) {
  const got = isHot(n, ema, ptr)
  if (got !== want) {
    console.error('FAIL', n, ema, ptr, 'want', want, 'got', got)
    fail++
  }
}
if (fail) process.exit(1)
console.log('ok', cases.length, 'cases')
