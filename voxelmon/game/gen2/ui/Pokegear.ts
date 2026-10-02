// The POKeGEAR: a port of gen1recomp src/ui/gen2/Pokegear.lua (bdfac727,
// MIT) -- engine/pokegear/pokegear.asm: Gen 2's clock, town map, radio and
// phone in one device.
//
// Transcribed rather than laid out by eye. A Pokegear card is a tilemap:
// InitPokegearTilemap fills the screen with $4f, runs the card's own entry,
// and Pokegear_FinishTilemap lays the card strip across the top two rows.
// Three of the four cards are RLE tilemaps in the ROM and the MAP card is the
// painted region map (JohtoMap / KantoMap); the importer hands all of them
// over as 20x18 tile-id grids (menu_gfx.json `pokegear`).
//
// Both sheets live in one 96-tile block: TownMapGFX at $00 and PokegearGFX at
// $30, so a tilemap byte under $30 is town map art and anything above it is
// gear chrome. Colour is by tile id: TownMapPals reads a nybble per tile out
// of its PalMap, with $60 and up falling back to palette 0.
//
// Card strip (Pokegear_FinishTilemap): the two rows are cleared to $4f, then
// each owned card's 2x2 icon is laid as n, n+1 / n+$10, n+$11 -- MAP at (2,0)
// from $40, PHONE at (4,0) from $44, RADIO at (6,0) from $42, and the gear
// itself at (0,0) from $46.
//
// On the Gold screen every tilemap byte is a cell and the arrow, the map
// cursor, the player icon and the tuning knob are objects, exactly as on the
// cart.

import { format, truthy } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";
import G, { type LcdImage, cachedBlock, keyOf } from "../platform/screen.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { FlagNames } from "../core/FlagNames.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { Clock } from "../core/Clock.ts";
import { CommonText } from "../core/CommonText.ts";
import { Font } from "../shared/render/Font.ts";
import { Palettes } from "../world/Palettes.ts";
import { Phone } from "../core/Phone.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Music } from "../shared/core/Music.ts";
import { Strings } from "../shared/core/Strings.ts";

type Colors = readonly (readonly number[])[];

// Lua: Pokegear.lua:41
const SCREEN_W = 20;
const SCREEN_H = 18;
const BLANK_TILE = 0x4f;

export interface PokegearCard {
  id: string;
  label: string;
  flag?: string;
  icon?: number;
  iconX?: number;
}

// Lua: Pokegear.lua:52 -- POKEGEARCARD_* order (CLOCK, MAP, PHONE, RADIO),
// with the icon each one contributes to the strip. Paging steps this list
// and AnimatePokegearModeIndicatorArrow indexes its x offsets by it.
const CARDS: PokegearCard[] = [
  { id: "clock", label: Strings.source("CLOCK"), icon: 0x46, iconX: 0 },
  { id: "map", label: Strings.source("MAP"), flag: "map", icon: 0x40, iconX: 2 },
  { id: "phone", label: Strings.source("PHONE"), flag: "phone", icon: 0x44, iconX: 4 },
  { id: "radio", label: Strings.source("RADIO"), flag: "radio", icon: 0x42, iconX: 6 },
];

// Lua: Pokegear.lua:63 -- _FlyMap's one-row card list: no strip, no
// ENGINE_MAP_CARD gate.
const FLY_MAP_CARD: PokegearCard = { id: "map", label: Strings.source("FLY") };

// Lua: Pokegear.lua:67 -- _TownMap (the wall map / DECO_TOWN_MAP poster).
const TOWN_MAP_CARD: PokegearCard = { id: "map", label: Strings.source("MAP") };
const AM_LABEL = Strings.source("AM");
const PM_LABEL = Strings.source("PM");
const DAY_LABEL = Strings.source("DAY");

// Lua: Pokegear.lua:72
function meridiem(hour: number): string {
  return Strings.get(hour < 12 ? AM_LABEL : PM_LABEL);
}

// ---------------------------------------------------------------- the radio
//
// engine/pokegear/radio.asm is a jumptable of code: every station is a little
// state machine whose segments each print ONE line and name the segment that
// prints the next. What follows transcribes RadioJumptable row by row, with
// the constants/radio_constants.asm segment names.

// Lua: Pokegear.lua:96 -- channel ids; only PlayRadioShow's
// `cp POKE_FLUTE_RADIO` Rocket override reads the numbers.
const RADIO_ID: Record<string, number> = {
  OAKS_POKEMON_TALK: 0x00, POKEDEX_SHOW: 0x01, POKEMON_MUSIC: 0x02,
  LUCKY_CHANNEL: 0x03, PLACES_AND_PEOPLE: 0x04, LETS_ALL_SING: 0x05,
  ROCKET_RADIO: 0x06, POKE_FLUTE_RADIO: 0x07, UNOWN_RADIO: 0x08,
  EVOLUTION_RADIO: 0x09,
};

// Lua: Pokegear.lua:105 -- data/radio/channel_music.asm, as Music_* labels.
const RADIO_CHANNEL_SONGS: Record<string, string> = {
  OAKS_POKEMON_TALK: "Music_ProfOaksPokemonTalk", // MUSIC_POKEMON_TALK
  POKEDEX_SHOW: "Music_PokemonCenter", // MUSIC_POKEMON_CENTER
  POKEMON_MUSIC: "Music_TitleScreen", // MUSIC_TITLE
  LUCKY_CHANNEL: "Music_GameCorner", // MUSIC_GAME_CORNER
  PLACES_AND_PEOPLE: "Music_ViridianCity", // MUSIC_VIRIDIAN_CITY
  LETS_ALL_SING: "Music_Bicycle", // MUSIC_BICYCLE
  ROCKET_RADIO: "Music_RocketTheme", // MUSIC_ROCKET_OVERTURE
  POKE_FLUTE_RADIO: "Music_PokeFluteChannel",
  UNOWN_RADIO: "Music_RuinsOfAlphRadio",
  EVOLUTION_RADIO: "Music_LakeOfRageRocketRadio",
};

// Lua: Pokegear.lua:124 -- the *Name labels LoadStation_* hands the tuner.
// LoadStation_RocketRadio reuses LetsAllSingName and LoadStation_EvolutionRadio
// reuses UnownStationName.
const STATION_NAMES: Record<string, string> = {
  OAKS_POKEMON_TALK: "OAK's <PK><MN> Talk",
  POKEDEX_SHOW: "POKéDEX Show",
  POKEMON_MUSIC: "POKéMON Music",
  LUCKY_CHANNEL: "Lucky Channel",
  PLACES_AND_PEOPLE: "Places & People",
  LETS_ALL_SING: "Let's All Sing!",
  ROCKET_RADIO: "Let's All Sing!",
  POKE_FLUTE_RADIO: "POKé FLUTE",
  UNOWN_RADIO: "?????",
  EVOLUTION_RADIO: "?????",
};

// Lua: Pokegear.lua:139 -- OaksPKMNTalk8.Adverbs (`maskbits 16`: no retry).
const OPT_ADVERBS: string[] = [
  Strings.source("sweet and adorably"), Strings.source("wiggly and slickly"),
  Strings.source("aptly named and"), Strings.source("undeniably kind of"),
  Strings.source("so, so unbearably"), Strings.source("wow, impressively"),
  Strings.source("almost poisonously"), Strings.source("ooh, so sensually"),
  Strings.source("so mischievously"), Strings.source("so very topically"),
  Strings.source("sure addictively"), Strings.source("looks in water is"),
  Strings.source("evolution must be"), Strings.source("provocatively"),
  Strings.source("so flipped out and"), Strings.source("heart-meltingly"),
];

// Lua: Pokegear.lua:151 -- OaksPKMNTalk9.Adjectives.
const OPT_ADJECTIVES: string[] = [
  Strings.source("cute."), Strings.source("weird."),
  Strings.source("pleasant."), Strings.source("bold, sort of."),
  Strings.source("frightening."), Strings.source("suave & debonair!"),
  Strings.source("powerful."), Strings.source("exciting."),
  Strings.source("now!"), Strings.source("inspiring."),
  Strings.source("friendly."), Strings.source("hot, hot, hot!"),
  Strings.source("stimulating."), Strings.source("guarded."),
  Strings.source("lovely."), Strings.source("speedy."),
];

// Lua: Pokegear.lua:164 -- PeoplePlaces5/7.Adjectives (the same sixteen).
const PNP_ADJECTIVES: string[] = [
  Strings.source("is cute."), Strings.source("is sort of lazy."),
  Strings.source("is always happy."), Strings.source("is quite noisy."),
  Strings.source("is precocious."), Strings.source("is somewhat bold."),
  Strings.source("is too picky!"), Strings.source("is sort of OK."),
  Strings.source("is just so-so."), Strings.source("is actually great."),
  Strings.source("is just my type."), Strings.source("is so cool, no?"),
  Strings.source("is inspiring!"), Strings.source("is kind of weird."),
  Strings.source("is right for me?"), Strings.source("is definitely odd!"),
];

// Lua: Pokegear.lua:177 -- RocketRadioText1..10; the text_pause bytes inside
// 7-10 only stall the printer, so the words either side are one line.
const ROCKET_LINES: string[] = [
  Strings.source("… …Ahem, we are"), Strings.source("TEAM ROCKET!"),
  Strings.source("After three years"), Strings.source("of preparation, we"),
  Strings.source("have risen again"), Strings.source("from the ashes!"),
  Strings.source("GIOVANNI! Can you"), Strings.source("hear? We did it!"),
  Strings.source("Where is our Boss?"), Strings.source("Is he listening?"),
];

// Lua: Pokegear.lua:188 -- data/radio/oaks_pkmn_talk_routes.asm. `and %11111`
// then `cp 15` is a rejection roll.
const OPT_ROUTES: string[] = [
  "ROUTE_29", "ROUTE_46", "ROUTE_30", "ROUTE_32", "ROUTE_34", "ROUTE_35",
  "ROUTE_37", "ROUTE_38", "ROUTE_39", "ROUTE_42", "ROUTE_43", "ROUTE_44",
  "ROUTE_45", "ROUTE_36", "ROUTE_31",
];

// Lua: Pokegear.lua:197 -- data/radio/pnp_places.asm.
const PNP_PLACES: string[] = [
  "PALLET_TOWN", "ROUTE_22", "PEWTER_CITY", "CERULEAN_POLICE_STATION",
  "ROUTE_12", "ROUTE_11", "ROUTE_16", "ROUTE_14",
  "CINNABAR_POKECENTER_2F_BETA",
];

// Lua: Pokegear.lua:208 -- data/radio/pnp_hidden_people.asm, one list with
// two interior labels that fall through into each other.
const PNP_HIDDEN: string[] = [
  "WILL", "BRUNO", "KAREN", "KOGA", "CHAMPION",
  // PnP_HiddenPeople_BeatE4
  "BROCK", "MISTY", "LT_SURGE", "ERIKA", "JANINE", "SABRINA", "BLAINE",
  "BLUE",
  // PnP_HiddenPeople_BeatKanto
  "RIVAL1", "POKEMON_PROF", "CAL", "RIVAL2", "RED",
];
const PNP_HIDDEN_BEAT_E4 = 6; // Lua: Pokegear.lua:216 (1-based, as the Lua)
const PNP_HIDDEN_BEAT_KANTO = 14; // Lua: Pokegear.lua:217

// Lua: Pokegear.lua:221 -- TextCommand_DAY's .Days; GetWeekday counts from
// Sunday = 0.
const RADIO_DAYS: string[] = [
  Strings.source("SUNDAY"), Strings.source("MONDAY"),
  Strings.source("TUESDAY"), Strings.source("WEDNESDAY"),
  Strings.source("THURSDAY"), Strings.source("FRIDAY"),
  Strings.source("SATURDAY"),
];

// Lua: Pokegear.lua:230 -- macros/data.asm `percent` is `* $ff / 100`.
const PNP_PEOPLE_CHANCE = Math.floor((49 * 255) / 100) - 1; // 49 percent - 1
const PNP_RESTART_CHANCE = Math.floor((4 * 255) / 100); // 4 percent

// Lua: Pokegear.lua:238 -- a landmark name keeps its town-map line break;
// the radio spends it as a space so the sentence stays one line.
function flatName(name: unknown): string {
  return String(name ?? "").split("\n").join(" ");
}

// Lua: Pokegear.lua:246 -- tiles in a plain string ("é" is one tile).
function tileWidth(text: unknown): number {
  return [...String(text ?? "")].length;
}

// --------------------------------------------------------- the show machine

/** Lua: Pokegear.lua:258 -- the cache reads the shows need (Pokegear:radioData). */
export interface RadioData {
  inJohto?: boolean;
  landmarks?: Record<number, { name?: string; [k: string]: any }>;
  mapLandmark?: Record<string, number>;
  /** grass[map] = [morn, day, nite] species lists (0-based). */
  grass?: Record<string, (string | undefined)[][]>;
  species?: Record<number, string>;
  dex?: Record<string, { kind?: string; lines: string[] }>;
  classes?: Record<number, { name?: string; trainer?: string }>;
  hidden?: Record<number, boolean>;
  caught?: (name: string) => boolean;
  weekday?: number;
  luckyNumber?: number;
  rocketsInRadioTower?: boolean;
  [k: string]: any;
}

