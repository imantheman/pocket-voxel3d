// Port of gen1recomp src/ui/game3/hall_of_fame_pc.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/hall_of_fame.c:709 -- the PC's Hall of Fame record viewer.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, mod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { RomText } from "../core/rom_text.ts";
import { HofGfx } from "./hall_of_fame_gfx.ts";
import { Profile } from "../core/profile.ts";
import { Audio } from "../core/audio.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { Dex } from "../core/dex.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { NotPortedError } from "../notported.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";

export interface HofPcModule {
  isMenu: boolean;
  open: boolean;
  _teams: LuaTable;
  _team: number;
  _number: number;
  _mon: number;
  _corrupted: boolean;
  _session?: any;
  _onDone?: (() => void) | null;
  _national?: boolean;
  show(opts?: any): void;
  isOpen(): boolean;
  close(): void;
  reset(): void;
  handleInput(input: any): void;
  draw(): void;
}

const MAX_TEAMS = 50; // pokefirered/src/hall_of_fame.c:29
const SPECIES_EGG = 412; // pokefirered/include/constants/species.h:421
const SPECIES_NIDORAN_F = 29; // pokefirered/include/constants/species.h:33
const SPECIES_NIDORAN_M = 32; // pokefirered/include/constants/species.h:36
const KANTO_SPECIES_END = 151; // pokefirered/include/constants/species.h:157
// pokeemerald/src/hall_of_fame.c:945
const RSE_TEXT: Record<string, string> = {
  gText_ABUTTONExit: "gText_AButtonExit",
  gText_UPDOWNPick_ABUTTONBBUTTONCancel: "gText_PickCancel",
  gText_UPDOWNPick_ABUTTONNext_BBUTTONBack: "gText_PickNextCancel",
};

// Lua: hall_of_fame_pc.lua:30
function key(k: string): string {
  const rse = Profile.family(HofPc._session) === "rse";
  return (rse && RSE_TEXT[k]) || k;
}
const GAME_STAT_ENTERED_HOF = 10; // pokefirered/include/constants/game_stat.h:14
const BG = seq(22 / 31, 24 / 31, 29 / 31); // pokefirered/src/hall_of_fame.c:30
const BLEND_COEFF = 12 / 16; // pokefirered/src/hall_of_fame.c:873
// pokefirered/src/hall_of_fame.c:136
// Built on first use: no top-level reads of imports (the gen3 import cycle).
let whiteText_: Colors | undefined;
function white_text(): Colors {
  return (whiteText_ ??= { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] });
}

// pokefirered/src/hall_of_fame.c:152
const FULL_TEAM = seq(seq(120, 40), seq(56, 40), seq(184, 40), seq(120, 88), seq(200, 88), seq(40, 88)) as (number[] | null)[];
// pokefirered/src/hall_of_fame.c:162
const HALF_TEAM = seq(seq(120, 64), seq(56, 64), seq(184, 64)) as (number[] | null)[];

let blendShader: Shader | false | undefined;

// Lua: hall_of_fame_pc.lua:49
function shader(): Shader | undefined {
  if (blendShader == null) {
    let s: Shader | false;
    try { s = G.newShader("mix_target"); } catch { s = false; }
    blendShader = s;
  }
  return blendShader || undefined;
}

// Lua: hall_of_fame_pc.lua:63
function members(team: any): LuaTable {
  const list: LuaTable = seq();
  for (let i = 1; i <= 6; i++) {
    const mon = team && team[i];
    if (mon && (tonumber(mon.species) ?? 0) !== 0) list[len(list) + 1] = mon;
  }
  return list;
}

// Lua: hall_of_fame_pc.lua:72
function cry(): void {
  const team = HofPc._teams[HofPc._team];
  const mon = members(team)[HofPc._mon];
  if (!mon || tonumber(mon.species) === SPECIES_EGG) return;
  try {
    const A: any = Audio;
    if (A.stopCry) A.stopCry();
    A.playCry(tonumber(mon.species));
  } catch { /* pcall */ }
}

