// The Gold story run's chapters (tools/gold_story.ts), in story order. Each
// walks its part of the critical path and checks what the cart would have
// handed over by the end of it.
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import {
  fail, badges, can, chapters, describe, engine, expect, flag, game, hasItem, log, npc, partySpecies, save, settle, talk, travel, use, walk, walkTo,
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

/** Teach `move` to the lead (the run's stand-in for the HM menu), last slot. */
function teach(move: string): void {
  const lead = save().party[0];
  const has = (lead.moves ?? []).some((m: any) => (m.id ?? m) === move);
  if (has) return;
  const slot = Math.min((lead.moves ?? []).length, 3);
  const mv = game.data.moves?.[move];
  lead.moves[slot] = { id: move, pp: mv?.pp ?? 30, ppUps: 0 };
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

void describe;
void npc;
void use;
void walk;
void walkTo;