export interface RadioOpts {
  data?: RadioData;
  rng?: () => number;
}

// Lua: Pokegear.lua:274 -- PlaceRadioString / PrintRadioLine both wait 100
// frames; the Pokemon Channel jingle's last hop waits 10.
const RADIO_LINE_FRAMES = 100;
const RADIO_JINGLE_FRAMES = 10;

// Lua: Pokegear.lua:316 -- every rejection sampler is capped.
const RADIO_SAMPLE_TRIES = 512;

type Segment = (R: Radio) => void;
// Lua: Pokegear.lua:277
const RadioJumptable: Record<string, Segment> = {};

/**
 * Lua: Pokegear.lua:269 -- the jumptable and its four bytes of RAM, stepped
 * one frame at a time; free of drawing so a test can seed `rng`.
 */
export class Radio {
  [key: string]: any;
  data: RadioData;
  rng: () => number;
  /** wCurRadioLine / wNextRadioLine / wRadioTextDelay / wNumRadioLinesPrinted */
  cur: string | undefined;
  next: string | undefined;
  delay: number;
  printed: number;
  /** The bottom text box's two lines. */
  top: string;
  bottom: string;
  log: string[];
  vars: Record<string, any>;
  music: string | undefined;
  /** wRadioText: the last line composed into the buffer. */
  text: string | undefined;

  // Lua: Pokegear.lua:279
  constructor(opts?: RadioOpts) {
    const o = opts ?? {};
    this.data = o.data ?? {};
    // `call Random` yields one byte.
    this.rng = o.rng ?? (() => random(0, 255));
    this.cur = undefined;
    this.next = undefined;
    this.delay = 0;
    this.printed = 0;
    this.top = "";
    this.bottom = "";
    this.log = [];
    this.vars = {};
    this.music = undefined;
    this.text = undefined;
  }

  static new(opts?: RadioOpts): Radio {
    return new Radio(opts);
  }

  // Lua: Pokegear.lua:306 -- `call Random`: one byte, 0..255.
  random(): number {
    const v = Math.floor(this.rng() || 0);
    return ((v % 256) + 256) % 256;
  }

  // Lua: Pokegear.lua:318
  sample<T>(pick: (roll: number) => T | undefined): T | undefined {
    for (let i = 0; i < RADIO_SAMPLE_TRIES; i++) {
      const value = pick(this.random());
      if (value !== undefined) return value;
    }
    return undefined;
  }

  // Lua: Pokegear.lua:329 -- LoadStation_*.
  tune(station: string | undefined): void {
    this.cur = station;
    this.next = undefined;
    this.delay = 0;
    this.printed = 0;
    this.top = "";
    this.bottom = "";
    this.log = [];
    this.vars = {};
    this.music = undefined;
  }

  // Lua: Pokegear.lua:342 -- StartRadioStation.
  startStation(): void {
    if (this.printed !== 0) return;
    this.top = "";
    this.bottom = "";
    this.music = this.cur !== undefined ? RADIO_CHANNEL_SONGS[this.cur] : undefined;
  }

  // Lua: Pokegear.lua:351 -- PrintRadioLine.
  printLine(text: string, nextLine: string | undefined): void {
    this.next = nextLine;
    this.text = text;
    if (this.printed < 2) {
      this.printed = this.printed + 1;
      if (this.printed === 1) this.top = text;
      else this.bottom = text;
    } else {
      this.bottom = text;
    }
    this.log.push(text);
    this.cur = "RADIO_SCROLL";
    this.delay = RADIO_LINE_FRAMES;
  }

  // Lua: Pokegear.lua:371 -- NextRadioLine is PrintRadioLine with an
  // invisible CopyRadioTextToRAM in front.
  nextLine(text: string, nextLine: string | undefined): void {
    this.printLine(text, nextLine);
  }

  // Lua: Pokegear.lua:376 -- PlaceRadioString.
  placeString(nextLine: string): void {
    this.cur = nextLine;
    this.delay = RADIO_LINE_FRAMES;
  }

  // Lua: Pokegear.lua:382 -- one frame of PlayRadioShow, with the Rocket
  // takeover between shows.
  step(): void {
    const id = this.cur !== undefined ? RADIO_ID[this.cur] : undefined;
    if (id !== undefined && id < RADIO_ID.POKE_FLUTE_RADIO!
      && truthy(this.data.rocketsInRadioTower) && truthy(this.data.inJohto)) {
      this.cur = "ROCKET_RADIO";
    }
    const segment = this.cur !== undefined ? RadioJumptable[this.cur] : undefined;
    if (segment) segment(this);
  }
}

// Lua: Pokegear.lua:399 -- RadioScroll.
RadioJumptable["RADIO_SCROLL"] = (R) => {
  if (R.delay !== 0) {
    R.delay = R.delay - 1;
    return;
  }
  R.cur = R.next;
  if (R.printed !== 1) R.top = R.bottom;
  R.bottom = "";
};

// ----------------------------------------------------- Oak's Pokemon Talk

// Lua: Pokegear.lua:415
RadioJumptable["OAKS_POKEMON_TALK"] = (R) => {
  R.vars.segmentCounter = 5;
  R.startStation();
  R.nextLine(Strings.get("MARY: PROF.OAK'S"), "OAKS_POKEMON_TALK_2");
};

// Lua: Pokegear.lua:421
RadioJumptable["OAKS_POKEMON_TALK_2"] = (R) => {
  R.nextLine(Strings.get("POKéMON TALK!"), "OAKS_POKEMON_TALK_3");
};

// Lua: Pokegear.lua:425
RadioJumptable["OAKS_POKEMON_TALK_3"] = (R) => {
  R.nextLine(Strings.get("With me, MARY!"), "OAKS_POKEMON_TALK_4");
};

// Lua: Pokegear.lua:431 -- OaksPKMNTalk4: a route, a time of day, one of the
// middle three grass slots.
RadioJumptable["OAKS_POKEMON_TALK_4"] = (R) => {
  const map = R.sample((roll) => {
    const r = roll % 32;
    return r < OPT_ROUTES.length ? OPT_ROUTES[r] : undefined;
  });
  if (map === undefined) return;
  const slots = R.data.grass ? R.data.grass[map] : undefined;
  if (!slots) {
    // .overflow: reprint wRadioText and restart the show.
    R.printLine(R.text ?? "", "OAKS_POKEMON_TALK");
    return;
  }
  // .loop2: `maskbits NUM_DAYTIMES` then reject DARKNESS_F.
  const daytime = R.sample((roll) => {
    const r = roll % 4;
    return r !== 3 ? r : undefined;
  });
  // .loop3: the middle three of the seven slots.
  const slot = R.sample((roll) => {
    const r = roll % 8;
    return r >= 2 && r < 5 ? r : undefined;
  });
  if (daytime === undefined || slot === undefined) return;
  const list = slots[daytime] ?? slots[0] ?? [];
  const species = list[slot];
  R.vars.species = species;
  R.vars.landmark = R.data.mapLandmark ? R.data.mapLandmark[map] : undefined;
  R.printLine(Strings.get("OAK: %s", String(species ?? "")), "OAKS_POKEMON_TALK_5");
};

// Lua: Pokegear.lua:468
RadioJumptable["OAKS_POKEMON_TALK_5"] = (R) => {
  R.nextLine(Strings.get("may be seen around"), "OAKS_POKEMON_TALK_6");
};

// Lua: Pokegear.lua:472 -- _OPT_OakText3: the landmark name and a full stop.
RadioJumptable["OAKS_POKEMON_TALK_6"] = (R) => {
  const entry = R.data.landmarks && R.vars.landmark != null ? R.data.landmarks[R.vars.landmark] : undefined;
  R.nextLine(Strings.get("%s.", flatName(entry ? entry.name : undefined)), "OAKS_POKEMON_TALK_7");
};

// Lua: Pokegear.lua:479
RadioJumptable["OAKS_POKEMON_TALK_7"] = (R) => {
  R.nextLine(Strings.get("MARY: %s's", String(R.vars.species ?? "")), "OAKS_POKEMON_TALK_8");
};

// Lua: Pokegear.lua:484
RadioJumptable["OAKS_POKEMON_TALK_8"] = (R) => {
  const adverb = OPT_ADVERBS[R.random() % 16]!;
  R.nextLine(Strings.get(adverb), "OAKS_POKEMON_TALK_9");
};

// Lua: Pokegear.lua:491 -- the adjective rolls before the counter is spent.
RadioJumptable["OAKS_POKEMON_TALK_9"] = (R) => {
  const adjective = OPT_ADJECTIVES[R.random() % 16]!;
  R.vars.segmentCounter = (R.vars.segmentCounter ?? 1) - 1;
  let nextLine = "OAKS_POKEMON_TALK_4";
  if (R.vars.segmentCounter === 0) {
    R.vars.segmentCounter = 5;
    nextLine = "OAKS_POKEMON_TALK_10";
  }
  R.nextLine(Strings.get(adjective), nextLine);
};

// Lua: Pokegear.lua:506 -- the Pokemon Channel jingle: PrintText, no scroll.
RadioJumptable["OAKS_POKEMON_TALK_10"] = (R) => {
  R.music = "Music_PokemonChannel"; // RadioMusicRestartPokemonChannel
  R.top = Strings.get("POKéMON");
  R.bottom = "";
  R.log.push(R.top);
  R.cur = "OAKS_POKEMON_TALK_11";
  R.delay = RADIO_LINE_FRAMES;
};

// Lua: Pokegear.lua:516 -- `hlcoord 9, 14`.
RadioJumptable["OAKS_POKEMON_TALK_11"] = (R) => {
  R.delay = R.delay - 1;
  if (R.delay !== 0) return;
  R.top = R.top + " ".repeat(Math.max(0, 8 - tileWidth(R.top))) + Strings.get("POKéMON");
  R.log.push(R.top);
  R.placeString("OAKS_POKEMON_TALK_12");
};

// Lua: Pokegear.lua:525
RadioJumptable["OAKS_POKEMON_TALK_12"] = (R) => {
  R.delay = R.delay - 1;
  if (R.delay !== 0) return;
  R.bottom = Strings.get("POKéMON Channel"); // hlcoord 1, 16
  R.log.push(R.bottom);
  R.placeString("OAKS_POKEMON_TALK_13");
};

// Lua: Pokegear.lua:535 -- a bare "@": only buys another 100 frames.
RadioJumptable["OAKS_POKEMON_TALK_13"] = (R) => {
  R.delay = R.delay - 1;
  if (R.delay !== 0) return;
  R.placeString("OAKS_POKEMON_TALK_14");
};

// Lua: Pokegear.lua:544 -- back to the talk, box wiped, line count reset.
RadioJumptable["OAKS_POKEMON_TALK_14"] = (R) => {
  R.delay = R.delay - 1;
  if (R.delay !== 0) return;
  R.music = "Music_ProfOaksPokemonTalk"; // MUSIC_POKEMON_TALK
  R.top = "";
  R.bottom = "";
  R.next = "OAKS_POKEMON_TALK_4";
  R.printed = 0;
  R.cur = "RADIO_SCROLL";
  R.delay = RADIO_JINGLE_FRAMES;
};

// ------------------------------------------------------------ Pokedex Show

// Lua: Pokegear.lua:560 -- `cp NUM_POKEMON`, then CheckCaughtMon.
RadioJumptable["POKEDEX_SHOW"] = (R) => {
  R.startStation();
  const species = R.sample((roll) => {
    if (roll >= 251) return undefined;
    const name = R.data.species ? R.data.species[roll + 1] : undefined;
    if (!name) return undefined;
    if (R.data.caught && !R.data.caught(name)) return undefined;
    return name;
  });
  if (species === undefined) return;
  R.vars.species = species;
  R.nextLine(species, "POKEDEX_SHOW_2");
};

// Lua: Pokegear.lua:581 -- the entry's own start: the species kind.
RadioJumptable["POKEDEX_SHOW_2"] = (R) => {
  const entry = R.data.dex ? R.data.dex[R.vars.species] : undefined;
  R.printLine((entry && entry.kind) || "", "POKEDEX_SHOW_3");
};

// Lua: Pokegear.lua:589 -- PokedexShow3..8, the same routine six times.
const POKEDEX_SHOW_SEGMENTS = [
  "POKEDEX_SHOW_3", "POKEDEX_SHOW_4", "POKEDEX_SHOW_5", "POKEDEX_SHOW_6",
  "POKEDEX_SHOW_7", "POKEDEX_SHOW_8",
];
POKEDEX_SHOW_SEGMENTS.forEach((segment, index) => {
  RadioJumptable[segment] = (R) => {
    const entry = R.data.dex ? R.data.dex[R.vars.species] : undefined;
    const lines = (entry && entry.lines) || [];
    R.printLine(lines[index] ?? "", POKEDEX_SHOW_SEGMENTS[index + 1] ?? "POKEDEX_SHOW");
  };
});

// --------------------------------------- Pokemon Music / Let's All Sing

// Lua: Pokegear.lua:610 -- StartPokemonMusicChannel: the weekday's low bit.
function startPokemonMusicChannel(R: Radio): void {
  R.top = "";
  R.bottom = "";
  const odd = (R.data.weekday ?? 0) % 2 === 1;
  R.music = odd ? "Music_PokemonLullaby" : "Music_PokemonMarch";
}