// Lua: hall_of_fame_pc.lua:83
function nationalEnabled(session: any): boolean {
  return PokedexData.isNationalUnlocked(session, session && session.dex) || false;
}

// Lua: hall_of_fame_pc.lua:156
function drawBackground(): void {
  // pokefirered/src/hall_of_fame.c:1193
  HofGfx.drawStripes();
  // pokefirered/src/hall_of_fame.c:749
  HofGfx.drawBands(16, 7);
}

// pokefirered/src/menu.c:163
// Lua: hall_of_fame_pc.lua:164
function drawTopBar(left: string | null, right: string | null): void {
  G.setColor(FrlgFont.STDPAL[2]!);
  G.rectangle("fill", 0, 0, 240, 16);
  G.setColor(1, 1, 1, 1);
  const white: Colors = { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] };
  if (left) Window.printPx(left, 2, 2, { colors: white } as any);
  if (right) {
    // pcall(require, "src.ui.game3.pokedex_chrome"): a stub stands for the failed require
    const PC: any = PokedexChrome;
    try {
      if (PC.drawControlInfo) PC.drawControlInfo(right, 238, 2);
    } catch (e) {
      if (!(e instanceof NotPortedError)) throw e;
    }
  }
}

// pokefirered/src/hall_of_fame.c:993
// Lua: hall_of_fame_pc.lua:177
function drawMonInfo(mon: any): void {
  const x0 = 16, y0 = 120;
  const sp = tonumber(mon.species) ?? 0;
  const egg = sp === SPECIES_EGG;
  const nick = tostring(mon.nickname ?? "");
  if (!egg) {
    const dex = (Pokemon.national && Pokemon.national(sp)) || sp;
    let digits = (!HofPc._national && dex > KANTO_SPECIES_END) ? "???" : format("%03d", dex);
    if (Profile.family(HofPc._session) === "rse" && !HofPc._national) {
      // pokeemerald/src/pokemon.c:6396
      const n = Dex.regionalNumber(sp, Profile.forSession(HofPc._session).id);
      digits = n != null ? format("%03d", n) : "???";
    }
    FrlgFont.draw(RomText.plain("gText_Number") + digits, x0 + 16, y0 + 1, { colors: white_text() });
  }
  const w = FrlgFont.measure(nick);
  const nx = egg ? (x0 + 0x80 - Math.floor(w / 2)) : (x0 + 0x80 - w);
  FrlgFont.draw(nick, nx, y0 + 1, { colors: white_text() });
  if (egg) return;
  let gender = " ";
  if (sp !== SPECIES_NIDORAN_M && sp !== SPECIES_NIDORAN_F) {
    const g = Pokemon.gender(sp, tonumber(mon.personality) ?? 0);
    if (g === "M") gender = "\xE2\x99\x82"; else if (g === "F") gender = "\xE2\x99\x80"; // ♂ / ♀
  }
  // pokefirered/src/hall_of_fame.c:1066
  FrlgFont.draw("/" + tostring(Pokemon.name(sp) || "") + gender, x0 + 0x80, y0 + 1, { colors: white_text() });
  FrlgFont.draw(RomText.plain("gText_Level") + tostring(tonumber(mon.level) ?? 0), x0 + 0x20, y0 + 0x11,
    { colors: white_text() });
  FrlgFont.draw(RomText.plain("gText_IDNumber") + format("%05d", mod(tonumber(mon.trainerId) ?? 0, 65536)), x0 + 0x60,
    y0 + 0x11, { colors: white_text() });
}

