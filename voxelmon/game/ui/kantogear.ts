// Kanto Gear companion (3DS bottom screen). A native reimplementation of the
// dual-screen mod (github.com/AverageConsumer/kanto-gear, MIT) for pocket-
// voxel: instead of a second LÖVE window driven by gen1recomp's mod runtime,
// it draws to the core's `ui_b` surface through the host's uiTileBottom ops,
// which the 3DS host renders to the bottom screen.
//
// Views:
//   PARTY DETAIL — per mon, name + level + status, and a real GB HP bar (the
//     same hpBarTiles the battle HUD uses) with current/max HP.
//   BATTLE       — mirrors the top-screen battle, one panel per WildBattle
//     phase: the FIGHT/PKMN/ITEM/RUN action grid (menu), the move list
//     (moveSelect), the party switch list (party) and the ball bag (item).
//     Each panel carries the ▶ cursor on the phase's own index, so selecting
//     an action on the top screen advances the bottom screen with it.
// Other views (local map, trainer card) draw into ui_b the same way; a full
// view switcher comes with touch input.
import { encodeGlyphs, SPACE } from "./tiles.ts";
import {
  ARROW_CURSOR,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
} from "./tiles.ts";
import { UI_TILE } from "../../../contracts/spec/voxel-spec.ts";
import { hpBarTiles } from "../battle/ui.ts";
import { picPageFor } from "../battle/staging.ts";
import type { VoxelHost } from "../host.ts";

// The companion grid is the same 20x18 the top UI uses (spec UI_COLS/UI_ROWS).
const COLS = 20;
const ROWS = 18;
// The bottom target is the full 320x240 filled by that grid (main.rs
// tpxx=320/COLS, tpxy=240/ROWS), so a touch pixel maps straight to a cell.
const TILE_W = 320 / COLS; // 16
const TILE_H = 240 / ROWS; // 13.33

interface GearMon {
  species: string;
  level: number;
  hp: number;
  stats?: { hp: number };
  status?: string | null;
  nickname?: string;
}

/** One move slot as the battle carries it (mon.ts MoveSlot): id + current PP.
 * The display name and max PP come from data.moves[id]. */
interface GearMoveSlot {
  id: string;
  pp: number;
}

/** The BattleInput shape (battle.ts:62). A bottom-screen tap drives the battle
 * by setting the phase's cursor and feeding one synthetic A-press through the
 * real update() handler — so touch and buttons share one code path. */
interface GearBattleInput {
  isDown: (b: string) => boolean;
  wasPressed: (b: string) => boolean;
}

/** The live battle state the panel mirrors. Every field is a plain public
 * member of WildBattle (battle.ts:144-217), read-only from here. */
interface GearBattle {
  phase: "messages" | "menu" | "moveSelect" | "party" | "item" | "forget";
  /** battle.ts forgetView(): the replace-move prompt's state, or null. */
  forgetView?(): { name: string; moves: string[]; index: number; learning: string } | null;
  menuIndex: number; // 1..4, FIGHT/PKMN over ITEM/RUN (battle.ts:753)
  moveIndex: number; // 1-based into player.curMoves
  partyIndex: number; // 0-based into save.party
  itemIndex: number; // 0-based into itemList
  itemList: string[]; // ball ids openItems() narrowed to (battle.ts:1371)
  /** Present only in a SAFARI battle (battle/safari.ts): the live ball count. */
  safari?: { balls: number } | null;
  /** sayChoice's YES/NO box (battle.ts:558-594, ChoiceBox.lua:34-45).
   * choiceOpen can be true while phase stays "messages" — it overlays the
   * still-visible dialog rather than being a phase of its own. */
  choiceOpen: boolean;
  choiceYes: boolean;
  player: { name: string; curMoves: GearMoveSlot[] };
  /** The rolling battle-message window (battle.ts shown[]): up to two lines,
   * each already encoded to glyph codes, with a per-line reveal count for the
   * typewriter. Non-last lines are fully revealed. */
  shown: { text: string; codes: number[]; revealed: number }[];
  msgWaiting: boolean; // holding for a press/tap to continue (battle.ts:200)
  msgPrompt: boolean; // a typed page is waiting to advance (battle.ts:202)
  /** The wild/enemy battler — its current types drive move effectiveness. */
  enemy?: { curTypes: readonly string[] };
  /** Gen-1 type chart (battle.ts:137). x10 multiplier vs the defender types. */
  chart?: { effectiveness: (moveType: string, defenderTypes: readonly string[]) => number };
  /** Run one battle step (battle.ts:707). Touch feeds it a synthetic A-press. */
  update: (input: GearBattleInput) => void;
}
interface GearBattleView {
  battle: GearBattle;
}

/** One TOWN MAP location: field.townMap.locations, keyed by map id. */
interface GearTownMapLoc {
  name: string;
  x: number;
  y: number;
}

