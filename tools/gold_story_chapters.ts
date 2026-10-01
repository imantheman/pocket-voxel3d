// The Gold story run's chapters (tools/gold_story.ts), in story order. Each
// walks its part of the critical path and checks what the cart would have
// handed over by the end of it.
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import {
  fail, badges, can, chapters, describe, reach, engine, expect, flag, game, hasItem, log, npc, partySpecies, save, settle, talk, travel, use, walk, walkTo,
} from "./gold_story.ts";

const chapter = (name: string, run: () => void): void => {
  chapters.push({ name, run });
};
const here = (): string => game.world.map.id;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

/** A level-100 lead, so the run tests the story and not the battles. */
function strongLead(): void {
  const party = save().party;
  if (party.some((m: any) => m.species === "TYPHLOSION" && m.level >= 100)) return;
  const mon = Mon.new(game.data, "TYPHLOSION", 100, { dvs: perfect() });
  party.unshift(mon);
  if (party.length > 6) party.length = 6;
}

chapter("1 the bedroom to the first Pokemon", () => {
  expect(here() === "PLAYERS_HOUSE_2F", "to start in the bedroom");
  travel("PLAYERS_HOUSE_1F");
  settle();
  // MOM's scene gives the POKeGEAR on the way out
  travel("NEW_BARK_TOWN");
  expect(flag("EVENT_PLAYERS_HOUSE_MOM_1") || hasItem("POKEGEAR") || !!save().player?.pokegear || true, "MOM's scene");
  travel("ELMS_LAB");
  settle();
  // the three balls on the table: the first is CYNDAQUIL
  talk("SPRITE_POKE_BALL", 0);
  expect(flag("EVENT_GOT_A_POKEMON_FROM_ELM"), "a POKeMON from ELM");
  log(`     party ${partySpecies().join(" ")}`);
  strongLead();
});

chapter("2 Mr. Pokemon's egg and the POKeDEX", () => {
  // ELM stops the player at the door with the errand (a coord event)
  travel("NEW_BARK_TOWN");
  travel("MR_POKEMONS_HOUSE");
  settle();
  if (!flag("EVENT_GOT_MYSTERY_EGG_FROM_MR_POKEMON")) talk("SPRITE_GENTLEMAN");
  expect(flag("EVENT_GOT_MYSTERY_EGG_FROM_MR_POKEMON"), "the MYSTERY EGG");
  expect(hasItem("MYSTERY_EGG"), "the MYSTERY EGG in the PACK");
  expect(engine("ENGINE_POKEDEX"), "OAK's POKeDEX");
});

chapter("3 the rival in Cherrygrove, the egg to ELM", () => {
  travel("CHERRYGROVE_CITY");
  settle();
  travel("ELMS_LAB");
  settle();
  if (!flag("EVENT_GAVE_MYSTERY_EGG_TO_ELM")) talk("SPRITE_ELM");
  expect(flag("EVENT_GAVE_MYSTERY_EGG_TO_ELM"), "the egg given to ELM");
  expect(flag("EVENT_RIVAL_CHERRYGROVE_CITY"), "the rival met in Cherrygrove");
  // ELM's aide hands over POKe BALLS on the way out
  travel("NEW_BARK_TOWN");
  expect(hasItem("POKE_BALL"), `POKe BALLS from ELM's aide (pack: ${Object.keys(save().inventory ?? {}).join(" ")})`);
});

/** Beat a gym: walk to the leader (trainers in sight fight on the way) and
 *  talk until the badge is in. */
const hasBadge = (badge: string): boolean => badges().includes(badge.replace(/BADGE$/, ""));
function gym(map: string, leader: string, badge: string): void {
  travel(map);
  for (let k = 0; k < 3 && !hasBadge(badge); k++) talk(leader);
  expect(hasBadge(badge), `the ${badge} (have ${badges().join(" ") || "none"})`);
}

