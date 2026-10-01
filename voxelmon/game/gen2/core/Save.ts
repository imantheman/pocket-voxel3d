// gen1recomp src/core/gen2/Save.lua at bdfac727 (MIT): the Gen 2 save file.
//
// Brian's save table shape, his FORMAT and migrations, his validate /
// quarantine pass and his serializer (shared/core/SaveSerializer.ts) are
// kept. What changes is where the bytes go: Brian writes save_gold.lua with a
// .bak and a .tmp through love.filesystem (Save.lua:883-984); we hand the
// encoded text to platform/saveio.ts, whose write is all-or-nothing, so the
// backup/staging dance collapses into its boolean and `recovered` is never
// "bak"/"tmp". The launcher's slot registry is inert (shared/core/SaveData.ts),
// so the flat single-save path is the one that runs, as Save.lua:145-149.
//
// Shape conventions for JS (see SaveSerializer.ts): Lua sequences are arrays
// (party, box lists, hallOfFame.teams, unownDex, mail.box); 1-based sparse
// tables are arrays indexed key-1 (boxes, boxNames, mail.party); everything
// else is an object. Public slot/box numbers stay 1-based as in the Lua.

import { GameVersion } from "../shared/core/GameVersion.ts";
import { HallOfFame } from "./HallOfFame.ts";
import { Mail, type LostMail } from "./Mail.ts";
import { MomShopping } from "./MomShopping.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { SaveSerializer } from "../shared/core/SaveSerializer.ts";
import { SaveData } from "../shared/core/SaveData.ts";
import { Mon } from "../battle/Mon.ts";
import { random } from "../platform/rng.ts";
import { osDate, osTime } from "../platform/clock.ts";
import { tonumber, tostring, removeAt } from "../platform/lua.ts";
import * as saveio from "../platform/saveio.ts";

export type SaveTable = Record<string, any>;

export interface SaveReport {
  lostScriptMem: Array<{ addr: unknown; value: unknown }>;
  lostMail: LostMail[];
  lostEvents: Array<{ byte: unknown; value: unknown }>;
  lostMapScenes: Array<{ map: unknown; scene: unknown }>;
  lostPlayerState: Array<{ state: unknown }>;
}

// Lua: Save.lua:36-41 -- love.math.random or math.random: both are rng.ts.
function rand(a: number, b: number): number {
  return random(a, b);
}

const isTable = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object";

/** Lua `for _, v in pairs(t)` over a table that may be an array or an object. */
function values(t: unknown): any[] {
  if (Array.isArray(t)) return t.filter((v) => v != null);
  if (isTable(t)) return Object.keys(t).map((k) => t[k]);
  return [];
}

/** Lua `for k, v in pairs(t)` with the Lua key (arrays: index + 1). */
function entries(t: unknown): Array<[string | number, any]> {
  const out: Array<[string | number, any]> = [];
  if (Array.isArray(t)) {
    t.forEach((v, i) => {
      if (v != null) out.push([i + 1, v]);
    });
    for (const k of Object.keys(t)) if (!/^\d+$/.test(k)) out.push([k, (t as any)[k]]);
  } else if (isTable(t)) {
    for (const k of Object.keys(t)) out.push([k, t[k]]);
  }
  return out;
}

// Lua: Save.lua:109-150 -- the active slot's names, else the flat names.
function saveNames(version?: string): [string, string, string] {
  version = version ?? GameVersion.get();
  let cart: string | undefined = SaveData.getCart();
  if (typeof cart !== "string" || cart === "") cart = undefined;
  let slot: string | undefined;
  if (cart) slot = SaveData.activeCartSlot(cart);
  else slot = SaveData.activeSlot(version);
  if (slot) {
    const scope = cart ? `cart_${cart}` : version;
    const main = `saves/${scope}/${slot}.lua`;
    return [main, `${main}.bak`, `${main}.tmp`];
  }
  const suffix = cart ? `_cart_${cart}` : GameVersion.saveSuffix(version);
  const main = `save${suffix}.lua`;
  return [main, `${main}.bak`, `${main}.tmp`];
}