/** The minimal shape the panel reads — kept loose so it doesn't couple to the
 * full game type. All paths exist on the real VoxelmonGame / VoxelmonData. */
interface GearGame {
  save?: {
    party?: GearMon[];
    inventory?: Record<string, number>;
  };
  data: {
    pokemon: Record<string, { name: string } | undefined>;
    moves: Record<string, { name: string; pp: number; type?: string; power?: number } | undefined>;
    items: Record<string, { name: string } | undefined>;
    /** Page indices the cook wrote (cook/gamedata.ts AtlasIndex). */
    atlas?: { townMapPage?: number | null; townMapCursorPage?: number | null };
    field?: { townMap?: { locations?: Record<string, GearTownMapLoc> } };
  };
  /** Non-null while a wild/trainer battle is on the stack (game.ts:881). */
  battleView?: () => GearBattleView | null;
  /** Which companion view is up, and the setter a tab tap calls. */
  gearView?: GearViewId;
  setGearView?: (v: GearViewId) => void;
  /** The location the map cursor sits on, or null to follow the player. */
  gearMapPick?: string | null;
  setGearMapPick?: (id: string | null) => void;
  /** The live map. Its id is on the GameMap; game.ts reads it the same way. */
  overworld?: { mapId?: string; map?: { id?: string } };
}

export type GearViewId = "party" | "map";

/** Stamp a label into the bottom grid, glyph by glyph (tile id == code), the
 * same way scene.ts's stamp() fills the top grid. Clipped to the grid width. */
function stampBottom(host: VoxelHost, x: number, y: number, s: string, bit = 0): void {
  const codes = encodeGlyphs(s);
  for (let i = 0; i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i]! | bit);
  }
}

/** Right-align a label so its last glyph sits one cell in from the edge. */
function stampRight(host: VoxelHost, y: number, s: string): void {
  stampBottom(host, Math.max(0, COLS - s.length - 1), y, s);
}

/** Write pre-encoded tile codes (e.g. an HP bar) straight into the grid. */
function tilesBottom(host: VoxelHost, x: number, y: number, tiles: number[]): void {
  for (let i = 0; i < tiles.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, tiles[i]!);
  }
}

// High bit on a ui_b tile flags it LIGHT (drawn in the light-green colour) so
// text reads on the dark top bar (main.rs's LIGHT_BIT). Glyph codes are small,
// so the bit is always free.
const LIGHT_BIT = 0x8000;

/** Stamp light-green text — for the dark top bar. */
function stampLight(host: VoxelHost, x: number, y: number, s: string): void {
  const codes = encodeGlyphs(s);
  for (let i = 0; i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i]! | LIGHT_BIT);
  }
}

// FILL_BIT (main.rs 0x4000): the cell gets a solid DARK quad and its glyph is
// drawn LIGHT via the interpolate stage — an inverted cell (dark box, light
// text), the mod's selected battle option. fillCellBottom lays the dark
// backdrop (blank SPACE glyphs); stampFill writes the light label over it.
const FILL_BIT = 0x4000;

// DARKTEXT_BIT (main.rs 0x2000): dark glyph on the light clear with no opaque
// dark-green cell behind it — for unselected labels and borders, so they read
// as dark strokes on the background instead of a boxed "highlight".
const DARKTEXT_BIT = 0x2000;

/** Fill a rect with solid dark cells — the selected option's backdrop. */
function fillCellBottom(host: VoxelHost, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w && x < COLS; x++) {
      host.uiTileBottom(x, y, SPACE | FILL_BIT);
    }
  }
}

/** Stamp light-green text over the dark fill — the selected option's label. */
function stampFill(host: VoxelHost, x: number, y: number, s: string): void {
  const codes = encodeGlyphs(s);
  for (let i = 0; i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i]! | FILL_BIT);
  }
}

/** Draw a GB text-box border (dark) — TextBox.lua drawBox, the same border
 * glyphs the top-screen dialogue frame uses. Interior is left on the light
 * clear. w,h are the outer tile extents (>= 2). */
function boxBottom(host: VoxelHost, x0: number, y0: number, w: number, h: number, bit = 0): void {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  host.uiTileBottom(x0, y0, BORDER_TL | bit);
  host.uiTileBottom(x1, y0, BORDER_TR | bit);
  host.uiTileBottom(x0, y1, BORDER_BL | bit);
  host.uiTileBottom(x1, y1, BORDER_BR | bit);
  for (let x = x0 + 1; x < x1; x++) {
    host.uiTileBottom(x, y0, BORDER_H | bit);
    host.uiTileBottom(x, y1, BORDER_H | bit);
  }
  for (let y = y0 + 1; y < y1; y++) {
    host.uiTileBottom(x0, y, BORDER_V | bit);
    host.uiTileBottom(x1, y, BORDER_V | bit);
  }
}

