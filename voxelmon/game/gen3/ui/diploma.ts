// Port of gen1recomp src/ui/game3/diploma.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/diploma.c:100
//
// Required lazily (pcall(require, "src.ui.game3.diploma")), so it registers
// itself in G3Lazy.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Display } from "../core/display.ts";
import { Stack } from "./stack.ts";
import { FrlgFont, type Colors, type FontOpts } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { Song } from "../core/song_ids.ts";
import { Fade } from "./fade.ts";
import { Profile } from "../core/profile.ts";
import { Dataset } from "../core/dataset.ts";
import { Queries } from "../core/scripting/natives_queries.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { Audio } from "../core/audio.ts";
import { Space } from "../core/scripting/space.ts";
import { NotPortedError } from "../notported.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { seq } from "../platform/lt.ts";

export interface DiplomaModule {
  ID: string;
  open: boolean;
  _phase: string;
  _national: boolean;
  _onDone: (() => void) | null | undefined;
  _images: Record<string, Image | false>;
  _player?: string;
  _body?: string;
  _gameFreak?: string;
  _playerX?: number;
  _bodyX?: number;
  isOpen(): boolean;
  isNational(): boolean;
  phase(): string;
  show(opts?: any): boolean;
  update(dt?: number): void;
  handleInput(input: any): void;
  draw(): void;
}

// pokefirered/include/constants/songs.h:267
// pokefirered/src/diploma.c:58
// pokefirered/src/diploma.c:97
// Built on first use: no top-level reads of imports (the gen3 import cycle).
let textColors_: Colors | undefined;
function text_colors(): Colors {
  return (textColors_ ??= { fg: FrlgFont.STDPAL[2], shadow: FrlgFont.STDPAL[3], bg: seq(0, 0, 0, 0) as number[] });
}
// pokefirered/src/new_menu_helpers.c:84
const LINE_PITCH = 14;
// pokefirered/src/diploma.c:84
const WIN_X = 0, WIN_Y = 16;

// Lua: diploma.lua:29
function fade(): typeof Fade {
  return Fade;
}

// Lua: diploma.lua:33
function image(keyIn: string): Image | null {
  let key = keyIn;
  const rse = Profile.family() === "rse";
  if (rse) {
    if (key === "kanto") key = "emerald_hoenn";
    if (key === "national") key = "emerald_national";
  }
  if (Diploma._images[key] != null) return Diploma._images[key] || null;
  const rel = (Extract.CACHE_ROOT || "data/generated/gba") + "/diploma/" + key + ".rgba";
  const bytes = Dataset.cache().read(rel);
  let img: Image | false = false;
  if (bytes && bytes.length === Display.W * Display.H * 4) {
    const data = newImageData(Display.W, Display.H, "rgba8", bytes);
    img = G.newImage(data);
    img.setFilter("nearest", "nearest");
  }
  Diploma._images[key] = img;
  return img || null;
}

// pokefirered/src/pokedex.c:123
// Lua: diploma.lua:53
function has_all_mons(): boolean {
  const [, v] = (Queries.BY_NAME as any).HasAllMons(null);
  return v === 1;
}

// Lua: diploma.lua:59
function player_name(): string {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return tostring((session && (session.name ?? session.playerName)) ?? "");
}

// Lua: diploma.lua:123
function finish(): void {
  Diploma.open = false;
  Diploma._phase = "idle";
  Stack.pop(Diploma.ID);
  const cb = Diploma._onDone;
  Diploma._onDone = null;
  // pokefirered/src/overworld.c:1677
  // package.loaded["src.core.game3.scripting.space"]
  const S: any = Space;
  if (S && S.returnToField) { try { S.returnToField(); } catch { /* pcall */ } }
  const F = fade();
  F.begin(F.MODE.FROM_BLACK, 1, () => {});
  if (cb) cb();
}

