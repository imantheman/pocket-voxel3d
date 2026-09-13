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
import { hpBarTiles } from "../battle/ui.ts";
import { picPageFor } from "../battle/staging.ts";
import type { VoxelHost } from "../host.ts";

// The companion grid is the same 20x18 the top UI uses (spec UI_COLS/UI_ROWS).
const COLS = 20;

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
  };
  /** Non-null while a wild/trainer battle is on the stack (game.ts:881). */
  battleView?: () => GearBattleView | null;
}

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

/**
 * The four-button action grid, the selected cell carrying the ▶ cursor. Two
 * 10-wide columns fill the full grid width; two 8-tall rows sit below the
 * header. When showCursor is false (the messages phase, while text/animation
 * plays on top) the grid shows as a passive backdrop with no selection.
 */
function drawActionGrid(host: VoxelHost, menuIndex: number, showCursor: boolean): void {
  host.uiClearBottom();
  drawTopBar(host, "BATTLE");

  const cellW = 10;
  const cellH = 8;
  const colX = [0, 10];
  const rowY = [2, 10];
  for (let i = 0; i < 4; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    const label = BATTLE_ACTIONS[i]!;
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
function drawItemList(host: VoxelHost, game: GearGame, b: GearBattle): void {
  host.uiClearBottom();
  drawTopBar(host, "ITEMS");

  for (let i = 0; i < b.itemList.length && i < 12; i++) {
    const id = b.itemList[i]!;
    const name = game.data.items[id]?.name ?? id;
    const count = game.save?.inventory?.[id] ?? 0;
    const y = 2 + i;
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
    const name = full.length > 6 ? full.slice(0, 5) + "." : full;
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
      drawActionGrid(host, b.menuIndex, true);
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
export function drawKantoGear(host: VoxelHost, game: GearGame): void {
  const bv = game.battleView?.();
  const b = bv?.battle;
  if (b) {
    drawBattleGear(host, game, b);
    return;
  }
  drawPartyList(host, game, "KANTO GEAR", -1);
}

// The bottom target is the full 320x240 filled by the 20x18 grid (main.rs
// tpxx=320/COLS, tpxy=240/ROWS), so a touch pixel maps straight to a cell.
const ROWS = 18;
const TILE_W = 320 / COLS; // 16
const TILE_H = 240 / ROWS; // 13.33

/** One synthetic A-press, reused for every tap. */
const TAP_A: GearBattleInput = {
  isDown: () => false,
  wasPressed: (btn) => btn === "a",
};

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A bottom-screen touch-DOWN, in bottom-target pixels (0..319, 0..239). Maps
 * the pixel to the cell the battle panel drew there, sets that phase's cursor,
 * then runs one A-press through the real handler (tap = select + confirm). The
 * cell math mirrors drawActionGrid / drawMoveSelect / drawItemList /
 * drawPartyList exactly. A no-op when no battle is on the stack.
 */
export function gearTouchDown(game: GearGame, x: number, y: number): void {
  const b = game.battleView?.()?.battle;
  if (!b) return;
  const col = clampInt(Math.floor(x / TILE_W), 0, COLS - 1);
  const row = clampInt(Math.floor(y / TILE_H), 0, ROWS - 1);

  // sayChoice's YES/NO box overlays "messages" rather than being its own
  // phase (battle.ts:558-594) — check it before the phase switch. Tapping
  // YES or NO picks that answer and confirms in one tap; a tap elsewhere in
  // the dialog just confirms whatever's already highlighted, like pressing A.
  if (b.choiceOpen) {
    if (col >= 14 && col <= 19 && row >= 7 && row <= 11) {
      b.choiceYes = row < 9;
    }
    b.update(TAP_A);
    return;
  }

  switch (b.phase) {
    case "menu": {
      // 2x2 grid: cols split at 10, rows split at 10 (colX=[0,10], rowY=[2,10],
      // cellH=8). FIGHT/PKMN over ITEM/RUN -> menuIndex 1..4.
      const c = col < 10 ? 0 : 1;
      const r = row < 10 ? 0 : 1;
      b.menuIndex = r * 2 + c + 1;
      b.update(TAP_A);
      return;
    }
    case "moveSelect": {
      // moves listed at y = 2 + i*3 (3-row band each).
      const n = b.player.curMoves.length;
      if (n === 0) return;
      const i = clampInt(Math.floor((row - 2) / 3), 0, n - 1);
      b.moveIndex = i + 1;
      b.update(TAP_A);
      return;
    }
    case "party": {
      // party rows at y = 2 + i*2 (2-row band each).
      const n = game.save?.party?.length ?? 0;
      if (n === 0) return;
      const i = clampInt(Math.floor((row - 2) / 2), 0, n - 1);
      b.partyIndex = i;
      b.update(TAP_A);
      return;
    }
    case "item": {
      // item rows at y = 2 + i (one row each).
      const n = b.itemList.length;
      if (n === 0) return;
      const i = clampInt(row - 2, 0, n - 1);
      b.itemIndex = i;
      b.update(TAP_A);
      return;
    }
    default:
      // "messages": a tap anywhere advances the text, like pressing A.
      b.update(TAP_A);
      return;
  }
}