// Lua: Pokegear.lua:616
RadioJumptable["POKEMON_MUSIC"] = (R) => {
  startPokemonMusicChannel(R);
  R.nextLine(Strings.get("BEN: POKéMON MUSIC"), "POKEMON_MUSIC_2");
};

// Lua: Pokegear.lua:621
RadioJumptable["POKEMON_MUSIC_2"] = (R) => {
  R.nextLine(Strings.get("CHANNEL!"), "POKEMON_MUSIC_3");
};

// Lua: Pokegear.lua:625
RadioJumptable["POKEMON_MUSIC_3"] = (R) => {
  R.nextLine(Strings.get("It's me, DJ BEN!"), "POKEMON_MUSIC_4");
};

// Lua: Pokegear.lua:629
RadioJumptable["LETS_ALL_SING"] = (R) => {
  startPokemonMusicChannel(R);
  R.nextLine(Strings.get("FERN: POKéMUSIC!"), "LETS_ALL_SING_2");
};

// Lua: Pokegear.lua:636 -- the handoff into Johto's code.
RadioJumptable["LETS_ALL_SING_2"] = (R) => {
  R.nextLine(Strings.get("With DJ FERN!"), "POKEMON_MUSIC_4");
};

// Lua: Pokegear.lua:640
RadioJumptable["POKEMON_MUSIC_4"] = (R) => {
  const days = RADIO_DAYS[(((R.data.weekday ?? 0) % 7) + 7) % 7];
  const day = Strings.get(days ?? "");
  R.nextLine(Strings.get("Today's %s,", day), "POKEMON_MUSIC_5");
};

// Lua: Pokegear.lua:645
RadioJumptable["POKEMON_MUSIC_5"] = (R) => {
  const odd = (R.data.weekday ?? 0) % 2 === 1;
  R.nextLine(odd ? Strings.get("so chill out to") : Strings.get("so let us jam to"), "POKEMON_MUSIC_6");
};

// Lua: Pokegear.lua:652
RadioJumptable["POKEMON_MUSIC_6"] = (R) => {
  const odd = (R.data.weekday ?? 0) % 2 === 1;
  R.nextLine(odd ? Strings.get("POKéMON Lullaby!") : Strings.get("POKéMON March!"), "POKEMON_MUSIC_7");
};

// Lua: Pokegear.lua:660 -- BenFernMusic7 is a bare `ret`.
RadioJumptable["POKEMON_MUSIC_7"] = () => {};

// ------------------------------------------------------- Lucky Number Show

// Lua: Pokegear.lua:667
const LUCKY_LINES: Record<string, [string, string]> = {
  LUCKY_CHANNEL: [Strings.source("REED: Yeehaw! How"), "LUCKY_NUMBER_SHOW_2"],
  LUCKY_NUMBER_SHOW_2: [Strings.source("y'all doin' now?"), "LUCKY_NUMBER_SHOW_3"],
  LUCKY_NUMBER_SHOW_3: [Strings.source("Whether you're up"), "LUCKY_NUMBER_SHOW_4"],
  LUCKY_NUMBER_SHOW_4: [Strings.source("or way down low,"), "LUCKY_NUMBER_SHOW_5"],
  LUCKY_NUMBER_SHOW_5: [Strings.source("don't you miss the"), "LUCKY_NUMBER_SHOW_6"],
  LUCKY_NUMBER_SHOW_6: [Strings.source("LUCKY NUMBER SHOW!"), "LUCKY_NUMBER_SHOW_7"],
  LUCKY_NUMBER_SHOW_7: [Strings.source("This week's Lucky"), "LUCKY_NUMBER_SHOW_8"],
  LUCKY_NUMBER_SHOW_9: [Strings.source("I'll repeat that!"), "LUCKY_NUMBER_SHOW_10"],
  // LC_Text7 and LC_Text8 again: the number read out a second time.
  LUCKY_NUMBER_SHOW_10: [Strings.source("This week's Lucky"), "LUCKY_NUMBER_SHOW_11"],
  LUCKY_NUMBER_SHOW_12: [Strings.source("Match it and go to"), "LUCKY_NUMBER_SHOW_13"],
  LUCKY_NUMBER_SHOW_14: [Strings.source("…Repeating myself"), "LUCKY_NUMBER_SHOW_15"],
  LUCKY_NUMBER_SHOW_15: [Strings.source("gets to be a drag…"), "LUCKY_CHANNEL"],
};
// Lua: Pokegear.lua:682
for (const segment of Object.keys(LUCKY_LINES)) {
  const row = LUCKY_LINES[segment]!;
  RadioJumptable[segment] = (R) => {
    if (segment === "LUCKY_CHANNEL") R.startStation();
    R.nextLine(Strings.get(row[0]), row[1]);
  };
}

// Lua: Pokegear.lua:691 -- PRINTNUM_LEADINGZEROS over five digits.
function luckyNumberLine(R: Radio): string {
  return Strings.get("Number is %05d!", Math.floor(R.data.luckyNumber ?? 0) % 100000);
}

// Lua: Pokegear.lua:696
RadioJumptable["LUCKY_NUMBER_SHOW_8"] = (R) => {
  R.nextLine(luckyNumberLine(R), "LUCKY_NUMBER_SHOW_9");
};

// Lua: Pokegear.lua:700
RadioJumptable["LUCKY_NUMBER_SHOW_11"] = (R) => {
  R.nextLine(luckyNumberLine(R), "LUCKY_NUMBER_SHOW_12");
};

// Lua: Pokegear.lua:706 -- only a rolled zero takes the drag lines.
RadioJumptable["LUCKY_NUMBER_SHOW_13"] = (R) => {
  const roll = R.random();
  R.nextLine(Strings.get("the RADIO TOWER!"), roll !== 0 ? "LUCKY_CHANNEL" : "LUCKY_NUMBER_SHOW_14");
};

// ------------------------------------------------------- Places and People

// Lua: Pokegear.lua:717
RadioJumptable["PLACES_AND_PEOPLE"] = (R) => {
  R.startStation();
  R.nextLine(Strings.get("PLACES AND PEOPLE!"), "PLACES_AND_PEOPLE_2");
};

// Lua: Pokegear.lua:722
RadioJumptable["PLACES_AND_PEOPLE_2"] = (R) => {
  R.nextLine(Strings.get("Brought to you by"), "PLACES_AND_PEOPLE_3");
};

// Lua: Pokegear.lua:728 -- `cp 49 percent - 1` / `jr c` takes People.
function peopleOrPlaces(R: Radio): string {
  return R.random() < PNP_PEOPLE_CHANCE ? "PLACES_AND_PEOPLE_4" : "PLACES_AND_PEOPLE_6";
}

// Lua: Pokegear.lua:733
RadioJumptable["PLACES_AND_PEOPLE_3"] = (R) => {
  R.nextLine(Strings.get("me, DJ LILY!"), peopleOrPlaces(R));
};

// Lua: Pokegear.lua:739 -- PeoplePlaces4: a trainer class, not one the hidden
// list covers, and its first trainer.
RadioJumptable["PLACES_AND_PEOPLE_4"] = (R) => {
  const classes = R.data.classes ?? {};
  const hidden = R.data.hidden ?? {};
  const index = R.sample((roll) => {
    const r = (roll % 128) + 1;
    if (r > 66 || hidden[r] || !classes[r]) return undefined;
    return r;
  });
  const cls = index !== undefined ? classes[index] : undefined;
  if (!cls) return;
  R.vars.class = cls.name;
  R.vars.trainer = cls.trainer;
  R.vars.classIndex = index;
  R.nextLine(Strings.get("%s %s", String(cls.name ?? ""), String(cls.trainer ?? "")), "PLACES_AND_PEOPLE_5");
};

// Lua: Pokegear.lua:764 -- adjective, 4% restart, then the coin again.
RadioJumptable["PLACES_AND_PEOPLE_5"] = (R) => {
  const adjective = PNP_ADJECTIVES[R.random() % 16]!;
  let nextLine = "PLACES_AND_PEOPLE";
  if (R.random() >= PNP_RESTART_CHANCE) nextLine = peopleOrPlaces(R);
  R.nextLine(Strings.get(adjective), nextLine);
};

// Lua: Pokegear.lua:772 -- one of the nine PnP_Places maps' landmark.
RadioJumptable["PLACES_AND_PEOPLE_6"] = (R) => {
  const map = R.sample((roll) => (roll < PNP_PLACES.length ? PNP_PLACES[roll] : undefined));
  if (map === undefined) return;
  const index = R.data.mapLandmark ? R.data.mapLandmark[map] : undefined;
  const entry = R.data.landmarks && index != null ? R.data.landmarks[index] : undefined;
  R.vars.landmark = index;
  R.nextLine(flatName(entry ? entry.name : undefined), "PLACES_AND_PEOPLE_7");
};

// Lua: Pokegear.lua:787
RadioJumptable["PLACES_AND_PEOPLE_7"] = (R) => {
  const adjective = PNP_ADJECTIVES[R.random() % 16]!;
  let nextLine = "PLACES_AND_PEOPLE";
  if (R.random() >= PNP_RESTART_CHANCE) nextLine = peopleOrPlaces(R);
  R.printLine(Strings.get(adjective), nextLine);
};

// ------------------------------------------------------------ Rocket Radio

// Lua: Pokegear.lua:798
RadioJumptable["ROCKET_RADIO"] = (R) => {
  R.startStation();
  R.nextLine(Strings.get(ROCKET_LINES[0]!), "ROCKET_RADIO_2");
};
// Lua: Pokegear.lua:802
for (let index = 2; index <= 10; index++) {
  RadioJumptable["ROCKET_RADIO_" + index] = (R) => {
    R.nextLine(Strings.get(ROCKET_LINES[index - 1]!), index < 10 ? "ROCKET_RADIO_" + (index + 1) : "ROCKET_RADIO");
  };
}

// ------------------------------------------------- the three music stations

// Lua: Pokegear.lua:814 -- start the song, mark one line printed, say nothing.
for (const station of ["POKE_FLUTE_RADIO", "UNOWN_RADIO", "EVOLUTION_RADIO"]) {
  RadioJumptable[station] = (R) => {
    R.startStation();
    R.printed = 1;
  };
}

// ------------------------------------------------------------- the tuner

export interface RadioCtx {
  inJohto: boolean;
  timeOfDay?: number;
  landmark?: unknown;
  expnCard?: boolean;
  rocketSignal?: boolean;
}

export interface RadioChannel {
  knob: number;
  frequency: string;
  signal: (ctx: RadioCtx) => string | undefined;
}

// Lua: Pokegear.lua:833 -- RadioChannels: a knob value and the routine that
// decides whether anything is on it (frequency value = 4 x ingame - 2).
const RADIO_CHANNELS: RadioChannel[] = [
  // .PKMNTalkAndPokedexShow
  {
    knob: 16, frequency: "04.5", signal: (ctx) => {
      if (!ctx.inJohto) return undefined;
      if ((ctx.timeOfDay ?? 0) === 0) return "POKEDEX_SHOW";
      return "OAKS_POKEMON_TALK";
    },
  },
  { knob: 28, frequency: "07.5", signal: (ctx) => (ctx.inJohto ? "POKEMON_MUSIC" : undefined) },
  { knob: 32, frequency: "08.5", signal: (ctx) => (ctx.inJohto ? "LUCKY_CHANNEL" : undefined) },
  // .RuinsOfAlphRadio
  { knob: 52, frequency: "13.5", signal: (ctx) => (ctx.landmark === "LANDMARK_RUINS_OF_ALPH" ? "UNOWN_RADIO" : undefined) },
  { knob: 64, frequency: "16.5", signal: (ctx) => (!ctx.inJohto ? "PLACES_AND_PEOPLE" : undefined) },
  { knob: 72, frequency: "18.5", signal: (ctx) => (!ctx.inJohto ? "LETS_ALL_SING" : undefined) },
  // .PokeFluteRadio wants the EXPN card too.
  {
    knob: 78, frequency: "20.0", signal: (ctx) => {
      if (ctx.inJohto || !ctx.expnCard) return undefined;
      return "POKE_FLUTE_RADIO";
    },
  },
  // .EvolutionRadio: Team Rocket in Mahogany, near the Lake of Rage.
  {
    knob: 80, frequency: "20.5", signal: (ctx) => {
      if (!ctx.rocketSignal) return undefined;
      const here = ctx.landmark;
      if (here === "LANDMARK_MAHOGANY_TOWN" || here === "LANDMARK_ROUTE_43" || here === "LANDMARK_LAKE_OF_RAGE") {
        return "EVOLUTION_RADIO";
      }
      return undefined;
    },
  },
];

// Lua: Pokegear.lua:878 -- PHONE_DISPLAY_HEIGHT.
const PHONE_ROWS = 4;