export const Diploma: DiplomaModule = {
  ID: "diploma",
  open: false,
  _phase: "idle",
  _national: false,
  _onDone: null,
  _images: {},

  // Lua: diploma.lua:65
  isOpen(): boolean {
    return Diploma.open;
  },

  // Lua: diploma.lua:69
  isNational(): boolean {
    return Diploma._national;
  },

  // Lua: diploma.lua:73
  phase(): string {
    return Diploma._phase;
  },

  // pokefirered/src/diploma.c:119
  // Lua: diploma.lua:78
  show(opts?: any): boolean {
    opts = opts || {};
    if (!image("kanto") || !image("national")) return false;
    Diploma._onDone = opts.onDone;
    // pokefirered/src/diploma.c:138
    Diploma._national = has_all_mons();
    const name = player_name();
    if (Profile.family() === "rse") {
      // pokeemerald/src/diploma.c:133-140
      // NOT FAITHFUL: Emerald only (the FRLG port has no Emerald diploma text path).
      throw new NotPortedError("Diploma.show (Emerald only)");
    } else {
      // pokefirered/src/diploma.c:260
      const dynamic = {
        0: name,
        1: RomText.plain(Diploma._national ? "gText_Diploma_National" : "gText_Diploma_Kanto"),
      };
      Diploma._player = RomText.plain("gText_Diploma_Player", { dynamic });
      Diploma._body = RomText.plain("gText_Diploma_ThisDocument", { dynamic });
      Diploma._gameFreak = RomText.plain("gText_Diploma_GameFreak");
      Diploma._playerX = 120 - Math.floor(FrlgFont.measure(Diploma._player) / 2);
      Diploma._bodyX = 120 - Math.floor(FrlgFont.measure(Diploma._body) / 2);
    }
    Diploma.open = true;
    Diploma._phase = "in";
    Stack.push(Diploma.ID, Diploma, { hideBelow: true, fullscreen: true });
    const F = fade();
    // pokefirered/src/diploma.c:150
    F.begin(F.MODE.FROM_BLACK, 1, () => {
      if (Diploma._phase !== "in") return;
      Diploma._phase = "fanfare";
      // pokefirered/src/diploma.c:158
      Audio.playFanfare(Song.MUS_OBTAIN_BADGE);
    });
    return true;
  },

  // pokefirered/src/diploma.c:164
  // Lua: diploma.lua:138
  update(_dt?: number): void {
    if (!Diploma.open) return;
    if (Diploma._phase === "fanfare") {
      if (Audio.isFanfareFinished()) {
        Diploma._phase = "wait";
      }
    }
  },

  // Lua: diploma.lua:147
  handleInput(input: any): void {
    if (!Diploma.open || !input) return;
    if (Diploma._phase !== "wait") return;
    if (input.wasPressed("a")) {
      Diploma._phase = "out";
      const F = fade();
      // pokefirered/src/diploma.c:175
      F.begin(F.MODE.TO_BLACK, 1, () => {
        if (Diploma._phase === "out") finish();
      });
    }
  },

  // Lua: diploma.lua:160
  draw(): void {
    if (!Diploma.open) return;
    const rse = Profile.family() === "rse";
    // pokefirered/src/diploma.c:138
    const img = image(Diploma._national ? "national" : "kanto");
    G.setColor(1, 1, 1, 1);
    if (img) G.draw(img, 0, 0);
    if (rse) {
      // pokeemerald/src/diploma.c:133-140, :181-189
      // NOT FAITHFUL: Emerald only (show() refuses the Emerald path, so this is unreachable).
      throw new NotPortedError("Diploma.draw (Emerald only)");
    }
    // pokefirered/src/diploma.c:269
    const opts: FontOpts = { colors: text_colors(), linePitch: LINE_PITCH };
    if (Diploma._player && Diploma._player !== "") {
      FrlgFont.draw(Diploma._player, WIN_X + Diploma._playerX!, WIN_Y + 4, opts);
    }
    if (Diploma._body && Diploma._body !== "") {
      FrlgFont.draw(Diploma._body, Diploma._bodyX!, WIN_Y + 30, opts);
    }
    if (Diploma._gameFreak && Diploma._gameFreak !== "") {
      FrlgFont.draw(Diploma._gameFreak, WIN_X + 120, WIN_Y + 105, opts);
    }
  },
};

G3Lazy["src.ui.game3.diploma"] = Diploma;

export default Diploma;
