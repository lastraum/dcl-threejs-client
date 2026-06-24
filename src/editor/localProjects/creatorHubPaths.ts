/** Default Creator Hub `settings.scenesPath` locations (matches Creator Hub app data). */

export function defaultCreatorHubScenesPath(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const platform = typeof navigator !== 'undefined' ? navigator.platform : ''

  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Macintosh/i.test(ua)) {
    return '~/Library/Application Support/creator-hub/Scenes'
  }

  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return '%APPDATA%\\creator-hub\\Scenes'
  }

  return '~/.config/creator-hub/Scenes'
}

export function creatorHubProjectId(folderName: string): string {
  return `creator-hub:${folderName}`
}

export function isCreatorHubProjectId(projectId: string): boolean {
  return projectId.startsWith('creator-hub:')
}