/**
 * The device wall-clock as "H:MMPM", like the real mod's status bar. Uses the
 * guest Date (the 3DS RTC via QuickJS); if the runtime has no working clock it
 * returns "" and the slot stays blank rather than showing a wrong time.
 */
function clockStr(): string {
  try {
    const d = new Date();
    const m = d.getMinutes();
    let h = d.getHours();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    const mm = m < 10 ? "0" + String(m) : String(m);
    return String(h) + ":" + mm + ap;
  } catch {
    return "";
  }
}

/** The dark header bar: a title on the left, the clock on the right. main.rs
 * paints the solid dark strip behind row 0; we draw light glyphs over it. */
function drawTopBar(host: VoxelHost, title: string): void {
  stampLight(host, 1, 0, title);
  const t = clockStr();
  if (t) stampLight(host, Math.max(0, COLS - t.length - 1), 0, t);
}

// FIGHT/PKMN over ITEM/RUN — the pokered main battle menu (battle.ts maps
// menuIndex 1..4 to fight/pkmn/item/run in this reading order).
const BATTLE_ACTIONS = ["FIGHT", "PKMN", "ITEM", "RUN"] as const;
/** DisplayBattleMenu's safari branch (battle/safari.ts SAFARI_ACTIONS). */
const SAFARI_ACTIONS = ["BALL", "BAIT", "ROCK", "RUN"] as const;

/**
 * The four-button action grid, the selected cell carrying the ▶ cursor. Two
 * 10-wide columns fill the full grid width; two 8-tall rows sit below the
 * header. When showCursor is false (the messages phase, while text/animation
 * plays on top) the grid shows as a passive backdrop with no selection.
 */
function drawActionGrid(
  host: VoxelHost,
  menuIndex: number,
  showCursor: boolean,
  safari?: { balls: number } | null,
): void {
  host.uiClearBottom();
  // A SAFARI battle has its own four; the ball count rides the bar, where the
  // original prints it beside the menu.
  drawTopBar(host, safari ? `SAFARI BALLS ${safari.balls}` : "BATTLE");

  const cellW = 10;
  const cellH = 8;
  const colX = [0, 10];
  const rowY = [2, 10];
  for (let i = 0; i < 4; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    const label = (safari ? SAFARI_ACTIONS : BATTLE_ACTIONS)[i]!;
    const iw = cellW - 2; // interior width
    const lx = x0 + 1 + Math.max(0, Math.floor((iw - label.length) / 2));
    const ly = y0 + Math.floor(cellH / 2);
    if (showCursor && i === menuIndex - 1) {
      // Selected: solid dark fill with its border, label in the light colour —
      // the look already dialed in. Fill first so the border lines up on top.
      fillCellBottom(host, x0, y0, cellW, cellH);
      boxBottom(host, x0, y0, cellW, cellH);
      stampFill(host, lx, ly, label);
    } else {
      // Unselected: a dark border + dark label as strokes on the light clear
      // (DARKTEXT_BIT), so nothing gets an opaque dark-green cell behind it.
      boxBottom(host, x0, y0, cellW, cellH, DARKTEXT_BIT);
      stampBottom(host, lx, ly, label, DARKTEXT_BIT);
    }
  }
}

/**
 * FIGHT -> the move list. Each move gets a name row and a "PP cur/max" row; the
 * ▶ cursor sits at column 0 of the selected move's name row (moveIndex is
 * 1-based, battle.ts:788-792). Four moves fill rows 2..13.
 */
/** Format a x10 type multiplier as the mod's cell tag: 1X, 2X, 4X, ½ as .5X. */
function effLabel(e10: number): string {
  if (e10 % 10 === 0) return String(e10 / 10) + "X";
  return (e10 / 10).toString().replace(/^0/, "") + "X";
}

function drawMoveSelect(host: VoxelHost, game: GearGame, b: GearBattle): void {
  host.uiClearBottom();
  drawTopBar(host, "MOVES");

  const moves = b.player.curMoves;
  const cellW = 10;
  const cellH = 8;
  const colX = [0, 10];
  const rowY = [2, 10];
  const qmark = encodeGlyphs("?")[0]!;
  for (let i = 0; i < 4; i++) {
    if (i >= moves.length) continue; // empty slot: blank, like the mod
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    const slot = moves[i]!;
    const def = game.data.moves[slot.id];
    const name = (def?.name ?? slot.id).slice(0, 7);
    const maxPp = def?.pp ?? slot.pp;
    const type = (def?.type ?? "").toUpperCase().slice(0, 6);
    const power = def?.power ?? 0;
    const selected = i === b.moveIndex - 1;
    const bit = selected ? FILL_BIT : DARKTEXT_BIT;

    if (selected) fillCellBottom(host, x0, y0, cellW, cellH);
    boxBottom(host, x0, y0, cellW, cellH, selected ? 0 : DARKTEXT_BIT);

    // name + the ? info tag in the corner
    stampBottom(host, x0 + 1, y0 + 1, name, bit);
    host.uiTileBottom(x0 + cellW - 2, y0 + 1, qmark | bit);
    // PP current/max
    stampBottom(host, x0 + 1, y0 + 3, "PP " + String(slot.pp) + "/" + String(maxPp), bit);
    // type on the left, effectiveness tag on the right
    stampBottom(host, x0 + 1, y0 + 5, type, bit);
    let eff = "--";
    if (power > 0 && b.enemy && b.chart) {
      eff = effLabel(b.chart.effectiveness(def!.type ?? "", b.enemy.curTypes));
    }
    stampBottom(host, x0 + cellW - 1 - eff.length, y0 + 5, eff, bit);
  }
}

