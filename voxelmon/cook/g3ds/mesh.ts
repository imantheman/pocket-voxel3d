// voxelmon/cook/g3ds/mesh.ts — the Gen 3 terrain mesher.
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f, lib/ChunkMesher.lua runGeometry (:394) -- its Gen 3 arms:
// columns of 8px tiles with tops and 8px side bands of cropped art, baked
// ambient occlusion, the hull foot rule (`occludeH`), a claimed cell's floor
// at the height it stands on, building runs as a wall folded from their
// drawing one row per course (a cliff face mapped continuously over its drop,
// a face taller than its drawing stretched, a cave's rock mapped once), a
// shed or gable roof with hipped flanks wearing the drawn roof band
// stretched over the footprint, a flat top wearing its top rows continuously,
// a room's wall topped with its panel, a bridge deck with a fascia and the
// floor under it, the per-pixel object quads and the hull stamps. The
// sub-tile sculpt and the neighbour masks (his live streaming) are not
// ported: this cook bakes whole maps, ring and all, and the host draws them.

import { AO, FACE_SHADE, VOLUME_TOP_SHADE } from "../../../contracts/spec/voxel-spec.ts";
import { cullHidden, FACE, keyOf, type Quad } from "../geom.ts";
import { mergeUvRects } from "../rectmerge.ts";
import { mergePointQuads } from "./merge.ts";
import { RING, type Run, type SG, type Shape } from "./struct.ts";

/** ChunkMesher.lua:140 INSET */
const INSET = 0.02;
const DIR_SHADE: Record<number, number> = {
  1: FACE_SHADE.east,
  2: FACE_SHADE.west,
  3: FACE_SHADE.up,
  4: FACE_SHADE.down,
  5: FACE_SHADE.south,
  6: FACE_SHADE.north,
};
const SIDES: [number, number, number][] = [[1, 0, 1], [-1, 0, 2], [0, 1, 5], [0, -1, 6]];
const LATERAL: Record<number, [number, number, number, number]> = {
  1: [0, 1, 0, -1],
  2: [0, -1, 0, 1],
  5: [-1, 0, 1, 0],
  6: [1, 0, -1, 0],
};
/** ChunkMesher.lua:556 HULL_CLASS */
const HULL_CLASS = new Set(["cylinder", "canopy", "stump", "can", "planter", "billboard", "post"]);

export interface G3Geometry {
  /** Tops, sides, runs, objects -- then the fine hulls, marked `tree`, last. */
  terrain: Quad[];
  treeCoarse: Quad[];
  treeBox: Quad[];
  water: Quad[];
  stats: { hullQuads: number; objectQuads: number; terrainQuads: number };
}

