/** Max pet GLB upload / P2P transfer size (16 MiB). */
export const PET_MAX_BYTES = 16 * 1024 * 1024

export const PET_INVENTORY_STORAGE_KEY = 'dcl-client-pet-inventory'
export const PET_LIBRARY_META_KEY = 'dcl-client-pet-library-meta'

/** Payload bytes per LiveKit reliable packet (room for RFC4 + DPET headers). */
export const DPET_CHUNK_DATA_SIZE = 6_000
