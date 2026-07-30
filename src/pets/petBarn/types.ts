import type { PetCategory } from '../types'

export type PetBarnListing = {
  id: string
  petName: string
  creatorName: string
  type: PetCategory
  animationCount: number
  clipNames?: string[]
  parcel: string
  glbFile?: string
  glbCid: string
  thumbnailFile?: string
  thumbnailCid: string
  sizeBytes: number
  thumbnailSizeBytes?: number
  submittedAt?: string
  deployedAt: string
  wallet?: string
}

export type PetBarnCatalog = {
  version: number
  world: string
  contentBaseUrl: string
  updatedAt: string
  nextParcel: { x: number; y: number }
  pets: PetBarnListing[]
}

export type PetBarnAddedEntry = {
  barnId: string
  contentHash: string
  glbCid: string
  addedAt: number
  petName: string
  type: PetCategory
}

export type PetBarnAddedMap = Record<string, PetBarnAddedEntry>

export type SubmitPetBarnInput = {
  petName: string
  creatorName: string
  type: PetCategory
  glb: File
  thumb: File | Blob
  wallet?: string
}

export type SubmitPetBarnResult =
  | { ok: true; id: string; issueUrl?: string; message?: string }
  | { ok: false; error: string }
