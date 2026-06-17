export type BodyShape = 'male' | 'female'

export type WearableCategory =
  | 'body_shape'
  | 'skin'
  | 'upper_body'
  | 'lower_body'
  | 'feet'
  | 'hair'
  | 'eyes'
  | 'eyebrows'
  | 'mouth'
  | 'helmet'
  | 'hat'
  | 'top_head'
  | 'mask'
  | 'eyewear'
  | 'earring'
  | 'tiara'
  | 'facial_hair'
  | 'hands_wear'

export type WearableRepresentation = {
  bodyShapes: string[]
  mainFile: string
  contents: Array<{ key: string; url: string }>
}

export type WearableDefinition = {
  id: string
  data: {
    category: WearableCategory
    hides?: string[]
    replaces?: string[]
    removesDefaultHiding?: string[]
    representations: WearableRepresentation[]
  }
}

export type AvatarProfile = {
  bodyShape: BodyShape
  skin: string
  hair: string
  eyes: string
  wearables: string[]
  forceRender: string[]
  emotes: ProfileEmoteSlot[]
  /** True when loaded from a Catalyst wallet profile (skip default outfit fill). */
  fromWallet: boolean
  address?: string
  displayName?: string
  nameColor?: string
  hasClaimedName?: boolean
}

export type ProfileEmoteSlot = {
  slot: number
  urn: string
}

export type AvatarComposeConfig = {
  bodyShape: BodyShape
  skin: string
  hair: string
  eyes: string
  wearables: WearableDefinition[]
  forceRender: string[]
}
