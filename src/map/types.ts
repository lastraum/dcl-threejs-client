export type LivePeer = {
  address: string
  parcel: [number, number]
  position: { x: number; y: number; z: number }
  lastPing: number
}

export type PlayerProfile = {
  displayName: string
  faceUrl: string | null
}

export type ParcelInfo = {
  px: number
  py: number
  sceneName: string | null
  parcelLabel: string
  description: string
  imageUrl: string
  mapImageUrl: string
}

export type WorldLiveEntry = {
  worldName: string
  users: number
}

export type WorldsLiveData = {
  totalUsers: number
  perWorld: WorldLiveEntry[]
  lastUpdated: string | null
}

export type ArchipelagoConnectionState = 'idle' | 'loading' | 'live' | 'error'
export type WorldsConnectionState = 'idle' | 'loading' | 'live' | 'error'
