import * as THREE from 'three'

function reverseBits(index: number, bits: number): number {
  let reversed = 0
  for (let i = 0; i < bits; i++) {
    if ((index & (1 << i)) !== 0) {
      reversed |= 1 << (bits - 1 - i)
    }
  }
  return reversed
}

/** Butterfly lookup for GPU IFFT — ported from FFTOCEAN. */
export function generateButterflyTexture(resolution: number): THREE.DataTexture {
  const stages = Math.log2(resolution)
  const data = new Float32Array(resolution * stages * 4)

  for (let i = 0; i < stages; i++) {
    const span = Math.pow(2, i)

    for (let j = 0; j < resolution; j++) {
      const k = j % (span * 2)
      const theta = (2.0 * Math.PI * k) / (span * 2.0)

      let evenIndex: number
      let oddIndex: number

      if (i === 0) {
        evenIndex = reverseBits(j - (j % 2), stages)
        oddIndex = reverseBits(j - (j % 2) + 1, stages)
      } else if (k < span) {
        evenIndex = j
        oddIndex = j + span
      } else {
        evenIndex = j - span
        oddIndex = j
      }

      const uEven = (evenIndex + 0.5) / resolution
      const uOdd = (oddIndex + 0.5) / resolution
      const twiddleReal = Math.cos(theta)
      const twiddleImag = Math.sin(theta)
      const pixelIndex = (i + j * stages) * 4

      data[pixelIndex + 0] = uEven
      data[pixelIndex + 1] = uOdd
      data[pixelIndex + 2] = twiddleReal
      data[pixelIndex + 3] = twiddleImag
    }
  }

  const texture = new THREE.DataTexture(data, stages, resolution, THREE.RGBAFormat, THREE.FloatType)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}