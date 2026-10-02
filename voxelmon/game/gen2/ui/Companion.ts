// Gold's bottom screen: a status panel on the 3DS's lower display, drawn
// with Gold's own font and HUD tiles on a second Gold screen (spec
// `lcdTarget(1)`; the host shows its top 160x120 at 2x, filling 320x240).
// Not the cart's -- the Game Boy had one screen. The Kanto games' bottom
// screen is the Kanto Gear (voxelmon/game/ui/kantogear.ts); this is Gold's
// counterpart, worked by touch:
//
//   row 0      where you are (the landmark name)
//   row 1      the time and its MORN/DAY/NITE, and your money
//   rows 2-13  the page:
//                PARTY   two rows a mon: name and level, then the HP bar and
//                        HP -- tap one for its page
//                a mon   its types, status, stats and moves with their PP;
//                        a tap turns to the next mon
//                BADGES  the sixteen, Johto's and Kanto's
//                CARD    name, ID No., POKeDEX own/seen, play time
//                MAP     the POKeGEAR's town map of the region you are in,
//                        you on it (its _TownMap, drawn three rows up: the
//                        landmark header and the bottom frame row fall off
//                        the 15 rows shown; rows 0-1 go to it too)
//   row 14     the tabs, <PK><MN> BADGE CARD MAP, tapped to turn the page
//
// In a battle the whole panel is the battle's (the Kanto games' 3D battles
// put their menus on the bottom screen the same way; with BATTLES 3D the
// top screen then shows only the arena and the HUDs):
//
//   row 0      the foe, name and level (BACK at the right in the move list)
//   rows 1-6   the battle's text, typed as the top screen types it, the
//              arrow when it waits -- a tap anywhere is A
//   rows 7-14  FIGHT <PK><MN> PACK RUN as four boxes; the move list with the
//              chosen move's type and PP; YES / NO; or, while the text runs,
//              both mons with their HP
//
// A tap moves the battle's own cursor and presses A for it, so the battle
// answers exactly as it answers the buttons (which work as ever).
//
// With BATTLES 3D, what the battle opens -- the party (and its SWITCH /
// STATS / CANCEL), the pack (and its USE prompts, the mon to use it on) --
// is drawn here too, whole (lcdTall: all 160x144 at the top screen's scale),
// the screens themselves unchanged, while the top keeps the arena
// (Game2.stagedBattleBelow). So are the battle's forget list and level-up
// stats box (its own drawBottom). Taps there go to the row under the finger:
// a mon, a submenu line, an item, a move to forget; the bag picture turns
// the pocket, the pack's top rows close it.
//
// A tap is the finger lifting after it went down on a target (the Kanto
// Gear's rule). The panel redraws only when something it shows has changed,
// checked twice a second, so a still panel costs a string compare every 15
// frames; a page turn redraws on the next shown frame.

import type { VoxelHost } from "../../host.ts";
import { Lcd } from "../platform/lcd.ts";
import G, { cachedBlock, resetDrawState, setLcd } from "../platform/screen.ts";
import { Clock } from "../core/Clock.ts";
import { BattleHud } from "./BattleHud.ts";
import { Chrome } from "./Chrome.ts";
import { Pokegear } from "./Pokegear.ts";
import { Input } from "../shared/core/Input.ts";
import { TypeChart } from "../shared/battle/TypeChart.ts";

type LcdBankSpec = { base: number; page: number; count: number };

const COLS = 20;
/** Shown frames between checks for a change (~0.5 s at 30 fps). */
const CHECK_EVERY = 15;
const PARTY_MAX = 6;
/** The tab row, and each tab's first column (its cursor sits one left). */
const TAB_ROW = 14;
type Page = "party" | "mon" | "badges" | "card" | "map";
/** Each tab: its label, first column and width in tiles (<PK><MN> is two). */
const TABS: { page: Page; label: string; x: number; w: number }[] = [
  { page: "party", label: "<PK><MN>", x: 1, w: 2 },
  { page: "badges", label: "BADGE", x: 5, w: 5 },
  { page: "card", label: "CARD", x: 11, w: 4 },
  { page: "map", label: "MAP", x: 17, w: 3 },
];
/** Town map rows the MAP page drops off the top (header and rule). */
const MAP_SHIFT = 3;
const JOHTO_BADGES = ["ZEPHYR", "HIVE", "PLAIN", "FOG", "STORM", "MINERAL", "GLACIER", "RISING"];
const KANTO_BADGES = ["BOULDER", "CASCADE", "THUNDER", "RAINBOW", "SOUL", "MARSH", "VOLCANO", "EARTH"];

