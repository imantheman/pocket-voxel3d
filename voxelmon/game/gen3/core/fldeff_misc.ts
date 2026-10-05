// Port of gen1recomp src/core/game3/fldeff_misc.lua (GPLv3 + additional terms; see LICENSE.md).
// Miscellaneous field effects (pokeemerald fldeff_misc.c / field_effect.c):
// field-move show-mon wrappers, secret power, PC, sand pillar, balloons,
// note mats, Hall of Fame record, dive / surf / waterfall, sparkle.
//
// Port notes:
// - Lazily required (field_effects handlerFor / package.loaded, Game3 soft
//   reset): registers as G3Lazy["src.core.game3.fldeff_misc"].
// - package.loaded / require of field_effects, player, runtime, space,
//   se_ids, audio, constants, field, field_move_show_mon, mb, collision,
//   trig, task: in the bundle (static imports, loaded).
// - NOT FAITHFUL: Emerald only. src.core.game3.field_effects_rse,
//   src.core.game3.rse.init and src.core.game3.special_scene_rse have no
//   module in this runtime. They are looked up in G3Lazy (by Lua name); when
//   absent, the call that needs one throws "NOT FAITHFUL: Emerald only"
//   where the Lua's require would load the module.
// - facingCell() returns Lua's two values as [x, y].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, len, pairs, seq } from "../platform/lt.ts";
import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { FieldEffects } from "./field_effects.ts";
import { Player as PlayerMod } from "./player.ts";
import { Runtime } from "./runtime.ts";
import { G3Lazy } from "./lazy_registry.ts";
import { Space } from "./scripting/space.ts";
import { SE } from "./se_ids.ts";
import { Audio } from "./audio.ts";
import { Constants } from "./constants.ts";
import { Field } from "./field.ts";
import { ShowMon as ShowMonMod } from "./field_move_show_mon.ts";
import { MB } from "./mb.ts";
import { Collision } from "./collision.ts";
import { Trig } from "./trig.ts";
import { Task } from "./task.ts";

const CELL = 16;

/** An Emerald-only module by Lua name (see the port notes). */
function rseModule(name: string): any {
  const m = G3Lazy[name];
  if (m == null) throw new Error("NOT FAITHFUL: Emerald only: " + name + " is not ported");
  return m;
}

// Lua: fldeff_misc.lua:5
function FE(): any {
  return FieldEffects;
}

// Lua: fldeff_misc.lua:9
function Rse(): any {
  return rseModule("src.core.game3.field_effects_rse");
}

// Lua: fldeff_misc.lua:13
function Player(): any {
  return PlayerMod;
}

