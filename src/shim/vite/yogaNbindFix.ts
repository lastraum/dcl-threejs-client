const NBIND_FIX =
  '_nbind.bigEndian = false;_a = _typeModule(_typeModule), _nbind.Type = _a.Type, _nbind.makeType = _a.makeType, _nbind.getComplexType = _a.getComplexType, _nbind.structureList = _a.structureList;' as const
const NBIND_FIXED =
  '_nbind.bigEndian = false;var _a = _typeModule(_typeModule); _nbind.Type = _a.Type; _nbind.makeType = _a.makeType; _nbind.getComplexType = _a.getComplexType; _nbind.structureList = _a.structureList;' as const

/** yoga-layout-prebuilt nbind.js assigns `_a` without declaring it — breaks Vite prebundle. */
export function patchYogaNbindSource(source: string): string {
  if (!source.includes(NBIND_FIX)) return source
  return source.replace(NBIND_FIX, NBIND_FIXED)
}