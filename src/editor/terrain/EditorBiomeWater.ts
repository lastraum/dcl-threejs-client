import * as THREE from 'three'
import type { SceneEnvironmentKind } from '../../dcl/content/types'
import { LANDSCAPE_ENVIRONMENTS } from '../../dcl/landscape/EnvironmentCatalog'
import { IslandWater } from '../../environment/IslandWater'
import { OpenOceanWater } from '../../environment/OpenOceanWater'
import { FftOceanWater } from '../../environment/FftOceanWater'
import type { FftOceanSettings } from '../../environment/fftOcean/readFftOceanOverride'
import { ISLAND_WATER_SURFACE_Y } from '../../dcl/landscape/IslandShoreMaterial'
import { EditorWaterPlane } from './EditorWaterPlane'
import { ARENA_WATER_SURFACE_Y, TERRAIN_BIOME_COLORS } from './terrainSculptConstants'

export type EditorWaterBackend = 'fft' | 'water.js' | 'plane' | 'none'

/**
 * Editor water preview driven by scene.json environment + biome profile:
 * - island / mountains → shore ring (FFTOCEAN if fft on, else Water.js)
 * - water → open ocean (FFTOCEAN if fft on, else Water.js)
 * - biomes with showWater:false (space, land, forest, desert, genesis, none) → none
 *
 * FFTOCEAN = dallapozza GPGPU sim (same as play client).
 */
export class EditorBiomeWater {
  private mode: 'plane' | 'island' | 'open' | 'hidden' = 'hidden'
  private backend: EditorWaterBackend = 'none'
  private plane: EditorWaterPlane | null = null
  private islandJs: IslandWater | null = null
  private openJs: OpenOceanWater | null = null
  private fft: FftOceanWater | null = null
  private userVisible = true
  private waterY = ARENA_WATER_SURFACE_Y
  private waterColor: number = TERRAIN_BIOME_COLORS.water
  private borderPadding = 1
  private lastKind: SceneEnvironmentKind = 'none'

  constructor(
    private readonly scene: THREE.Scene,
    private readonly parcels: string[],
    private readonly baseParcel: string,
    private readonly footprint: {
      widthM: number
      depthM: number
      originX: number
      originZ: number
    },
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getFftSettings: () => FftOceanSettings
  ) {}

  get groupVisible(): boolean {
    if (!this.userVisible || this.mode === 'hidden') return false
    if (this.mode === 'plane') return this.plane?.group.visible ?? false
    if (this.fft) return this.fft.group.visible
    if (this.islandJs) return this.islandJs.group.visible
    if (this.openJs) return this.openJs.group.visible
    return false
  }

  getBackend(): EditorWaterBackend {
    return this.backend
  }

  setUserVisible(visible: boolean): void {
    this.userVisible = visible
    this.applyVisibility()
  }

  setWaterLevel(y: number): void {
    if (!Number.isFinite(y)) return
    this.waterY = y
    this.plane?.setWaterLevel(y)
    if (this.islandJs) this.islandJs.group.position.y = y
    if (this.openJs) this.openJs.group.position.y = y
    if (this.fft) this.fft.group.position.y = y
  }

  setWaterColor(hex: number): void {
    this.waterColor = hex
    this.plane?.setWaterColor(hex)
  }

  setBorderPadding(padding: number): void {
    this.borderPadding = Math.max(0, Math.floor(padding))
  }

  /**
   * Rebuild preview for biome + current FFT settings from scene.json.
   * Call after kind or environment.water changes.
   * Honors LANDSCAPE_ENVIRONMENTS[kind].showWater — space/land/etc. get no water.
   *
   * Island / mountains pin sea level to {@link ISLAND_WATER_SURFACE_Y} so the land
   * disc (≈ Y=0) sits above water. Sculpt "Water To" (default 5) is for heightmap
   * bands — using it as ocean Y flooded the whole island circle.
   */
  async applyKind(kind: SceneEnvironmentKind): Promise<void> {
    this.lastKind = kind
    const profile = LANDSCAPE_ENVIRONMENTS[kind] ?? LANDSCAPE_ENVIRONMENTS.none
    let next: EditorBiomeWater['mode'] = 'hidden'
    if (profile.showWater) {
      if (kind === 'water' || profile.openOcean) next = 'open'
      else if (kind === 'island' || kind === 'mountains') next = 'island'
      else next = 'plane'
    }
    // Island + open ocean share client sea level so seafloor heightmaps sit under water.
    // Plane biomes (rare) still use sculpt Water To via setWaterLevel from workspace.
    if (next === 'island' || next === 'open') {
      this.waterY = ISLAND_WATER_SURFACE_Y
    } else if (next === 'plane') {
      if (!Number.isFinite(this.waterY)) this.waterY = ARENA_WATER_SURFACE_Y
    }
    await this.rebuild(next)
  }

