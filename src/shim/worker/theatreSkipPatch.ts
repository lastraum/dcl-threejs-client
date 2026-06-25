/** Genesis plaza theatre — skip heavy composite spawn for perf isolation (`?notheatre`). */
export const SKIP_THEATRE_GLOBAL = '__THREEJS_SKIP_THEATRE__'

const RUN_SHOW_SETUP_NEEDLE = 'console.log("runShowSetup"),E0.getInstance().loadShowEntities()'
const RUN_SHOW_SETUP_GUARD =
  'if(globalThis.__THREEJS_SKIP_THEATRE__){console.log("runShowSetup skipped (client)");return;}' +
  RUN_SHOW_SETUP_NEEDLE

const THEATRE_REGISTER_TIMEOUT_NEEDLE = 'qe.setTimeout(()=>{I0e()},15e3)'
const THEATRE_REGISTER_TIMEOUT_GUARD =
  'globalThis.__THREEJS_SKIP_THEATRE__?console.log("theatre scene registration skipped (client)"):' +
  THEATRE_REGISTER_TIMEOUT_NEEDLE

export type TheatreSkipPatchResult = {
  code: string
  applied: string[]
  missed: string[]
}

/** Inject runtime guards — no-op unless `globalThis.__THREEJS_SKIP_THEATRE__` is set before eval. */
export function patchTheatreSkip(code: string): TheatreSkipPatchResult {
  const applied: string[] = []
  const missed: string[] = []
  let out = code

  if (out.includes(RUN_SHOW_SETUP_NEEDLE)) {
    out = out.replace(RUN_SHOW_SETUP_NEEDLE, RUN_SHOW_SETUP_GUARD)
    applied.push('runShowSetup')
  } else {
    missed.push('runShowSetup')
  }

  if (out.includes(THEATRE_REGISTER_TIMEOUT_NEEDLE)) {
    out = out.replace(THEATRE_REGISTER_TIMEOUT_NEEDLE, THEATRE_REGISTER_TIMEOUT_GUARD)
    applied.push('theatreRegisterTimeout')
  } else {
    missed.push('theatreRegisterTimeout')
  }

  return { code: out, applied, missed }
}