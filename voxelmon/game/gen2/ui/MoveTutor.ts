// gen1recomp src/ui/gen2/MoveTutor.lua (bdfac727, MIT): Crystal's move
// tutor (pokecrystal engine/events/move_tutor.asm:1 MoveTutor, the submenu
// FadeToMenu / ChooseMonToLearnTMHM / CloseSubmenu wraps, and :54
// CheckCanLearnMoveTutorMove, whose refusals print into a Textbox over the
// party list).
//
// ChooseMonToLearnTMHM (engine/items/tmhm.asm:73) is InitPartyMenuWithCancel
// with PARTYMENUACTION_TEACH_TMHM, which is the list PartyMenu draws when it
// is handed `tmhm`. Crystal-only: Screens.lua lists it as pending, but the
// module itself is complete.

import G from "../platform/screen.ts";
import { Happiness } from "../core/Happiness.ts";
import { Mon } from "../battle/Mon.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { PartyMenu } from "./PartyMenu.ts";

export interface MoveTutorOpts {
  move?: string;
  moveName?: string;
  pokemon?: Record<string, any>;
  onDone?: (learned: boolean) => void;
}

// Lua: MoveTutor.lua:23 -- common_2.asm:187 _TMHMNotCompatibleText and
// common_3.asm:1424 _KnowsMoveText.
const NOT_COMPATIBLE = Strings.source("%s is\nnot compatible\vwith %s.");
const KNOWS_MOVE = Strings.source("%s knows\n%s.");

export class MoveTutor {
  // Lua: MoveTutor.lua:18
  static isOpaque = true;
  isOpaque = true;

  game: any;
  move: string | undefined;
  moveName: string;
  onDone?: (learned: boolean) => void;
  pokemon: Record<string, any> | undefined;
  view: Record<string, any>;
  list: any;
  done?: boolean;
  [key: string]: any;

  /**
   * Lua: MoveTutor.lua:29 -- CanLearnTMHMMove's bitfield: `add_mt` gives the
   * three tutor moves TMHM flags 58-60, which the cache splits out as
   * `tutorMoves`.
   */
  static canLearn(species: any, moveId: string | undefined): boolean {
    if (species == null || typeof species !== "object" || moveId == null) return false;
    for (const id of species.tmhm || []) if (id === moveId) return true;
    for (const id of species.tutorMoves || []) if (id === moveId) return true;
    return false;
  }

  /**
   * Lua: MoveTutor.lua:42 -- the same bitfield as a pokemon table view, for
   * PartyMenu's ABLE / NOT ABLE column (which walks `tmhm` only). The Lua's
   * __index metatable becomes a read-only Proxy with the same cache.
   */
  static speciesView(pokemon: Record<string, any> | undefined): Record<string, any> {
    const cache = new Map<string, any>();
    return new Proxy({} as Record<string, any>, {
      get(_t, key) {
        if (typeof key !== "string") return undefined;
        if (cache.has(key)) return cache.get(key) || undefined;
        const def = pokemon && pokemon[key];
        if (def == null || typeof def !== "object") {
          cache.set(key, false);
          return undefined;
        }
        const merged: Record<string, any> = { ...def };
        const list: any[] = [];
        for (const id of def.tmhm || []) list.push(id);
        for (const id of def.tutorMoves || []) list.push(id);
        merged.tmhm = list;
        cache.set(key, merged);
        return merged;
      },
    });
  }

  /** Lua: MoveTutor.lua:64 -- opts: move, moveName, onDone(learned) */
  static new(game: any, opts?: MoveTutorOpts): MoveTutor {
    return new MoveTutor(game, opts ?? {});
  }

  constructor(game: any, opts: MoveTutorOpts) {
    this.game = game;
    const data = (game && game.data) || {};
    this.move = opts.move;
    this.moveName = opts.moveName || opts.move || "?";
    this.onDone = opts.onDone;
    this.pokemon = opts.pokemon || data.pokemon;
    this.view = MoveTutor.speciesView(this.pokemon);
    this.list = this.buildList();
  }

  /** Lua: MoveTutor.lua:78 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MoveTutor.lua:79 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: MoveTutor.lua:81 */
  buildList(): any {
    return (PartyMenu as any).new(this.game, {
      prompt: "teach",
      tmhm: { move: this.move },
      pokemon: this.view,
      onChoose: (_: any, mon: any) => this.picked(mon),
      onCancel: () => this.finish(false),
    });
  }

  /** Lua: MoveTutor.lua:91 */
  say(body: string, onDone?: () => void): any {
    if (this.game && this.game.say) return this.game.say(body, onDone);
    if (onDone) onDone();
  }

  /** Lua: MoveTutor.lua:96 */
  playSfx(name: string): void {
    const world = this.game && this.game.world;
    if (world && world.playSfxNamed) world.playSfxNamed(name);
  }

  /**
   * Lua: MoveTutor.lua:103 -- CheckCanLearnMoveTutorMove (move_tutor.asm:54);
   * all three failures fall back into the list, `jr nc, .loop` at :24.
   */
  picked(mon: any): any {
    if (!mon) return;
    const name = Mon.displayName(mon);
    if (!MoveTutor.canLearn(this.view[mon.species], this.move)) {
      this.playSfx("Sfx_Wrong");
      return this.say(Strings.get(NOT_COMPATIBLE, this.moveName, name));
    }
    // knows_move.asm:16 sets carry and prints: the same .didnt_learn arm.
    for (const move of mon.moves || []) {
      if (move.id === this.move) return this.say(Strings.get(KNOWS_MOVE, name, this.moveName));
    }
    const game = this.game;
    if (!(game && game.learnMoveOn)) return this.finish(false);
    game.learnMoveOn(mon, this.move, (learned: boolean) => {
      if (!learned) return;
      // :87-88 `ld c, HAPPINESS_LEARNMOVE / callfar ChangeHappiness`. The
      // 4000 coins are the script's own takecoins (GoldenrodCity.asm:124).
      Happiness.change(mon, "LEARNMOVE");
      this.finish(true);
    });
  }

  /** Lua: MoveTutor.lua:128 */
  finish(learned: boolean): void {
    if (this.done) return;
    this.done = true;
    const stack = this.game && this.game.stack;
    if (stack) stack.pop();
    if (this.onDone) this.onDone(learned);
  }

  /** Lua: MoveTutor.lua:136 */
  update(dt?: number): void {
    if (this.done) return;
    this.list.update(dt);
  }

  /** Lua: MoveTutor.lua:141 */
  drawPanel(): void {
    this.list.drawPanel();
  }

  /** Lua: MoveTutor.lua:145 */
  draw(): void {
    this.list.draw();
  }

  /** Lua: MoveTutor.lua:151 -- PartyMenu:drawWidescreen's own blit. */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default MoveTutor;
