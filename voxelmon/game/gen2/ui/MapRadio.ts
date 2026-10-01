// The wall radios: a port of gen1recomp src/ui/gen2/MapRadio.lua (bdfac727,
// MIT) -- engine/pokegear/pokegear.asm PlayRadio.
//
// A house radio's bg event runs `jumpstd Radio1Script` -- `setval MAPRADIO_*`
// then `special MapRadio` -- and PlayRadio owns the joypad from there: it
// resolves the MAPRADIO_* index through PlayRadioStationPointers, prints the
// station's name in quotes in the text box, waits 100 frames, then runs one
// PlayRadioShow frame per loop until A or B. The show is the SAME state
// machine the Pokegear's radio card runs (Pokegear.Radio), and the exit music
// is the same ExitPokegearRadio_HandleMusic.
//
// Pushed by script/Specials.ts H.MapRadio while the script VM is parked on
// the special; `onDone` resumes it.

import { Chrome } from "./Chrome.ts";
import { Nests } from "../core/Nests.ts";
import { Pokegear, type RadioData, type Radio } from "./Pokegear.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Music } from "../shared/core/Music.ts";

// Lua: MapRadio.lua:126 -- PlayRadioStationPointers in MAPRADIO_* order.
// Index 0, LoadStation_PokemonChannel, resolves by region and time of day.
const STATIONS: Record<number, string> = {
  1: "OAKS_POKEMON_TALK",
  2: "POKEDEX_SHOW",
  3: "POKEMON_MUSIC",
  4: "LUCKY_CHANNEL",
  5: "UNOWN_RADIO",
  6: "PLACES_AND_PEOPLE",
  7: "LETS_ALL_SING",
  8: "ROCKET_RADIO",
};

// Lua: MapRadio.lua:137
const POKEGEAR_ONLY_STATIONS = ["POKE_FLUTE_RADIO", "EVOLUTION_RADIO"];

// Lua: MapRadio.lua:189 -- the player's landmark, as Game2.currentLandmark
// reads it.
function landmarkOf(game: any): string | undefined {
  const world = game ? game.world : undefined;
  const map = world && world.map ? world.map.def : undefined;
  return Nests.landmarkId(game ? game.data : undefined, map ? map.landmark : undefined);
}

export interface MapRadioOpts {
  channel?: number;
  onDone?: () => void;
  save?: any;
  currentLandmark?: unknown;
  radioData?: RadioData;
  radioRng?: () => number;
}

export class MapRadio {
  [key: string]: any;
  // Lua: MapRadio.lua:121 -- the map stays on screen under the text box.
  static isOpaque = false;
  isOpaque = false;
  static STATIONS = STATIONS;

  game: any;
  onDone: (() => void) | undefined;
  gear: Pokegear;
  station: string;
  stationName: string | undefined;
  radio: Radio;
  radioMusicPlaying: string | undefined;
  radioSong: string | undefined;
  hold: number;

  /**
   * Lua: MapRadio.lua:150 -- the eight dial positions plus the two
   * Pokegear-only signals into the `radio_channels` registry.
   */
  static registerInto(registry: any, _data?: unknown, owner?: unknown): number {
    let count = 0;
    for (const key of Object.keys(STATIONS)) {
      const channel = Number(key);
      const station = STATIONS[channel]!;
      registry.register(station, { channel, name: Pokegear.STATION_NAMES[station] }, owner);
      count++;
    }
    for (const station of POKEGEAR_ONLY_STATIONS) {
      registry.register(station, { name: Pokegear.STATION_NAMES[station] }, owner);
      count++;
    }
    return count;
  }

  /** Lua: MapRadio.lua:170 -- [record, station] for a dial position, or []. */
  static channelRecord(data: any, channel: number): [any, string] | [] {
    const rows = data ? data.gen2RadioChannels : undefined;
    if (rows !== null && typeof rows === "object") {
      for (const station of Object.keys(rows)) {
        const record = rows[station];
        if (record !== null && typeof record === "object" && record.channel === channel) {
          return [record, station];
        }
      }
      return [];
    }
    const station = STATIONS[channel];
    if (!station) return [];
    return [{ channel, name: Pokegear.STATION_NAMES[station] }, station];
  }

