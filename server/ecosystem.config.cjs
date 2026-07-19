/**
 * PM2 ecosystem for place analytics.
 *
 * Flat deploy (FTP everything into one folder):
 *   analytics.mjs, analytics-core.mjs, .env, ecosystem.config.cjs
 *   cd /root/express/dclthreejs-client && pm2 start ecosystem.config.cjs
 *
 * Repo layout:
 *   pm2 start server/ecosystem.config.cjs
 *
 * Loads sibling .env automatically (no --env-file needed).
 */
const fs = require('fs')
const path = require('path')

const root = __dirname

function loadDotEnv(filePath) {
  /** @type {Record<string, string>} */
  const env = {}
  if (!fs.existsSync(filePath)) return env
  const text = fs.readFileSync(filePath, 'utf8')
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    const key = t.slice(0, i).trim()
    let val = t.slice(i + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    env[key] = val
  }
  return env
}

const dotenv = loadDotEnv(path.join(root, '.env'))

const eventsPath =
  dotenv.ANALYTICS_EVENTS_PATH || path.join(root, 'data', 'place-events.jsonl')

module.exports = {
  apps: [
    {
      name: 'dcl-analytics',
      script: 'analytics.mjs',
      cwd: root,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        ANALYTICS_PORT: dotenv.ANALYTICS_PORT || '8787',
        ANALYTICS_EVENTS_PATH: eventsPath,
        SUPABASE_URL: dotenv.SUPABASE_URL || '',
        SUPABASE_SERVICE_ROLE_KEY: dotenv.SUPABASE_SERVICE_ROLE_KEY || ''
      }
    }
  ]
}