// Lua: Pokegear.lua:885 -- data/text/common_3.asm (bank $66), with the
// "bank:addr" key the extracted form will have.
const PHONE_TEXT: Record<string, { key: string; body: string }> = {
  GearEllipse: { key: "66:4066", body: Strings.source("……") },
  GearOutOfService: { key: "66:4069", body: Strings.source("You're out of the service area.") },
  AskWhoCall: { key: "66:4089", body: Strings.source("Whom do you want to call?") },
  // _PokegearPressButtonText, the CLOCK card's bottom-box prompt.
  PressButton: { key: "66:40a4", body: Strings.source("Press any button to exit.") },
  AskDelete: { key: "66:40bf", body: Strings.source("Delete this stored phone number?") },
  WrongNumber: { key: "66:40e1", body: Strings.source("Huh? Sorry, wrong number!") },
  Click: { key: "66:40fc", body: Strings.source("Click!") },
  PhoneEllipse: { key: "66:4104", body: Strings.source("……") },
  OutOfArea: { key: "66:4107", body: Strings.source("That number is out of the area.") },
  JustTalkToThem: { key: "66:4128", body: Strings.source("Just go talk to that person!") },
};

// Lua: Pokegear.lua:1048 -- EngineFlags rows 0-3: POKEGEAR_RADIO/MAP/PHONE/EXPN_CARD_F.
const CARD_ENGINE_FLAGS: Record<string, number> = { radio: 0, map: 1, phone: 2, expn: 3 };

// Lua: Pokegear.lua:1569 -- PokegearPhoneContactSubmenu's two string tables.
const PHONE_SUBMENUS: Record<string, { x: number; y: number; rows: number; textX: number; textY: number; entries: string[] }> = {
  callDeleteCancel: { x: 9, y: 4, rows: 3, textX: 11, textY: 6, entries: ["CALL", "DELETE", "CANCEL"] },
  callCancel: { x: 9, y: 6, rows: 2, textX: 11, textY: 8, entries: ["CALL", "CANCEL"] },
};

// Lua: Pokegear.lua:1576
const PHONE_SUBMENU_LABELS: Record<string, string> = {
  CALL: Strings.source("CALL"),
  DELETE: Strings.source("DELETE"),
  CANCEL: Strings.source("CANCEL"),
};

// Lua: Pokegear.lua:1725 -- LANDMARK_* fallbacks (pokegold indices).
const LANDMARK_NEW_BARK_TOWN = 0x01;
const LANDMARK_SILVER_CAVE = 0x2d;
const LANDMARK_PALLET_TOWN = 0x2e;
const LANDMARK_VICTORY_ROAD = 0x57;
const LANDMARK_ROUTE_28 = 0x5d;

// Lua: Pokegear.lua:1914 -- a font-page SPACE: colour 0, the cream plate.
const SPACE_TILE = 0x7f;

/** The map icon objects: a cooked sprite sheet and its OBJ palette. */
interface IconSprite {
  image: LcdImage;
  objColors: Colors | undefined;
}

export interface PokegearOpts {
  save?: any;
  landmarks?: any;
  currentLandmark?: unknown;
  clock?: { hour?: number; minute?: number; weekday?: number };
  menuGfx?: any;
  radioData?: RadioData;
  radioRng?: () => number;
  onClose?: () => void;
  mapDef?: any;
  trainers?: any;
  text?: any;
  onCall?: (call: any) => void;
  fly?: any[];
  onFly?: (spawn: unknown) => void;
  flyMon?: any;
  townMap?: boolean;
  sprites?: any;
  palettes?: any;
  icons?: any;
}

/** The input the Pokegear reads (shared/core/Input.ts). */
interface GearInput {
  wasPressed(button: string): boolean;
}

export class Pokegear {
  [key: string]: any;
  // Lua: Pokegear.lua:39
  static isOpaque = true;
  isOpaque = true;
  static PHONE_SUBMENUS = PHONE_SUBMENUS;
  // Lua: Pokegear.lua:2501 -- the desktop film canvas (see drawPanel).
  static CUSTOM_RAMP_FILM = true;
  // Lua: Pokegear.lua:2583 -- the gate World:openFlyMap reads.
  static FLY_MAP = true;
  static CARDS = CARDS;
  static RADIO_CHANNELS = RADIO_CHANNELS;
  static STATION_NAMES = STATION_NAMES;
  static Radio = Radio;
  static OPT_ADVERBS = OPT_ADVERBS;
  static OPT_ADJECTIVES = OPT_ADJECTIVES;
  static PNP_ADJECTIVES = PNP_ADJECTIVES;
  static ROCKET_LINES = ROCKET_LINES;
  static OPT_ROUTES = OPT_ROUTES;
  static PNP_PLACES = PNP_PLACES;

  game: any;
  save: any;
  landmarks: any;
  currentLandmark: unknown;
  clock: PokegearOpts["clock"];
  onClose: (() => void) | undefined;
  cards: PokegearCard[];
  /** 1-based, as the Lua. */
  cardIndex: number;
  mode: "strip" | "card";
  /** Which RADIO_CHANNELS row (1-based) the knob sits on. */
  station: number;
  phoneCursor: number;
  phoneScroll: number;
  phoneSubmenu: string | undefined;
  phoneSubmenuCursor: number;
  mapDef: any;
  trainers: any;
  textData: any;
  onCall: ((call: any) => void) | undefined;
  radioShow: string | undefined;
  radio: Radio | undefined;
  radioDataOverride: RadioData | undefined;
  radioDataCache: RadioData | undefined;
  radioRng: (() => number) | undefined;
  radioOn: boolean;
  radioTuned: boolean | undefined;
  radioSong: string | undefined;
  radioMusicPlaying: string | undefined;
  mapCursor: number | undefined;
  call: any;
  fly: any[] | undefined;
  onFly: ((spawn: unknown) => void) | undefined;
  flyMon: any;
  /** 1-based, as the Lua. */
  flyIndex: number | undefined;
  townMap: boolean | undefined;
  townMapClosed: boolean | undefined;
  sprites: any;
  palettes: any;
  icons: any;
  gfx: any;
  gearPals: Colors[] | undefined;
  sheet: TileSheet | undefined;
  arrow: TileSheet | false | undefined;
  playerIcon: IconSprite | false | undefined;
  flyMonIcon: IconSprite | false | undefined;
  iconTimer: number | undefined;

  // Lua: Pokegear.lua:909 -- opts: save, landmarks, currentLandmark, clock,
  // menuGfx, radioData, radioRng, onClose, mapDef, trainers, text, onCall,
  // and the fly / town map entries.
  constructor(game: any, opts?: PokegearOpts) {
    const o = opts ?? {};
    this.game = game;
    this.save = o.save ?? (game ? game.save : undefined);
    const data = (game && game.data) || {};
    this.landmarks = o.landmarks ?? data.gen2Landmarks;
    // TownMap_GetCurrentLandmark reads the map header itself.
    this.currentLandmark = o.currentLandmark;
    if (this.currentLandmark == null && game && typeof game.currentLandmark === "function") {
      try {
        this.currentLandmark = game.currentLandmark();
      } catch {
        // pcall
      }
    }
    this.clock = o.clock;
    this.onClose = o.onClose;
    this.cards = [];
    this.cards = this.visibleCards();
    this.cardIndex = 1;
    this.mode = "strip";
    this.station = 1;
    // wPokegearPhoneCursorPosition / wPokegearPhoneScrollPosition, ZERO based.
    this.phoneCursor = 0;
    this.phoneScroll = 0;
    this.phoneSubmenu = undefined;
    this.phoneSubmenuCursor = 0;
    this.mapDef = o.mapDef;
    this.trainers = o.trainers ?? data.trainers ?? data.gen2Trainers;
    this.textData = o.text;
    this.onCall = o.onCall;
    this.radioShow = undefined;
    this.radio = undefined;
    this.radioDataOverride = o.radioData;
    this.radioDataCache = undefined;
    this.radioRng = o.radioRng;
    this.radioOn = false;
    this.radioTuned = undefined;
    this.radioSong = undefined;
    this.radioMusicPlaying = undefined;
    this.mapCursor = undefined;
    this.call = undefined;

    // _FlyMap's own state.
    this.fly = o.fly;
    this.onFly = o.onFly;
    this.flyMon = o.flyMon;
    this.flyIndex = undefined;
    if (this.fly && this.fly.length > 0) {
      this.cards = [FLY_MAP_CARD];
      this.cardIndex = 1;
      this.mode = "card";
      // Johto opens on New Bark Town, Kanto on Indigo Plateau.
      this.flyIndex = this.region() === "kanto" ? this.fly.length : 1;
    }

    // _TownMap: the same map, one card, no gate and no strip.
    this.townMap = !this.fly && o.townMap ? true : undefined;
    this.townMapClosed = undefined;
    if (this.townMap) {
      this.cards = [TOWN_MAP_CARD];
      this.cardIndex = 1;
      this.mode = "card";
    }

    // _CGB_PokegearPals writes wBGPals1 only: the icon keeps the overworld OBJ palette.
    this.sprites = o.sprites ?? data.gen2Sprites;
    this.palettes = o.palettes ?? data.gen2Palettes;
    this.icons = o.icons ?? data.gen2Icons;

    const gfx = (o.menuGfx ?? data.gen2MenuGfx ?? {}).pokegear;
    this.gfx = gfx;
    // FemalePokegearPals off wPlayerGender.
    this.gearPals = gfx ? ((Gen2Save.isFemale(this.save) && gfx.palettesFemale) || gfx.palettes) : undefined;
    this.sheet = undefined;
    if (gfx) {
      this.sheet = TileSheet.new({
        path: gfx.tiles, wide: gfx.tilesWide ?? 16, firstTile: 0,
        raw: true,
        paletteFor: (tile: number) => this.colorsFor(tile),
      });
    }
    this.arrow = undefined;
    this.playerIcon = undefined;
    this.flyMonIcon = undefined;
    this.iconTimer = undefined;
  }

  static new(game: any, opts?: PokegearOpts): Pokegear {
    return new Pokegear(game, opts);
  }

  // Lua: Pokegear.lua:900
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: Pokegear.lua:901
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: Pokegear.lua:1010
  styled(): boolean {
    return this.sheet !== undefined && this.sheet.available();
  }

  // Lua: Pokegear.lua:1016 -- Male/FemalePokegearPals.
  pals(): Colors[] | undefined {
    return this.gearPals;
  }

  // Lua: Pokegear.lua:1021 -- TownMapPals: a nybble per tile id for
  // $00..$5f, palette 0 above.
  colorsFor(tile: number): Colors | undefined {
    const pals = this.pals();
    if (!pals) return undefined;
    if (tile >= 0x60) return pals[0];
    const n = (this.gfx.palMap && this.gfx.palMap[tile]) || 1;
    return pals[n - 1];
  }

  // Lua: Pokegear.lua:1030 -- every card string wears BG palette 0.
  text(str: string, tx: number, ty: number): number {
    const pals = this.pals();
    return Chrome.printThrough(str, tx, ty, pals ? pals[0] : undefined, false, true);
  }

  // Lua: Pokegear.lua:1035
  cursor(tx: number, ty: number): void {
    const pals = this.pals();
    Chrome.cursorThrough(tx, ty, pals ? pals[0] : undefined, false, false, true);
  }

  // Lua: Pokegear.lua:1051 -- ../pokecrystal/constants/engine_flags.asm:25
  engineFlag(name: string, goldId: number | undefined): boolean {
    const world = this.game ? this.game.world : undefined;
    let id = goldId;
    if (world && world.engineFlagId) id = world.engineFlagId(name, goldId);
    const engine = (this.save ?? {}).engineFlags ?? {};
    return id != null && engine[id] === true;
  }

  // Lua: Pokegear.lua:1058
  flags(): Record<string, any> {
    const save = this.save ?? {};
    const flags: Record<string, any> = {};
    for (const key of Object.keys(save.pokegearFlags ?? {})) flags[key] = save.pokegearFlags[key];
    const engine = save.engineFlags ?? {};
    for (const key of Object.keys(CARD_ENGINE_FLAGS)) {
      if (engine[CARD_ENGINE_FLAGS[key]!] === true) flags[key] = true;
    }
    return flags;
  }

  // Lua: Pokegear.lua:1069
  visibleCards(): PokegearCard[] {
    const flags = this.flags();
    const out: PokegearCard[] = [];
    for (const card of CARDS) {
      if (!card.flag || truthy(flags[card.flag])) out.push(card);
    }
    return out;
  }

  // Lua: Pokegear.lua:1078
  card(): PokegearCard | undefined {
    return this.cards[this.cardIndex - 1];
  }

  // Lua: Pokegear.lua:1082
  cardLabel(card?: PokegearCard): string {
    const c = card ?? this.card();
    return c ? Strings.get(c.label) : "";
  }

  // Lua: Pokegear.lua:1095 -- the GAME clock; `weekday` 1-based for DAYS.
  clockParts(): [number, number, number] {
    if (this.clock) {
      return [this.clock.hour ?? 0, this.clock.minute ?? 0, this.clock.weekday ?? 1];
    }
    const world = this.game ? this.game.world : undefined;
    if (world && world.hour) {
      return [world.hour(), world.minute(), (world.weekday() % 7) + 1];
    }
    const save = this.save;
    return [Clock.hour(save), Clock.minute(save), Clock.weekday(save) + 1];
  }

  // Lua: Pokegear.lua:1112 -- wPhoneList: ten slots, 0 for an empty one.
  phoneList(): number[] {
    return Phone.contacts(this.save);
  }

