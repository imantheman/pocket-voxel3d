// Gold's bottom screen: a status panel on the 3DS's lower display, drawn
// with Gold's own font and HUD tiles on a second Gold screen (spec
// `lcdTarget(1)`; the host shows its top 160x120 at 2x, filling 320x240).
// Not the cart's -- the Game Boy had one screen. The Kanto games' bottom
// screen is the Kanto Gear (voxelmon/game/ui/kantogear.ts); this is Gold's
// counterpart, read-only for now:
//
//   row 0     where you are (the landmark name)
//   row 1     the time and its MORN/DAY/NITE, and your money
//   row 2     a rule
//   rows 3-14 the party, two rows a mon: name and level, then the HP bar
//             and HP
//
// It redraws only when something it shows has changed, checked twice a
// second, so a still panel costs a string compare every 15 frames.

import type { VoxelHost } from "../../host.ts";
import { Lcd } from "../platform/lcd.ts";
import G, { resetDrawState, setLcd } from "../platform/screen.ts";
import { Clock } from "../core/Clock.ts";
import { Font } from "../shared/render/Font.ts";
import { BattleHud } from "./BattleHud.ts";
import { Chrome } from "./Chrome.ts";

type LcdBankSpec = { base: number; page: number; count: number };

const COLS = 20;
/** Shown frames between checks for a change (~0.5 s at 30 fps). */
const CHECK_EVERY = 15;
const PARTY_MAX = 6;

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
  stats?: { hp?: number };
  isEgg?: boolean;
  egg?: boolean;
}

function monName(m: MonLike): string {
  return String(m.nickname || m.name || m.species || "?").slice(0, 10);
}

function maxHpOf(m: MonLike): number {
  return Math.max(1, Number(m.maxHp || (m.stats && m.stats.hp) || 1));
}

export class Companion {
  private readonly lcd: Lcd;
  private hud: BattleHud | null = null;
  private sig = "";
  private wait = 0;

  constructor(host: VoxelHost, banks: LcdBankSpec[]) {
    this.lcd = new Lcd(targeted(host, 1));
    if (banks.length > 0) this.lcd.banks(banks);
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

  private signature(game: any): string {
    if (!game?.world?.map) return "boot";
    let s = `${this.location(game)}|${this.time(game)}|${game.save?.player?.money ?? 0}`;
    for (const m of this.party(game)) s += `|${monName(m)}:${m.level ?? 0}:${m.hp ?? 0}/${maxHpOf(m)}:${m.isEgg || m.egg ? 1 : 0}`;
    return s;
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
      for (let x = 0; x < COLS; x++) Font.drawCode(Font.BORDER.h!, x * 8, 2 * 8);
      if (!this.hud) this.hud = BattleHud.new(game.data?.gen2MenuGfx, game.data?.gen2Palettes);
      const party = this.party(game);
      for (let i = 0; i < party.length; i++) {
        const m = party[i]!;
        const row = 3 + i * 2;
        if (m.isEgg || m.egg) {
          Chrome.print("EGG", 1, row);
          continue;
        }
        Chrome.print(monName(m), 1, row);
        Chrome.print(`<LV>${m.level ?? 1}`, 14, row);
        const max = maxHpOf(m);
        const hp = Math.max(0, Math.min(max, Number(m.hp ?? 0)));
        if (this.hud.available()) this.hud.drawHpBar(hp, max, 1, row + 1);
        Chrome.printRight(`${hp}/${max}`, COLS, row + 1);
      }
    }
    lcd.end();
  }
}
