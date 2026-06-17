const PARCEL_POINTER_RE = /^-?\d{1,3},-?\d{1,3}$/

export function normalizePointer(pointer: string): string {
  const parcel = pointer.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, '')
  if (PARCEL_POINTER_RE.test(parcel)) return parcel
  return pointer.trim().toLowerCase()
}

export function isParcelPointer(pointer: string): boolean {
  return PARCEL_POINTER_RE.test(normalizePointer(pointer))
}

/** Genesis parcel → `main`; worlds → lowercase world id (gatekeeper kernel metadata). */
export function realmNameForCommsPointer(pointer: string): string {
  const normalized = normalizePointer(pointer)
  if (isParcelPointer(normalized)) return 'main'
  return normalized
}