/** `host`, with every lcd* op addressed to screen `k` and the target put back after. */
function targeted(host: VoxelHost, k: number): VoxelHost {
  const h = host as unknown as Record<string, ((...a: unknown[]) => void) | undefined>;
  const wrap = (name: string) => (...a: unknown[]): void => {
    const f = h[name];
    if (!f) return;
    host.lcdTarget?.(k);
    f.apply(host, a);
    host.lcdTarget?.(0);
  };
  const names = ["lcdShow", "lcdBank", "lcdReset", "lcdCells", "lcdRegs", "lcdObjs", "lcdPals", "lcdLines", "lcdTall"];
  const out: Record<string, unknown> = {};
  for (const n of names) out[n] = wrap(n);
  // the typed-array forms only where the host has them (Lcd.end takes their
  // presence as the choice): the battle page redraws as its text types, and
  // the hex path cost the frame several ms
  for (const n of ["lcdCellsBin", "lcdObjsBin", "lcdLinesBin"]) if (h[n]) out[n] = wrap(n);
  return out as unknown as VoxelHost;
}

interface MonLike {
  nickname?: string;
  name?: string;
  species?: string;
  level?: number;
  hp?: number;
  maxHp?: number;
  stats?: Record<string, number>;
  types?: string[];
  isEgg?: boolean;
  egg?: boolean;
  status?: unknown;
  moves?: { id?: unknown; pp?: number; maxPp?: number }[];
}

function monName(m: MonLike): string {
  return String(m.nickname || m.name || m.species || "?").slice(0, 10);
}

function maxHpOf(m: MonLike): number {
  return Math.max(1, Number(m.maxHp || (m.stats && m.stats.hp) || 1));
}

const isEgg = (m: MonLike | undefined): boolean => !!m && !!(m.isEgg || m.egg);

/** The battle screen on the stack, if any. */
function battleOf(game: any): any {
  // (globalThis.noBattlePanel: the old panel in battles, for A/B timing)
  if ((globalThis as { noBattlePanel?: boolean }).noBattlePanel) return null;
  const states: any[] = game?.stack?.states ?? [];
  for (let i = states.length - 1; i >= 0; i--) if (states[i]?.screenId === "Gen2BattleState") return states[i];
  return null;
}

/** The battle's YES/NO questions (BattleState drawBottom's `asking`). */
const ASKING = new Set(["ask-nickname", "ask-forget", "stop-learning", "ask-shift", "ask-next-mon"]);
type BattleView = "menu" | "moves" | "ask" | "text";

function battleView(st: any): BattleView {
  if (st.phase === "menu") return "menu";
  if (st.phase === "moves") return "moves";
  if (ASKING.has(st.phase) && (st.messageTimer ?? 0) <= 0) return "ask";
  return "text";
}

/** The YES/NO cursor of the question standing: 1 YES, 2 NO. */
const ASK_FIELD: Record<string, string> = {
  "ask-nickname": "nicknameIndex", "ask-shift": "shiftIndex", "ask-next-mon": "nextMonIndex",
};
function askIndex(st: any): number {
  return Number(st[ASK_FIELD[st.phase] ?? "forgetChoice"] ?? 1);
}

/** The battle phases drawn here whole, with the battle's own drawBottom. */
function tallPhase(st: any): boolean {
  return !!st?.staged3d && ((st.phase === "choose-forget" && (st.messageTimer ?? 0) <= 0) || st.phase === "stats-box");
}

/** The bottom screen in whole mode: 160x144 at 5/3 between bars 27 px wide. */
const TALL_X0 = 27;
const TALL_SCALE = 240 / 144;

