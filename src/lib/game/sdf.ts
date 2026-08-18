/**
 * MESH -> SIGNED DISTANCE FIELD baker, for shapes the water's raytrace
 * must intersect exactly.
 *
 * The refraction shader can only hit what it can evaluate per pixel. For
 * anything more complex than a box that means a distance field: bake the
 * mesh once into a 3D grid of "metres to the surface", tile the slices
 * into a 2D atlas (WebGL1-friendly — no sampler3D), and the shader
 * sphere-traces it. Works for ANY closed mesh group — the boat now, fish
 * and the Blender hull later — and the hit point and normal it produces
 * are true to the surface, which is what the caustic and underwater
 * shading need to read correctly on a recognisable body.
 *
 * Sign handling is per COMPONENT: a group's children are each closed, but
 * their union is not, and ray-parity over the merged soup calls overlap
 * regions "outside" (two shells crossed = even). Parity is therefore run
 * per child and OR-ed.
 */

import * as THREE from 'three'

export type SdfBake = {
  /** Slice atlas, row-major, tilesX x tilesY tiles of nx x ny texels. */
  data: Float32Array
  width: number
  height: number
  /** Grid bounds in the root's local space. */
  min: THREE.Vector3
  size: THREE.Vector3
}

type Tri = Float32Array // 9 floats: ax ay az bx by bz cx cy cz

function collectComponents(root: THREE.Object3D): Tri[][] {
  root.updateMatrixWorld(true)
  const rootInv = root.matrixWorld.clone().invert()
  const comps: Tri[][] = []
  const v = new THREE.Vector3()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geo = mesh.geometry as THREE.BufferGeometry
    const local = rootInv.clone().multiply(mesh.matrixWorld)
    const pos = geo.attributes.position
    const idx = geo.index
    const n = idx ? idx.count : pos.count
    const tris: Tri[] = []
    for (let i = 0; i < n; i += 3) {
      const t = new Float32Array(9)
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k
        v.fromBufferAttribute(pos, vi).applyMatrix4(local)
        t[k * 3] = v.x
        t[k * 3 + 1] = v.y
        t[k * 3 + 2] = v.z
      }
      tris.push(t)
    }
    comps.push(tris)
  })
  return comps
}

/** Ericson: closest point on a triangle, squared distance. */
function triDist2(px: number, py: number, pz: number, t: Tri): number {
  const abx = t[3] - t[0], aby = t[4] - t[1], abz = t[5] - t[2]
  const acx = t[6] - t[0], acy = t[7] - t[1], acz = t[8] - t[2]
  const apx = px - t[0], apy = py - t[1], apz = pz - t[2]
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz
  const bpx = px - t[3], bpy = py - t[4], bpz = pz - t[5]
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t1 = d1 / (d1 - d3)
    const qx = apx - t1 * abx, qy = apy - t1 * aby, qz = apz - t1 * abz
    return qx * qx + qy * qy + qz * qz
  }
  const cpx = px - t[6], cpy = py - t[7], cpz = pz - t[8]
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t1 = d2 / (d2 - d6)
    const qx = apx - t1 * acx, qy = apy - t1 * acy, qz = apz - t1 * acz
    return qx * qx + qy * qy + qz * qz
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t1 = (d4 - d3) / (d4 - d3 + (d5 - d6))
    const qx = bpx + t1 * (cpx - bpx), qy = bpy + t1 * (cpy - bpy), qz = bpz + t1 * (cpz - bpz)
    return qx * qx + qy * qy + qz * qz
  }
  const denom = 1 / (va + vb + vc)
  const w1 = vb * denom, w2 = vc * denom
  const qx = t[0] + abx * w1 + acx * w2 - px
  const qy = t[1] + aby * w1 + acy * w2 - py
  const qz = t[2] + abz * w1 + acz * w2 - pz
  return qx * qx + qy * qy + qz * qz
}