// Lua: Save.lua:374-380
const SHARED_KEYS: Record<string, true> = {
  touchControls: true, haptics: true, screenPos: true,
  videoMode: true,
  mods: true, modsByVersion: true, modsGen2: true,
  modOptions: true, modProfiles: true, modProfilesSeeded: true,
  activeProfile: true,
};

// Lua: Save.lua:430-438 -- MON_PKRS is one byte.
function normalizePokerus(mons: unknown): void {
  for (const mon of Array.isArray(mons) ? mons : []) {
    if (isTable(mon) && mon.pokerus != null) {
      let value = tonumber(mon.pokerus) ?? 0;
      if (value < 0) value = 0;
      mon.pokerus = Math.floor(value) % 256;
    }
  }
}

// Lua: Save.lua:441-454 -- constants/pokemon_data_constants.asm:79, :90
function normalizeMoves(mons: unknown): void {
  for (const mon of Array.isArray(mons) ? mons : []) {
    if (isTable(mon) && Array.isArray(mon.moves)) {
      let rebuilt = false;
      mon.moves.forEach((entry: unknown, i: number) => {
        if (!isTable(entry)) {
          mon.moves[i] = { id: entry, pp: (mon.pp || [])[i] };
          rebuilt = true;
        }
      });
      if (rebuilt) delete mon.pp;
    }
  }
}

// Lua: Save.lua:459-461
function counter(value: unknown): number {
  return Math.max(0, Math.floor(tonumber(value) ?? 0));
}

// Lua: Save.lua:731-756
function scrubScriptMem(save: SaveTable, report: SaveReport): void {
  const mem = save.scriptMem;
  if (!isTable(mem)) {
    if (mem != null) report.lostScriptMem.push({ addr: undefined, value: mem });
    save.scriptMem = {};
    return;
  }
  const clean: Record<string, number> = {};
  for (const [key, value] of entries(mem)) {
    const addr = tonumber(key);
    const byte = tonumber(value);
    const okAddr = addr !== undefined && addr === Math.floor(addr) && addr >= 0 && addr <= 0xffff;
    const okByte = byte !== undefined && byte === Math.floor(byte) && byte >= 0 && byte <= 255;
    if (okAddr && okByte) clean[addr!] = byte!;
    else report.lostScriptMem.push({ addr: key, value });
  }
  save.scriptMem = clean;
}

// Lua: Save.lua:764-787
function scrubEvents(save: SaveTable, report: SaveReport): void {
  const flags = save.events;
  if (!isTable(flags)) {
    if (flags != null) report.lostEvents.push({ byte: undefined, value: flags });
    save.events = {};
    return;
  }
  const clean: Record<string, number> = {};
  for (const [key, value] of entries(flags)) {
    const index = tonumber(key);
    const byte = tonumber(value);
    const okIndex = index !== undefined && index === Math.floor(index) && index >= 0 && index < Save.EVENT_BYTES;
    const okByte = byte !== undefined && byte === Math.floor(byte) && byte >= 0 && byte <= 255;
    if (okIndex && okByte) clean[index!] = byte!;
    else report.lostEvents.push({ byte: key, value });
  }
  save.events = clean;
}

// Lua: Save.lua:795-819
function scrubMapScenes(save: SaveTable, report: SaveReport): void {
  const scenes = save.mapScenes;
  if (!isTable(scenes)) {
    if (scenes != null) report.lostMapScenes.push({ map: undefined, scene: scenes });
    save.mapScenes = {};
    return;
  }
  const clean: Record<string, number> = {};
  for (const [key, value] of entries(scenes)) {
    const scene = tonumber(value);
    const okMap = typeof key === "string" && key !== "";
    const okScene = scene !== undefined && scene === Math.floor(scene) && scene >= 0 && scene <= 255;
    if (okMap && okScene) clean[key as string] = scene!;
    else report.lostMapScenes.push({ map: key, scene: value });
  }
  save.mapScenes = clean;
}

// Lua: Save.lua:827-834
function scrubPlayerState(save: SaveTable, report: SaveReport): void {
  const state = save.playerState;
  if (typeof state === "string" && Save.PLAYER_STATES[state]) return;
  if (state != null) report.lostPlayerState.push({ state });
  save.playerState = Save.PLAYER_NORMAL;
}

