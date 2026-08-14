/**
 * WSP Phase 0.5d — patch SDK sendMessages network size check.
 *
 * Stock @dcl/ecs sendMessages does:
 *   currentBufferSize = transportBuffer.toBinary().byteLength
 * per message for LIVEKIT_MAX_SIZE (network transport only).
 *
 * ReadWriteByteBuffer.toBinary() is a subarray view (cheap), but minified bundles
 * and older patterns may copy; currentWriteOffset() is the authored write cursor
 * and is always O(1) and equal to toBinary().byteLength for sequential writes.
 *
 * Does NOT rewrite payload paths: `transportBuffer.toBinary()` without `.byteLength`
 * (final send) is left intact.
 *
 * @see docs/WORKER_SYSTEM_PIE_V2.md Phase 0.5d
 */

const SIZE_NEEDLE = '.toBinary().byteLength'
const SIZE_REPLACEMENT = '.currentWriteOffset()'

export function patchCrdtSendBufferSize(code: string): { code: string; replacements: number } {
  if (!code.includes(SIZE_NEEDLE)) return { code, replacements: 0 }
  const parts = code.split(SIZE_NEEDLE)
  const replacements = parts.length - 1
  if (replacements <= 0) return { code, replacements: 0 }
  return { code: parts.join(SIZE_REPLACEMENT), replacements }
}
