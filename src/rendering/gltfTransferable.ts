import * as THREE from 'three'

/**
 * Transferable GLB graph — worker parses with GLTFLoader, main rebuilds THREE objects.
 * THREE.Object3D is not structured-cloneable; only ArrayBuffers + ImageBitmaps move.
 */

export type XferArrayType = 'f32' | 'f64' | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32'

type TypedArray =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array

export type XferAttr = {
  name: string
  itemSize: number
  normalized: boolean
  type: XferArrayType
  array: ArrayBuffer
}

export type XferGeometry = {
  id: number
  index: XferAttr | null
  attributes: XferAttr[]
  morphAttributes: Array<{ name: string; attrs: XferAttr[] }>
  morphTargetsRelative: boolean
}

export type XferTexture = {
  id: number
  bitmap: ImageBitmap
  flipY: boolean
  wrapS: number
  wrapT: number
  magFilter: number
  minFilter: number
  colorSpace: string
  name: string
}

export type XferMaterial = {
  id: number
  kind: 'standard' | 'physical' | 'basic' | 'phong'
  name: string
  color: number
  roughness: number
  metalness: number
  opacity: number
  transparent: boolean
  alphaTest: number
  side: number
  depthWrite: boolean
  depthTest: boolean
  vertexColors: boolean
  flatShading: boolean
  wireframe: boolean
  emissive: number
  emissiveIntensity: number
  transmission: number
  thickness: number
  ior: number
  /** Linear RGB — KHR specularColorFactor can be >1; hex would clamp. */
  specularColor: { r: number; g: number; b: number }
  specularIntensity: number
  maps: Partial<Record<XferMapSlot, number>>
  userData: Record<string, unknown>
}

export type XferMapSlot =
  | 'map'
  | 'normalMap'
  | 'roughnessMap'
  | 'metalnessMap'
  | 'emissiveMap'
  | 'aoMap'
  | 'alphaMap'
  | 'bumpMap'
  | 'metalnessRoughnessMap'
  | 'specularColorMap'
  | 'specularMap'

export type XferNode = {
  id: number
  name: string
  kind: 'group' | 'mesh' | 'skinned' | 'bone' | 'line' | 'lineSegments' | 'points' | 'object'
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  sx: number
  sy: number
  sz: number
  visible: boolean
  frustumCulled: boolean
  castShadow: boolean
  receiveShadow: boolean
  children: number[]
  geometry: number | null
  material: number | number[] | null
  bones: number[] | null
  inverseBind: ArrayBuffer | null
  bindMatrix: ArrayBuffer | null
  morphInfluences: number[] | null
  userData: Record<string, unknown>
}

export type XferTrack = {
  name: string
  valueType: string
  times: ArrayBuffer
  values: ArrayBuffer
  timesType: XferArrayType
  valuesType: XferArrayType
}

export type XferClip = {
  name: string
  duration: number
  tracks: XferTrack[]
}

export type XferGltfPayload = {
  root: number
  nodes: XferNode[]
  geometries: XferGeometry[]
  materials: XferMaterial[]
  textures: XferTexture[]
  clips: XferClip[]
}

const MAP_SLOTS: XferMapSlot[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
  'specularColorMap',
  'specularMap'
]

function jsonUserData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function arrayType(arr: ArrayLike<number> & ArrayBufferView): XferArrayType {
  if (arr instanceof Float32Array) return 'f32'
  if (arr instanceof Float64Array) return 'f64'
  if (arr instanceof Uint8Array || arr instanceof Uint8ClampedArray) return 'u8'
  if (arr instanceof Int8Array) return 'i8'
  if (arr instanceof Uint16Array) return 'u16'
  if (arr instanceof Int16Array) return 'i16'
  if (arr instanceof Uint32Array) return 'u32'
  if (arr instanceof Int32Array) return 'i32'
  return 'f32'
}

