/**
 * D3JS-exclusive avatar colors (brows / facial hair) — not part of the Catalyst
 * profile schema, so they live in localStorage and propagate to remote D3JS
 * clients via `avatar.d3js` extension keys on the serialized comms profile.
 * Unset channels fall back to the profile hair color.
 */

const STORAGE_KEY = 'dcl-client-extended-colors'

export type ExtendedAvatarColors = {
  /** Eyebrows tint (6-char hex, no `#`). */
  brows?: string
  /** Facial hair tint (6-char hex, no `#`). */
  facialHair?: string
}

type ColorStore = Record<string, ExtendedAvatarColors>

const HEX6 = /^[0-9a-f]{6}$/

/** `#AaBbCc` / `abc` → `aabbcc`, or null when not a usable color. */
export function normalizeExtendedColorHex(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string') return null
  let raw = hex.replace('#', '').trim().toLowerCase()
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('')
  return HEX6.test(raw) ? raw : null
}

function normalizeEntry(value: unknown): ExtendedAvatarColors | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const brows = normalizeExtendedColorHex(record.brows as string | undefined)
  const facialHair = normalizeExtendedColorHex(record.facialHair as string | undefined)
  if (!brows && !facialHair) return null
  return {
    ...(brows ? { brows } : {}),
    ...(facialHair ? { facialHair } : {})
  }
}

function readStore(): ColorStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ColorStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: ColorStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[avatar] failed to persist extended colors', err)
  }
}

export function getExtendedAvatarColors(address?: string | null): ExtendedAvatarColors {
  if (!address) return {}
  return normalizeEntry(readStore()[address.toLowerCase()]) ?? {}
}

/** Set one channel; pass null to clear it (falls back to hair color again). */
export function setExtendedAvatarColor(
  address: string,
  channel: keyof ExtendedAvatarColors,
  hex: string | null
): void {
  const key = address.toLowerCase()
  const store = readStore()
  const next: ExtendedAvatarColors = { ...(normalizeEntry(store[key]) ?? {}) }
  const normalized = hex === null ? null : normalizeExtendedColorHex(hex)
  if (normalized) next[channel] = normalized
  else delete next[channel]
  if (next.brows || next.facialHair) store[key] = next
  else delete store[key]
  writeStore(store)
}

/**
 * Re-serialize a comms profile JSON blob with the current extension keys for
 * `address` (`avatar.d3js.browsColor` / `avatar.d3js.facialHairColor`).
 * Loosely typed on purpose — the entry shape belongs to peerApi and only the
 * extension subtree is touched. Returns the input unchanged on parse failure.
 */
export function applyExtendedColorsToSerializedProfile(
  serializedProfile: string,
  address?: string | null
): string {
  const colors = getExtendedAvatarColors(address)
  try {
    const entry = JSON.parse(serializedProfile) as {
      avatar?: { d3js?: { browsColor?: string; facialHairColor?: string } }
    }
    if (!entry?.avatar || typeof entry.avatar !== 'object') return serializedProfile
    if (colors.brows || colors.facialHair) {
      entry.avatar.d3js = {
        ...(colors.brows ? { browsColor: colors.brows } : {}),
        ...(colors.facialHair ? { facialHairColor: colors.facialHair } : {})
      }
    } else {
      delete entry.avatar.d3js
    }
    return JSON.stringify(entry)
  } catch {
    return serializedProfile
  }
}
