/** Quick validation for patchEngineSystemLoopPartition output. */
import { readFileSync } from 'node:fs'

const loopRe =
  /for\(let (\w+) of (\w+)\.getSystems\(\)\)\{let (\w+)=\1\.fn\((\w+)\);(\(0,\w+\.\w+\)|\w+)\(\3,(`A system \(\$\{\1\.name\|\|"anonymous"\}\) returned a thenable\. Systems cannot be async functions\. Documentation: https:\/\/dcl\.gg\/sdk\/sync-systems`)\)\}/g

function patchEngineSystemLoopPartition(code) {
  if (!code.includes('.getSystems()')) return code
  if (!loopRe.test(code)) return code
  loopRe.lastIndex = 0
  return code.replace(
    loopRe,
    'globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__&&globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__($2.getSystems(),$4,($1,$4)=>{let $3=$1.fn($4);$5($3,$6)})'
  )
}

function patchEngineSystemLoopPartitionFixed(code) {
  if (!code.includes('.getSystems()')) return code
  if (!loopRe.test(code)) return code
  loopRe.lastIndex = 0
  const hook = 'globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__'
  return code.replace(loopRe, (_m, sysVar, engVar, retVar, dtVar, checkFn, errTpl) => {
    const msg = errTpl.replace(new RegExp(`\\$\\{${sysVar}\\.name`, 'g'), '${__sys.name')
    return `${hook}&&${hook}(${engVar}.getSystems(),${dtVar},(__sys,__dt)=>{let ${retVar}=__sys.fn(__dt);${checkFn}(${retVar},${msg})});`
  })
}

const samples = [
  'for(let n of t.getSystems()){let i=n.fn(e);(0,r.assertThenable)(i,`A system (${n.name||"anonymous"}) returned a thenable. Systems cannot be async functions. Documentation: https://dcl.gg/sdk/sync-systems`)}',
  'for(let e of t.getSystems()){let i=e.fn(e);check(i,`A system (${e.name||"anonymous"}) returned a thenable. Systems cannot be async functions. Documentation: https://dcl.gg/sdk/sync-systems`)}',
]

for (const [name, fn] of [
  ['broken', patchEngineSystemLoopPartition],
  ['fixed', patchEngineSystemLoopPartitionFixed],
]) {
  for (let i = 0; i < samples.length; i++) {
    const patched = fn(samples[i])
    try {
      new Function(patched)
      console.log(`${name} sample${i}: COMPILE OK`)
    } catch (e) {
      console.log(`${name} sample${i}: COMPILE FAIL — ${e.message}`)
      console.log(patched.slice(0, 200))
    }
  }
}

const bundlePath = process.argv[2]
if (bundlePath) {
  const code = readFileSync(bundlePath, 'utf8')
  let matches = 0
  loopRe.lastIndex = 0
  while (loopRe.exec(code)) matches++
  console.log(`\nBundle ${bundlePath}: ${matches} loop(s)`)
  for (const [name, fn] of [
    ['broken', patchEngineSystemLoopPartition],
    ['fixed', patchEngineSystemLoopPartitionFixed],
  ]) {
    const patched = fn(code)
    const hookCount = (patched.match(/__THREEJS_ENGINE_SYSTEM_LOOP__/g) || []).length
    try {
      new Function(patched)
      console.log(`${name}: full bundle COMPILE OK (hooks=${hookCount})`)
    } catch (e) {
      console.log(`${name}: full bundle COMPILE FAIL — ${e.message} (hooks=${hookCount})`)
      // find first broken patch vicinity
      const idx = patched.indexOf('__THREEJS_ENGINE_SYSTEM_LOOP__')
      if (idx >= 0) console.log('snippet:', patched.slice(idx, idx + 300))
    }
  }
}