/**
 * The replace-move prompt (battle.ts learnMove / updateForget): the mon's
 * four moves plus a cancel row, with the move being offered in the header so
 * the choice is visible while making it. A plain list rather than the 2x2
 * move grid — this picks a move to DELETE, and reading it as the familiar
 * attack grid would invite picking one to use.
 */
function drawForgetList(host: VoxelHost, b: GearBattle): void {
  host.uiClearBottom();
  const f = b.forgetView?.();
  if (!f) return;
  drawTopBar(host, ("LEARN " + f.learning).slice(0, 18));
  stampBottom(host, 1, 2, (f.name + " FORGETS?").slice(0, 18));
  f.moves.forEach((name: string, i: number) => {
    const y = 4 + i * 2;
    stampBottom(host, 2, y, name.slice(0, 14));
    if (i === f.index) host.uiTileBottom(0, y, ARROW_CURSOR);
  });
  const cancelY = 4 + f.moves.length * 2;
  stampBottom(host, 2, cancelY, "DON'T LEARN");
  if (f.index >= f.moves.length) host.uiTileBottom(0, cancelY, ARROW_CURSOR);
}

/**
 * ITEM -> the (ball-only, v1) battle bag. One row per item: name left, count
 * right, ▶ cursor at column 0 on the selected row (itemIndex is 0-based,
 * battle.ts:1388-1391).
 */
/** Rows the ITEM list shows at once; the list scrolls to keep the cursor on. */
const ITEM_ROWS = 12;

/** The first item drawn, so the cursor is always among the rows shown. */
function itemListTop(b: GearBattle): number {
  return Math.max(0, Math.min(b.itemIndex - (ITEM_ROWS - 1), b.itemList.length - ITEM_ROWS));
}

function drawItemList(host: VoxelHost, game: GearGame, b: GearBattle): void {
  host.uiClearBottom();
  drawTopBar(host, "ITEMS");

  // The whole bag now, not the balls alone, so it scrolls: a window of
  // ITEM_ROWS that follows the cursor down and back up.
  const top = itemListTop(b);
  for (let i = top; i < b.itemList.length && i < top + ITEM_ROWS; i++) {
    const id = b.itemList[i]!;
    const name = game.data.items[id]?.name ?? id;
    const count = game.save?.inventory?.[id] ?? 0;
    const y = 2 + (i - top);
    stampBottom(host, 2, y, name.slice(0, 13));
    stampRight(host, y, "x" + String(count));
    if (i === b.itemIndex) host.uiTileBottom(0, y, ARROW_CURSOR);
  }
}

/**
 * The party roster. Two rows per mon (name/level, then HP bar + current/max).
 * When cursor >= 0 (the battle switch menu, PKMN / a forced faint replacement)
 * the ▶ cursor marks the selected mon's name row; -1 for the passive overworld
 * panel. Retained-mode safe via the leading clear.
 */
