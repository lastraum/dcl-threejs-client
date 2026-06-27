import { creatorHubPathProjectId, creatorHubProjectId } from './creatorHubPaths'

export type CreatorHubConfig = {
  settings?: { scenesPath?: string }
  workspace?: { paths?: string[] }
}

export function parseCreatorHubConfig(json: unknown): CreatorHubConfig {
  if (!json || typeof json !== 'object') return {}
  const root = json as Record<string, unknown>
  const settings =
    root.settings && typeof root.settings === 'object'
      ? {
          scenesPath:
            typeof (root.settings as Record<string, unknown>).scenesPath === 'string'
              ? ((root.settings as Record<string, unknown>).scenesPath as string)
              : undefined
        }
      : undefined
  const workspace =
    root.workspace && typeof root.workspace === 'object'
      ? {
          paths: Array.isArray((root.workspace as Record<string, unknown>).paths)
            ? ((root.workspace as Record<string, unknown>).paths as unknown[]).filter(
                (p): p is string => typeof p === 'string' && p.trim().length > 0
              )
            : []
        }
      : undefined
  return { settings, workspace }
}

export function folderNameFromPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export type CreatorHubConfigEntry = {
  id: string
  folderName: string
  pathHint: string
  underScenesPath: boolean
}

export function entriesFromCreatorHubConfig(config: CreatorHubConfig): CreatorHubConfigEntry[] {
  const paths = config.workspace?.paths ?? []
  const scenesPath = config.settings?.scenesPath?.replace(/[/\\]+$/, '')
  const seen = new Set<string>()
  const out: CreatorHubConfigEntry[] = []

  for (const path of paths) {
    const folderName = folderNameFromPath(path)
    const underScenesPath = Boolean(scenesPath && path.startsWith(scenesPath))
    const id = underScenesPath ? creatorHubProjectId(folderName) : creatorHubPathProjectId(path)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, folderName, pathHint: path, underScenesPath })
  }

  return out
}

export function defaultCreatorHubConfigPath(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const platform = typeof navigator !== 'undefined' ? navigator.platform : ''

  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Macintosh/i.test(ua)) {
    return '~/Library/Application Support/creator-hub/Settings/config.json'
  }

  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return '%APPDATA%\\creator-hub\\Settings\\config.json'
  }

  return '~/.config/creator-hub/Settings/config.json'
}