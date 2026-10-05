// Port of gen1recomp src/ui/game3/hall_of_fame.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/hall_of_fame.c:361 CB2_DoHallOfFameScreen

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { RomText } from "../core/rom_text.ts";
import { HofGfx } from "./hall_of_fame_gfx.ts";
import { Rng } from "../core/rng.ts";
import { Trig } from "../core/trig.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Audio } from "../core/audio.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { Fade } from "./fade.ts";
import { Map } from "../core/map.ts";
import { Player } from "../core/player.ts";
import { Song } from "../core/song_ids.ts";
import { SE } from "../core/se_ids.ts";
import { Constants } from "../core/constants.ts";
import { Dex } from "../core/dex.ts";
import { TrainerPic } from "../core/trainer_pic.ts";
import { NotPortedError } from "../notported.ts";
import { G, type Shader } from "../platform/graphics.ts";
import { insert, ipairs, len, remove, seq, type LuaTable } from "../platform/lt.ts";

interface HofSprite { x: number; y: number; dx: number; dy: number; mon: any }
interface Confetti { x: number; y: number; frame: number; fall: number; x2: number; y2: number; angle: number }
interface HofFade { y: number; target: number; delay: number; counter: number; color: number[]; active: boolean }

export interface HallOfFameModule {
  open: boolean;
  _session: any;
  _onDone: (() => void) | null | undefined;
  _mons: LuaTable;
  _currentIndex: number;
  _phase: string;
  _timer: number;
  _dontSave?: boolean;
  _warp?: boolean;
  _credits?: boolean;
  _hasRecords?: boolean;
  _sprites?: Record<number, HofSprite>;
  _selected?: Record<number, boolean>;
  _dimmed?: boolean;
  _info?: any;
  _welcome?: boolean;
  _saving?: boolean;
  _band?: number;
  _bandEva?: number;
  _confetti?: (Confetti | null)[];
  _player?: { x: number; y: number; pic: number } | null;
  _playerInfo?: boolean;
  _national?: boolean;
  _fade?: HofFade | null;
  _commitClearAndSave: (session: any, eligibleMons: LuaTable) => void;
  start(opts?: any): void;
  setWarpsToRollCredits(): boolean;
  close(): void;
  reset(): void;
  isOpen(): boolean;
  phase(): string;
  getCurrentMon(): any;
  update(dt?: number): void;
  handleInput(inp: any): void;
  draw(): void;
}

// Lua: hall_of_fame.lua:22
function game_clear_flag(session: any): number {
  const id = Flags.forVersion(Profile.forSession(session).id).IDS.FLAG_SYS_GAME_CLEAR;
  if (!truthy(id)) throw new Error("assertion failed!");
  return id!;
}

// Lua: hall_of_fame.lua:27
function rse(session: any): boolean {
  return Profile.family(session) === "rse";
}

// pokeemerald/src/hall_of_fame.c:516
const RSE_TEXT: Record<string, string> = { gText_MainMenuTime: "gText_Time", gText_SavingDontTurnOffThePower2: "gText_SavingDontTurnOffPower" };

// Lua: hall_of_fame.lua:34
function key(session: any, k: string): string {
  return (rse(session) && RSE_TEXT[k]) || k;
}

// pokefirered/src/hall_of_fame.c:30
const BG_PAL = seq(22 / 31, 24 / 31, 29 / 31);
// pokefirered/src/hall_of_fame.c:152
const FULL_TEAM = seq(
  seq(120, 210, 120, 40), seq(326, 220, 56, 40), seq(-86, 220, 184, 40),
  seq(120, -62, 120, 88), seq(-70, -92, 200, 88), seq(310, -92, 40, 88),
) as (number[] | null)[];
// pokefirered/src/hall_of_fame.c:162
const HALF_TEAM = seq(seq(120, 234, 120, 64), seq(326, 244, 56, 64), seq(-86, 244, 184, 64)) as (number[] | null)[];
// pokefirered/include/constants/trainers.h:156
const TRAINER_PIC_RED = 135, TRAINER_PIC_LEAF = 136;
// pokeemerald/src/hall_of_fame.c:701
const RSE_PLAYER_PICS = seq("TRAINER_PIC_BRENDAN", "TRAINER_PIC_MAY");
// pokefirered/include/constants/species.h:33
const SPECIES_NIDORAN_F = 29, SPECIES_NIDORAN_M = 32;
// pokefirered/src/hall_of_fame.c:126
const PLAYER_WIN = { left: 2, top: 2, width: 17, height: 6 };
// pokeemerald/src/hall_of_fame.c:136
const PLAYER_WIN_RSE = { left: 2, top: 2, width: 14, height: 6 };
// Built on first use: no top-level reads of imports (the gen3 import cycle).
let whiteText_: Colors | undefined;
function white_text(): Colors {
  return (whiteText_ ??= { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] });
}
// Built on first use: no top-level reads of imports (the gen3 import cycle).
let grayText_: Colors | undefined;
function gray_text(): Colors {
  return (grayText_ ??= { fg: FrlgFont.STDPAL[2], shadow: FrlgFont.STDPAL[3], bg: FrlgFont.STDPAL[0] });
}

