/**
 * Genesis midnight sky — the purple hue the forest was designed around,
 * with a modest brightness lift so it isn't pitch black.
 */
import * as THREE from 'three'
import { DclGenesisSky, sampleSkyGradientsAt } from '../environment/DclGenesisSky'
import {
  EQUATOR_AMBIENT_NIGHT,
  HEMI_NIGHT_INTENSITY,
  MOON_BRIGHTNESS,
  NIGHT_GROUND_HEMI_BOOST
} from '../environment/skyboxTime'
import { celestialDirection, moonLightIntensity } from '../environment/sunCycleSampler'

/** Midnight — moon up, no sun disc. Genesis fog/sky are deepest purple here. */
export const FOREST_SKY_SECONDS = 0

const _celestial = new THREE.Vector3()
const _hemiGround = new THREE.Color()
const _moonCool = new THREE.Color(0.62, 0.42, 1)
const _purpleFog = new THREE.Color(0x4a0070)
const _purpleSky = new THREE.Color(0xb48cff)
const _purpleEquator = new THREE.Color(0x9a78c8)

export class ForestNightSky {
  private readonly sky = new DclGenesisSky()
  private readonly moon = new THREE.DirectionalLight(0x9a7cff, 0.5)
  private readonly moonTarget = new THREE.Object3D()
  private readonly hemi = new THREE.HemisphereLight(0xb48cff, 0x1a1228, HEMI_NIGHT_INTENSITY)
  private readonly equator = new THREE.AmbientLight(0x9a78c8, EQUATOR_AMBIENT_NIGHT)
  private readonly sapFill = new THREE.DirectionalLight(0x3ec8e0, 0.18)
  private ready = false

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera
  ) {
    this.moon.castShadow = false
    this.moon.target = this.moonTarget
    this.sapFill.position.set(-18, 10, -14)
    this.sky.mesh.renderOrder = -1000
    scene.add(this.sky.mesh, this.hemi, this.equator, this.moon, this.moonTarget, this.sapFill)
    this.apply(0)
    void this.sky.loadTextures().then(() => {
      this.ready = true
      this.apply(0)
    })
  }

  update(dt: number): void {
    this.apply(dt)
  }

  dispose(): void {
    this.sky.mesh.removeFromParent()
    this.hemi.removeFromParent()
    this.equator.removeFromParent()
    this.moon.removeFromParent()
    this.moonTarget.removeFromParent()
    this.sapFill.removeFromParent()
    this.sky.dispose()
    this.hemi.dispose()
    this.equator.dispose()
    this.moon.dispose()
    this.sapFill.dispose()
  }

  private apply(dt: number): void {
    const seconds = FOREST_SKY_SECONDS
    celestialDirection(seconds, _celestial)
    const g = sampleSkyGradientsAt(seconds)
    this.camera.getWorldPosition(this.sky.mesh.position)
    this.sky.update(seconds, _celestial, dt, false)

    const moonLit = moonLightIntensity(seconds)
    this.moon.intensity = Math.max(0.48, moonLit * MOON_BRIGHTNESS) * 1.28
    this.moon.color.copy(g.directional).lerp(_moonCool, 0.45)
    this.moonTarget.position.copy(this.camera.position)
    this.moon.position.copy(this.camera.position).addScaledVector(_celestial, 90)
    this.moonTarget.updateMatrixWorld()

    this.hemi.intensity = HEMI_NIGHT_INTENSITY * 1.28
    this.hemi.color.copy(g.indirectSky).lerp(_purpleSky, 0.28)
    _hemiGround.copy(g.indirectGround).lerp(new THREE.Color(0x2a1638), 0.35)
    _hemiGround.multiplyScalar(NIGHT_GROUND_HEMI_BOOST)
    this.hemi.groundColor.copy(_hemiGround)
    this.equator.intensity = EQUATOR_AMBIENT_NIGHT * 1.22
    this.equator.color.copy(g.indirectEquator).lerp(_purpleEquator, 0.3)

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(g.fog).lerp(_purpleFog, 0.25)
      this.scene.fog.density = 0.0076
    } else {
      this.scene.fog = new THREE.FogExp2(g.fog.clone().lerp(_purpleFog, 0.25), 0.0076)
    }
    this.scene.background = this.ready ? null : g.nadir
  }
}