/** Where the battle panel's boxes start, and the move list's first row. */
const ACT_ROW = 7;
const MOVE_ROW = 8;

export class Companion {
  private readonly lcd: Lcd;
  private hud: BattleHud | null = null;
  private sig = "";
  private wait = 0;
  private page: Page = "party";
  /** The mon whose page is open (an index into the party). */
  private mon = 0;
  /** The cell the finger went down on; null while it is up. */
  private down: [number, number] | null = null;
  /** The town map's POKeGEAR, and the landmark it is showing. */
  private gear: Pokegear | null = null;
  private gearFor = "";
  /** A button a battle tap pressed, let go on the next step. */
  private tapBtn: string | null = null;
  /** Where the finger went down, in the bottom screen's pixels. */
  private downPx: [number, number] | null = null;
  /** Bumped per whole-screen redraw: those views change every frame. */
  private tick = 0;

  constructor(host: VoxelHost, banks: LcdBankSpec[]) {
    this.lcd = new Lcd(targeted(host, 1));
    if (banks.length > 0) this.lcd.banks(banks);
  }

  /** Once a step: the bottom screen's touch in its own pixels (320x240) and
   *  whether a finger is on it. Acts as the finger lifts. */
  touch(game: any, x: number, y: number, held: boolean): void {
    // the press a tap made last step has been seen: let it go
    if (this.tapBtn) {
      Input.sourceRelease(this.tapBtn, "companion");
      this.tapBtn = null;
    }
    if (held) {
      if (!this.down) {
        this.down = [Math.floor(x / 16), Math.floor(y / 16)];
        this.downPx = [x, y];
      }
      return;
    }
    const at = this.down;
    this.down = null;
    if (!at || !game?.world?.map) return;
    const [cx, cy] = at;
    const st = battleOf(game);
    if (st) {
      // the whole-screen views: the cell under the finger in the 160x144
      const routed = game.stagedBattleBelow?.();
      if (routed || (game.stack.top() === st && tallPhase(st))) {
        const tx = Math.floor(((this.downPx![0] - TALL_X0) / TALL_SCALE) / 8);
        const ty = Math.floor((this.downPx![1] / TALL_SCALE) / 8);
        if (tx < 0 || tx >= COLS) return;
        if (routed) this.screenTap(game.stack.top(), tx, ty);
        else this.tallBattleTap(st, tx, ty);
        return;
      }
      if (game.stack.top() === st) this.battleTap(st, cx, cy);
      return;
    }
    let page: Page = this.page;
    let mon = this.mon;
    const party = this.party(game);
    if (cy === TAB_ROW) {
      for (const t of TABS) if (cx >= t.x - 1 && cx < t.x + t.w) page = t.page;
    } else if (this.page === "party" && cy >= 2 && cy <= 13) {
      const i = Math.floor((cy - 2) / 2);
      if (party[i] && !isEgg(party[i])) {
        page = "mon";
        mon = i;
      }
    } else if (this.page === "mon" && cy >= 2 && cy <= 13) {
      for (let k = 1; k <= party.length; k++) {
        const j = (this.mon + k) % party.length;
        if (!isEgg(party[j])) {
          mon = j;
          break;
        }
      }
    }
    if (page === this.page && mon === this.mon) return;
    this.page = page;
    this.mon = mon;
    // (a "[pv]" line: the host keeps those in pvlog.txt; one a page turn)
    console.log(`[pv] gold panel: ${page}${page === "mon" ? ` ${mon + 1}` : ""} (tap at ${cx},${cy})`);
    // redraw on the next shown frame
    this.sig = "";
    this.wait = CHECK_EVERY;
  }