// Lua: Save.lua:883-893, reading the seam instead of a path.
function readTable(): [SaveTable | undefined, string?] {
  const raw = saveio.read();
  if (raw === undefined) return [undefined, "missing"];
  const value = SaveSerializer.decode(raw);
  if (!isTable(value)) return [undefined, `corrupt: ${tostring(value)}`];
  return [value];
}

// Not in the Lua: the JS shape of a decoded table (SaveSerializer.ts header).
// A Lua `{}` decodes as an empty array; the fields the save keys by name or
// by a non-positional number are objects, so give those their object back,
// and read a file of Brian's number-keyed wEventFlags/scriptMem (which
// decode as arrays with holes, key k at index k-1) back into keyed objects.
const MAP_FIELDS: string[][] = [
  ["events"], ["scriptMem"], ["mapScenes"], ["flags"], ["inventory"], ["pcItems"],
  ["phoneContacts"], ["tradeFlags"], ["pokedex", "seen"], ["pokedex", "caught"],
  ["player", "badges"], ["player", "kantoBadges"],
];

function asObject(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, e] of entries(v)) out[String(k)] = e;
  return out;
}

function reshape(save: SaveTable): void {
  for (const path of MAP_FIELDS) {
    let parent: any = save;
    for (let i = 0; i < path.length - 1 && isTable(parent); i++) parent = parent[path[i]!];
    const leaf = path[path.length - 1]!;
    if (isTable(parent) && Array.isArray(parent[leaf])) parent[leaf] = asObject(parent[leaf]);
  }
}