  /** Force rebuild (e.g. FFT toggle / amplitude) with last biome. */
  async refresh(): Promise<void> {
    await this.applyKind(this.lastKind)
  }

  update(delta: number, camera?: THREE.Camera): void {
    if (!this.userVisible) return
    this.plane?.update(delta)
    this.islandJs?.update(delta)
    this.openJs?.update(delta)
    if (this.fft && camera) this.fft.update(delta, camera)
  }

  dispose(): void {
    this.clearAll()
  }

  private clearAll(): void {
    this.plane?.dispose()
    this.plane = null
    this.islandJs?.dispose()
    this.islandJs = null
    this.openJs?.dispose()
    this.openJs = null
    this.fft?.dispose()
    this.fft = null
    this.backend = 'none'
  }

  private applyVisibility(): void {
    const on = this.userVisible
    if (this.plane) this.plane.setVisible(on && this.mode === 'plane')
    if (this.islandJs) this.islandJs.group.visible = on && this.mode === 'island'
    if (this.openJs) this.openJs.group.visible = on && this.mode === 'open'
    if (this.fft) {
      this.fft.group.visible = on && (this.mode === 'island' || this.mode === 'open')
    }
  }

  private async rebuild(mode: EditorBiomeWater['mode']): Promise<void> {
    this.clearAll()
    this.mode = mode
    const settings = this.getFftSettings()

    try {
      // mode already follows biome showWater. waterEnabled=false only after
      // resolveFftOceanSettings with landscapeWantsWater — i.e. explicit scene/URL kill.
      if (mode !== 'hidden' && settings.waterEnabled === false) {
        this.mode = 'hidden'
        this.backend = 'none'
        console.info(
          `[editor] water killed (environment.water.enabled=false or ?water=0), biomeMode was ${mode}`
        )
        this.applyVisibility()
        return
      }

      if (mode === 'hidden') {
        this.backend = 'none'
        // Biomes like space/land: dispose any prior mesh and stay empty.
      } else if (mode === 'plane') {
        this.plane = await EditorWaterPlane.create(
          this.footprint.widthM,
          this.footprint.depthM,
          this.footprint.originX,
          this.footprint.originZ,
          this.waterY,
          this.waterColor
        )
        this.plane.mount(this.scene)
        this.backend = 'plane'
      } else if (mode === 'island' || mode === 'open') {
        // fft flag only picks backend; master enabled already handled above.
        const wantFft = settings.enabled !== false
        const canFft = wantFft && this.renderer.capabilities.isWebGL2

        if (canFft) {
          this.fft = await FftOceanWater.create(
            this.parcels,
            this.baseParcel,
            this.renderer,
            {
              mode,
              shoreWidthParcels: this.borderPadding,
              settings
            }
          )
          this.fft.group.position.y = this.waterY
          this.scene.add(this.fft.group)
          this.backend = 'fft'
          console.info(`[editor] FFTOCEAN (dallapozza) preview — ${mode} Y=${this.waterY.toFixed(2)}`)
        } else if (mode === 'island') {
          this.islandJs = await IslandWater.create(
            this.parcels,
            this.baseParcel,
            this.borderPadding
          )
          this.islandJs.group.position.y = this.waterY
          this.scene.add(this.islandJs.group)
          this.backend = 'water.js'
          if (wantFft && !this.renderer.capabilities.isWebGL2) {
            console.warn('[editor] FFTOCEAN needs WebGL2 — Water.js island preview')
          } else if (!wantFft) {
            console.info('[editor] Water.js island preview (FFT off)')
          }
        } else {
          this.openJs = await OpenOceanWater.create(this.parcels, this.baseParcel)
          this.openJs.group.position.y = this.waterY
          this.scene.add(this.openJs.group)
          this.backend = 'water.js'
        }
      }
    } catch (e) {
      console.warn('[editor] biome water preview failed', e)
      this.mode = 'hidden'
      this.backend = 'none'
    }
    this.applyVisibility()
  }
}
