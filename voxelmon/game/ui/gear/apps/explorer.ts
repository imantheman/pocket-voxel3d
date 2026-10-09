// EXPLORER: the area you are in, four ways -- AREA (an overhead map of the
// cells around you: walls, water, grass, exits, item balls, the people),
// WILD (what lives here and how often), TRAINERS (who is left to beat) and
// ITEMS (what is still lying around).
//
// The INFO level decides how much of it shows, as in the mod: VANILLA keeps
// to what the game would tell you (the map, no markers, no lists), ENHANCED
// fills the lists but keeps unseen POKéMON and hidden items secret, and
// SPOILERS shows everything.
import { picPageFor } from "../../../battle/staging.ts";
import {
  COLS, TILE_H, TILE_W, center, fit, rect, region, right, sprite, spriteFrame, text,
} from "../draw.ts";
import { assists, mapItems, mapTrainers, spoilers, wildRows } from "../model.ts";
import { stepper, tabs, type GearCtx } from "../ui.ts";

const PAGES = [
  { id: "area", label: "AREA" },
  { id: "wild", label: "WILD" },
  { id: "trainers", label: "TRNR" },
  { id: "items", label: "ITEM" },
];

/** An overworld sprite id ("SPRITE_YOUNGSTER") to its atlas page. */
export function spritePage(data: any, sprite: string | undefined): number {
  if (!sprite) return -1;
  const key = sprite.replace(/^SPRITE_/, "").toLowerCase();
  const p = data.atlas?.sprites?.[key];
  return typeof p === "number" ? p : -1;
}

function here(ctx: GearCtx): string {
  return ctx.game.overworld?.map?.id ?? "";
}

export function drawExplorer(ctx: GearCtx): void {
  const { ui } = ctx;
  const page = ui.page ?? "area";
  if (!here(ctx)) {
    center(ctx.host, 8, "NOWHERE YET");
  } else if (page === "area") {
    drawArea(ctx);
  } else if (!assists(ctx.save)) {
    center(ctx.host, 6, "INFO IS VANILLA:");
    center(ctx.host, 8, "SET IT TO ENHANCED");
    center(ctx.host, 10, "IN OPTIONS TO SEE");
    center(ctx.host, 12, "WHAT IS HERE.");
  } else if (page === "wild") {
    drawWild(ctx);
  } else if (page === "trainers") {
    drawTrainers(ctx);
  } else {
    drawItems(ctx);
  }
  tabs(ctx, PAGES, page, (id) => { ui.page = id; ui.top = 0; });
}

// ---------------------------------------------------------------------------
// AREA: the overhead map
// ---------------------------------------------------------------------------

/** Map cells are drawn 12px square; the window follows the player. */
const CELL = 12;
const AREA_Y = Math.ceil(TILE_H);
const AREA_H = Math.floor(16 * TILE_H) - AREA_Y;
const VIEW_W = Math.floor(320 / CELL);
const VIEW_H = Math.floor(AREA_H / CELL);
const OX = Math.floor((320 - VIEW_W * CELL) / 2);
const OY = AREA_Y + Math.floor((AREA_H - VIEW_H * CELL) / 2);

/** Frame of a sheet for a facing: 0 down, 1 up, 2 left (right = mirrored). */
function facingFrame(facing: string | undefined): { frame: number; mirror: boolean } {
  if (facing === "up") return { frame: 1, mirror: false };
  if (facing === "left") return { frame: 2, mirror: false };
  if (facing === "right") return { frame: 2, mirror: true };
  return { frame: 0, mirror: false };
}

/** How the AREA map shades a cell. */
const FLOOR = 0, GRASS = 1, WATER = 2, WALL = 3, WARP = 4;

/**
 * The cells of the map in view as the AREA map shades them, each worked out
 * the first time it is drawn and kept until the map changes (a new GameMap,
 * or a cut or a door changing one: map.version). Asking the map's cell
 * predicates for every cell in view, every frame, was 90 ms of a 3DS frame.
 * Stored as kind + 1, so 0 is "not yet asked".
 */
let kindsOf: {
  map: unknown;
  version: number;
  cells: Uint8Array;
  window: string;
  ground: number[];
} | null = null;

/** The map's cell cache, made afresh for a new map or a changed one. */
function kindCells(map: any): NonNullable<typeof kindsOf> {
  if (!kindsOf || kindsOf.map !== map || kindsOf.version !== (map.version ?? 0)) {
    kindsOf = {
      map, version: map.version ?? 0, cells: new Uint8Array(map.widthCells * map.heightCells),
      window: "", ground: [],
    };
  }
  return kindsOf;
}

/**
 * The ground under the window whose top-left cell is (cx0, cy0), as the
 * rects that draw it (x, y, w, h, shade each): walls darkest, water dark,
 * grass mid, floor left as paper, an exit a dark ring; a row's run of like
 * cells as one rect (the same squares, fewer of them). Kept while the
 * window stays put, so a person moving about in view redraws only people.
 */