  /** A battle tap at cell (cx, cy): the battle's cursor there, then A (or B). */
  private battleTap(st: any, cx: number, cy: number): void {
    const view = battleView(st);
    let btn = "a";
    if (view === "menu" && cy >= ACT_ROW) {
      st.menuIndex = (cy >= ACT_ROW + 4 ? 2 : 0) + (cx >= 10 ? 2 : 1);
    } else if (view === "moves") {
      if (cy === 0) btn = "b";
      else {
        const i = cy - MOVE_ROW + 1;
        const moves = st.playerMoves?.() ?? [];
        if (i < 1 || i > moves.length) return;
        st.moveIndex = i;
      }
    } else if (view === "ask" && cy >= ACT_ROW && cy < ACT_ROW + 4) {
      st[ASK_FIELD[st.phase] ?? "forgetChoice"] = cx >= 10 ? 2 : 1;
    } else if (view !== "text") {
      return;
    }
    Input.sourcePress(btn, "companion");
    this.tapBtn = btn;
    console.log(`[pv] gold panel: battle ${view} tap ${btn} at ${cx},${cy}`);
    this.sig = "";
  }

  /** Press `btn` for the step after this one (released the step after). */
  private press(btn: string, what: string, tx: number, ty: number): void {
    Input.sourcePress(btn, "companion");
    this.tapBtn = btn;
    console.log(`[pv] gold panel: ${what} tap ${btn} at ${tx},${ty}`);
    this.sig = "";
  }

  /** The battle's forget list and stats box, drawn here whole: tile (tx, ty). */
  private tallBattleTap(st: any, tx: number, ty: number): void {
    if (st.phase === "choose-forget") {
      // ForgetMoveList: moves at rows 4, 6, 8, 10 right of column 5
      const slot = Math.floor((ty - 4) / 2) + 1;
      if (tx < 5 || slot < 1 || slot > 4) return;
      st.forgetIndex = slot;
    }
    this.press("a", `battle ${st.phase}`, tx, ty);
  }

  /** A screen the battle opened, drawn here whole: tile (tx, ty) tapped. */
  private screenTap(screen: any, tx: number, ty: number): void {
    const id = String(screen?.screenId ?? "");
    if (id === "Gen2PartyMenu") {
      const menu = screen.submenu;
      if (menu) {
        // the battle submenu (SWITCH / STATS / CANCEL): a box at (11,11),
        // its lines at rows 12, 14, 16; a tap off it closes it
        const line = Math.floor((ty - 12) / 2) + 1;
        if (menu.battle && tx >= 11 && line >= 1 && line <= menu.items.length) {
          menu.index = line;
          this.press("a", "party submenu", tx, ty);
        } else {
          this.press("b", "party submenu", tx, ty);
        }
        return;
      }
      // a mon's two rows from row 1; CANCEL on the row after the last
      const slot = Math.floor((ty - 1) / 2) + 1;
      const n = (screen.party ?? []).length;
      if (ty >= 1 && slot >= 1 && slot <= n + 1) {
        screen.index = slot;
        this.press("a", "party", tx, ty);
      }
      return;
    }
    if (id === "Gen2PackMenu") {
      const busy = screen.submenu || screen.qtyState || screen.confirm || screen.message !== undefined
        || screen.switching !== undefined;
      if (ty <= 1) return this.press("b", "pack", tx, ty);
      if (busy) return this.press("a", "pack prompt", tx, ty);
      // the bag picture: the next pocket
      if (tx < 7 && ty < 12) return this.press("right", "pack pocket", tx, ty);
      // the list: five rows from row 2, two rows each
      const row = Math.floor((ty - 2) / 2) + 1;
      if (tx >= 7 && row >= 1 && row <= 5) {
        const i = row + (screen.scroll ?? 0);
        if (i <= (screen.total?.() ?? 0)) {
          screen.index = i;
          this.press("a", "pack", tx, ty);
        }
      }
      return;
    }
    // anything else the battle opens (a stats page, a nickname's naming
    // screen...): a tap is A
    this.press("a", id || "screen", tx, ty);
  }

  /** Once per shown frame, after the top screen's compose. */
  frame(game: any): void {
    // a battle's text types and its cursor moves: looked at every second
    // frame (the text then types at 15 steps a second down here)
    const every = battleOf(game) ? 2 : CHECK_EVERY;
    if (this.lcd.tall && !this.tallWanted(game)) this.sig = "";
    if (this.sig !== "" && ++this.wait < every) return;
    this.wait = 0;
    const sig = this.signature(game);
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw(game);
  }

  private party(game: any): MonLike[] {
    const p = game?.save?.party;
    return Array.isArray(p) ? (p as MonLike[]).slice(0, PARTY_MAX) : [];
  }