export const Save = {
  // Lua: Save.lua:86 -- bumped whenever a field's meaning changes.
  FORMAT: 8,

  // Lua: Save.lua:88-97
  MAX_MONEY: 999999,
  MAX_COINS: 9999,
  PARTY_SIZE: 6,
  NUM_BOXES: 14,
  MONS_PER_BOX: 20,
  EVENT_BYTES: 256,

  // Lua: Save.lua:104-107 -- wPlayerState by name.
  PLAYER_NORMAL: "normal",
  PLAYER_STATES: { normal: true, bike: true, surf: true, surf_pika: true } as Record<string, boolean>,

  // Lua: Save.lua:152 -- [main, backup, tmp]; informational on this build.
  filenames: saveNames,

  // Lua: Save.lua:163-167 -- pokegold data/player_names.asm.
  DEFAULT_PLAYER_NAMES: { gold: "GOLD", silver: "SILVER", crystal: "CHRIS" } as Record<string, string>,

  // Lua: Save.lua:171-173
  DEFAULT_PLAYER_NAMES_FEMALE: { crystal: "KRIS" } as Record<string, string>,

  // Lua: Save.lua:176-179
  isFemale(save: unknown): boolean {
    const player = isTable(save) ? save.player : undefined;
    return (player && player.gender) === "female";
  },

  // Lua: Save.lua:181-188
  defaultPlayerName(version?: string | null, gender?: string): string {
    const v = version ?? GameVersion.get();
    if (gender === "female") {
      const female = Save.DEFAULT_PLAYER_NAMES_FEMALE[v];
      if (female) return female;
    }
    return Save.DEFAULT_PLAYER_NAMES[v] ?? "GOLD";
  },

  // Lua: Save.lua:192-309 -- a fresh Gen 2 save.
  newGame(opts?: { playerName?: string; gender?: string; trainerId?: number; rivalName?: string; momName?: string } | null): SaveTable {
    const o = opts ?? {};
    const save: SaveTable = {
      format: Save.FORMAT,
      version: GameVersion.get(),
      generation: 2,
      player: {
        name: o.playerName ?? Save.defaultPlayerName(undefined, o.gender ?? "male"),
        // _ResetWRAM rolls wPlayerID (engine/menus/intro_menu.asm:41-49).
        id: o.trainerId ?? rand(0, 65535),
        gender: o.gender ?? "male",
        money: 3000,
        coins: 0,
        badges: {},
        kantoBadges: {},
      },
      // InitializeNPCNames' .Rival row is "???@" (intro_menu.asm:131, :193-214).
      rival: { name: o.rivalName ?? "???" },
      // wMomSavingMoney's bits plus wWhichMomItem / wMomItemTriggerBalance.
      mom: {
        name: o.momName ?? "MOM", active: false, savingMoney: false,
        savedMoney: 0, whichItem: 0,
        triggerBalance: MomShopping.MOM_MONEY,
      },
      position: undefined,
      spawn: "SPAWN_HOME",
      playerState: Save.PLAYER_NORMAL,
      hallOfFame: { count: 0, teams: [] },
      spawnAfterChampion: undefined,
      party: [],
      boxes: [],
      currentBox: 1,
      boxNames: [],
      inventory: {},
      registeredItem: undefined,
      mail: { party: [], box: [] },
      pcItems: {},
      phoneContacts: {},
      tradeFlags: {},
      pokedex: { seen: {}, caught: {} },
      lastDexMode: "NEW",
      unownDex: [],
      firstUnownSeen: 0,
      events: {},
      flags: {},
      mapScenes: {},
      scriptMem: {},
      playTime: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      // StageRTCTimeForSave bookkeeping (engine/rtc/rtc.asm).
      rtc: {
        day: tonumber(osDate("%j")) ?? 1, hour: tonumber(osDate("%H")) ?? 0,
        minute: tonumber(osDate("%M")) ?? 0,
      },
      options: undefined, // lives in options.lua; see SaveData.saveOptions
      createdAt: osTime(),
    };
    return Runtime.call("save.new_game", (s: SaveTable) => s, save);
  },

  // Lua: Save.lua:314-355 -- Gen 2's OPTION screen plus the port's keys.
  DEFAULT_OPTIONS: {
    textSpeed: "MID",
    battleScene: true,
    battleStyle: "SHIFT",
    sound: "MONO",
    print: "NORMAL",
    menuAccount: true,
    frame: 1,
    speed: 1,
    performance: "auto",
    zoom: 0,
    tilt: 0,
    color: "gbc",
    palette: "",
    videoMode: "windowed",
    fpsCap: 60,
    battleLayout: "og",
    battleHud: "standard",
    battleFit: "fixed",
    battleBg: "white",
    voidFill: "fade",
    uiLetterbox: "auto",
    musicVol: 7,
    sfxVol: 7,
    musicFilter: 0,
    haptics: "light",
    touchControls: { enabled: true },
    screenPos: "center",
  } as Record<string, any>,

  // Lua: Save.lua:357-361 (shallow, as the Lua: touchControls is shared)
  defaultOptions(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const key of Object.keys(Save.DEFAULT_OPTIONS)) out[key] = Save.DEFAULT_OPTIONS[key];
    return out;
  },

  // Lua: Save.lua:372
  OPTIONS_KEY: "gold",

  // Lua: Save.lua:382-403
  loadOptions(fs?: unknown): Record<string, any> {
    const options = Save.defaultOptions();
    const loaded = SaveData.loadOptions(fs);
    const stored = loaded ? loaded[Save.OPTIONS_KEY] : undefined;
    if (isTable(stored)) {
      for (const key of Object.keys(stored)) {
        if (!SHARED_KEYS[key]) options[key] = stored[key];
      }
    }
    if (isTable(loaded)) {
      for (const key of Object.keys(SHARED_KEYS)) {
        if (loaded[key] != null) options[key] = loaded[key];
        else if (isTable(stored) && stored[key] != null) options[key] = stored[key];
      }
    }
    return options;
  },

  // Lua: Save.lua:407-423 -- read-modify-write under the `gold` key.
  saveOptions(options: unknown, fs?: unknown): boolean {
    if (!isTable(options)) return false;
    const file: Record<string, any> = SaveData.loadOptions(fs) || {};
    const block: Record<string, any> = {};
    for (const key of Object.keys(options)) {
      if (SHARED_KEYS[key]) file[key] = options[key];
      else block[key] = options[key];
    }
    file[Save.OPTIONS_KEY] = block;
    SaveData.saveOptions(file, fs);
    return true;
  },

  // Lua: Save.lua:457 -- ../pokecrystal/ram/sram.asm:140 sGSBallFlag.
  GS_BALL_STATES: { have: true, given: true, used: true } as Record<string, boolean>,

  // Lua: Save.lua:465-483 -- "SRAM Crystal Data", created on demand.
  crystalState(save: SaveTable): Record<string, any> {
    const crystal = save.crystal || {};
    save.crystal = crystal;
    if (crystal.celebiCaught == null) crystal.celebiCaught = false;
    crystal.beasts = crystal.beasts || {};
    const buena = crystal.buenaPassword || {};
    crystal.buenaPassword = buena;
    buena.prizesToday = counter(buena.prizesToday);
    buena.streak = counter(buena.streak);
    crystal.moveTutor = crystal.moveTutor || {};
    if (crystal.moveTutor.used == null) crystal.moveTutor.used = false;
    crystal.unownWords = crystal.unownWords || {};
    crystal.mapSign = crystal.mapSign || { prev: "LANDMARK_NEW_BARK_TOWN" };
    return crystal;
  },

  // Lua: Save.lua:487-499 -- "SRAM Battle Tower".
  battleTowerState(save: SaveTable): Record<string, any> {
    const tower = save.battleTower || {};
    save.battleTower = tower;
    tower.streak = counter(tower.streak);
    tower.best = counter(tower.best);
    tower.challenge = counter(tower.challenge);
    tower.prevTeams = tower.prevTeams || [];
    if (tower.inChallenge == null) tower.inChallenge = false;
    return tower;
  },

  // Lua: Save.lua:503-624 -- fill in anything a save is missing.
  normalize(save: unknown): SaveTable | undefined {
    if (!isTable(save)) return undefined;
    save.format = save.format ?? Save.FORMAT;
    if (!(GameVersion.VERSIONS[save.version] && GameVersion.generation(save.version) === 2)) {
      save.version = GameVersion.get();
    }
    save.generation = 2;
    save.player = save.player || {};
    save.player.gender = save.player.gender ?? "male";
    save.player.name = save.player.name ?? Save.defaultPlayerName(save.version, save.player.gender);
    save.player.id = save.player.id ?? rand(0, 65535);
    save.player.money = Math.max(0, Math.min(save.player.money ?? 0, Save.MAX_MONEY));
    save.player.coins = Math.max(0, Math.min(save.player.coins ?? 0, Save.MAX_COINS));
    save.player.badges = save.player.badges || {};
    save.player.kantoBadges = save.player.kantoBadges || {};
    save.rival = save.rival || { name: "???" };
    save.mom = save.mom || {};
    save.mom.name = save.mom.name ?? "MOM";
    if (save.mom.active == null) save.mom.active = false;
    if (save.mom.savingMoney == null) save.mom.savingMoney = false;
    save.mom.savedMoney = Math.max(0, Math.min(tonumber(save.mom.savedMoney) ?? 0, Save.MAX_MONEY));
    save.mom.whichItem = Math.max(0, Math.floor(tonumber(save.mom.whichItem) ?? 0));
    save.mom.triggerBalance = Math.max(0, Math.min(
      Math.floor(tonumber(save.mom.triggerBalance) ?? MomShopping.MOM_MONEY),
      Save.MAX_MONEY + MomShopping.MOM_MONEY));
    save.party = save.party || [];
    save.boxes = save.boxes || [];
    save.boxNames = save.boxNames || [];
    save.currentBox = save.currentBox ?? 1;
    save.inventory = save.inventory || {};
    Mail.state(save);
    save.pcItems = save.pcItems || {};
    save.phoneContacts = save.phoneContacts || {};
    save.tradeFlags = save.tradeFlags || {};
    save.pokedex = save.pokedex || {};
    save.pokedex.seen = save.pokedex.seen || {};
    save.pokedex.caught = save.pokedex.caught || {};
    save.unownDex = save.unownDex || [];
    while (save.unownDex.length > 26) removeAt(save.unownDex);
    let firstUnown = tonumber(save.firstUnownSeen) ?? 0;
    firstUnown = Math.floor(firstUnown);
    if (firstUnown < 0 || firstUnown > 26) firstUnown = 0;
    save.firstUnownSeen = firstUnown;
    save.events = save.events || {};
    save.flags = save.flags || {};
    save.mapScenes = save.mapScenes || {};
    save.playerState = save.playerState ?? Save.PLAYER_NORMAL;
    save.scriptMem = save.scriptMem || {};
    save.playTime = save.playTime || { hours: 0, minutes: 0, seconds: 0, frames: 0 };
    save.rtc = save.rtc || {};
    if (GameVersion.engine(save.version) === "crystal") {
      Save.crystalState(save);
      Save.battleTowerState(save);
    }
    const hof = HallOfFame.record(save)!;
    while (hof.teams.length > HallOfFame.NUM_TEAMS) removeAt(hof.teams);
    while (save.party.length > Save.PARTY_SIZE) removeAt(save.party);
    normalizePokerus(save.party);
    normalizeMoves(save.party);
    for (const box of values(save.boxes)) {
      if (isTable(box)) {
        normalizePokerus(box);
        normalizeMoves(box);
      }
    }
    // move_mon.asm:143-149: a mon the player owns carries wPlayerID.
    for (const mon of save.party) Mon.stampOT(save, mon);
    for (const box of values(save.boxes)) {
      if (Array.isArray(box)) for (const mon of box) Mon.stampOT(save, mon);
    }
    return save;
  },

  // Lua: Save.lua:627-705 -- each entry upgrades a save at `from` to from+1.
  MIGRATIONS: {
    1: (save: SaveTable) => {
      save.hallOfFame = save.hallOfFame || { count: 0, teams: [] };
      save.spawnAfterChampion = undefined;
    },
    2: (save: SaveTable) => {
      save.scriptMem = save.scriptMem || {};
    },
    3: (save: SaveTable) => {
      save.mail = save.mail || { party: [], box: [] };
    },
    4: (save: SaveTable) => {
      save.events = save.events || {};
      save.mapScenes = save.mapScenes || {};
    },
    5: (save: SaveTable) => {
      save.playerState = save.playerState ?? Save.PLAYER_NORMAL;
    },
    6: (save: SaveTable) => {
      save.mom = save.mom || {};
      if (save.mom.whichItem == null) save.mom.whichItem = 0;
      if (save.mom.triggerBalance == null) save.mom.triggerBalance = MomShopping.MOM_MONEY;
    },
    // ../pokecrystal/engine/events/poke_seer.asm:103-104
    7: (save: SaveTable) => {
      if (!Mon.hasCaughtData(save.version)) return;
      const clear = (mon: any): void => {
        if (!isTable(mon) || mon.isEgg) return;
        if ((tonumber(mon.caughtLocation) ?? 0) !== 0) return;
        mon.caughtTime = 0;
        mon.caughtLevel = 0;
        mon.caughtLocation = 0;
        mon.caughtByGender = "boy";
      };
      for (const mon of save.party || []) clear(mon);
      for (const box of values(save.boxes)) if (Array.isArray(box)) for (const mon of box) clear(mon);
      const dc = save.dayCare;
      if (isTable(dc)) {
        for (const which of ["man", "lady"]) {
          const side = dc[which];
          if (isTable(side)) clear(side.mon);
        }
      }
    },
  } as Record<number, (save: SaveTable) => void>,

  // Lua: Save.lua:707-717
  migrate(save: SaveTable): SaveTable {
    let fmt = tonumber(save.format) ?? 1;
    while (fmt < Save.FORMAT) {
      const step = Save.MIGRATIONS[fmt];
      if (!step) break;
      step(save);
      fmt += 1;
      save.format = fmt;
    }
    return save;
  },

  // Lua: Save.lua:836-861
  validate(save: unknown): SaveReport {
    const report: SaveReport = { lostScriptMem: [], lostMail: [], lostEvents: [], lostMapScenes: [], lostPlayerState: [] };
    if (!isTable(save)) return report;
    scrubScriptMem(save, report);
    scrubEvents(save, report);
    scrubMapScenes(save, report);
    scrubPlayerState(save, report);
    if (save.lastDexMode !== "NEW" && save.lastDexMode !== "OLD" && save.lastDexMode !== "A-Z") {
      save.lastDexMode = "NEW";
    }
    Mail.validate(save, report);
    return report;
  },

  // Lua: Save.lua:864-871
  emptyReport(report: unknown): boolean {
    if (!isTable(report)) return true;
    return (report.lostScriptMem || []).length === 0
      && (report.lostMail || []).length === 0
      && (report.lostEvents || []).length === 0
      && (report.lostMapScenes || []).length === 0
      && (report.lostPlayerState || []).length === 0;
  },

  // Lua: Save.lua:876-881 -- MainMenu_GetWhichMenu's wSaveFileExists.
  exists(_version?: string): boolean {
    return saveio.read() !== undefined;
  },

  /**
   * Lua: Save.lua:898-925 -- [save, recovered, err, report]. The seam has
   * no staged or backup copy, so `recovered` is always undefined.
   */
  load(_version?: string): [SaveTable | undefined, string | undefined, string | undefined, SaveReport | undefined] {
    const [data, err] = readTable();
    const recovered: string | undefined = undefined;
    if (!data) return [undefined, undefined, err, undefined];
    // The slot is shared with what came before the Gold engine: the Gen 1
    // guest's Gold walker wrote save_gold.lua in Gen 1's shape. Every Gen 2
    // save carries generation = 2 (newGame), so anything else is not one of
    // ours and must not be continued from.
    if ((data as { generation?: unknown }).generation !== 2) {
      return [undefined, undefined, "not a Gen 2 save", undefined];
    }
    reshape(data);
    Save.migrate(data);
    Save.normalize(data);
    const report = Save.validate(data);
    if (!Save.emptyReport(report)) {
      Logger.warn(
        "gold load report: %d script memory byte(s), %d MAIL struct(s), " +
        "%d event byte(s), %d map scene(s) and %d player state(s) dropped",
        report.lostScriptMem.length, report.lostMail.length, report.lostEvents.length,
        report.lostMapScenes.length, report.lostPlayerState.length);
    }
    return [data, recovered, undefined, report];
  },

  /** Lua: Save.lua:930-984 -- [ok, err]; the seam's write is atomic. */
  save(save: unknown): [boolean, string?] {
    if (!isTable(save)) return [false, "no save"];
    Save.normalize(save);
    const version = save.version;
    {
      let cart: string | undefined = SaveData.getCart();
      if (typeof cart !== "string" || cart === "") cart = undefined;
      if (cart) {
        if (!SaveData.activeCartSlot(cart)) {
          const id = SaveData.createCartSlot(cart);
          if (id) SaveData.setActiveCartSlot(cart, id);
        }
      } else if (!SaveData.activeSlot(version)) {
        const id = SaveData.createSlot(version);
        if (id) SaveData.setActiveSlot(version, id);
      }
    }
    save.savedAt = osTime();
    const encoded = SaveSerializer.encode(save);
    if (!saveio.write(encoded)) {
      const err = "write refused";
      Logger.error("gold save failed: %s", tostring(err));
      return [false, err];
    }
    Logger.info("saved gold game");
    return [true];
  },

  // Lua: Save.lua:989-1013 -- DisplaySaveInfoOnContinue's lines.
  summary(save: unknown): { name: string; badges: number; caught: number; hours: number; minutes: number; map: unknown } | undefined {
    if (!isTable(save)) return undefined;
    let badges = 0;
    for (const has of values(save.player && save.player.badges)) if (has !== false && has != null) badges += 1;
    for (const has of values(save.player && save.player.kantoBadges)) if (has !== false && has != null) badges += 1;
    let caught = 0;
    for (const has of values(save.pokedex && save.pokedex.caught)) if (has !== false && has != null) caught += 1;
    const time = save.playTime || {};
    return {
      name: (save.player && save.player.name) || "?",
      badges,
      caught,
      hours: time.hours ?? 0,
      minutes: time.minutes ?? 0,
      map: (save.position && save.position.map) || save.spawn,
    };
  },

  // Lua: Save.lua:1017-1032 -- one logic tick; the cart caps at 999:59.
  tickPlayTime(save: unknown): void {
    const t = isTable(save) ? save.playTime : undefined;
    if (!t) return;
    t.frames = (t.frames ?? 0) + 1;
    if (t.frames < 60) return;
    t.frames = 0;
    t.seconds = (t.seconds ?? 0) + 1;
    if (t.seconds < 60) return;
    t.seconds = 0;
    t.minutes = (t.minutes ?? 0) + 1;
    if (t.minutes < 60) return;
    t.minutes = 0;
    t.hours = Math.min((t.hours ?? 0) + 1, 999);
  },
};

export default Save;