export const HofPc: HofPcModule = {
  isMenu: true,
  open: false,
  _teams: seq(),
  _team: 0,
  _number: 0,
  _mon: 1,
  _corrupted: false,

  // pokefirered/src/hall_of_fame.c:758
  // Lua: hall_of_fame_pc.lua:89
  show(opts?: any): void {
    opts = opts || {};
    const session = opts.session || {};
    HofPc._session = session;
    HofPc._onDone = opts.onDone;
    HofPc._teams = (session.hallOfFameTeams != null && typeof session.hallOfFameTeams === "object") ? session.hallOfFameTeams : seq();
    HofPc._corrupted = len(HofPc._teams) === 0;
    HofPc._team = Math.min(len(HofPc._teams), MAX_TEAMS);
    const stats = session.gameStats || {};
    HofPc._number = tonumber(stats[GAME_STAT_ENTERED_HOF]) ?? 0;
    HofPc._mon = 1;
    HofPc._national = nationalEnabled(session);
    HofPc.open = true;
    Stack.push("hall_of_fame_pc", HofPc, { hideBelow: true, fullscreen: true });
    if (!HofPc._corrupted) cry();
  },

  // Lua: hall_of_fame_pc.lua:106
  isOpen(): boolean {
    return HofPc.open;
  },

  // pokefirered/src/hall_of_fame.c:937
  // Lua: hall_of_fame_pc.lua:111
  close(): void {
    if (!HofPc.open) return;
    HofPc.open = false;
    try { (Audio as any).stopCry(); } catch { /* pcall */ }
    Stack.pop("hall_of_fame_pc");
    const cb = HofPc._onDone;
    HofPc._onDone = null;
    if (cb) cb();
  },

  // Lua: hall_of_fame_pc.lua:121
  reset(): void {
    HofPc.open = false;
    HofPc._onDone = null;
    HofPc._session = null;
    HofPc._teams = seq();
  },

  // pokefirered/src/hall_of_fame.c:886
  // Lua: hall_of_fame_pc.lua:129
  handleInput(input: any): void {
    if (!HofPc.open) return;
    if (HofPc._corrupted) {
      if (input.wasPressed("a")) HofPc.close(); // pokefirered/src/hall_of_fame.c:980
      return;
    }
    const count = len(members(HofPc._teams[HofPc._team]));
    if (input.wasPressed("a")) {
      if (HofPc._team > 1) {
        HofPc._team = HofPc._team - 1;
        if (HofPc._number !== 0) HofPc._number = HofPc._number - 1;
        HofPc._mon = 1;
        cry();
      } else {
        HofPc.close();
      }
    } else if (input.wasPressed("b")) {
      HofPc.close();
    } else if (input.wasPressed("up") && HofPc._mon > 1) {
      HofPc._mon = HofPc._mon - 1;
      cry();
    } else if (input.wasPressed("down") && HofPc._mon < count) {
      HofPc._mon = HofPc._mon + 1;
      cry();
    }
  },

  // Lua: hall_of_fame_pc.lua:209
  draw(): void {
    if (!HofPc.open) return;
    drawBackground();
    if (HofPc._corrupted) {
      // pokefirered/src/hall_of_fame.c:969
      drawTopBar(null, RomText.plain(key("gText_ABUTTONExit")));
      Window.dialogueFrame();
      Window.printPx(RomText.plain("gText_HOFCorrupted"), 16, 121);
      return;
    }
    const list = members(HofPc._teams[HofPc._team]);
    const pos = len(list) > 3 ? FULL_TEAM : HALF_TEAM;
    const sh = shader();
    for (const [i, mon] of ipairs<any>(list)) {
      const p = pos[i];
      const pic = p ? Pokemon.monFrontPic(mon) : null;
      if (pic && pic.image) {
        const dim = i !== HofPc._mon;
        if (dim && sh) {
          G.setShader(sh);
          sh.send("target", BG);
          sh.send("coeff", BLEND_COEFF);
        }
        G.setColor(1, 1, 1, 1);
        G.draw(pic.image, p![1]! - 32, p![2]! - 32);
        if (dim && sh) G.setShader();
      }
    }
    // pokefirered/src/hall_of_fame.c:843
    const title = RomText.plain("gText_HOFNumber", { stringVars: seq(tostring(HofPc._number)) });
    const hint = HofPc._team <= 1 ? RomText.plain(key("gText_UPDOWNPick_ABUTTONBBUTTONCancel"))
      : RomText.plain(key("gText_UPDOWNPick_ABUTTONNext_BBUTTONBack"));
    drawTopBar(title, hint);
    const mon = list[HofPc._mon];
    if (mon) drawMonInfo(mon);
  },
};

export default HofPc;