  private location(game: any): string {
    try {
      return String(game?.world?.landmarkName?.() ?? "").slice(0, COLS);
    } catch {
      return "";
    }
  }

  private time(game: any): string {
    const minutes = Clock.minutes(game?.save);
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    return `${hh < 10 ? " " : ""}${hh}:${mm < 10 ? "0" : ""}${mm} ${Clock.daytimeLabel(hh)}`;
  }

  private badges(game: any): string[] {
    const p = game?.save?.player ?? {};
    const out: string[] = [];
    for (const store of ["johtoBadges", "kantoBadges", "badges"]) {
      const t = p[store];
      if (t && typeof t === "object") for (const k of Object.keys(t)) if (t[k] === true) out.push(k);
    }
    return out;
  }

  private count(table: unknown): number {
    if (!table || typeof table !== "object") return 0;
    let n = 0;
    for (const v of Object.values(table as Record<string, unknown>)) if (v) n++;
    return n;
  }

  /** Whether this frame's view is a whole-screen one (see the header). */
  private tallWanted(game: any): boolean {
    const st = game?.world?.map ? battleOf(game) : null;
    if (!st) return false;
    return !!game.stagedBattleBelow?.() || (game.stack.top() === st && tallPhase(st));
  }

  private signature(game: any): string {
    if (!game?.world?.map) return "boot";
    // the whole-screen views animate (cursors, icons, typed text): redrawn
    // each time they are looked at
    if (this.tallWanted(game)) return `T${++this.tick}`;
    const st = battleOf(game);
    if (st) return this.battleSignature(game, st);
    let s = `${this.page}:${this.mon}|${this.location(game)}|${this.time(game)}|${game.save?.player?.money ?? 0}`;
    for (const m of this.party(game)) {
      s += `|${monName(m)}:${m.level ?? 0}:${m.hp ?? 0}/${maxHpOf(m)}:${isEgg(m) ? 1 : 0}`;
      if (this.page === "mon") s += `:${String(m.status ?? "")}:${(m.moves ?? []).map((v) => `${String(v?.id)}${v?.pp}`).join(",")}`;
    }
    if (this.page === "badges") s += `|${this.badges(game).join(",")}`;
    if (this.page === "map") s += `|${game.world?.map?.id ?? ""}`;
    if (this.page === "card") {
      const dex = game.save?.pokedex ?? {};
      s += `|${this.count(dex.caught)}/${this.count(dex.seen)}|${game.save?.playTime?.hours ?? 0}:${game.save?.playTime?.minutes ?? 0}`;
    }
    return s;
  }

  private battleSignature(game: any, st: any): string {
    st.syncTyper?.();
    const view = battleView(st);
    const e = st.activeMon?.("enemy") ?? {};
    const p = st.activeMon?.("player") ?? {};
    let s = `B|${view}|${st.phase}|${st.menuIndex}|${st.moveIndex}|${view === "ask" ? askIndex(st) : 0}`
      + `|${(st.messageLines?.() ?? []).join("/")}|${st.messageArrowVisible?.() ? 1 : 0}`
      + `|${monName(e)}:${e.level}:${st.shownHp?.enemy ?? e.hp}/${maxHpOf(e)}`
      + `|${monName(p)}:${p.level}:${st.shownHp?.player ?? p.hp}/${maxHpOf(p)}|${game.stack.top() === st ? 1 : 0}`;
    if (view === "moves") for (const m of st.playerMoves?.() ?? []) s += `|${String(m?.id)}${m?.pp}`;
    return s;
  }

  /** One mon's name, level and HP bar from row `row`; its HP numbers too. */
  private battleMon(mon: any, hp: number, row: number, numbers: boolean): void {
    if (!mon || !mon.species) return;
    Chrome.print(monName(mon), 1, row);
    Chrome.printRight(`<LV>${mon.level ?? 1}`, COLS - 1, row);
    const max = maxHpOf(mon);
    const shown = Math.max(0, Math.min(max, Math.round(Number(hp ?? 0))));
    if (this.hud!.available()) this.hud!.drawHpBar(shown, max, 1, row + 1);
    if (numbers) Chrome.printRight(`${shown}/${max}`, COLS - 1, row + 2);
  }