function drawPartyList(
  host: VoxelHost,
  game: GearGame,
  title: string,
  cursor: number,
): void {
  host.uiClearBottom();
  drawTopBar(host, title);

  const party = game.save?.party ?? [];
  const cellW = 10;
  const cellH = 5;
  const colX = [0, 10];
  const rowY = [2, 7, 12];
  for (let i = 0; i < 6; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    if (i >= party.length) continue; // empty party slot: blank cell
    const mon = party[i]!;
    const full = mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species;
    // The name row runs from x0+3 to the cell's inner edge at x0+9: seven
    // glyphs. Only a name longer than that is shortened, and to six plus a
    // stop -- it used to cut everything past five, so CHARMANDER read as
    // CHARM. in a cell with two more columns to spare.
    const name = full.length > 7 ? full.slice(0, 6) + "." : full;
    const maxHp = mon.stats?.hp ?? mon.hp;

    boxBottom(host, x0, y0, cellW, cellH, DARKTEXT_BIT);
    // Sprite nook (x0+1..x0+2, two rows) holds the mon's front sprite via
    // uiSpriteBottom (voxel-spec op 78). picPageFor returns -1 on a pak
    // cooked without the front-sprite atlas; the nook is left blank rather
    // than drawing a garbage page. The nook's opaque sprite quad draws AFTER
    // the tile grid (main.rs bottom draw order), so the selection cursor
    // moves to the box's top-left corner instead of sitting in the nook,
    // where a sprite would now paint over it.
    const spritePage = picPageFor(game.data as unknown as Parameters<typeof picPageFor>[0], mon.species);
    if (spritePage >= 0) {
      host.uiSpriteBottom(
        spritePage,
        (x0 + 1) * TILE_W,
        (y0 + 1) * TILE_H,
        2 * TILE_W - 2,
        2 * TILE_H - 1,
      );
    }
    if (cursor === i) host.uiTileBottom(x0, y0, ARROW_CURSOR | DARKTEXT_BIT);
    stampBottom(host, x0 + 3, y0 + 1, name, DARKTEXT_BIT);
    stampBottom(host, x0 + 3, y0 + 2, "L" + String(mon.level), DARKTEXT_BIT);
    // Drop the leading "HP" label glyph so the 8-tile bar fits the cell.
    tilesBottom(host, x0 + 1, y0 + 3, hpBarTiles(mon.hp, maxHp, true).slice(1));
    if (mon.status) stampBottom(host, x0 + 6, y0 + 2, mon.status.slice(0, 3), DARKTEXT_BIT);
  }
}

/**
 * Battle dialog, on the bottom screen (the top screen no longer draws the
 * message box). Mirrors the GB text area: up to two rolling lines, typed out
 * via each line's reveal count, with a divider + TAP TO CONTINUE prompt while
 * the box holds for input. Codes come pre-encoded from battle.shown.
 */
function drawBattleMessage(host: VoxelHost, b: GearBattle): void {
  host.uiClearBottom();
  drawTopBar(host, "BATTLE");
  boxBottom(host, 0, 2, COLS, 14, DARKTEXT_BIT); // rows 2..15

  const rows = [5, 7];
  b.shown.forEach((line, i) => {
    if (i >= rows.length) return;
    const isLast = i === b.shown.length - 1;
    const n = isLast ? line.revealed : line.codes.length;
    for (let c = 0; c < n && c < line.codes.length && 2 + c < COLS - 1; c++) {
      host.uiTileBottom(2 + c, rows[i]!, line.codes[c]! | DARKTEXT_BIT);
    }
  });

  if (b.msgWaiting || b.msgPrompt) {
    for (let x = 2; x < COLS - 2; x++) {
      host.uiTileBottom(x, 11, BORDER_H | DARKTEXT_BIT);
    }
    const tip = "TAP TO CONTINUE";
    const tx = Math.max(2, Math.floor((COLS - tip.length) / 2));
    stampBottom(host, tx, 13, tip, DARKTEXT_BIT);
  }

  // sayChoice's YES/NO box (battle.ts:558-594 / ChoiceBox.lua:34-45), ported
  // from the top screen at the same (14,7) 6x5 cell rect ui.ts used to draw
  // it (battle/ui.ts's repaint) — it sits inside this same dialog box
  // (rows 2..15), so the coordinates carry over unchanged.
  if (b.choiceOpen) {
    boxBottom(host, 14, 7, 6, 5, DARKTEXT_BIT);
    stampBottom(host, 16, 8, "YES", DARKTEXT_BIT);
    stampBottom(host, 16, 10, "NO", DARKTEXT_BIT);
    host.uiTileBottom(15, b.choiceYes ? 8 : 10, ARROW_CURSOR | DARKTEXT_BIT);
  }
}

/**
 * BATTLE dispatch: pick the panel that mirrors the battle's current phase, so
 * the bottom screen follows the top screen through move / party / item menus
 * instead of freezing on the action grid.
 */
function drawBattleGear(host: VoxelHost, game: GearGame, b: GearBattle): void {
  switch (b.phase) {
    case "forget":
      drawForgetList(host, b);
      return;
    case "moveSelect":
      drawMoveSelect(host, game, b);
      return;
    case "party":
      drawPartyList(host, game, "PKMN", b.partyIndex);
      return;
    case "item":
      drawItemList(host, game, b);
      return;
    case "menu":
      drawActionGrid(host, b.menuIndex, true, b.safari ?? null);
      return;
    default: // "messages": battle dialog now lives on the bottom screen
      drawBattleMessage(host, b);
      return;
  }
}

/**
 * Redraw the companion surface for this frame. A battle on the stack takes over
 * with the phase-mirroring battle panels; otherwise the party-detail panel
 * shows.
 */
// ---------------------------------------------------------------------------
// the view switcher
// ---------------------------------------------------------------------------

