// Port of gen1recomp src/ui/game3/mon_pic.lua (GPLv3 + additional terms; see LICENSE.md).
// Field script mon pic (pret ScriptMenu_ShowPokemonPic / showmonpic).
// 8×8 tile window + 64×64 front.

import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Image } from "../platform/image.ts";
import { Display } from "../core/display.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Audio } from "../core/audio.ts";
import { Window } from "./window.ts";

export interface AnimTransform { x2?: number; y2?: number; rotation?: number; sx?: number; sy?: number }

export const MonPic = {
  active: false,
  species: 0,
  left: 10,
  top: 3,
  _img: undefined as Image | undefined,
  _w: 64,
  _h: 64,
  _animTransform: undefined as AnimTransform | undefined,

  // Lua: mon_pic.lua:18
  show(speciesIn: unknown, x?: unknown, y?: unknown, opts?: { noCry?: boolean }): void {
    const species = tonumber(speciesIn) ?? 0;
    opts = opts || {};
    MonPic.active = true;
    MonPic.species = species;
    MonPic.left = tonumber(x) ?? 10;
    MonPic.top = tonumber(y) ?? 3;
    MonPic._img = undefined;
    MonPic._w = 64;
    MonPic._h = 64;
    MonPic._animTransform = undefined;
    // pcall(require, "src.core.game3.pokemon"): always present here
    if (Pokemon) {
      // pokefirered/src/field_effect.c:610
      const entry = (Pokemon.frontPic as (...a: any[]) => any)(Pokemon.picSpecies(species, 0x8000), undefined, false, 0x8000);
      if (entry && entry.image) {
        MonPic._img = entry.image;
        MonPic._w = entry.w || 64;
        MonPic._h = entry.h || 64;
      }
    }
    if (!opts.noCry && Audio && Audio.playCry) {
      Audio.playCry(species);
    }
  },

  // Lua: mon_pic.lua:45
  hide(): void {
    MonPic.active = false;
    MonPic.species = 0;
    MonPic._img = undefined;
    MonPic._animTransform = undefined;
  },

  // Lua: mon_pic.lua:52
  isActive(): boolean {
    return MonPic.active;
  },

  // Lua: mon_pic.lua:56
  draw(): void {
    if (!MonPic.active) return;
    const tx = MonPic.left ?? 10;
    const ty = MonPic.top ?? 3;
    // pokefirered/src/script_menu.c:1193
    Window.stdFrame(Window.template(tx + 1, ty + 1, 8, 8));
    const cx = tx * Display.TILE + 40;
    const cy = ty * Display.TILE + 40;
    if (MonPic._img) {
      const iw = MonPic._w || 64;
      const ih = MonPic._h || 64;
      const scale = Math.min(64 / iw, 64 / ih);
      const dw = iw * scale, dh = ih * scale;
      G.setColor(1, 1, 1, 1);
      const t = MonPic._animTransform;
      if (t) {
        G.draw(MonPic._img, cx + (t.x2 ?? 0), cy + (t.y2 ?? 0), t.rotation ?? 0,
          scale * (t.sx ?? 1), scale * (t.sy ?? 1), iw / 2, ih / 2);
      } else {
        G.draw(MonPic._img, cx - dw / 2, cy - dh / 2, 0, scale, scale);
      }
    } else {
      G.setColor(0.2, 0.25, 0.35, 1);
      G.rectangle("fill", cx - 28, cy - 28, 56, 56);
      G.setColor(1, 1, 1, 1);
    }
  },
};

export default MonPic;