  /** The battle's panel (see the header). */
  private drawBattle(game: any, st: any): void {
    const view = game.stack.top() === st ? battleView(st) : "text";
    const enemy = st.activeMon?.("enemy");
    const player = st.activeMon?.("player");
    if (enemy?.species) Chrome.print(`${monName(enemy)} <LV>${enemy.level ?? 1}`, 0, 0);
    if (view === "moves") {
      Chrome.printRight("BACK", COLS, 0);
    }
    // Everything but the text, recorded once and replayed while it stands
    // (screen.ts cachedBlock): the text types every other frame, and this
    // part redrawn with it cost the battle ~7 ms a frame.
    const e = enemy ?? {};
    const p = player ?? {};
    const key = `bp|${view}|${st.menuIndex}|${st.moveIndex}|${view === "ask" ? askIndex(st) : 0}`
      + `|${monName(e)}:${e.level}:${Math.round(st.shownHp?.enemy ?? e.hp ?? 0)}/${maxHpOf(e)}`
      + `|${monName(p)}:${p.level}:${Math.round(st.shownHp?.player ?? p.hp ?? 0)}/${maxHpOf(p)}`
      + (view === "menu" ? `|${(st.menuLabels?.() ?? []).join(",")}` : "")
      + (view === "moves" ? `|${(st.playerMoves?.() ?? []).map((m: any) => `${String(m?.id)}${m?.pp}`).join(",")}` : "");
    cachedBlock(this, key, () => this.drawBattleStill(game, st, view, enemy, player));
    // the text, on the box's two rows as the top screen sets them
    st.syncTyper?.();
    const lines: string[] = st.messageLines?.() ?? [];
    for (let i = 0; i < Math.min(2, lines.length); i++) Chrome.print(lines[i]!, 1, 3 + i * 2);
    if (st.messageArrowVisible?.()) Chrome.print("▼", 18, 6);
  }

  /** The battle panel's still part: the text's box, the boxes and lists below. */
  private drawBattleStill(game: any, st: any, view: BattleView, enemy: any, player: any): void {
    Chrome.box(0, 1, COLS, 6);
    if (view === "menu" || view === "ask") {
      const labels: string[] = view === "menu" ? (st.menuLabels?.() ?? []) : ["YES", "NO"];
      const at = view === "menu" ? st.menuIndex : askIndex(st);
      labels.forEach((label, k) => {
        const x = (k % 2) * 10;
        const y = ACT_ROW + Math.floor(k / 2) * 4;
        Chrome.box(x, y, 10, 4);
        Chrome.print(label, x + 2, y + 2);
        if (k + 1 === at) Chrome.cursor(x + 1, y + 2);
      });
    } else if (view === "moves") {
      Chrome.box(0, ACT_ROW, COLS, 8);
      const moves: any[] = st.playerMoves?.() ?? [];
      const defs = game.data?.moves ?? {};
      moves.forEach((m, k) => {
        const row = MOVE_ROW + k;
        Chrome.print(String(defs[String(m?.id)]?.name ?? m?.id ?? "-").slice(0, 12), 2, row);
        Chrome.printRight(`${m?.pp ?? 0}/${m?.maxPp ?? m?.pp ?? 0}`, COLS - 1, row);
        if (k + 1 === st.moveIndex) Chrome.cursor(1, row);
      });
      const cur = moves[(st.moveIndex ?? 1) - 1];
      if (cur) {
        const disabled = st.battle?.player && st.battle.moveDisabled?.(st.battle.player, cur.id);
        const type = defs[String(cur.id)]?.type;
        Chrome.print(disabled ? "Disabled!" : `TYPE/${type ? TypeChart.displayName(type, game.data) : ""}`, 1, 13);
      }
    } else {
      // while the text runs: both mons and their HP
      this.battleMon(enemy, st.shownHp?.enemy ?? enemy?.hp, 8, false);
      this.battleMon(player, st.shownHp?.player ?? player?.hp, 11, true);
    }
  }