interface GearTab {
  id: GearViewId;
  label: string;
}

/**
 * The tabs available right now. PARTY is always there; MAP appears only once
 * the bag holds the TOWN MAP, which is Blue's sister's gift — the same gate
 * the original puts on the item (you cannot open a map you were never given).
 * More views slot in here as they arrive.
 */
export function gearTabs(game: GearGame): GearTab[] {
  const tabs: GearTab[] = [{ id: "party", label: "PARTY" }];
  if ((game.save?.inventory?.TOWN_MAP ?? 0) > 0 && hasTownMap(game)) {
    tabs.push({ id: "map", label: "MAP" });
  }
  return tabs;
}

/** A pak cooked before the town map pages existed draws no MAP tab. */
function hasTownMap(game: GearGame): boolean {
  const a = game.data.atlas;
  return typeof a?.townMapPage === "number" && a.townMapPage >= 0;
}

/** The active view, clamped to a tab that actually exists. */
function activeView(game: GearGame): GearViewId {
  const want = game.gearView ?? "party";
  return gearTabs(game).some((t) => t.id === want) ? want : "party";
}

/** The view after `from`, `dir` steps along. Wraps. */
export function gearViewStep(game: GearGame, dir: 1 | -1): GearViewId {
  const tabs = gearTabs(game);
  const at = Math.max(0, tabs.findIndex((t) => t.id === activeView(game)));
  return tabs[(at + dir + tabs.length) % tabs.length]!.id;
}

/**
 * The view name centred on the status bar between a matched pair of arrows,
 * the way the Kanto Gear mod titles its screens — the shoulder buttons step
 * it, and the arrows are tappable for the same thing.
 *
 * Centred in the space LEFT of the clock rather than on the bar, so a long
 * name cannot run into it.
 */
const CLOCK_COL = COLS - 8;

function drawGearHeader(host: VoxelHost, game: GearGame, label: string): void {
  const many = gearTabs(game).length > 1;
  const w = label.length + (many ? 4 : 0);
  const x = Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  if (many) {
    host.uiTileBottom(x, 0, UI_TILE.arrowLeft | LIGHT_BIT);
    host.uiTileBottom(x + w - 1, 0, ARROW_CURSOR | LIGHT_BIT);
  }
  stampLight(host, x + (many ? 2 : 0), 0, label);
  const t = clockStr();
  if (t) stampLight(host, Math.max(0, COLS - t.length - 1), 0, t);
}

/** Which cells the header's arrows occupy, for the hit test. */
function headerArrowCols(game: GearGame, label: string): { left: number; right: number } | null {
  if (gearTabs(game).length < 2) return null;
  const w = label.length + 4;
  const x = Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  return { left: x, right: x + w - 1 };
}

/**
 * The bottom strip: a dark bar with one centred label, which is where the mod
 * puts the map's location name.
 */
function drawBottomBar(host: VoxelHost, text: string): void {
  fillCellBottom(host, 0, ROWS - 1, COLS, 1);
  stampFill(host, Math.max(0, Math.floor((COLS - text.length) / 2)), ROWS - 1, text);
}

// --- the TOWN MAP view -----------------------------------------------------

// The composed page (cook/atlas.ts buildTownMapPage) is the GB screen's own
// 20x18 tiles. It is blitted whole, scaled to fit the area under the tab
// strip with its aspect kept — a stretched Kanto reads as a wrong map.
const MAP_W = 160;
const MAP_H = 144;
// Between the status bar and the location strip, inset a few pixels so the
// map sits in a margin instead of butting against both bars — the mod's own
// framing.
const MAP_INSET = 4;
const MAP_AREA_Y = Math.round(TILE_H) + MAP_INSET;
const MAP_AREA_H = Math.round((ROWS - 1) * TILE_H) - MAP_AREA_Y - MAP_INSET;
const MAP_SCALE = Math.min(320 / MAP_W, MAP_AREA_H / MAP_H);
const MAP_DRAW_W = Math.round(MAP_W * MAP_SCALE);
const MAP_DRAW_H = Math.round(MAP_H * MAP_SCALE);
const MAP_X = Math.round((320 - MAP_DRAW_W) / 2);
const MAP_Y = MAP_AREA_Y + Math.round((MAP_AREA_H - MAP_DRAW_H) / 2);

/**
 * TownMapCoordsToOAMCoords (engine/items/town_map.asm): a location's grid
 * (x,y) is the 8x8 cell at map pixel (x*8+16, y*8+8). The 16x16 marker is
 * centred on that cell, so it starts 4px up and left of it.
 */
function locPixel(loc: GearTownMapLoc): { x: number; y: number } {
  return { x: loc.x * 8 + 16, y: loc.y * 8 + 8 };
}