function groundRects(map: any, cx0: number, cy0: number, padX: number, padY: number): number[] {
  const kinds = kindCells(map);
  const key = `${cx0},${cy0},${padX},${padY}`;
  if (kinds.window === key) return kinds.ground;
  const out: number[] = [];
  const cells = kinds.cells;
  const mw = map.widthCells;
  const x0 = OX + padX - cx0 * CELL;
  const cx1 = Math.min(cx0 + VIEW_W, mw);
  const cy1 = Math.min(cy0 + VIEW_H, map.heightCells);
  for (let cy = cy0; cy < cy1; cy++) {
    const y = OY + padY + (cy - cy0) * CELL;
    let runKind = FLOOR;
    let runX = 0;
    let runN = 0;
    for (let cx = cx0; cx < cx1; cx++) {
      const x = x0 + cx * CELL;
      const i = cy * mw + cx;
      let k = cells[i]!;
      if (k === 0) {
        k = askKind(map, cx, cy) + 1;
        cells[i] = k;
      }
      const kind = k - 1;
      if (runN > 0 && kind === runKind && kind !== WARP) {
        runN++;
        continue;
      }
      if (runN > 0 && runKind !== FLOOR) out.push(runX, y, runN * CELL, CELL, runKind);
      runN = 0;
      if (kind === WARP) {
        out.push(x, y, CELL, CELL, 3, x + 3, y + 3, CELL - 6, CELL - 6, 0);
        continue;
      }
      runKind = kind;
      runX = x;
      runN = 1;
    }
    if (runN > 0 && runKind !== FLOOR) out.push(runX, y, runN * CELL, CELL, runKind);
  }
  kinds.window = key;
  kinds.ground = out;
  return out;
}

/** A cell's kind, asked of the map (the order the shading always went in:
 *  an exit over everything, then water, walls, grass). */
function askKind(map: any, cx: number, cy: number): number {
  return map.warpAtCell?.(cx, cy) ? WARP
    : map.isWaterCell?.(cx, cy) ? WATER
    : !map.isWalkableCell(cx, cy) ? WALL
    : map.isGrassCell?.(cx, cy) ? GRASS
    : FLOOR;
}

/** What the AREA map draws from, as one string: it changes when a person
 *  (or you) changes cell or facing, or the map's cells do -- the gear's
 *  still-frame key (kantogear.ts) while EXPLORER is up. */
export function explorerKey(game: any): string {
  const ow = game.overworld;
  const map = ow?.map;
  const p = ow?.player;
  const ui = game.gearUi?.explorer;
  const page = ui?.page ?? "area";
  let k = `${page}|${ui?.top ?? 0}|${map?.id ?? ""}|${map?.version ?? 0}|${p?.cellX},${p?.cellY},${p?.facing}`;
  if (page === "area") {
    for (const n of ow?.npcs ?? []) k += `|${n.cellX},${n.cellY},${n.facing},${n.hidden ? 1 : 0}`;
  }
  return k;
}

function drawArea(ctx: GearCtx): void {
  const { host, game, data, save } = ctx;
  const ow = game.overworld;
  const map = ow?.map;
  const p = ow?.player;
  if (!map || !p) return;
  const cx0 = Math.max(0, Math.min(p.cellX - Math.floor(VIEW_W / 2), map.widthCells - VIEW_W));
  const cy0 = Math.max(0, Math.min(p.cellY - Math.floor(VIEW_H / 2), map.heightCells - VIEW_H));
  // a map smaller than the window (a house, a POKéMON CENTER) sits centred
  const padX = Math.max(0, Math.floor((VIEW_W - map.widthCells) * CELL / 2));
  const padY = Math.max(0, Math.floor((VIEW_H - map.heightCells) * CELL / 2));
  const at = (cx: number, cy: number) => ({ x: OX + padX + (cx - cx0) * CELL, y: OY + padY + (cy - cy0) * CELL });
  // the ground (groundRects)
  const ground = groundRects(map, cx0, cy0, padX, padY);
  for (let i = 0; i < ground.length; i += 5) {
    rect(host, ground[i]!, ground[i + 1]!, ground[i + 2]!, ground[i + 3]!, ground[i + 4]!);
  }
  const inView = (cx: number, cy: number) => cx >= cx0 && cy >= cy0 && cx < cx0 + VIEW_W && cy < cy0 + VIEW_H;
  // the item radar: balls (ENHANCED) and what is buried (SPOILERS)
  if (assists(save)) {
    const ball = spritePage(data, "SPRITE_POKE_BALL");
    for (const it of mapItems(data, save, map.id)) {
      if (it.taken || !inView(it.x, it.y)) continue;
      if (it.hidden && !spoilers(save)) continue;
      const s = at(it.x, it.y);
      if (it.hidden) rect(host, s.x + 4, s.y + 4, CELL - 8, CELL - 8, 2);
      else spriteFrame(host, ball, s.x, s.y, CELL);
    }
  }
  // the people on screen, then you
  for (const n of ow.npcs ?? []) {
    if (n.hidden || !inView(n.cellX, n.cellY)) continue;
    if (n.def?.item) continue; // a ball is an item, drawn above
    const s = at(n.cellX, n.cellY);
    const f = facingFrame(n.facing);
    spriteFrame(host, spritePage(data, n.def?.sprite), s.x, s.y, CELL, f.frame, f.mirror);
  }
  const me = at(p.cellX, p.cellY);
  const f = facingFrame(p.facing);
  spriteFrame(host, spritePage(data, "SPRITE_RED"), me.x, me.y, CELL, f.frame, f.mirror);
  region("area:map", 0, 1, COLS, 15, () => {});
}