// pokefirered/src/hall_of_fame.c:382 Task_Hof_InitMonData
// Lua: hall_of_fame.lua:61
function extract_eligible_mons(party: any): LuaTable {
  const eligible: LuaTable = seq();
  if (party == null || typeof party !== "object") return eligible;
  for (let i = 1; i <= Math.min(6, len(party)); i++) {
    const mon = party[i];
    if (mon && (tonumber(mon.species) ?? 0) !== 0) {
      insert(eligible, mon);
    }
  }
  return eligible;
}

// Lua: hall_of_fame.lua:73
function commit_clear_and_save(session: any, eligibleMons: LuaTable): void {
  if (!session) return;

  // 1. Set clear flag
  session.flags = session.flags || {};
  session.flags[game_clear_flag(session)] = true;
  session.game_cleared = true;
  session.hasHallOfFameRecords = true;

  // 2. Timestamp debut
  const h = tonumber(session.playTimeHours ?? session.hours) ?? 0;
  const m = tonumber(session.playTimeMinutes ?? session.minutes) ?? 0;
  const s = tonumber(session.playTimeSeconds ?? session.seconds) ?? 0;
  session.hofDebutHours = h;
  session.hofDebutMinutes = m;
  session.hofDebutSeconds = s;
  session.hofDebutTime = format("%d:%02d:%02d", h, m, s);

  // 3. Record Hall of Fame team
  session.hallOfFameTeams = session.hallOfFameTeams || seq();
  const teamRecord: LuaTable = seq();
  // pokefirered/src/hall_of_fame.c:389
  for (let i = 1; i <= Math.min(6, len(eligibleMons)); i++) {
    const mon = eligibleMons[i];
    const egg = Pokemon.isEgg(mon);
    const sp = egg ? 412 : (mon.species ?? 1);
    const lvl = tonumber(mon.level) ?? 1;
    const nick = egg ? RomText.plain("gText_EggNickname") : (mon.nickname || mon.name || Pokemon.name(sp) || "POK\xC3\xA9MON");
    const tid = tonumber(mon.otId ?? mon.tid ?? session.trainerId ?? 0);
    insert(teamRecord, {
      species: sp,
      level: lvl,
      nickname: nick,
      trainerId: tid,
      otSecretId: tonumber(mon.otSecretId) ?? 0,
      personality: tonumber(mon.personality) ?? 0,
    });
  }
  insert(session.hallOfFameTeams, teamRecord);
  // pokefirered/src/hall_of_fame.c:443
  while (len(session.hallOfFameTeams) > 50) {
    remove(session.hallOfFameTeams, 1);
  }
  // pokefirered/src/save.c:665
  session.gameStats = session.gameStats || seq();
  const entered = tonumber(session.gameStats[10]) ?? 0;
  if (entered < 999) session.gameStats[10] = entered + 1;

  // 4. Commit to disk through the engine's save path.  This used to pcall
  // "src.core.game3.save", which does not exist -- so the clear flag, the debut
  // timestamp and the team above were set in memory and never written.
  // package.loaded["src.core.game3.runtime"]
  const game = Runtime && Runtime._game;
  if (game && typeof game.saveGame === "function") {
    try {
      game.saveGame();
    } catch (err) {
      try {
        Logger.warn("[hall_of_fame] save failed: %s", tostring(err instanceof Error ? err.message : err));
      } catch { /* pcall */ }
    }
  }
}

