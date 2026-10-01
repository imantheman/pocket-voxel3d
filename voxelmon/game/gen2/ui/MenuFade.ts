// gen1recomp src/ui/gen2/MenuFade.lua (bdfac727): the fade to white into a
// start-menu page and back.
// ../pokecrystal/home/map.asm:1910-1917 FadeToMenu
// ../pokecrystal/home/map.asm:1919-1940 CloseSubmenu / FinishExitMenu
//
// The Lua lays a translucent white sheet over the frame. The cart instead
// steps every palette toward white, and so does this: the screens under the
// fade draw through an rBGP byte that lightens with the level
// (GbcPalette.setBgp), and at full white the whole screen is white cells.

import G from "../platform/screen.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { World } from "../world/World.ts";
import { Chrome } from "./Chrome.ts";

// Lua: MenuFade.lua:12 -- ../pokecrystal/engine/tilesets/timeofday_pals.asm:122-127, :277-287
const OUT_STEPS = 4;
const STEP_FRAMES = 2;
const OUT_FRAMES = OUT_STEPS * STEP_FRAMES;
// ../pokecrystal/engine/tilesets/timeofday_pals.asm:115-120, :289-299
const IN_STEPS = 3;
const IN_RAMP_FRAMES = IN_STEPS * STEP_FRAMES;

// Lua: MenuFade.lua:21 -- ../pokecrystal/engine/gfx/load_font.asm:67-89
const PARTY_FONT_FRAMES = 3;
// ../pokecrystal/engine/menus/start_menu.asm:503-518
const PARTY_WHITE = 4 + PARTY_FONT_FRAMES + 4;
// ../pokecrystal/engine/gfx/mon_icons.asm:287-297
const PARTY_ICON_FRAMES = 3;
// ../pokecrystal/engine/items/pack.asm:1330-1365, :1439-1444
const PACK_RELOAD_FRAMES = 2;
const PACK_WHITE = 4 + 4 + PACK_RELOAD_FRAMES + 2 + 4;
// ../pokecrystal/engine/pokegear/pokegear.asm:73-111, :291-301
const GEAR_RELOAD_FRAMES = 5;
const GEAR_WHITE = 4 + 4 + GEAR_RELOAD_FRAMES + 7;
// ../pokecrystal/engine/pokegear/pokegear.asm:53-63
const GEAR_EXIT_WHITE = 4;
// ../pokecrystal/engine/menus/trainer_card.asm:41-72
const CARD_RELOAD_FRAMES = 2;
const CARD_WHITE = 4 + 4 + CARD_RELOAD_FRAMES + 4;
// ../pokecrystal/engine/pokedex/pokedex.asm:44, :78-81, :216-252, :2422-2450, :2566-2573
const DEX_RELOAD_FRAMES = 6;
const DEX_WHITE = 4 + 4 + DEX_RELOAD_FRAMES + 1 + 8 + 4;
// ../pokecrystal/engine/menus/options_menu.asm:19-51
const OPTION_WHITE = 4 + 4;

// Lua: MenuFade.lua:61 -- ../pokecrystal/engine/menus/start_menu.asm:444-518
const OPEN_WHITE: Record<string, (partySize?: number) => number> = {
  pokemon: (partySize) => PARTY_WHITE + PARTY_ICON_FRAMES * (partySize ?? 0),
  pack: () => PACK_WHITE,
  pokegear: () => GEAR_WHITE,
  status: () => CARD_WHITE,
  pokedex: () => DEX_WHITE,
  option: () => OPTION_WHITE,
};

// The palette steps toward white, as rBGP bytes: the identity, then the
// RotateThreePalettesRight row (pokecrystal/home/fade.asm, 05 06 07), indexed
// by the sheet's level in quarters.
const WHITE_BGP = [0xe4, 0x90, 0x40, 0x00, 0x00];

export interface MenuFadeOpts {
  kind?: "out" | "in";
  white?: number;
  onDone?: () => void;
}

