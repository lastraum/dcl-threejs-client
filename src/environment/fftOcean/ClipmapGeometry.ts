import * as THREE from 'three'

/** Infinite ocean clipmap — ported from FFTOCEAN. */
export class ClipmapGeometry extends THREE.BufferGeometry {
  constructor(resolution = 256, levels = 5, baseVertexSpacing = 1.0) {
    super()

    if (resolution % 4 !== 0) {
      resolution = Math.ceil(resolution / 4) * 4
    }

    const m = resolution
    const halfM = m / 2
    const quarterM = m / 4
    const threeQuarterM = (3 * m) / 4

    const vCountLOD0 = (m + 1) * (m + 1)
    const vCountLODk = (m + 1) * (m + 1) - (halfM - 1) * (halfM - 1)
    const totalVertices = vCountLOD0 + levels * vCountLODk

    const iCountLOD0 = m * m * 6
    const iCountLODk = (m * m - halfM * halfM) * 6
    const totalIndices = iCountLOD0 + levels * iCountLODk

    const positions = new Float32Array(totalVertices * 3)
    const uvs = new Float32Array(totalVertices * 2)
    const indices = new (totalVertices > 65535 ? Uint32Array : Uint16Array)(totalIndices)

    let vIndex = 0
    let iIndex = 0
    const vMap: number[][][] = new Array(levels + 1)

    for (let L = 0; L <= levels; L++) {
      vMap[L] = new Array(m + 1)
      const step = baseVertexSpacing * Math.pow(2, L)
      const startPos = -(m * step) / 2

      for (let z = 0; z <= m; z++) {
        vMap[L]![z] = new Array(m + 1)
        for (let x = 0; x <= m; x++) {
          if (L > 0 && x > quarterM && x < threeQuarterM && z > quarterM && z < threeQuarterM) {
            continue
          }

          const posX = startPos + x * step
          const posZ = startPos + z * step

          positions[vIndex * 3] = posX
          positions[vIndex * 3 + 1] = 0.0
          positions[vIndex * 3 + 2] = posZ
          uvs[vIndex * 2] = posX
          uvs[vIndex * 2 + 1] = posZ
          vMap[L]![z]![x] = vIndex
          vIndex++
        }
      }
    }

    for (let L = 0; L <= levels; L++) {
      for (let z = 0; z < m; z++) {
        for (let x = 0; x < m; x++) {
          if (L > 0 && x >= quarterM && x < threeQuarterM && z >= quarterM && z < threeQuarterM) {
            continue
          }

          const a = vMap[L]![z]![x]!
          const b = vMap[L]![z + 1]![x]!
          const c = vMap[L]![z]![x + 1]!
          const d = vMap[L]![z + 1]![x + 1]!

          indices[iIndex++] = a
          indices[iIndex++] = b
          indices[iIndex++] = c
          indices[iIndex++] = c
          indices[iIndex++] = b
          indices[iIndex++] = d
        }
      }
    }

    this.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    this.setIndex(new THREE.BufferAttribute(indices, 1))
    this.computeVertexNormals()
  }
}