// Lua: hall_of_fame.lua:140
function audio(): any {
  return Audio;
}

// Lua: hall_of_fame.lua:144
function player_female(session: any): boolean {
  const g = session && (session.gender ?? session.playerGender);
  return g === 1 || g === "female" || g === "F";
}

// Lua: hall_of_fame.lua:149
function national_enabled(session: any): boolean {
  const P: any = PokedexData;
  return (P.isNationalUnlocked && P.isNationalUnlocked(session, session && session.dex)) || false;
}

// pokefirered/src/palette.c:151
// Lua: hall_of_fame.lua:156
function begin_fade(y: number, target: number, delay?: number, color?: number[]): void {
  HallOfFame._fade = {
    y, target, delay: delay ?? 0, counter: delay ?? 0,
    color: color ?? seq(0, 0, 0) as number[], active: y !== target,
  };
}

// Lua: hall_of_fame.lua:163
function fade_active(): boolean {
  return !!(HallOfFame._fade && HallOfFame._fade.active);
}

// Lua: hall_of_fame.lua:167
function tick_fade(): void {
  const f = HallOfFame._fade;
  if (!(f && f.active)) return;
  if (f.counter > 0) {
    f.counter = f.counter - 1;
    return;
  }
  f.counter = f.delay;
  if (f.y < f.target) {
    f.y = Math.min(f.target, f.y + 2);
  } else {
    f.y = Math.max(f.target, f.y - 2);
  }
  if (f.y === f.target) f.active = false;
}

let blendShader: Shader | false | undefined;

// Lua: hall_of_fame.lua:185
function shader(): Shader | undefined {
  if (blendShader == null) {
    let s: Shader | false;
    try { s = G.newShader("mix_target"); } catch { s = false; }
    blendShader = s;
  }
  return blendShader || undefined;
}

// Lua: hall_of_fame.lua:297
function positions(): (number[] | null)[] {
  return len(HallOfFame._mons) > 3 ? FULL_TEAM : HALF_TEAM;
}

// pokefirered/src/hall_of_fame.c:1223 SpriteCB_GetOnScreen
// Lua: hall_of_fame.lua:302
function slide(s: HofSprite): boolean {
  if (s.x === s.dx && s.y === s.dy) return true;
  if (s.x < s.dx) s.x = s.x + 15;
  if (s.x > s.dx) s.x = s.x - 15;
  if (s.y < s.dy) s.y = s.y + 10;
  if (s.y > s.dy) s.y = s.y - 10;
  return false;
}

// pokefirered/src/hall_of_fame.c:1267 Hof_SpawnConfetti
// Lua: hall_of_fame.lua:312
function spawn_confetti(): void {
  const x = Rng.Random() % 240;
  const y = -(Rng.Random() % 8);
  const frame = Rng.Random() % 17;
  const fall = (Rng.Random() % 4 !== 0) ? 0 : 1;
  const list = HallOfFame._confetti!;
  list[len(list) + 1] = { x, y, frame, fall, x2: 0, y2: 0, angle: 0 };
}

// pokefirered/src/hall_of_fame.c:1245 SpriteCB_Confetti
// Lua: hall_of_fame.lua:322
function update_confetti(): void {
  const keep: (Confetti | null)[] = [null];
  for (const [, c] of ipairs<Confetti>(HallOfFame._confetti || [null])) {
    if (c.y2 <= 120) {
      c.y2 = c.y2 + 1 + c.fall;
      const amp = Rng.Random() % 4 + 8;
      const v = amp * Trig.SINE[mod(c.angle, 256) + 1]!;
      c.x2 = v >= 0 ? Math.floor(v / 256) : -Math.floor(-v / 256);
      c.angle = c.angle + 4;
      keep[len(keep) + 1] = c;
    }
  }
  HallOfFame._confetti = keep;
}

