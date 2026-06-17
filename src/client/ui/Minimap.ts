import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import { parseParcelKey } from '../../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../../dcl/content/types'
import { parcelWorldOrigin } from '../../dcl/landscape/Utils/SceneSpace'

export type MinimapOptions = {
  scene: ResolvedScene
  getPlayerPosition: () => THREE.Vector3 | null
  onClick?: () => void
}

/** Circular parcel map — top-left HUD showing landscape grid + player dot. */
export class Minimap {
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly parcels: string[]
  private readonly base: ReturnType<typeof parseParcelKey>
  private readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  private readonly size = 224
  private readonly dpr = Math.min(window.devicePixelRatio, 2)

  constructor({ scene, getPlayerPosition, onClick }: MinimapOptions) {
    this.parcels = scene.parcels
    this.base = parseParcelKey(scene.baseParcel)

    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const key of this.parcels) {
      const p = parseParcelKey(key)
      const o = parcelWorldOrigin(p, this.base)
      minX = Math.min(minX, o.x)
      maxX = Math.max(maxX, o.x + PARCEL_SIZE)
      minZ = Math.min(minZ, o.z)
      maxZ = Math.max(maxZ, o.z + PARCEL_SIZE)
    }
    this.bounds = { minX, maxX, minZ, maxZ }

    this.root = document.createElement('div')
    this.root.id = 'minimap'
    this.root.className = 'minimap'
    this.root.innerHTML = `<canvas width="${this.size}" height="${this.size}" aria-label="Parcel map"></canvas>`

    this.canvas = this.root.querySelector('canvas')!
    this.canvas.width = this.size * this.dpr
    this.canvas.height = this.size * this.dpr
    this.canvas.style.width = `${this.size}px`
    this.canvas.style.height = `${this.size}px`

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Minimap 2D context unavailable')
    this.ctx = ctx

    if (onClick) {
      this.root.classList.add('is-clickable')
      this.root.setAttribute('role', 'button')
      this.root.setAttribute('tabindex', '0')
      this.root.setAttribute('aria-label', 'Open Genesis City map')
      this.root.addEventListener('click', () => onClick())
      this.root.addEventListener('keydown', (ev) => {
        if (ev.code === 'Enter' || ev.code === 'Space') {
          ev.preventDefault()
          onClick()
        }
      })
    }

    document.body.appendChild(this.root)

    const draw = (): void => {
      this.render(getPlayerPosition())
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  }

  private worldToMap(x: number, z: number): { x: number; y: number } {
    const spanX = this.bounds.maxX - this.bounds.minX
    const spanZ = this.bounds.maxZ - this.bounds.minZ
    const pad = 12
    const inner = this.size - pad * 2
    return {
      x: pad + ((x - this.bounds.minX) / spanX) * inner,
      y: pad + ((z - this.bounds.minZ) / spanZ) * inner
    }
  }

  private render(player: THREE.Vector3 | null): void {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.size, this.size)

    const cx = this.size / 2
    const cy = this.size / 2
    const radius = this.size / 2 - 8

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.clip()

    ctx.fillStyle = 'rgba(8, 14, 22, 0.88)'
    ctx.fillRect(0, 0, this.size, this.size)

    for (const key of this.parcels) {
      const parcel = parseParcelKey(key)
      const origin = parcelWorldOrigin(parcel, this.base)
      const tl = this.worldToMap(origin.x, origin.z)
      const br = this.worldToMap(origin.x + PARCEL_SIZE, origin.z + PARCEL_SIZE)
      const w = br.x - tl.x
      const h = br.y - tl.y

      ctx.fillStyle = '#8b3a3a'
      ctx.fillRect(tl.x, tl.y, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, w - 1, h - 1)
    }

    if (player) {
      const dot = this.worldToMap(player.x, player.z)
      ctx.fillStyle = '#57e389'
      ctx.beginPath()
      ctx.arc(dot.x, dot.y, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    ctx.restore()

    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
  }

  dispose(): void {
    this.root.remove()
  }
}