  // Lua: Pokegear.lua:1119
  phoneSelection(): number {
    return this.phoneList()[this.phoneScroll + this.phoneCursor] ?? 0;
  }

  // Lua: Pokegear.lua:1128 -- the map record the phone tests read.
  phoneContext(): { map: any; clock: { hour: number; minute: number } } {
    let map = this.mapDef;
    if (!map) {
      const world = this.game ? this.game.world : undefined;
      map = world && world.map ? world.map.def : undefined;
    }
    const [hour, minute] = this.clockParts();
    return { map, clock: { hour, minute } };
  }

  // Lua: Pokegear.lua:1140 -- the extracted string, else the transcription.
  phoneText(name: string): string {
    const entry = PHONE_TEXT[name];
    if (!entry) return "";
    const text = this.textData ?? (this.game && this.game.world ? this.game.world.text : undefined);
    const extracted = CommonText.plain(text ? text[entry.key] : undefined);
    if (typeof extracted === "string" && extracted !== "") return extracted;
    return Strings.get(entry.body);
  }

  // Lua: Pokegear.lua:1152 -- GetCallerClassAndName.
  contactRow(id: number): [string, string | undefined] {
    const [name, className] = Phone.contactName(id, this.trainers);
    return [(name ?? "----------") + ":", className];
  }

  // Lua: Pokegear.lua:1157
  update(_dt?: number): void {
    // .Frameset_RedWalk: four 8-frame beats.
    this.iconTimer = ((this.iconTimer ?? 0) + 1) % 32;
    const input: GearInput | undefined = this.game ? this.game.input : undefined;
    if (!input) return;
    if (this.fly) return this.updateFlyMap(input);
    if (this.townMap) return this.updateTownMap(input);
    if (this.mode === "strip") {
      const stripCard = this.card();
      if (!(stripCard && stripCard.id === "phone")) {
        if (input.wasPressed("left")) {
          this.cardIndex = this.cardIndex > 1 ? this.cardIndex - 1 : this.cards.length;
        } else if (input.wasPressed("right")) {
          this.cardIndex = this.cardIndex < this.cards.length ? this.cardIndex + 1 : 1;
        } else if (input.wasPressed("a")) {
          this.mode = "card";
        } else if (input.wasPressed("b")) {
          if (this.onClose) this.onClose();
        }
        return;
      }
      this.mode = "card";
    }
    // Inside a card.
    const card = this.card();
    // The busy test comes FIRST: wasPressed consumes the press.
    const phoneBusy = !!card && card.id === "phone" && (this.call != null || this.phoneSubmenu != null);
    // engine/pokegear/pokegear.asm:799
    if (card && card.id === "phone" && !phoneBusy) {
      if (input.wasPressed("b")) {
        if (this.onClose) this.onClose();
        return;
      } else if (input.wasPressed("left")) {
        this.switchCard("map", "clock");
        return;
      } else if (input.wasPressed("right")) {
        this.switchCard("radio");
        return;
      }
    }
    if (!phoneBusy && input.wasPressed("b")) {
      this.mode = "strip";
      this.stopRadio();
      this.call = undefined;
      this.phoneSubmenu = undefined;
      return;
    }
    // engine/pokegear/pokegear.asm:454
    if (card && card.id === "clock") {
      if (input.wasPressed("right")) this.switchCard("map", "phone", "radio");
      return;
    }
    if (card && card.id === "radio") {
      // engine/pokegear/pokegear.asm:740
      if (input.wasPressed("left")) {
        this.stopRadio();
        this.switchCard("phone", "map", "clock");
        return;
      }
      this.ensureTuned();
      // AnimateTuningKnob.TuningKnob: up winds towards 80, down towards 0,
      // and it stops dead at either end.
      if (input.wasPressed("up")) {
        if (this.station < RADIO_CHANNELS.length) {
          this.station = this.station + 1;
          this.tuneRadio();
        }
      } else if (input.wasPressed("down")) {
        if (this.station > 1) {
          this.station = this.station - 1;
          this.tuneRadio();
        }
      }
      this.tickRadio();
    } else if (card && card.id === "phone") {
      this.updatePhone(input);
    } else if (card && card.id === "map") {
      this.moveMapCursor(input);
    }
  }

  // --------------------------------------------------------------- radio

  // Lua: Pokegear.lua:1253 -- .InJohto: the S.S. Aqua and anything below
  // KANTO_LANDMARK; the PLAYER's landmark, never the cursor's.
  region(): "johto" | "kanto" {
    const landmarks = this.landmarks ? this.landmarks.landmarks : undefined;
    const current = landmarks && this.currentLandmark != null ? landmarks[this.currentLandmark as string] : undefined;
    const index = (current && current.index) || 0;
    if (index === this.landmarkIndex("FAST_SHIP", 0x5e)) return "johto";
    if (index >= this.landmarkIndex("PALLET_TOWN", 0x2e)) return "kanto";
    return "johto";
  }

  // Lua: Pokegear.lua:1266 -- what RadioChannels' tests read.
  radioContext(): RadioCtx {
    const flags = this.flags();
    return {
      inJohto: this.region() === "johto",
      landmark: this.currentLandmark,
      // wTimeOfDay: MORN 0 swaps Oak's talk for the Pokedex Show.
      timeOfDay: this.timeOfDay ?? this.timeOfDayIndex(),
      expnCard: truthy(flags.expn) ? true : false,
      rocketSignal: this.engineFlag("ENGINE_ROCKET_SIGNAL_ON_CH20", FlagNames.engine.ENGINE_ROCKET_SIGNAL_ON_CH20),
    };
  }

  // Lua: Pokegear.lua:1290 -- radio_channels registry names, else STATION_NAMES.
  stationName(station: string | undefined): string | undefined {
    if (!station) return undefined;
    const data = this.game ? this.game.data : undefined;
    const rows = data ? data.gen2RadioChannels : undefined;
    if (rows !== null && typeof rows === "object") {
      const record = rows[station];
      return record ? record.name : undefined;
    }
    return STATION_NAMES[station];
  }

  // Lua: Pokegear.lua:1303
  stations(): { knob: number; frequency: string; station: string | undefined; name: string | undefined }[] {
    const ctx = this.radioContext();
    return RADIO_CHANNELS.map((row) => {
      const station = row.signal(ctx);
      return { knob: row.knob, frequency: row.frequency, station, name: this.stationName(station) };
    });
  }

  // Lua: Pokegear.lua:1316
  currentStation(): ReturnType<Pokegear["stations"]>[number] | undefined {
    return this.stations()[this.station - 1];
  }

  // Lua: Pokegear.lua:1323 -- UpdateRadioStation; dead air is NoRadioStation.
  tuneRadio(): void {
    const row = this.currentStation();
    const station = row ? row.station : undefined;
    this.radioTuned = true;
    this.radioShow = station;
    if (!station) {
      this.radio = undefined;
      this.radioOn = false;
      // NoRadioStation: MUSIC_NONE, and ENTER_MAP_MUSIC parked.
      this.radioMusicPlaying = "enterMap";
      const data = this.game ? this.game.data : undefined;
      if (data) {
        try {
          Music.stop();
        } catch {
          // pcall
        }
      }
      return;
    }
    this.radio = Radio.new({ data: this.radioData(), rng: this.radioRng });
    this.radio.tune(station);
    this.radioOn = true;
    this.playRadioMusic();
  }

  // Lua: Pokegear.lua:1348
  ensureTuned(): void {
    if (this.radioTuned) return;
    this.tuneRadio();
  }

  // Lua: Pokegear.lua:1356
  tickRadio(): void {
    if (!this.radio) return;
    this.radio.step();
    this.playRadioMusic();
  }

  // Lua: Pokegear.lua:1367 -- what a started song leaves in
  // wPokegearRadioMusicPlaying.
  static radioPlayingValue(song: string | undefined): string | undefined {
    if (song === "Music_PokemonChannel") return "restartMap";
    return song;
  }

  // Lua: Pokegear.lua:1372
  playRadioMusic(): void {
    const song = this.radio ? this.radio.music : undefined;
    if (!song || song === this.radioSong) return;
    this.radioSong = song;
    this.radioMusicPlaying = Pokegear.radioPlayingValue(song);
    const data = this.game ? this.game.data : undefined;
    if (!data) return;
    try {
      Music.play(data, song);
    } catch {
      // pcall
    }
  }

  // Lua: Pokegear.lua:1386 -- the cache reads the shows need, once.
  radioData(): RadioData {
    if (this.radioDataOverride) return this.radioDataOverride;
    if (this.radioDataCache) return this.radioDataCache;
    const data = (this.game && this.game.data) || {};
    const save = this.save ?? {};
    const out: RadioData = { inJohto: this.region() === "johto" };

    // Landmarks by index (GetLandmarkName / GetWorldMapLocation).
    const landmarks: Record<number, any> = {};
    const records = (this.landmarks ?? {}).landmarks ?? {};
    for (const key of Object.keys(records)) {
      const entry = records[key];
      landmarks[entry.index ?? 0] = entry;
    }
    out.landmarks = landmarks;

    // GetWorldMapLocation: map -> landmark index.
    const mapLandmark: Record<string, number> = {};
    const maps = (this.game && this.game.world && this.game.world.maps) || data.gen2Maps || {};
    for (const id of Object.keys(maps)) {
      const def = maps[id];
      if (def !== null && typeof def === "object") mapLandmark[id] = def.landmark;
    }
    out.mapLandmark = mapLandmark;

    // JohtoGrassWildMons by map, then the MORN/DAY/NITE block.
    const grass: Record<string, (string | undefined)[][]> = {};
    const grassRows = (data.gen2Encounters ?? {}).grass ?? {};
    for (const id of Object.keys(grassRows)) {
      const slots = grassRows[id].slots ?? {};
      grass[id] = ["MORN", "DAY", "NITE"].map((key) => (slots[key] ?? []).map((entry: any) => entry.species));
    }
    out.grass = grass;

    // Species by internal index, which is what the Pokedex Show rolls.
    const species: Record<number, string> = {};
    const pokemon = data.pokemon ?? {};
    for (const name of Object.keys(pokemon)) {
      const def = pokemon[name];
      if (def !== null && typeof def === "object" && def.index != null) species[def.index] = name;
    }
    out.species = species;
    const caught = (save.pokedex ?? {}).caught ?? {};
    out.caught = (name: string) => caught[name] === true;

    // Pokedex entries split the way CopyDexEntryPart1 walks them.
    const dex: Record<string, { kind?: string; lines: string[] }> = {};
    const entries = (data.gen2Pokedex ?? {}).entries ?? {};
    for (const name of Object.keys(entries)) {
      const entry = entries[name];
      const lines: string[] = [];
      for (const page of [entry.text, entry.text2]) {
        for (const line of String(page ?? "").split("<NEXT>")) {
          if (line !== "") lines.push(line);
        }
      }
      dex[name] = { kind: entry.kind, lines };
    }
    out.dex = dex;

    // TrainerClassNames and each class's first trainer, by class index.
    const classes: Record<number, { name?: string; trainer?: string }> = {};
    const classRows = (data.gen2Trainers ?? {}).classes ?? {};
    for (const key of Object.keys(classRows)) {
      const cls = classRows[key];
      if (cls && cls.index != null) {
        classes[cls.index] = {
          name: cls.name,
          trainer: cls.trainers && cls.trainers[0] ? cls.trainers[0].name : undefined,
        };
      }
    }
    out.classes = classes;
    out.hidden = this.hiddenPeople();

    out.weekday = this.radioWeekday();
    // wLuckyIDNumber; a save that never rolled one honestly reads 00000.
    out.luckyNumber = save.luckyNumber ?? 0;
    // ../pokegold/engine/events/std_scripts.asm:255
    out.rocketsInRadioTower = this.engineFlag("ENGINE_ROCKETS_IN_RADIO_TOWER", FlagNames.engine.ENGINE_ROCKETS_IN_RADIO_TOWER);
    this.radioDataCache = out;
    return out;
  }

  // Lua: Pokegear.lua:1474 -- PnP_HiddenPeople from one of three entry points.
  hiddenPeople(): Record<number, boolean> {
    const save = this.save ?? {};
    let first = 1;
    if (truthy((save.flags ?? {}).HALL_OF_FAME)) {
      first = PNP_HIDDEN_BEAT_E4;
      const badges = (save.player ?? {}).kantoBadges ?? {};
      let count = 0;
      for (const key of Object.keys(badges)) if (truthy(badges[key])) count++;
      if (count >= 8) first = PNP_HIDDEN_BEAT_KANTO;
    }
    const hidden: Record<number, boolean> = {};
    for (let index = first; index <= PNP_HIDDEN.length; index++) {
      const classIndex = this.trainerClassIndex(PNP_HIDDEN[index - 1]!);
      if (classIndex != null) hidden[classIndex] = true;
    }
    return hidden;
  }

  // Lua: Pokegear.lua:1492
  trainerClassIndex(id: string): number | undefined {
    const classes = ((this.game && this.game.data && this.game.data.gen2Trainers) || {}).classes ?? {};
    const cls = classes[id];
    return cls ? cls.index : undefined;
  }

