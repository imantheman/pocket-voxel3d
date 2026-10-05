// Port of gen1recomp src/core/game3/braille_field.lua (GPLv3 + additional terms; see LICENSE.md).
// The Hoenn braille puzzles (pokeemerald/src/braille_puzzles.c): Sealed
// Chamber dig, Regirock / Registeel / Regice. Every map here is Emerald's,
// and the module's flag/var/session access goes through src.core.game3.rse.init.
//
// Return shapes: playerPos -> [x, y]; the BY_NAME specials -> [stop, value].

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { ipairs, seq, type LuaTable } from "../platform/lt.ts";
import { Player as PlayerMod } from "./player.ts";
import { Field as FieldMod } from "./field.ts";
import { Constants } from "./constants.ts";
import { SE } from "./se_ids.ts";
import { Audio } from "./audio.ts";
import { FieldView } from "./field_view.ts";
import { Task } from "./task.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: braille_field.lua:3
function Rse(): any {
  // NOT FAITHFUL: Emerald only -- src.core.game3.rse.init is not ported.
  throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.init");
}

// Lua: braille_field.lua:7
function session(): any {
  return Rse().session();
}

// Lua: braille_field.lua:19
function playerPos(s?: any): [number, number] {
  const P: any = PlayerMod;
  if (P && P.cellX != null) return [P.cellX, P.cellY];
  s = s ?? session();
  return [s ? s.x ?? 0 : 0, s ? s.y ?? 0 : 0];
}

// Lua: braille_field.lua:26
function onMap(name: string, s?: any): boolean {
  s = s ?? session();
  return s != null && s.map === name;
}

// Lua: braille_field.lua:31
function setMetatile(x: number, y: number, label: string, impassable?: boolean): void {
  const Field: any = FieldMod;
  const C = Constants.of(Constants.versionOf(session()));
  Field.setMetatile(x, y, C.require("metatile_labels", label), impassable === true);
}

// Lua: braille_field.lua:38
function playSe(name: string): void {
  const S: any = SE;
  if (Audio && Audio.playSe && S[name]) Audio.playSe(S[name]);
}

// Lua: braille_field.lua:45 -- pokeemerald/src/braille_puzzles.c:78
function openEntrance(x0: number, y0: number): void {
  setMetatile(x0, y0, "METATILE_Cave_SealedChamberEntrance_TopLeft");
  setMetatile(x0 + 1, y0, "METATILE_Cave_SealedChamberEntrance_TopMid");
  setMetatile(x0 + 2, y0, "METATILE_Cave_SealedChamberEntrance_TopRight");
  setMetatile(x0, y0 + 1, "METATILE_Cave_SealedChamberEntrance_BottomLeft", true);
  setMetatile(x0 + 1, y0 + 1, "METATILE_Cave_SealedChamberEntrance_BottomMid");
  setMetatile(x0 + 2, y0 + 1, "METATILE_Cave_SealedChamberEntrance_BottomRight", true);
  playSe("SE_BANG");
}

// Lua: braille_field.lua:169
function shakeSpecial(long: boolean): (ctx: any) => boolean {
  return (ctx: any): boolean => {
    let finished = false;
    BrailleField.shake(long, () => { finished = true; });
    ctx.stateWait = () => finished;
    return false;
  };
}