  // Lua: MapRadio.lua:197 -- opts: channel, onDone, and for tests save,
  // currentLandmark, radioData, radioRng.
  constructor(game: any, opts?: MapRadioOpts) {
    const o = opts ?? {};
    this.game = game;
    this.onDone = o.onDone;
    // The Pokegear owns the radio data assembly and the region/time reads.
    this.gear = Pokegear.new(game, {
      save: o.save ?? (game ? game.save : undefined),
      currentLandmark: o.currentLandmark ?? landmarkOf(game),
      radioData: o.radioData,
      radioRng: o.radioRng,
    });
    const [station, stationName] = this.resolveStation(o.channel ?? 0);
    this.station = station;
    this.stationName = stationName;
    this.radio = Pokegear.Radio.new({ data: this.gear.radioData(), rng: o.radioRng });
    this.radio.tune(this.station);
    // radio.channel: station, MAPRADIO_* channel, name, source "map_radio".
    if (Runtime.wants("radio.channel")) {
      Runtime.emit("radio.channel", {
        station: this.station, channel: o.channel ?? 0,
        name: this.name(),
        source: "map_radio",
      });
    }
    // .PlayStation parks ENTER_MAP_MUSIC before the show's own song lands.
    this.radioMusicPlaying = "enterMap";
    this.radioSong = undefined;
    // `ld c, 100 / call DelayFrames`: no button is read during the delay.
    this.hold = 100;
  }

  static new(game: any, opts?: MapRadioOpts): MapRadio {
    return new MapRadio(game, opts);
  }

  /**
   * Lua: MapRadio.lua:249 -- LoadStation_PokemonChannel: Johto mornings air
   * the Pokedex Show, the rest of the day Oak's talk; Kanto carries Places &
   * People. Answers [station, its record's display name].
   */
  resolveStation(channel: number): [string, string | undefined] {
    if (channel !== 0) {
      const [record, station] = MapRadio.channelRecord(this.game ? this.game.data : undefined, channel);
      if (station) return [station, record ? record.name : undefined];
      return ["OAKS_POKEMON_TALK", undefined];
    }
    if (this.gear.region() !== "johto") return ["PLACES_AND_PEOPLE", undefined];
    if ((this.gear.timeOfDayIndex() ?? 0) === 0) return ["POKEDEX_SHOW", undefined];
    return ["OAKS_POKEMON_TALK", undefined];
  }

  // Lua: MapRadio.lua:263 -- the name quoted in the text box.
  name(): string | undefined {
    if (this.stationName) return this.stationName;
    return (this.gear && this.gear.stationName(this.station)) || Pokegear.STATION_NAMES[this.station];
  }

  // Lua: MapRadio.lua:269
  close(): void {
    Pokegear.exitRadioMusic(this.game, this.radioMusicPlaying);
    this.radioMusicPlaying = undefined;
    const stack = this.game ? this.game.stack : undefined;
    if (stack) stack.pop();
    if (this.onDone) this.onDone();
  }

  // Lua: MapRadio.lua:277
  update(_dt?: number): void {
    if (this.hold > 0) {
      this.hold = this.hold - 1;
      return;
    }
    const input = this.game ? this.game.input : undefined;
    if (input && (input.wasPressed("a") || input.wasPressed("b"))) {
      this.close();
      return;
    }
    this.radio.step();
    const song = this.radio.music;
    if (song && song !== this.radioSong) {
      this.radioSong = song;
      this.radioMusicPlaying = Pokegear.radioPlayingValue(song);
      const data = this.game ? this.game.data : undefined;
      if (data) {
        try {
          Music.play(data, song);
        } catch {
          // pcall
        }
      }
    }
  }

  // Lua: MapRadio.lua:297 -- PlayRadio's frame: Textbox at (0,12), the name
  // quoted at (1,14) until the show's first line scrolls in.
  draw(): void {
    Chrome.textbox(0, 12, 18, 4);
    const radio = this.radio;
    if (radio.top === "" && radio.bottom === "") {
      const name = this.name() ?? "";
      Chrome.print("“" + name + "”", 1, 14);
      return;
    }
    if (radio.top !== "") Chrome.print(radio.top, 1, 14);
    if (radio.bottom !== "") Chrome.print(radio.bottom, 1, 16);
  }
}

export default MapRadio;
