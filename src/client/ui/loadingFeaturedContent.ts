/** Curated featured slides shown while the world loads (Unity Explorer–style carousel). */
export type LoadingFeaturedSlide = {
  title: string
  subtitle: string
  imageUrl: string
  tag: string
}

/** Fallback when a slide thumbnail fails to load (matches loading-screen backdrop). */
export const LOADING_FALLBACK_IMAGE =
  'https://cdn.decentraland.org/@dcl/jump-site/1.2.0/assets/background--i0ipWGU.webp'

export const LOADING_FEATURED_SLIDES: LoadingFeaturedSlide[] = [
  {
    tag: 'Featured place',
    title: 'Genesis Plaza',
    subtitle: 'The social heart of Decentraland — events, quests, and meetups every day.',
    imageUrl:
      'https://peer.decentraland.org/content/contents/bafybeietrfx6arffgapt65jkawued7mcsu75uuloodf3drxbvq2pfpggei'
  },
  {
    tag: 'Hot scene',
    title: 'Fashion Street',
    subtitle: 'Runway shows, wearables, and style experiences across connected parcels.',
    imageUrl:
      'https://peer.decentraland.org/content/contents/bafkreie6tmyny3nkfu2e3b523udqcdjlwjfisx3yq53cb3zk3e6vh75nde'
  },
  {
    tag: 'World',
    title: 'Explore DCL Worlds',
    subtitle: 'Jump into creator-owned realms beyond the Genesis City map.',
    imageUrl: LOADING_FALLBACK_IMAGE
  },
  {
    tag: 'Tip',
    title: 'Move with WASD',
    subtitle: 'Click the canvas to lock your cursor, then explore scenes with friends in real time.',
    imageUrl:
      'https://peer.decentraland.org/content/contents/bafybeic7nsjciccwgo66sorl2caol5tmpqlxomvc3nhnvwdcw7j7duszga'
  },
  {
    tag: 'Community',
    title: 'Live events',
    subtitle: 'Concerts, game nights, and meetups — check Events in the companion app.',
    imageUrl:
      'https://peer-ap1.decentraland.org/content/contents/bafybeig3ek25r2kirnbmkammwojlub4tp3xybwmg2yhu4swvzdeckaqicq'
  }
]