  // Lua: Pokegear.lua:1500 -- wTimeOfDay: MORN 0, DAY 1, NITE 2, DARK 3.
  timeOfDayIndex(): number {
    const world = this.game ? this.game.world : undefined;
    // the unpinned clock split, not the palette pin (pokegear.asm:1456, :1957)
    const daytime = (world && (world.tod || world.daytime))
      || Palettes.clockDaytime(this.clock && this.clock.hour != null ? this.clock.hour : undefined);
    return (Palettes.DAYTIME_ID[daytime] ?? 2) - 1;
  }

  // Lua: Pokegear.lua:1511 -- GetWeekday from Sunday = 0.
  radioWeekday(): number {
    const [, , weekday] = this.clockParts();
    return ((((weekday ?? 1) - 1) % 7) + 7) % 7;
  }

  // Lua: Pokegear.lua:1525 -- ExitPokegearRadio_HandleMusic: a tuned
  // station's song stays as the map music; ENTER_MAP_MUSIC and
  // RESTART_MAP_MUSIC bring the map theme back.
  static exitRadioMusic(game: any, playing: string | undefined): void {
    if (!playing) return;
    const data = game ? game.data : undefined;
    if (!data) return;
    if (playing !== "enterMap" && playing !== "restartMap") {
      Music.setMapSong(playing);
      return;
    }
    const world = game ? game.world : undefined;
    const song = world && world.map && world.map.def ? world.map.def.music : undefined;
    try {
      if (song) Music.play(data, song);
      else Music.stop();
    } catch {
      // pcall
    }
  }

  // Lua: Pokegear.lua:1539
  stopRadio(): void {
    const playing = this.radioMusicPlaying;
    this.radio = undefined;
    this.radioShow = undefined;
    this.radioSong = undefined;
    this.radioTuned = undefined;
    this.radioMusicPlaying = undefined;
    this.radioOn = false;
    Pokegear.exitRadioMusic(this.game, playing);
  }

  // --------------------------------------------------------------- phone

  // Lua: Pokegear.lua:1587 -- PokegearPhone_GetDPad, then `.a`; neither the
  // cursor nor the scroll wraps.
  updatePhone(input: GearInput): void {
    // PokegearPhone_FinishPhoneCall: A or B hangs up.
    if (this.call) {
      if (input.wasPressed("a") || input.wasPressed("b")) this.hangUp();
      return;
    }
    if (this.phoneSubmenu) {
      this.updatePhoneSubmenu(input);
      return;
    }
    if (input.wasPressed("a")) {
      // `ld a, [hl] / and a / ret z`
      if (this.phoneSelection() !== 0) this.openPhoneSubmenu();
      return;
    }
    if (input.wasPressed("up")) {
      if (this.phoneCursor > 0) this.phoneCursor = this.phoneCursor - 1;
      else if (this.phoneScroll > 0) this.phoneScroll = this.phoneScroll - 1;
    } else if (input.wasPressed("down")) {
      if (this.phoneCursor < PHONE_ROWS - 1) this.phoneCursor = this.phoneCursor + 1;
      else if (this.phoneScroll < Phone.CONTACT_LIST_SIZE - PHONE_ROWS) this.phoneScroll = this.phoneScroll + 1;
    }
  }

  // Lua: Pokegear.lua:1621 -- CheckCanDeletePhoneNumber picks the menu.
  openPhoneSubmenu(): void {
    const id = this.phoneSelection();
    this.phoneSubmenu = Phone.canDelete(id) ? "callDeleteCancel" : "callCancel";
    this.phoneSubmenuCursor = 0;
  }

  // Lua: Pokegear.lua:1627
  updatePhoneSubmenu(input: GearInput): void {
    const menu = this.phoneSubmenu ? PHONE_SUBMENUS[this.phoneSubmenu] : undefined;
    if (!menu) {
      this.phoneSubmenu = undefined;
      return;
    }
    // `.d_up` / `.d_down`: a clamp, not a wrap.
    if (input.wasPressed("up")) {
      if (this.phoneSubmenuCursor > 0) this.phoneSubmenuCursor = this.phoneSubmenuCursor - 1;
      return;
    }
    if (input.wasPressed("down")) {
      if (this.phoneSubmenuCursor < menu.rows - 1) this.phoneSubmenuCursor = this.phoneSubmenuCursor + 1;
      return;
    }
    // `.a_b`: B always means Cancel.
    if (input.wasPressed("b")) {
      this.phoneSubmenu = undefined;
      return;
    }
    if (!input.wasPressed("a")) return;
    const choice = menu.entries[this.phoneSubmenuCursor];
    this.phoneSubmenu = undefined;
    if (choice === "CALL") {
      this.callContact(this.phoneSelection());
    } else if (choice === "DELETE") {
      // NOT FAITHFUL (Brian's): the cart asks first (PokegearAskDeleteText +
      // YesNoBox); the submenu entry is the confirmation here.
      Phone.deleteContactAt(this.save, this.phoneScroll + this.phoneCursor + 1);
    }
  }

  // Lua: Pokegear.lua:1669 -- PokegearPhone_MakePhoneCall; the no-signal
  // branch prints _GearOutOfServiceText and never calls.
  callContact(id: number | undefined): void {
    if (!id || id === 0) return;
    const context = this.phoneContext();
    if (!Phone.mapHasService(context)) {
      this.call = { contact: id, kind: "nosignal", text: this.phoneText("GearOutOfService") };
      return;
    }
    // pokegold engine/pokegear/pokegear.asm:883-889: SFX_CALL rings first.
    const world = this.game ? this.game.world : undefined;
    if (world) world.playSfxNamed("Sfx_Call", 106);
    const call: any = Phone.call(this.save, id, context);
    const [name, className] = Phone.contactName(id, this.trainers);
    call.name = name;
    call.className = className;
    if (call.kind === "outofarea") {
      call.text = this.phoneText("OutOfArea");
    } else if (call.kind === "justtalk") {
      call.text = this.phoneText("JustTalkToThem");
    } else if (call.wrongNumber) {
      call.text = this.phoneText("WrongNumber");
    } else {
      // Phone_TextboxWithName's "NAME:" and PhoneEllipseText.
      call.text = (name ?? "") + ": " + this.phoneText("PhoneEllipse");
    }
    this.call = call;
    // Game2.runPokegearCall runs the contact's SCRIPT1 over this card.
    if (this.onCall) this.onCall(call);
  }

  // Lua: Pokegear.lua:1704 -- HangUp: SFX_HANG_UP, back to the prompt.
  hangUp(): void {
    // pokegold engine/phone/phone.asm:517-519
    if (this.call && this.call.kind !== "nosignal") {
      const world = this.game ? this.game.world : undefined;
      if (world) world.playSfxNamed("Sfx_HangUp", 107);
    }
    this.call = undefined;
  }

  // ----------------------------------------------------------------- map

  // Lua: Pokegear.lua:1734 -- the cache's record is the authority.
  landmarkIndex(id: string, fallback: number): number {
    const records = (this.landmarks ?? {}).landmarks;
    const record = records ? (records["LANDMARK_" + id] ?? records[id]) : undefined;
    const index = record ? Number(record.index) : NaN;
    return Number.isFinite(index) ? index : fallback;
  }

  // Lua: Pokegear.lua:1745 -- [d (last), e (first)].
  cursorLimits(): [number, number] {
    if (this.region() !== "kanto") {
      return [
        this.landmarkIndex("SILVER_CAVE", LANDMARK_SILVER_CAVE),
        this.landmarkIndex("NEW_BARK_TOWN", LANDMARK_NEW_BARK_TOWN),
      ];
    }
    const last = this.landmarkIndex("ROUTE_28", LANDMARK_ROUTE_28);
    if (truthy(((this.save ?? {}).flags ?? {}).HALL_OF_FAME)) {
      return [last, this.landmarkIndex("PALLET_TOWN", LANDMARK_PALLET_TOWN)];
    }
    return [last, this.landmarkIndex("VICTORY_ROAD", LANDMARK_VICTORY_ROAD)];
  }

  // Lua: Pokegear.lua:1760 -- the cursor's landmark index.
  mapCursorIndex(): number {
    const flyRow = this.flyRow();
    if (flyRow && flyRow.index != null) return flyRow.index;
    if (this.mapCursor != null) return this.mapCursor;
    const landmarks = this.landmarks ? this.landmarks.landmarks : undefined;
    const current = landmarks && this.currentLandmark != null ? landmarks[this.currentLandmark as string] : undefined;
    const [, first] = this.cursorLimits();
    return (current && current.index) || first;
  }

  // Lua: Pokegear.lua:1779 -- PokegearMap_ContinueMap's .DPad wraps.
  stepMapCursor(delta: number): void {
    const [last, first] = this.cursorLimits();
    let cursor = this.mapCursorIndex();
    if (delta > 0) {
      if (cursor >= last) cursor = first - 1;
      cursor = cursor + 1;
    } else {
      if (cursor === first) cursor = last + 1;
      cursor = cursor - 1;
    }
    this.mapCursor = cursor;
  }

  // Lua: Pokegear.lua:1795 -- left/right page the POKeGEAR.
  moveMapCursor(input: GearInput): void {
    if (input.wasPressed("up")) {
      this.stepMapCursor(1);
    } else if (input.wasPressed("down")) {
      this.stepMapCursor(-1);
    } else if (input.wasPressed("right")) {
      this.switchCard("phone", "radio");
    } else if (input.wasPressed("left")) {
      this.switchCard("clock");
    }
  }

  // Lua: Pokegear.lua:1815 -- _TownMap's `.loop`: B, UP, DOWN, nothing else.
  updateTownMap(input: GearInput): void {
    if (input.wasPressed("b")) {
      if (this.townMapClosed) return;
      this.townMapClosed = true;
      const stack = this.game ? this.game.stack : undefined;
      if (stack) stack.pop();
      if (this.onClose) this.onClose();
      return;
    }
    if (input.wasPressed("up")) this.stepMapCursor(1);
    else if (input.wasPressed("down")) this.stepMapCursor(-1);
  }

  // Lua: Pokegear.lua:1838 -- _FlyMap's `.loop`.
  updateFlyMap(input: GearInput): void {
    const rows = this.fly ?? [];
    const count = rows.length;
    if (count === 0) {
      if (this.onClose) this.onClose();
      return;
    }
    if (input.wasPressed("up")) {
      this.flyIndex = ((this.flyIndex ?? 1) % count) + 1;
    } else if (input.wasPressed("down")) {
      this.flyIndex = ((((this.flyIndex ?? 1) - 2) % count) + count) % count + 1;
    } else if (input.wasPressed("a")) {
      const row = rows[(this.flyIndex ?? 1) - 1];
      if (row && this.onFly) this.onFly(row.spawn);
    } else if (input.wasPressed("b")) {
      if (this.onClose) this.onClose();
    }
  }

  // Lua: Pokegear.lua:1858
  flyRow(): any {
    if (!this.fly) return undefined;
    return this.fly[(this.flyIndex ?? 1) - 1];
  }

  // Lua: Pokegear.lua:1864 -- Pokegear_SwitchPage: the first owned card.
  switchCard(...ids: string[]): boolean {
    for (const id of ids) {
      for (let index = 1; index <= this.cards.length; index++) {
        if (this.cards[index - 1]!.id === id) {
          this.cardIndex = index;
          if (id === "radio") this.tuneRadio();
          return true;
        }
      }
    }
    return false;
  }

  // Lua: Pokegear.lua:1880 -- the CURSOR's landmark.
  mapLandmark(): any {
    const index = this.mapCursorIndex();
    const records = (this.landmarks ?? {}).landmarks ?? {};
    for (const key of Object.keys(records)) {
      if (records[key].index === index) return records[key];
    }
    return undefined;
  }

  // Lua: Pokegear.lua:1889 -- the landmark the player icon sits on.
  playerLandmark(): any {
    const landmarks = this.landmarks ? this.landmarks.landmarks : undefined;
    return (landmarks && this.currentLandmark != null ? landmarks[this.currentLandmark as string] : undefined) ?? undefined;
  }

  // ---------------------------------------------------------- tile layer

  // Lua: Pokegear.lua:1916 -- $7f is the cream plate, $4f the black ground;
  // both are font-page ids, so both are painted rather than blitted.
  tile(id: number, tx: number, ty: number): void {
    if (id === SPACE_TILE) {
      const paper = this.paperColor();
      G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
      G.rectangle("fill", tx * 8, ty * 8, 8, 8);
      G.setColor(1, 1, 1, 1);
      return;
    }
    if (id === BLANK_TILE) {
      const ground = this.groundColor();
      G.setColor(ground[0]! / 255, ground[1]! / 255, ground[2]! / 255, 1);
      G.rectangle("fill", tx * 8, ty * 8, 8, 8);
      G.setColor(1, 1, 1, 1);
      return;
    }
    if (this.sheet) this.sheet.draw(id, tx, ty);
  }

