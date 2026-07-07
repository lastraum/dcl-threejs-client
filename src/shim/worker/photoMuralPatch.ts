/** Genesis photo mural — `n?.data[0]` throws when Places API omits `data`. */
const UNSAFE_DATA_INDEX = '?.data[0]'
const SAFE_DATA_INDEX = '?.data?.[0]'

export type PhotoMuralPatchResult = {
  code: string
  applied: boolean
  replacements: number
}

/** Fix optional chaining so missing `data` does not crash `initPhotoMuralSystem`. */
export function patchPhotoMuralOptionalChain(code: string): PhotoMuralPatchResult {
  if (!code.includes('initPhotoMuralSystem') || !code.includes(UNSAFE_DATA_INDEX)) {
    return { code, applied: false, replacements: 0 }
  }

  let replacements = 0
  const out = code.replaceAll(UNSAFE_DATA_INDEX, () => {
    replacements++
    return SAFE_DATA_INDEX
  })

  return { code: out, applied: replacements > 0, replacements }
}