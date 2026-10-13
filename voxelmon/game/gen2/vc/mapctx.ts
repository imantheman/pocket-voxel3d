// What a cartridge continue reads besides the map number and the spot: when
// a save moves the player (a new map, or a new spot on the same map), these
// are rebuilt the way the cartridge leaves them when it saves there.
//
//   - wScreenSave: the 6x5 blocks around the player the screen is restored
//     from (the map's own blocks, the connected map's past an edge, else the
//     border block);
//   - the player's map object and object struct: the spot (+4, the
//     cartridge's map-object margin) and the facing;
//   - wMapObjects / wObjectMasks: the map's people from its object events,
//     each hidden or shown by its event flag, as a map load leaves them.
//
// Checked against the cartridges' own saves (tests/voxel-gen2-vcsave.test.ts).

import type { Layout } from "./layout.ts";

export interface MapDef {
  id?: string;
  group: number;
  map: number;
  width: number;
  height: number;
  borderBlock?: number;
  blocks?: number[];
  connections?: Record<string, { mapId: string; xOffset?: number; yOffset?: number; offset?: number; stripLength?: number; width?: number }>;
  events?: { bank?: number; address?: number };
  scripts?: { bank?: number; address?: number };
  warps?: unknown[];
  coordEvents?: unknown[];
  bgEvents?: unknown[];
  sceneScripts?: Record<string, unknown> | unknown[];
  callbacks?: unknown[];
  objects?: { index: number; spriteId?: number; sprite?: number | string; x: number; y: number; movement: number; radius?: { x: number; y: number }; hours?: number[]; palette?: number; type?: number; sight?: number; script?: number; eventFlag?: number }[];
  [k: string]: unknown;
}

const FACING_BYTE: Record<string, number> = { down: 0, up: 4, left: 8, right: 12 };

/** The block at block coordinates (bx, by) of `id`, looking through the
 *  connections for a spot past the edge. */
function blockAt(maps: Record<string, MapDef>, id: string, bx: number, by: number): number {
  const m = maps[id];
  if (!m) return 0;
  if (bx >= 0 && by >= 0 && bx < m.width && by < m.height) return m.blocks?.[by * m.width + bx] ?? (m.borderBlock ?? 0);
  const c = m.connections ?? {};
  const look = (dir: string, nx: number, ny: number): number | undefined => {
    const k = c[dir];
    const n = k ? maps[k.mapId] : undefined;
    if (!k || !n) return undefined;
    if (nx < 0 || ny < 0 || nx >= n.width || ny >= n.height) return undefined;
    return n.blocks?.[ny * n.width + nx];
  };
  let v: number | undefined;
  if (by < 0 && c.north) v = look("north", bx - (c.north.offset ?? 0), maps[c.north.mapId] ? maps[c.north.mapId]!.height + by : -1);
  else if (by >= m.height && c.south) v = look("south", bx - (c.south.offset ?? 0), by - m.height);
  else if (bx < 0 && c.west) v = look("west", maps[c.west.mapId] ? maps[c.west.mapId]!.width + bx : -1, by - (c.west.offset ?? 0));
  else if (bx >= m.width && c.east) v = look("east", bx - m.width, by - (c.east.offset ?? 0));
  return v ?? (m.borderBlock ?? 0);
}

/** SpriteMovementData (the ROM's, the same in all three games; checked by
 *  tools/vc2/romfacts.ts): function, facing, action, flags1, flags2,
 *  palette flags, by SPRITEMOVEDATA_* number. */
export const SPRITE_MOVE_DATA: number[][] = [
  [0x00, 0, 1, 0x02, 0x00, 0x00], [0x06, 0, 1, 0x0c, 0x00, 0x00], [0x03, 0, 1, 0x00, 0x00, 0x00], [0x04, 0, 1, 0x00, 0x00, 0x00],
  [0x01, 0, 1, 0x00, 0x00, 0x00], [0x02, 0, 1, 0x00, 0x00, 0x00], [0x06, 0, 1, 0x00, 0x00, 0x00], [0x06, 1, 1, 0x00, 0x00, 0x00],
  [0x06, 2, 1, 0x00, 0x00, 0x00], [0x06, 3, 1, 0x00, 0x00, 0x00], [0x05, 0, 1, 0x00, 0x00, 0x00], [0x07, 0, 1, 0x02, 0x00, 0x00],
  [0x08, 0, 1, 0x00, 0x00, 0x00], [0x09, 0, 1, 0x00, 0x00, 0x00], [0x0a, 0, 1, 0x00, 0x00, 0x00], [0x0b, 0, 1, 0x00, 0x00, 0x00],
  [0x0c, 0, 1, 0x00, 0x00, 0x00], [0x0d, 0, 1, 0x00, 0x00, 0x00], [0x0e, 0, 1, 0x00, 0x00, 0x00], [0x0f, 0, 1, 0x02, 0x00, 0x00],
  [0x10, 0, 1, 0x02, 0x00, 0x00], [0x15, 0, 9, 0x2e, 0x01, 0xc0], [0x16, 0, 10, 0x2e, 0x00, 0x00], [0x06, 0, 1, 0x0c, 0x00, 0x00],
  [0x06, 0, 1, 0x2e, 0x10, 0x00], [0x11, 0, 1, 0x2e, 0x00, 0x40], [0x12, 0, 1, 0x02, 0x00, 0x00], [0x13, 0, 0, 0x8e, 0x01, 0x00],
  [0x14, 0, 8, 0x8e, 0x02, 0x00], [0x17, 0, 0, 0x82, 0x00, 0x00], [0x19, 2, 1, 0x00, 0x00, 0x00], [0x18, 3, 1, 0x00, 0x00, 0x00],
  [0x11, 0, 12, 0x2e, 0x01, 0xc0], [0x11, 0, 13, 0x2e, 0x01, 0xc0], [0x1a, 0, 14, 0x8e, 0x01, 0x00], [0x1b, 0, 15, 0x8e, 0x02, 0x00],
  [0x03, 0, 1, 0x00, 0x00, 0x20], [0x00, 0, 1, 0x00, 0x00, 0x00],
];

