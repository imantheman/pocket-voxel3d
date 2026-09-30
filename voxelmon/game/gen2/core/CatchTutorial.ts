// Ports gen1recomp src/core/gen2/CatchTutorial.lua at bdfac727 (MIT).
//
// The DUDE's catching demonstration (engine/events/catch_tutorial.asm).
// `catchtutorial BATTLETYPE_TUTORIAL` on Route 29 is a REAL battle: the
// player's name is swapped for the DUDE's, he gets his own pack, an
// auto-input stream is armed, then StartBattle. Everything the DUDE does is
// the AutoInput ring answering the prompts. What BATTLETYPE_TUTORIAL changes
// inside the battle (no mon sent out, DudeBackpic, BattleMenu skipping the
// HUD refresh, TutorialPack's answer discarded for POKE_BALL, a catch that
// never fails and writes nothing) lives in ui/BattleState.ts's `tutorial` arm.

import { AutoInput, type AutoInputTarget } from "./AutoInput.ts";

export interface CatchTutorialState {
  name?: any;
  textSpeed?: any;
}

export const CatchTutorial = {
  // CatchTutorial.Dude: `db "DUDE@"`.
  DUDE_NAME: "DUDE",

  // wBattleType (constants/battle_constants.asm) that Route 29's three
  // `catchtutorial` commands carry.
  BATTLETYPE_TUTORIAL: 3,

  // .LoadDudeData as an id -> count bag. The POKE_BALL count really is 5: the
  // routine writes the ball's item id (5) into the quantity byte too. Kept,
  // like the catch-rate bugs.
  PACK: { POTION: 1, POKE_BALL: 5 } as Record<string, number>,

  // The ball the demo always throws, whatever TutorialPack came back with.
  BALL: "POKE_BALL",

  // The re-arm points, by AutoInput.STREAMS name:
  //   PROMPT  home/joypad.asm .wait_input (every text box waiting for A)
  //   MENU    engine/battle/core.asm BattleMenu (picks ITEM)
  //   PACK    engine/items/pack.asm TutorialPack (BALL pocket, POKE BALL)
  // and CatchTutorial's own stream, armed around StartBattle.
  PROMPT_STREAM: "DUDE_A",
  MENU_STREAM: "DUDE_DOWN_A",
  PACK_STREAM: "DUDE_RIGHT_A",
  BATTLE_STREAM: "CATCH_TUTORIAL",

  // Lua: CatchTutorial.lua:78 -- arm a stream on the ring, but only while one
  // is already running (`ld a, [wInputType] / or a / jr z, .skip`). `skipIdle`
  // is for the streams a MENU consumes (see AutoInput.skipIdle).
  rearm(ring: AutoInput | undefined | null, stream: string, input?: AutoInputTarget, skipIdle?: boolean): boolean {
    if (!(ring && ring.isActive && ring.isActive())) return false;
    if (!AutoInput.STREAMS[stream]) return false;
    if (!ring.start(stream, input)) return false;
    if (skipIdle) ring.skipIdle();
    return true;
  },

  // Lua: CatchTutorial.lua:90 -- the save-shaped shim TutorialPack draws
  // (wDudeNumItems / wDudeNumBalls are their own buffers).
  dudeSave(): { player: { name: string }; inventory: Record<string, number> } {
    const inventory: Record<string, number> = {};
    for (const id of Object.keys(CatchTutorial.PACK)) inventory[id] = CatchTutorial.PACK[id]!;
    return {
      player: { name: CatchTutorial.DUDE_NAME },
      inventory,
    };
  },

  // Lua: CatchTutorial.lua:103 -- the bracket before StartBattle: back the
  // player's name up into wMomsName, copy DUDE over it, force TEXT_DELAY_MED.
  // Returns the state `finish` needs.
  begin(save: any, options: any): CatchTutorialState {
    const player = save ? save.player : undefined;
    const state: CatchTutorialState = {
      name: player ? player.name : undefined,
      textSpeed: options ? options.textSpeed : undefined,
    };
    if (player) {
      // `ld hl, wPlayerName / ld de, wMomsName / call CopyBytes`: MOM's name is
      // overwritten and never restored, so <MOM> prints the player's name from
      // here on. A real cart quirk, kept.
      save.mom = save.mom ?? {};
      save.mom.name = player.name;
      player.name = CatchTutorial.DUDE_NAME;
    }
    if (options) {
      // `and ~TEXT_DELAY_MASK / add TEXT_DELAY_MED`: only the delay field.
      options.textSpeed = "MID";
    }
    return state;
  },

  // Lua: CatchTutorial.lua:130 -- .DudeTutorial's tail: `pop af / ld [wOptions], a`,
  // then the player's name back out of wMomsName. Mom's name is NOT restored.
  finish(save: any, options: any, state?: CatchTutorialState): void {
    state = state ?? {};
    const player = save ? save.player : undefined;
    if (player && state.name != null && state.name !== false) player.name = state.name;
    if (options && state.textSpeed != null && state.textSpeed !== false) options.textSpeed = state.textSpeed;
  },
};

export default CatchTutorial;
