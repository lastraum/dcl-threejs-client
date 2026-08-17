/**
 * Preview /about lambdas + content are the local scene server, not a Catalyst.
 * Profile + wearable lookups must stay on genesis-city peers.
 */
import { PEER_URL } from './constants'
import { isLocalPreviewHttpUrl } from '../network/preview/wsSceneMessage'

export function genesisCatalystEndpoints(): { contentUrl: string; lambdasUrl: string } {
  return { contentUrl: PEER_URL, lambdasUrl: `${PEER_URL}/lambdas` }
}

/** True when a realm URL is Creator Hub / sdk-commands preview HTTP. */
export function isLocalPreviewCatalystUrl(url: string | null | undefined): boolean {
  return isLocalPreviewHttpUrl(url)
}

/**
 * Scene realm endpoints for avatar/profile Catalyst traffic.
 * Local preview origin is remapped — that host only serves the scene bundle.
 */
export function catalystEndpointsForRealm(
  contentUrl: string,
  lambdasUrl: string
): { contentUrl: string; lambdasUrl: string; skipProfileFetch: boolean } {
  if (isLocalPreviewHttpUrl(contentUrl) || isLocalPreviewHttpUrl(lambdasUrl)) {
    return { ...genesisCatalystEndpoints(), skipProfileFetch: true }
  }
  return {
    contentUrl: contentUrl.replace(/\/$/, ''),
    lambdasUrl: lambdasUrl.replace(/\/$/, ''),
    skipProfileFetch: false
  }
}

/** Wearable entity lookup host — never the preview scene server. */
export function catalystContentUrlForWearables(contentUrl?: string): string {
  if (!contentUrl || isLocalPreviewHttpUrl(contentUrl)) return PEER_URL
  return contentUrl.replace(/\/$/, '')
}
