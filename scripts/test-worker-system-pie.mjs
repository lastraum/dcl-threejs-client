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
function isHot(name, pointer = false) {
  if (name.startsWith('@dcl/react-ecs')) return false
  if (pointer) return true
  if (!name) return true
  if (name.startsWith('@dcl/')) return true
  if (HOT_SDK.has(name)) return true
  return false // residual COLD under hard wall
}
const cases = [
  ['TriggerAreaResultSystem', false, true],
  ['EventSystem', false, true],
  ['@dcl/ecs#inputSystem', false, true],
  ['@dcl/react-ecs', false, false],
  ['', false, true],
  ['fishingBobber', false, false],
  ['fishingBobber', true, true],
]
let fail = 0
for (const [n, ptr, want] of cases) {
  const got = isHot(n, ptr)
  if (got !== want) {
    console.error('FAIL', n, ptr, 'want', want, 'got', got)
    fail++
  }
}
if (fail) process.exit(1)
console.log('ok', cases.length, 'cases')