/** Map-page pixel -> bottom-screen pixel. */
function mapToScreen(px: number, py: number): { x: number; y: number } {
  return { x: MAP_X + Math.round(px * MAP_SCALE), y: MAP_Y + Math.round(py * MAP_SCALE) };
}

/** The bottom-screen pixel at the centre of a location's square. */
export function gearMapPoint(loc: GearTownMapLoc): { x: number; y: number } {
  const p = locPixel(loc);
  return mapToScreen(p.x + 4, p.y + 4);
}

function townMapLocations(game: GearGame): Record<string, GearTownMapLoc> {
  return game.data.field?.townMap?.locations ?? {};
}

/**
 * One entry per SQUARE, not per map — most of the 226 locations are interiors
 * pointing at their town's square (every Celadon building says CELADON CITY),
 * and picking between them by iteration order would be arbitrary. The same
 * dedupe TownMap.lua does when it builds its cursor list.
 *
 * The survivor is the map whose id IS the place ("CELADON_CITY" spelled out
 * matches "CELADON CITY"); where no map is named after the square — BILLS_HOUSE
 * is the SEA COTTAGE — the lowest id wins, so the choice is at least stable.
 */
function townMapPlaces(game: GearGame): { id: string; loc: GearTownMapLoc }[] {
  const bySquare = new Map<string, { id: string; loc: GearTownMapLoc }>();
  for (const id of Object.keys(townMapLocations(game)).sort()) {
    const loc = townMapLocations(game)[id]!;
    const key = `${loc.x},${loc.y}`;
    const held = bySquare.get(key);
    if (!held || (held.id.replace(/_/g, " ") !== held.loc.name
                  && id.replace(/_/g, " ") === loc.name)) {
      bySquare.set(key, { id, loc });
    }
  }
  return [...bySquare.values()];
}

/** The location the cursor is on: the player's tap, else where they stand. */
function focusedLocation(game: GearGame): { id: string; loc: GearTownMapLoc } | null {
  const locs = townMapLocations(game);
  const picked = game.gearMapPick;
  if (picked && locs[picked]) return { id: picked, loc: locs[picked]! };
  const ow = game.overworld;
  const here = ow?.mapId ?? ow?.map?.id;
  if (here && locs[here]) return { id: here, loc: locs[here]! };
  return null;
}

function drawTownMapView(host: VoxelHost, game: GearGame): void {
  host.uiClearBottom();
  const focus = focusedLocation(game);
  drawGearHeader(host, game, "MAP");
  // The place name gets the bottom strip to itself, so it has the width for
  // "POKéMON LEAGUE" instead of fighting the clock for the status bar.
  drawBottomBar(host, focus?.loc.name ?? "TOWN MAP");

  const page = game.data.atlas?.townMapPage;
  if (typeof page !== "number" || page < 0) {
    stampBottom(host, 2, 4, "NO MAP DATA", DARKTEXT_BIT);
    return;
  }
  host.uiSpriteBottom(page, MAP_X, MAP_Y, MAP_DRAW_W, MAP_DRAW_H);

  // The marker rides on top as a second sprite: sprites draw after the tile
  // grid and in call order, so a tile overlay would be hidden by the map.
  const cursorPage = game.data.atlas?.townMapCursorPage;
  if (focus && typeof cursorPage === "number" && cursorPage >= 0) {
    const p = locPixel(focus.loc);
    const at = mapToScreen(p.x - 4, p.y - 4);
    const size = Math.round(16 * MAP_SCALE);
    host.uiSpriteBottom(cursorPage, at.x, at.y, size, size);
  }
}

export function drawKantoGear(host: VoxelHost, game: GearGame): void {
  const bv = game.battleView?.();
  const b = bv?.battle;
  if (b) {
    drawBattleGear(host, game, b);
    return;
  }
  if (activeView(game) === "map") {
    drawTownMapView(host, game);
    return;
  }
  drawPartyList(host, game, "", -1);
  drawGearHeader(host, game, "PARTY");
}

/**
 * A tap on the TOWN MAP: move the marker to the nearest location and read its
 * name in the banner, which is what the original's d-pad cursor does. A tap
 * that lands nowhere near a location clears the pick, so the marker goes back
 * to following the player.
 */
function gearMapTouch(game: GearGame, x: number, y: number): void {
  if (!game.setGearMapPick) return;
  // screen -> the map page's own pixels
  const px = (x - MAP_X) / MAP_SCALE;
  const py = (y - MAP_Y) / MAP_SCALE;
  if (px < 0 || py < 0 || px >= MAP_W || py >= MAP_H) return;
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const { id, loc } of townMapPlaces(game)) {
    const p = locPixel(loc);
    // + 4 for the cell's centre, so the nearest location is measured from
    // the middle of its square rather than its corner
    const d = (p.x + 4 - px) ** 2 + (p.y + 4 - py) ** 2;
    if (d < bestD) { bestD = d; bestId = id; }
  }
  // Two cells' slack: closer than that and the tap plainly meant that place.
  game.setGearMapPick(bestD <= 16 * 16 ? bestId : null);
}