  /** The screens over a staged battle, as Game2.draw would draw them on
   *  top: a widescreen face (the top one's, else the topmost opaque one's)
   *  alone when it is the top's, else from the topmost opaque one up. */
  private drawScreens(above: any[]): void {
    let base = 0;
    for (let i = above.length - 1; i >= 0; i--) {
      if (above[i]?.isOpaque) {
        base = i;
        break;
      }
    }
    const top = above[above.length - 1];
    const wideOf = (s: any): any => (s && s.drawsWidescreen?.() && s.drawWidescreen ? s : null);
    const wide = wideOf(top) ?? (above[base]?.isOpaque ? wideOf(above[base]) : null);
    if (wide) {
      wide.drawWidescreen(160, 144);
      if (wide === top) return;
    }
    for (let i = base; i < above.length; i++) above[i]?.draw?.();
  }

  private drawParty(game: any): void {
    const hud = this.hud!;
    const party = this.party(game);
    for (let i = 0; i < party.length; i++) {
      const m = party[i]!;
      const row = 2 + i * 2;
      if (isEgg(m)) {
        Chrome.print("EGG", 1, row);
        continue;
      }
      Chrome.print(monName(m), 1, row);
      Chrome.print(`<LV>${m.level ?? 1}`, 14, row);
      const max = maxHpOf(m);
      const hp = Math.max(0, Math.min(max, Number(m.hp ?? 0)));
      if (hud.available()) hud.drawHpBar(hp, max, 1, row + 1);
      Chrome.printRight(`${hp}/${max}`, COLS, row + 1);
    }
  }

  private drawMon(game: any): void {
    const m = this.party(game)[this.mon];
    if (!m || isEgg(m)) {
      // the mon left the party (a PC deposit): back to the list
      this.page = "party";
      this.drawParty(game);
      return;
    }
    const data = game.data ?? {};
    Chrome.print(monName(m), 0, 2);
    Chrome.printRight(`<LV>${m.level ?? 1}`, COLS, 2);
    const types: string[] = m.types ?? data.pokemon?.[String(m.species ?? "")]?.types ?? [];
    Chrome.print([...new Set(types)].join("/").slice(0, COLS), 0, 3);
    const max = maxHpOf(m);
    const hp = Math.max(0, Math.min(max, Number(m.hp ?? 0)));
    if (this.hud!.available()) this.hud!.drawHpBar(hp, max, 0, 4);
    Chrome.printRight(`${hp}/${max}`, COLS, 4);
    const status = hp <= 0 ? "FNT" : m.status ? String(m.status).toUpperCase().slice(0, 3) : "OK";
    Chrome.print(`STATUS/${status}`, 0, 5);
    const st = m.stats ?? {};
    Chrome.print(`ATK${Chrome.number(st.attack ?? 0, 4)}`, 0, 6);
    Chrome.print(`DEF${Chrome.number(st.defense ?? 0, 4)}`, 10, 6);
    Chrome.print(`SPD${Chrome.number(st.speed ?? 0, 4)}`, 0, 7);
    Chrome.print(`SAT${Chrome.number(st.specialAttack ?? 0, 4)}`, 10, 7);
    Chrome.print(`SDF${Chrome.number(st.specialDefense ?? 0, 4)}`, 0, 8);
    const moves = m.moves ?? [];
    for (let i = 0; i < 4; i++) {
      const mv = moves[i];
      const row = 9 + i;
      if (!mv || mv.id == null) {
        Chrome.print("-", 1, row);
        continue;
      }
      Chrome.print(String(data.moves?.[String(mv.id)]?.name ?? mv.id).slice(0, 12), 1, row);
      Chrome.printRight(`${mv.pp ?? 0}/${mv.maxPp ?? mv.pp ?? 0}`, COLS, row);
    }
  }

  private drawBadges(game: any): void {
    const have = new Set(this.badges(game));
    const list = (title: string, names: string[], row: number): void => {
      Chrome.print(title, 0, row);
      Chrome.printRight(`${names.filter((n) => have.has(n)).length}/8`, COLS, row);
      names.forEach((n, i) => {
        const tx = (i % 2) * 10;
        const ty = row + 1 + Math.floor(i / 2);
        if (have.has(n)) {
          Chrome.cursor(tx, ty);
          Chrome.print(n, tx + 1, ty);
        } else {
          Chrome.print("-".repeat(n.length), tx + 1, ty);
        }
      });
    };
    list("JOHTO", JOHTO_BADGES, 2);
    list("KANTO", KANTO_BADGES, 8);
  }

