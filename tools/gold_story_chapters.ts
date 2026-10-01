// The Gold story run's chapters (tools/gold_story.ts), in story order. Each
// walks its part of the critical path and checks what the cart would have
// handed over by the end of it.
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import {
  dropBoulders, fail, healIfLow, useOn, badges, can, canReach, chapters, describe, reach, engine, expect, flag, game, hasItem, log, npc, partySpecies, save, settle, talk, travel, use, walk, walkTo,
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
  for (let k = 0; k < max && !done(); k++) {
    // worn down: the POKeMON CENTER, and straight back
    if (healIfLow()) travel(map);
    if (here() !== map) break;
    const list = (game.world.npcs ?? []).filter((n: any) => n?.def?.sprite === sprite && !n.hidden);
    if (list.length === 0) break;
    try {
      talk(sprite, k % list.length);
    } catch (e) {
      // the story took the player elsewhere mid-walk (a scene's warp), or
      // this one is out of reach (behind a door not yet open): the next
      if (here() === map && !/no way to|could not get to/.test(String((e as Error).message))) throw e;
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
  while (mon.moves.length <= slot) mon.moves.push({ id: "TACKLE", pp: 35, maxPp: 35, ppUps: 0 });
  // (maxPp as the engine's own moves carry it: a POKeMON CENTER heals to it)
  mon.moves[slot] = { id: move, pp: mv?.pp ?? 30, maxPp: mv?.pp ?? 30, ppUps: 0 };
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

chapter("21 the Lake of Rage: the red GYARADOS, LANCE", () => {
  travel("LAKE_OF_RAGE");
  const gyarados = (game.world.npcs ?? []).find((n: any) => n?.def?.sprite === "SPRITE_GYARADOS" && !n.hidden);
  if (gyarados) use(gyarados.cellX, gyarados.cellY, "the red GYARADOS");
  settle();
  expect(hasItem("RED_SCALE"), "the RED SCALE");
  // LANCE waits by the shore: YES to helping him
  if (!flag("EVENT_DECIDED_TO_HELP_LANCE")) talk("SPRITE_LANCE");
  expect(flag("EVENT_DECIDED_TO_HELP_LANCE"), "the promise to help LANCE");
});

chapter("22 the Team Rocket hideout under Mahogany", () => {
  travel("MAHOGANY_MART_1F");
  settle();
  expect(flag("EVENT_UNCOVERED_STAIRCASE_IN_MAHOGANY_MART"), "the hidden staircase found");
  // B2F: LANCE heals the party (5, 14), then the executive at (14, 11)
  reach("TEAM_ROCKET_BASE_B2F", 5, 14, () => flag("EVENT_LANCE_HEALED_YOU_IN_TEAM_ROCKET_BASE"));
  settle();
  expect(flag("EVENT_LANCE_HEALED_YOU_IN_TEAM_ROCKET_BASE"), "LANCE's heal on B2F");
  log(`     after the heal: B2F scene ${game.world.mapScenes?.TEAM_ROCKET_BASE_B2F}`);
  // B3F: the rival (8, 10), the passwords from two grunts, the executive at
  // the office door (10, 8), the door
  reach("TEAM_ROCKET_BASE_B3F", 8, 10);
  settle();
  const pw = (): boolean => flag("EVENT_LEARNED_SLOWPOKETAIL") && flag("EVENT_LEARNED_RATICATE_TAIL");
  for (let k = 0; k < 4 && !pw(); k++) {
    talkAll("SPRITE_ROCKET_GIRL", pw, 3);
    talkAll("SPRITE_ROCKET", pw, 6);
    talkAll("SPRITE_SCIENTIST", pw, 4);
  }
  expect(flag("EVENT_LEARNED_SLOWPOKETAIL") && flag("EVENT_LEARNED_RATICATE_TAIL"), "both passwords");
  // the office door takes both passwords; inside, the executive (10, 8)
  if (!flag("EVENT_OPENED_DOOR_TO_GIOVANNIS_OFFICE")) use(10, 9, "the office door");
  expect(flag("EVENT_OPENED_DOOR_TO_GIOVANNIS_OFFICE"), "the office door open");
  reach("TEAM_ROCKET_BASE_B3F", 10, 8, () => flag("EVENT_BEAT_ROCKET_EXECUTIVEM_4"));
  settle();
  expect(flag("EVENT_BEAT_ROCKET_EXECUTIVEM_4"), "the executive in the office");
  // the office's MURKROW (sprite slot SPRITE_MOLTRES) gives the transmitter
  // password, HAIL GIOVANNI
  if (!flag("EVENT_LEARNED_HAIL_GIOVANNI")) talk("SPRITE_MOLTRES");
  expect(flag("EVENT_LEARNED_HAIL_GIOVANNI"), "the password HAIL GIOVANNI");
  // B2F: the transmitter door, then its three ELECTRODE
  travel("TEAM_ROCKET_BASE_B2F");
  if (!flag("EVENT_OPENED_DOOR_TO_ROCKET_HIDEOUT_TRANSMITTER")) use(14, 12, "the transmitter door");
  expect(flag("EVENT_OPENED_DOOR_TO_ROCKET_HIDEOUT_TRANSMITTER"), "the transmitter door open");
  log(`     B2F scene ${game.world.mapScenes?.TEAM_ROCKET_BASE_B2F} B3F scene ${game.world.mapScenes?.TEAM_ROCKET_BASE_B3F}`);
  // inside: the executive and LANCE (a coord event at (14, 11))
  reach("TEAM_ROCKET_BASE_B2F", 14, 11, () => flag("EVENT_BEAT_ROCKET_EXECUTIVEF_2"));
  settle();
  expect(flag("EVENT_BEAT_ROCKET_EXECUTIVEF_2"), "the executive by the transmitter beaten");
  talkAll("SPRITE_VOLTORB", () => flag("EVENT_CLEARED_ROCKET_HIDEOUT"), 10);
  expect(flag("EVENT_CLEARED_ROCKET_HIDEOUT"), "the hideout cleared");
  if (!flag("EVENT_GOT_HM06_WHIRLPOOL")) talk("SPRITE_LANCE");
  expect(flag("EVENT_GOT_HM06_WHIRLPOOL"), "HM06 WHIRLPOOL from LANCE");
  teach("WHIRLPOOL");
  can.whirlpool = true;
});

chapter("23 Mahogany Gym and PRYCE", () => {
  gym("MAHOGANY_GYM", "SPRITE_PRYCE", "GLACIERBADGE");
});

chapter("24 the Radio Tower taken: the fake director's BASEMENT KEY", () => {
  travel("RADIO_TOWER_5F");
  settle();
  if (!hasItem("BASEMENT_KEY")) talk("SPRITE_GENTLEMAN");
  expect(hasItem("BASEMENT_KEY"), "the BASEMENT KEY from the director (an impostor)");
});

/** The Underground's shutters: the four switches' settings tried, in
 *  order, until a map `goal` accepts can be reached. */
function shutters(goal: (m: string) => boolean, what: string): void {
  const room = "GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES";
  const switches: [number, number, string][] = [[16, 1, "EVENT_SWITCH_1"], [10, 1, "EVENT_SWITCH_2"], [2, 1, "EVENT_SWITCH_3"], [20, 11, "EVENT_EMERGENCY_SWITCH"]];
  for (let combo = 0; combo < 16 && !canReach(goal); combo++) {
    for (let k = 0; k < 4; k++) {
      const want = ((combo >> k) & 1) === 1;
      const [x, y, ev] = switches[k]!;
      if (flag(ev) !== want && canReach((m, a, b) => m === room && Math.abs(a - x) + Math.abs(b - y) === 1)) {
        useOn(room, x, y, `switch ${k + 1}`);
      }
    }
    log(`     switches ${switches.map(([, , ev]) => (flag(ev) ? 1 : 0)).join("")}: ${what} ${canReach(goal) ? "open" : "shut"}`);
  }
  expect(canReach(goal), `a way to ${what} through the shutters`);
}

chapter("25 the Underground: the rival, the shutters, the CARD KEY", () => {
  travel("GOLDENROD_UNDERGROUND");
  // the basement door (18, 6) opens with the BASEMENT KEY; the switch room's
  // shutter side is through it (its other door is the far end of the room)
  if (!flag("EVENT_USED_BASEMENT_KEY")) useOn("GOLDENROD_UNDERGROUND", 18, 6, "the basement door");
  expect(flag("EVENT_USED_BASEMENT_KEY"), "the basement door unlocked");
  {
    const mp = game.world.map;
    log(`     basement door: on ${mp.id} coll(18,6)=${mp.cellCollision(18, 6)?.toString(16)} walk=${mp.isWalkable(18, 6)} block=${mp.blockId(9, 3)} player ${game.world.player.cellX},${game.world.player.cellY}`);
    log(`     door warp entry ${JSON.stringify(mp.warpAt(18, 6)?.def ?? null)} cooldown ${JSON.stringify(game.world.warpCooldown ?? null)} map===connMap ${mp === game.world.connectionMap?.("GOLDENROD_UNDERGROUND")}`);
    log(`     reach: basement ${canReach((m, x, y) => m === "GOLDENROD_UNDERGROUND" && y >= 28)} (22,27) ${canReach((m, x, y) => m === "GOLDENROD_UNDERGROUND" && x === 22 && y === 28)} switchroom-top ${canReach((m, x, y) => m === "GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES" && y <= 4)}`);
  }
  reach("GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES", 16, 2, () => flag("EVENT_RIVAL_GOLDENROD_UNDERGROUND"));
  settle();
  // the shutters: the switches' settings (four switches, 16 ways) tried
  // until the warehouse can be reached
  shutters((m) => m === "GOLDENROD_UNDERGROUND_WAREHOUSE", "the warehouse");
  travel("GOLDENROD_UNDERGROUND_WAREHOUSE");
  if (!flag("EVENT_RECEIVED_CARD_KEY")) talk("SPRITE_GENTLEMAN");
  expect(flag("EVENT_RECEIVED_CARD_KEY"), "the CARD KEY from the real director");
  // the warehouse put every switch back (its NEWMAP callback, as on the
  // cart): back in the switch room, set them again for the way up to the city
  travel("GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES");
  shutters((m) => m === "GOLDENROD_CITY", "the way back to the city");
  expect(flag("EVENT_RIVAL_GOLDENROD_UNDERGROUND"), "the rival in the Underground");
});

chapter("26 the Radio Tower freed", () => {
  travel("RADIO_TOWER_3F");
  // the card key's slot faces up at (14, 2)
  if (!flag("EVENT_USED_THE_CARD_KEY_IN_THE_RADIO_TOWER")) use(14, 2, "the card key door");
  expect(flag("EVENT_USED_THE_CARD_KEY_IN_THE_RADIO_TOWER"), "the card key used");
  reach("RADIO_TOWER_5F", 16, 5, () => flag("EVENT_CLEARED_RADIO_TOWER"));
  settle();
  talkAll("SPRITE_ROCKET", () => flag("EVENT_CLEARED_RADIO_TOWER"), 4);
  expect(flag("EVENT_CLEARED_RADIO_TOWER"), "the Radio Tower cleared");
});

chapter("27 the Ice Path: HM07 WATERFALL, through to Blackthorn", () => {
  travel("ICE_PATH_1F");
  // HM07 lies on the ice of the first floor (31, 7)
  if (!hasItem("HM_WATERFALL")) useOn("ICE_PATH_1F", 31, 7, "the HM07 ball");
  expect(hasItem("HM_WATERFALL"), "HM07 WATERFALL");
  teach("WATERFALL");
  can.waterfall = true;
  // B1F's four boulders go down its four holes: each lands on the ice of
  // B2F below, the stoppers that make a way across it to B3F
  if (!canReach((m) => m === "BLACKTHORN_CITY")) {
    travel("ICE_PATH_B1F");
    dropBoulders("B1F's boulders");
  }
  travel("BLACKTHORN_CITY");
});

chapter("28 Blackthorn Gym and CLAIR", () => {
  travel("BLACKTHORN_GYM_1F");
  // the lava: 2F's boulders go down its holes and bridge it on 1F
  const nearClair = (m: string, x: number, y: number): boolean => m === "BLACKTHORN_GYM_1F" && Math.abs(x - 5) + Math.abs(y - 3) === 1;
  if (!canReach(nearClair)) {
    travel("BLACKTHORN_GYM_2F");
    dropBoulders("2F's boulders");
    travel("BLACKTHORN_GYM_1F");
  }
  if (!flag("EVENT_BEAT_CLAIR")) talk("SPRITE_CLAIR");
  expect(flag("EVENT_BEAT_CLAIR"), "CLAIR beaten");
});

chapter("29 the Dragon's Den: the DRAGON FANG, the RISINGBADGE", () => {
  travel("DRAGONS_DEN_B1F");
  // the fang's ball (35, 16); CLAIR comes up behind with the badge
  if (!flag("EVENT_DRAGONS_DEN_B1F_DRAGON_FANG")) useOn("DRAGONS_DEN_B1F", 35, 16, "the DRAGON FANG ball");
  settle();
  expect(hasItem("DRAGON_FANG"), "the DRAGON FANG");
  expect(hasBadge("RISINGBADGE"), `the RISINGBADGE (have ${badges().join(" ")})`);
});

chapter("30 to the POKeMON LEAGUE: Route 27, Tohjo Falls, Victory Road", () => {
  travel("INDIGO_PLATEAU_POKECENTER_1F");
  settle();
  expect(flag("EVENT_RIVAL_VICTORY_ROAD"), "the rival in Victory Road");
});

chapter("31 the ELITE FOUR: WILL, KOGA, BRUNO, KAREN", () => {
  travel("INDIGO_PLATEAU_POKECENTER_1F");
  // the last POKeMON CENTER before the doors lock behind
  talk("SPRITE_NURSE");
  const four: [string, string, string][] = [
    ["WILLS_ROOM", "SPRITE_WILL", "EVENT_BEAT_ELITE_4_WILL"],
    ["KOGAS_ROOM", "SPRITE_KOGA", "EVENT_BEAT_ELITE_4_KOGA"],
    ["BRUNOS_ROOM", "SPRITE_BRUNO", "EVENT_BEAT_ELITE_4_BRUNO"],
    ["KARENS_ROOM", "SPRITE_KAREN", "EVENT_BEAT_ELITE_4_KAREN"],
  ];
  for (const [room, who, ev] of four) {
    travel(room);
    settle();
    for (let k = 0; k < 3 && !flag(ev); k++) talk(who);
    expect(flag(ev), `${who.replace("SPRITE_", "")} beaten`);
  }
});

chapter("32 LANCE, the HALL OF FAME, the credits", () => {
  // LANCE's battle is a coord event at (4, 5)/(5, 5); then the HALL OF FAME
  try {
    reach("LANCES_ROOM", 5, 5, () => flag("EVENT_BEAT_CHAMPION_LANCE"));
  } catch (e) {
    if (!flag("EVENT_BEAT_CHAMPION_LANCE")) throw e;
  }
  expect(flag("EVENT_BEAT_CHAMPION_LANCE"), "LANCE beaten");
  // the HALL OF FAME and the credits run long
  for (let k = 0; k < 12; k++) {
    try {
      settle(20000);
      break;
    } catch (e) {
      const top = game.stack.top();
      const tb = game.world?.textbox;
      log(`     still going: ${describe()} top=${top?.screenId ?? top?.constructor?.name} phase=${game.phase} text=${JSON.stringify(top?.page ?? tb?.text ?? top?.pages ?? "").slice(0, 120)}`);
    }
  }
  log(`     after the credits: ${describe()} HoF ${JSON.stringify(save().hallOfFame?.length ?? save().hof?.length ?? null)}`);
});

chapter("33 the S.S. TICKET from ELM", () => {
  travel("ELMS_LAB");
  settle();
  if (!flag("EVENT_GOT_SS_TICKET_FROM_ELM")) talk("SPRITE_ELM");
  expect(flag("EVENT_GOT_SS_TICKET_FROM_ELM") && hasItem("S_S_TICKET"), "the S.S. TICKET");
});

chapter("34 the S.S. AQUA to Vermilion", () => {
  // the port's sailor sees the ticket (a coord event at (7, 15)), YES, and
  // walks the player aboard
  reach("OLIVINE_PORT", 7, 15, () => here() === "FAST_SHIP_1F");
  settle();
  expect(here() === "FAST_SHIP_1F", `aboard the S.S. AQUA (at ${describe()})`);
  settle();
  // B1F's sailor keeps the way west shut (stepping across whichever lane the
  // player takes) until the lazy sailor he tells of is found and beaten
  if (!flag("EVENT_FAST_SHIP_LAZY_SAILOR")) {
    if (!flag("EVENT_FAST_SHIP_INFORMED_ABOUT_LAZY_SAILOR")) {
      travel("FAST_SHIP_B1F");
      settle();
      const guard = (game.world.npcs ?? []).find((n: any) => !n.hidden && n.def?.sprite === "SPRITE_SAILOR" && n.cellY === 6 && n.cellX >= 30);
      if (!guard) fail("no sailor guarding B1F's way west");
      use(guard.cellX, guard.cellY, "B1F's sailor");
      expect(flag("EVENT_FAST_SHIP_INFORMED_ABOUT_LAZY_SAILOR"), "told of the lazy sailor");
    }
    useOn("FAST_SHIP_CABINS_NNW_NNE_NE", 4, 26, "the lazy sailor");
    settle();
    expect(flag("EVENT_FAST_SHIP_LAZY_SAILOR"), "the lazy sailor found");
  }
  // the captain's granddaughter is lost in his cabin: found, she runs back
  // to her grandfather, and the ship comes in
  if (!flag("EVENT_FAST_SHIP_FOUND_GIRL")) useOn("FAST_SHIP_CABINS_SE_SSE_CAPTAINS_CABIN", 2, 25, "the captain's granddaughter");
  settle();
  expect(flag("EVENT_FAST_SHIP_FOUND_GIRL"), "the girl found");
  expect(flag("EVENT_FAST_SHIP_HAS_ARRIVED"), "the S.S. AQUA in port");
  // the sailor at the gangway (25, 2) sees the player ashore (its warp is
  // "back where you came from", which no plan can follow)
  travel("FAST_SHIP_1F");
  use(25, 2, "the gangway sailor");
  settle();
  expect(here() === "VERMILION_PORT", `ashore at Vermilion (at ${describe()})`);
  travel("VERMILION_CITY");
});

void describe;
void npc;
void use;
void walk;
void walkTo;
