/**
 * End-of-tour CSV + ZIP export (leader-local photos).
 */
import JSZip from 'jszip'
import { followTargetLabel, type TourLocationWire } from './communityFollowWire'
import { listTourLocationPhotos } from './tourLocationPhotoStore'

export type TourExportMeta = {
  communityName: string
  sessionId: string
  startedAt: number
  endedAt: number
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled'
}

function formatDateMdY(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

function coordsLabel(loc: TourLocationWire): string {
  return followTargetLabel(loc.target) || 'unknown'
}

export function buildTourLocationsCsv(
  locations: TourLocationWire[],
  meta: TourExportMeta,
  photoIds: Set<string>
): string {
  const header = [
    'location_id',
    'name',
    'scene_name',
    'coords_or_world',
    'pinned_at_iso',
    'dwell_sec',
    'people',
    'community_name',
    'has_photo'
  ].join(',')
  const rows = locations.map((loc) => {
    const name = loc.name?.trim() || loc.sceneName
    return [
      csvEscape(loc.id),
      csvEscape(name),
      csvEscape(loc.sceneName),
      csvEscape(coordsLabel(loc)),
      csvEscape(new Date(loc.at).toISOString()),
      String(loc.dwellSec ?? 0),
      String(loc.people ?? ''),
      csvEscape(meta.communityName),
      photoIds.has(loc.id) ? 'yes' : 'no'
    ].join(',')
  })
  return [header, ...rows].join('\n')
}

export function photoFileName(
  loc: TourLocationWire,
  communityName: string,
  capturedAt: number
): string {
  const coords = sanitizeFilePart(coordsLabel(loc))
  const locName = sanitizeFilePart(loc.name?.trim() || loc.sceneName)
  const community = sanitizeFilePart(communityName)
  const date = formatDateMdY(capturedAt)
  return `${coords} - ${locName} - ${community} - ${date}.png`
}

export async function buildTourExportZip(
  locations: TourLocationWire[],
  meta: TourExportMeta
): Promise<Blob> {
  const photos = await listTourLocationPhotos(meta.sessionId)
  const byLoc = new Map(photos.map((p) => [p.locationId, p]))
  const csv = buildTourLocationsCsv(locations, meta, new Set(byLoc.keys()))
  const zip = new JSZip()
  zip.file('locations.csv', csv)
  for (const loc of locations) {
    const photo = byLoc.get(loc.id)
    if (!photo) continue
    const name = photoFileName(loc, meta.communityName, photo.capturedAt)
    zip.file(name, photo.blob)
  }
  return zip.generateAsync({ type: 'blob' })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000)
}

export async function downloadTourCsvOnly(
  locations: TourLocationWire[],
  meta: TourExportMeta
): Promise<void> {
  const photos = await listTourLocationPhotos(meta.sessionId)
  const csv = buildTourLocationsCsv(locations, meta, new Set(photos.map((p) => p.locationId)))
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const safe = sanitizeFilePart(meta.communityName)
  downloadBlob(blob, `tour-locations-${safe}-${formatDateMdY(meta.endedAt).replace(/\//g, '-')}.csv`)
}

export async function downloadTourZip(
  locations: TourLocationWire[],
  meta: TourExportMeta
): Promise<void> {
  const blob = await buildTourExportZip(locations, meta)
  const safe = sanitizeFilePart(meta.communityName)
  downloadBlob(blob, `tour-${safe}-${formatDateMdY(meta.endedAt).replace(/\//g, '-')}.zip`)
}