function viewOf(type: XferArrayType, buffer: ArrayBuffer): TypedArray {
  switch (type) {
    case 'f32':
      return new Float32Array(buffer)
    case 'f64':
      return new Float64Array(buffer)
    case 'u8':
      return new Uint8Array(buffer)
    case 'i8':
      return new Int8Array(buffer)
    case 'u16':
      return new Uint16Array(buffer)
    case 'i16':
      return new Int16Array(buffer)
    case 'u32':
      return new Uint32Array(buffer)
    case 'i32':
      return new Int32Array(buffer)
  }
}

function copyTyped(arr: ArrayLike<number> & ArrayBufferView): { type: XferArrayType; array: ArrayBuffer } {
  const type = arrayType(arr)
  const ctor = viewOf(type, new ArrayBuffer(0)).constructor as new (src: ArrayLike<number>) => ArrayBufferView
  const copy = new ctor(arr as ArrayLike<number>)
  return { type, array: copy.buffer as ArrayBuffer }
}

function packAttribute(
  name: string,
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
): XferAttr {
  const interleaved = (attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
  if (!interleaved && (attr as THREE.BufferAttribute).isBufferAttribute) {
    const ba = attr as THREE.BufferAttribute
    const packed = copyTyped(ba.array as ArrayLike<number> & ArrayBufferView)
    return {
      name,
      itemSize: ba.itemSize,
      normalized: ba.normalized,
      type: packed.type,
      array: packed.array
    }
  }
  const count = attr.count
  const itemSize = attr.itemSize
  const dst = new Float32Array(count * itemSize)
  for (let i = 0; i < count; i++) {
    const o = i * itemSize
    dst[o] = attr.getX(i)
    if (itemSize > 1) dst[o + 1] = attr.getY(i)
    if (itemSize > 2) dst[o + 2] = attr.getZ(i)
    if (itemSize > 3) dst[o + 3] = attr.getW(i)
  }
  return {
    name,
    itemSize,
    normalized: attr.normalized,
    type: 'f32',
    array: dst.buffer
  }
}

async function bitmapFromImage(image: unknown): Promise<ImageBitmap | null> {
  if (!image) return null
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return image
  if (typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(image as ImageBitmapSource)
  } catch {
    return null
  }
}

function nodeKind(obj: THREE.Object3D): XferNode['kind'] {
  if ((obj as THREE.Bone).isBone) return 'bone'
  if ((obj as THREE.SkinnedMesh).isSkinnedMesh) return 'skinned'
  if ((obj as THREE.Mesh).isMesh) return 'mesh'
  if ((obj as THREE.LineSegments).isLineSegments) return 'lineSegments'
  if ((obj as THREE.Line).isLine) return 'line'
  if ((obj as THREE.Points).isPoints) return 'points'
  if ((obj as THREE.Group).isGroup) return 'group'
  return 'object'
}

function materialKind(mat: THREE.Material): XferMaterial['kind'] {
  if ((mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return 'physical'
  if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return 'standard'
  if ((mat as THREE.MeshPhongMaterial).isMeshPhongMaterial) return 'phong'
  return 'basic'
}

/** Flatten a parsed GLTF graph into transferable buffers + bitmaps. */
export async function flattenGltf(
  scene: THREE.Object3D,
  clips: THREE.AnimationClip[]
): Promise<XferGltfPayload> {
  const objects: THREE.Object3D[] = []
  scene.traverse((obj) => {
    objects.push(obj)
  })

  const nodeId = new Map<THREE.Object3D, number>()
  objects.forEach((obj, i) => nodeId.set(obj, i))

  const geoId = new Map<THREE.BufferGeometry, number>()
  const geometries: XferGeometry[] = []
  const matId = new Map<THREE.Material, number>()
  const materials: XferMaterial[] = []
  const texId = new Map<THREE.Texture, number>()
  const textures: XferTexture[] = []

  const takeGeometry = (geo: THREE.BufferGeometry): number => {
    const existing = geoId.get(geo)
    if (existing !== undefined) return existing
    const id = geometries.length
    geoId.set(geo, id)
    const attributes: XferAttr[] = []
    for (const name of Object.keys(geo.attributes)) {
      const attr = geo.getAttribute(name)
      if (attr) attributes.push(packAttribute(name, attr))
    }
    const morphAttributes: XferGeometry['morphAttributes'] = []
    if (geo.morphAttributes) {
      const morphs = geo.morphAttributes as Record<
        string,
        Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute> | undefined
      >
      for (const name of Object.keys(morphs)) {
        const list = morphs[name]
        if (!list?.length) continue
        morphAttributes.push({
          name,
          attrs: list.map((a, i) => packAttribute(`${name}:${i}`, a))
        })
      }
    }
    geometries.push({
      id,
      index: geo.index ? packAttribute('index', geo.index) : null,
      attributes,
      morphAttributes,
      morphTargetsRelative: geo.morphTargetsRelative === true
    })
    return id
  }

  const takeTexture = async (tex: THREE.Texture | null | undefined): Promise<number | null> => {
    if (!tex) return null
    const existing = texId.get(tex)
    if (existing !== undefined) return existing
    const bitmap = await bitmapFromImage(tex.image)
    if (!bitmap) return null
    const id = textures.length
    texId.set(tex, id)
    textures.push({
      id,
      bitmap,
      flipY: tex.flipY,
      wrapS: tex.wrapS,
      wrapT: tex.wrapT,
      magFilter: tex.magFilter,
      minFilter: tex.minFilter,
      colorSpace: String(tex.colorSpace ?? ''),
      name: tex.name ?? ''
    })
    return id
  }

  const takeMaterial = async (mat: THREE.Material): Promise<number> => {
    const existing = matId.get(mat)
    if (existing !== undefined) return existing
    const id = materials.length
    matId.set(mat, id)
    const std = mat as THREE.MeshStandardMaterial
    const phys = mat as THREE.MeshPhysicalMaterial
    const maps: XferMaterial['maps'] = {}
    for (const slot of MAP_SLOTS) {
      const tex = (mat as unknown as Record<string, THREE.Texture | undefined>)[slot]
      const tid = await takeTexture(tex)
      if (tid !== null) maps[slot] = tid
    }
    const color =
      'color' in mat && (mat as THREE.MeshStandardMaterial).color
        ? (mat as THREE.MeshStandardMaterial).color.getHex()
        : 0xffffff
    const emissive = std.emissive ? std.emissive.getHex() : 0
    materials.push({
      id,
      kind: materialKind(mat),
      name: mat.name ?? '',
      color,
      roughness: std.roughness ?? 1,
      metalness: std.metalness ?? 0,
      opacity: mat.opacity,
      transparent: mat.transparent,
      alphaTest: mat.alphaTest,
      side: mat.side,
      depthWrite: mat.depthWrite,
      depthTest: mat.depthTest,
      vertexColors: std.vertexColors === true,
      flatShading: std.flatShading === true,
      wireframe: std.wireframe === true,
      emissive,
      emissiveIntensity: std.emissiveIntensity ?? 0,
      transmission: phys.transmission ?? 0,
      thickness: phys.thickness ?? 0,
      ior: phys.ior ?? 1.5,
      specularColor: phys.specularColor
        ? { r: phys.specularColor.r, g: phys.specularColor.g, b: phys.specularColor.b }
        : { r: 1, g: 1, b: 1 },
      specularIntensity: phys.specularIntensity ?? 1,
      maps,
      userData: jsonUserData(mat.userData)
    })
    return id
  }

  const takeMaterials = async (
    mat: THREE.Material | THREE.Material[]
  ): Promise<number | number[]> => {
    if (Array.isArray(mat)) {
      const ids: number[] = []
      for (const m of mat) ids.push(await takeMaterial(m))
      return ids
    }
    return takeMaterial(mat)
  }

  for (const obj of objects) {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.geometry) takeGeometry(mesh.geometry)
    if (mesh.isMesh && mesh.material) await takeMaterials(mesh.material)
    const line = obj as THREE.Line
    if (line.isLine && line.geometry) takeGeometry(line.geometry)
    if (line.isLine && line.material) await takeMaterials(line.material as THREE.Material)
    const points = obj as THREE.Points
    if (points.isPoints && points.geometry) takeGeometry(points.geometry)
    if (points.isPoints && points.material) await takeMaterials(points.material as THREE.Material)
  }

  const nodes: XferNode[] = objects.map((obj) => {
    const id = nodeId.get(obj)!
    const mesh = obj as THREE.Mesh
    const skinned = obj as THREE.SkinnedMesh
    let geometry: number | null = null
    let material: number | number[] | null = null
    if (mesh.isMesh || (obj as THREE.Line).isLine || (obj as THREE.Points).isPoints) {
      const geo = (obj as THREE.Mesh).geometry
      const mat = (obj as THREE.Mesh).material
      if (geo) geometry = geoId.get(geo) ?? null
      if (mat) {
        if (Array.isArray(mat)) {
          material = mat.map((m) => matId.get(m)!).filter((n) => n !== undefined)
        } else {
          material = matId.get(mat) ?? null
        }
      }
    }

    let bones: number[] | null = null
    let inverseBind: ArrayBuffer | null = null
    let bindMatrix: ArrayBuffer | null = null
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      bones = skinned.skeleton.bones.map((b) => {
        const bid = nodeId.get(b)
        return bid === undefined ? -1 : bid
      })
      const inv = new Float32Array(skinned.skeleton.boneInverses.length * 16)
      skinned.skeleton.boneInverses.forEach((m, i) => m.toArray(inv, i * 16))
      inverseBind = inv.buffer
      const bm = new Float32Array(16)
      skinned.bindMatrix.toArray(bm)
      bindMatrix = bm.buffer
    }

    const children: number[] = []
    for (const child of obj.children) {
      const cid = nodeId.get(child)
      if (cid !== undefined) children.push(cid)
    }

    return {
      id,
      name: obj.name ?? '',
      kind: nodeKind(obj),
      px: obj.position.x,
      py: obj.position.y,
      pz: obj.position.z,
      qx: obj.quaternion.x,
      qy: obj.quaternion.y,
      qz: obj.quaternion.z,
      qw: obj.quaternion.w,
      sx: obj.scale.x,
      sy: obj.scale.y,
      sz: obj.scale.z,
      visible: obj.visible,
      frustumCulled: obj.frustumCulled,
      castShadow: (obj as THREE.Mesh).castShadow === true,
      receiveShadow: (obj as THREE.Mesh).receiveShadow === true,
      children,
      geometry,
      material,
      bones,
      inverseBind,
      bindMatrix,
      morphInfluences: mesh.isMesh && mesh.morphTargetInfluences ? [...mesh.morphTargetInfluences] : null,
      userData: jsonUserData(obj.userData)
    }
  })

  const xferClips: XferClip[] = clips.map((clip) => ({
    name: clip.name,
    duration: clip.duration,
    tracks: clip.tracks.map((track) => {
      const times = copyTyped(track.times as ArrayLike<number> & ArrayBufferView)
      const values = copyTyped(track.values as ArrayLike<number> & ArrayBufferView)
      return {
        name: track.name,
        valueType: track.ValueTypeName,
        times: times.array,
        values: values.array,
        timesType: times.type,
        valuesType: values.type
      }
    })
  }))

  return {
    root: nodeId.get(scene) ?? 0,
    nodes,
    geometries,
    materials,
    textures,
    clips: xferClips
  }
}

export function collectTransfers(payload: XferGltfPayload): Transferable[] {
  const out: Transferable[] = []
  const seen = new Set<Transferable>()
  const push = (buf: Transferable | null | undefined) => {
    if (!buf || seen.has(buf)) return
    seen.add(buf)
    out.push(buf)
  }
  for (const geo of payload.geometries) {
    for (const a of geo.attributes) push(a.array)
    if (geo.index) push(geo.index.array)
    for (const morph of geo.morphAttributes) {
      for (const a of morph.attrs) push(a.array)
    }
  }
  for (const tex of payload.textures) push(tex.bitmap)
  // Do NOT transfer inverseBind / bindMatrix — they are tiny and Brave/structured-clone
  // + transfer has neutered them, leaving skinned extremities (feet) in bind pose.
  for (const clip of payload.clips) {
    for (const track of clip.tracks) {
      push(track.times)
      push(track.values)
    }
  }
  return out
}

function makeGeometry(xfer: XferGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  for (const a of xfer.attributes) {
    geo.setAttribute(a.name, new THREE.BufferAttribute(viewOf(a.type, a.array), a.itemSize, a.normalized))
  }
  if (xfer.index) {
    geo.setIndex(new THREE.BufferAttribute(viewOf(xfer.index.type, xfer.index.array), 1))
  }
  const morphOut = geo.morphAttributes as Record<string, THREE.BufferAttribute[]>
  for (const morph of xfer.morphAttributes) {
    morphOut[morph.name] = morph.attrs.map(
      (a) => new THREE.BufferAttribute(viewOf(a.type, a.array), a.itemSize, a.normalized)
    )
  }
  geo.morphTargetsRelative = xfer.morphTargetsRelative
  return geo
}

function makeTexture(xfer: XferTexture): THREE.Texture {
  const tex = new THREE.Texture(xfer.bitmap)
  tex.flipY = xfer.flipY
  tex.wrapS = xfer.wrapS as THREE.Wrapping
  tex.wrapT = xfer.wrapT as THREE.Wrapping
  tex.magFilter = xfer.magFilter as THREE.MagnificationTextureFilter
  tex.minFilter = xfer.minFilter as THREE.MinificationTextureFilter
  tex.colorSpace = (xfer.colorSpace || THREE.NoColorSpace) as THREE.ColorSpace
  tex.name = xfer.name
  tex.needsUpdate = true
  return tex
}

function makeMaterial(xfer: XferMaterial, textures: THREE.Texture[]): THREE.Material {
  let mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial | THREE.MeshPhongMaterial
  if (xfer.kind === 'physical') mat = new THREE.MeshPhysicalMaterial()
  else if (xfer.kind === 'phong') mat = new THREE.MeshPhongMaterial()
  else if (xfer.kind === 'basic') mat = new THREE.MeshBasicMaterial()
  else mat = new THREE.MeshStandardMaterial()

  mat.name = xfer.name
  if ('color' in mat && mat.color) mat.color.setHex(xfer.color)
  mat.opacity = xfer.opacity
  mat.transparent = xfer.transparent
  mat.alphaTest = xfer.alphaTest
  mat.side = xfer.side as THREE.Side
  // ALPHA_BLEND volumes (fog, mist) must not write depth or the floor occludes them.
  mat.depthWrite = xfer.transparent && xfer.opacity < 0.95 ? false : xfer.depthWrite
  mat.depthTest = xfer.depthTest
  if ('roughness' in mat) mat.roughness = xfer.roughness
  if ('metalness' in mat) mat.metalness = xfer.metalness
  if ('vertexColors' in mat) mat.vertexColors = xfer.vertexColors
  if ('flatShading' in mat) mat.flatShading = xfer.flatShading
  if ('wireframe' in mat) mat.wireframe = xfer.wireframe
  if ('emissive' in mat && mat.emissive) {
    mat.emissive.setHex(xfer.emissive)
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = xfer.emissiveIntensity
  }
  if (mat instanceof THREE.MeshPhysicalMaterial) {
    mat.transmission = xfer.transmission
    mat.thickness = xfer.thickness
    mat.ior = xfer.ior
    // KHR_materials_specular — keep authored RGB (may be >1). Hex clamp hid the tint.
    if (xfer.specularColor) {
      mat.specularColor.setRGB(xfer.specularColor.r, xfer.specularColor.g, xfer.specularColor.b)
    }
    if (typeof xfer.specularIntensity === 'number') mat.specularIntensity = xfer.specularIntensity
  }
  for (const slot of MAP_SLOTS) {
    const tid = xfer.maps[slot]
    if (tid === undefined) continue
    const tex = textures[tid]
    if (tex) (mat as unknown as Record<string, THREE.Texture>)[slot] = tex
  }
  // Three.js dielectric F0 is 0.04×specularColor — invisible on roughness-1 ALPHA_BLEND
  // volumes (fog/mist). Explorer's lit shader still shows that tint as a wrap-around
  // lobe. Sheen is the same authored specular color on the lobe Three actually shades.
  if (
    mat instanceof THREE.MeshPhysicalMaterial &&
    mat.transparent &&
    (mat.specularColorMap ||
      mat.specularColor.r > 1.001 ||
      mat.specularColor.g > 1.001 ||
      mat.specularColor.b > 1.001)
  ) {
    mat.sheen = 1
    mat.sheenRoughness = Math.min(1, Math.max(mat.sheenRoughness, mat.roughness))
    mat.sheenColor.copy(mat.specularColor)
    if (mat.specularColorMap && !mat.sheenColorMap) mat.sheenColorMap = mat.specularColorMap
  }
  Object.assign(mat.userData, xfer.userData)
  return mat
}

function asFloat32(view: TypedArray): Float32Array {
  return view instanceof Float32Array ? view : new Float32Array(view)
}

function makeTrack(track: XferTrack): THREE.KeyframeTrack {
  const times = asFloat32(viewOf(track.timesType, track.times))
  const valuesView = viewOf(track.valuesType, track.values)
  switch (track.valueType) {
    case 'quaternion':
      return new THREE.QuaternionKeyframeTrack(track.name, times, asFloat32(valuesView))
    case 'color':
      return new THREE.ColorKeyframeTrack(track.name, times, asFloat32(valuesView))
    case 'bool': {
      const flags = new Array<boolean>(valuesView.length)
      for (let i = 0; i < valuesView.length; i++) flags[i] = !!valuesView[i]
      return new THREE.BooleanKeyframeTrack(track.name, times, flags)
    }
    case 'number':
      return new THREE.NumberKeyframeTrack(track.name, times, asFloat32(valuesView))
    default:
      return new THREE.VectorKeyframeTrack(track.name, times, asFloat32(valuesView))
  }
}

function createNodeShell(node: XferNode): THREE.Object3D {
  switch (node.kind) {
    case 'bone':
      return new THREE.Bone()
    case 'skinned':
      return new THREE.SkinnedMesh()
    case 'mesh':
      return new THREE.Mesh()
    case 'lineSegments':
      return new THREE.LineSegments()
    case 'line':
      return new THREE.Line()
    case 'points':
      return new THREE.Points()
    case 'group':
      return new THREE.Group()
    default:
      return new THREE.Object3D()
  }
}

/** Keep skeleton.bones[i] aligned with boneInverses[i] — filtering drops foot joints. */
function ensureBoneAt(
  objects: THREE.Object3D[],
  id: number,
  fallbackName: string
): THREE.Bone {
  const existing = id >= 0 ? objects[id] : undefined
  if (existing && (existing as THREE.Bone).isBone) return existing as THREE.Bone

  const bone = new THREE.Bone()
  bone.name = existing?.name || fallbackName
  if (existing) {
    bone.position.copy(existing.position)
    bone.quaternion.copy(existing.quaternion)
    bone.scale.copy(existing.scale)
    const parent = existing.parent
    if (parent) {
      parent.add(bone)
      existing.removeFromParent()
    }
    for (const child of [...existing.children]) bone.add(child)
    if (id >= 0) objects[id] = bone
  }
  return bone
}

/** Rebuild a THREE graph from a transferable payload (main thread, cheap vs parse). */
export function inflateGltf(payload: XferGltfPayload): {
  scene: THREE.Group
  animations: THREE.AnimationClip[]
} {
  const geometries = payload.geometries.map(makeGeometry)
  const textures = payload.textures.map(makeTexture)
  const materials = payload.materials.map((m) => makeMaterial(m, textures))
  const objects = payload.nodes.map((n) => createNodeShell(n))

  for (let i = 0; i < payload.nodes.length; i++) {
    const spec = payload.nodes[i]!
    const obj = objects[i]!
    obj.name = spec.name
    obj.visible = spec.visible
    obj.frustumCulled = spec.frustumCulled
    obj.position.set(spec.px, spec.py, spec.pz)
    obj.quaternion.set(spec.qx, spec.qy, spec.qz, spec.qw)
    obj.scale.set(spec.sx, spec.sy, spec.sz)
    Object.assign(obj.userData, spec.userData)

    const mesh = obj as THREE.Mesh
    if (spec.geometry !== null && (mesh.isMesh || (obj as THREE.Line).isLine || (obj as THREE.Points).isPoints)) {
      mesh.geometry = geometries[spec.geometry]!
      if (Array.isArray(spec.material)) {
        mesh.material = spec.material.map((id) => materials[id]!).filter(Boolean)
      } else if (spec.material !== null) {
        mesh.material = materials[spec.material]!
      }
      mesh.castShadow = spec.castShadow
      mesh.receiveShadow = spec.receiveShadow
      if (spec.morphInfluences) {
        mesh.morphTargetInfluences = [...spec.morphInfluences]
        mesh.morphTargetDictionary = {}
        for (let m = 0; m < spec.morphInfluences.length; m++) {
          mesh.morphTargetDictionary[`morphTarget${m}`] = m
        }
      }
    }

    for (const cid of spec.children) {
      const child = objects[cid]
      if (child) obj.add(child)
    }
  }

  for (let i = 0; i < payload.nodes.length; i++) {
    const spec = payload.nodes[i]!
    if (!spec.bones || spec.kind !== 'skinned') continue
    const mesh = objects[i] as THREE.SkinnedMesh
    if (!spec.inverseBind) continue
    const invSrc = new Float32Array(spec.inverseBind)
    const bones: THREE.Bone[] = []
    const inverses: THREE.Matrix4[] = []
    for (let b = 0; b < spec.bones.length; b++) {
      bones.push(ensureBoneAt(objects, spec.bones[b]!, `bone_${b}`))
      inverses.push(new THREE.Matrix4().fromArray(invSrc, b * 16))
    }
    if (!bones.length) continue
    const skeleton = new THREE.Skeleton(bones, inverses)
    const bind = new THREE.Matrix4()
    if (spec.bindMatrix) bind.fromArray(new Float32Array(spec.bindMatrix))
    mesh.bind(skeleton, bind)
    if (!mesh.geometry.getAttribute('skinIndex') || !mesh.geometry.getAttribute('skinWeight')) {
      throw new Error(`inflateGltf: skinned mesh "${mesh.name}" missing skin attributes`)
    }
  }

  const rootObj = objects[payload.root] ?? objects[0]
  let scene: THREE.Group
  if (rootObj instanceof THREE.Group) {
    scene = rootObj
  } else {
    scene = new THREE.Group()
    scene.name = rootObj?.name || 'gltf-root'
    if (rootObj) scene.add(rootObj)
  }

  const animations = payload.clips.map(
    (clip) => new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.map(makeTrack))
  )
  return { scene, animations }
}
