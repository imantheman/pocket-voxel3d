// Port of gen1recomp src/core/game3/battle/evo_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Post-win evolution presentation (pret TryEvolvePokemon).
// Handles headless fast-path and visual EvolutionScene chaining.
//
// Port notes:
// - pcall(require, "src.ui.game3.evolution_scene") / audio: linked in;
//   pcall(EvolutionScene.start, ...) is a try/catch.
// - print -> console.log.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { NotPortedError } from "../../notported.ts";
import Evolution from "../evolution.ts";
import LearnMove from "./learn_move.ts";
import Pokemon from "../pokemon.ts";
import RomText from "../rom_text.ts";
import Audio from "../audio.ts";
import EvolutionScene from "../../ui/evolution_scene.ts";

type Fn = (...a: any[]) => any;

export interface EvoSeqModule {
  _steps: LuaTable | null | undefined;
  _i: number;
  _waiting: boolean;
  _pushMsg: Fn | null | undefined;
  _askYesNo: Fn | null | undefined;
  _askForget: Fn | null | undefined;
  _headless: boolean;
  _session: any;
  _onDone?: Fn | null;
  reset(): void;
  busy(): boolean;
  begin(pending: LuaTable | null | undefined, opts?: any): boolean;
  update(): boolean;
}

export const EvoSeq = {} as EvoSeqModule;

EvoSeq._steps = undefined;
EvoSeq._i = 1;
EvoSeq._waiting = false;
EvoSeq._pushMsg = undefined;
EvoSeq._askYesNo = undefined;
EvoSeq._askForget = undefined;
EvoSeq._headless = false;
EvoSeq._session = undefined;

/** `EvolutionScene and EvolutionScene.isOpen and EvolutionScene.isOpen()`. */
function scene_open(): boolean {
  const M: any = EvolutionScene;
  if (!truthy(M) || !truthy(M.isOpen)) return false;
  try {
    return truthy(M.isOpen());
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Lua: evo_seq.lua:20
EvoSeq.reset = function (): void {
  EvoSeq._steps = undefined;
  EvoSeq._i = 1;
  EvoSeq._waiting = false;
  EvoSeq._pushMsg = undefined;
  EvoSeq._session = undefined;
  LearnMove.reset();
};

// Lua: evo_seq.lua:29
EvoSeq.busy = function (): boolean {
  if (scene_open()) {
    return true;
  }
  return EvoSeq._steps != null || LearnMove.busy();
};

// Lua: evo_seq.lua:37
function finish(): void {
  const cb = EvoSeq._onDone;
  EvoSeq._steps = undefined;
  EvoSeq._i = 1;
  EvoSeq._waiting = false;
  EvoSeq._onDone = undefined;
  if (truthy(cb)) cb!();
}

// Lua: evo_seq.lua:46
function advance(): void {
  EvoSeq._waiting = false;
  EvoSeq._i = EvoSeq._i + 1;
}

/** pending: Evolution.pending() results */
// Lua: evo_seq.lua:52
EvoSeq.begin = function (pending: LuaTable | null | undefined, opts?: any): boolean {
  opts = opts ?? {};
  EvoSeq.reset();
  EvoSeq._pushMsg = opts.pushMsg;
  EvoSeq._askYesNo = opts.askYesNo;
  EvoSeq._askForget = opts.askForget;
  EvoSeq._headless = truthy(opts.headless) ? true : false;
  EvoSeq._session = opts.session;
  EvoSeq._onDone = opts.onDone;

  const steps: LuaTable = [null];
  for (const [, entry] of ipairs(pending ?? [null])) {
    steps[len(steps) + 1] = entry;
  }

  if (len(steps) === 0) {
    finish();
    return false;
  }
  EvoSeq._steps = steps;
  EvoSeq._i = 1;
  return true;
};

// Lua: evo_seq.lua:76
function run_step(entry: any): void {
  if (!truthy(entry)) {
    finish();
    return;
  }

  const mon = entry.mon;
  const toSpecies = truthy(entry.toSpecies) ? entry.toSpecies : entry.target;
  const fromName = Pokemon.displayMonName(mon);
  const intoName = Pokemon.name(toSpecies);

  if (EvoSeq._headless) {
    if (truthy(EvoSeq._pushMsg)) {
      // src/evolution_scene.c:678
      EvoSeq._pushMsg!(RomText.ascii("gText_PkmnIsEvolving", { stringVars: seq(fromName) }));
    }
    Evolution.apply(mon, toSpecies, EvoSeq._session);
    if (truthy(EvoSeq._pushMsg)) {
      // src/evolution_scene.c:775
      EvoSeq._pushMsg!(RomText.ascii("gText_CongratsPkmnEvolved", { stringVars: seq(fromName, intoName) }));
    }
    const lv = tonumber(truthy(mon) ? mon.level : undefined) ?? 1;
    EvoSeq._waiting = true;
    const started = LearnMove.beginQueue(mon, seq(lv), {
      displayName: Pokemon.displayMonName(mon),
      pushMsg: EvoSeq._pushMsg,
      askYesNo: EvoSeq._askYesNo,
      askForget: EvoSeq._askForget,
      headless: true,
      // src/evolution_scene.c:869
      battleText: true,
      onDone: () => {
        advance();
      },
    });
    if (!started) {
      advance();
    }
    return;
  }

  // Visual mode: launch dedicated EvolutionScene
  const ES: any = EvolutionScene;
  if (truthy(ES) && truthy(ES.start)) {
    const victorySong = (truthy(Audio._currentSong) ? Audio._currentSong.id : undefined) || Audio.role("victoryWild") || 311;
    EvoSeq._waiting = true;
    let advanced = false;
    const advanceOnce = (): void => {
      if (advanced) return;
      advanced = true;
      advance();
    };
    let okStart = true, startErr: any;
    try {
      ES.start(mon, toSpecies, {
        canStop: true,
        headless: EvoSeq._headless,
        session: EvoSeq._session,
        isBattle: true,
        savedSong: victorySong,
        onDone: (_result: any) => {
          advanceOnce();
        },
      });
    } catch (e) {
      okStart = false;
      startErr = e instanceof Error ? e.message : e;
    }
    if (!okStart) {
      ES.open = false;
      ES._onDone = undefined;
    }
    if (!okStart || !scene_open()) {
      console.log("[game3/evo] evolution scene failed to open: "
        + tostring(truthy(startErr) ? startErr : "no layer pushed"));
      if (truthy(mon) && mon.species !== toSpecies) {
        Evolution.apply(mon, toSpecies, EvoSeq._session);
      }
      advanceOnce();
    }
  } else {
    // Fallback
    Evolution.apply(mon, toSpecies, EvoSeq._session);
    advance();
  }
}

// Lua: evo_seq.lua:158
EvoSeq.update = function (): boolean {
  if (scene_open()) {
    return false;
  }

  if (LearnMove.busy()) {
    LearnMove.pump();
    return false;
  }

  if (!truthy(EvoSeq._steps)) return true;

  if (EvoSeq._waiting) {
    return false;
  }

  const entry = EvoSeq._steps![EvoSeq._i];
  if (!truthy(entry)) {
    finish();
    return true;
  }

  run_step(entry);
  return false;
};

export default EvoSeq;