  private drawCard(game: any): void {
    const player = game.save?.player ?? {};
    const time = game.save?.playTime ?? {};
    const dex = game.save?.pokedex ?? {};
    Chrome.print(`NAME/${player.name || "GOLD"}`, 0, 3);
    Chrome.print(`ID No.${Chrome.number(player.id || 0, 5, true)}`, 0, 5);
    Chrome.print("POKéDEX", 0, 7);
    Chrome.print(`OWN${Chrome.number(this.count(dex.caught), 4)}`, 1, 8);
    Chrome.print(`SEEN${Chrome.number(this.count(dex.seen), 4)}`, 10, 8);
    Chrome.print("PLAY TIME", 0, 10);
    Chrome.printRight(`${time.hours || 0}:${Chrome.number(time.minutes || 0, 2, true)}`, COLS, 10);
    Chrome.print("BADGES", 0, 12);
    Chrome.printRight(`${this.badges(game).length}`, COLS, 12);
  }

  private drawMap(game: any): void {
    // one, kept (building it loads its art: a hitch worth paying once); a
    // new landmark is handed to it as the town map's own open would read it
    const key = `${this.location(game)}|${game.world?.map?.id ?? ""}`;
    if (!this.gear) {
      this.gear = Pokegear.new(game, { townMap: true });
    } else if (this.gearFor !== key) {
      try {
        this.gear.currentLandmark = game.currentLandmark?.();
      } catch {
        // keep the last
      }
      this.gear.mapCursor = undefined;
    }
    this.gearFor = key;
    // its drawMap inside the shift (draw() would reset it with G.origin)
    if (!this.gear.styled()) return;
    G.push();
    G.translate(0, -MAP_SHIFT * 8);
    try {
      this.gear.drawMap();
    } finally {
      G.pop();
    }
    // the tab row back over the map's last shown row
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, TAB_ROW * 8, 160, 8);
  }

  private draw(game: any): void {
    const lcd = this.lcd;
    setLcd(lcd);
    lcd.begin();
    resetDrawState();
    lcd.shown = true;
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, 160, 144);
    const st = game?.world?.map ? battleOf(game) : null;
    const routed = st ? game.stagedBattleBelow?.() : null;
    lcd.tall = !!routed || (!!st && game.stack.top() === st && tallPhase(st));
    if (routed) {
      this.drawScreens(routed.above);
      lcd.end();
      return;
    }
    if (st && lcd.tall) {
      // the forget list or the stats box, as the top screen would draw them
      st.drawBottom(0);
      lcd.end();
      return;
    }
    if (st) {
      if (!this.hud) this.hud = BattleHud.new(game.data?.gen2MenuGfx, game.data?.gen2Palettes);
      this.drawBattle(game, st);
      lcd.end();
      return;
    }
    if (game?.world?.map && this.page === "map") {
      this.drawMap(game);
    } else if (game?.world?.map) {
      Chrome.print(this.location(game), 0, 0);
      Chrome.print(this.time(game), 0, 1);
      Chrome.printRight(`¥${game.save?.player?.money ?? 0}`, COLS, 1);
      if (!this.hud) this.hud = BattleHud.new(game.data?.gen2MenuGfx, game.data?.gen2Palettes);
      if (this.page === "mon") this.drawMon(game);
      else if (this.page === "badges") this.drawBadges(game);
      else if (this.page === "card") this.drawCard(game);
      else this.drawParty(game);
    }
    if (game?.world?.map) {
      // the tabs, the cursor on the page shown (a mon's page is PARTY's)
      for (const t of TABS) {
        Chrome.print(t.label, t.x, TAB_ROW);
        if (t.page === this.page || (t.page === "party" && this.page === "mon")) Chrome.cursor(t.x - 1, TAB_ROW);
      }
    }
    lcd.end();
  }
}