export function bakeSdfAtlas(
  root: THREE.Object3D,
  nx: number,
  ny: number,
  nz: number,
  tilesX: number,
  pad: number,
): SdfBake {
  const comps = collectComponents(root)
  const all: Tri[] = comps.flat()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const t of all)
    for (let k = 0; k < 3; k++) {
      min.x = Math.min(min.x, t[k * 3]); max.x = Math.max(max.x, t[k * 3])
      min.y = Math.min(min.y, t[k * 3 + 1]); max.y = Math.max(max.y, t[k * 3 + 1])
      min.z = Math.min(min.z, t[k * 3 + 2]); max.z = Math.max(max.z, t[k * 3 + 2])
    }
  min.subScalar(pad)
  max.addScalar(pad)
  const size = max.clone().sub(min)
  const sx = size.x / (nx - 1), sy = size.y / (ny - 1), sz = size.z / (nz - 1)

  // ---- sign: +X ray parity per COMPONENT, OR-ed ----
  const inside = new Uint8Array(nx * ny * nz)
  // tiny irrational jitter dodges exact shared-edge hits double-counting
  const JY = 0.0012345, JZ = 0.0009871
  const cols: number[][] = new Array(ny * nz)
  for (const tris of comps) {
    for (let i = 0; i < cols.length; i++) cols[i] = []
    for (const t of tris) {
      const y0 = Math.max(0, Math.ceil((Math.min(t[1], t[4], t[7]) - min.y - JY) / sy))
      const y1 = Math.min(ny - 1, Math.floor((Math.max(t[1], t[4], t[7]) - min.y - JY) / sy))
      const z0 = Math.max(0, Math.ceil((Math.min(t[2], t[5], t[8]) - min.z - JZ) / sz))
      const z1 = Math.min(nz - 1, Math.floor((Math.max(t[2], t[5], t[8]) - min.z - JZ) / sz))
      for (let jz = z0; jz <= z1; jz++)
        for (let jy = y0; jy <= y1; jy++) {
          const cy = min.y + jy * sy + JY
          const cz = min.z + jz * sz + JZ
          // 2D barycentric in the (y,z) plane; the crossing x interpolates
          const det = (t[4] - t[1]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[7] - t[1])
          if (Math.abs(det) < 1e-12) continue
          const u = ((cy - t[1]) * (t[8] - t[2]) - (cz - t[2]) * (t[7] - t[1])) / det
          const w = ((t[4] - t[1]) * (cz - t[2]) - (t[5] - t[2]) * (cy - t[1])) / det
          if (u < 0 || w < 0 || u + w > 1) continue
          cols[jz * ny + jy].push(t[0] + u * (t[3] - t[0]) + w * (t[6] - t[0]))
        }
    }
    for (let jz = 0; jz < nz; jz++)
      for (let jy = 0; jy < ny; jy++) {
        const xs = cols[jz * ny + jy]
        if (!xs.length) continue
        xs.sort((a, b) => a - b)
        let k = 0
        for (let jx = 0; jx < nx; jx++) {
          const x = min.x + jx * sx
          while (k < xs.length && xs[k] < x) k++
          if (k & 1) inside[(jz * ny + jy) * nx + jx] = 1
        }
      }
  }

  // ---- unsigned distance: coarse-binned triangles, expanding-shell search ----
  const cell = Math.max(sx, sy, sz) * 3
  const ncx = Math.max(1, Math.ceil(size.x / cell))
  const ncy = Math.max(1, Math.ceil(size.y / cell))
  const ncz = Math.max(1, Math.ceil(size.z / cell))
  const bins: Tri[][] = new Array(ncx * ncy * ncz)
  for (let i = 0; i < bins.length; i++) bins[i] = []
  for (const t of all) {
    const bx0 = Math.max(0, Math.floor((Math.min(t[0], t[3], t[6]) - min.x) / cell))
    const bx1 = Math.min(ncx - 1, Math.floor((Math.max(t[0], t[3], t[6]) - min.x) / cell))
    const by0 = Math.max(0, Math.floor((Math.min(t[1], t[4], t[7]) - min.y) / cell))
    const by1 = Math.min(ncy - 1, Math.floor((Math.max(t[1], t[4], t[7]) - min.y) / cell))
    const bz0 = Math.max(0, Math.floor((Math.min(t[2], t[5], t[8]) - min.z) / cell))
    const bz1 = Math.min(ncz - 1, Math.floor((Math.max(t[2], t[5], t[8]) - min.z) / cell))
    for (let a = bx0; a <= bx1; a++)
      for (let b = by0; b <= by1; b++)
        for (let c = bz0; c <= bz1; c++) bins[(c * ncy + b) * ncx + a].push(t)
  }

  const tilesY = Math.ceil(nz / tilesX)
  const width = nx * tilesX
  const height = ny * tilesY
  const data = new Float32Array(width * height)
  for (let jz = 0; jz < nz; jz++) {
    const tileU = (jz % tilesX) * nx
    const tileV = Math.floor(jz / tilesX) * ny
    for (let jy = 0; jy < ny; jy++)
      for (let jx = 0; jx < nx; jx++) {
        const px = min.x + jx * sx, py = min.y + jy * sy, pz = min.z + jz * sz
        const ca = Math.min(ncx - 1, Math.floor((px - min.x) / cell))
        const cb = Math.min(ncy - 1, Math.floor((py - min.y) / cell))
        const cc = Math.min(ncz - 1, Math.floor((pz - min.z) / cell))
        let best = Infinity
        for (let r = 0; ; r++) {
          // a ring at Chebyshev radius r cannot beat a hit closer than
          // (r-1) cells, so stop one ring after the first find
          if (best < Infinity && (r - 1) * cell > Math.sqrt(best)) break
          let any = false
          for (let a = Math.max(0, ca - r); a <= Math.min(ncx - 1, ca + r); a++)
            for (let b = Math.max(0, cb - r); b <= Math.min(ncy - 1, cb + r); b++)
              for (let c = Math.max(0, cc - r); c <= Math.min(ncz - 1, cc + r); c++) {
                if (Math.max(Math.abs(a - ca), Math.abs(b - cb), Math.abs(c - cc)) !== r) continue
                any = true
                for (const t of bins[(c * ncy + b) * ncx + a]) {
                  const d2 = triDist2(px, py, pz, t)
                  if (d2 < best) best = d2
                }
              }
          if (!any && best < Infinity) break
          if (r > ncx + ncy + ncz) break
        }
        const d = Math.sqrt(best)
        const s = inside[(jz * ny + jy) * nx + jx] ? -1 : 1
        data[(tileV + jy) * width + (tileU + jx)] = s * d
      }
  }
  return { data, width, height, min, size }
}
