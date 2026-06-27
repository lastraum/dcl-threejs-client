#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
const target =
  process.platform === 'darwin'
    ? path.join(home, 'Library/Application Support/creator-hub/Scenes')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'creator-hub', 'Scenes')
      : path.join(home, '.config/creator-hub/Scenes')

const linkPath = path.join(home, 'Documents', 'CreatorHubScenes')

if (!fs.existsSync(target)) {
  console.error(`Creator Hub Scenes folder not found:\n  ${target}`)
  process.exit(1)
}

if (fs.existsSync(linkPath)) {
  console.log(`Already exists: ${linkPath}`)
  process.exit(0)
}

fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`Created symlink:\n  ${linkPath}\n  -> ${target}`)
console.log('In the editor, use + Add folder and pick ~/Documents/CreatorHubScenes/<scene-name>')