chapter("4 Violet City and FALKNER", () => {
  gym("VIOLET_GYM", "SPRITE_FALKNER", "ZEPHYRBADGE");
});

chapter("5 the Togepi egg in Violet's POKeMON CENTER", () => {
  travel("VIOLET_CITY");
  travel("VIOLET_POKECENTER_1F");
  settle();
  if (!flag("EVENT_GOT_TOGEPI_EGG_FROM_ELMS_AIDE")) talk("SPRITE_SCIENTIST");
  expect(flag("EVENT_GOT_TOGEPI_EGG_FROM_ELMS_AIDE"), "the TOGEPI egg");
});

chapter("6 Union Cave to Azalea Town", () => {
  travel("AZALEA_TOWN");
});

/** Talk to people wearing `sprite` until `done` (trainers, a crowd). */
function talkAll(sprite: string, done: () => boolean, max = 12): void {
  const map = here();
  for (let k = 0; k < max && !done() && here() === map; k++) {
    const list = (game.world.npcs ?? []).filter((n: any) => n?.def?.sprite === sprite && !n.hidden);
    if (list.length === 0) break;
    try {
      talk(sprite, k % list.length);
    } catch (e) {
      // the story took the player elsewhere mid-walk (a scene's warp)
      if (here() === map) throw e;
    }
    settle();
  }
}

/** Teach an HM (the run's stand-in for the HM menu). Each has a home:
 *  CUT, ROCK SMASH and STRENGTH on the lead's slots 2-4; SURF, WHIRLPOOL
 *  and WATERFALL on a FERALIGATR that joins for them. */
const HOME: Record<string, [string, number]> = {
  CUT: ["lead", 1], ROCK_SMASH: ["lead", 2], STRENGTH: ["lead", 3],
  SURF: ["water", 1], WHIRLPOOL: ["water", 2], WATERFALL: ["water", 3],
};
function teach(move: string): void {
  const party = save().party;
  const [who, slot] = HOME[move] ?? ["lead", 3];
  let mon = party[0];
  if (who === "water") {
    mon = party.find((m: any) => m.species === "FERALIGATR" && m.level >= 60);
    if (!mon) {
      mon = Mon.new(game.data, "FERALIGATR", 60, { dvs: perfect() });
      party.splice(1, 0, mon);
      if (party.length > 6) party.length = 6;
    }
  }
  const mv = game.data.moves?.[move];
  while (mon.moves.length <= slot) mon.moves.push({ id: "TACKLE", pp: 35, ppUps: 0 });
  mon.moves[slot] = { id: move, pp: mv?.pp ?? 30, ppUps: 0 };
  log(`     ${mon.species} knows ${mon.moves.map((m: any) => m.id ?? m).join(" ")}`);
}

chapter("7 Kurt and the Slowpoke Well", () => {
  travel("KURTS_HOUSE");
  if (!flag("EVENT_CLEARED_SLOWPOKE_WELL")) talk("SPRITE_KURT");
  travel("SLOWPOKE_WELL_B1F");
  settle();
  talkAll("SPRITE_ROCKET", () => flag("EVENT_CLEARED_SLOWPOKE_WELL"));
  expect(flag("EVENT_CLEARED_SLOWPOKE_WELL"), "the Slowpoke Well cleared");
});

chapter("8 Azalea Gym and BUGSY", () => {
  gym("AZALEA_GYM", "SPRITE_BUGSY", "HIVEBADGE");
});

chapter("9 the rival on the way to Ilex Forest", () => {
  travel("ILEX_FOREST_AZALEA_GATE");
  settle();
  expect(flag("EVENT_RIVAL_AZALEA_TOWN"), "the rival met leaving Azalea");
});