  // Lua: Pokegear.lua:1936
  drawTilemap(cells: number[] | undefined): void {
    if (!cells) return;
    // a card's tilemap draws the same cells every frame: recorded once,
    // replayed after while its palettes stand (screen.ts cachedBlock)
    const key = `tm:${keyOf(cells)}:${keyOf(this.pals())}:${keyOf(this.sheet)}:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawTilemapNow(cells));
  }

  /** drawTilemap's drawing. */
  private drawTilemapNow(cells: number[]): void {
    // A row's run of SPACE or BLANK cells is one fill on the 8px grid: the
    // same cells as a fill each (tile() fills those two with a flat colour),
    // at a fraction of the calls -- a card is mostly plate and ground.
    const grid = G.tx % 8 === 0 && G.ty % 8 === 0;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const tile = cells[y * SCREEN_W + x];
        if (tile == null) continue;
        if (grid && (tile === SPACE_TILE || tile === BLANK_TILE)) {
          let end = x + 1;
          while (end < SCREEN_W && cells[y * SCREEN_W + end] === tile) end++;
          const c = tile === SPACE_TILE ? this.paperColor() : this.groundColor();
          G.setColor(c[0]! / 255, c[1]! / 255, c[2]! / 255, 1);
          G.rectangle("fill", x * 8, y * 8, (end - x) * 8, 8);
          G.setColor(1, 1, 1, 1);
          x = end - 1;
          continue;
        }
        this.tile(tile, x, y);
      }
    }
  }

  // Lua: Pokegear.lua:1951 -- PokegearSpritesGFX (arrow $00, map cursor $04,
  // knob $08), remembered as `false` when there is no sheet.
  loadArrowSheet(): void {
    if (this.arrow !== undefined) return;
    this.arrow = false;
    const gfx = this.gfx;
    if (gfx && gfx.sprites) {
      this.loadPlayerIcon();
      const pals = this.pals();
      this.arrow = TileSheet.new({
        path: gfx.sprites, wide: gfx.spritesWide ?? 2, firstTile: 0,
        // STILL_CURSOR's oamset reuses RED_WALK's OAM data: PAL_OW_RED.
        palette: (this.playerIcon && this.playerIcon.objColors) || (pals ? pals[0] : undefined),
      });
    }
  }

  // Draw the PokegearSpritesGFX tiles as objects: on the cart they are OAM,
  // so a grid-aligned one must not replace the BG cell under it.
  private arrowObjects(body: () => void): void {
    G.push();
    G.objects = true;
    try {
      body();
    } finally {
      G.pop();
    }
  }

  // Lua: Pokegear.lua:1967 -- Pokegear_FinishTilemap's strip.
  drawStrip(): void {
    // the icon strip only changes with the cards (screen.ts cachedBlock)
    const key = `strip:${keyOf(this.cards)}:${this.cards.length}:${keyOf(this.pals())}:${keyOf(this.sheet)}`
      + `:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawStripNow());
  }

  /** drawStrip's drawing. */
  private drawStripNow(): void {
    for (let x = 0; x <= 7; x++) {
      this.tile(BLANK_TILE, x, 0);
      this.tile(BLANK_TILE, x, 1);
    }
    for (const card of this.cards) {
      const n = card.icon;
      const x = card.iconX;
      if (n == null || x == null) continue;
      this.tile(n, x, 0);
      this.tile(n + 1, x + 1, 0);
      this.tile(n + 0x10, x, 1);
      this.tile(n + 0x11, x + 1, 1);
    }
  }

  // Lua: Pokegear.lua:2003 -- the mode indicator arrow: an OBJ, drawn last,
  // tiles $00-$03 as one 16x16 up-triangle under the selected icon.
  drawModeArrow(): void {
    const card = this.card();
    const iconX = ((card && card.iconX) || 0) * 8;
    this.loadArrowSheet();
    const arrow = this.arrow;
    if (arrow && arrow.available()) {
      G.setColor(1, 1, 1, 1);
      // lifted half a tile so the apex meets the icon's bottom edge
      const tx = iconX / 8;
      const ty = 1.5;
      this.arrowObjects(() => {
        arrow.draw(0, tx, ty);
        arrow.draw(1, tx + 1, ty);
        arrow.draw(2, tx, ty + 1);
        arrow.draw(3, tx + 1, ty + 1);
      });
    } else {
      Chrome.cursor(Math.floor(iconX / 8), 2);
    }
  }

  // ----------------------------------------------------------- the cards

  // Lua: Pokegear.lua:2031
  drawClock(): void {
    // the whole card is the same cells until the minute turns (screen.ts
    // cachedBlock)
    const [hour, minute, weekday] = this.clockParts();
    const key = `clock:${hour}:${minute}:${weekday}:${keyOf(this.cards)}:${keyOf(this.pals())}:${keyOf(this.sheet)}`
      + `:${this.phoneText("PressButton")}:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawClockNow(hour, minute, weekday));
  }

  /** drawClock's drawing. */
  private drawClockNow(hour: number, minute: number, weekday: number): void {
    this.drawTilemap(this.gfx && this.gfx.cards ? this.gfx.cards.clock : undefined);
    this.drawStrip();
    this.text(" " + Strings.get("SWITCH"), 12, 1);
    this.cursor(19, 1);

    // Pokegear_UpdateClock: the day at (6,6), PrintHoursMins at (6,8), AM/PM
    // at column 12.
    this.text(Clock.weekdayName(weekday) ?? "", 6, 6);
    let display = hour % 12;
    if (display === 0) display = 12;
    this.text(Chrome.number(display, 2), 6, 8);
    this.text(":", 8, 8);
    this.text(Chrome.number(minute, 2, true), 9, 8);
    this.text(meridiem(hour), 12, 8);

    // The bottom Textbox (lb bc, 4, 18 at (0,12)) holds PokegearPressButtonText.
    this.textbox(0, 12, 18, 4);
    this.printBoxText(this.phoneText("PressButton"));
  }

  // Lua: Pokegear.lua:2064 -- `text` at (1,14) and `line` at (1,16).
  printBoxText(text: string): void {
    const lines = Chrome.wrap(text, 18);
    for (let i = 1; i <= Math.min(lines.length, 2); i++) {
      this.text(lines[i - 1]!, 1, 14 + (i - 1) * 2);
    }
  }

  // Lua: Pokegear.lua:2079 -- BG palette 0's colour 0, `RGB 28, 31, 20`.
  paperColor(): readonly number[] {
    const pals = this.pals();
    return (pals && pals[0] && pals[0][0]) || [255, 255, 255];
  }

  // Lua: Pokegear.lua:2094 -- $4f is a solid colour-3 tile: BG palette 0's
  // last colour.
  groundColor(): readonly number[] {
    const pals = this.pals();
    const pal = pals ? pals[0] : undefined;
    return (pal && pal[pal.length - 1]) || [0, 0, 0];
  }

  // Lua: Pokegear.lua:2103 -- a run of ' ' cells: the cream plate.
  drawPlate(tx: number, ty: number, tw: number, th: number): void {
    const paper = this.paperColor();
    G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
    G.rectangle("fill", tx * 8, ty * 8, tw * 8, th * 8);
    G.setColor(1, 1, 1, 1);
  }

  // Lua: Pokegear.lua:2119 -- Textbox on this screen: the frame glyphs are
  // font-page tiles too, so the ring wears palette 0 like the paper inside it.
  // (The Lua tints black glyphs over its plate; here the glyph cells go
  // through BG palette 0, which lands the same cream and black.)
  textbox(tx: number, ty: number, interiorW: number, interiorH: number): void {
    const tw = interiorW + 2;
    const th = interiorH + 2;
    this.drawPlate(tx, ty, tw, th);
    const B = Font.BORDER;
    const pals = this.pals();
    G.setColor(1, 1, 1, 1);
    GbcPalette.withRaw(pals ? pals[0] : undefined, () => {
      Font.drawCode(B.tl!, tx * 8, ty * 8);
      Font.drawCode(B.tr!, (tx + tw - 1) * 8, ty * 8);
      Font.drawCode(B.bl!, tx * 8, (ty + th - 1) * 8);
      Font.drawCode(B.br!, (tx + tw - 1) * 8, (ty + th - 1) * 8);
      for (let i = 1; i <= tw - 2; i++) {
        Font.drawCode(B.h!, (tx + i) * 8, ty * 8);
        Font.drawCode(B.h!, (tx + i) * 8, (ty + th - 1) * 8);
      }
      for (let j = 1; j <= th - 2; j++) {
        Font.drawCode(B.v!, tx * 8, (ty + j) * 8);
        Font.drawCode(B.v!, (tx + tw - 1) * 8, (ty + j) * 8);
      }
    });
    G.setColor(0, 0, 0, 1);
  }

  // Lua: Pokegear.lua:2143 -- TownMapBubble: "Where?" at (2,0), the
  // flypoint's name at (2,1), the scroller at (18,1).
  drawFlyBubble(): void {
    this.tile(0x30, 1, 0);
    for (let x = 2; x <= 17; x++) this.tile(SPACE_TILE, x, 0);
    this.tile(0x31, 18, 0);
    for (let x = 1; x <= 18; x++) this.tile(SPACE_TILE, x, 1);
    this.tile(0x32, 1, 2);
    for (let x = 2; x <= 17; x++) this.tile(SPACE_TILE, x, 2);
    this.tile(0x33, 18, 2);
    this.text(Strings.get("Where?"), 2, 0);
    const row = this.flyRow();
    this.text(flatName(row ? row.name : undefined), 2, 1);
    this.tile(0x34, 18, 1);
  }

  // Lua: Pokegear.lua:2160 -- _TownMap.InitTilemap's rule.
  drawTownMapRule(): void {
    this.tile(0x06, 0, 0);
    for (let x = 1; x <= 6; x++) this.tile(0x07, x, 0);
    this.tile(0x17, 7, 0);
    this.tile(0x16, 7, 1);
    this.tile(0x26, 7, 2);
    // `ld bc, NAME_LENGTH` from (8,2)
    for (let x = 8; x <= 18; x++) this.tile(0x07, x, 2);
    this.tile(0x17, 19, 2);
  }

  // Lua: Pokegear.lua:2171 -- the region follows the player, the name box
  // follows the cursor.
  drawMap(): void {
    const region = this.region();
    const current = this.mapLandmark();
    this.drawTilemap(this.gfx && this.gfx.maps ? this.gfx.maps[region] : undefined);
    if (this.fly) {
      this.drawFlyBubble();
    } else {
      // the header and the landmark plate: the same cells until the
      // landmark under the cursor changes (screen.ts cachedBlock)
      const name = current ? current.name ?? "" : "";
      const key = `maphead:${this.townMap ? 1 : 0}:${name}:${keyOf(this.cards)}:${keyOf(this.pals())}`
        + `:${keyOf(this.sheet)}:${GbcPalette.stateKey()}`;
      cachedBlock(this, key, () => {
        if (this.townMap) {
          this.drawTownMapRule();
        } else {
          this.drawStrip();
          // The header's own bottom rule: $07 across (1,2), $06 and $17 caps.
          this.tile(0x06, 0, 2);
          for (let x = 1; x <= 18; x++) this.tile(0x07, x, 2);
          this.tile(0x17, 19, 2);
        }

        // PokegearMap_UpdateLandmarkName: ClearBox(8,0) 2x12 with ' ', $34 at
        // (8,0), the name at (9,0) with <LF> stepping one row.
        G.setColor(1, 1, 1, 1);
        this.drawPlate(8, 0, 12, 2);
        this.tile(0x34, 8, 0);
        let row = 0;
        for (const line of String(name).split("\n")) {
          if (row < 2) this.text(line, 9, row);
          row++;
        }
      });
    }

    // Two OBJs: RED_WALK on the PLAYER's landmark, the POKEGEAR_ARROW on the
    // CURSOR's. Coordinates are already screen ones.
    const player = this.playerLandmark();
    if (player && player.x != null && player.y != null) {
      if (!this.drawPlayerIcon(player.x, player.y)) {
        G.setColor(0, 0, 0, 1);
        G.rectangle("fill", player.x - 2, player.y - 2, 5, 5);
        G.setColor(1, 1, 1, 1);
        G.rectangle("fill", player.x - 1, player.y - 1, 3, 3);
      }
    }
    if (current && current.x != null && current.y != null) {
      // FlyMap's cursor is TownMapMon; only the MAP card's is the arrow.
      if (!(this.fly && this.drawFlyMonCursor(current.x, current.y))) {
        this.mapCursorSprite(current.x, current.y);
      }
    }
  }

  // Lua: Pokegear.lua:2234 -- ChrisSpriteGFX (RED_WALK) plus PAL_OW_RED.
  // SpriteRenderer is desktop-only in this port (inert), so the icon is the
  // sprite's own cooked sheet drawn as objects -- what the cart's OAM shows.
  loadPlayerIcon(): void {
    if (this.playerIcon !== undefined) return;
    this.playerIcon = false;
    const def = this.sprites
      ? this.sprites[FieldMoves.playerSprite(this.save && this.save.player ? this.save.player.gender : undefined)]
      : undefined;
    if (!(def && def.image)) return;
    let image: LcdImage | undefined;
    try {
      image = Assets.image(def.image);
    } catch {
      image = undefined;
    }
    if (!image) return;
    const world = this.game ? this.game.world : undefined;
    const daytime = (world && world.daytime)
      || Palettes.clockDaytime(this.clock && this.clock.hour != null ? this.clock.hour : undefined);
    const colors = this.palettes ? Palettes.spritePalette(this.palettes, daytime, def) : undefined;
    this.playerIcon = { image, objColors: colors };
  }

  // One 16x16 frame of a cooked sprite sheet at pixel (x, y), as objects.
  private drawIconFrame(icon: IconSprite, frameIndex: number, x: number, y: number, flip: boolean): void {
    const [w, h] = icon.image.getDimensions();
    const quad = G.newQuad(0, frameIndex * 16, 16, 16, w, h);
    G.setColor(1, 1, 1, 1);
    GbcPalette.with(icon.objColors, () => {
      G.push();
      G.objects = true;
      try {
        if (flip) G.draw(icon.image, quad, x + 16, y, 0, -1, 1);
        else G.draw(icon.image, quad, x, y);
      } finally {
        G.pop();
      }
    });
  }

  // Lua: Pokegear.lua:2258 -- .Frameset_RedWalk: stand, walk, stand, walk
  // B_OAM_XFLIP (FacingStepDown0-3), hung at -8,-8.
  drawPlayerIcon(x: number, y: number): boolean {
    this.loadPlayerIcon();
    const icon = this.playerIcon;
    if (!icon) return false;
    const beat = Math.floor((this.iconTimer ?? 0) / 8);
    // sheet frames: 0 standing down, 3 walking down
    this.drawIconFrame(icon, beat % 2 === 1 ? 3 : 0, x - 8, y - 8, beat === 3);
    return true;
  }

  // Lua: Pokegear.lua:2274 -- TownMapMon: the FlyMon's party icon on PAL_OW_RED.
  loadFlyMonIcon(): void {
    if (this.flyMonIcon !== undefined) return;
    this.flyMonIcon = false;
    const mon = this.flyMon;
    if (mon === null || typeof mon !== "object") return;
    const icons = this.icons;
    const iconId = mon.isEgg ? "ICON_EGG"
      : (icons && icons.species && mon.species ? icons.species[mon.species] : undefined);
    const entry = iconId && icons && icons.icons ? icons.icons[iconId] : undefined;
    if (!(entry && entry.image)) return;
    const def = {
      id: "SPRITE_FLY_MON", image: entry.image, frames: 2, walker: false,
      spriteType: "POKEMON_SPRITE", palette: "PAL_OW_RED", paletteId: 0,
      species: mon.species, icon: iconId,
    };
    let image: LcdImage | undefined;
    try {
      image = Assets.image(def.image);
    } catch {
      image = undefined;
    }
    if (!image) return;
    const world = this.game ? this.game.world : undefined;
    const daytime = (world && world.daytime)
      || Palettes.clockDaytime(this.clock && this.clock.hour != null ? this.clock.hour : undefined);
    const colors = this.palettes ? Palettes.spritePalette(this.palettes, daytime, def) : undefined;
    this.flyMonIcon = { image, objColors: colors };
  }

  // Lua: Pokegear.lua:2305 -- .Frameset_PartyMon: two 8-frame beats.
  drawFlyMonCursor(x: number, y: number): boolean {
    this.loadFlyMonIcon();
    const icon = this.flyMonIcon;
    if (!icon) return false;
    this.drawIconFrame(icon, Math.floor((this.iconTimer ?? 0) / 8) % 2, x - 8, y - 8, false);
    return true;
  }

  // Lua: Pokegear.lua:2317 -- the cursor arrow, tiles $04-$07 centred on the
  // landmark.
  mapCursorSprite(x: number, y: number): void {
    this.loadArrowSheet();
    const arrow = this.arrow;
    if (arrow && arrow.available()) {
      G.setColor(1, 1, 1, 1);
      const tx = (x - 8) / 8;
      const ty = (y - 8) / 8;
      this.arrowObjects(() => {
        arrow.draw(0x04, tx, ty);
        arrow.draw(0x05, tx + 1, ty);
        arrow.draw(0x06, tx, ty + 1);
        arrow.draw(0x07, tx + 1, ty + 1);
      });
      return;
    }
    Chrome.cursor(Math.floor(x / 8), Math.floor(y / 8));
  }

  // Lua: Pokegear.lua:2336 -- tile $08 three rows deep, x = knob.
  drawTuningKnob(): void {
    this.loadArrowSheet();
    const arrow = this.arrow;
    if (!(arrow && arrow.available())) return;
    const row = this.currentStation();
    const tx = (72 + (row ? row.knob : 0)) / 8;
    this.arrowObjects(() => {
      arrow.draw(0x08, tx, 1);
      arrow.draw(0x08, tx, 2);
      arrow.draw(0x08, tx, 3);
    });
  }

  // Lua: Pokegear.lua:2346
  drawRadio(): void {
    this.ensureTuned();
    this.drawTilemap(this.gfx && this.gfx.cards ? this.gfx.cards.radio : undefined);
    this.drawStrip();
    this.drawTuningKnob();
    const station = this.currentStation();
    const radio = this.radio;
    // the station's name and the box's two lines: the same cells until one
    // of them changes (screen.ts cachedBlock)
    const live = !!(station && station.station && radio);
    const key = `radio:${(station && station.name) || ""}:${live ? `${radio!.top}\u0000${radio!.bottom}` : "-"}`
      + `:${keyOf(this.pals())}:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => {
      // UpdateRadioStation prints the name at (2,9); dead air prints nothing.
      this.text((station && station.name) || "", 2, 9);
      this.textbox(0, 12, 18, 4);
      if (!live) return;
      if (radio!.top !== "") this.text(radio!.top, 1, 14);
      if (radio!.bottom !== "") this.text(radio!.bottom, 1, 16);
    });
  }

  // Lua: Pokegear.lua:2365
  drawPhone(): void {
    // the card is the same cells until the list, the cursor, a submenu, a
    // call's text or the signal changes (screen.ts cachedBlock)
    const list = this.phoneList();
    const service = Phone.mapHasService(this.phoneContext()) ? 1 : 0;
    const key = `phone:${list.join(",")}:${this.phoneScroll}:${this.phoneCursor}:${this.phoneSubmenu ?? ""}`
      + `:${this.phoneSubmenuCursor}:${this.call ? (this.call.text ?? "\u0001") : "\u0000"}:${service}`
      + `:${this.phoneText("AskWhoCall")}:${keyOf(this.cards)}:${keyOf(this.pals())}:${keyOf(this.sheet)}`
      + `:${GbcPalette.stateKey()}`;
    cachedBlock(this, key, () => this.drawPhoneNow());
  }

  /** drawPhone's drawing. */
  private drawPhoneNow(): void {
    this.drawTilemap(this.gfx && this.gfx.cards ? this.gfx.cards.phone : undefined);
    this.drawStrip();
    // .PlacePhoneBars: the fourth tile only with service.
    this.tile(0x3c, 17, 1);
    this.tile(0x3d, 18, 1);
    this.tile(0x3e, 17, 2);
    if (Phone.mapHasService(this.phoneContext())) this.tile(0x3f, 18, 2);

    this.textbox(0, 12, 18, 4);
    if (this.call) {
      const lines = Chrome.wrap(this.call.text ?? this.phoneText("GearEllipse"), 18);
      for (let i = 1; i <= Math.min(lines.length, 3); i++) this.text(lines[i - 1]!, 1, 13 + i);
    } else {
      this.printBoxText(this.phoneText("AskWhoCall"));
    }
    // PokegearPhone_UpdateDisplayList: four slots from (2,4), two rows apart.
    const list = this.phoneList();
    for (let row = 1; row <= PHONE_ROWS; row++) {
      const id = list[row - 1 + this.phoneScroll] ?? 0;
      const ty = 4 + (row - 1) * 2;
      const [label, className] = this.contactRow(id);
      this.text(label, 2, ty);
      if (className) this.text(className, 5, ty + 1);
    }
    // PokegearPhone_UpdateCursor: (1, 4 + 2 * cursor).
    this.cursor(1, 4 + this.phoneCursor * 2);
    this.drawPhoneSubmenu();
  }

  // Lua: Pokegear.lua:2407 -- PokegearPhoneContactSubmenu's box and entries.
  drawPhoneSubmenu(): void {
    const menu = PHONE_SUBMENUS[this.phoneSubmenu ?? ""];
    if (!menu) return;
    this.textbox(menu.x, menu.y, 8, menu.rows * 2);
    menu.entries.forEach((label, index) => {
      const ty = menu.textY + index * 2;
      this.text(Strings.get(PHONE_SUBMENU_LABELS[label] ?? label), menu.textX, ty);
    });
    this.cursor(menu.textX - 1, menu.textY + this.phoneSubmenuCursor * 2);
  }

  // ------------------------------------------------------------- fallback

  // Lua: Pokegear.lua:2422 -- no gear sheet in this cache.
  drawPlain(): void {
    Chrome.clear();
    if (this.fly) {
      Chrome.box(0, 0, 20, 4);
      Chrome.print(Strings.get("Where?"), 2, 1);
      Chrome.box(0, 4, 20, 14);
      const rows = this.fly;
      const top = Math.max(1, Math.min((this.flyIndex ?? 1) - 3, rows.length - 5));
      for (let slot = 0; slot <= 5; slot++) {
        const index = top + slot;
        const row = rows[index - 1];
        if (row) {
          const ty = 5 + slot * 2;
          if (index === (this.flyIndex ?? 1)) Chrome.cursor(1, ty);
          Chrome.print(flatName(row.name), 2, ty);
        }
      }
      return;
    }
    if (this.townMap) {
      Chrome.box(7, 0, 13, 3);
      const current = this.mapLandmark();
      Chrome.print(flatName(current ? current.name : undefined), 9, 1);
      return;
    }
    Chrome.box(0, 0, 20, 4);
    const card = this.card();
    Chrome.print(this.cardLabel(card), 2, 1);
    if (this.cards.length > 1) Chrome.cursor(17, 1);
    const id = card ? card.id : undefined;
    if (id === "clock") {
      const [hour, minute, weekday] = this.clockParts();
      Chrome.box(1, 5, 18, 7);
      Chrome.print(Clock.weekdayName(weekday) ?? Strings.get(DAY_LABEL), 3, 7);
      let display = hour % 12;
      if (display === 0) display = 12;
      Chrome.print(format("%s:%s %s", Chrome.number(display, 2), Chrome.number(minute, 2, true), meridiem(hour)), 5, 9);
      Chrome.print(Clock.daytimeLabel(hour), 5, 11);
    } else if (id === "radio") {
      Chrome.box(0, 4, 20, 14);
      this.stations().forEach((row, i) => {
        const ty = 5 + i * 2;
        if (ty < 17) {
          if (i + 1 === this.station) Chrome.cursor(1, ty);
          Chrome.print(row.frequency + " " + (row.name ?? ""), 2, ty);
        }
      });
    } else if (id === "phone") {
      Chrome.box(0, 3, 20, 9);
      const list = this.phoneList();
      for (let row = 1; row <= PHONE_ROWS; row++) {
        const ty = 4 + (row - 1) * 2;
        const [label, className] = this.contactRow(list[row - 1 + this.phoneScroll] ?? 0);
        Chrome.print(label, 2, ty);
        if (className) Chrome.print(className, 5, ty + 1);
      }
      Chrome.cursor(1, 4 + this.phoneCursor * 2);
      Chrome.textbox(0, 12, 18, 4);
      Chrome.printWrapped(this.call ? this.call.text ?? "" : this.phoneText("AskWhoCall"), 1, 14, 18, 3);
      this.drawPhoneSubmenu();
    } else {
      Chrome.box(0, 4, 20, 14);
      Chrome.print(Strings.get("NO CARD DATA"), 2, 6);
    }
  }

  // Lua: Pokegear.lua:2503
  drawPanel(): void {
    if (!this.styled()) {
      this.drawPlain();
      G.setColor(1, 1, 1, 1);
      return;
    }
    const paint = (): void => {
      // InitPokegearTilemap ByteFills SCREEN_AREA with $4f.
      const ground = this.groundColor();
      G.setColor(ground[0]! / 255, ground[1]! / 255, ground[2]! / 255, 1);
      G.rectangle("fill", 0, 0, SCREEN_W * 8, SCREEN_H * 8);
      const card = this.card();
      const id = card ? card.id : undefined;
      if (id === "map") this.drawMap();
      else if (id === "radio") this.drawRadio();
      else if (id === "phone") this.drawPhone();
      else this.drawClock();
      // Last: the arrow is an OBJ. _FlyMap and _TownMap never show it.
      if (!(this.fly || this.townMap)) this.drawModeArrow();
    };
    // NOT FAITHFUL: with a custom ramp the Lua paints into a film canvas and
    // redraws it through GbcPalette.customRamp. The Gold screen has no
    // canvas (draws inside one are dropped), so the gear paints straight
    // onto the screen in its own palettes and the custom ramp is not applied.
    G.push();
    G.origin();
    try {
      paint();
    } finally {
      G.pop();
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: Pokegear.lua:2561
  draw(): void {
    this.drawPanel();
  }

  // Lua: Pokegear.lua:2565 -- the surround takes the gear's own ground; the
  // Gold screen IS the panel, so the fit is the origin.
  drawWidescreen(winW: number, winH: number): void {
    const ground = this.groundColor();
    Chrome.letterbox(winW, winH, ground[0]! / 255, ground[1]! / 255, ground[2]! / 255);
    const scale = Chrome.fitScale();
    const [ox, oy] = Chrome.fitOrigin();
    G.push();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default Pokegear;
