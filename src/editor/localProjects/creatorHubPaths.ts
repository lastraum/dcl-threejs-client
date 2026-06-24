/**
 * Browser-friendly folder for scene projects (Documents/Downloads/Desktop work;
 * ~/Library/Application Support/creator-hub/Scenes is often blocked).
 */
export const RECOMMENDED_SCENES_FOLDER = '~/Documents/DCL-Scenes'

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

/** Stable id for Creator Hub workspace paths outside the default Scenes folder. */
export function creatorHubPathProjectId(fullPath: string): string {
  let h = 0
  for (let i = 0; i < fullPath.length; i++) {
    h = (Math.imul(31, h) + fullPath.charCodeAt(i)) | 0
  }
  return `creator-hub-path:${(h >>> 0).toString(36)}`
}

export function isCreatorHubProjectId(projectId: string): boolean {
  return projectId.startsWith('creator-hub:') || projectId.startsWith('creator-hub-path:')
}