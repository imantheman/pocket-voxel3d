// The Kanto Gear in battle: the bottom screen follows the fight phase by
// phase -- the dialog, the FIGHT/PKMN/ITEM/RUN grid, the moves, the party,
// the bag, the forget-a-move list -- and adds the mod's extras: a move's
// details on its "?", the enemy's INFO page (number, types, caught, what
// hits it hard), the caught mark on a wild mon you own, and the level-up
// box that shows what each stat gained.
import { hpBarTiles } from "../../battle/ui.ts";
import { picPageFor } from "../../battle/staging.ts";
import { encodeGlyphs, BORDER_H } from "../tiles.ts";
import {
  COLS, DARKTEXT_BIT, FILL_BIT, ROWS, TILE_H, TILE_W, box, center, cursor, fill, fit, pill,
  region, right, rule, sprite, spriteFrame, text, tile,
} from "./draw.ts";
import { assists, matchups, multLabel, spoilers, typeShort } from "./model.ts";
import { header, type GearCtx } from "./ui.ts";
import { drawMoveInfo, drawPartyGrid } from "./apps/party.ts";
import { spritePage } from "./apps/explorer.ts";

export interface GearBattleInput {
  isDown: (b: string) => boolean;
  wasPressed: (b: string) => boolean;
}

/** The live battle, read-only except for the cursors a tap sets. */
export interface GearBattle {
  phase: "messages" | "menu" | "moveSelect" | "party" | "item" | "forget";
  forgetView?(): { name: string; moves: string[]; index: number; learning: string } | null;
  menuIndex: number;
  moveIndex: number;
  partyIndex: number;
  itemIndex: number;
  itemList: string[];
  safari?: { balls: number } | null;
  choiceOpen: boolean;
  choiceYes: boolean;
  player: { name: string; curMoves: { id: string; pp: number }[]; curTypes?: readonly string[] };
  /** The move menu's list: the foe's while MIMIC asks for one. */
  menuMoves?(): { id: string; pp: number }[];
  shown: { text: string; codes: number[]; revealed: number }[];
  msgWaiting: boolean;
  msgPrompt: boolean;
  enemy?: { curTypes: readonly string[]; mon?: any; def?: any; name?: string };
  chart?: { effectiveness: (moveType: string, defenderTypes: readonly string[]) => number };
  isTrainerBattle?(): boolean;
  statBoxMon?: unknown;
  gearLevelUp?: {
    name: string;
    from: number;
    to: number;
    before: Record<string, number>;
    after: Record<string, number>;
  } | null;
  update: (input: GearBattleInput) => void;
}

const BATTLE_ACTIONS = ["FIGHT", "PKMN", "ITEM", "RUN"] as const;
const SAFARI_ACTIONS = ["BALL", "BAIT", "ROCK", "RUN"] as const;

/** The battle's own screen state (reset when a battle starts). */
function bstate(ctx: GearCtx, b: GearBattle): Record<string, any> {
  if (ctx.ui.battle !== b) {
    ctx.ui.battle = b;
    ctx.ui.info = false;
    ctx.ui.moveInfo = null;
  }
  return ctx.ui;
}

/** A wild mon you have already caught, with the icon turned on. */
function caughtMark(ctx: GearCtx, b: GearBattle): boolean {
  if (!ctx.gear.caughtIcon || b.isTrainerBattle?.()) return false;
  const sp = b.enemy?.mon?.species;
  return !!sp && !!ctx.save?.pokedex?.owned?.[sp];
}

