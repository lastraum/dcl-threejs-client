import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const ARCHIPELAGO_PEERS = 'https://archipelago-ea-stats.decentraland.org/peers'
const PARCELS_API = 'https://api.decentraland.org/v2/parcels'
const WORLDS_LIVE_DATA = 'https://worlds-content-server.decentraland.org/live-data'
const PLACES_API = 'https://places.decentraland.org/api'

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
  },
  resolve: {
    alias: {
      fs: fileURLToPath(new URL('./src/shim/browser/emptyFs.ts', import.meta.url))
    }
  },
  appType: 'spa',
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api/peers': {
        target: ARCHIPELAGO_PEERS,
        changeOrigin: true,
        rewrite: () => ''
      },
      '/api/parcels': {
        target: PARCELS_API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/parcels/, '')
      },
      '/api/worlds/live-data': {
        target: WORLDS_LIVE_DATA,
        changeOrigin: true,
        rewrite: () => ''
      },
      '/api/places': {
        target: PLACES_API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/places/, '')
      },
      '/api/texture': {
        target: 'https://arweave.net',
        changeOrigin: true,
        secure: true,
        followRedirects: true,
        router: (req) => {
          const path = req.url ?? ''
          const match = path.match(/^\/api\/texture\/(https?)\/([^/?#]+)/)
          if (!match) return 'https://arweave.net'
          return `${match[1]}://${match[2]}`
        },
        rewrite: (path) => {
          const match = path.match(/^\/api\/texture\/https?:\/[^/]+(\/.*)?$/)
          return match?.[1] || '/'
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['src/physics/vendor/physx-js-webidl.js']
  },
  worker: {
    format: 'es',
    resolve: {
      alias: {
        fs: fileURLToPath(new URL('./src/shim/browser/emptyFs.ts', import.meta.url))
      }
    }
  }
})