export class MenuFade {
  static isOpaque = false;
  static BG_WORLD_DIM = 0;
  static OUT_FRAMES = OUT_FRAMES;
  static OUT_WHITE_FRAMES = STEP_FRAMES;
  static IN_RAMP_FRAMES = IN_RAMP_FRAMES;
  static PARTY_FONT_FRAMES = PARTY_FONT_FRAMES;
  static PARTY_WHITE = PARTY_WHITE;
  static PARTY_ICON_FRAMES = PARTY_ICON_FRAMES;
  static PACK_RELOAD_FRAMES = PACK_RELOAD_FRAMES;
  static PACK_WHITE = PACK_WHITE;
  static GEAR_RELOAD_FRAMES = GEAR_RELOAD_FRAMES;
  static GEAR_WHITE = GEAR_WHITE;
  static GEAR_EXIT_WHITE = GEAR_EXIT_WHITE;
  static CARD_RELOAD_FRAMES = CARD_RELOAD_FRAMES;
  static CARD_WHITE = CARD_WHITE;
  static DEX_RELOAD_FRAMES = DEX_RELOAD_FRAMES;
  static DEX_WHITE = DEX_WHITE;
  static OPTION_WHITE = OPTION_WHITE;

  isOpaque = false;
  game: any;
  kind: "out" | "in";
  white: number;
  onDone: (() => void) | null | undefined;
  frame = 1;
  total: number;

  constructor(game: any, opts: MenuFadeOpts = {}) {
    this.game = game;
    this.kind = opts.kind ?? "out";
    this.white = opts.white ?? 0;
    this.onDone = opts.onDone;
    this.total = this.kind === "out" ? MenuFade.framesOut(this.white) : MenuFade.framesIn(this.white);
  }

  /** Lua: MenuFade.lua:72 */
  static openWhite(id: string, partySize?: number): number | undefined {
    const page = OPEN_WHITE[id];
    return page ? page(partySize) : undefined;
  }

  /** Lua: MenuFade.lua:77 */
  static exitWhite(): number {
    return (World as any).MENU_EXIT_WHITE_FRAMES;
  }

  /** Lua: MenuFade.lua:81 */
  static closeWhite(id: string): number | undefined {
    if (!OPEN_WHITE[id]) return undefined;
    let white = MenuFade.exitWhite();
    if (id === "pokegear") white += GEAR_EXIT_WHITE;
    return white;
  }

  /** Lua: MenuFade.lua:88 */
  static framesOut(white: number): number {
    return OUT_FRAMES + white;
  }

  /** Lua: MenuFade.lua:89 */
  static framesIn(white: number): number {
    return white + IN_RAMP_FRAMES;
  }

  /** Lua: MenuFade.lua:91 */
  static new(game: any, opts?: MenuFadeOpts): MenuFade {
    return new MenuFade(game, opts ?? {});
  }

  /** Lua: MenuFade.lua:107 -- 0 (clear) .. 1 (white). */
  level(): number {
    const f = this.frame;
    if (this.kind === "out") {
      if (f >= OUT_FRAMES) return 1;
      return Math.ceil(f / STEP_FRAMES) / OUT_STEPS;
    }
    if (f <= this.white) return 1;
    const k = Math.ceil((f - this.white) / STEP_FRAMES);
    return Math.max(0, (OUT_STEPS - k) / OUT_STEPS);
  }

  /** Lua: MenuFade.lua:118 */
  update(): void {
    this.frame += 1;
    if (this.frame <= this.total) return;
    const done = this.onDone;
    this.onDone = null;
    const stack = this.game?.stack;
    if (stack && stack.top() === this) stack.pop();
    if (done) done();
  }

  /** Lua: MenuFade.lua:128 */
  bgMode(): string {
    return "world";
  }

  /** Lua: MenuFade.lua:130 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** The rBGP byte for the current level (the cart's palette step). */
  bgp(): number {
    return WHITE_BGP[Math.max(0, Math.min(4, Math.round(this.level() * 4)))]!;
  }

  /**
   * Lua: MenuFade.lua:132 sheet(w, h, a) -- the white sheet. Only full white
   * paints cells; a partial level is the rBGP step the screens drew through.
   * NOT FAITHFUL: the voxel world under the holes is not lightened by the
   * partial steps (the scene has no fade op yet); it goes white at level 1.
   */
  sheet(w: number, h: number): void {
    if (this.level() < 1) return;
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, w, h);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MenuFade.lua:139 -- the stack under the fade, then the sheet. */
  drawWidescreen(w: number, h: number): void {
    const stack = this.game?.stack;
    if (stack && stack.states) {
      const previous = GbcPalette.setBgp(this.bgp());
      try {
        for (let i = stack.visibleBase(); i < stack.states.length; i++) {
          const state = stack.states[i];
          if (state !== this && state.draw && stack.renderVisible(state)) state.draw();
        }
      } finally {
        GbcPalette.setBgp(previous);
      }
    }
    this.sheet(w, h);
  }

  /** Lua: MenuFade.lua:161 */
  draw(): void {
    this.sheet(Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
  }
}

export default MenuFade;
