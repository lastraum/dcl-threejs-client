import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { patchYogaNbindSource } from './src/shim/vite/yogaNbindFix'
import { createSuggestionProxyMiddleware } from './scripts/suggestion-dispatch-proxy.mjs'
import { createTextureProxyMiddleware } from './scripts/texture-dispatch-proxy.mjs'
import { createAnalyticsProxyMiddleware } from './scripts/analytics-dispatch-proxy.mjs'
import { sceneBundleMirrorPlugin } from './vite-plugins/sceneBundleMirror'

const ARCHIPELAGO_PEERS = 'https://archipelago-ea-stats.decentraland.org/peers'
const PARCELS_API = 'https://api.decentraland.org/v2/parcels'
const WORLDS_LIVE_DATA = 'https://worlds-content-server.decentraland.org/live-data'
const PLACES_API = 'https://places.decentraland.org/api'

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