// ---------------------------------------------------------------------------
// WILD / TRAINERS / ITEMS: scrolled lists, two rows an entry
// ---------------------------------------------------------------------------

const PER_PAGE = 6;

/** A list's page stepper on row 16, when it runs past one page. */
function pager(ctx: GearCtx, count: number): number {
  const { ui } = ctx;
  const pages = Math.max(1, Math.ceil(count / PER_PAGE));
  ui.top = Math.min(ui.top ?? 0, (pages - 1) * PER_PAGE);
  if (pages > 1) {
    const at = Math.floor(ui.top / PER_PAGE);
    stepper(ctx, `${at + 1}/${pages}`,
      () => { ui.top = ((at + pages - 1) % pages) * PER_PAGE; },
      () => { ui.top = ((at + 1) % pages) * PER_PAGE; }, 16);
  }
  return ui.top;
}

function drawWild(ctx: GearCtx): void {
  const { host, data, save } = ctx;
  const inv = save?.inventory ?? {};
  const rods = { OLD_ROD: inv.OLD_ROD > 0, GOOD_ROD: inv.GOOD_ROD > 0, SUPER_ROD: inv.SUPER_ROD > 0 };
  const rows = wildRows(data, here(ctx), rods);
  if (rows.length === 0) { center(host, 8, "NO WILD POKéMON"); return; }
  const top = pager(ctx, rows.length);
  const seen = save?.pokedex?.seen ?? {};
  const owned = save?.pokedex?.owned ?? {};
  rows.slice(top, top + PER_PAGE).forEach((r, k) => {
    const y0 = 2 + k * 2;
    const known = seen[r.species] || owned[r.species] || spoilers(save);
    const name = known ? data.pokemon?.[r.species]?.name ?? r.species : "?????";
    if (known) sprite(host, picPageFor(data, r.species), 0, y0 * TILE_H, 2 * TILE_W - 2, 2 * TILE_H - 1);
    text(host, 2, y0, fit(name, 10));
    const lv = r.minLv === r.maxLv ? `L${r.minLv}` : `L${r.minLv}-${r.maxLv}`;
    right(host, y0, lv);
    text(host, 2, y0 + 1, `${r.method} ${r.pct}%`);
    if (owned[r.species]) right(host, y0 + 1, "OWN");
  });
}

function drawTrainers(ctx: GearCtx): void {
  const { host, data, save } = ctx;
  const rows = mapTrainers(data, save, here(ctx));
  if (rows.length === 0) { center(host, 8, "NO TRAINERS HERE"); return; }
  const top = pager(ctx, rows.length);
  const left = rows.filter((r) => !r.beaten).length;
  right(host, 1, `${left} LEFT`, "dark", 20);
  rows.slice(top, top + PER_PAGE).forEach((r, k) => {
    const y0 = 2 + k * 2;
    spriteFrame(host, spritePage(data, r.obj.sprite), 2, y0 * TILE_H + 4, 2 * TILE_H - 4);
    text(host, 2, y0, fit(r.name, 11));
    right(host, y0, r.beaten ? "BEATEN" : "READY");
    if (spoilers(save) && r.party.length) {
      text(host, 2, y0 + 1, fit(r.party.map((m) => `${(data.pokemon?.[m.species]?.name ?? m.species).slice(0, 4)}${m.level}`).join(" "), 18));
    } else {
      text(host, 2, y0 + 1, `${r.party.length} POKéMON`);
    }
  });
}

function drawItems(ctx: GearCtx): void {
  const { host, save } = ctx;
  const all = mapItems(ctx.data, save, here(ctx));
  const hidden = all.filter((i) => i.hidden);
  const rows = all.filter((i) => !i.hidden || spoilers(save));
  if (rows.length === 0 && hidden.length === 0) { center(host, 8, "NOTHING LEFT HERE"); return; }
  const top = pager(ctx, rows.length);
  rows.slice(top, top + PER_PAGE).forEach((it, k) => {
    const y0 = 2 + k * 2;
    text(host, 1, y0, fit(it.name, 12));
    right(host, y0, it.taken ? "FOUND" : "LEFT");
    text(host, 1, y0 + 1, it.hidden ? "HIDDEN" : "ITEM BALL");
  });
  if (!spoilers(save) && hidden.length) {
    // ENHANCED knows there is something buried, not what or where
    const left = hidden.filter((h) => !h.taken).length;
    text(host, 1, 15, left ? `+${left} HIDDEN SOMEWHERE` : "HIDDEN ITEMS: ALL FOUND");
  }
}