/** One synthetic A-press, reused for every tap. */
const TAP_A: GearBattleInput = {
  isDown: () => false,
  wasPressed: (btn) => btn === "a",
};

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Whether the finger is down on a battle option, so the release fires it.
 * Only a touch that landed ON an option arms this; one on an empty cell (a
 * fourth move the mon does not have, a sixth party slot) does nothing on
 * either edge, because there is nothing there to execute.
 */
let armed = false;

/**
 * A bottom-screen touch-DOWN, in bottom-target pixels (0..319, 0..239). Maps
 * the pixel to the cell the battle panel drew there and puts that phase's
 * cursor on it -- and only that. The option lights up under the finger, and
 * gearTouchUp runs the A-press when it lifts, so a tap reads as a tap
 * everywhere: highlight, then execute, and always the thing that was
 * touched. (It used to select and confirm on the same edge, so nothing was
 * ever seen highlighted, and the move and party grids had gone 2x2 / 2x3
 * while this still read them as lists -- a tap on a move hit a different
 * move.) The cell math mirrors drawActionGrid / drawMoveSelect /
 * drawItemList / drawPartyList exactly. A no-op when no battle is on the
 * stack.
 */
export function gearTouchDown(game: GearGame, x: number, y: number): void {
  armed = false;
  const b = game.battleView?.()?.battle;
  const col = clampInt(Math.floor(x / TILE_W), 0, COLS - 1);
  const row = clampInt(Math.floor(y / TILE_H), 0, ROWS - 1);
  if (!b) {
    // Out of battle the gear is its own screen: the header arrows step the
    // view (what the shoulder buttons do), and the map takes taps of its own.
    // A battle owns the whole surface, so the header is neither drawn nor
    // hit-tested while one is up.
    const view = activeView(game);
    const arrows = headerArrowCols(game, view === "map" ? "MAP" : "PARTY");
    if (row === 0 && arrows) {
      if (col <= arrows.left) { game.setGearView?.(gearViewStep(game, -1)); return; }
      if (col >= arrows.right && col < CLOCK_COL) {
        game.setGearView?.(gearViewStep(game, 1));
        return;
      }
      return;
    }
    if (view === "map") gearMapTouch(game, x, y);
    return;
  }

  // sayChoice's YES/NO box overlays "messages" rather than being its own
  // phase (battle.ts:558-594) — check it before the phase switch. Tapping
  // YES or NO picks that answer and confirms in one tap; a tap elsewhere in
  // the dialog just confirms whatever's already highlighted, like pressing A.
  if (b.choiceOpen) {
    if (col >= 14 && col <= 19 && row >= 7 && row <= 11) {
      b.choiceYes = row < 9;
    }
    armed = true;
    return;
  }

  // The 2x2 cells drawActionGrid and drawMoveSelect share: colX=[0,10],
  // rowY=[2,10], cellH=8. Reading order, so FIGHT/PKMN over ITEM/RUN.
  const cell2x2 = (): number => (row < 10 ? 0 : 2) + (col < 10 ? 0 : 1);

  switch (b.phase) {
    case "menu": {
      b.menuIndex = cell2x2() + 1;
      armed = true;
      return;
    }
    case "moveSelect": {
      const i = cell2x2();
      if (i >= b.player.curMoves.length) return; // an empty slot
      b.moveIndex = i + 1;
      armed = true;
      return;
    }
    case "party": {
      // drawPartyList's 2x3: colX=[0,10], rowY=[2,7,12], cellH=5.
      const r = row < 7 ? 0 : row < 12 ? 1 : 2;
      const i = r * 2 + (col < 10 ? 0 : 1);
      if (i >= (game.save?.party?.length ?? 0)) return; // an empty slot
      b.partyIndex = i;
      armed = true;
      return;
    }
    case "item": {
      // item rows at y = 2 + (i - top) (one row each), top being where the
      // list is scrolled to (drawItemList).
      const i = row - 2 + itemListTop(b);
      if (row < 2 || i >= b.itemList.length) return;
      b.itemIndex = i;
      armed = true;
      return;
    }
    default:
      // "messages": a tap anywhere advances the text, like pressing A --
      // on the down edge, since there is nothing to highlight first.
      b.update(TAP_A);
      return;
  }
}

/**
 * The finger lifting. If the touch-down landed on a battle option, this is
 * the press that runs it: the highlighted option, whatever the finger did in
 * between, so a tap can never fire something other than what it touched.
 */
export function gearTouchUp(game: GearGame): void {
  if (!armed) return;
  armed = false;
  const b = game.battleView?.()?.battle;
  if (!b) return;
  b.update(TAP_A);
}