// Lua: fldeff_misc.lua:17
function session(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: fldeff_misc.lua:22
function vmCtx(): any {
  // package.loaded["src.core.game3.scripting.space"]
  const S: any = Space;
  return (S && S.vm && S.vm.ctx) || undefined;
}

// Lua: fldeff_misc.lua:27
function playSe(name: string): void {
  const id = (SE as any)[name];
  if (!id) return;
  // pcall(require, "src.core.game3.audio")
  const A: any = Audio;
  if (A && A.playSe) A.playSe(id);
}

// Lua: fldeff_misc.lua:36
function C(): any {
  return Constants.of(Constants.versionOf(session()));
}

// Lua: fldeff_misc.lua:41
function metatile(name: string): any {
  return C().require("metatile_labels", name);
}

// Lua: fldeff_misc.lua:46
function setMetatile(x: number, y: number, name: string, impassable?: boolean): void {
  // package.loaded["src.core.game3.field"]
  const F: any = Field;
  if (F && F.setMetatile) F.setMetatile(x, y, metatile(name), impassable === true);
}

const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// Lua: fldeff_misc.lua:53
function facingCell(): [number, number] {
  const P = Player();
  const d = DELTA[P.facing || "down"] || DELTA.down!;
  return [P.cellX + d[0], P.cellY + d[1]];
}

// Lua: fldeff_misc.lua:62
function begin(name: string): object {
  const ctx = vmCtx();
  const token = {};
  FldeffMisc._active[name] = token;
  if (ctx) {
    ctx.stateWait = () => FldeffMisc._active[name] !== token;
  }
  return token;
}

// Lua: fldeff_misc.lua:72
function finish(name: string, token?: object): void {
  if (token == null || FldeffMisc._active[name] === token) delete FldeffMisc._active[name];
}

// Lua: fldeff_misc.lua:80
function partyMon(idx: any): any {
  const s = session();
  const party = s && s.party;
  return (party && party[(tonumber(idx) ?? 0) + 1]) || (party && party[1]);
}

// Lua: fldeff_misc.lua:87
// pokeemerald/src/field_effect.c:2570
function showMon(onDone: () => void, opts?: { noPose?: boolean; noDuck?: boolean }): void {
  const mon = partyMon(FE().fieldEffectArgument(0, 0));
  // pcall(require, "src.core.game3.field_move_show_mon")
  const ShowMon: any = ShowMonMod;
  if (ShowMon && ShowMon.start && mon) {
    ShowMon.start(mon, { pose: !(opts && opts.noPose), noDuck: opts && opts.noDuck }, onDone);
  } else {
    onDone();
  }
}

// Lua: fldeff_misc.lua:98
function fieldMove(name: string, se: string | undefined, after?: () => void): () => boolean {
  return () => {
    const token = begin(name);
    showMon(() => {
      if (se) playSe(se);
      if (after) after();
      finish(name, token);
    });
    return true;
  };
}

// Lua: fldeff_misc.lua:111
// pokeemerald/src/fldeff_misc.c:547
function secretPower(useName: string, sheet: string, se: string, toggleAt: number): () => boolean {
  return () => {
    const token = begin(useName);
    showMon(() => {
      const [fx, fy] = facingCell();
      let anim = 1;
      if (sheet === "secret_power_tree") {
        // package.loaded["src.core.game3.collision"]
        const Col: any = Collision;
        const b = Col && Col.behavior && Col.behavior(fx, fy);
        // pokeemerald/src/fldeff_misc.c:672
        if (b === MB.id("SECRET_BASE_SPOT_TREE_RIGHT")) anim = 3;
      }
      playSe(se);
      let toggled = false;
      Rse().spawn(sheet, {
        anim, layer: "front", x: fx * CELL + 8, y: fy * CELL + 8,
        stopOnEnd: false,
        onStep: (e: any) => {
          if (!toggled && e.timer >= toggleAt) {
            toggled = true;
            rseModule("src.core.game3.rse.init").call("secretBase", "toggleEntrance", "ToggleSecretBaseEntranceMetatile",
              undefined, fx, fy);
          }
          return e.timer >= 40;
        },
        onDone: () => { finish(useName, token); },
      });
    });
    return true;
  };
}

// pokeemerald/src/fldeff_misc.c:954
const NOTES: Record<string, string> = {
  METATILE_SecretBase_NoteMat_C_Low: "SE_NOTE_C", METATILE_SecretBase_NoteMat_D: "SE_NOTE_D",
  METATILE_SecretBase_NoteMat_E: "SE_NOTE_E", METATILE_SecretBase_NoteMat_F: "SE_NOTE_F",
  METATILE_SecretBase_NoteMat_G: "SE_NOTE_G", METATILE_SecretBase_NoteMat_A: "SE_NOTE_A",
  METATILE_SecretBase_NoteMat_B: "SE_NOTE_B", METATILE_SecretBase_NoteMat_C_High: "SE_NOTE_C_HIGH",
};

// Lua: fldeff_misc.lua:372
// pokeemerald/src/field_effect.c:1902
function useDive(): boolean {
  const name = "FLDEFF_USE_DIVE";
  const token = begin(name);
  showMon(() => {
    rseModule("src.core.game3.rse.init").call("dive", "start", "FldEff_UseDive", undefined,
      FE().fieldEffectArgument(1, 0));
    finish(name, token);
  });
  return true;
}

// Lua: fldeff_misc.lua:384
// pokeemerald/src/field_effect.c:2985
function useSurf(): boolean {
  // package.loaded["src.core.game3.field"]
  const F: any = Field;
  if (F) F.locked = true;
  // pcall(require, "src.core.game3.audio")
  const A: any = Audio;
  if (A && A.startSurfMusic) A.startSurfMusic();
  showMon(() => {
    const rt: any = Runtime;
    Player().startSurfing(rt && rt._game, () => {
      if (F) F.locked = false;
    });
  }, { noDuck: true });
  return true;
}

// Lua: fldeff_misc.lua:399
// pokeemerald/src/field_effect.c:1828
function useWaterfall(): boolean {
  showMon(() => {
    const F: any = Field;
    if (F && F.rideWaterfall) F.rideWaterfall("up", 0);
  }, { noPose: true });
  return true;
}

// Lua: fldeff_misc.lua:408
// pokeemerald/src/field_effect_helpers.c:1417
function sparkle(): boolean {
  const fe = FE();
  const name = "FLDEFF_SPARKLE";
  const token = {};
  FldeffMisc._active[name] = token;
  Rse().startSparkle(fe.fieldEffectArgument(0, 0), fe.fieldEffectArgument(1, 0), () => { finish(name, token); });
  return true;
}

export const FldeffMisc = {
  // Lua: fldeff_misc.lua:34
  playSe,
  // Lua: fldeff_misc.lua:44
  metatile,
  // Lua: fldeff_misc.lua:58
  facingCell,

  _active: {} as Record<string, object | undefined>,

  // Lua: fldeff_misc.lua:76
  isActive(name: string): boolean {
    return FldeffMisc._active[name] != null;
  },

  // Lua: fldeff_misc.lua:96
  showMon,

  // Lua: fldeff_misc.lua:145
  // pokeemerald/src/field_effect.c:3118
  npcFlyOut(): boolean {
    const name = "FLDEFF_NPCFLY_OUT";
    const sheet = FE().loadSheet("bird");
    const P = Player();
    const token = {};
    FldeffMisc._active[name] = token;
    playSe("SE_M_FLY");
    const SINE = Trig.SINE;
    const rec = Rse().spawn("bird", {
      layer: "front", stopOnEnd: false, effectName: name,
      onStep: (e: any) => {
        const d = e.d || 0;
        const ox = P ? P.px - 112 : 0;
        const oy = P ? P.py - 72 : 0;
        e.x = ox + 120 + Math.floor(140 * SINE[mod(d + 64, 256) + 1]! / 256);
        e.y = oy + Math.floor(72 * SINE[mod(d, 256) + 1]! / 256);
        e.d = d + 4;
        return d >= 0x80;
      },
      onDone: () => { finish(name, token); },
    });
    if (!(sheet && rec)) finish(name, token);
    return true;
  },

  // Lua: fldeff_misc.lua:171
  // pokeemerald/src/fldeff_misc.c:788
  pcTurnOn(): boolean {
    const name = "FLDEFF_PCTURN_ON";
    const token = begin(name);
    const [x, y] = facingCell();
    let state = 0;
    Task.spawn(() => {
      if (state === 4 || state === 12) {
        setMetatile(x, y, "METATILE_SecretBase_PC_On");
      } else if (state === 8 || state === 16) {
        setMetatile(x, y, "METATILE_SecretBase_PC");
      } else if (state === 20) {
        setMetatile(x, y, "METATILE_SecretBase_PC_On");
        finish(name, token);
        return true;
      }
      state = state + 1;
      return false;
    });
    return true;
  },

  // Lua: fldeff_misc.lua:194
  // pokeemerald/src/fldeff_misc.c:835
  pcTurnOff(currentSecretBase?: boolean): void {
    const [x, y] = facingCell();
    playSe("SE_PC_OFF");
    setMetatile(x, y, currentSecretBase ? "METATILE_SecretBase_RegisterPC" : "METATILE_SecretBase_PC", true);
  },

  // Lua: fldeff_misc.lua:201
  // pokeemerald/src/fldeff_misc.c:1033
  sandPillar(): boolean {
    const name = "FLDEFF_SAND_PILLAR";
    const token = begin(name);
    const P = Player();
    const [x, y] = facingCell();
    // package.loaded["src.core.game3.field"]
    const lock: any = Field;
    if (lock) lock.locked = true;
    // pokeemerald/src/fldeff_misc.c:1043
    const off = ({ down: [8, 32], up: [8, 0], left: [-8, 16], right: [24, 16] } as Record<string, [number, number]>)[P.facing || "down"]!;
    const sx = P.px + off[0];
    const sy = P.py - 16 + off[1];
    let stage = 0;
    Rse().spawn("sand_pillar", {
      layer: P.facing === "down" ? "front" : "actor", x: sx, y: sy, stopOnEnd: false,
      effectName: name,
      onStep: (e: any) => {
        if (stage === 0 && e.a.ended) {
          // pokeemerald/src/fldeff_misc.c:1081
          playSe("SE_M_ROCK_THROW");
          const top = FldeffMisc.metatileAt(x, y - 1);
          if (top === metatile("METATILE_SecretBase_SandOrnament_TopWall")) {
            setMetatile(x, y - 1, "METATILE_SecretBase_Wall_TopMid", true);
          } else {
            setMetatile(x, y - 1, "METATILE_SecretBase_SandOrnament_BrokenTop");
          }
          setMetatile(x, y, "METATILE_SecretBase_Ground");
          stage = 1;
          e.wait = 0;
          return false;
        } else if (stage === 1) {
          e.wait = e.wait + 1;
          if (e.wait >= 18) {
            setMetatile(x, y, "METATILE_SecretBase_SandOrnament_BrokenBase", true);
            return true;
          }
        }
        return false;
      },
      onDone: () => {
        if (lock) lock.locked = false;
        finish(name, token);
      },
    });
    return true;
  },

  // Lua: fldeff_misc.lua:246
  metatileAt(x: number, y: number): any {
    // package.loaded["src.core.game3.collision"]
    const Col: any = Collision;
    const def = Col && Col._mapDef;
    const layout = def && def.midLayout;
    if (!(layout && layout.midAt)) return undefined;
    return layout.midAt(x, y);
  },

  // Lua: fldeff_misc.lua:255
  // pokeemerald/src/fldeff_misc.c:850
  popBalloon(metatileId: number, x: number, y: number): void {
    let t = 0, step = 1;
    const sounds: Record<number, string> = {
      [metatile("METATILE_SecretBase_RedBalloon")]: "SE_BALLOON_RED",
      [metatile("METATILE_SecretBase_BlueBalloon")]: "SE_BALLOON_BLUE",
      [metatile("METATILE_SecretBase_YellowBalloon")]: "SE_BALLOON_YELLOW",
      [metatile("METATILE_SecretBase_MudBall")]: "SE_MUD_BALL",
    };
    Task.spawn(() => {
      if (t === 6) t = 0; else t = t + 1;
      if (t === 0) {
        if (step === 2 && sounds[metatileId]) playSe(sounds[metatileId]!);
        // package.loaded["src.core.game3.field"]
        const F: any = Field;
        if (F && F.setMetatile) F.setMetatile(x, y, metatileId + step, false);
        if (step === 3) return true;
        step = step + 1;
      }
      return false;
    });
  },

  // Lua: fldeff_misc.lua:278
  // pokeemerald/src/fldeff_misc.c:936
  shatterBreakableDoor(x: number, y: number): void {
    const shatter = (): void => {
      playSe("SE_BREAKABLE_DOOR");
      setMetatile(x, y, "METATILE_SecretBase_BreakableDoor_BottomOpen");
      setMetatile(x, y - 1, "METATILE_SecretBase_BreakableDoor_TopOpen");
    };
    const dir = Player().facing;
    if (dir === "down") {
      shatter();
    } else if (dir === "up") {
      let n = 0;
      Task.spawn(() => {
        if (n === 7) {
          shatter();
          return true;
        }
        n = n + 1;
        return false;
      });
    }
  },

  // Lua: fldeff_misc.lua:308
  musicNoteMat(metatileId: number): void {
    let n = 0;
    Task.spawn(() => {
      if (n === 7) {
        for (const [label, se] of pairs(NOTES)) {
          if (metatile(label as string) === metatileId) playSe(se);
        }
        return true;
      }
      n = n + 1;
      return false;
    });
  },

  // Lua: fldeff_misc.lua:323
  // pokeemerald/src/fldeff_misc.c:1014
  glitterMatSparkle(): void {
    const P = Player();
    Rse().spawnAt("sparkle", P.cellX, P.cellY, 8, 4, {
      layer: "front", stopOnEnd: false,
      onStep: (e: any) => {
        if (e.timer === 8) playSe("SE_M_HEAL_BELL");
        return e.timer >= 32;
      },
    });
  },

  // Lua: fldeff_misc.lua:335
  // pokeemerald/src/field_effect.c:1066
  hallOfFameRecord(): boolean {
    const name = "FLDEFF_HALL_OF_FAME_RECORD";
    const token = {};
    FldeffMisc._active[name] = token;
    const s = session();
    let n = 0;
    for (const [, mon] of pairs((s && s.party) || {})) { if (mon) n = n + 1; }
    const P = Player();
    const ox = P ? P.px - 112 : 0, oy = P ? P.py - 72 : 0;
    const balls: any = seq();
    // pokeemerald/src/field_effect.c:597
    const OFFS = seq(seq(0, 0), seq(6, 0), seq(0, 4), seq(6, 4), seq(0, 8), seq(6, 8));
    let t = 0;
    Task.spawn(() => {
      t = t + 1;
      const placed = Math.min(n, Math.floor((t - 1) / 25) + 1);
      for (let i = len(balls) + 1; i <= placed; i++) {
        // pokeemerald/src/field_effect.c:1156
        playSe("SE_BALL");
        const o = OFFS[i] || OFFS[1]!;
        balls[i] = Rse().spawn("pokeball_glow", {
          layer: "front", x: ox + 117 + o[1]! + 4, y: oy + 52 + o[2]! + 4,
          stopOnEnd: false, keep: () => FldeffMisc._active[name] === token,
        });
      }
      if (t === n * 25 + 32) {
        for (const [, b] of ipairs<any>(balls)) { if (b) b.a = Rse().anim(Rse().animCmds("pokeball_glow", 2)); }
      }
      if (t >= n * 25 + 150) {
        finish(name, token);
        return true;
      }
      return false;
    });
    return true;
  },

  // Lua: fldeff_misc.lua:417
  HANDLERS: {
    // pokeemerald/src/fldeff_cut.c:640
    FLDEFF_USE_CUT_ON_TREE: fieldMove("FLDEFF_USE_CUT_ON_TREE", "SE_M_CUT"),
    // pokeemerald/src/fldeff_rocksmash.c:161
    FLDEFF_USE_ROCK_SMASH: fieldMove("FLDEFF_USE_ROCK_SMASH", "SE_M_ROCK_THROW"),
    // pokeemerald/src/fldeff_strength.c:46
    FLDEFF_USE_STRENGTH: fieldMove("FLDEFF_USE_STRENGTH", undefined),
    FLDEFF_USE_SURF: useSurf,
    FLDEFF_USE_WATERFALL: useWaterfall,
    FLDEFF_USE_DIVE: useDive,
    // pokeemerald/src/fldeff_misc.c:602
    FLDEFF_USE_SECRET_POWER_CAVE: secretPower("FLDEFF_USE_SECRET_POWER_CAVE", "secret_power_cave", "SE_M_ROCK_THROW", 20),
    // pokeemerald/src/fldeff_misc.c:652
    FLDEFF_USE_SECRET_POWER_TREE: secretPower("FLDEFF_USE_SECRET_POWER_TREE", "secret_power_tree", "SE_M_SCRATCH", 40),
    // pokeemerald/src/fldeff_misc.c:726
    FLDEFF_USE_SECRET_POWER_SHRUB: secretPower("FLDEFF_USE_SECRET_POWER_SHRUB", "secret_power_shrub",
      "SE_M_POISON_POWDER", 20),
    FLDEFF_NPCFLY_OUT: (): boolean => FldeffMisc.npcFlyOut(),
    FLDEFF_PCTURN_ON: (): boolean => FldeffMisc.pcTurnOn(),
    FLDEFF_SAND_PILLAR: (): boolean => FldeffMisc.sandPillar(),
    FLDEFF_HALL_OF_FAME_RECORD: (): boolean => FldeffMisc.hallOfFameRecord(),
    FLDEFF_SPARKLE: sparkle,
    // pokeemerald/src/field_effect_helpers.c:892
    FLDEFF_WATER_SURFACING: (): boolean => {
      const fe = FE();
      return Rse().startWaterSurfacing(fe.fieldEffectArgument(0, 0), fe.fieldEffectArgument(1, 0)) != null;
    },
    // pokeemerald/src/field_effect.c:3081
    FLDEFF_RAYQUAZA_SPOTLIGHT: (): boolean => {
      return rseModule("src.core.game3.special_scene_rse").startRayquazaSpotlight() != null;
    },
  } as Record<string, () => boolean>,

  // Lua: fldeff_misc.lua:450
  reset(): void {
    FldeffMisc._active = {};
  },
};

G3Lazy["src.core.game3.fldeff_misc"] = FldeffMisc;

export default FldeffMisc;