// Lua: hall_of_fame.lua:337
function run_phase(): void {
  const phase = HallOfFame._phase;
  if (phase === "fadein") {
    if (fade_active()) return;
    // pokefirered/src/hall_of_fame.c:353
    audio().playSong(Song.MUS_HALL_OF_FAME);
    HallOfFame._phase = HallOfFame._dontSave ? "display" : "save";
  } else if (phase === "save") {
    // pokefirered/src/hall_of_fame.c:456
    HallOfFame._saving = true;
    HallOfFame._phase = "trysave";
  } else if (phase === "trysave") {
    // pokefirered/src/hall_of_fame.c:462
    const session = HallOfFame._session;
    commit_clear_and_save(session, (session.party != null && typeof session.party === "object") ? session.party : seq());
    audio().playSe(SE.SE_SAVE);
    HallOfFame._timer = 32;
    HallOfFame._phase = "savewait";
  } else if (phase === "savewait") {
    // pokefirered/src/hall_of_fame.c:471
    if (HallOfFame._timer !== 0) {
      HallOfFame._timer = HallOfFame._timer - 1;
    } else {
      HallOfFame._phase = "display";
    }
  } else if (phase === "display") {
    // pokefirered/src/hall_of_fame.c:484
    const i = HallOfFame._currentIndex;
    const pos = positions()[i];
    const mon = HallOfFame._mons[i];
    if (!(pos && mon)) {
      HallOfFame._phase = "welcome";
      return;
    }
    HallOfFame._sprites![i] = { x: pos[1]!, y: pos[2]!, dx: pos[3]!, dy: pos[4]!, mon };
    HallOfFame._saving = false;
    HallOfFame._info = null;
    HallOfFame._phase = "slide";
  } else if (phase === "slide") {
    const s = HallOfFame._sprites![HallOfFame._currentIndex]!;
    slide(s);
    // pokefirered/src/hall_of_fame.c:521
    if (s.x === s.dx && s.y === s.dy) {
      const sp = tonumber(s.mon.species) ?? 0;
      if (!Pokemon.isEgg(s.mon)) {
        try { audio().playCry(sp); } catch { /* pcall */ }
      }
      HallOfFame._info = s.mon;
      HallOfFame._timer = 120;
      HallOfFame._phase = "hold";
    }
  } else if (phase === "hold") {
    // pokefirered/src/hall_of_fame.c:535
    if (HallOfFame._timer !== 0) {
      HallOfFame._timer = HallOfFame._timer - 1;
      return;
    }
    const i = HallOfFame._currentIndex;
    HallOfFame._selected![i] = true;
    if (i < 6 && HallOfFame._mons[i + 1]) {
      HallOfFame._currentIndex = i + 1;
      HallOfFame._dimmed = true;
      HallOfFame._phase = "display";
    } else {
      HallOfFame._phase = "welcome";
    }
  } else if (phase === "welcome") {
    // pokefirered/src/hall_of_fame.c:561
    HallOfFame._dimmed = false;
    HallOfFame._info = null;
    HallOfFame._welcome = true;
    audio().playSe(SE.SE_APPLAUSE);
    HallOfFame._timer = 400;
    HallOfFame._phase = "applause";
  } else if (phase === "applause") {
    // pokefirered/src/hall_of_fame.c:578
    if (HallOfFame._timer !== 0) {
      HallOfFame._timer = HallOfFame._timer - 1;
      if (HallOfFame._timer % 4 === 0 && HallOfFame._timer > 110) spawn_confetti();
      return;
    }
    HallOfFame._dimmed = true;
    HallOfFame._welcome = false;
    HallOfFame._timer = 7;
    HallOfFame._phase = "bands";
  } else if (phase === "bands") {
    // pokefirered/src/hall_of_fame.c:602
    if (HallOfFame._timer > 15) {
      HallOfFame._phase = "playerpic";
    } else {
      HallOfFame._timer = HallOfFame._timer + 1;
      HallOfFame._band = HallOfFame._timer;
      HallOfFame._bandEva = 0;
    }
  } else if (phase === "playerpic") {
    // pokefirered/src/hall_of_fame.c:615
    HallOfFame._band = 16;
    let pic: number = player_female(HallOfFame._session) ? TRAINER_PIC_LEAF : TRAINER_PIC_RED;
    if (rse(HallOfFame._session)) {
      const C = Constants.of(Profile.forSession(HallOfFame._session).id);
      pic = C.require("trainer_classes", RSE_PLAYER_PICS[player_female(HallOfFame._session) ? 2 : 1]!);
    }
    HallOfFame._player = { x: 0x78, y: 0x48, pic };
    HallOfFame._timer = 120;
    HallOfFame._phase = "playerwait";
  } else if (phase === "playerwait") {
    // pokefirered/src/hall_of_fame.c:628
    if (HallOfFame._timer !== 0) {
      HallOfFame._timer = HallOfFame._timer - 1;
    } else if (HallOfFame._player!.x !== 192) {
      HallOfFame._player!.x = HallOfFame._player!.x + 1;
    } else {
      HallOfFame._playerInfo = true;
      HallOfFame._phase = "exitwait";
    }
  } else if (phase === "exit") {
    // pokefirered/src/hall_of_fame.c:665
    if (!fade_active()) HallOfFame.close();
  }
}