/** The battle header: the panel's name, the caught ball, and INFO. */
function battleHeader(ctx: GearCtx, b: GearBattle, title: string): void {
  const s = bstate(ctx, b);
  header(ctx, title, { aside: "" });
  if (caughtMark(ctx, b)) {
    spriteFrame(ctx.host, spritePage(ctx.data, "SPRITE_POKE_BALL"), 0, 0, Math.floor(TILE_H));
  }
  if (b.enemy) {
    // light words on the bar, like the title: a pill would vanish into it
    const label = s.info ? "BACK" : "INFO";
    text(ctx.host, COLS - 5, 0, label, "light");
    region("b:info", COLS - 6, 0, 6, 1, () => {
      s.info = !s.info;
      s.moveInfo = null;
    });
  }
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function drawActionGrid(ctx: GearCtx, b: GearBattle, showCursor: boolean): void {
  const { host } = ctx;
  battleHeader(ctx, b, b.safari ? `BALLS ${b.safari.balls}` : "BATTLE");
  const colX = [0, 10];
  const rowY = [2, 10];
  for (let i = 0; i < 4; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    const label = (b.safari ? SAFARI_ACTIONS : BATTLE_ACTIONS)[i]!;
    const lx = x0 + 1 + Math.max(0, Math.floor((8 - label.length) / 2));
    const ly = y0 + 4;
    if (showCursor && i === b.menuIndex - 1) {
      fill(host, x0, y0, 10, 8);
      box(host, x0, y0, 10, 8, "fill");
      text(host, lx, ly, label, "fill");
    } else {
      box(host, x0, y0, 10, 8);
      text(host, lx, ly, label);
    }
  }
}

/** The move grid: name and ? / PP / type and the matchup tag. */
function drawMoveSelect(ctx: GearCtx, b: GearBattle): void {
  const { host, data } = ctx;
  const s = bstate(ctx, b);
  battleHeader(ctx, b, b.menuMoves && b.menuMoves() !== b.player.curMoves ? "MIMIC" : "MOVES");
  const moves = b.menuMoves ? b.menuMoves() : b.player.curMoves;
  if (typeof s.moveInfo === "number" && moves[s.moveInfo]) {
    const m = moves[s.moveInfo]!;
    const d = data.moves?.[m.id] ?? {};
    let vs: string | undefined;
    if (assists(ctx.save) && d.power && b.enemy && b.chart) {
      const e = b.chart.effectiveness(d.type ?? "", b.enemy.curTypes);
      const stab = b.player.curTypes?.includes(d.type) ? " STAB" : "";
      vs = `VS FOE ${multLabel(e)}${stab}`;
    }
    box(host, 0, 2, COLS, 14);
    drawMoveInfo(ctx, m, 3, () => { s.moveInfo = null; }, vs);
    return;
  }
  const colX = [0, 10];
  const rowY = [2, 10];
  const qmark = encodeGlyphs("?")[0]!;
  const details = assists(ctx.save);
  for (let i = 0; i < 4 && i < moves.length; i++) {
    const x0 = colX[i % 2]!;
    const y0 = rowY[(i / 2) | 0]!;
    const slot = moves[i]!;
    const def = data.moves?.[slot.id];
    const name = (def?.name ?? slot.id).slice(0, 7);
    const maxPp = def?.pp ?? slot.pp;
    const type = (def?.type ?? "").toUpperCase().slice(0, 6);
    const selected = i === b.moveIndex - 1;
    const ink = selected ? "fill" : "dark";
    if (selected) fill(host, x0, y0, 10, 8);
    box(host, x0, y0, 10, 8, selected ? "fill" : "dark");
    text(host, x0 + 1, y0 + 1, name, ink);
    text(host, x0 + 1, y0 + 3, `PP ${slot.pp}/${maxPp}`, ink);
    text(host, x0 + 1, y0 + 5, type, ink);
    let eff = "--";
    if (details && (def?.power ?? 0) > 0 && b.enemy && b.chart) {
      eff = multLabel(b.chart.effectiveness(def!.type ?? "", b.enemy.curTypes));
    }
    text(host, x0 + 9 - eff.length, y0 + 5, eff, ink);
    if (details) {
      // the ? is its own target: it opens the details, it does not pick
      host.uiTileBottom(x0 + 8, y0 + 1, qmark | (selected ? FILL_BIT : DARKTEXT_BIT));
      region(`b:q${i}`, x0 + 7, y0, 3, 3, () => { s.moveInfo = i; });
    }
  }
}

function drawForgetList(ctx: GearCtx, b: GearBattle): void {
  const { host } = ctx;
  const f = b.forgetView?.();
  if (!f) return;
  header(ctx, fit(`LEARN ${f.learning}`, 18), { aside: "" });
  text(host, 1, 2, fit(`${f.name} FORGETS?`, 18));
  f.moves.forEach((name, i) => {
    const y = 4 + i * 2;
    text(host, 2, y, name.slice(0, 14));
    if (i === f.index) cursor(host, 0, y);
  });
  const cancelY = 4 + f.moves.length * 2;
  text(host, 2, cancelY, "DON'T LEARN");
  if (f.index >= f.moves.length) cursor(host, 0, cancelY);
}

/** Rows the ITEM list shows at once; it scrolls to keep the cursor on. */
export const ITEM_ROWS = 12;

export function itemListTop(b: GearBattle): number {
  return Math.max(0, Math.min(b.itemIndex - (ITEM_ROWS - 1), b.itemList.length - ITEM_ROWS));
}

/** The pocket an item belongs in, for the bag's jump tabs. */
function kindOf(data: any, id: string): "ball" | "med" | "other" {
  if (/_BALL$/.test(id)) return "ball";
  if (/POTION|RESTORE|REVIVE|HEAL|ANTIDOTE|AWAKENING|ETHER|ELIXER|WATER|SODA|LEMONADE/.test(id)) return "med";
  return "other";
}

function drawItemList(ctx: GearCtx, b: GearBattle): void {
  const { host, data, save } = ctx;
  battleHeader(ctx, b, "ITEMS");
  const top = itemListTop(b);
  for (let i = top; i < b.itemList.length && i < top + ITEM_ROWS; i++) {
    const id = b.itemList[i]!;
    const y = 2 + (i - top);
    text(host, 2, y, (data.items?.[id]?.name ?? id).slice(0, 13));
    right(host, y, `x${save?.inventory?.[id] ?? 0}`);
    if (i === b.itemIndex) cursor(host, 0, y);
  }
  // jump tabs: put the cursor on the first ball / medicine / other thing
  const jump = (k: string) => {
    const at = b.itemList.findIndex((id) => kindOf(data, id) === k);
    if (at >= 0) b.itemIndex = at;
  };
  pill(host, "b:jball", 0, 15, 6, "BALLS", () => jump("ball"));
  pill(host, "b:jmed", 7, 15, 6, "MEDS", () => jump("med"));
  pill(host, "b:jother", 14, 15, 6, "OTHER", () => jump("other"));
}

/** The dialog: two rolling lines, TAP TO CONTINUE, the YES/NO box. */
function drawBattleMessage(ctx: GearCtx, b: GearBattle): void {
  const { host } = ctx;
  battleHeader(ctx, b, "BATTLE");
  box(host, 0, 2, COLS, 14);
  const rows = [5, 7];
  b.shown.forEach((line, i) => {
    if (i >= rows.length) return;
    const isLast = i === b.shown.length - 1;
    const n = isLast ? line.revealed : line.codes.length;
    for (let c = 0; c < n && c < line.codes.length && 2 + c < COLS - 1; c++) {
      host.uiTileBottom(2 + c, rows[i]!, line.codes[c]! | DARKTEXT_BIT);
    }
  });
  const lv = b.statBoxMon ? b.gearLevelUp : null;
  if (lv) {
    drawLevelUp(ctx, lv);
  } else if (b.msgWaiting || b.msgPrompt) {
    for (let x = 2; x < COLS - 2; x++) host.uiTileBottom(x, 11, BORDER_H | DARKTEXT_BIT);
    center(host, 13, "TAP TO CONTINUE");
  }
  if (b.choiceOpen) {
    box(host, 14, 7, 6, 5);
    text(host, 16, 8, "YES");
    text(host, 16, 10, "NO");
    cursor(host, 15, b.choiceYes ? 8 : 10);
  }
}

/** level_up.lua: each stat before -> after, and the gain. */
function drawLevelUp(ctx: GearCtx, lv: NonNullable<GearBattle["gearLevelUp"]>): void {
  const { host } = ctx;
  rule(host, 9, 1, COLS - 2);
  text(host, 2, 9, fit(` ${lv.name} L${lv.to} `, 16));
  const stats: [string, string][] = [["hp", "HP"], ["attack", "ATK"], ["defense", "DEF"], ["speed", "SPD"], ["special", "SPC"]];
  stats.forEach(([k, label], i) => {
    const y = 10 + i;
    const a = lv.before[k] ?? 0;
    const z = lv.after[k] ?? 0;
    text(host, 2, y, label);
    text(host, 6, y, `${a}-${z}`);
    right(host, y, `+${z - a}`, "dark", COLS - 2);
  });
}

/** The enemy's page: pic, number, level, types, caught, and (assists) the
 * types that hit it hard and the ones it shrugs off. */
function drawEnemyInfo(ctx: GearCtx, b: GearBattle): void {
  const { host, data, save } = ctx;
  battleHeader(ctx, b, "ENEMY");
  const mon = b.enemy?.mon;
  const def = b.enemy?.def ?? data.pokemon?.[mon?.species] ?? {};
  sprite(host, picPageFor(data, mon?.species ?? ""), 0, TILE_H + 2, 5 * TILE_W, 5 * TILE_H);
  text(host, 6, 2, fit(b.enemy?.name ?? def.name ?? "", 13));
  text(host, 6, 3, `No.${String(def.dex ?? 0).padStart(3, "0")} L${mon?.level ?? "?"}`);
  text(host, 6, 4, fit((b.enemy?.curTypes ?? def.types ?? []).join("/"), 14));
  const owned = !!save?.pokedex?.owned?.[mon?.species];
  text(host, 6, 5, `CAUGHT ${owned ? "YES" : "NO"}`);
  if (spoilers(save) && mon?.dvs) {
    const d = mon.dvs;
    text(host, 6, 6, fit(`DV ${d.attack}/${d.defense}/${d.speed}/${d.special}`, 14));
  }
  rule(host, 7);
  if (!assists(save)) {
    center(host, 10, "SET INFO TO ENHANCED");
    center(host, 11, "FOR MATCHUPS");
    return;
  }
  center(host, 8, "BASE MATCHUP");
  const { weak, resist } = matchups(b.chart, b.enemy?.curTypes ?? def.types ?? []);
  text(host, 0, 9, `WEAK ${weak.length}`);
  text(host, 10, 9, `RESIST ${resist.length}`);
  for (let i = 0; i < 6; i++) {
    const w = weak[i];
    const r = resist[i];
    if (w) text(host, 0, 10 + i, fit(`${typeShort(w[0])} ${multLabel(w[1])}`, 10));
    if (r) text(host, 10, 10 + i, fit(`${typeShort(r[0])} ${multLabel(r[1])}`, 10));
  }
  for (let y = 9; y < 16; y++) tile(host, 9, y, 0x7c);
}

/** Dispatch on the phase. INFO takes over only while nothing needs picking. */
export function drawBattleGear(ctx: GearCtx, b: GearBattle): void {
  const s = bstate(ctx, b);
  if (s.info && (b.phase === "menu" || (b.phase === "messages" && !b.choiceOpen))) {
    drawEnemyInfo(ctx, b);
    return;
  }
  if (b.phase !== "moveSelect") s.moveInfo = null;
  switch (b.phase) {
    case "forget": drawForgetList(ctx, b); return;
    case "moveSelect": drawMoveSelect(ctx, b); return;
    case "party":
      battleHeader(ctx, b, "PKMN");
      drawPartyGrid(ctx, b.partyIndex);
      return;
    case "item": drawItemList(ctx, b); return;
    case "menu": drawActionGrid(ctx, b, true); return;
    default: drawBattleMessage(ctx, b); return;
  }
}

// ---------------------------------------------------------------------------
// touch: aim on the down edge, fire on the up edge
// ---------------------------------------------------------------------------

const TAP_A: GearBattleInput = { isDown: () => false, wasPressed: (btn) => btn === "a" };

let armed = false;

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A touch-down on a battle panel that hit none of the drawn targets: put the
 * phase's cursor on the option under the finger (it lights up), and the
 * release runs it. The dialog advances on the down edge.
 */
export function battleTouchDown(ctx: GearCtx, b: GearBattle, x: number, y: number): void {
  armed = false;
  const col = clampInt(Math.floor(x / TILE_W), 0, COLS - 1);
  const row = clampInt(Math.floor(y / TILE_H), 0, ROWS - 1);
  const s = bstate(ctx, b);
  if (s.info && (b.phase === "menu" || b.phase === "messages")) {
    // the INFO page is to read; a tap on it is the same as B from it
    s.info = false;
    return;
  }
  if (b.choiceOpen) {
    if (col >= 14 && col <= 19 && row >= 7 && row <= 11) b.choiceYes = row < 9;
    armed = true;
    return;
  }
  const cell2x2 = (): number => (row < 10 ? 0 : 2) + (col < 10 ? 0 : 1);
  switch (b.phase) {
    case "menu":
      if (row < 2) return;
      b.menuIndex = cell2x2() + 1;
      armed = true;
      return;
    case "moveSelect": {
      if (typeof s.moveInfo === "number") { s.moveInfo = null; return; }
      if (row < 2) return;
      const i = cell2x2();
      if (i >= (b.menuMoves ? b.menuMoves() : b.player.curMoves).length) return;
      b.moveIndex = i + 1;
      armed = true;
      return;
    }
    case "party": {
      if (row < 2) return;
      const r = row < 7 ? 0 : row < 12 ? 1 : 2;
      const i = r * 2 + (col < 10 ? 0 : 1);
      if (i >= (ctx.save?.party?.length ?? 0)) return;
      b.partyIndex = i;
      armed = true;
      return;
    }
    case "item": {
      const i = row - 2 + itemListTop(b);
      if (row < 2 || row >= 2 + ITEM_ROWS || i >= b.itemList.length) return;
      b.itemIndex = i;
      armed = true;
      return;
    }
    default:
      b.update(TAP_A);
  }
}

/** The finger lifting: runs the option the down edge lit. */
export function battleTouchUp(b: GearBattle | undefined): void {
  if (!armed) return;
  armed = false;
  b?.update(TAP_A);
}