export function buildMapContext(
  b: Uint8Array, Lo: Layout, data: { maps: Record<string, MapDef>; events?: unknown }, mapId: string,
  x: number, y: number, facing: string, notes: string[],
  eventFlag: (n: number) => boolean = (n) => ((b[Lo.eventFlags + (n >> 3)]! >> (n & 7)) & 1) === 1,
  spritePalette: (sprite: number) => number = () => 0,
  playerColor = 0x80,
): void {
  const m = data.maps[mapId]!;
  // the screen the continue restores
  const ox = (x - 4) >> 1, oy = (y - 4) >> 1;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) b[Lo.screenSave + r * 6 + c] = blockAt(data.maps, mapId, ox + c, oy + r) & 0xff;
  // the player: map object 0 and object struct 0
  const po = Lo.mapObjects, ps = Lo.playerStruct;
  const sprite = b[po + 1] || b[ps] || 1;
  b[po] = 0;
  b[po + 1] = sprite;
  b[po + 2] = y + 4;
  b[po + 3] = x + 4;
  if (!b[po + 4]) {
    // a fresh save: the player's map object as a new game makes it (the
    // player's movement, no radius or hours, no script, no flag; Crystal's
    // carries the player's palette)
    b.set([0x0b, 0xff, 0xff, 0xff, Lo.engine === "crystal" ? playerColor : 0, 0, 0, 0, 0xff, 0xff], po + 4);
  }
  b[ps] = sprite;
  if (!b[ps + 3]) {
    // a fresh save: the player's struct as the cartridge keeps it (the
    // player's movement data, standing, drawn at the screen's middle)
    b[ps + 3] = 0x0b;
    b[ps + 4] = 0x02;
    b[ps + 9] = 0x01;
    b[ps + 11] = 0x01;
    b[ps + 13] = 0xff;
    b[ps + 23] = 0x40;
    b[ps + 24] = 0x40;
  }
  b[ps + 7] = 0xff;
  b[ps + 8] = FACING_BYTE[facing] ?? 0;
  for (const k of [16, 18, 20]) b[ps + k] = x + 4;
  for (const k of [17, 19, 21]) b[ps + k] = y + 4;
  // the map's people
  for (let slot = 1; slot < 16; slot++) b.fill(0, po + slot * 16, po + slot * 16 + 16);
  b.fill(0xff, Lo.objectMasks, Lo.objectMasks + 16);
  b[Lo.objectMasks] = 0;
  // their live structs: when the cartridge saves, only the people on screen
  // have one (the rest get theirs as they scroll into view), and a continue
  // takes them as they are
  b.fill(0, ps + 0x28, ps + 0x28 * 13);
  let nextStruct = 1;
  for (const ob of m.objects ?? []) {
    // Gold and Silver leave map object slot 1 free; Crystal fills from 1
    const slot = Lo.engine === "gs" ? ob.index + 1 : ob.index;
    if (slot < 1 || slot > 15) { notes.push(`${mapId}: object ${ob.index} has no map-object slot, left out`); continue; }
    const o = po + slot * 16;
    b[o] = 0xff;
    b[o + 1] = Number(ob.spriteId ?? ob.sprite) & 0xff;
    b[o + 2] = (ob.y + 4) & 0xff;
    b[o + 3] = (ob.x + 4) & 0xff;
    b[o + 4] = ob.movement & 0xff;
    b[o + 5] = (((ob.radius?.y ?? 0) & 15) << 4) | ((ob.radius?.x ?? 0) & 15);
    b[o + 6] = (ob.hours?.[0] ?? -1) & 0xff;
    b[o + 7] = (ob.hours?.[1] ?? -1) & 0xff;
    b[o + 8] = (((ob.palette ?? 0) & 15) << 4) | ((ob.type ?? 0) & 15);
    b[o + 9] = (ob.sight ?? 0) & 0xff;
    b[o + 10] = (ob.script ?? 0) & 0xff;
    b[o + 11] = ((ob.script ?? 0) >> 8) & 0xff;
    const f = ob.eventFlag ?? 0xffff;
    b[o + 12] = f & 0xff;
    b[o + 13] = (f >> 8) & 0xff;
    const hidden = f !== 0xffff && f !== -1 && eventFlag(f);
    b[Lo.objectMasks + slot] = hidden ? 0xff : 0;
    const dx = ob.x - x, dy = ob.y - y;
    if (hidden || dx < -4 || dx > 5 || dy < -4 || dy > 4) continue;
    if (nextStruct > 12) { notes.push(`${mapId}: more people on screen than structs`); continue; }
    // on screen: a struct as a map load makes one -- the movement data's
    // facing, action and flags, the palette, the spot -- with the step type
    // at "reset", so the object's own routine starts it on the first frame
    const k = nextStruct++;
    b[o] = k;
    const s = ps + k * 0x28;
    let spr = Number(ob.spriteId ?? ob.sprite) & 0xff;
    if (spr >= 0xf0) spr = b[Lo.variableSprites + (spr & 0x0f)] || spr;
    const move = ob.movement & 0xff;
    const md = SPRITE_MOVE_DATA[move] ?? SPRITE_MOVE_DATA[0]!;
    const pal = ob.palette ?? 0;
    b[s] = spr;
    b[s + 1] = slot;
    b[s + 3] = move;
    b[s + 4] = md[3]!;
    b[s + 5] = md[4]!;
    b[s + 6] = pal >= 8 ? pal - 8 : spritePalette(spr);
    b[s + 7] = 0xff;
    b[s + 8] = (md[1]! & 3) << 2;
    b[s + 11] = md[2]!;
    b[s + 13] = 0xff;
    for (const kk of [16, 18, 20]) b[s + kk] = (ob.x + 4) & 0xff;
    for (const kk of [17, 19, 21]) b[s + kk] = (ob.y + 4) & 0xff;
    b[s + 22] = (b[o + 5]! + 0x11) & 0xff;
    b[s + 23] = (0x40 + dx * 16) & 0xff;
    b[s + 24] = (0x40 + dy * 16) & 0xff;
  }
  // the slots past the map's last object, as a map load clears them
  let lastSlot = 0;
  for (const ob of m.objects ?? []) lastSlot = Math.max(lastSlot, Lo.engine === "gs" ? ob.index + 1 : ob.index);
  for (let slot = Math.max(lastSlot + 1, Lo.engine === "gs" ? 2 : 1); slot < 16; slot++) b[po + slot * 16 + 2] = 0xff;
  // the map's script and event lists: the continue does not read the map
  // header again, so the counts and pointers into the map's script bank
  // are the save's (warps, coord events, signs, people, scene scripts,
  // callbacks), and the pointer to the map's scene byte
  const ev = m.events?.address, sc = m.scripts?.address;
  if (typeof ev !== "number" || typeof sc !== "number") {
    notes.push(`${mapId}: no event/script addresses in the data; the cartridge keeps the old map's lists`);
    return;
  }
  const at = Lo.mapEvents;
  const put = (o: number, count: number, ptr: number): void => {
    b[o] = count & 0xff;
    b[o + 1] = ptr & 0xff;
    b[o + 2] = (ptr >> 8) & 0xff;
  };
  const nW = m.warps?.length ?? 0, nC = m.coordEvents?.length ?? 0, nB = m.bgEvents?.length ?? 0, nO = m.objects?.length ?? 0;
  let p = ev + 2; // two filler bytes, then the warp count
  put(at + 4, nW, p + 1);
  p += 1 + nW * 5;
  put(at + 7, nC, p + 1);
  p += 1 + nC * 8;
  put(at + 10, nB, p + 1);
  p += 1 + nB * 5;
  put(at + 13, nO, p + 1);
  const nS = Object.keys(m.sceneScripts ?? {}).length || (Array.isArray(m.sceneScripts) ? m.sceneScripts.length : 0);
  const nK = m.callbacks?.length ?? 0;
  put(at + 16, nS, sc + 1);
  put(at + 19, nK, sc + 1 + nS * 4 + 1);
  const sceneOff = Lo.scenes[mapId];
  const sceneW = sceneOff !== undefined ? sceneOff - Lo.blocks[0]!.sram + Lo.blocks[0]!.wram : 0;
  b[at] = sceneW & 0xff;
  b[at + 1] = (sceneW >> 8) & 0xff;
  // the roaming mons' "map the player is on"
  b[Lo.roamerCurMap] = m.map;
  b[Lo.roamerCurMap + 1] = m.group;
}