// pokefirered/src/hall_of_fame.c:1181 DrawHofBackground
// Lua: hall_of_fame.lua:478
function draw_background(): void {
  HofGfx.drawStripes();
  HofGfx.drawBands(HallOfFame._bandEva ?? 16, HallOfFame._band ?? 7);
}

// Lua: hall_of_fame.lua:483
function draw_confetti(): void {
  const sheet = HofGfx.confetti();
  if (!sheet) return;
  G.setColor(1, 1, 1, 1);
  for (const [, c] of ipairs<Confetti>(HallOfFame._confetti || [null])) {
    G.draw(sheet.image, sheet.quads![c.frame], c.x + c.x2 - 4, c.y + c.y2 - 4);
  }
}

// Lua: hall_of_fame.lua:492
function draw_mon(s: HofSprite, dim: boolean | undefined): void {
  const pic = Pokemon.monFrontPic(s.mon);
  if (!(pic && pic.image)) return;
  const sh = dim ? shader() : undefined;
  if (sh) {
    G.setShader(sh);
    sh.send("target", BG_PAL);
    sh.send("coeff", 12 / 16);
  }
  G.setColor(1, 1, 1, 1);
  G.draw(pic.image, s.x - 32, s.y - 32);
  if (sh) G.setShader();
}

// pokefirered/src/hall_of_fame.c:993 HallOfFame_PrintMonInfo
// Lua: hall_of_fame.lua:507
function draw_mon_info(mon: any): void {
  const x0 = 16, y0 = 120;
  const sp = tonumber(mon.species) ?? 0;
  const egg = Pokemon.isEgg(mon);
  if (!egg) {
    // pokeemerald/src/pokemon.c:6396
    let dex: number | null | undefined = Pokemon.national(sp) ?? sp;
    if (!HallOfFame._national) {
      dex = Dex.regionalNumber(sp, Profile.forSession(HallOfFame._session).id);
    }
    const digits = dex != null ? format("%03d", dex) : "???";
    FrlgFont.draw(RomText.plain("gText_Number") + digits, x0 + 16, y0 + 1, { colors: white_text() });
  }
  const nick = egg ? RomText.plain("gText_EggNickname") : Pokemon.displayName(mon);
  const w = FrlgFont.measure(nick);
  const nx = egg ? (0x80 - Math.floor(w / 2)) : (0x80 - w);
  FrlgFont.draw(nick, x0 + nx, y0 + 1, { colors: white_text() });
  if (egg) return;
  let gender = " ";
  if (sp !== SPECIES_NIDORAN_M && sp !== SPECIES_NIDORAN_F) {
    const g = Pokemon.gender(sp, tonumber(mon.personality) ?? 0);
    if (g === "M") gender = "\xE2\x99\x82"; else if (g === "F") gender = "\xE2\x99\x80"; // ♂ / ♀
  }
  FrlgFont.draw("/" + tostring(Pokemon.name(sp) || "") + gender, x0 + 0x80, y0 + 1, { colors: white_text() });
  FrlgFont.draw(RomText.plain("gText_Level") + tostring(tonumber(mon.level) ?? 0), x0 + 0x20, y0 + 0x11,
    { colors: white_text() });
  const tid = tonumber(mon.otId ?? mon.tid ?? HallOfFame._session.trainerId) ?? 0;
  FrlgFont.draw(RomText.plain("gText_IDNumber") + format("%05d", mod(tid, 65536)), x0 + 0x60, y0 + 0x11,
    { colors: white_text() });
}