export const BrailleField = {
  // Lua: braille_field.lua:12 -- pokeemerald/src/braille_puzzles.c:17
  REGICE_PATH: seq(
    seq(4, 21), seq(5, 21), seq(6, 21), seq(7, 21), seq(8, 21), seq(9, 21), seq(10, 21), seq(11, 21), seq(12, 21),
    seq(12, 22), seq(12, 23), seq(13, 23), seq(13, 24), seq(13, 25), seq(13, 26), seq(13, 27), seq(12, 27), seq(12, 28),
    seq(4, 29), seq(5, 29), seq(6, 29), seq(7, 29), seq(8, 29), seq(9, 29), seq(10, 29), seq(11, 29), seq(12, 29),
    seq(4, 28), seq(4, 27), seq(3, 27), seq(3, 26), seq(3, 25), seq(3, 24), seq(3, 23), seq(4, 23), seq(4, 22),
  ) as LuaTable,

  isRegisteel: false,

  // Lua: braille_field.lua:56 -- pokeemerald/src/braille_puzzles.c:61
  shouldDoDig(s?: any): boolean {
    if (Rse().flag("FLAG_SYS_BRAILLE_DIG", s) || !onMap("EM_SEALED_CHAMBER_OUTER_ROOM", s)) return false;
    const [x, y] = playerPos(s);
    return y === 3 && (x === 9 || x === 10 || x === 11);
  },

  // Lua: braille_field.lua:63 -- pokeemerald/src/braille_puzzles.c:78
  doDig(s?: any): void {
    openEntrance(9, 1);
    Rse().setFlag("FLAG_SYS_BRAILLE_DIG", true, s);
  },

  // Lua: braille_field.lua:69 -- pokeemerald/src/braille_puzzles.c:92
  checkRelicanthWailord(s?: any): boolean {
    s = s ?? session();
    const party = (s && s.party) || [null];
    const C = Constants.of(Constants.versionOf(s));
    const speciesOf = (mon: any): number => {
      if (!mon) return 0;
      if (mon.isEgg) return C.require("species", "SPECIES_EGG");
      return tonumber(mon.species) ?? 0;
    };
    let n = 0;
    for (let i = 1; i <= 6; i++) { if (party[i]) n = i; }
    if (n === 0) return false;
    return speciesOf(party[1]) === C.require("species", "SPECIES_WAILORD")
      && speciesOf(party[n]) === C.require("species", "SPECIES_RELICANTH");
  },

  // Lua: braille_field.lua:87 -- pokeemerald/src/braille_puzzles.c:141
  shake(long: boolean, done?: () => void): void {
    let delayCounter = 0, shakes = 0;
    let pan = long ? 2 : 3;
    const delay = 5, total = long ? 50 : 2;
    Task.spawn(() => {
      delayCounter = delayCounter + 1;
      if (mod(delayCounter, delay) === 0) {
        delayCounter = 0;
        shakes = shakes + 1;
        pan = -pan;
        FieldView.setCameraPanning(0, pan);
        if (shakes === total) {
          FieldView.setCameraPanning(0, 0);
          if (done) done();
          return true;
        }
      }
      return false;
    });
  },

  // Lua: braille_field.lua:110 -- pokeemerald/src/braille_puzzles.c:167
  shouldDoRegirock(s?: any): boolean {
    if (Rse().flag("FLAG_SYS_REGIROCK_PUZZLE_COMPLETED", s) || !onMap("EM_DESERT_RUINS", s)) return false;
    const [x, y] = playerPos(s);
    if (y === 23 && (x === 5 || x === 6 || x === 7)) {
      BrailleField.isRegisteel = false;
      return true;
    }
    return false;
  },

  // Lua: braille_field.lua:121 -- pokeemerald/src/braille_puzzles.c:219
  shouldDoRegisteel(s?: any): boolean {
    if (Rse().flag("FLAG_SYS_REGISTEEL_PUZZLE_COMPLETED", s) || !onMap("EM_ANCIENT_TOMB", s)) return false;
    const [x, y] = playerPos(s);
    if (x === 8 && y === 25) {
      BrailleField.isRegisteel = true;
      return true;
    }
    return false;
  },

  // Lua: braille_field.lua:132 -- pokeemerald/src/braille_puzzles.c:205
  doRegiEffect(s?: any): void {
    openEntrance(7, 19);
    Rse().setFlag(BrailleField.isRegisteel ? "FLAG_SYS_REGISTEEL_PUZZLE_COMPLETED"
      : "FLAG_SYS_REGIROCK_PUZZLE_COMPLETED", true, s);
  },

  // Lua: braille_field.lua:139 -- pokeemerald/src/braille_puzzles.c:283
  shouldDoRegicePuzzle(s?: any): boolean {
    s = s ?? session();
    if (!onMap("EM_ISLAND_CAVE", s)) return false;
    const R = Rse();
    if (R.flag("FLAG_SYS_BRAILLE_REGICE_COMPLETED", s)) return false;
    if (!R.flag("FLAG_TEMP_REGICE_PUZZLE_STARTED", s)) return false;
    if (R.flag("FLAG_TEMP_REGICE_PUZZLE_FAILED", s)) return false;
    const [x, y] = playerPos(s);
    for (const [i, c] of ipairs<any>(BrailleField.REGICE_PATH)) {
      if (c[1] === x && c[2] === y) {
        const k = i - 1;
        let v_: string, bit: number;
        if (k < 16) { v_ = "VAR_REGICE_STEPS_1"; bit = k; }
        else if (k < 32) { v_ = "VAR_REGICE_STEPS_2"; bit = k - 16; }
        else { v_ = "VAR_REGICE_STEPS_3"; bit = k - 32; }
        let v = R.var(v_, s);
        if (mod(Math.floor(v / 2 ** bit), 2) === 0) v = v + 2 ** bit;
        R.setVar(v_, v, s);
        if (R.var("VAR_REGICE_STEPS_1", s) !== 0xFFFF || R.var("VAR_REGICE_STEPS_2", s) !== 0xFFFF
          || R.var("VAR_REGICE_STEPS_3", s) !== 0xF) {
          return false;
        }
        return x === 8 && y === 21;
      }
    }
    R.setFlag("FLAG_TEMP_REGICE_PUZZLE_FAILED", true, s);
    R.setFlag("FLAG_TEMP_REGICE_PUZZLE_STARTED", false, s);
    return false;
  },

  // Lua: braille_field.lua:178
  BY_NAME: {
    // pokeemerald/src/braille_puzzles.c:92
    CheckRelicanthWailord: (ctx: any): [boolean, number] => {
      const v = BrailleField.checkRelicanthWailord() ? 1 : 0;
      Rse().setSpecialVar(ctx, 0x800D, v);
      return [false, v];
    },
    // pokeemerald/src/braille_puzzles.c:107
    ShouldDoBrailleRegirockEffectOld: (): boolean => false,
    // pokeemerald/src/braille_puzzles.c:117
    DoSealedChamberShakingEffect_Long: shakeSpecial(true),
    // pokeemerald/src/braille_puzzles.c:129
    DoSealedChamberShakingEffect_Short: shakeSpecial(false),
    ShouldDoBrailleRegicePuzzle: (ctx: any): [boolean, number] => {
      const v = BrailleField.shouldDoRegicePuzzle() ? 1 : 0;
      Rse().setSpecialVar(ctx, 0x800D, v);
      return [false, v];
    },
  } as Record<string, (...a: any[]) => any>,
};

export default BrailleField;