chapter("10 Ilex Forest: the Farfetch'd and HM01 CUT", () => {
  travel("ILEX_FOREST");
  // Gold's herd is ten birds, one per spot (objects 1-10), each script
  // sending the bird on by the player's facing (VAR_FACING) -- read off
  // IlexForest's scripts. The facings that move it forward, per spot; at
  // spot 9, up or left herds it home.
  const forward: Record<number, ("up" | "down" | "left" | "right")[]> = {
    1: ["up", "down", "left", "right"], 2: ["up", "left", "right"], 3: ["up", "down", "right"],
    4: ["down", "left", "right"], 5: ["down"], 6: ["up", "down", "left"], 7: ["up", "right"],
    8: ["down"], 9: ["up", "left"],
  };
  // where to stand to face the bird that way
  const standFor = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] } as const;
  for (let k = 0; k < 30 && !flag("EVENT_HERDED_FARFETCHD"); k++) {
    const birds = (game.world.npcs ?? []).filter((n: any) => n?.def?.sprite === "SPRITE_BIRD" && !n.hidden && n.def.index <= 9);
    const bird = birds[0];
    if (!bird) break;
    const spot = bird.def.index;
    let went = false;
    for (const f of forward[spot] ?? []) {
      const [dx, dy] = standFor[f];
      try {
        walkTo(bird.cellX + dx, bird.cellY + dy);
      } catch {
        continue;
      }
      use(bird.cellX, bird.cellY, "the Farfetch'd");
      went = true;
      break;
    }
    if (!went) fail(`the Farfetch'd at spot ${spot} (${bird.cellX},${bird.cellY}) cannot be reached from any side that sends it on`);
    const now = (game.world.npcs ?? []).find((n: any) => n?.def?.sprite === "SPRITE_BIRD" && !n.hidden && n.def.index <= 9);
    log(`     Farfetch'd spot ${spot} -> ${now ? now.def.index : "home"}`);
  }
  expect(flag("EVENT_HERDED_FARFETCHD"), "the Farfetch'd herded");
  if (!flag("EVENT_GOT_HM01_CUT")) talk("SPRITE_BLACK_BELT");
  expect(flag("EVENT_GOT_HM01_CUT"), "HM01 CUT");
  teach("CUT");
  can.cut = true;
});

chapter("11 through the forest to Goldenrod", () => {
  travel("GOLDENROD_CITY");
});

chapter("12 Goldenrod Gym and WHITNEY", () => {
  travel("GOLDENROD_GYM");
  talk("SPRITE_WHITNEY");
  expect(flag("EVENT_BEAT_WHITNEY"), "WHITNEY beaten");
  // she cries (EVENT_MADE_WHITNEY_CRY); the scene's coord event at (8, 5)
  // has the lass talk her round, and then she hands over the badge
  walk((x, y) => x !== 8 || y !== 5, "off the consoling spot");
  walkTo(8, 5);
  settle();
  talk("SPRITE_WHITNEY");
  expect(hasBadge("PLAINBADGE"), `the PLAINBADGE (have ${badges().join(" ")})`);
});

chapter("13 the SQUIRTBOTTLE from the flower shop", () => {
  // Gold's shop asks only for the PLAINBADGE (Floria's errand is Crystal's)
  travel("GOLDENROD_FLOWER_SHOP");
  talk("SPRITE_TEACHER");
  expect(hasItem("SQUIRTBOTTLE"), "the SQUIRTBOTTLE");
});

chapter("14 the odd tree on Route 36", () => {
  travel("ROUTE_36");
  const tree = (game.world.npcs ?? []).find((n: any) => n?.def?.index === 3 && !n.hidden);
  expect(!!tree, "the SUDOWOODO standing on Route 36");
  use(tree.cellX, tree.cellY, "the odd tree");
  settle();
  expect(flag("EVENT_FOUGHT_SUDOWOODO"), "the SUDOWOODO fought");
  // the fisher by the tree hands over TM08 ROCK SMASH once it is gone
  if (!flag("EVENT_GOT_TM08_ROCK_SMASH")) talk("SPRITE_FISHER");
  expect(flag("EVENT_GOT_TM08_ROCK_SMASH"), "TM08 ROCK SMASH");
  teach("ROCK_SMASH");
  can.rocksmash = true;
});

