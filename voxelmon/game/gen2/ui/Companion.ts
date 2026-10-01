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
//   row 14     the tabs, PARTY BADGES CARD, tapped to turn the page
//
// A tap is the finger lifting after it went down on a target (the Kanto
// Gear's rule). The panel redraws only when something it shows has changed,
// checked twice a second, so a still panel costs a string compare every 15
// frames; a page turn redraws on the next shown frame.

import type { VoxelHost } from "../../host.ts";
import { Lcd } from "../platform/lcd.ts";
import G, { resetDrawState, setLcd } from "../platform/screen.ts";
import { Clock } from "../core/Clock.ts";
import { BattleHud } from "./BattleHud.ts";
import { Chrome } from "./Chrome.ts";

type LcdBankSpec = { base: number; page: number; count: number };

const COLS = 20;
/** Shown frames between checks for a change (~0.5 s at 30 fps). */
const CHECK_EVERY = 15;
const PARTY_MAX = 6;
/** The tab row, and each tab's first column (its cursor sits one left). */
const TAB_ROW = 14;
type Page = "party" | "mon" | "badges" | "card";
const TABS: { page: Page; label: string; x: number }[] = [
  { page: "party", label: "PARTY", x: 1 },
  { page: "badges", label: "BADGES", x: 8 },
  { page: "card", label: "CARD", x: 16 },
];
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
  const names = ["lcdShow", "lcdBank", "lcdReset", "lcdCells", "lcdRegs", "lcdObjs", "lcdPals", "lcdLines"];
  const out: Record<string, unknown> = {};
  for (const n of names) out[n] = wrap(n);
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

  constructor(host: VoxelHost, banks: LcdBankSpec[]) {
    this.lcd = new Lcd(targeted(host, 1));
    if (banks.length > 0) this.lcd.banks(banks);
  }

  /** Once a step: the bottom screen's touch in its own pixels (320x240) and
   *  whether a finger is on it. Acts as the finger lifts. */
  touch(game: any, x: number, y: number, held: boolean): void {
    if (held) {
      if (!this.down) this.down = [Math.floor(x / 16), Math.floor(y / 16)];
      return;
    }
    const at = this.down;
    this.down = null;
    if (!at || !game?.world?.map) return;
    const [cx, cy] = at;
    let page: Page = this.page;
    let mon = this.mon;
    const party = this.party(game);
    if (cy === TAB_ROW) {
      for (const t of TABS) if (cx >= t.x - 1 && cx < t.x + t.label.length) page = t.page;
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
    // redraw on the next shown frame
    this.sig = "";
    this.wait = CHECK_EVERY;
  }

  /** Once per shown frame, after the top screen's compose. */
  frame(game: any): void {
    if (this.sig !== "" && ++this.wait < CHECK_EVERY) return;
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

  private signature(game: any): string {
    if (!game?.world?.map) return "boot";
    let s = `${this.page}:${this.mon}|${this.location(game)}|${this.time(game)}|${game.save?.player?.money ?? 0}`;
    for (const m of this.party(game)) {
      s += `|${monName(m)}:${m.level ?? 0}:${m.hp ?? 0}/${maxHpOf(m)}:${isEgg(m) ? 1 : 0}`;
      if (this.page === "mon") s += `:${String(m.status ?? "")}:${(m.moves ?? []).map((v) => `${String(v?.id)}${v?.pp}`).join(",")}`;
    }
    if (this.page === "badges") s += `|${this.badges(game).join(",")}`;
    if (this.page === "card") {
      const dex = game.save?.pokedex ?? {};
      s += `|${this.count(dex.caught)}/${this.count(dex.seen)}|${game.save?.playTime?.hours ?? 0}:${game.save?.playTime?.minutes ?? 0}`;
    }
    return s;
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

  private draw(game: any): void {
    const lcd = this.lcd;
    setLcd(lcd);
    lcd.begin();
    resetDrawState();
    lcd.shown = true;
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, 160, 144);
    if (game?.world?.map) {
      Chrome.print(this.location(game), 0, 0);
      Chrome.print(this.time(game), 0, 1);
      Chrome.printRight(`¥${game.save?.player?.money ?? 0}`, COLS, 1);
      if (!this.hud) this.hud = BattleHud.new(game.data?.gen2MenuGfx, game.data?.gen2Palettes);
      if (this.page === "mon") this.drawMon(game);
      else if (this.page === "badges") this.drawBadges(game);
      else if (this.page === "card") this.drawCard(game);
      else this.drawParty(game);
      // the tabs, the cursor on the page shown (a mon's page is PARTY's)
      for (const t of TABS) {
        Chrome.print(t.label, t.x, TAB_ROW);
        if (t.page === this.page || (t.page === "party" && this.page === "mon")) Chrome.cursor(t.x - 1, TAB_ROW);
      }
    }
    lcd.end();
  }
}
