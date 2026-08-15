import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { patchYogaNbindSource } from './src/shim/vite/yogaNbindFix'
import { createSuggestionProxyMiddleware } from './scripts/suggestion-dispatch-proxy.mjs'
import { createTextureProxyMiddleware } from './scripts/texture-dispatch-proxy.mjs'
import { createAnalyticsProxyMiddleware } from './scripts/analytics-dispatch-proxy.mjs'
import { createSceneFetchProxyMiddleware } from './scripts/scene-fetch-proxy.mjs'
import { sceneBundleMirrorPlugin } from './vite-plugins/sceneBundleMirror'

const ARCHIPELAGO_PEERS = 'https://archipelago-ea-stats.decentraland.org/peers'
const PARCELS_API = 'https://api.decentraland.org/v2/parcels'
const WORLDS_LIVE_DATA = 'https://worlds-content-server.decentraland.org/live-data'
const PLACES_API = 'https://places.decentraland.org/api'
const STORAGE_API = 'https://storage.decentraland.org'

export default defineConfig({
  plugins: [
    {
      name: 'suggestion-dispatch-proxy',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use(createSuggestionProxyMiddleware())
      }
    },
    {
      name: 'analytics-dispatch-proxy',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use(createAnalyticsProxyMiddleware())
      },
      configurePreviewServer(server) {
        server.middlewares.use(createAnalyticsProxyMiddleware())
      }
    },
    {
      name: 'texture-dispatch-proxy',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use(createTextureProxyMiddleware())
      }
    },
    {
      name: 'scene-fetch-proxy',
      enforce: 'pre',
      configureServer(server) {
        // Single generic egress: /api/scene-http/<https|http>/<host>/… (scene fetch + SignedFetch)
        server.middlewares.use(createSceneFetchProxyMiddleware())
      },
      configurePreviewServer(server) {
        server.middlewares.use(createSceneFetchProxyMiddleware())
      }
    },
    // Dev-only: POST /api/mirror-scene-bundle → dev/scene-bundles/ (inspect scene scripts).
    sceneBundleMirrorPlugin(),
    // Production + dev: yoga nbind assigns `_a` without declaring it (strict ESM crash).
    // optimizeDeps alone only covers prebundle — rollup must patch too.
    {
      name: 'yoga-nbind-fix',
      enforce: 'pre',
      async load(id) {
        if (!/yoga-layout-prebuilt[/\\].*[/\\]nbind\.js$/.test(id)) return null
        const { readFile } = await import('node:fs/promises')
        return patchYogaNbindSource(await readFile(id, 'utf8'))
      }
    }
  ],
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
  },
  resolve: {
    alias: {
      fs: fileURLToPath(new URL('./src/shim/browser/emptyFs.ts', import.meta.url)),
      '@vfx': fileURLToPath(new URL('./vendor/threejs-vfx/src', import.meta.url))
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
      // Same-origin auth-api proxy (matches nginx /api/dcl-auth-api/)
      '/api/dcl-auth-api': {
        target: 'https://auth-api.decentraland.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/dcl-auth-api/, '')
      },
      // World Storage Service — direct CORS returns Allow-Origin: false for localhost
      '/api/storage': {
        target: STORAGE_API,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/storage/, '')
      },
      // Marketplace — never call marketplace-api from the browser (CORS broken)
      '/api/marketplace': {
        target: 'https://marketplace-api.decentraland.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/marketplace/, '')
      },
      // Loot Bag meta-tx — same-origin (CORS broken on transactions.lastslice.co)
      // Local self-relayer: change target to http://localhost:5356
      '/api/meta-tx': {
        target: 'https://transactions.lastslice.co',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/meta-tx/, '')
      }
    }
  },
  optimizeDeps: {
    exclude: ['src/physics/vendor/physx-js-webidl.js'],
    esbuildOptions: {
      plugins: [
        {
          name: 'yoga-nbind-fix-deps',
          setup(build) {
            build.onLoad({ filter: /yoga-layout-prebuilt[\\/].*[\\/]nbind\.js$/ }, async (args) => {
              const { readFile } = await import('node:fs/promises')
              const contents = patchYogaNbindSource(await readFile(args.path, 'utf8'))
              return { contents, loader: 'js' }
            })
          }
        }
      ]
    }
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
