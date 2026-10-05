// Port of gen1recomp src/world/OverworldController.lua (GPLv3 + additional terms; see LICENSE.md).
// SURFACE ONLY: the Gen 1 overworld (OverworldState, 6,708 lines of Lua) is
// the Kanto host engine, not part of the FireRed runtime. The game3 modules
// reach it in exactly these places, all of them host fallbacks taken only
// when the game3 Runtime is not active (never, on the 3DS: Game3 runs
// standalone and owns the field):
// - scripting/adapters.lua:771  `OC.openPC(finish)` (openPc when neither the
//   game3 Runtime nor the world has a PC)
// - scripting/adapters.lua:1321 `type(OC.loadMap) == "function"` then
//   `OC.loadMap(w, mapId)` (warp to a non-game3 map with no world setMap).
//   OverworldState has no `loadMap`, so the guard is false in the Lua too:
//   `loadMap` stays absent here.
// - scripting/space.lua:686-899 Space.install (Brian's Kanto-Reforged mod
//   mode) wraps OC.loadMap / OC.setMap / OC.talkTo / OC.interact and sets
//   OC._game3LoadMap / _game3Talk / _game3Interact.
// The Lua class table holds both statics and colon methods; Brian's code
// reads them as `OC.x`, so here they are static members, assignable so
// Space.install can wrap them.
// NOT FAITHFUL: openPC / setMap / talkTo / interact are the Gen 1 host's
// (Game.stack, Gen 1 menus and map loader) and stop with NotPortedError if
// ever reached.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { notPorted } from "../../notported.ts";

type Fn = (...a: any[]) => any;

export class OverworldState {
  [key: string]: any;
  static [key: string]: any;

  /** Absent on OverworldState (adapters.lua:1322 / space.lua:716 test it). */
  static loadMap: Fn | undefined = undefined;

  /** Space.install's once-only markers (space.lua:689, :748, :843). */
  static _game3LoadMap: boolean | undefined = undefined;
  static _game3Talk: boolean | undefined = undefined;
  static _game3Interact: boolean | undefined = undefined;

  // Lua: OverworldController.lua:3569 (Gen 1 host PC menu)
  static openPC: Fn | undefined = (..._a: any[]): any =>
    notPorted("OverworldState:openPC (NOT FAITHFUL: Gen 1 host overworld)");

  // Lua: OverworldController.lua:425 (Gen 1 host map loader)
  static setMap: Fn | undefined = (..._a: any[]): any =>
    notPorted("OverworldState:setMap (NOT FAITHFUL: Gen 1 host overworld)");

  // Lua: OverworldController.lua:3441 (Gen 1 host NPC talk)
  static talkTo: Fn | undefined = (..._a: any[]): any =>
    notPorted("OverworldState:talkTo (NOT FAITHFUL: Gen 1 host overworld)");

  // Lua: OverworldController.lua:2538 (Gen 1 host A-button)
  static interact: Fn | undefined = (..._a: any[]): any =>
    notPorted("OverworldState:interact (NOT FAITHFUL: Gen 1 host overworld)");
}

export default OverworldState;