// pokefirered/src/hall_of_fame.c:1080 HallOfFame_PrintPlayerInfo
// Lua: hall_of_fame.lua:539
function draw_player_info(): void {
  const session = HallOfFame._session || {};
  const win = rse(session) ? PLAYER_WIN_RSE : PLAYER_WIN;
  const ox = win.left * 8, oy = win.top * 8;
  const textWidth = win.width * 8 - 6;
  Window.fill(win, 1, 1, 1, 1);
  Window.stdFrame(win);
  const name = tostring(session.name ?? session.playerName ?? "");
  FrlgFont.draw(RomText.plain("gText_Name"), ox + 4, oy + 3, { colors: gray_text() });
  FrlgFont.draw(name, ox + textWidth - FrlgFont.measure(name), oy + 3, { colors: gray_text() });
  const tid = mod(tonumber(session.trainerId ?? session.playerTrainerId) ?? 0, 65536);
  FrlgFont.draw(RomText.plain("gText_IDNumber"), ox + 4, oy + 18, { colors: gray_text() });
  FrlgFont.draw(format("%05d", tid), ox + textWidth - 30, oy + 18, { colors: gray_text() });
  const h = tonumber(session.playTimeHours ?? session.hours) ?? 0;
  const m = tonumber(session.playTimeMinutes ?? session.minutes) ?? 0;
  FrlgFont.draw(RomText.plain(key(session, "gText_MainMenuTime")), ox + 4, oy + 32, { colors: gray_text() });
  FrlgFont.draw(format("%3d:%02d", mod(h, 1000), mod(m, 100)), ox + textWidth - 36, oy + 32,
    { colors: gray_text() });
}

