/** Open Source Avatars registry — https://github.com/ToxSam/open-source-avatars */

export const OSA_DATA_BASE =
  'https://raw.githubusercontent.com/ToxSam/open-source-avatars/main/data/'

export const OSA_GALLERY_URL = 'https://opensourceavatars.com'

export type OsaProject = {
  id: string
  name: string
  license: string
  avatar_data_file: string
  description?: string
}

export type OsaAvatarRecord = {
  id: string
  name: string
  project_id: string
  description?: string
  model_file_url: string
  thumbnail_url?: string
  format?: string
  is_public?: boolean
}

export type OsaGalleryEntry = OsaAvatarRecord & {
  projectName: string
  license: string
}

let cachedCatalog: OsaGalleryEntry[] | null = null
let catalogPromise: Promise<OsaGalleryEntry[]> | null = null

function compareOsaName(a: OsaGalleryEntry, b: OsaGalleryEntry): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function osaAvatarFileName(entry: Pick<OsaGalleryEntry, 'name' | 'project_id'>): string {
  const base =
    entry.name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || entry.project_id
  return `${base}.vrm`
}

export async function fetchOsaGalleryCatalog(): Promise<OsaGalleryEntry[]> {
  if (cachedCatalog) return cachedCatalog
  if (!catalogPromise) {
    catalogPromise = loadOsaGalleryCatalog().then((entries) => {
      cachedCatalog = entries
      return entries
    })
  }
  return catalogPromise
}

async function loadOsaGalleryCatalog(): Promise<OsaGalleryEntry[]> {
  const projectsRes = await fetch(`${OSA_DATA_BASE}projects.json`)
  if (!projectsRes.ok) throw new Error(`OSA projects.json failed (${projectsRes.status})`)
  const projects = (await projectsRes.json()) as OsaProject[]
  const publicProjects = projects.filter((p) => p.avatar_data_file)

  const avatarLists = await Promise.all(
    publicProjects.map(async (project) => {
      const res = await fetch(`${OSA_DATA_BASE}${project.avatar_data_file}`)
      if (!res.ok) {
        console.warn(`[osa] skip ${project.id} — ${res.status}`)
        return [] as OsaGalleryEntry[]
      }
      const rows = (await res.json()) as OsaAvatarRecord[]
      return rows
        .filter((row) => row.model_file_url && row.is_public !== false)
        .map(
          (row): OsaGalleryEntry => ({
            ...row,
            projectName: project.name,
            license: project.license
          })
        )
    })
  )

  return avatarLists.flat().sort(compareOsaName)
}

export function filterOsaGallery(
  catalog: OsaGalleryEntry[],
  query: string
): OsaGalleryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return catalog
  return catalog.filter((entry) => {
    const haystack = [
      entry.name,
      entry.projectName,
      entry.project_id,
      entry.license,
      entry.description ?? ''
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
}