export function meshScene(S: SG): G3Geometry {
  const terrain: Quad[] = [];
  const water: Quad[] = [];
  const fl2 = (v: number) => Math.floor(v / 2);

  // Structures.lua:10281 standHeight
  const standHeight = (tx: number, ty: number): number | undefined => {
    const run = S.runs.get(keyOf(tx, ty));
    if (run && run.base > 0) return run.base;
    const sy = S.shapeAt.get(keyOf(tx, ty + 2));
    if (sy && sy.flat && sy.cls !== "void" && sy.cls !== "water" && S.isWalkableCell(fl2(tx), fl2(ty) + 1)) return sy.h;
    let approach: number | undefined;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0]] as const) {
      const nx = tx + dx * 2;
      const ny = ty + dy * 2;
      const ns = S.shapeAt.get(keyOf(nx, ny));
      if (ns && ns.flat && ns.cls !== "void" && ns.cls !== "water" && S.isWalkableCell(fl2(nx), fl2(ny))) {
        if (approach === undefined || ns.h < approach) approach = ns.h;
      }
    }
    if (approach !== undefined) return approach;
    for (const walkOnly of [true, false]) {
      for (let r = 1; r <= 3; r++) {
        let best: number | undefined;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (!(dx === -r || dx === r || dy === -r || dy === r)) continue;
            const nx = tx + dx * 2;
            const ny = ty + dy * 2;
            const ns = S.shapeAt.get(keyOf(nx, ny));
            let ok = !!ns && ns.flat && ns.cls !== "void" && ns.cls !== "water";
            if (ok && walkOnly) ok = S.isWalkableCell(fl2(nx), fl2(ny));
            if (ok && (best === undefined || ns!.h > best)) best = ns!.h;
          }
        }
        if (best !== undefined && best > 0) return best;
      }
    }
    return undefined;
  };
  // Structures.lua:808 stampGround
  const stampMemo = new Map<number, number>();
  const stampGround = (tx: number, ty: number): number => {
    const k = keyOf(tx, ty);
    let z = stampMemo.get(k);
    if (z === undefined) {
      const s = S.shapeAt.get(k);
      z = s && typeof s.base === "number" ? s.base : standHeight(tx, ty) ?? 0;
      stampMemo.set(k, z);
    }
    return z;
  };
  const heightAt = (tx: number, ty: number): number => {
    const k = keyOf(tx, ty);
    if (S.skip.has(k)) return stampGround(tx, ty);
    const run = S.runs.get(k);
    if (run) return run.h;
    const s = S.shapeAt.get(k);
    return s ? s.h : 0;
  };
  const occludeH = (tx: number, ty: number): number => {
    const k = keyOf(tx, ty);
    if (S.skip.has(k) || S.runs.has(k)) return heightAt(tx, ty);
    const s = S.shapeAt.get(k);
    if (s && HULL_CLASS.has(s.cls)) {
      const b = s.base ?? 0;
      return b < s.h ? b : s.h;
    }
    return heightAt(tx, ty);
  };
  const tileAt = (tx: number, ty: number) => S.tileAt.get(keyOf(tx, ty)) ?? S.rawTile(tx, ty);
  const uvRect = (tile: number, vTop: number, vBot: number): [number, number, number, number] => {
    const [ax, ay] = S.tileOrigin(tile);
    const vi = Math.min(INSET, (vBot - vTop) / 4);
    return [ax + INSET, ax + 8 - INSET, ay + vTop + vi, ay + vBot - vi];
  };
  const aoShades = (tx: number, ty: number, h: number, shade: number): number | number[] => {
    const n = heightAt(tx, ty - 1) > h;
    const s = heightAt(tx, ty + 1) > h;
    const e = heightAt(tx + 1, ty) > h;
    const w = heightAt(tx - 1, ty) > h;
    const nw = heightAt(tx - 1, ty - 1) > h;
    const ne = heightAt(tx + 1, ty - 1) > h;
    const sw = heightAt(tx - 1, ty + 1) > h;
    const se = heightAt(tx + 1, ty + 1) > h;
    if (!(n || s || e || w || nw || ne || sw || se)) return shade;
    const corner = (a: boolean, b: boolean, d: boolean) => {
      let k = 0;
      if (a) k++;
      if (b) k++;
      if (d && !(a && b)) k++;
      return shade * Math.max(AO.floor, 1 - AO.step * k);
    };
    return [corner(n, w, nw), corner(n, e, ne), corner(s, e, se), corner(s, w, sw)];
  };
  const AO_CORNER = Math.max(AO.floor, AO.edge * AO.edge);
  const sideShades = (hl: number, hr: number, y0: number, y1: number, crease: boolean, shade: number): number | number[] => {
    if (!(crease || hl > y0 || hr > y0)) return shade;
    const base = crease ? AO.edge : 1;
    return [
      shade * (hl > y0 ? (crease ? AO_CORNER : AO.edge) : base),
      shade * (hr > y0 ? (crease ? AO_CORNER : AO.edge) : base),
      shade * (hr > y1 ? AO.edge : 1),
      shade * (hl > y1 ? AO.edge : 1),
    ];
  };
  const topQuad = (x0: number, z0: number, h: number, tile: number, shade: number, to?: Quad[], vTop?: number, vBot?: number) => {
    const [u0, u1, v0, v1] = uvRect(tile, vTop ?? 0, vBot ?? 8);
    (to ?? terrain).push({
      c: [[x0, h, z0], [x0 + 8, h, z0], [x0 + 8, h, z0 + 8], [x0, h, z0 + 8]],
      uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      shade: aoShades(x0 / 8, z0 / 8, h, shade),
      f: FACE.up,
    });
  };
  const sideQuad = (d: number, x0: number, z0: number, y0: number, y1: number, tile: number, vTop: number, vBot: number, shade: number | number[], to: Quad[] = terrain) => {
    const x1 = x0 + 8;
    const z1 = z0 + 8;
    let c: [number, number, number][];
    if (d === 5) c = [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    else if (d === 6) c = [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]];
    else if (d === 1) c = [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]];
    else c = [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]];
    const [u0, u1, v0, v1] = uvRect(tile, vTop, vBot);
    to.push({ c, uv: [[u0, v1], [u1, v1], [u1, v0], [u0, v0]], shade, f: d as 1 | 2 | 5 | 6 });
  };

  const tw = S.tw;
  const th = S.th;
  const r = RING;
  for (let ty = -r; ty < th + r; ty++) {
    for (let tx = -r; tx < tw + r; tx++) {
      const k = keyOf(tx, ty);
      let s: Shape | undefined = S.shapeAt.get(k);
      const tile = S.tileAt.get(k);
      const inBody = tx >= 0 && ty >= 0 && tx < tw && ty < th;
      // a hidden box is not a hidden floor (ChunkMesher.lua:883)
      if (!inBody && S.hideBareRing && !S.skip.has(k)) {
        if (s === undefined || s.apron || !S.outdoor) {
          if (!S.outdoor && s && !s.apron) s = undefined;
        } else s = { cls: "ground", art: "flat", flat: true, h: s.h, base: s.base, authored: true, apron: true };
      }
      if (!s || tile === undefined) continue;
      const x0 = tx * 8;
      const z0 = ty * 8;
      if (S.skip.has(k)) {
        const g0 = S.ground.get(k);
        if (g0 === undefined || g0 === false) continue;
        // (ours) the floor's tile at this tile's own quadrant of its
        // metatile, so a claimed cell is laid with the whole ground drawing
        // (his repeats one 8px tile; four quadrants of one metatile also merge
        // into one quad)
        const g = (g0 & ~3) | ((ty & 1) * 2 + (tx & 1));
        const gy = heightAt(tx, ty);
        topQuad(x0, z0, gy, g, 1);
        for (const [sx, sy, d] of SIDES) {
          const nh = occludeH(tx + sx, ty + sy);
          if (!(nh < gy)) continue;
          const lat = LATERAL[d]!;
          const hl = heightAt(tx + lat[0], ty + lat[1]);
          const hr = heightAt(tx + lat[2], ty + lat[3]);
          for (let band = Math.floor(nh / 8); band <= Math.ceil(gy / 8) - 1; band++) {
            const y0 = Math.max(nh, band * 8);
            const y1 = Math.min(gy, band * 8 + 8);
            if (y1 > y0) sideQuad(d, x0, z0, y0, y1, g, band * 8 + 8 - y1, band * 8 + 8 - y0, sideShades(hl, hr, y0, y1, y0 <= nh, DIR_SHADE[d]!));
          }
        }
        continue;
      }
      const run = S.runs.get(k);
      const h = run ? run.h : s.h;
      // ---- the top ----
      if (run && run.rise > 0) roofTop(run, tx, ty, x0, z0);
      else if (run) {
        let roomTop: number | undefined;
        if (!S.outdoor && S.gen3RoomWallTop && !run.gen3RoofRows && s.cls === "wall") roomTop = S.gen3RoomWallTop[(ty & 1) * 2 + (tx & 1)];
        let m = Math.min(2, run.extent);
        let artTop = run.north;
        if ((run.roofArtRows ?? 0) > 0 && run.roofArtTop !== undefined && run.roofArtTop <= run.front) {
          artTop = run.roofArtTop;
          m = Math.min(run.roofArtRows!, run.front - artTop + 1);
        } else if (S.outdoor && S.ctx.isBuildingCell(fl2(tx), fl2(ty))) {
          // FRLG (ours): a flat-topped building with no roof plan drawn -- the
          // department stores, the game hall, the apartment blocks, whose
          // whole drawing is facade -- tops with its top COURSE (the
          // parapet), not its top two tile rows, which are the upper
          // storey's windows and would lie on the roof a second time: the
          // course's whole cell where it is drawn under the player, else
          // the top tile row of the drawing
          m = S.gen3Roof.has(keyOf(tx, run.north)) ? 1 : Math.min(2, run.extent);
        }
        if (roomTop !== undefined) topQuad(x0, z0, h, roomTop, VOLUME_TOP_SHADE);
        else if (run.extent > m) {
          // the top rows mapped continuously over the depth
          const d = ty - run.north;
          const band = m * 8;
          const p0 = (d / run.extent) * band;
          const p1 = ((d + 1) / run.extent) * band;
          const ai = Math.max(0, Math.min(m - 1, Math.floor((p0 + p1) / 2 / 8)));
          const tv0 = Math.max(0, Math.min(7.5, p0 - ai * 8));
          const tv1 = Math.max(tv0 + 0.5, Math.min(8, p1 - ai * 8));
          topQuad(x0, z0, h, tileAt(tx, artTop + ai), VOLUME_TOP_SHADE, undefined, tv0, tv1);
        } else {
          topQuad(x0, z0, h, tileAt(tx, artTop + ((((ty - run.north) % m) + m) % m)), VOLUME_TOP_SHADE);
        }
      } else {
        let topTile = tile;
        if (s.art === "upright" && s.authored) {
          // top art for a pinned box: the nearest row above the folded face
          let north = ty;
          let front = ty;
          while (ty - north < 6) {
            const bs = S.shapeAt.get(keyOf(tx, north - 1));
            if (bs && bs.authored && bs.cls === s.cls) north--;
            else break;
          }
          while (front - ty < 6) {
            const bs = S.shapeAt.get(keyOf(tx, front + 1));
            if (bs && bs.authored && bs.cls === s.cls) front++;
            else break;
          }
          let row = Math.min(ty, front - Math.floor(h / 8));
          if (row < north) {
            const above = S.shapeAt.get(keyOf(tx, north - 1));
            row = above && above.authored && above.art === "upright" ? north - 1 : north;
          }
          topTile = S.tileAt.get(keyOf(tx, row)) ?? topTile;
        }
        topQuad(x0, z0, h, topTile, s.art === "upright" ? VOLUME_TOP_SHADE : 1, s.cls === "water" ? water : undefined);
      }
      // ...and the floor under a bridge deck
      if (s.cls === "bridge") {
        let floorH: number | undefined;
        let floorT: number | undefined;
        for (const [sx, sy] of SIDES) {
          const ns = S.shapeAt.get(keyOf(tx + sx, ty + sy));
          if (ns && ns.cls !== "bridge") {
            const nh2 = heightAt(tx + sx, ty + sy);
            if (floorH === undefined || nh2 < floorH) {
              floorH = nh2;
              floorT = S.tileAt.get(keyOf(tx + sx, ty + sy));
            }
          }
        }
        if (floorT !== undefined && floorH !== undefined && h - floorH > 8) topQuad(x0, z0, floorH, floorT, 1);
      }
      // ---- the sides: 8px bands wherever the neighbour is lower ----
      for (const [sx, sy, d] of SIDES) {
        const nh = occludeH(tx + sx, ty + sy);
        let bottom = nh;
        if (s.cls === "bridge" && h - nh > 8) bottom = h - 8;
        if (!(bottom < h)) continue;
        const lat = LATERAL[d]!;
        const hl = heightAt(tx + lat[0], ty + lat[1]);
        const hr = heightAt(tx + lat[2], ty + lat[3]);
        for (let band = Math.floor(bottom / 8); band <= Math.ceil(h / 8) - 1; band++) {
          const y0 = Math.max(bottom, band * 8);
          const y1 = Math.min(h, band * 8 + 8);
          if (!(y1 > y0)) continue;
          let src = tile;
          let shade = DIR_SHADE[d]!;
          let vT: number | undefined;
          let vB: number | undefined;
          if (run) {
            const bb = Math.max(0, band - Math.floor(run.base / 8));
            let period: number | undefined;
            if (!run.gen3RoofRows && run.unit > 0 && run.extent > run.unit) {
              if (run.fromRepeat) period = run.unit;
              else if (run.extent >= 16) period = run.unit;
            }
            let artNorth = run.gen3ArtNorth ?? run.north;
            if (artNorth > run.north) artNorth = run.north;
            const roomWall = !S.outdoor && S.gen3RoomWallTop && !run.gen3RoofRows && s.cls === "wall" ? S.gen3RoomWallTop : null;
            let stretched = false;
            if (!roomWall && !run.gen3RoofRows && period === undefined && !run.door && run.front >= artNorth) {
              const rows = run.front - artNorth + 1;
              if (rows >= 1 && h - bottom > rows * 8) stretched = true;
            }
            if (run.face) {
              // a cliff face wears its own drawing once, top to bottom
              const faceH = h - bottom;
              const rows = run.face.rows || 1;
              let idx = 0;
              if (faceH > 0 && rows > 0) idx = Math.max(0, Math.min(rows - 1, Math.floor((((h - y1) + (h - y0)) / (2 * faceH)) * rows)));
              src = run.face.dir === "north" ? tileAt(tx, run.front - idx) : tileAt(tx, run.north + idx);
            } else if (stretched) {
              const faceH = h - bottom;
              const rows = run.front - artNorth + 1;
              const tm = ((h - y1) + (h - y0)) / (2 * faceH);
              const idx = Math.max(0, Math.min(rows - 1, Math.floor(tm * rows)));
              src = d === 6 ? tileAt(tx, artNorth + idx) : tileAt(tx, run.front - idx);
            } else if (d === 6) {
              if (period !== undefined) src = tileAt(tx, artNorth + (bb % period));
              else if (roomWall && artNorth + bb > run.front) src = roomWall[((artNorth + bb) & 1) * 2 + (tx & 1)]!;
              else src = tileAt(tx, Math.min(run.front, artNorth + bb));
            } else {
              if (period !== undefined) src = tileAt(tx, run.front - (bb % period));
              else if (roomWall && run.front - bb < artNorth) src = roomWall[((run.front - bb) & 1) * 2 + (tx & 1)]!;
              else src = tileAt(tx, Math.max(artNorth, run.front - bb));
            }
            if (d === 5) shade = 1;
          } else if (s.art === "upright") {
            if (d === 5) shade = 1;
            let front = ty;
            while (front < ty + 6) {
              const fs2 = S.shapeAt.get(keyOf(tx, front + 1));
              if (fs2 && fs2.authored && fs2.cls === s.cls) front++;
              else break;
            }
            // FURNITURE IS DRAWN ONCE, NOT STACKED: its rows mapped over the box
            let rows = 0;
            while (rows < 6) {
              const rk = keyOf(tx, front - rows);
              const rs = S.shapeAt.get(rk);
              if (rs && rs.cls === s.cls && !S.runs.has(rk) && !S.skip.has(rk)) rows++;
              else break;
            }
            if (rows > 0 && h > 0) {
              const artH = rows * 8;
              const base = s.base ?? 0;
              const span = h - base > 0 ? h - base : h;
              const p0 = ((y0 - (h - span)) / span) * artH;
              const p1 = ((y1 - (h - span)) / span) * artH;
              const ri = Math.max(0, Math.min(rows - 1, Math.floor((p0 + p1) / 2 / 8)));
              src = S.tileAt.get(keyOf(tx, front - ri)) ?? src;
              vB = Math.min(8, Math.max(0.5, 8 - (p0 - ri * 8)));
              vT = Math.max(0, Math.min(vB - 0.5, 8 - (p1 - ri * 8)));
            }
          }
          // a cave's drop is one drawing, mapped over the whole face
          if (s.rock && vT === undefined && vB === undefined) {
            const faceH = h - bottom;
            if (faceH > 8) {
              vT = (8 * (h - y1)) / faceH;
              vB = (8 * (h - y0)) / faceH;
            }
          }
          sideQuad(d, x0, z0, y0, y1, src, vT ?? band * 8 + 8 - y1, vB ?? band * 8 + 8 - y0, sideShades(hl, hr, y0, y1, y0 <= nh, shade));
        }
      }
    }
  }

  // ---- the roof of a run (ChunkMesher.lua:1120): shed or gable, hipped flanks ----
  function roofTop(run: Run, tx: number, ty: number, x0: number, z0: number): void {
    const gext = run.gableExtent ?? run.extent;
    const mid = gext / 2;
    const shed = run.shedRoof;
    const profileH = (nr: Run, d: number) => {
      const ne = nr.gableExtent ?? nr.extent;
      let t: number;
      if (nr.shedRoof) t = d / nr.shedRoof;
      else {
        const nm = ne / 2;
        t = d <= nm ? d / nm : (ne - d) / (ne - nm);
      }
      return nr.h + nr.rise * Math.max(0, Math.min(1, t));
    };
    const d0 = run.front - ty;
    const hS = profileH(run, d0);
    const hN = profileH(run, d0 + 1);
    let roofTile: number;
    let rv0: number;
    let rv1: number;
    if ((run.roofRows ?? 0) > 0) {
      const span = Math.max(mid, 0.5);
      const artRows = run.roofArtRows ?? run.roofRows;
      const artTop = run.roofArtTop ?? run.north;
      const band = artRows * 8;
      let artDepth = Math.max(1, Math.min(gext, artRows));
      if (run.gen3RoofRows) artDepth = Math.max(1, gext);
      const artPix = (d: number) => {
        const t = shed ? 1 - d / artDepth : Math.abs(d - mid) / span;
        return Math.max(0, Math.min(1, t)) * band;
      };
      const a = artPix(d0);
      const b = artPix(d0 + 1);
      let p0 = Math.min(a, b);
      let p1 = Math.max(a, b);
      if (p1 - p0 < 0.5) {
        // past the ridge: the ridge course's lower half, the roof's plain field
        if (p0 <= 0.001) {
          p0 = 4;
          p1 = 8;
        } else p1 = p0 + 0.5;
      }
      const ai = Math.max(0, Math.min(artRows - 1, Math.floor((p0 + p1) / 2 / 8)));
      roofTile = tileAt(tx, artTop + ai);
      rv0 = Math.max(0, Math.min(7.5, p0 - ai * 8));
      rv1 = Math.max(rv0 + 0.5, Math.min(8, p1 - ai * 8));
    } else {
      roofTile = tileAt(tx, run.north);
      rv0 = 0;
      rv1 = 8;
    }
    let swY = hS;
    let seY = hS;
    let neY = hN;
    let nwY = hN;
    const hipW = heightAt(tx - 1, ty) < run.h;
    const hipE = heightAt(tx + 1, ty) < run.h;
    if (hipW) {
      swY = Math.max(run.h, hS - 8);
      nwY = Math.max(run.h, hN - 8);
    }
    if (hipE) {
      seY = Math.max(run.h, hS - 8);
      neY = Math.max(run.h, hN - 8);
    }
    const [u0, u1, v0, v1] = uvRect(roofTile, rv0, rv1);
    const uv: [number, number][] = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
    terrain.push({ c: [[x0, swY, z0 + 8], [x0 + 8, seY, z0 + 8], [x0 + 8, neY, z0], [x0, nwY, z0]], uv, shade: 0.95, f: FACE.up });
    // CLOSE THE SIDE OF THE ROOF
    const roofEdge = (ntx: number): [number, number] | null => {
      const nr = S.runs.get(keyOf(ntx, ty));
      if (!nr) return null;
      if (nr.rise <= 0) return [nr.h, nr.h];
      const nd = nr.front - ty;
      return [profileH(nr, nd), profileH(nr, nd + 1)];
    };
    const flank = (ne: [number, number] | null, sY: number, nY: number, east: boolean) => {
      const bS = Math.max(run.h, Math.min(ne ? ne[0] : run.h, sY));
      const bN = Math.max(run.h, Math.min(ne ? ne[1] : run.h, nY));
      if (sY - bS < 0.5 && nY - bN < 0.5) return;
      const fx = east ? x0 + 8 : x0;
      if (east) terrain.push({ c: [[fx, bS, z0 + 8], [fx, bN, z0], [fx, nY, z0], [fx, sY, z0 + 8]], uv, shade: FACE_SHADE.east, f: FACE.east });
      else terrain.push({ c: [[fx, bN, z0], [fx, bS, z0 + 8], [fx, sY, z0 + 8], [fx, nY, z0]], uv, shade: FACE_SHADE.west, f: FACE.west });
    };
    flank(hipW ? null : roofEdge(tx - 1), swY, nwY, false);
    flank(hipE ? null : roofEdge(tx + 1), seY, neY, true);
    // ...and across the row boundaries
    const rowEdge = (nty: number, southSide: boolean): [number, number] | null => {
      const nr = S.runs.get(keyOf(tx, nty));
      if (!nr) return null;
      if (nr.rise <= 0) return [nr.h, nr.h];
      const nd = nr.front - nty;
      const e = southSide ? profileH(nr, nd + 1) : profileH(nr, nd);
      let w = e;
      let ee = e;
      if (heightAt(tx - 1, nty) < nr.h) w = Math.max(nr.h, e - 8);
      if (heightAt(tx + 1, nty) < nr.h) ee = Math.max(nr.h, e - 8);
      return [w, ee];
    };
    const rowFlank = (ne: [number, number] | null, wY: number, eY: number, south: boolean) => {
      const bW = Math.max(run.h, Math.min(ne ? ne[0] : run.h, wY));
      const bE = Math.max(run.h, Math.min(ne ? ne[1] : run.h, eY));
      if (wY - bW < 0.5 && eY - bE < 0.5) return;
      if (south) terrain.push({ c: [[x0, bW, z0 + 8], [x0 + 8, bE, z0 + 8], [x0 + 8, eY, z0 + 8], [x0, wY, z0 + 8]], uv, shade: FACE_SHADE.south, f: FACE.south });
      else terrain.push({ c: [[x0 + 8, bE, z0], [x0, bW, z0], [x0, wY, z0], [x0 + 8, eY, z0]], uv, shade: FACE_SHADE.north, f: FACE.north });
    };
    rowFlank(rowEdge(ty + 1, true), swY, seY, true);
    rowFlank(rowEdge(ty - 1, false), nwY, neY, false);
  }

  // ---- prebuilt objects, grass mats ----
  const groundShades = (q: Quad): number | number[] => {
    if (typeof q.shade !== "number") return q.shade;
    const ys = q.c.map((c) => c[1]);
    const floorY = Math.min(...ys);
    if (floorY >= AO.risePx) return q.shade;
    return ys.map((y) => {
      const t = y / AO.risePx;
      return (q.shade as number) * (t >= 1 ? 1 : 1 - AO.ground * (1 - t));
    });
  };
  const objects = mergePointQuads(S.objectQuads, S.colourAtUv);
  const objectQuads = objects.length;
  for (const q of objects) terrain.push({ ...q, shade: groundShades(q) });
  for (const q of S.grassQuads) terrain.push(q);
  // ---- hull stamps: the fine carve rides terrain, marked; the coarse one
  // its own stream; the far level the claimed cells as plain boxes ----
  const hulls: Quad[] = [];
  const treeCoarse: Quad[] = [];
  for (const st of S.roundStamps) {
    let my = st.my;
    const acx = Math.floor((st.mx - st.r) / 16) * 2;
    const acz = Math.floor((st.mz - st.r) / 16) * 2;
    if (S.skip.has(keyOf(acx, acz))) my = heightAt(acx, acz);
    const move = (q: Quad): Quad => ({ ...q, c: q.c.map(([x, y, z]) => [x + st.mx, y + my, z + st.mz]) as [number, number, number][] });
    for (const q of st.quads) {
      const m = move(q);
      hulls.push({ ...m, shade: m.shade, tree: true });
    }
    for (const q of st.coarse) {
      if (q.f === FACE.north) continue;
      treeCoarse.push(move(q));
    }
  }
  const treeBox: Quad[] = [];
  const boxH = (tx: number, ty: number) => {
    const k = keyOf(tx, ty);
    if (S.round.has(k)) return S.shapeAt.get(k)?.h ?? 0;
    return heightAt(tx, ty);
  };
  for (const k of S.round) {
    const tx = (k % 4096) - 64;
    const ty = Math.floor(k / 4096) - 64;
    const s = S.shapeAt.get(k);
    const tile = S.tileAt.get(k);
    if (!s || tile === undefined) continue;
    const h = s.h;
    const x0 = tx * 8;
    const z0 = ty * 8;
    topQuad(x0, z0, h, tile, 1, treeBox);
    for (const [sx, sy, d] of SIDES) {
      const nh = boxH(tx + sx, ty + sy);
      if (nh >= h) continue;
      for (let band = Math.floor(nh / 8); band <= Math.ceil(h / 8) - 1; band++) {
        const y0 = Math.max(nh, band * 8);
        const y1 = Math.min(h, band * 8 + 8);
        if (y1 > y0) sideQuad(d, x0, z0, y0, y1, tile, band * 8 + 8 - y1, band * 8 + 8 - y0, DIR_SHADE[d]!, treeBox);
      }
    }
  }
  const merged = mergeUvRects(cullHidden(terrain), undefined, 16);
  const hullsKept = cullHidden(hulls);
  return {
    terrain: [...merged, ...hullsKept],
    treeCoarse: cullHidden(treeCoarse),
    treeBox: cullHidden(treeBox),
    water: cullHidden(water),
    stats: { hullQuads: hullsKept.length, objectQuads, terrainQuads: merged.length },
  };
}