export const HallOfFame: HallOfFameModule = {
  open: false,
  _session: null,
  _onDone: null,
  _mons: seq(),
  _currentIndex: 1,
  _phase: "idle",
  _timer: 0,

  // Test seam: the induction commit (pret hall_of_fame.c) sets the clear flag, the
  // debut timestamp and the HOF team, then commits the save.
  _commitClearAndSave: commit_clear_and_save,

  // Lua: hall_of_fame.lua:200
  start(opts?: any): void {
    opts = opts || {};
    const session = opts.session || {};
    HallOfFame._session = session;
    HallOfFame._onDone = opts.onDone;
    HallOfFame._dontSave = opts.dontSave === true;
    HallOfFame._warp = opts.warp !== false;
    HallOfFame._credits = opts.credits === true;
    HallOfFame._hasRecords = opts.hasRecords === true;
    HallOfFame.open = true;
    HallOfFame._mons = extract_eligible_mons(session.party);
    HallOfFame._currentIndex = 1;
    HallOfFame._sprites = {};
    HallOfFame._selected = {};
    HallOfFame._dimmed = false;
    HallOfFame._info = null;
    HallOfFame._welcome = false;
    HallOfFame._saving = false;
    HallOfFame._band = 7;
    HallOfFame._bandEva = 16;
    HallOfFame._confetti = [null];
    HallOfFame._player = null;
    HallOfFame._playerInfo = false;
    HallOfFame._national = national_enabled(session);
    HallOfFame._timer = 0;
    HallOfFame._phase = "fadein";
    // pokefirered/src/hall_of_fame.c:344
    begin_fade(16, 0, 0);
    Fade.clear();
    Stack.push("hall_of_fame", HallOfFame, { hideBelow: true, fullscreen: true });
  },

  // pokefirered/src/hall_of_fame.c:699 SetWarpsToRollCredits
  // Lua: hall_of_fame.lua:233
  setWarpsToRollCredits(): boolean {
    // package.loaded["src.core.game3.scripting.space"] / [...runtime]: always loaded here
    const SpaceM: any = Space;
    const game = Runtime && Runtime._game;
    if (!(SpaceM && truthy(SpaceM.store))) throw new Error("SetWarpsToRollCredits: no script space");
    if (!truthy(game)) throw new Error("SetWarpsToRollCredits: no running game");
    const store = SpaceM.store;
    Flags.setVar(store, null, Flags.VAR_IDS.VAR_MAP_SCENE_INDIGO_PLATEAU_EXTERIOR, 1);
    Flags.setFlag(store, null, Flags.IDS.FLAG_DONT_SHOW_MAP_NAME_POPUP, true);
    Map.disableMusicChange = Map.MUSIC_DISABLE_KEEP;
    // pokefirered/src/hall_of_fame.c:704
    Map.load(null, game, "FR_INDIGO_PLATEAU_EXTERIOR", { x: 11, y: 6, facing: "down" });
    const P: any = Player;
    if (P && P.setVisible) P.setVisible(true);
    Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {});
    return true;
  },

  // Lua: hall_of_fame.lua:254
  close(): void {
    if (!HallOfFame.open) return;
    HallOfFame.open = false;
    HallOfFame._phase = "done";
    Stack.pop("hall_of_fame");
    const cb = HallOfFame._onDone;
    HallOfFame._onDone = null;
    if (HallOfFame._credits) {
      // pokeemerald/src/hall_of_fame.c:775
      // NOT FAITHFUL: Emerald only (ui/game3/rse/credits is not part of the FRLG port).
      const RseCredits = G3Lazy["src.ui.game3.rse.credits"];
      if (!RseCredits) throw new NotPortedError("src.ui.game3.rse.credits (Emerald only)");
      RseCredits.start({
        session: HallOfFame._session,
        hasRecords: HallOfFame._hasRecords,
        onDone: cb,
      });
      return;
    }
    if (HallOfFame._warp) {
      HallOfFame.setWarpsToRollCredits();
    }
    if (cb) cb();
  },

  // Lua: hall_of_fame.lua:276
  reset(): void {
    HallOfFame.open = false;
    HallOfFame._phase = "idle";
    HallOfFame._onDone = null;
    HallOfFame._session = null;
    HallOfFame._fade = null;
  },

  // Lua: hall_of_fame.lua:284
  isOpen(): boolean {
    return HallOfFame.open;
  },

  // Lua: hall_of_fame.lua:288
  phase(): string {
    return HallOfFame._phase;
  },

  // Lua: hall_of_fame.lua:292
  getCurrentMon(): any {
    if (!HallOfFame.open) return null;
    return HallOfFame._mons[HallOfFame._currentIndex];
  },

  // Lua: hall_of_fame.lua:458
  update(_dt?: number): void {
    if (!HallOfFame.open) return;
    tick_fade();
    run_phase();
    update_confetti();
  },

  // pokefirered/src/hall_of_fame.c:649 Task_Hof_ExitOnKeyPressed
  // Lua: hall_of_fame.lua:466
  handleInput(inp: any): void {
    if (!HallOfFame.open || !inp) return;
    if (HallOfFame._phase !== "exitwait") return;
    if (inp.wasPressed("a")) {
      audio().fadeOutBgm(4);
      // pokefirered/src/hall_of_fame.c:661
      begin_fade(0, 16, 8);
      HallOfFame._phase = "exit";
    }
  },

  // Lua: hall_of_fame.lua:559
  draw(): void {
    if (!HallOfFame.open) return;
    draw_background();
    for (let i = 1; i <= 6; i++) {
      const s = HallOfFame._sprites![i];
      if (s) {
        draw_mon(s, HallOfFame._dimmed && HallOfFame._selected![i]);
      }
    }
    if (HallOfFame._player) {
      const pic = TrainerPic.front(HallOfFame._player.pic);
      if (pic && pic.image) {
        G.setColor(1, 1, 1, 1);
        G.draw(pic.image, HallOfFame._player.x - 32, HallOfFame._player.y - 32);
      }
    }
    if (HallOfFame._saving) {
      // pokefirered/src/hall_of_fame.c:456
      Window.dialogueFrame();
      Window.printPx(RomText.plain(key(HallOfFame._session, "gText_SavingDontTurnOffThePower2")), 16, 121);
    }
    if (HallOfFame._info) draw_mon_info(HallOfFame._info);
    if (HallOfFame._welcome) {
      // pokefirered/src/hall_of_fame.c:984
      const text = RomText.plain("gText_WelcomeToHOF");
      const x = Math.floor((0xD0 - FrlgFont.measure(text)) / 2);
      FrlgFont.draw(text, 16 + x, 121, { colors: white_text() });
    }
    if (HallOfFame._playerInfo) {
      draw_player_info();
      // pokefirered/src/hall_of_fame.c:642
      Window.dialogueFrame();
      Window.printPx(RomText.plain("gText_LeagueChamp"), 16, 121);
    }
    draw_confetti();
    const f = HallOfFame._fade;
    if (f && f.y > 0) {
      G.setColor(f.color[1]!, f.color[2]!, f.color[3]!, f.y / 16);
      G.rectangle("fill", 0, 0, 240, 160);
      G.setColor(1, 1, 1, 1);
    }
  },
};

export default HallOfFame;
