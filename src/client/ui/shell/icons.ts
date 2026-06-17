/** Explorer-style sidebar icon SVGs (24×24 viewBox). */

export const SIDEBAR_ICONS = {
  nearbyVoice: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="9" r="3.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M7.5 14.5c.8 2 2.4 3.5 4.5 3.5s3.7-1.5 4.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M16.5 8.5c1 .8 1.5 1.8 1.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M18.5 6.5c1.6 1.3 2.5 3 2.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`,
  smartWearable: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M13 2 4 14h7l-1 8 10-13h-7l0-7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,
  skybox: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="15.5" cy="9" r="1.6" fill="currentColor"/>
    <path d="M8 14.5c.8.8 2 .8 2.8 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 8.5h3l1.5-2h7l1.5 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17v-7A1.5 1.5 0 0 1 4 8.5z" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="12" cy="13.5" r="2.8" stroke="currentColor" stroke-width="1.5"/>
  </svg>`,
  emotes: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="7" r="2.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8.5 20v-4.5c0-1.9 1.6-3.5 3.5-3.5s3.5 1.6 3.5 3.5V20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M6.5 11.5 4 9M17.5 11.5 20 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  friendRequests: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/>
    <path d="M4.5 18c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M16.5 8.5c1.2.4 2 1.5 2 2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M15.5 14.5c1.8.3 3.2 1.8 3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M17.5 6.5c.9.3 1.6 1 2 1.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 18 15.5H10l-3.5 3v-3H5A1.5 1.5 0 0 1 3.5 12V8A1.5 1.5 0 0 1 5 6.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M8 10.5h8M8 13h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`,
  notifications: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 4.5a4.5 4.5 0 0 0-4.5 4.5v3.8l-1.2 2.2h11.4l-1.2-2.2V9A4.5 4.5 0 0 0 12 4.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M10 17.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  marketplaceCredits: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" stroke="url(#creditsGrad)" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M12 8.5 9 10v4l3 1.5 3-1.5v-4L12 8.5z" fill="url(#creditsGrad)" opacity="0.85"/>
    <defs>
      <linearGradient id="creditsGrad" x1="4" y1="3" x2="20" y2="21">
        <stop stop-color="#c084fc"/>
        <stop offset="1" stop-color="#60a5fa"/>
      </linearGradient>
    </defs>
  </svg>`,
  events: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="5" y="6" width="14" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M8 4.5V7M16 4.5V7M5 10h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  map: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="12" cy="11" r="2" fill="currentColor"/>
  </svg>`,
  communities: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="9" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="16.5" cy="9" r="2" stroke="currentColor" stroke-width="1.3"/>
    <path d="M13.5 17c.4-1.6 1.7-2.8 3.3-2.8 1 0 1.9.4 2.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`,
  backpack: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 8V6.5A4 4 0 0 1 12 2.5 4 4 0 0 1 16 6.5V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <rect x="6" y="8" width="12" height="12.5" rx="2" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 12v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  marketplace: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M7 8.5V7a5 5 0 0 1 10 0v1.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M6 8.5h12l-1 11H7L6 8.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,
  pictures: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="4" y="6" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="9" cy="10.5" r="1.5" fill="currentColor"/>
    <path d="m6 16 4-3 3 2.5 2-1.5 3 3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M9.5 9.2a2.7 2.7 0 1 1 4.3 2.2c-.9.6-1.3 1.1-1.3 2.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="12" cy="16.8" r="0.9" fill="currentColor"/>
  </svg>`,
  dev: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 7 4 12l4 5M16 7l4 5-4 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M11 5.5 9 18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`
} as const

export type SidebarIconId = keyof typeof SIDEBAR_ICONS

/** DCL scene/world chat rail icon (companion-style pin). */
export const SCENE_CHAT_RAIL_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 2.5c-1.4 4.2-4.5 6.2-4.5 10a4.5 4.5 0 1 0 9 0c0-3.8-3.1-5.8-4.5-10z" fill="#FF2D55"/>
  <path d="M12 2.5v10l4-2.3C14.8 7.8 12.8 5.5 12 2.5z" fill="#FFBC5B"/>
</svg>`
