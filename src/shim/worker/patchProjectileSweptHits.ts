/**
 * Continuous projectile hits for scene combat systems (worker bundle rewrite).
 *
 * Problem
 * -------
 * Scenes often do:
 *   newPos = currentPos + dir * speed * dt
 *   mutable.position = newPos
 *   hit if |newPos - target| < radius   // end-point only
 *
 * Combined with PE chest + muzzle height, bullets fly near y≈2 while the target
 * sphere is at y≈0.9 (radius 1.15) — the vertical gap alone is ~1.13 m, leaving
 * only ~0.2 m horizontal window. End-point samples tunnel; even pure 3D segment–
 * sphere barely works and fails if `currentPos` was aliased/mutated by getMutable.
 *
 * Fix (still scene positions / radius / height symbols — no host hardcodes)
 * ------------------------------------------------------------------------
 * 1. Snapshot segment origin (ox,oy,oz) immediately after computing newPos.
 * 2. Closest point on segment [origin→newPos] in **XZ** (matches aimDirXZ combat).
 * 3. Hit if horizontal distance ≤ scene hit radius (cylinder along Y).
 *
 * No full-engine substeps. No-op when the combat pattern is absent.
 */

export type ProjectileSweptHitPatchResult = {
  code: string
  applied: boolean
  replacements: number
  originSnapshots: number
}

/** Snapshot segment origin before getMutable can alias/mutate `currentPos`. */
const NEWPOS_LINE =
  /const newPos = (\w+)\.add\(currentPos, \1\.scale\(dir, (?:bulletSpeed|[^)]+) \* dt\)\);/g

/**
 * Point-sphere after linear move (esbuild-pretty combat scenes).
 * Captures Transform getter, height offset id, radius-sq id.
 */
const POINT_HIT_BLOCK =
  /const zombiePos = (\w+)\.get\(zombie\)\.position;\s*\n\s*const dx = newPos\.x - zombiePos\.x;\s*\n\s*const dy = newPos\.y - \(zombiePos\.y \+ (\w+)\);\s*\n\s*const dz = newPos\.z - zombiePos\.z;\s*\n\s*const distSq = dx \* dx \+ dy \* dy \+ dz \* dz;\s*\n\s*if \(distSq > (\w+)\)\s*\n\s*continue;/g

/** Already-patched segment block that still used 3D sphere + live currentPos — upgrade. */
const OLD_SWEPT_3D_BLOCK =
  /const zombiePos = (\w+)\.get\(zombie\)\.position;\s*\n\s*\/\/ Segment[^\n]*\n\s*const _tcx = zombiePos\.x;\s*\n\s*const _tcy = zombiePos\.y \+ (\w+);\s*\n\s*const _tcz = zombiePos\.z;\s*\n\s*const _abx = newPos\.x - currentPos\.x;\s*\n\s*const _aby = newPos\.y - currentPos\.y;\s*\n\s*const _abz = newPos\.z - currentPos\.z;\s*\n\s*const _acx = _tcx - currentPos\.x;\s*\n\s*const _acy = _tcy - currentPos\.y;\s*\n\s*const _acz = _tcz - currentPos\.z;\s*\n\s*const _abLenSq = _abx \* _abx \+ _aby \* _aby \+ _abz \* _abz;\s*\n\s*let _tHit = _abLenSq > 1e-12 \? \(_acx \* _abx \+ _acy \* _aby \+ _acz \* _abz\) \/ _abLenSq : 0;\s*\n\s*if \(_tHit < 0\) _tHit = 0;\s*\n\s*else if \(_tHit > 1\) _tHit = 1;\s*\n\s*const dx = currentPos\.x \+ _abx \* _tHit - _tcx;\s*\n\s*const dy = currentPos\.y \+ _aby \* _tHit - _tcy;\s*\n\s*const dz = currentPos\.z \+ _abz \* _tHit - _tcz;\s*\n\s*const distSq = dx \* dx \+ dy \* dy \+ dz \* dz;\s*\n\s*if \(distSq > (\w+)\)\s*\n\s*continue;/g

function xzCylinderHitBlock(
  transformGet: string,
  _heightId: string,
  radiusSqId: string
): string {
  // XZ segment vs zombie XZ — scene aims with aimDirXZ (horizontal only).
  // Origin uses _segO* snapshot when present, else currentPos (pre-mutate).
  return `const zombiePos = ${transformGet}.get(zombie).position;
      // XZ segment–cylinder hit (scene currentPos/newPos + radius; horizontal aim parity).
      const _ox = typeof _segOx === "number" ? _segOx : currentPos.x;
      const _oy = typeof _segOy === "number" ? _segOy : currentPos.y;
      const _oz = typeof _segOz === "number" ? _segOz : currentPos.z;
      const _abx = newPos.x - _ox;
      const _abz = newPos.z - _oz;
      const _acx = zombiePos.x - _ox;
      const _acz = zombiePos.z - _oz;
      const _abLenSq = _abx * _abx + _abz * _abz;
      let _tHit = _abLenSq > 1e-12 ? (_acx * _abx + _acz * _abz) / _abLenSq : 0;
      if (_tHit < 0) _tHit = 0;
      else if (_tHit > 1) _tHit = 1;
      const dx = _ox + _abx * _tHit - zombiePos.x;
      const dz = _oz + _abz * _tHit - zombiePos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > ${radiusSqId})
        continue;`
}

/**
 * Rewrite discrete end-point projectile/target tests into XZ segment–cylinder tests.
 */
export function patchProjectileSweptHits(code: string): ProjectileSweptHitPatchResult {
  if (!code.includes('zombiePos') || !code.includes('newPos')) {
    return { code, applied: false, replacements: 0, originSnapshots: 0 }
  }

  let originSnapshots = 0
  let out = code

  // 1) Snapshot segment origin right after newPos (before getMutable.position = newPos).
  if (!out.includes('_segOx')) {
    out = out.replace(NEWPOS_LINE, (full) => {
      originSnapshots++
      return (
        full +
        `\n    const _segOx = currentPos.x, _segOy = currentPos.y, _segOz = currentPos.z;`
      )
    })
  }

  let replacements = 0

  // 2) Upgrade previous 3D swept patch if present.
  out = out.replace(
    OLD_SWEPT_3D_BLOCK,
    (_full, transformGet: string, heightId: string, radiusSqId: string) => {
      replacements++
      return xzCylinderHitBlock(transformGet, heightId, radiusSqId)
    }
  )

  // 3) Original point-sphere pattern.
  out = out.replace(
    POINT_HIT_BLOCK,
    (_full, transformGet: string, heightId: string, radiusSqId: string) => {
      replacements++
      return xzCylinderHitBlock(transformGet, heightId, radiusSqId)
    }
  )

  return {
    code: out,
    applied: replacements > 0 || originSnapshots > 0,
    replacements,
    originSnapshots
  }
}
