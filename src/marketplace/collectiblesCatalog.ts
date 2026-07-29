/** Wearable slot groups for Collectibles sidebar (DCL browse taxonomy). */

export type CollectiblesCategoryId =
  | 'wearables'
  | 'emotes'
  | `wearable:${string}`

export type CollectiblesNavNode = {
  id: CollectiblesCategoryId
  label: string
  /** marketplace-api top-level category */
  apiCategory: 'wearable' | 'emote'
  /** marketplace-api wearableCategory when set */
  wearableCategory?: string
  children?: CollectiblesNavNode[]
}

export const COLLECTIBLES_NAV: CollectiblesNavNode[] = [
  {
    id: 'wearables',
    label: 'Wearables',
    apiCategory: 'wearable',
    children: [
      { id: 'wearable:hat', label: 'Hat', apiCategory: 'wearable', wearableCategory: 'hat' },
      { id: 'wearable:helmet', label: 'Helmet', apiCategory: 'wearable', wearableCategory: 'helmet' },
      { id: 'wearable:hair', label: 'Hair', apiCategory: 'wearable', wearableCategory: 'hair' },
      {
        id: 'wearable:facial_hair',
        label: 'Facial hair',
        apiCategory: 'wearable',
        wearableCategory: 'facial_hair'
      },
      { id: 'wearable:eyes', label: 'Eyes', apiCategory: 'wearable', wearableCategory: 'eyes' },
      {
        id: 'wearable:eyebrows',
        label: 'Eyebrows',
        apiCategory: 'wearable',
        wearableCategory: 'eyebrows'
      },
      { id: 'wearable:mouth', label: 'Mouth', apiCategory: 'wearable', wearableCategory: 'mouth' },
      { id: 'wearable:mask', label: 'Mask', apiCategory: 'wearable', wearableCategory: 'mask' },
      {
        id: 'wearable:eyewear',
        label: 'Eyewear',
        apiCategory: 'wearable',
        wearableCategory: 'eyewear'
      },
      {
        id: 'wearable:earring',
        label: 'Earring',
        apiCategory: 'wearable',
        wearableCategory: 'earring'
      },
      { id: 'wearable:tiara', label: 'Tiara', apiCategory: 'wearable', wearableCategory: 'tiara' },
      {
        id: 'wearable:top_head',
        label: 'Top head',
        apiCategory: 'wearable',
        wearableCategory: 'top_head'
      },
      {
        id: 'wearable:upper_body',
        label: 'Upper body',
        apiCategory: 'wearable',
        wearableCategory: 'upper_body'
      },
      {
        id: 'wearable:lower_body',
        label: 'Lower body',
        apiCategory: 'wearable',
        wearableCategory: 'lower_body'
      },
      { id: 'wearable:feet', label: 'Feet', apiCategory: 'wearable', wearableCategory: 'feet' },
      {
        id: 'wearable:hands_wear',
        label: 'Hands',
        apiCategory: 'wearable',
        wearableCategory: 'hands_wear'
      },
      { id: 'wearable:skin', label: 'Skins', apiCategory: 'wearable', wearableCategory: 'skin' }
    ]
  },
  {
    id: 'emotes',
    label: 'Emotes',
    apiCategory: 'emote'
  }
]

export function findCollectiblesNavNode(id: CollectiblesCategoryId): CollectiblesNavNode | null {
  for (const node of COLLECTIBLES_NAV) {
    if (node.id === id) return node
    for (const child of node.children ?? []) {
      if (child.id === id) return child
    }
  }
  return null
}

export const COLLECTIBLES_PAGE_SIZE = 48
