// gen1recomp src/script/gen2/specials/unown_words.lua at bdfac727 (MIT).
//
// ../pokecrystal/data/events/special_pointers.asm:151 DisplayUnownWords, run
// by all four chambers: ../pokecrystal/maps/RuinsOfAlphKabutoChamber.asm:123,
// ../pokecrystal/maps/RuinsOfAlphHoOhChamber.asm:86,
// ../pokecrystal/maps/RuinsOfAlphOmanyteChamber.asm:86,
// ../pokecrystal/maps/RuinsOfAlphAerodactylChamber.asm:85.

import { Specials } from "../Specials.ts";
import type { Script, Vm } from "../Vm.ts";
import { UnownWords } from "../../world/UnownWords.ts";

// Lua: unown_words.lua:12
function* DisplayUnownWords(vm: Vm): Script<void> {
  const S = Specials.shared;
  const h = S.hooks(vm);
  const world = h.world;
  const game = world && world.game;
  if (!(game && game.stack)) return;
  const wall = UnownWords.wallFor(game.data, vm.scriptVar ?? 0);
  if (!wall) return;
  yield* S.block(vm, (done: (value?: any) => void) => {
    const screen = UnownWords.new(game, {
      wall, world, onClose: () => done(true),
    });
    // pcall(game.stack.push, game.stack, screen)
    let ok = true;
    try {
      game.stack.push(screen);
    } catch {
      ok = false;
    }
    if (!ok) done(false);
  });
}

export const unown_words: Record<string, (vm: Vm) => any> = {
  DisplayUnownWords,
};

export default unown_words;
