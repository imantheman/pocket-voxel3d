// Port of gen1recomp src/ui/game3/whiteout_rush.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_screen_effect.c:387 Task_RushInjuredPokemonToCenter
//
// Lua's `package.loaded["src.X"]` / lazy `require("src.X")` become the static
// imports below; Brian's `X and X.f` guards are kept.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { truthy } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { Stack } from "./stack.ts";
import { FrlgFont as Font } from "./frlg_font.ts";
import { Fade } from "./fade.ts";
import { Display } from "../core/display.ts";
import { RomText } from "../core/rom_text.ts";
import { Audio } from "../core/audio.ts";
import { Field } from "../core/field.ts";
import { Space } from "../core/scripting/space.ts";
import { Renderer } from "../shared/render/Renderer.ts";

export interface RushState {
  phase: "hold" | "print" | "wait";
  frames: number;
  text: string;
  total: number;
  shown: number;
  home: boolean;
  healerLocalId: unknown;
  game: any;
}

export interface RushOpts { home?: unknown; healerLocalId?: unknown }

// Lua: whiteout_rush.lua:15
function stopMusic(): void {
  if (Audio.currentSong && truthy(Audio.currentSong())) Audio.playSong(0);
}

// Lua: whiteout_rush.lua:55
function finish(): void {
  const st = Rush._state!;
  Rush._state = undefined;
  Stack.pop(Rush.ID);
  // pokefirered/src/field_screen_effect.c:434
  Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {
    if (!(Space && Space.startScript)) return;
    // pokefirered/src/field_screen_effect.c:441
    const key = st.home ? "EventScript_AfterWhiteOutMomHeal" : "EventScript_AfterWhiteOutHeal";
    Space.startScript(key, st.healerLocalId);
  });
}

export const Rush = {
  ID: "whiteout_rush",
  // pokefirered/src/overworld.c:1549
  HOLD_FRAMES: 120,
  _state: undefined as RushState | undefined,

  // Lua: whiteout_rush.lua:20
  start(game: any, session: any, opts?: RushOpts | null): void {
    opts = opts || {};
    // Lua `or`: only nil/false fall through ("" is a name).
    let name: any = truthy(session) ? (truthy(session.name) ? session.name : session.playerName) : undefined;
    if (!truthy(name)) name = "";
    // pokefirered/src/field_screen_effect.c:414, :421
    const key = truthy(opts.home) ? "gText_PlayerScurriedBackHome" : "gText_PlayerScurriedToCenter";
    const text = RomText.plain(key, { playerName: name });
    Rush._state = {
      phase: "hold",
      frames: 0,
      text,
      total: Font.countChars(text),
      shown: 0,
      home: truthy(opts.home) ? true : false,
      healerLocalId: opts.healerLocalId,
      game,
    };
    if (Field && Field.lock) Field.lock();
    // pokefirered/src/overworld.c:1552
    stopMusic();
    Stack.push(Rush.ID, Rush, { hideBelow: true, fullscreen: true });
  },

  // Lua: whiteout_rush.lua:43
  isActive(): boolean {
    return Rush._state != null;
  },

  // Lua: whiteout_rush.lua:47
  phase(): RushState["phase"] | undefined {
    return Rush._state && Rush._state.phase;
  },

  // Lua: whiteout_rush.lua:51
  text(): string | undefined {
    return Rush._state && Rush._state.text;
  },

  // Lua: whiteout_rush.lua:70
  update(_dt?: number): void {
    const st = Rush._state;
    if (!st) return;
    stopMusic();
    if (st.phase === "hold") {
      st.frames = st.frames + 1;
      if (st.frames >= Rush.HOLD_FRAMES) st.phase = "print";
    } else if (st.phase === "print") {
      st.shown = st.shown + 1;
      if (st.shown >= st.total) st.phase = "wait";
    }
  },

  // Lua: whiteout_rush.lua:83
  handleInput(input: any): void {
    const st = Rush._state;
    if (!(st && st.phase === "wait" && input && input.wasPressed)) return;
    if (input.wasPressed("a") || input.wasPressed("b")) finish();
  },

  // Lua: whiteout_rush.lua:89
  draw(): void {
    const st = Rush._state;
    // package.loaded["src.render.Renderer"]
    const R = Renderer as Record<string, any>;
    if (R) {
      R.worldFadeAlpha = 1;
      R.worldFadeColor = seq(0, 0, 0);
    }
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, Display.W, Display.H);
    G.setColor(1, 1, 1, 1);
    if (!st || st.phase === "hold") return;
    // pokefirered/src/field_screen_effect.c:21 sWindowTemplate_WhiteoutText
    Font.draw(st.text, 2, 5 * 8 + 8, { colors: Font.COLOR.WHITE, limitChars: st.shown });
  },
};

export default Rush;
