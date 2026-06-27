/** Max custom avatar upload / P2P transfer size (35 MiB). */
export const VRM_MAX_BYTES = 35 * 1024 * 1024

export const VRM_EQUIP_STORAGE_KEY = 'dcl-client-vrm-equip'

export const VRM_LIBRARY_META_KEY = 'dcl-client-vrm-library-meta'

export type CustomAvatarFormat = 'vrm' | 'odk'

export const DavAvatarFormat = {
  vrm: 0,
  odk: 1
} as const