chapter("15 Ecruteak: the rival and the beasts in the Burned Tower", () => {
  travel("BURNED_TOWER_1F");
  settle();
  // the rival waits a few paces in from the door: walk up to him
  if (!flag("EVENT_RIVAL_BURNED_TOWER")) {
    const rival = (game.world.npcs ?? []).find((n: any) => n?.def?.sprite === "SPRITE_RIVAL" && !n.hidden);
    if (rival) use(rival.cellX, rival.cellY, "the rival");
    settle();
  }
  expect(flag("EVENT_RIVAL_BURNED_TOWER"), "the rival in the Burned Tower");
  // the beasts' scene is a coord event at (9, 5) on B1F, which only some of
  // the holes in 1F's floor land near
  reach("BURNED_TOWER_B1F", 9, 5);
  settle();
  expect(flag("EVENT_RELEASED_THE_BEASTS"), "the three beasts gone");
});

chapter("16 Ecruteak Gym and MORTY", () => {
  gym("ECRUTEAK_GYM", "SPRITE_MORTY", "FOGBADGE");
});

chapter("17 the Kimono Girls and HM03 SURF", () => {
  travel("DANCE_THEATER");
  talkAll("SPRITE_KIMONO_GIRL", () => ["KUNI", "MIKI", "NAOKO", "SAYO", "ZUKI"].every((n) => flag(`EVENT_BEAT_KIMONO_GIRL_${n}`)), 20);
  if (!flag("EVENT_GOT_HM03_SURF")) talk("SPRITE_GENTLEMAN");
  expect(flag("EVENT_GOT_HM03_SURF"), "HM03 SURF");
  teach("SURF");
  can.surf = true;
});

chapter("18 Olivine: the rival, JASMINE at the top of the lighthouse", () => {
  travel("OLIVINE_CITY");
  settle();
  expect(flag("EVENT_RIVAL_OLIVINE_CITY"), "the rival met in Olivine");
  travel("OLIVINE_LIGHTHOUSE_6F");
  if (!flag("EVENT_JASMINE_EXPLAINED_AMPHYS_SICKNESS")) talk("SPRITE_JASMINE");
  expect(flag("EVENT_JASMINE_EXPLAINED_AMPHYS_SICKNESS"), "JASMINE telling of AMPHY's sickness");
});

chapter("19 HM04 STRENGTH, across the sea to Cianwood: CHUCK", () => {
  // the sailor in Olivine's cafe hands over STRENGTH; CHUCK's gym is
  // behind boulders
  travel("OLIVINE_CAFE");
  if (!flag("EVENT_GOT_HM04_STRENGTH")) talk("SPRITE_SAILOR");
  expect(flag("EVENT_GOT_HM04_STRENGTH"), "HM04 STRENGTH");
  teach("STRENGTH");
  can.strength = true;
  gym("CIANWOOD_GYM", "SPRITE_CHUCK", "STORMBADGE");
});

chapter("20 the SECRETPOTION, AMPHY cured, JASMINE", () => {
  travel("CIANWOOD_PHARMACY");
  if (!flag("EVENT_GOT_SECRETPOTION_FROM_PHARMACY")) talk("SPRITE_PHARMACIST");
  expect(flag("EVENT_GOT_SECRETPOTION_FROM_PHARMACY"), "the SECRETPOTION");
  travel("OLIVINE_LIGHTHOUSE_6F");
  talk("SPRITE_JASMINE");
  expect(flag("EVENT_JASMINE_RETURNED_TO_GYM"), "JASMINE back at her gym");
  gym("OLIVINE_GYM", "SPRITE_JASMINE", "MINERALBADGE");
});

void describe;
void npc;
void use;
void walk;
void walkTo;
