import {
  PETBARN_CATALOG_URL_DEFAULT,
  PETBARN_CONTENT_BASE_DEFAULT,
  PETBARN_WORKER_URL_DEFAULT
} from './constants'

export function petBarnCatalogUrl(): string {
  const fromEnv = import.meta.env.VITE_PETBARN_CATALOG_URL
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return PETBARN_CATALOG_URL_DEFAULT
}

/** null = dispatch disabled */
export function petBarnDispatchUrl(): string | null {
  if (typeof window === 'undefined') return null
  const fromEnv = import.meta.env.VITE_PETBARN_DISPATCH_URL
  if (fromEnv === '0' || fromEnv === 'false') return null
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  try {
    if (localStorage.getItem('petBarnDispatch') === '0') return null
  } catch {
    /* ignore */
  }
  // Dev: optional same-origin proxy if wired; else prod worker.
  if (import.meta.env.DEV) {
    // Prefer worker URL in dev too unless proxy is configured later.
    return PETBARN_WORKER_URL_DEFAULT
  }
  return PETBARN_WORKER_URL_DEFAULT
}

export function petBarnContentBase(catalogBase?: string): string {
  const base = (catalogBase || PETBARN_CONTENT_BASE_DEFAULT).trim()
  return base.endsWith('/') ? base : `${base}/`
}

export function petBarnContentUrl(contentBaseUrl: string, cid: string): string {
  return `${petBarnContentBase(contentBaseUrl)}${cid}`
}
