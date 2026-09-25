// voxelmon/game/data.ts
var REQUIRED_MODULES = [
  "pokemon",
  "moves",
  "type_chart",
  "constants",
  "encounters"
];
var GEN_MODULES = [
  ...REQUIRED_MODULES,
  "items",
  "trainers",
  "maps",
  "tilesets",
  "sprites",
  "field",
  "text",
  "text_pointers",
  "trainer_headers"
];
function fromObject(source) {
  for (const name of REQUIRED_MODULES) {
    if (source[name] === undefined) {
      throw new Error(`voxelmon dataset is missing required module "${name}"`);
    }
  }
  return source;
}

// contracts/spec/voxel-spec.ts
var TILE_PX = 8;
var CELL_PX = 16;
var CHUNK_TILES = 16;
var CHUNK_PX = CHUNK_TILES * TILE_PX;
var GB_W = 160;
var GB_H = 144;
var UI_COLS = 20;
var UI_ROWS = 18;
var UI_PAGE_COLS = 16;
var UI_PAGE_ROWS = 24;
var UI_PAGE_TILES = UI_PAGE_COLS * UI_PAGE_ROWS;
var UI_TILE = {
  frame: 1,
  circle: 10,
  number: 11,
  arrowLeft: 19,
  badge: 32,
  badgeStride: 8,
  badgeHalf: 4,
  slotSymbol: 256,
  slotSymbolStride: 4
};
var VIEW_W = 480;
var VIEW_H = 272;
var WORLD_VIEW_H = 136;
var VOX_BTN = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7
};
var QUALITY_TIER = {
  psp: 0,
  vita: 1,
  desktop: 2
};
var QUALITY_TIER_DEFAULT = QUALITY_TIER.psp;
var CHUNK_DRAW_DIST_PX = 2.5 * WORLD_VIEW_H;
var ARENA_SHAPE = {
  wide: 0,
  narrow: 1
};
var RIG = {
  tele: {
    side: 78.79,
    back: 144.96,
    height: 37.88,
    lookX: -0.26,
    lookY: 0.34,
    frameH: 34.11
  },
  wide: {
    side: 41.98,
    back: 41.16,
    height: 28.48,
    lookX: -3.24,
    lookY: -1.35,
    frameH: 55.62
  }
};
var ENTS_MAX = 16;
var ENT_FLAG = {
  mirror: 1 << 0,
  ghost: 1 << 1,
  walker: 1 << 2
};
var FX_FRAME_CUT_TREE = 3;
var PICS_MAX = 16;
var Q4 = 16;
var Q8 = 256;
var AUDIO_ENGINES = 4;
var AUDIO_DRUMS = 32;
var AUDIO_SFX_TEMPO = 128;
var AUDIO_MUSIC_FLAG = {
  loop: 1 << 0
};
var AUDIO_SFX_FLAG = {
  duck: 1 << 0
};
var VXPK_ALIGN = 16;
var VXPK_META_FLAG_TREE_LOD = 1 << 0;
var VXPK_META_FLAG_TREE_COARSE = 1 << 1;
var VXPK_META_FLAG_GROUND_BAKE = 1 << 2;
var VXPK_AUDIO_HEADER_SIZE = 16;
var VXPK_COLOR_FLAG_WORLD = 1 << 0;
var MESH_KINDS = 9;
var VXPK_CHUNK_RECORD_SIZE = 20 + MESH_KINDS * 12;

// voxelmon/game/audio/banks.ts
function u32(bytes, at) {
  return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}
function readAudioSection(bytes) {
  if (bytes.length < VXPK_AUDIO_HEADER_SIZE) {
    throw new Error("audio: AUDI payload is shorter than its header");
  }
  const jsonLen = u32(bytes, 0);
  const programLen = u32(bytes, 4);
  const programsOff = Math.ceil((VXPK_AUDIO_HEADER_SIZE + jsonLen) / VXPK_ALIGN) * VXPK_ALIGN;
  if (programsOff + programLen > bytes.length) {
    throw new Error("audio: AUDI halves do not fit in the payload");
  }
  return {
    json: bytes.subarray(VXPK_AUDIO_HEADER_SIZE, VXPK_AUDIO_HEADER_SIZE + jsonLen),
    programs: bytes.subarray(programsOff, programsOff + programLen)
  };
}
function utf8(bytes) {
  let out = "";
  for (let i = 0;i < bytes.length; ) {
    const b = bytes[i];
    if (b < 128) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 224) {
      out += String.fromCharCode((b & 31) << 6 | bytes[i + 1] & 63);
      i += 2;
    } else if (b < 240) {
      out += String.fromCharCode((b & 15) << 12 | (bytes[i + 1] & 63) << 6 | bytes[i + 2] & 63);
      i += 3;
    } else {
      const cp = (b & 7) << 18 | (bytes[i + 1] & 63) << 12 | (bytes[i + 2] & 63) << 6 | bytes[i + 3] & 63;
      const v = cp - 65536;
      out += String.fromCharCode(55296 + (v >> 10), 56320 + (v & 1023));
      i += 4;
    }
  }
  return out;
}

class AudioBanks {
  manifest;
  slots = new Map;
  constructor(manifest) {
    this.manifest = manifest;
    manifest.bankOrder.forEach((bank, index) => this.slots.set(bank, index));
  }
  get playable() {
    return this.manifest.bankOrder.length > 0 && Object.keys(this.manifest.songs).length > 0;
  }
  ref(header) {
    if (!header)
      return null;
    const slot = this.slots.get(header.bank);
    if (slot === undefined)
      return null;
    return { bank: slot, address: header.address, engine: header.engine };
  }
  song(label) {
    return label ? this.ref(this.manifest.songs[label]) : null;
  }
  sfx(name) {
    return this.ref(this.manifest.sfx[name]);
  }
  cry(species) {
    const def = this.manifest.cries[species];
    const ref = def && this.ref(def.header);
    return ref ? { ...ref, pitch: def.pitch, length: def.length } : null;
  }
  mapSong(mapId) {
    return this.manifest.mapSongs[mapId];
  }
  battleSong(role) {
    return this.manifest.battle[role];
  }
  pins() {
    const out = [];
    for (const [engine, spec] of Object.entries(this.manifest.waveBanks)) {
      const id = Number(engine);
      const slot = this.slots.get(spec.bank);
      if (!Number.isInteger(id) || id < 0 || id >= AUDIO_ENGINES)
        continue;
      if (slot === undefined)
        continue;
      out.push({ engine: id, drum: -1, bank: slot, address: spec.address });
    }
    for (const [engine, drums] of Object.entries(this.manifest.noiseHeaders)) {
      const id = Number(engine);
      if (!Number.isInteger(id) || id < 0 || id >= AUDIO_ENGINES)
        continue;
      for (const [drum, header] of Object.entries(drums)) {
        const drumId = Number(drum);
        const slot = this.slots.get(header.bank);
        if (!Number.isInteger(drumId) || drumId < 0 || drumId >= AUDIO_DRUMS)
          continue;
        if (slot === undefined)
          continue;
        out.push({ engine: id, drum: drumId, bank: slot, address: header.address });
      }
    }
    return out;
  }
}
function fromSection(bytes) {
  if (!bytes)
    return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length === 0)
    return null;
  const { json } = readAudioSection(view);
  if (json.length === 0)
    return null;
  return new AudioBanks(JSON.parse(utf8(json)));
}

// voxelmon/game/world/bike.ts
var BIKE_STEP_FRAMES = 8;
var SURF_SONG = "Music_Surfing";
var BIKE_SONG = "Music_BikeRiding";
var OUTDOOR_SONGS = new Set([
  "Music_PalletTown",
  "Music_Cities1",
  "Music_Cities2",
  "Music_Celadon",
  "Music_Cinnabar",
  "Music_Vermilion",
  "Music_Lavender",
  "Music_Routes1",
  "Music_Routes2",
  "Music_Routes3",
  "Music_Routes4",
  "Music_IndigoPlateau",
  "Music_SafariZone",
  "Music_Dungeon1",
  "Music_Dungeon2",
  "Music_Dungeon3"
]);
var BIKE_RIDING_DEFAULT = {
  maps: ["ROUTE_23", "INDIGO_PLATEAU"],
  tilesets: ["OVERWORLD", "FOREST", "UNDERGROUND", "SHIP_PORT", "CAVERN"]
};
function bikeAllowed(mapId, tileset, rules) {
  const br = rules ?? BIKE_RIDING_DEFAULT;
  if (br.maps?.includes(mapId))
    return true;
  return !!tileset && !!br.tilesets?.includes(tileset);
}
function effectiveMapSong(song, onBike, surfing = false) {
  if (!song)
    return song;
  if (surfing)
    return SURF_SONG;
  if (!onBike)
    return song;
  return OUTDOOR_SONGS.has(song) ? BIKE_SONG : song;
}

// voxelmon/game/audio/music.ts
var FANFARES = {
  Level_Up: true,
  Caught_Mon: true,
  Get_Item1: true,
  Get_Item2: true,
  Get_Key_Item: true,
  Pokedex_Rating: true,
  Dex_Page_Added: true,
  Pokeflute: true
};

class AudioDirector {
  banks;
  host;
  current = null;
  mapSong = null;
  failed = new Set;
  constructor(banks, host = null) {
    this.banks = banks && banks.playable ? banks : null;
    this.host = host;
    if (this.banks && this.host) {
      for (const pin of this.banks.pins()) {
        if (pin.drum < 0)
          this.host.audioWaves(pin.engine, pin.bank, pin.address);
        else
          this.host.audioDrum(pin.engine, pin.drum, pin.bank, pin.address);
      }
    }
  }
  get live() {
    return this.banks !== null && this.host !== null;
  }
  get playing() {
    return this.current;
  }
  startMap(mapId, onBike = false, surfing = false) {
    const song = this.banks?.mapSong(mapId) ?? null;
    this.mapSong = song;
    const play = effectiveMapSong(song, onBike, surfing);
    if (play)
      this.play(play);
  }
  noteMap(mapId) {
    this.mapSong = this.banks?.mapSong(mapId) ?? null;
  }
  playBattle(kind = "wild") {
    const label = this.banks?.battleSong(kind) ?? this.banks?.battleSong("wild");
    if (label)
      this.play(label);
  }
  playVictory(kind = "wild") {
    const label = this.banks?.battleSong(`${kind}Win`);
    if (!label || !this.banks?.song(label))
      return false;
    this.play(label);
    return true;
  }
  playOnce(song) {
    if (!this.banks?.song(song)) {
      if (this.banks?.sfx(song)) {
        this.playSfx(song);
        return true;
      }
      return false;
    }
    this.play(song);
    return this.current === song;
  }
  restore() {
    this.current = null;
    if (this.mapSong)
      this.play(this.mapSong);
    else
      this.stopMusic();
  }
  fadeOut(control = 10) {
    if (!this.banks)
      return;
    this.current = null;
    this.host?.musicFade(Math.max(1, control));
  }
  stopMusic() {
    if (!this.banks)
      return;
    this.current = null;
    this.host?.musicStop();
  }
  playSfx(name, pitch = 0, tempo = AUDIO_SFX_TEMPO) {
    const ref = this.banks?.sfx(name);
    if (!ref || !this.host)
      return;
    this.host.sfx(ref.bank, ref.address, ref.engine, pitch, tempo, FANFARES[name] ? AUDIO_SFX_FLAG.duck : 0);
  }
  playCry(species) {
    const cry = this.banks?.cry(species);
    if (!cry || !this.host)
      return;
    this.host.cry(cry.bank, cry.address, cry.engine, cry.pitch, cry.length);
  }
  stop() {
    if (!this.banks)
      return;
    this.current = null;
    this.host?.musicStop();
  }
  play(label) {
    if (label === this.current || this.failed.has(label))
      return;
    const ref = this.banks?.song(label);
    if (!ref || !this.host) {
      this.failed.add(label);
      return;
    }
    this.host.music(ref.bank, ref.address, ref.engine, AUDIO_MUSIC_FLAG.loop);
    this.current = label;
  }
}

// voxelmon/game/rng.ts
function randRange(rng, min, max) {
  return min + rng.int(max - min + 1);
}
function seededRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state;
  };
  return {
    int(maxExclusive) {
      return (next() >>> 8) % maxExclusive;
    },
    byte() {
      return next() >>> 24;
    }
  };
}

// voxelmon/game/rules/stats.ts
var STAT_ORDER = ["hp", "attack", "defense", "speed", "special"];
function randomDVs(rng) {
  const attack = rng.int(16);
  const defense = rng.int(16);
  const speed = rng.int(16);
  const special = rng.int(16);
  const hp = attack % 2 * 8 + defense % 2 * 4 + speed % 2 * 2 + special % 2;
  return { hp, attack, defense, speed, special };
}
function calcOne(base, dv, statExp, level, isHP) {
  const ev = Math.floor(Math.min(255, Math.ceil(Math.sqrt(statExp ?? 0))) / 4);
  const v = Math.floor(((base + dv) * 2 + ev) * level / 100);
  return isHP ? v + level + 10 : v + 5;
}
function calc(speciesDef, level, dvs, statExp) {
  const exp = statExp ?? {};
  const out = {};
  for (const key of STAT_ORDER) {
    out[key] = calcOne(speciesDef.baseStats[key], dvs[key] ?? 0, exp[key], level, key === "hp");
  }
  return out;
}
var STAGE_MULT = {
  [-6]: [25, 100],
  [-5]: [28, 100],
  [-4]: [33, 100],
  [-3]: [40, 100],
  [-2]: [50, 100],
  [-1]: [66, 100],
  [0]: [100, 100],
  [1]: [150, 100],
  [2]: [200, 100],
  [3]: [250, 100],
  [4]: [300, 100],
  [5]: [350, 100],
  [6]: [400, 100]
};
function applyStage(value, stage) {
  const m = STAGE_MULT[Math.max(-6, Math.min(6, stage ?? 0))];
  const v = Math.floor(value * m[0] / m[1]);
  return Math.max(1, Math.min(999, v));
}
var SHINY_ATK = new Set([2, 3, 6, 7, 10, 11, 14, 15]);

// voxelmon/game/rules/status.ts
function fmt(template, ...args) {
  let i = 0;
  return template.replace(/%[sd]/g, () => String(args[i++]));
}
var VOLATILE_PRIORITY = 20;
function hasType(battler, wanted) {
  return (battler.curTypes ?? []).includes(wanted);
}
function damageOverTime(template) {
  return (battler) => {
    const mon = battler.mon;
    const base = Math.max(1, Math.floor(mon.stats.hp / 16));
    let dmg = base;
    if (battler.toxicCounter !== undefined) {
      dmg = base * battler.toxicCounter;
      battler.toxicCounter += 1;
    }
    mon.hp = Math.max(0, mon.hp - dmg);
    return [fmt(template, battler.name)];
  };
}
var RECORDS = {
  SLP: {
    id: "SLP",
    label: "SLP",
    hudLabel: "SLP",
    catchBonus: 25,
    shakeBonus: 10,
    beforeMovePriority: 40,
    beforeMove(battler) {
      battler.sleepTurns = (battler.sleepTurns ?? 1) - 1;
      if (battler.sleepTurns <= 0) {
        battler.mon.status = null;
        return [false, [fmt(`%s
woke up!`, battler.name)]];
      }
      return [false, [fmt(`%s
is fast asleep!`, battler.name)]];
    },
    onInflict(target, _opts, display, rng) {
      target.sleepTurns = 1 + rng.int(7);
      return [fmt(`%s
fell asleep!`, display)];
    }
  },
  FRZ: {
    id: "FRZ",
    label: "FRZ",
    hudLabel: "FRZ",
    catchBonus: 25,
    shakeBonus: 10,
    beforeMovePriority: 30,
    beforeMove(battler) {
      return [false, [fmt(`%s
is frozen solid!`, battler.name)]];
    },
    canInflict: (target) => !hasType(target, "ICE"),
    onInflict(_target, _opts, display) {
      return [fmt(`%s
was frozen solid!`, display)];
    }
  },
  PSN: {
    id: "PSN",
    label: "PSN",
    hudLabel: "PSN",
    catchBonus: 12,
    shakeBonus: 5,
    residual: damageOverTime(`%s's
hurt by poison!`),
    canInflict: (target) => !hasType(target, "POISON"),
    onInflict(target, opts, display) {
      if (opts.toxic) {
        target.toxicCounter = 1;
        return [fmt(`%s's
badly poisoned!`, display)];
      }
      return [fmt(`%s
was poisoned!`, display)];
    }
  },
  BRN: {
    id: "BRN",
    label: "BRN",
    hudLabel: "BRN",
    catchBonus: 12,
    shakeBonus: 5,
    statPenalty: { stat: "attack", div: 2 },
    residual: damageOverTime(`%s's
hurt by the burn!`),
    canInflict: (target) => !hasType(target, "FIRE"),
    onInflict(_target, _opts, display) {
      return [fmt(`%s
was burned!`, display)];
    }
  },
  PAR: {
    id: "PAR",
    label: "PAR",
    hudLabel: "PAR",
    catchBonus: 12,
    shakeBonus: 5,
    statPenalty: { stat: "speed", div: 4 },
    beforeMovePriority: 10,
    beforeMove(battler, rng) {
      if (rng.byte() < 63) {
        return [false, [fmt(`%s's
fully paralyzed!`, battler.name)]];
      }
      return [true, []];
    },
    canInflict: (target, opts) => !(opts.moveType === "ELECTRIC" && hasType(target, "GROUND")),
    onInflict(_target, _opts, display) {
      return [fmt(`%s's
paralyzed! It may
not attack!`, display)];
    }
  }
};
function recordFor(statuses, id) {
  if (id == null)
    return;
  return (statuses ?? RECORDS)[id];
}
function beforeMove(battler, rng) {
  const mon = battler.mon;
  if (battler.skipMove) {
    battler.skipMove = undefined;
    return { canMove: false, messages: [] };
  }
  if (battler.flinched) {
    battler.flinched = false;
    return { canMove: false, messages: [fmt(`%s
flinched!`, battler.name)] };
  }
  const record = recordFor(battler.statuses, mon.status);
  let handler = record?.beforeMove;
  const priority = handler ? record?.beforeMovePriority ?? 0 : 0;
  const msgs = [];
  const runStatus = () => {
    const [canMove, statusMsgs, selfHit] = handler(battler, rng);
    msgs.push(...statusMsgs);
    return [canMove, selfHit];
  };
  if (handler && priority > VOLATILE_PRIORITY) {
    const [canMove, selfHit] = runStatus();
    if (!canMove || selfHit)
      return { canMove, messages: msgs, selfHit };
    handler = undefined;
  }
  if (battler.boundTurns !== undefined && battler.boundTurns > 0) {
    battler.boundTurns -= 1;
    msgs.push(fmt(`%s
can't move!`, battler.name));
    return { canMove: false, messages: msgs };
  }
  if (battler.disabledTurns !== undefined) {
    battler.disabledTurns -= 1;
    if (battler.disabledTurns <= 0) {
      battler.disabledTurns = undefined;
      battler.disabledSlot = undefined;
      msgs.push(fmt(`%s's
disabled no more!`, battler.name));
    }
  }
  if (battler.confusedTurns !== undefined) {
    battler.confusedTurns -= 1;
    if (battler.confusedTurns <= 0) {
      battler.confusedTurns = undefined;
      msgs.push(fmt(`%s
snapped out of
confusion!`, battler.name));
    } else {
      msgs.push(fmt(`%s
is confused!`, battler.name));
      if (rng.byte() < 128) {
        return { canMove: false, messages: msgs, selfHit: true };
      }
    }
  }
  if (handler) {
    const [canMove, selfHit] = runStatus();
    if (!canMove || selfHit)
      return { canMove, messages: msgs, selfHit };
  }
  return { canMove: true, messages: msgs };
}
function residual(battler, opponent) {
  const msgs = [];
  const mon = battler.mon;
  battler.skipMove = undefined;
  if (mon.hp <= 0)
    return msgs;
  const record = recordFor(battler.statuses, mon.status);
  if (record?.residual) {
    msgs.push(...record.residual(battler));
  }
  if (battler.leechSeeded && mon.hp > 0 && opponent.mon.hp > 0) {
    let dmg = Math.max(1, Math.floor(mon.stats.hp / 16));
    if (battler.toxicCounter !== undefined) {
      dmg = dmg * battler.toxicCounter;
      battler.toxicCounter += 1;
    }
    dmg = Math.min(dmg, mon.hp);
    mon.hp -= dmg;
    opponent.mon.hp = Math.min(opponent.mon.stats.hp, opponent.mon.hp + dmg);
    msgs.push(fmt(`LEECH SEED saps
%s!`, battler.name));
  }
  return msgs;
}

// voxelmon/game/rules/damage.ts
var GEN1_FAITHFUL = {
  name: "gen1_faithful",
  oneIn256Miss: true,
  critUsesBaseSpeed: true,
  critIgnoresStages: true,
  randMin: 217,
  randMax: 255,
  focusEnergyBug: true,
  enemyUnlimitedPP: true,
  hyperBeamSkipRechargeOnKO: true,
  residualAfterMove: true
};
var HIGH_CRIT = new Set(["KARATE_CHOP", "RAZOR_LEAF", "CRABHAMMER", "SLASH"]);
var BADGE_BOOSTS = [
  { badge: "BOULDERBADGE", stat: "attack", num: 9, den: 8 },
  { badge: "THUNDERBADGE", stat: "defense", num: 9, den: 8 },
  { badge: "SOULBADGE", stat: "speed", num: 9, den: 8 },
  { badge: "VOLCANOBADGE", stat: "special", num: 9, den: 8 }
];
function badgeBoost(battler, stat) {
  const badges = battler.badges;
  if (!badges)
    return;
  for (const row of battler.badgeBoosts ?? BADGE_BOOSTS) {
    if (row.stat === stat && badges[row.badge])
      return row;
  }
  return;
}
function statusRecord(battler) {
  return recordFor(battler.statuses, battler.mon.status);
}
function critRoll(ruleset, attacker, moveId, rng, highCrit) {
  const shl = (x) => Math.min(255, x * 2);
  const speed = ruleset.critUsesBaseSpeed === false ? applyStage(attacker.curStats.speed, attacker.stages?.speed ?? 0) : attacker.def.baseStats.speed;
  let b = Math.floor(speed / 2);
  if (attacker.focusEnergy) {
    b = ruleset.focusEnergyBug ? Math.floor(b / 2) : shl(shl(shl(b)));
  } else {
    b = shl(b);
  }
  const high = highCrit ?? (moveId !== undefined && HIGH_CRIT.has(moveId));
  b = high ? shl(shl(b)) : Math.floor(b / 2);
  return rng.byte() < b;
}
function accuracyRoll(ruleset, move, attacker, defender, rng) {
  if (attacker.xAccuracy)
    return true;
  const accuracy = move.accuracy ?? 100;
  let acc = Math.floor(accuracy * 255 / 100);
  acc = Math.min(255, applyStage(acc, attacker.stages?.accuracy ?? 0));
  acc = Math.min(255, applyStage(acc, -(defender.stages?.evasion ?? 0)));
  if (!ruleset.oneIn256Miss && accuracy >= 100 && (attacker.stages?.accuracy ?? 0) >= (defender.stages?.evasion ?? 0)) {
    return true;
  }
  return rng.byte() < acc;
}
var warnedTypes = new Set;
function categoryOf(move, chart) {
  let category = move.category ?? chart.category(move.type);
  if (category === undefined) {
    if (move.type != null && !warnedTypes.has(move.type)) {
      warnedTypes.add(move.type);
      console.warn(`move type ${move.type} has no category; treated as physical`);
    }
    category = "physical";
  }
  return category;
}
function compute(ruleset, chart, attacker, defender, move, opts = {}) {
  const needRng = () => {
    if (!opts.rng)
      throw new Error("Damage.compute rolled with no opts.rng injected");
    return opts.rng;
  };
  if (move.power === 0 || move.category === "status") {
    return [0, { crit: false, typeMult: 10 }];
  }
  const crit = opts.forceCrit ?? critRoll(ruleset, attacker, move.id, needRng(), move.highCrit);
  const special = categoryOf(move, chart) === "special";
  const atkStat = special ? "special" : "attack";
  const defStat = special ? "special" : "defense";
  let atk;
  let dfn;
  if (crit && ruleset.critIgnoresStages) {
    atk = attacker.curStats[atkStat];
    dfn = defender.curStats[defStat];
  } else {
    atk = applyStage(attacker.curStats[atkStat], attacker.stages?.[atkStat] ?? 0);
    dfn = applyStage(defender.curStats[defStat], defender.stages?.[defStat] ?? 0);
    const atkBoost = badgeBoost(attacker, atkStat);
    if (atkBoost) {
      atk = Math.floor(atk * (atkBoost.num ?? 9) / (atkBoost.den ?? 8));
    }
    const defBoost = badgeBoost(defender, defStat);
    if (defBoost) {
      dfn = Math.floor(dfn * (defBoost.num ?? 9) / (defBoost.den ?? 8));
    }
    const penalty = statusRecord(attacker)?.statPenalty;
    if (penalty && penalty.stat === atkStat && !attacker.hazeStatReset) {
      atk = Math.max(1, Math.floor(atk / penalty.div));
    }
    if (!crit) {
      let screens = opts.screens;
      if (screens === undefined && !opts.typeless)
        screens = defender;
      if (screens) {
        if (special && screens.lightScreen)
          dfn = dfn * 2;
        if (!special && screens.reflect)
          dfn = dfn * 2;
      }
    }
  }
  if (atk > 255 || dfn > 255) {
    atk = Math.max(1, Math.floor(atk / 4));
    dfn = Math.max(1, Math.floor(dfn / 4));
  }
  if (opts.explode) {
    dfn = Math.max(1, Math.floor(dfn / 2));
  }
  let level = attacker.mon.level;
  if (crit)
    level = level * 2;
  let d = Math.floor(Math.floor(2 * level / 5) + 2);
  d = Math.floor(Math.floor(d * move.power * atk / Math.max(1, dfn)) / 50);
  d = Math.min(d, 997) + 2;
  let mult = 10;
  if (!opts.typeless) {
    const stab = attacker.curTypes.includes(move.type);
    if (stab) {
      d = Math.floor(d * 3 / 2);
    }
    mult = chart.effectiveness(move.type, defender.curTypes);
    if (mult === 0) {
      return [0, { crit: false, typeMult: 0 }];
    }
    for (const m of chart.rows(move.type, defender.curTypes)) {
      d = Math.floor(d * m / 10);
    }
    if (d === 0) {
      return [0, { crit: false, typeMult: mult, missed: true }];
    }
  }
  if (d > 1 && !opts.typeless) {
    const r = randRange(needRng(), ruleset.randMin, ruleset.randMax);
    d = Math.floor(d * r / 255);
  }
  return [Math.max(d, 1), { crit, typeMult: mult }];
}

// voxelmon/game/rules/catching.ts
var BALLS = {
  MASTER_BALL: { randMax: 0, autoCatch: true, tossAnim: "ULTRATOSS_ANIM", flicker: true },
  POKE_BALL: { randMax: 255, hpFactor: 12, wobbleFactor: 255, tossAnim: "TOSS_ANIM" },
  GREAT_BALL: { randMax: 200, hpFactor: 8, wobbleFactor: 200, tossAnim: "GREATTOSS_ANIM" },
  ULTRA_BALL: {
    randMax: 150,
    hpFactor: 12,
    wobbleFactor: 150,
    tossAnim: "ULTRATOSS_ANIM",
    flicker: true
  },
  SAFARI_BALL: { randMax: 150, hpFactor: 12, wobbleFactor: 150, tossAnim: "ULTRATOSS_ANIM" }
};
var DEFAULT_BALL = { randMax: 255, hpFactor: 12, wobbleFactor: 150 };
function stockAttempt(def, targetMon, targetDef, rng, rateOverride, statuses) {
  if (def.autoCatch)
    return [true, 3];
  const randMax = def.randMax;
  const rate = rateOverride ?? targetDef.catchRate;
  const s = targetMon.status;
  const record = recordFor(statuses, s);
  const statusBonus = record?.catchBonus ?? 0;
  const maxhp = targetMon.stats.hp;
  const hpQuarter = Math.max(1, Math.floor(targetMon.hp / 4));
  const factor = def.hpFactor ?? DEFAULT_BALL.hpFactor;
  const f = Math.min(255, Math.floor(Math.floor(maxhp * 255 / factor) / hpQuarter));
  const shakes = () => {
    const ballFactor2 = def.wobbleFactor ?? DEFAULT_BALL.wobbleFactor;
    const y = Math.floor(rate * 100 / ballFactor2);
    let z;
    if (y > 255) {
      z = 255;
    } else {
      z = Math.floor(f * y / 255);
    }
    if (s != null) {
      z = z + (record?.shakeBonus ?? 5);
    }
    if (z < 10)
      return 0;
    if (z < 30)
      return 1;
    if (z < 70)
      return 2;
    return 3;
  };
  const r = rng.int(randMax + 1) - statusBonus;
  if (r < 0)
    return [true, 3];
  if (r > rate)
    return [false, shakes()];
  if (rng.byte() <= f)
    return [true, 3];
  return [false, shakes()];
}
function attempt(ball, targetMon, targetDef, rng, rateOverride, opts = {}) {
  const def = opts.ballDef ?? BALLS[ball] ?? DEFAULT_BALL;
  const statuses = opts.statuses;
  if (def.attempt) {
    const ctx = {
      ballDef: def,
      targetMon,
      targetDef,
      rng,
      rateOverride,
      battle: opts.battle,
      vanillaAttempt() {
        return stockAttempt(def, targetMon, targetDef, rng, ctx.rateOverride, statuses);
      }
    };
    return def.attempt(ctx);
  }
  return stockAttempt(def, targetMon, targetDef, rng, rateOverride, statuses);
}

// voxelmon/game/rules/growth.ts
var CURVES = {
  MEDIUM_FAST: (n) => n * n * n,
  SLIGHTLY_FAST: (n) => Math.floor(3 * n * n * n / 4) + 10 * n * n - 30,
  SLIGHTLY_SLOW: (n) => Math.floor(3 * n * n * n / 4) + 20 * n * n - 70,
  MEDIUM_SLOW: (n) => Math.floor(6 * n * n * n / 5) - 15 * n * n + 100 * n - 140,
  FAST: (n) => Math.floor(4 * n * n * n / 5),
  SLOW: (n) => Math.floor(5 * n * n * n / 4)
};
var warned = new Set;
function expForLevel(growthRate, level, rates) {
  const record = rates?.[growthRate];
  if (record?.expForLevel) {
    return Math.max(0, record.expForLevel(level));
  }
  let curve = CURVES[growthRate];
  if (!curve) {
    if (growthRate != null && !warned.has(growthRate)) {
      warned.add(growthRate);
      console.warn(`unknown growth rate ${growthRate}; using MEDIUM_FAST`);
    }
    curve = CURVES.MEDIUM_FAST;
  }
  return Math.max(0, curve(level));
}
function levelForExp(growthRate, exp, cap, rates) {
  const top = cap ?? 100;
  let level = 1;
  while (level < top && expForLevel(growthRate, level + 1, rates) <= exp) {
    level += 1;
  }
  return level;
}

// voxelmon/game/rules/experience.ts
function gainFor(defeatedDef, level, isTrainer, numParticipants, traded, consts) {
  let divisor = 7;
  let tradedMult;
  let trainerMult;
  const tuning = consts?.exp;
  if (tuning) {
    divisor = tuning.divisor ?? divisor;
    tradedMult = tuning.tradedMult;
    trainerMult = tuning.trainerMult;
  }
  const base = Math.floor(defeatedDef.baseExp / Math.max(1, numParticipants ?? 1));
  let exp = Math.floor(base * level / divisor);
  if (traded) {
    exp = Math.floor(exp * (tradedMult ?? 1.5));
  }
  if (isTrainer) {
    exp = Math.floor(exp * (trainerMult ?? 1.5));
  }
  return Math.max(1, exp);
}
function apply(data, mon, defeatedDef, level, isTrainer, numParticipants, traded) {
  const speciesDef = data.pokemon[mon.species];
  const statShare = Math.max(1, numParticipants ?? 1);
  for (const key of STAT_ORDER) {
    const gain = Math.floor(defeatedDef.baseStats[key] / statShare);
    mon.statExp[key] = Math.min(65535, (mon.statExp[key] ?? 0) + gain);
  }
  const consts = data.constants;
  const gained = gainFor(defeatedDef, level, isTrainer, numParticipants, traded, consts);
  mon.exp = mon.exp + gained;
  const cap = consts?.levelCap ?? 100;
  const levels = [];
  const newLevel = levelForExp(speciesDef.growthRate, mon.exp, cap, data.growth_rates);
  while (mon.level < Math.min(newLevel, cap)) {
    mon.level += 1;
    const old = mon.stats;
    mon.stats = calc(speciesDef, mon.level, mon.dvs, mon.statExp);
    mon.hp = Math.min(mon.stats.hp, mon.hp + (mon.stats.hp - old.hp));
    levels.push(mon.level);
  }
  return [levels, gained];
}
function movesLearnedAt(speciesDef, level) {
  const out = [];
  for (const entry of speciesDef.learnset) {
    if (entry.level === level) {
      out.push(entry.move);
    }
  }
  return out;
}

// voxelmon/game/rules/turnorder.ts
function effectiveSpeed(battler) {
  let spd = applyStage(battler.curStats.speed, battler.stages?.speed ?? 0);
  const badges = battler.badges;
  if (badges) {
    for (const row of battler.badgeBoosts ?? BADGE_BOOSTS) {
      if (row.stat === "speed" && badges[row.badge]) {
        spd = Math.floor(spd * (row.num ?? 9) / (row.den ?? 8));
        break;
      }
    }
  }
  const penalty = recordFor(battler.statuses, battler.mon.status)?.statPenalty;
  if (penalty && penalty.stat === "speed" && !battler.hazeStatReset) {
    spd = Math.max(1, Math.floor(spd / penalty.div));
  }
  return spd;
}
var PRIORITY = { QUICK_ATTACK: 1, COUNTER: -1 };
function priority(move) {
  if (!move)
    return 0;
  const record = move;
  if (record.priority !== undefined)
    return record.priority;
  return PRIORITY[move.id] ?? 0;
}
function firstMover(a, aMove, b, bMove, rng, invertTie) {
  const pa = priority(aMove);
  const pb = priority(bMove);
  if (pa !== pb)
    return pa > pb;
  const sa = effectiveSpeed(a);
  const sb = effectiveSpeed(b);
  if (sa !== sb)
    return sa > sb;
  let aFirst = rng.int(2) === 0;
  if (invertTie)
    aFirst = !aFirst;
  return aFirst;
}

// voxelmon/game/rules/typechart.ts
var TYPES = {
  NORMAL: { name: "NORMAL", category: "physical" },
  FIGHTING: { name: "FIGHTING", category: "physical" },
  FLYING: { name: "FLYING", category: "physical" },
  POISON: { name: "POISON", category: "physical" },
  GROUND: { name: "GROUND", category: "physical" },
  ROCK: { name: "ROCK", category: "physical" },
  BUG: { name: "BUG", category: "physical" },
  GHOST: { name: "GHOST", category: "physical" },
  FIRE: { name: "FIRE", category: "special" },
  WATER: { name: "WATER", category: "special" },
  GRASS: { name: "GRASS", category: "special" },
  ELECTRIC: { name: "ELECTRIC", category: "special" },
  PSYCHIC_TYPE: { name: "PSYCHIC", category: "special" },
  ICE: { name: "ICE", category: "special" },
  DRAGON: { name: "DRAGON", category: "special" }
};
function createTypeChart(data) {
  const matchups = data?.matchups ?? [];
  const index = new Map;
  for (const m of matchups) {
    let row = index.get(m.attacker);
    if (!row) {
      row = new Map;
      index.set(m.attacker, row);
    }
    row.set(m.defender, m.multiplier);
  }
  const types = data?.types;
  const record = (typeId) => typeId === undefined ? undefined : types?.[typeId] ?? TYPES[typeId];
  return {
    category(typeId) {
      return record(typeId)?.category;
    },
    displayName(typeId) {
      return record(typeId)?.name ?? typeId;
    },
    rows(moveType, defenderTypes) {
      const out = [];
      for (const m of matchups) {
        if (m.attacker !== moveType)
          continue;
        for (const dt of defenderTypes) {
          if (m.defender === dt) {
            out.push(m.multiplier);
            break;
          }
        }
      }
      return out;
    },
    effectiveness(moveType, defenderTypes) {
      let mult = 10;
      const row = index.get(moveType);
      if (!row)
        return mult;
      for (const dt of defenderTypes) {
        const m = row.get(dt);
        if (m !== undefined) {
          mult = Math.floor(mult * m / 10);
        }
      }
      return mult;
    }
  };
}

// voxelmon/game/rules/timing.ts
var DELAY3 = 3;
var FADE_OUT_TO_BLACK = 32;
var FADE_OUT_TO_WHITE = 24;
var FADE_IN_FROM_WHITE = 24;
var WARP_FADE_OUT = FADE_OUT_TO_BLACK;
var POST_BATTLE_RETURN = 10;
var MAP_ENTRY_AFTER_BATTLE = FADE_IN_FROM_WHITE;
var SPECIAL_WARP_ENTRY = DELAY3 + FADE_IN_FROM_WHITE;
var TEXT_SCROLL_LINE = 5;
var TEXT_SCROLL_PAIR = TEXT_SCROLL_LINE * 2;
var TEXT_PRE_ADVANCE = DELAY3;
var TEXT_PAGE_CLEAR = 20;
var TEXT_CONT = TEXT_PRE_ADVANCE + TEXT_SCROLL_PAIR;
var TEXT_PARAGRAPH = TEXT_PRE_ADVANCE + TEXT_PAGE_CLEAR;
var YES_NO_ANSWER = 15;
var FIELD_TELEPORT = 60 + DELAY3;
var BATTLE_SLIDE_IN_FRAMES = 72;
var TRAINER_INTRO_SFX_GAP = 20;
var BATTLE_START_SENDOUT = 40;
var MOVE_ANIM_PRE = DELAY3;
var MOVE_STATUS_OR_MISS = 30;
var FAINT_SLIDE = 14;
var CRIT_OHKO_TEXT = 20;
var FAINT_SLIDE_ROW = 2;
var FAINT_SLIDE_STEP = 8 / FAINT_SLIDE_ROW;
var HP_BAR_PIXELS = 48;
var HP_BAR_PIXEL_STEP = 2;
var HP_BAR_HP_STEP = 1;
function hpBarPixels(hp, maxHP) {
  if (!maxHP || maxHP <= 0)
    return 0;
  if (hp <= 0)
    return 0;
  let px = Math.floor(hp * HP_BAR_PIXELS / maxHP);
  if (px < 1)
    px = 1;
  return px;
}
function hpDrainStepFrames(fromHP, toHP, maxHP, playerSide) {
  const pixels = Math.abs(hpBarPixels(toHP, maxHP) - hpBarPixels(fromHP, maxHP));
  let frames = pixels * HP_BAR_PIXEL_STEP;
  if (playerSide)
    frames += HP_BAR_HP_STEP;
  return frames;
}
function hpDrainClosingFrames(playerSide) {
  let frames = HP_BAR_PIXEL_STEP + DELAY3;
  if (playerSide)
    frames += HP_BAR_HP_STEP;
  return frames;
}

// voxelmon/game/ui/tiles.ts
var BORDER_TL = 121;
var BORDER_H = 122;
var BORDER_TR = 123;
var BORDER_V = 124;
var BORDER_BL = 125;
var BORDER_BR = 126;
var SPACE = 127;
var ARROW_MORE = 238;
var ARROW_CURSOR = 237;
var ARROW_HOLLOW = 236;
var BOX_TX = 0;
var BOX_TY = 12;
var BOX_TW = 20;
var BOX_TH = 6;
var MAX_COLS = 18;
var TEXT_X = BOX_TX + 1;
var LINE1_Y = BOX_TY + 2;
var LINE2_Y = BOX_TY + 4;
var ARROW_X = 18;
var ARROW_Y = 16;
var CHARMAP_PAIRS = [
  ["<BOLD_A>", 96],
  ["<BOLD_B>", 97],
  ["<BOLD_C>", 98],
  ["<BOLD_D>", 99],
  ["<BOLD_E>", 100],
  ["<BOLD_F>", 101],
  ["<BOLD_G>", 102],
  ["<BOLD_H>", 103],
  ["<BOLD_I>", 104],
  ["<BOLD_L>", 107],
  ["<BOLD_M>", 108],
  ["<BOLD_P>", 114],
  ["<BOLD_S>", 106],
  ["<BOLD_V>", 105],
  ["<COLON>", 109],
  ["<DOT>", 242],
  ["<ED>", 240],
  ["<ID>", 115],
  ["<LV>", 110],
  ["<MN>", 226],
  ["<PK>", 225],
  ["<to>", 112],
  ["'d", 187],
  ["'l", 188],
  ["'m", 229],
  ["'r", 228],
  ["'s", 189],
  ["'t", 190],
  ["'v", 191],
  [" ", 127],
  ["!", 231],
  ['"', 115],
  ["'", 224],
  ["(", 154],
  [")", 155],
  [",", 244],
  ["-", 227],
  [".", 232],
  ["/", 243],
  ["0", 246],
  ["1", 247],
  ["2", 248],
  ["3", 249],
  ["4", 250],
  ["5", 251],
  ["6", 252],
  ["7", 253],
  ["8", 254],
  ["9", 255],
  [":", 156],
  [";", 157],
  ["?", 230],
  ["A", 128],
  ["B", 129],
  ["C", 130],
  ["D", 131],
  ["E", 132],
  ["F", 133],
  ["G", 134],
  ["H", 135],
  ["I", 136],
  ["J", 137],
  ["K", 138],
  ["L", 139],
  ["M", 140],
  ["N", 141],
  ["O", 142],
  ["P", 143],
  ["Q", 144],
  ["R", 145],
  ["S", 146],
  ["T", 147],
  ["U", 148],
  ["V", 149],
  ["W", 150],
  ["X", 151],
  ["Y", 152],
  ["Z", 153],
  ["[", 158],
  ["]", 159],
  ["a", 160],
  ["b", 161],
  ["c", 162],
  ["d", 163],
  ["e", 164],
  ["f", 165],
  ["g", 166],
  ["h", 167],
  ["i", 168],
  ["j", 169],
  ["k", 170],
  ["l", 171],
  ["m", 172],
  ["n", 173],
  ["o", 174],
  ["p", 175],
  ["q", 176],
  ["r", 177],
  ["s", 178],
  ["t", 179],
  ["u", 180],
  ["v", 181],
  ["w", 182],
  ["x", 183],
  ["y", 184],
  ["z", 185],
  ["¥", 240],
  ["·", 116],
  ["×", 241],
  ["é", 186],
  ["‘", 112],
  ["’", 113],
  ["“", 114],
  ["”", 115],
  ["…", 117],
  ["′", 96],
  ["″", 97],
  ["№", 116],
  ["⋯", 117],
  ["─", 122],
  ["│", 124],
  ["┌", 121],
  ["┐", 123],
  ["└", 125],
  ["┘", 126],
  ["▲", 237],
  ["▶", 237],
  ["▷", 236],
  ["▼", 238],
  ["♀", 245],
  ["♂", 239]
];
var SINGLE = new Map;
var MULTI = [];
for (const [seq, code] of CHARMAP_PAIRS) {
  if ([...seq].length === 1)
    SINGLE.set(seq, code);
  else
    MULTI.push([seq, code]);
}
MULTI.sort((a, b) => b[0].length - a[0].length);
var MULTI_BY_HEAD = new Map;
for (const entry of MULTI) {
  const head = entry[0][0];
  const bucket = MULTI_BY_HEAD.get(head);
  if (bucket)
    bucket.push(entry);
  else
    MULTI_BY_HEAD.set(head, [entry]);
}
var GLYPH_CACHE = new Map;
var GLYPH_CACHE_MAX = 64;
function encodeGlyphs(text) {
  const hit = GLYPH_CACHE.get(text);
  if (hit)
    return hit;
  const out = [];
  let i = 0;
  outer:
    while (i < text.length) {
      const bucket = MULTI_BY_HEAD.get(text[i]);
      if (bucket) {
        for (const [seq, code] of bucket) {
          if (text.startsWith(seq, i)) {
            out.push(code);
            i += seq.length;
            continue outer;
          }
        }
      }
      const cp = String.fromCodePoint(text.codePointAt(i));
      out.push(SINGLE.get(cp) ?? SPACE);
      i += cp.length;
    }
  if (GLYPH_CACHE.size >= GLYPH_CACHE_MAX)
    GLYPH_CACHE.clear();
  GLYPH_CACHE.set(text, out);
  return out;
}
function glyphLen(text) {
  return encodeGlyphs(text).length;
}
var LIGATURE_BASE = 57344;
function toCells(text) {
  let out = "";
  let i = 0;
  outer:
    while (i < text.length) {
      const bucket = MULTI_BY_HEAD.get(text[i]);
      if (bucket) {
        for (const [seq, code] of bucket) {
          if (text.startsWith(seq, i)) {
            out += String.fromCharCode(LIGATURE_BASE + code);
            i += seq.length;
            continue outer;
          }
        }
      }
      const cp = String.fromCodePoint(text.codePointAt(i));
      out += SINGLE.has(cp) ? cp : " ";
      i += cp.length;
    }
  return out;
}
function sliceGlyphs(text, n) {
  let i = 0;
  let count = 0;
  outer:
    while (i < text.length && count < n) {
      const bucket = MULTI_BY_HEAD.get(text[i]);
      if (bucket) {
        for (const [seq] of bucket) {
          if (text.startsWith(seq, i)) {
            i += seq.length;
            count += 1;
            continue outer;
          }
        }
      }
      const cp = String.fromCodePoint(text.codePointAt(i));
      i += cp.length;
      count += 1;
    }
  return text.slice(0, i);
}

// voxelmon/game/battle/anim.ts
var SIDE_PLAYER = 0;
var SIDE_ENEMY = 1;
function animFrames(kind) {
  if (kind === "faint")
    return FAINT_SLIDE;
  return 16;
}
var LUNGE_PX = 7;
var KNOCKBACK_PX = 5;
var NO_FX = { dx: 0, dy: 0, dz: 0, hidden: false };
var px = (v) => Math.round(v * Q4);
function cardFx(anims, side, towardX, towardZ) {
  const anim = anims.find((a) => a.side === side);
  if (!anim)
    return NO_FX;
  const span = Math.max(1, anim.total - 1);
  const t = Math.min(1, anim.frame / span);
  if (anim.kind === "faint") {
    return { dx: 0, dy: px(-FAINT_SLIDE_STEP * anim.frame), dz: 0, hidden: false };
  }
  if (anim.kind === "lunge") {
    const reach = Math.sin(Math.PI * t) * LUNGE_PX;
    return { dx: px(towardX * reach), dy: 0, dz: px(towardZ * reach), hidden: false };
  }
  const recoil = (1 - t) * KNOCKBACK_PX;
  return {
    dx: px(-towardX * recoil),
    dy: 0,
    dz: px(-towardZ * recoil),
    hidden: anim.frame < anim.total / 2 && (anim.frame & 2) !== 0
  };
}
function towardCell(from, to) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const len = Math.hypot(dx, dz);
  if (len < 0.000001)
    return [0, 0];
  return [dx / len, dz / len];
}

// voxelmon/game/battle/moveanim.ts
var SE_PAUSE_FRAMES = 8;
var SE_FRAMES = {
  SE_DARK_SCREEN_FLASH: 4,
  SE_FLASH_SCREEN_LONG: 48,
  SE_DARK_SCREEN_PALETTE: 0,
  SE_LIGHT_SCREEN_PALETTE: 0,
  SE_DARKEN_MON_PALETTE: 0,
  SE_RESET_SCREEN_PALETTE: 0,
  SE_SHAKE_SCREEN: 72,
  SE_SHAKE_ENEMY_HUD: 44,
  SE_DELAY_ANIMATION_10: 10,
  SE_SLIDE_MON_OFF: 24,
  SE_SLIDE_ENEMY_MON_OFF: 24,
  SE_SLIDE_MON_HALF_OFF: 19,
  SE_SLIDE_MON_UP: 14,
  SE_SLIDE_MON_DOWN: 21,
  SE_SLIDE_MON_DOWN_AND_HIDE: 19,
  SE_MOVE_MON_HORIZONTALLY: 3,
  SE_RESET_MON_POSITION: 3,
  SE_SHAKE_BACK_AND_FORTH: 96,
  SE_BOUNCE_UP_AND_DOWN: 108,
  SE_SQUISH_MON_PIC: 26,
  SE_MINIMIZE_MON: 6,
  SE_SHOW_MON_PIC: 3,
  SE_SHOW_ENEMY_MON_PIC: 3,
  SE_HIDE_MON_PIC: 3,
  SE_HIDE_ENEMY_MON_PIC: 3,
  SE_BLINK_MON: 60,
  SE_BLINK_ENEMY_MON: 60,
  SE_FLASH_MON_PIC: 4,
  SE_FLASH_ENEMY_MON_PIC: 4,
  SE_TRANSFORM_MON: 4,
  SE_SUBSTITUTE_MON: 3,
  SE_WAVY_SCREEN: 255
};
var ANIM_ID_FX = {
  MEGA_PUNCH: "flash",
  GUILLOTINE: "flash",
  MEGA_KICK: "flash",
  HEADBUTT: "flash",
  DISABLE: "flash",
  BUBBLEBEAM: "flash",
  REFLECT: "flash",
  SPORE: "flash",
  BLIZZARD: "blizzard",
  HYPER_BEAM: "every4",
  THUNDERBOLT: "every8",
  SELFDESTRUCT: "explode",
  EXPLOSION: "explode",
  ROCK_SLIDE: "rockslide"
};
var BALL_TILE = 122 - 49;
var DROPLET_TILE = 113 - 49;
var LEAF_TILE = 55 - 49;
var PETAL_TILE = 113 - 49;
var wrap = (v) => (v % 256 + 256) % 256;
function resolveTransform(subType, attackerIsPlayer) {
  if (subType === "ENEMY")
    return attackerIsPlayer ? "HFLIP" : "NORMAL";
  return attackerIsPlayer ? "NORMAL" : subType;
}
var SPIRAL_COORDS = [
  [56, 40],
  [64, 24],
  [80, 16],
  [96, 24],
  [104, 40],
  [96, 56],
  [80, 64],
  [64, 56],
  [64, 40],
  [70, 30],
  [80, 24],
  [91, 30],
  [96, 40],
  [91, 50],
  [80, 56],
  [70, 50],
  [72, 40],
  [80, 32],
  [88, 40],
  [80, 48],
  [80, 40]
];
function spiralBallSteps(attackerIsPlayer) {
  const by = attackerIsPlayer ? 0 : -40;
  const bx = attackerIsPlayer ? 0 : 80;
  const steps = [];
  for (let k = 0;k < SPIRAL_COORDS.length - 2; k++) {
    const sprites = [];
    for (let i = 0;i < 3; i++) {
      const c = SPIRAL_COORDS[k + i];
      sprites.push({
        x: wrap(bx + c[1]),
        y: wrap(by + c[0]),
        tile: BALL_TILE,
        ts: 0,
        xf: false,
        yf: false,
        obp: "e4"
      });
    }
    steps.push({ dur: 5, sprites });
  }
  return steps;
}
function shootPillarSteps(steps, n, x, baseY) {
  const ys = [];
  for (let i = 1;i <= n; i++)
    ys.push(baseY + 8 * i);
  const snapshot = () => ys.filter((y) => y !== null).map((y) => ({ x, y: wrap(y), tile: BALL_TILE, ts: 0, xf: false, yf: false, obp: "e4" }));
  steps.push({ dur: 1, sprites: snapshot() });
  let alive = n;
  while (alive > 0) {
    for (let i = 0;i < n; i++) {
      const y = ys[i];
      if (y === null)
        continue;
      if (y === baseY + 8) {
        ys[i] = null;
        alive -= 1;
      } else {
        ys[i] = y - 4;
      }
    }
    steps.push({ dur: 1, sprites: snapshot() });
  }
}
function shootBallsSteps(attackerIsPlayer) {
  const steps = [];
  if (attackerIsPlayer)
    shootPillarSteps(steps, 5, 5 * 8, 6 * 8);
  else
    shootPillarSteps(steps, 5, 16 * 8, 0);
  return steps;
}
function shootManyBallsSteps(attackerIsPlayer) {
  const xs = attackerIsPlayer ? [16, 64, 40, 24, 56, 48] : [96, 144, 120, 104, 136, 128];
  const baseY = attackerIsPlayer ? 80 : 40;
  const steps = [];
  for (const x of xs)
    shootPillarSteps(steps, 4, x, baseY);
  return steps;
}
function waterDropletSteps() {
  const steps = [];
  let baseX = 240;
  for (let pass = 0;pass < 32; pass++) {
    for (const startY of [16, 24]) {
      const sprites = [];
      let y = startY;
      for (;; ) {
        baseX = wrap(baseX + 27);
        sprites.push({ x: baseX, y, tile: DROPLET_TILE, ts: 0, xf: false, yf: false, obp: "e4" });
        if (baseX >= 144) {
          baseX = wrap(baseX - 168);
          y += 16;
          if (y >= 112)
            break;
        }
      }
      steps.push({ dur: 1, sprites });
    }
  }
  return steps;
}
var FALLING_X = [
  56,
  64,
  80,
  96,
  112,
  136,
  144,
  86,
  103,
  74,
  119,
  132,
  152,
  50,
  34,
  92,
  108,
  125,
  142,
  153
];
var FALLING_M = [
  0,
  132,
  6,
  129,
  2,
  136,
  1,
  131,
  5,
  137,
  9,
  128,
  7,
  135,
  3,
  130,
  4,
  133,
  8,
  134
];
var FALLING_DX = [0, 1, 3, 5, 7, 9, 11, 13, 15];
function fallingObjectSteps(n, tile, obp) {
  const objs = [];
  for (let i = 0;i < n; i++) {
    objs.push({ y: i === 0 ? 0 : 8 * (i + 1), x: FALLING_X[i], m: FALLING_M[i], xf: false });
  }
  const steps = [];
  while (objs[0].y !== 104) {
    const sprites = [];
    for (const o of objs) {
      let left = o.m >= 128;
      let idx = o.m % 128 + 1;
      if (idx === 9) {
        left = !left;
        idx = 0;
      }
      o.m = (left ? 128 : 0) + idx;
      o.y += 2;
      if (o.y >= 112)
        o.y = 160;
      const dx = FALLING_DX[idx];
      o.x = left ? wrap(o.x - dx) : wrap(o.x + dx);
      o.xf = left;
      sprites.push({ x: o.x, y: o.y, tile, ts: 1, xf: o.xf, yf: false, obp });
    }
    steps.push({ dur: 3, sprites });
    if (steps.length > 120)
      break;
  }
  return steps;
}
var EMITTERS = {
  SE_SPIRAL_BALLS_INWARD: (p) => [spiralBallSteps(p), "flash"],
  SE_SHOOT_BALLS_UPWARD: (p) => [shootBallsSteps(p)],
  SE_SHOOT_MANY_BALLS_UPWARD: (p) => [shootManyBallsSteps(p)],
  SE_WATER_DROPLETS_EVERYWHERE: () => [waterDropletSteps()],
  SE_LEAVES_FALLING: () => [fallingObjectSteps(3, LEAF_TILE, "f0")],
  SE_PETALS_FALLING: () => [fallingObjectSteps(20, PETAL_TILE, "e4")]
};
var OAM_PAL1 = 16;
var OAM_XFLIP = 32;
var OAM_YFLIP = 64;
var OAM_PRIO = 128;
function placeTile(transform, bc, t, tileset) {
  const [bcy, bcx] = bc;
  const xflip = (t.attrs & OAM_XFLIP) !== 0;
  const yflip = (t.attrs & OAM_YFLIP) !== 0;
  const prio = (t.attrs & OAM_PRIO) !== 0;
  const pal1 = (t.attrs & OAM_PAL1) !== 0;
  let x;
  let y;
  let xf;
  let yf;
  if (transform === "HVFLIP") {
    y = wrap(136 - wrap(bcy + t.y));
    x = wrap(168 - wrap(bcx + t.x));
    const plain = !prio && !pal1;
    if (plain && !xflip && !yflip) {
      xf = true;
      yf = true;
    } else if (plain && xflip && !yflip) {
      xf = false;
      yf = true;
    } else if (plain && yflip && !xflip) {
      xf = true;
      yf = false;
    } else {
      xf = false;
      yf = false;
    }
  } else if (transform === "HFLIP") {
    y = wrap(wrap(bcy + t.y) + 40);
    x = wrap(168 - wrap(bcx + t.x));
    xf = !xflip;
    yf = yflip;
  } else if (transform === "COORDFLIP") {
    y = wrap(wrap(136 - bcy) + t.y);
    x = wrap(wrap(168 - bcx) + t.x);
    xf = xflip;
    yf = yflip;
  } else {
    y = wrap(bcy + t.y);
    x = wrap(bcx + t.x);
    xf = xflip;
    yf = yflip;
  }
  return { x, y, tile: t.tile, ts: tileset, xf, yf, obp: pal1 ? "obp1" : "f0" };
}

class MoveAnim {
  steps = [];
  events = [];
  frames = 0;
  missing = [];
  constructor(data, moveId, attackerIsPlayer, opts = {}) {
    const rows = data?.anims?.[moveId];
    if (!data || !rows) {
      this.missing.push(`anim:${moveId}`);
      return;
    }
    const steps = this.steps;
    const events = this.events;
    let oam = [];
    let oamMax = 0;
    let frame = 0;
    const emit = (dur, override) => {
      const d = dur < 1 ? 1 : dur;
      const sprites = override ?? oam.slice(0, oamMax).filter((s) => s !== null && s !== undefined);
      steps.push({ dur: d, sprites });
      frame += d;
    };
    const flashScreen = () => {
      events.push({ effect: "SE_DARK_SCREEN_FLASH", frame });
      emit(4);
    };
    const idFx = ANIM_ID_FX[moveId];
    const wantsFlicker = opts.ballFlicker ?? (opts.ball === "MASTER_BALL" || opts.ball === "ULTRA_BALL");
    const ballFlicker = wantsFlicker && (moveId === "TOSS_ANIM" || moveId === "GREATTOSS_ANIM" || moveId === "ULTRATOSS_ANIM");
    let obp0Flip = false;
    let growlNoteTrail = null;
    for (const row of rows) {
      if (row.sound !== null && row.sound !== undefined) {
        events.push({ sound: row.sound, frame });
      }
      if ("effect" in row) {
        const emitter = EMITTERS[row.effect];
        if (emitter) {
          oam = [];
          oamMax = 0;
          const [emSteps, tailFx] = emitter(attackerIsPlayer);
          events.push({ effect: row.effect, frame });
          for (const st of emSteps)
            emit(st.dur, st.sprites);
          emit(1, []);
          if (tailFx === "flash")
            flashScreen();
        } else {
          const known = SE_FRAMES[row.effect];
          const dur = known ?? SE_PAUSE_FRAMES;
          events.push({ effect: row.effect, frame, dur });
          if (dur > 0)
            emit(dur);
        }
        continue;
      }
      const sub = data.subanims[row.sub];
      if (!sub) {
        this.missing.push(`subanim:${row.sub}`);
        continue;
      }
      const transform = resolveTransform(sub.type, attackerIsPlayer);
      const reverse = transform === "REVERSE";
      const order = reverse ? [...sub.blocks].reverse() : sub.blocks;
      const passes = opts.shakes ?? 1;
      for (let pass = 0;pass < passes; pass++) {
        if (opts.shakes !== undefined) {
          events.push({ effect: "SFX_TINK", frame });
          emit(40);
        }
        let dest = 0;
        let played = 0;
        for (const entry of order) {
          const fb = data.frameBlocks[entry.block];
          const bc = data.baseCoords[entry.base];
          if (!fb || !bc) {
            this.missing.push(`block:${entry.block}:${entry.base}`);
            continue;
          }
          for (let j = 0;j < fb.length; j++) {
            oam[dest + j] = placeTile(transform, bc, fb[j], row.tileset);
          }
          if (obp0Flip) {
            for (let j = 0;j < fb.length; j++) {
              const t = oam[dest + j];
              if (t && t.obp === "f0")
                t.obp = "f0x";
            }
          }
          if (dest + fb.length > oamMax)
            oamMax = dest + fb.length;
          const mode = entry.mode;
          if (mode === 2) {
            dest += fb.length;
          } else if (mode === 3) {
            emit(row.delay);
            dest += fb.length;
          } else if (mode === 4) {
            emit(row.delay);
          } else {
            if (moveId === "GROWL") {
              const current = oam.slice(0, oamMax).filter((s) => s !== null && s !== undefined);
              const shown = growlNoteTrail ? [...current, ...growlNoteTrail] : current;
              emit(row.delay, shown);
              growlNoteTrail = current;
            } else {
              emit(row.delay + 1);
              oam = [];
              oamMax = 0;
            }
            dest = 0;
          }
          played += 1;
          if (ballFlicker)
            obp0Flip = !obp0Flip;
          if (idFx) {
            const counter = order.length - played + 1;
            if (idFx === "flash" || idFx === "every4" && counter % 4 === 0 || idFx === "every8" && counter % 8 === 0 || idFx === "blizzard" && (counter === 13 || counter === 9 || counter === 5 || counter === 1)) {
              flashScreen();
            } else if (idFx === "explode") {
              if (counter % 4 === 0)
                flashScreen();
              if (counter === 1) {
                events.push({ effect: "SE_HIDE_ATTACKER_PIC", frame });
              }
            } else if (idFx === "rockslide") {
              if (counter >= 8 && counter <= 11) {
                events.push({ effect: "SE_ROCK_SLIDE_SHAKE", frame, dur: 15 });
                emit(15);
              } else if (counter === 1) {
                flashScreen();
              }
            }
          }
        }
      }
    }
    this.frames = frame;
  }
  spritesAt(frame) {
    let at = 0;
    for (const step of this.steps) {
      if (frame < at + step.dur)
        return step.sprites;
      at += step.dur;
    }
    return [];
  }
  eventsIn(from, to) {
    return this.events.filter((e) => e.frame >= from && e.frame < to);
  }
  done(frame) {
    return frame >= this.frames;
  }
}

// voxelmon/game/battle/battler.ts
function makeBattler(data, mon, isPlayer, save) {
  const def = data.pokemon[mon.species];
  if (!def)
    throw new Error(`unknown species ${mon.species}`);
  let badges;
  if (isPlayer && save) {
    badges = {};
    for (const row of BADGE_BOOSTS) {
      if (save.inventory[row.badge])
        badges[row.badge] = true;
    }
  }
  return {
    mon,
    def,
    name: mon.nickname ?? def.name,
    isPlayer,
    badges,
    shownHP: mon.hp,
    shownStatus: mon.status,
    stages: {},
    curStats: mon.stats,
    curTypes: def.types,
    curMoves: mon.moves
  };
}
function displayName(b) {
  return b.isPlayer ? b.name : `Enemy ${b.name}`;
}
function ghostText(data, label, fallback) {
  const v = data.text?.[label];
  return typeof v === "string" ? v : fallback;
}
function prefixEnemy(msg, battler) {
  if (battler.isPlayer)
    return msg;
  const s = msg.indexOf(battler.name);
  if (s < 0)
    return msg;
  return `${msg.slice(0, s)}Enemy ${battler.name}${msg.slice(s + battler.name.length)}`;
}

// voxelmon/game/battle/effects.ts
var STAT_LABEL = {
  attack: "ATTACK",
  defense: "DEFENSE",
  speed: "SPEED",
  special: "SPECIAL",
  accuracy: "ACCURACY",
  evasion: "EVADE"
};
function changeStage(battle, who, stat, delta, fromEnemy) {
  if (fromEnemy && (who.substituteHP !== undefined || who.mist)) {
    if (who.mist)
      return [`${displayName(who)} is
protected by MIST!`];
    return ["But, it failed!"];
  }
  const cur = who.stages[stat] ?? 0;
  const next = Math.max(-6, Math.min(6, cur + delta));
  if (next === cur)
    return ["Nothing happened!"];
  who.stages[stat] = next;
  who.hazeStatReset = undefined;
  const label = STAT_LABEL[stat];
  if (delta >= 2)
    return [`${displayName(who)}'s
${label}
greatly rose!`];
  if (delta === 1)
    return [`${displayName(who)}'s
${label} rose!`];
  if (delta === -1)
    return [`${displayName(who)}'s
${label} fell!`];
  return [`${displayName(who)}'s
${label}
greatly fell!`];
}
function inflictStatus(battle, target, status, opts) {
  if (target.mon.status)
    return [];
  if (target.substituteHP !== undefined && (opts.secondary || status === "PSN")) {
    return [];
  }
  if (opts.secondary && status !== "PSN") {
    for (const t of target.curTypes ?? []) {
      if (opts.moveType === t)
        return [];
    }
  }
  const record = recordFor(target.statuses, status) ?? recordFor(undefined, status);
  if (record?.canInflict && !record.canInflict(target, { moveType: opts.moveType })) {
    return [];
  }
  target.mon.status = status;
  const display = displayName(target);
  if (record?.onInflict) {
    return record.onInflict(target, { toxic: opts.toxic }, display, battle.rng);
  }
  return [`${display}
was afflicted
by ${record?.label ?? status}!`];
}
var FAILED = "But, it failed!";
function statusMove(status) {
  return (ctx) => {
    if (ctx.target.mon.status)
      return [FAILED];
    if (status === "PSN" && ctx.target.substituteHP !== undefined)
      return [FAILED];
    const msgs = inflictStatus(ctx.battle, ctx.target, status, {
      toxic: ctx.move.id === "TOXIC",
      moveType: ctx.move.type,
      source: ctx.move.id
    });
    return msgs.length === 0 ? [FAILED] : msgs;
  };
}
function confuse(battle, target, pierceSub = false) {
  if (target.confusedTurns !== undefined || target.substituteHP !== undefined && !pierceSub) {
    return [FAILED];
  }
  target.confusedTurns = randRange(battle.rng, 2, 5);
  return [`${displayName(target)}
became confused!`];
}
function drainHalf(text) {
  return (ctx) => {
    const heal = Math.max(1, Math.floor((ctx.rawDamage ?? 0) / 2));
    ctx.battle.lastDamage = heal;
    const mon = ctx.user.mon;
    mon.hp = Math.min(mon.stats.hp, mon.hp + heal);
    ctx.battle.drainNext(ctx.user);
    ctx.say(text(displayName(ctx.target)));
  };
}
var FIXED_DAMAGE = {
  SONICBOOM: 20,
  DRAGON_RAGE: 40,
  SEISMIC_TOSS: "level",
  NIGHT_SHADE: "level",
  PSYWAVE: "half_level_rand"
};
function statUp(stat, delta) {
  return (ctx) => ctx.changeStage(ctx.user, stat, delta, false);
}
function statDown(stat, delta) {
  return (ctx) => ctx.changeStage(ctx.target, stat, -delta, true);
}
function flinchSide(chance) {
  return (ctx) => {
    if (ctx.target.substituteHP !== undefined)
      return [];
    if (ctx.battle.rng.byte() < chance)
      ctx.target.flinched = true;
    return [];
  };
}
function statDownSide(stat) {
  return (ctx) => {
    if (ctx.target.substituteHP !== undefined)
      return [];
    if (ctx.battle.rng.byte() >= 85)
      return [];
    return ctx.changeStage(ctx.target, stat, -1, false);
  };
}
function statusSide(status, chance) {
  return (ctx) => {
    if (ctx.move.type === "FIRE" && ctx.target.mon.status === "FRZ") {
      ctx.target.mon.status = null;
      return [`Fire defrosted
${displayName(ctx.target)}!`];
    }
    if (ctx.battle.rng.byte() >= chance)
      return [];
    return inflictStatus(ctx.battle, ctx.target, status, {
      moveType: ctx.move.type,
      secondary: true,
      source: ctx.move.id
    });
  };
}
var PRIMARY = {
  ATTACK_UP1_EFFECT: statUp("attack", 1),
  ATTACK_UP2_EFFECT: statUp("attack", 2),
  DEFENSE_UP1_EFFECT: statUp("defense", 1),
  DEFENSE_UP2_EFFECT: statUp("defense", 2),
  SPEED_UP2_EFFECT: statUp("speed", 2),
  SPECIAL_UP1_EFFECT: statUp("special", 1),
  SPECIAL_UP2_EFFECT: statUp("special", 2),
  EVASION_UP1_EFFECT: statUp("evasion", 1),
  ATTACK_DOWN1_EFFECT: statDown("attack", 1),
  DEFENSE_DOWN1_EFFECT: statDown("defense", 1),
  DEFENSE_DOWN2_EFFECT: statDown("defense", 2),
  SPEED_DOWN1_EFFECT: statDown("speed", 1),
  ACCURACY_DOWN1_EFFECT: statDown("accuracy", 1),
  SLEEP_EFFECT: statusMove("SLP"),
  POISON_EFFECT: statusMove("PSN"),
  PARALYZE_EFFECT: statusMove("PAR"),
  CONFUSION_EFFECT: (ctx) => confuse(ctx.battle, ctx.target),
  LEECH_SEED_EFFECT: (ctx) => {
    if (ctx.target.leechSeeded)
      return [FAILED];
    for (const t of ctx.target.curTypes) {
      if (t === "GRASS")
        return [FAILED];
    }
    ctx.target.leechSeeded = true;
    return [`${displayName(ctx.target)}
was seeded!`];
  },
  HEAL_EFFECT: (ctx) => {
    const mon = ctx.user.mon;
    if (ctx.move.id === "REST") {
      if (mon.hp === mon.stats.hp)
        return [FAILED];
      mon.hp = mon.stats.hp;
      mon.status = "SLP";
      ctx.user.sleepTurns = 2;
      ctx.user.toxicCounter = undefined;
      return [`${displayName(ctx.user)}
started sleeping!`];
    }
    if (mon.hp === mon.stats.hp)
      return [FAILED];
    mon.hp = Math.min(mon.stats.hp, mon.hp + Math.floor(mon.stats.hp / 2));
    return [`${displayName(ctx.user)}
regained health!`];
  },
  LIGHT_SCREEN_EFFECT: (ctx) => {
    if (ctx.user.lightScreen)
      return [FAILED];
    ctx.user.lightScreen = true;
    return [`${displayName(ctx.user)}'s
protected against
special attacks!`];
  },
  REFLECT_EFFECT: (ctx) => {
    if (ctx.user.reflect)
      return [FAILED];
    ctx.user.reflect = true;
    return [`${displayName(ctx.user)}
gained armor!`];
  },
  MIST_EFFECT: (ctx) => {
    if (ctx.user.mist)
      return [FAILED];
    ctx.user.mist = true;
    return [`${displayName(ctx.user)}'s
shrouded in mist!`];
  },
  FOCUS_ENERGY_EFFECT: (ctx) => {
    if (ctx.user.focusEnergy)
      return [FAILED];
    ctx.user.focusEnergy = true;
    return [`${displayName(ctx.user)}'s
getting pumped!`];
  },
  HAZE_EFFECT: (ctx) => {
    for (const b of [ctx.user, ctx.target]) {
      b.stages = {};
      b.confusedTurns = undefined;
      b.leechSeeded = undefined;
      b.toxicCounter = undefined;
      b.reflect = undefined;
      b.lightScreen = undefined;
      b.mist = undefined;
      b.focusEnergy = undefined;
      b.disabledSlot = undefined;
      b.disabledTurns = undefined;
      b.xAccuracy = undefined;
      b.hazeStatReset = true;
    }
    const st = ctx.target.mon.status;
    if (st === "SLP" || st === "FRZ")
      ctx.target.skipMove = true;
    ctx.target.mon.status = null;
    return [`All STATUS changes
are eliminated!`];
  },
  SUBSTITUTE_EFFECT: (ctx) => {
    const user = ctx.user;
    if (user.substituteHP !== undefined) {
      const m = [`${displayName(user)}
has a SUBSTITUTE!`];
      m.failed = true;
      return m;
    }
    const cost = Math.floor(user.mon.stats.hp / 4);
    if (user.mon.hp < cost) {
      const m = [`Too weak to make
a SUBSTITUTE!`];
      m.failed = true;
      return m;
    }
    user.mon.hp -= cost;
    user.substituteHP = cost + 1;
    return [`It created a
SUBSTITUTE!`];
  },
  CONVERSION_EFFECT: (ctx) => {
    if (ctx.target.invulnerable)
      return [FAILED];
    ctx.user.curTypes = [...ctx.target.curTypes];
    return [`Converted type to
${displayName(ctx.target)}'s!`];
  },
  TRANSFORM_EFFECT: (ctx) => {
    const { user, target } = ctx;
    user.curStats = {
      ...user.mon.stats,
      attack: target.curStats.attack,
      defense: target.curStats.defense,
      speed: target.curStats.speed,
      special: target.curStats.special
    };
    user.curTypes = [...target.curTypes];
    user.stages = { ...target.stages };
    user.curMoves = target.curMoves.map((mv) => ({ id: mv.id, pp: 5 }));
    user.transformedInto = target.mon.species;
    return [`${displayName(user)}
transformed into
${target.name}!`];
  },
  DISABLE_EFFECT: (ctx) => {
    const target = ctx.target;
    if (target.disabledSlot !== undefined)
      return [FAILED];
    const usable = [];
    target.curMoves.forEach((mv, i) => {
      if (mv.pp > 0)
        usable.push(i + 1);
    });
    if (usable.length === 0)
      return [FAILED];
    const slot = usable[randRange(ctx.rng, 1, usable.length) - 1];
    target.disabledSlot = slot;
    target.disabledTurns = randRange(ctx.rng, 1, 8);
    const id = target.curMoves[slot - 1].id;
    return [`${displayName(target)}'s
${ctx.data.moves[id]?.name ?? id} was
disabled!`];
  },
  SPLASH_EFFECT: () => ["No effect!"]
};
var ACC_CHECKED = new Set([
  "SLEEP_EFFECT",
  "POISON_EFFECT",
  "PARALYZE_EFFECT",
  "CONFUSION_EFFECT",
  "LEECH_SEED_EFFECT",
  "DISABLE_EFFECT",
  "ATTACK_DOWN1_EFFECT",
  "DEFENSE_DOWN1_EFFECT",
  "DEFENSE_DOWN2_EFFECT",
  "SPEED_DOWN1_EFFECT",
  "ACCURACY_DOWN1_EFFECT"
]);
var SECONDARY = {
  BURN_SIDE_EFFECT1: statusSide("BRN", 26),
  BURN_SIDE_EFFECT2: statusSide("BRN", 77),
  FREEZE_SIDE_EFFECT1: statusSide("FRZ", 26),
  PARALYZE_SIDE_EFFECT1: statusSide("PAR", 26),
  PARALYZE_SIDE_EFFECT2: statusSide("PAR", 77),
  POISON_SIDE_EFFECT1: statusSide("PSN", 52),
  POISON_SIDE_EFFECT2: statusSide("PSN", 103),
  FLINCH_SIDE_EFFECT1: flinchSide(26),
  FLINCH_SIDE_EFFECT2: flinchSide(77),
  ATTACK_DOWN_SIDE_EFFECT: statDownSide("attack"),
  DEFENSE_DOWN_SIDE_EFFECT: statDownSide("defense"),
  SPEED_DOWN_SIDE_EFFECT: statDownSide("speed"),
  SPECIAL_DOWN_SIDE_EFFECT: statDownSide("special"),
  CONFUSION_SIDE_EFFECT: (ctx) => {
    if (ctx.target.confusedTurns !== undefined)
      return [];
    if (ctx.battle.rng.byte() >= 25)
      return [];
    return confuse(ctx.battle, ctx.target, true);
  },
  TWINEEDLE_EFFECT: (ctx) => {
    if (ctx.battle.rng.byte() >= 52)
      return [];
    return inflictStatus(ctx.battle, ctx.target, "PSN", {
      secondary: true,
      source: "TWINEEDLE"
    });
  }
};
function hitsFrom(dist, ctx) {
  if (typeof dist === "number")
    return dist;
  return dist[randRange(ctx.rng, 0, dist.length - 1)];
}
var plainInfo = () => ({ crit: false, typeMult: 10 });
var FULL = {
  NO_ADDITIONAL_EFFECT: {},
  TWO_TO_FIVE_ATTACKS_EFFECT: {
    hitCount: (ctx) => hitsFrom(ctx.move.multiHit ?? [
      2,
      2,
      2,
      3,
      3,
      3,
      4,
      5
    ], ctx)
  },
  ATTACK_TWICE_EFFECT: {
    hitCount: (ctx) => hitsFrom(ctx.move.multiHit ?? 2, ctx)
  },
  TWINEEDLE_EFFECT: {
    hitCount: (ctx) => hitsFrom(ctx.move.multiHit ?? 2, ctx)
  },
  SPECIAL_DAMAGE_EFFECT: {
    chooseDamage: (ctx) => {
      const spec = FIXED_DAMAGE[ctx.move.id];
      let dmg;
      if (spec === "level")
        dmg = ctx.user.mon.level;
      else if (spec === "half_level_rand") {
        const max = Math.max(1, Math.floor(ctx.user.mon.level * 3 / 2) - 1);
        dmg = randRange(ctx.rng, 1, max);
      } else
        dmg = spec;
      if (!dmg)
        return [null, FAILED];
      return [dmg, plainInfo()];
    }
  },
  SUPER_FANG_EFFECT: {
    chooseDamage: (ctx) => [Math.max(1, Math.floor(ctx.target.mon.hp / 2)), plainInfo()]
  },
  OHKO_EFFECT: {
    gate: (ctx) => {
      if (ctx.battle.chart.effectiveness(ctx.move.type, ctx.target.curTypes) === 0) {
        return [false, `It doesn't affect
${displayName(ctx.target)}!`];
      }
      if (effectiveSpeed(ctx.user) < effectiveSpeed(ctx.target))
        return [false, FAILED];
      return [true];
    },
    chooseDamage: () => [65535, { crit: false, typeMult: 10, ohko: true }]
  },
  RECOIL_EFFECT: {
    afterDamage: (ctx) => {
      const recoil = Math.max(1, Math.floor((ctx.rawDamage ?? 0) / (ctx.moveInst.struggle ? 2 : 4)));
      ctx.say(`${displayName(ctx.user)}'s
hit with recoil!`);
      ctx.battle.applyDamage(ctx.user, recoil);
    }
  },
  DRAIN_HP_EFFECT: {
    afterDamage: drainHalf((t) => `Sucked health from
${t}!`)
  },
  DREAM_EATER_EFFECT: {
    gate: (ctx) => ctx.target.mon.status !== "SLP" ? [false, FAILED] : [true],
    afterDamage: drainHalf((t) => `${t}'s
dream was eaten!`)
  },
  CHARGE_EFFECT: { charge: { anim: "XSTATITEM_ANIM", enemyAnim: "XSTATITEM_DUPLICATE_ANIM" } },
  FLY_EFFECT: { charge: { invulnerable: true, anim: "TELEPORT" } },
  TRAPPING_EFFECT: {
    beforeAccuracy: (ctx) => {
      if (ctx.user.trappingTurns === undefined)
        ctx.target.mustRecharge = undefined;
    },
    afterDamage: (ctx) => {
      const user = ctx.user;
      if (user.trappingTurns === undefined) {
        const r = randRange(ctx.rng, 0, 7);
        user.trappingTurns = [1, 1, 1, 2, 2, 2, 3, 4][r];
        user.trapDamage = ctx.rawDamage;
        user.trapMove = ctx.move.id;
      }
    }
  },
  THRASH_PETAL_DANCE_EFFECT: {
    afterDamage: (ctx) => {
      const user = ctx.user;
      if (user.thrashTurns === undefined) {
        user.thrashTurns = randRange(ctx.rng, 2, 3);
        user.thrashMove = ctx.moveInst;
        user.thrashAnnounced = true;
      } else {
        user.thrashTurns -= 1;
        if (user.thrashTurns <= 0) {
          user.thrashTurns = undefined;
          user.thrashMove = undefined;
          user.thrashAnnounced = undefined;
          if (user.confusedTurns === undefined) {
            user.confusedTurns = randRange(ctx.rng, 2, 5);
            ctx.say(`${displayName(user)}
became confused!`);
          }
        }
      }
    }
  },
  JUMP_KICK_EFFECT: {
    onMiss: (ctx, reason) => {
      if (reason !== "accuracy")
        return;
      ctx.say(`${displayName(ctx.user)}
kept going and
crashed!`);
      ctx.damage(ctx.user, 1);
    }
  },
  EXPLODE_EFFECT: {
    explode: true,
    onMiss: (ctx) => ctx.battle.selfDestruct(ctx.user),
    afterDamage: (ctx) => ctx.battle.selfDestruct(ctx.user)
  },
  HYPER_BEAM_EFFECT: {
    afterDamage: (ctx) => {
      const skipOnKO = ctx.battle.ruleset.hyperBeamSkipRechargeOnKO !== false;
      const targetDown = ctx.target.mon.hp <= 0 || ctx.brokeSub;
      if (!skipOnKO || !targetDown)
        ctx.user.mustRecharge = true;
    }
  },
  PAY_DAY_EFFECT: {
    afterDamage: (ctx) => {
      ctx.battle.payDay += 2 * ctx.user.mon.level;
      ctx.say(`Coins scattered
everywhere!`);
    }
  },
  SWIFT_EFFECT: { neverMiss: true },
  RAGE_EFFECT: {
    afterDamage: (ctx) => {
      ctx.user.rageMove = ctx.moveInst;
    }
  },
  BIDE_EFFECT: {
    perform: (ctx) => {
      const user = ctx.user;
      user.bideTurns = randRange(ctx.rng, 2, 3);
      user.bideDamage = 0;
      ctx.battle.cancelMoveAnim();
      ctx.battle.animNext(user.isPlayer ? "XSTATITEM_ANIM" : "XSTATITEM_DUPLICATE_ANIM", user.isPlayer);
      ctx.say(`${displayName(user)}
is storing energy!`);
    }
  },
  SWITCH_AND_TELEPORT_EFFECT: {
    perform: (ctx) => {
      const { battle, user, target, move } = ctx;
      if (!battle.trainerBattle) {
        const uLvl = user.mon.level;
        const tLvl = target.mon.level;
        let ok = uLvl >= tLvl;
        if (!ok)
          ok = randRange(ctx.rng, 0, uLvl + tLvl) >= Math.floor(tLvl / 4);
        if (ok) {
          if (move.id === "ROAR")
            ctx.say(`${displayName(target)}
ran away scared!`);
          else if (move.id === "WHIRLWIND")
            ctx.say(`${displayName(target)}
was blown away!`);
          else
            ctx.say(`${displayName(user)}
ran from battle!`);
          battle.escape();
        } else if (move.id === "TELEPORT") {
          battle.cancelMoveAnim();
          ctx.say(FAILED);
        } else {
          battle.cancelMoveAnim();
          ctx.say(`It didn't affect
${displayName(target)}!`);
        }
      } else if (move.id === "TELEPORT") {
        battle.cancelMoveAnim();
        ctx.say(FAILED);
      } else {
        battle.cancelMoveAnim();
        ctx.say(`${displayName(target)}
is unaffected!`);
      }
    }
  },
  METRONOME_EFFECT: {
    callsMove: (ctx) => {
      const order = ctx.data.constants?.moveOrder ?? Object.keys(ctx.data.moves);
      for (let tries = 0;tries < 1000; tries++) {
        const pick = order[randRange(ctx.rng, 1, order.length) - 1];
        if (pick !== "METRONOME" && pick !== "STRUGGLE" && ctx.data.moves[pick])
          return pick;
      }
      return null;
    }
  },
  MIRROR_MOVE_EFFECT: {
    callsMove: (ctx) => {
      const last = ctx.target.lastMove;
      if (!last) {
        ctx.say(`The MIRROR MOVE
failed!`);
        return null;
      }
      return last;
    }
  }
};
var EFFECTS = {};
for (const [id, run] of Object.entries(PRIMARY)) {
  EFFECTS[id] = { kind: "primary", run, accuracyChecked: ACC_CHECKED.has(id) || undefined };
}
for (const [id, run] of Object.entries(SECONDARY)) {
  EFFECTS[id] = { kind: "secondary", run };
}
for (const [id, spec] of Object.entries(FULL)) {
  const record = { kind: "full", ...spec };
  const secondary = SECONDARY[id];
  if (secondary)
    record.run = secondary;
  EFFECTS[id] = record;
}
var warned2 = new Set;
function warnUnknown(effect) {
  if (!warned2.has(effect)) {
    warned2.add(effect);
    console.warn(`move effect ${effect} not implemented; treated as plain damage`);
  }
}
function effectRecord(effect) {
  return effect === undefined ? undefined : EFFECTS[effect];
}
function makeCtx(battle, user, target, move, moveInst, isCalled) {
  return {
    battle,
    data: battle.data,
    rng: battle.rng,
    ruleset: battle.ruleset,
    user,
    target,
    move,
    moveInst,
    isCalled,
    say: (text) => battle.sayNext(text),
    damage: (who, amount) => {
      const dealt = battle.applyDamage(who, amount);
      if (who.mon.hp <= 0)
        battle.onFaint(who);
      return dealt;
    },
    changeStage: (who, stat, delta, fromEnemy) => changeStage(battle, who, stat, delta, fromEnemy)
  };
}
function missBeat(battle, record) {
  if (record?.explode)
    return;
  battle.waitNext(MOVE_STATUS_OR_MISS);
}
function hitCount(ctx, record) {
  if (record?.hitCount)
    return record.hitCount(ctx) || 1;
  const dist = ctx.move.multiHit;
  if (dist === undefined)
    return 1;
  if (typeof dist === "number")
    return dist;
  const r = randRange(ctx.rng, 0, dist.length - 1);
  return dist[r];
}
function runDamaging(battle, ctx, record) {
  const { user, target, move, moveInst } = ctx;
  const neverMiss = record?.neverMiss;
  if (target.invulnerable && !neverMiss) {
    if (!record?.explode)
      battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s
attack missed!`);
    record?.onMiss?.(ctx, "invulnerable");
    return;
  }
  if (record?.gate) {
    const [ok, failMsg] = record.gate(ctx);
    if (!ok) {
      battle.cancelMoveAnim();
      if (failMsg)
        battle.sayNext(failMsg);
      return;
    }
  }
  const hitsWanted = hitCount(ctx, record);
  record?.beforeAccuracy?.(ctx);
  if (!neverMiss) {
    if (!battle.accuracyRoll(move, user, target)) {
      if (!record?.explode)
        battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s
attack missed!`);
      record?.onMiss?.(ctx, "accuracy");
      user.trappingTurns = undefined;
      return;
    }
  }
  let dmg;
  let info;
  if (move.id === "COUNTER") {
    const lastId = target.lastMove;
    const lm = lastId && lastId !== "COUNTER" ? battle.data.moves[lastId] : undefined;
    let counterable = false;
    if (lm && (lm.power ?? 0) > 0) {
      counterable = lm.type === "NORMAL" || lm.type === "FIGHTING";
    }
    if (!counterable || battle.lastDamage === 0) {
      battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s
attack missed!`);
      return;
    }
    dmg = Math.min(65535, battle.lastDamage * 2);
    info = { crit: false, typeMult: 10 };
  } else if (record?.chooseDamage) {
    const [chosen, extra] = record.chooseDamage(ctx);
    if (chosen === null || chosen === undefined) {
      battle.cancelMoveAnim();
      if (typeof extra === "string")
        battle.sayNext(extra);
      return;
    }
    dmg = chosen;
    info = typeof extra === "object" && extra ? extra : { crit: false, typeMult: 10 };
  } else {
    [dmg, info] = battle.computeDamage(user, target, move, {
      rng: battle.rng,
      explode: record?.explode || undefined
    });
  }
  if (info.typeMult === 0) {
    if (!record?.explode)
      battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`It doesn't affect
${displayName(target)}!`);
    record?.onMiss?.(ctx, "immune");
    return;
  }
  if (info.missed) {
    if (!record?.explode)
      battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s
attack missed!`);
    record?.onMiss?.(ctx, "floored");
    return;
  }
  battle.lastDamage = dmg;
  const hitSfx = info.typeMult > 10 ? { sound: "Super_Effective", pitch: 224 } : info.typeMult < 10 ? { sound: "Not_Very_Effective", pitch: 80 } : { sound: "Damage", pitch: 32 };
  const added = move.effect !== undefined && move.effect !== "NO_ADDITIONAL_EFFECT";
  const hitFx = {
    sfx: hitSfx,
    animType: user.isPlayer ? added ? 5 : 4 : added ? 2 : 1
  };
  let totalDealt = 0;
  let landed = 0;
  let brokeSub = false;
  for (let h = 1;h <= hitsWanted; h++) {
    if (target.mon.hp <= 0)
      break;
    const hitRow = h === 1 ? battle.moveAnimRow ?? battle.insertHitRow(null, user.isPlayer) : battle.insertHitRow(move.id, user.isPlayer);
    const hadSub = target.substituteHP !== undefined;
    const dealt = battle.applyDamage(target, dmg);
    totalDealt += dealt;
    landed = h;
    if (dealt > 0)
      hitRow.hit = hitFx;
    if (info.crit)
      battle.sayNext("Critical hit!");
    if (info.ohko)
      battle.sayNext("One-hit KO!");
    battle.waitNext(CRIT_OHKO_TEXT);
    if (info.typeMult > 10) {
      battle.sayNext(`It's super
effective!`);
    } else if (info.typeMult < 10) {
      battle.sayNext(`It's not very
effective...`);
    }
    if (hadSub && target.substituteHP === undefined) {
      brokeSub = true;
      break;
    }
  }
  const hits = landed > 0 ? landed : hitsWanted;
  if (hits > 1) {
    battle.sayNext(user.isPlayer ? `Hit the enemy
${hits} times!` : `Hit ${hits} times!`);
  }
  ctx.rawDamage = dmg;
  ctx.totalDealt = totalDealt;
  ctx.brokeSub = brokeSub;
  ctx.hits = hits;
  if (record?.afterDamage) {
    record.afterDamage(ctx, totalDealt);
  } else if (moveInst.struggle) {
    const recoil = Math.max(1, Math.floor(dmg / 2));
    battle.sayNext(`${displayName(user)}'s
hit with recoil!`);
    battle.applyDamage(user, recoil);
  }
  if (record?.run && record.kind !== "primary" && target.mon.hp > 0 && totalDealt > 0) {
    for (const m of record.run(ctx))
      battle.sayNext(m);
  }
  if (record === undefined && move.effect) {
    warnUnknown(move.effect);
  }
  if (target.mon.hp <= 0)
    battle.onFaint(target);
  if (user.mon.hp <= 0)
    battle.onFaint(user);
}

// voxelmon/game/battle/mon.ts
function movesAtLevel(speciesDef, level) {
  const moves = [];
  const add = (id) => {
    if (!moves.includes(id))
      moves.push(id);
  };
  for (const m of speciesDef.level1Moves)
    add(m);
  for (const entry of speciesDef.learnset) {
    if (entry.level <= level)
      add(entry.move);
  }
  while (moves.length > 4)
    moves.shift();
  return moves;
}
function newMon(data, species, level, rng, dvs) {
  const def = data.pokemon[species];
  if (!def)
    throw new Error(`unknown species ${species}`);
  const rolled = dvs ?? (rng ? randomDVs(rng) : { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 });
  const stats = calc(def, level, rolled);
  const moves = [];
  for (const id of movesAtLevel(def, level)) {
    moves.push({ id, pp: data.moves[id]?.pp ?? 0 });
  }
  return {
    species,
    level,
    exp: expForLevel(def.growthRate, level, data.growth_rates),
    dvs: rolled,
    statExp: { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 },
    stats,
    hp: stats.hp,
    catchRate: def.catchRate,
    status: null,
    moves
  };
}
function healMon(data, mon) {
  mon.hp = mon.stats.hp;
  mon.status = null;
  for (const mv of mon.moves) {
    const def = data.moves[mv.id];
    if (def)
      mv.pp = def.pp + (mv.ppUps ?? 0) * Math.floor(def.pp / 5);
  }
}
var PARTY_MAX = 6;
function partyAdd(party, mon) {
  if (party.length >= PARTY_MAX)
    return false;
  party.push(mon);
  return true;
}
function firstHealthy(party) {
  for (const mon of party) {
    if (mon.hp > 0)
      return mon;
  }
  return null;
}
function markSeen(save, species) {
  const dex = save.pokedex;
  if (dex)
    dex.seen[species] = true;
}
function markOwned(save, species) {
  const dex = save.pokedex;
  if (dex) {
    dex.seen[species] = true;
    dex.owned[species] = true;
  }
}

// voxelmon/game/rules/items.ts
var HEAL_AMOUNT = {
  POTION: 20,
  SUPER_POTION: 50,
  HYPER_POTION: 200,
  FRESH_WATER: 50,
  SODA_POP: 60,
  LEMONADE: 80
};
var STATUS_HEAL = {
  ANTIDOTE: ["PSN"],
  BURN_HEAL: ["BRN"],
  ICE_HEAL: ["FRZ"],
  AWAKENING: ["SLP"],
  PARLYZ_HEAL: ["PAR"],
  FULL_HEAL: ["PSN", "BRN", "FRZ", "SLP", "PAR"]
};
var BALLS2 = new Set(["POKE_BALL", "GREAT_BALL", "ULTRA_BALL", "MASTER_BALL", "SAFARI_BALL"]);
var STONES = new Set(["FIRE_STONE", "WATER_STONE", "THUNDER_STONE", "LEAF_STONE", "MOON_STONE"]);
var VITAMINS = {
  HP_UP: "hp",
  PROTEIN: "attack",
  IRON: "defense",
  CARBOS: "speed",
  CALCIUM: "special"
};
var REPELS = { REPEL: 100, SUPER_REPEL: 200, MAX_REPEL: 250 };
var X_ITEMS = {
  X_ATTACK: "attack",
  X_DEFEND: "defense",
  X_SPEED: "speed",
  X_SPECIAL: "special"
};
var BATTLE_ONLY = new Set([
  ...Object.keys(X_ITEMS),
  "X_ACCURACY",
  "DIRE_HIT",
  "GUARD_SPEC",
  "POKE_DOLL"
]);
var CURE_TEXT = {
  ANTIDOTE: "_AntidoteText",
  BURN_HEAL: "_BurnHealText",
  ICE_HEAL: "_IceHealText",
  AWAKENING: "_AwakeningText",
  PARLYZ_HEAL: "_ParlyzHealText",
  FULL_HEAL: "_FullHealText"
};
var ESCAPE_ROPE_TILESETS = new Set(["FOREST", "CEMETERY", "CAVERN", "FACILITY", "INTERIOR"]);
function isBall(id) {
  return BALLS2.has(id);
}
function needsTarget(data, id) {
  return HEAL_AMOUNT[id] !== undefined || STATUS_HEAL[id] !== undefined || id === "MAX_POTION" || id === "FULL_RESTORE" || id === "REVIVE" || id === "MAX_REVIVE" || id === "RARE_CANDY" || STONES.has(id) || !!data?.items?.[id]?.machine || needsMove(id) || id === "ELIXER" || id === "MAX_ELIXER" || VITAMINS[id] !== undefined;
}
function needsMove(id) {
  return id === "ETHER" || id === "MAX_ETHER" || id === "PP_UP";
}
function refusedInBattle(data, id) {
  return VITAMINS[id] !== undefined || STONES.has(id) || id === "PP_UP" || id === "RARE_CANDY" || id === "COIN_CASE" || REPELS[id] !== undefined || !!data?.items?.[id]?.machine;
}
function repelled(save, level) {
  const steps = save.repelSteps ?? 0;
  const lead = save.party?.[0];
  return steps > 0 && lead !== undefined && level < lead.level;
}
function itemText(data, key, fallback, subs = {}) {
  const raw = data?.text?.[key];
  let s = typeof raw === "string" && raw.length > 0 ? raw : fallback;
  s = s.replace(/\{RAM:wNameBuffer\}/g, String(subs.name ?? ""));
  s = s.replace(/\{RAM:wStringBuffer\}/g, String(subs.str ?? ""));
  s = s.replace(/\{RAM:wEnemyMonNick\}/g, String(subs.enemy ?? ""));
  s = s.replace(/\{USER\}/g, String(subs.name ?? ""));
  s = s.replace(/\{PLAYER\}/g, String(subs.player ?? ""));
  s = s.replace(/\{NUM:[^}]*\}/g, String(subs.num ?? ""));
  return s.replace(/[ \t]+$/g, "");
}
function notTime(data, save) {
  return itemText(data, "_ItemUseNotTimeText", `OAK: {PLAYER}!
This isn't the
time to use that!`, { player: save?.player?.name ?? "RED" });
}
function noEffect(data) {
  return itemText(data, "_ItemUseNoEffectText", `It won't have any
effect.`);
}
function monName(data, mon) {
  return mon.nickname ?? data?.pokemon?.[mon.species]?.name ?? mon.species;
}
function maxPP(data, mv) {
  const base = data?.moves?.[mv.id]?.pp;
  if (typeof base !== "number")
    return null;
  return base + (mv.ppUps ?? 0) * Math.floor(base / 5);
}
function cureActiveToxic(battle, target) {
  if (!battle)
    return;
  for (const b of [battle.player, battle.enemy]) {
    if (b && b.mon === target)
      b.toxicCounter = undefined;
  }
}
function useItem(data, save, itemId, target, battle, moveIndex) {
  const def = data?.items?.[itemId];
  const name = def?.name ?? itemId;
  if (battle && refusedInBattle(data, itemId)) {
    return { kind: "failed", msgs: [notTime(data, save)] };
  }
  if (BALLS2.has(itemId))
    return { kind: "ball", msgs: [] };
  if (BATTLE_ONLY.has(itemId)) {
    if (!battle)
      return { kind: "failed", msgs: [notTime(data, save)] };
    const b = battle.player;
    if (itemId === "X_ACCURACY") {
      b.xAccuracy = true;
      return { kind: "consumed", msgs: [`${b.name}'s
hits will never
miss!`] };
    }
    const stat = X_ITEMS[itemId];
    if (stat) {
      b.stages ??= {};
      const cur = b.stages[stat] ?? 0;
      if (cur >= 6) {
        return { kind: "consumed", msgs: [itemText(data, "_NothingHappenedText", "Nothing happened!")] };
      }
      b.stages[stat] = cur + 1;
      return { kind: "consumed", msgs: [`${b.name}'s
${stat.toUpperCase()} rose!`] };
    }
    if (itemId === "DIRE_HIT") {
      b.focusEnergy = true;
      return { kind: "consumed", msgs: [itemText(data, "_GettingPumpedText", `{USER}'s
getting pumped!`, { name: b.name })] };
    }
    if (itemId === "GUARD_SPEC") {
      b.mist = true;
      return { kind: "consumed", msgs: [`${b.name}'s
protected against
stat changes!`] };
    }
    if (itemId === "POKE_DOLL") {
      if (battle.kind !== "wild")
        return { kind: "failed", msgs: [notTime(data, save)] };
      return {
        kind: "consumed_escape",
        msgs: [itemText(data, "_WildRanText", `Wild {RAM:wEnemyMonNick}
ran!`, { enemy: battle.enemy?.name ?? "" })]
      };
    }
  }
  if (itemId === "ETHER" || itemId === "MAX_ETHER" || itemId === "ELIXER" || itemId === "MAX_ELIXER") {
    if (!target)
      return { kind: "failed", msgs: [noEffect(data)] };
    const full = itemId === "MAX_ETHER" || itemId === "MAX_ELIXER";
    const all = itemId === "ELIXER" || itemId === "MAX_ELIXER";
    const restore = (mv) => {
      const cap = maxPP(data, mv);
      if (cap === null || mv.pp >= cap)
        return false;
      mv.pp = full ? cap : Math.min(cap, mv.pp + 10);
      return true;
    };
    let restored = false;
    if (all) {
      for (const mv of target.moves)
        restored = restore(mv) || restored;
    } else {
      const mv = target.moves[moveIndex ?? 0];
      restored = mv ? restore(mv) : false;
    }
    if (!restored)
      return { kind: "failed", msgs: [noEffect(data)] };
    return { kind: "consumed", msgs: [itemText(data, "_PPRestoredText", "PP was restored.")] };
  }
  const heal = HEAL_AMOUNT[itemId];
  if (heal !== undefined || itemId === "MAX_POTION" || itemId === "FULL_RESTORE") {
    if (itemId === "FULL_RESTORE" && target && target.hp > 0 && target.hp >= target.stats.hp && target.status) {
      target.status = null;
      cureActiveToxic(battle, target);
      return {
        kind: "consumed",
        msgs: [itemText(data, CURE_TEXT.FULL_HEAL, `{RAM:wNameBuffer}'s
health returned!`, { name: monName(data, target) })]
      };
    }
    if (!target || target.hp <= 0 || target.hp >= target.stats.hp) {
      return { kind: "failed", msgs: [noEffect(data)] };
    }
    const before = target.hp;
    target.hp = heal === undefined ? target.stats.hp : Math.min(target.stats.hp, target.hp + heal);
    if (itemId === "FULL_RESTORE") {
      target.status = null;
      cureActiveToxic(battle, target);
    }
    return {
      kind: "consumed",
      msgs: [itemText(data, "_PotionText", `{RAM:wNameBuffer}
recovered by {NUM}!`, { name: monName(data, target), num: target.hp - before })],
      healedFrom: before
    };
  }
  const cures = STATUS_HEAL[itemId];
  if (cures) {
    if (!target || !target.status || !cures.includes(target.status)) {
      return { kind: "failed", msgs: [noEffect(data)] };
    }
    target.status = null;
    cureActiveToxic(battle, target);
    return {
      kind: "consumed",
      msgs: [itemText(data, CURE_TEXT[itemId], `{RAM:wNameBuffer}'s
status returned
to normal!`, { name: monName(data, target) })]
    };
  }
  if (itemId === "REVIVE" || itemId === "MAX_REVIVE") {
    if (!target || target.hp > 0)
      return { kind: "failed", msgs: [noEffect(data)] };
    target.status = null;
    target.hp = itemId === "REVIVE" ? Math.floor(target.stats.hp / 2) : target.stats.hp;
    return {
      kind: "consumed",
      msgs: [itemText(data, "_ReviveText", `{RAM:wNameBuffer}
is revitalized!`, { name: monName(data, target) })],
      healedFrom: 0
    };
  }
  if (STONES.has(itemId)) {
    if (!target)
      return { kind: "failed", msgs: [noEffect(data)] };
    for (const evo of data?.pokemon?.[target.species]?.evolutions ?? []) {
      if (evo.method === "ITEM" && evo.item === itemId) {
        return { kind: "consumed", msgs: [], evolveTo: evo.species };
      }
    }
    return { kind: "failed", msgs: [noEffect(data)] };
  }
  const vit = VITAMINS[itemId];
  if (vit) {
    if (!target)
      return { kind: "failed", msgs: [noEffect(data)] };
    const se = target.statExp ??= {};
    const cur = se[vit] ?? 0;
    if (cur >= 25600)
      return { kind: "failed", msgs: [noEffect(data)] };
    se[vit] = Math.min(65535, cur + 2560);
    const sdef = data?.pokemon?.[target.species];
    if (sdef) {
      target.stats = calc(sdef, target.level, target.dvs, target.statExp);
      target.hp = Math.min(target.hp, target.stats.hp);
    }
    return {
      kind: "consumed",
      msgs: [itemText(data, "_VitaminStatRoseText", `{RAM:wNameBuffer}'s
{RAM:wStringBuffer} rose.`, { name: monName(data, target), str: vit === "hp" ? "HEALTH" : vit.toUpperCase() })]
    };
  }
  if (itemId === "PP_UP") {
    if (!target)
      return { kind: "failed", msgs: [noEffect(data)] };
    const mv = target.moves[moveIndex ?? 0];
    const base = mv ? data?.moves?.[mv.id]?.pp : undefined;
    if (mv && typeof base === "number" && (mv.ppUps ?? 0) < 3) {
      mv.ppUps = (mv.ppUps ?? 0) + 1;
      mv.pp += Math.floor(base / 5);
      return {
        kind: "consumed",
        msgs: [itemText(data, "_PPIncreasedText", `{RAM:wStringBuffer}'s PP
increased.`, { str: data?.moves?.[mv.id]?.name ?? mv.id })]
      };
    }
    return { kind: "failed", msgs: [noEffect(data)] };
  }
  if (itemId === "ESCAPE_ROPE")
    return { kind: "escape_rope", msgs: [] };
  if (itemId === "TOWN_MAP") {
    if (battle)
      return { kind: "failed", msgs: [notTime(data, save)] };
    return { kind: "townmap", msgs: [] };
  }
  if (itemId === "ITEMFINDER") {
    if (battle)
      return { kind: "failed", msgs: [notTime(data, save)] };
    return { kind: "itemfinder", msgs: [] };
  }
  if (itemId === "COIN_CASE") {
    return {
      kind: "failed",
      msgs: [itemText(data, "_CoinCaseNumCoinsText", `Coins
{NUM}`, { num: save?.coins ?? 0 })]
    };
  }
  const repel = REPELS[itemId];
  if (repel !== undefined) {
    save.repelSteps = repel;
    return { kind: "consumed", msgs: [`${save?.player?.name ?? "RED"} used
${name}!`] };
  }
  return { kind: "failed", msgs: [notTime(data, save)] };
}

// voxelmon/game/pokemon/boxes.ts
var BOX_COUNT = 12;
var BOX_CAPACITY = 20;
function ensure(save) {
  if (!save.boxes) {
    save.boxes = [];
    for (let i = 0;i < BOX_COUNT; i++)
      save.boxes[i] = [];
    save.currentBox = 1;
    if (Array.isArray(save.box)) {
      for (const mon of save.box)
        save.boxes[0].push(mon);
      save.box = null;
    }
  }
  save.currentBox = Math.max(1, Math.min(BOX_COUNT, save.currentBox ?? 1));
  return save.boxes;
}
function active(save) {
  return ensure(save)[save.currentBox - 1];
}
function deposit(save, mon) {
  const boxes = ensure(save);
  for (let off = 0;off < BOX_COUNT; off++) {
    const i = (save.currentBox - 1 + off) % BOX_COUNT;
    if (boxes[i].length < BOX_CAPACITY) {
      boxes[i].push(mon);
      return i + 1;
    }
  }
  return null;
}

// voxelmon/game/rules/bag.ts
var DEFAULT_CAPACITY = 20;
function capacity(data) {
  const configured = data?.constants?.bagSize;
  if (typeof configured === "number" && configured >= 1) {
    return Math.floor(configured);
  }
  return DEFAULT_CAPACITY;
}
function precious(data, id) {
  const def = data.items?.[id];
  return !def || id.startsWith("HM_") || def.keyItem === true || def.tossable === false;
}
function isBadge(id) {
  return id.includes("BADGE");
}
function slots(save) {
  let n = 0;
  for (const id of Object.keys(save.inventory)) {
    if (!isBadge(id))
      n += 1;
  }
  return n;
}
function order(save) {
  let list = save.bagOrder;
  if (!Array.isArray(list)) {
    list = undefined;
  }
  if (!list) {
    list = [];
    for (const id of Object.keys(save.inventory)) {
      if (!isBadge(id))
        list.push(id);
    }
    list.sort();
    save.bagOrder = list;
  }
  const seen = new Set;
  for (let i = list.length - 1;i >= 0; i--) {
    const id = list[i];
    if (save.inventory[id] === undefined || seen.has(id)) {
      list.splice(i, 1);
    } else {
      seen.add(id);
    }
  }
  for (const id of Object.keys(save.inventory)) {
    if (!isBadge(id) && !seen.has(id))
      list.push(id);
  }
  return list;
}
function add(save, id, qty, data) {
  const inv = save.inventory;
  if (inv[id] === undefined && !isBadge(id) && slots(save) >= capacity(data)) {
    return false;
  }
  if (!isBadge(id) && (inv[id] ?? 0) + (qty ?? 1) > 99) {
    return false;
  }
  const isNew = inv[id] === undefined;
  inv[id] = (inv[id] ?? 0) + (qty ?? 1);
  if (isNew && !isBadge(id)) {
    order(save).push(id);
  }
  return true;
}
function remove(save, id, qty) {
  const inv = save.inventory;
  inv[id] = (inv[id] ?? 0) - (qty ?? 1);
  if (inv[id] <= 0) {
    delete inv[id];
    const list = save.bagOrder;
    if (Array.isArray(list)) {
      const i = list.indexOf(id);
      if (i !== -1)
        list.splice(i, 1);
    }
  }
}

// voxelmon/game/battle/battle.ts
function listStep(input) {
  if (input.wasPressed("up") || input.wasPressed("left"))
    return -1;
  if (input.wasPressed("down") || input.wasPressed("right"))
    return 1;
  return 0;
}
function pressedDir(input) {
  return input.wasPressed("left") || input.wasPressed("right") || input.wasPressed("up") || input.wasPressed("down");
}
function gridStep(input, index, cols, count) {
  if (count <= 0)
    return index;
  const rows = Math.ceil(count / cols);
  let col = index % cols;
  let row = Math.floor(index / cols);
  if (input.wasPressed("left"))
    col = Math.max(0, col - 1);
  else if (input.wasPressed("right"))
    col = Math.min(cols - 1, col + 1);
  else if (input.wasPressed("up"))
    row = Math.max(0, row - 1);
  else if (input.wasPressed("down"))
    row = Math.min(rows - 1, row + 1);
  else
    return index;
  const next = row * cols + col;
  return next < count ? next : index;
}
var GEAR_GRID_COLS = 2;
var DEMO_MENU_HOLD = 130;
var CHARGE_TEXT = {
  FLY: `%s
flew up high!`,
  DIG: `%s
dug a hole!`,
  RAZOR_WIND: `%s
made a whirlwind!`,
  SOLARBEAM: `%s
took in sunlight!`,
  SKULL_BASH: `%s
lowered its head!`,
  SKY_ATTACK: `%s
is glowing!`
};
var SLOW_SHAKE_EFFECTS = new Set([
  "SLEEP_EFFECT",
  "POISON_EFFECT",
  "CONFUSION_EFFECT",
  "DISABLE_EFFECT",
  "ATTACK_DOWN1_EFFECT",
  "DEFENSE_DOWN1_EFFECT",
  "DEFENSE_DOWN2_EFFECT",
  "SPEED_DOWN1_EFFECT",
  "ACCURACY_DOWN1_EFFECT"
]);

class WildBattle {
  kind = "wild";
  data;
  rng;
  save;
  messageLog = [];
  ruleset = GEN1_FAITHFUL;
  chart;
  player;
  enemy;
  dead = false;
  queue = [];
  phase = "messages";
  learnPending = null;
  forgetIndex = 0;
  hmCache = null;
  afterQueue = "menu";
  menuIndex = 1;
  moveIndex = 1;
  moveSwapIndex = null;
  frame = 0;
  moveSfxIndex = null;
  moveAnim = null;
  moveAnimFrame = 0;
  moveAnimDefender = SIDE_ENEMY;
  turnCount = 0;
  runAttempts = 0;
  lastDamage = 0;
  result = null;
  finished = null;
  audioCues = [];
  introBalls = true;
  showPlayerBack = true;
  sendingOut = false;
  blackedOut = false;
  enemyHidden = false;
  lastBall = null;
  noCatch = false;
  disguised = false;
  ghostRealName = "";
  scopeReveal = false;
  hooked = false;
  makeGhost() {
    this.disguised = true;
    this.ghostRealName = this.enemy.name;
    this.enemy.name = "GHOST";
  }
  makeUnveiledGhost() {
    this.makeGhost();
    this.scopeReveal = true;
  }
  demo = false;
  demoName = "OLD MAN";
  demoFails = false;
  oakDemo = false;
  demoTimer = 0;
  nextInsert = 0;
  waitFrames = 0;
  draining = false;
  moveAnimRow = null;
  anims = [];
  current = null;
  statBoxMon = null;
  lines = [];
  lineIndex = 0;
  codes = [];
  shown = [];
  msgWaiting = false;
  msgPreWait = 0;
  msgPrompt = false;
  msgPromptWait = 0;
  msgAutoWait = null;
  msgHold = false;
  charTimer = 0;
  choiceOpen = false;
  choiceYes = true;
  choicePending = null;
  choiceHold = 0;
  partyIndex = 0;
  partyForced = false;
  itemIndex = 0;
  itemList = [];
  participants = new Set;
  leveledUp = new Set;
  constructor(data, save, rng, species, level) {
    this.data = data;
    this.save = save;
    this.rng = rng;
    this.chart = createTypeChart(data.type_chart);
    const playerMon = firstHealthy(save.party);
    if (!playerMon) {
      this.dead = true;
    } else {
      this.player = makeBattler(data, playerMon, true, save);
    }
    this.enemy = makeBattler(data, newMon(data, species, level, rng), false);
    if (this.dead) {
      this.player = this.enemy;
    }
  }
  makeOldManDemo(name, failThrow) {
    this.demo = true;
    this.demoName = name ?? "OLD MAN";
    this.demoFails = !!failThrow;
    this.oakDemo = name === "PROF.OAK";
    if (this.dead || !this.player) {
      this.dead = false;
      this.player = makeBattler(this.data, newMon(this.data, this.enemy.mon.species, 5, this.rng), true, this.save);
    }
  }
  oldManThrow() {
    this.phase = "messages";
    this.afterQueue = "finish";
    this.result = "run";
    this.sayAuto(`${this.demoName} used
POKé BALL!`);
    this.act(() => {
      this.insertNext({ wait: 20 });
      this.ballChain(true, 3, "POKE_BALL");
      this.sayNext(`All right!
${this.enemy.name} was
caught!`);
    });
  }
  say(text) {
    this.queue.push({ text });
  }
  sayAuto(text, delay = 0) {
    this.queue.push({ text, auto: true, autoDelay: delay });
  }
  sayChoice(text, onChoose) {
    this.queue.push({ text, choice: onChoose });
  }
  act(fn) {
    this.queue.push({ fn });
  }
  insertNext(row) {
    this.nextInsert += 1;
    this.queue.splice(this.nextInsert - 1, 0, row);
  }
  animNext(name, isPlayer, shakes, ball) {
    this.insertNext({ anim: name, attackerIsPlayer: isPlayer, shakes, ball });
  }
  actNext(fn) {
    this.insertNext({ fn });
  }
  sayNext(text) {
    this.insertNext({ text });
  }
  sayNextAuto(text, delay = 0) {
    this.insertNext({ text, auto: true, autoDelay: delay });
  }
  statBoxNext(mon) {
    this.insertNext({ statBox: mon });
  }
  drainNext(battler, stopAt) {
    this.insertNext({ drain: true, battler, stopAt });
  }
  waitNext(frames) {
    if (!frames || frames <= 0)
      return;
    this.insertNext({ wait: frames });
  }
  insertHitRow(anim, isPlayer) {
    const row = anim ? { anim, attackerIsPlayer: isPlayer } : { hitRow: true, attackerIsPlayer: isPlayer };
    this.insertNext(row);
    return row;
  }
  cancelMoveAnim() {
    const row = this.moveAnimRow;
    if (!row)
      return;
    this.moveAnimRow = null;
    const i = this.queue.indexOf(row);
    if (i >= 0) {
      this.queue.splice(i, 1);
      if (i < this.nextInsert)
        this.nextInsert -= 1;
    }
  }
  stepHPDrain() {
    let busy = false;
    for (const b of [this.player, this.enemy]) {
      if (!b)
        continue;
      let goal = b.mon.hp;
      if (b.drainFloor !== undefined && b.drainFloor > goal && b.shownHP >= b.drainFloor) {
        goal = b.drainFloor;
      }
      if ((b.drainHold ?? 0) > 0) {
        b.drainHold = (b.drainHold ?? 0) - 1;
        busy = true;
      } else if (b.shownHP !== goal) {
        const maxHP = Math.max(1, b.mon.stats.hp);
        const playerSide = b === this.player;
        let cost = 0;
        while (b.shownHP !== goal && cost < 1) {
          const nextHP = b.shownHP + (b.shownHP > goal ? -1 : 1);
          cost += hpDrainStepFrames(b.shownHP, nextHP, maxHP, playerSide);
          b.shownHP = nextHP;
        }
        b.drainHold = Math.max(0, cost - 1);
        b.draining = true;
        busy = true;
      } else if (b.draining) {
        b.draining = undefined;
        b.drainHold = hpDrainClosingFrames(b === this.player) - 1;
        busy = true;
      }
    }
    return busy;
  }
  startMessage(item) {
    this.current = item;
    this.lines = [];
    const text = item.text ?? "";
    this.messageLog.push(text);
    let pos = 0;
    let cont = false;
    for (;; ) {
      const npos = text.slice(pos).search(/[\n\v]/);
      const chunk = npos < 0 ? text.slice(pos) : text.slice(pos, pos + npos);
      this.lines.push({ text: chunk, codes: encodeGlyphs(chunk), cont });
      if (npos < 0)
        break;
      cont = text[pos + npos] === "\v";
      pos += npos + 1;
    }
    this.shown = [];
    this.lineIndex = 0;
    this.msgWaiting = false;
    this.msgPrompt = false;
    this.msgAutoWait = null;
    this.msgHold = false;
    this.beginMsgLine();
  }
  beginMsgLine() {
    this.lineIndex += 1;
    const ln = this.lines[this.lineIndex - 1];
    this.codes = ln ? ln.codes : [];
    if (this.shown.length >= 2) {
      this.shown.shift();
    }
    this.shown.push({ text: ln ? ln.text : "", codes: this.codes, revealed: 0 });
  }
  updateQueue(input) {
    if (this.statBoxMon) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.statBoxMon = null;
      }
      return true;
    }
    if (this.waitFrames > 0) {
      this.waitFrames -= 1;
      return true;
    }
    if (this.draining) {
      if (this.stepHPDrain())
        return true;
      this.draining = false;
      if (this.player)
        this.player.drainFloor = undefined;
      if (this.enemy)
        this.enemy.drainFloor = undefined;
    }
    if (!this.current) {
      const item = this.queue.shift();
      if (!item)
        return false;
      if (item.fn) {
        this.nextInsert = 0;
        item.fn();
        this.current = null;
        return true;
      }
      if (item.statBox) {
        this.statBoxMon = item.statBox;
        return true;
      }
      if (item.drain) {
        this.draining = true;
        if (item.battler)
          item.battler.drainFloor = item.stopAt;
        return true;
      }
      if (item.wait !== undefined) {
        this.waitFrames = item.wait;
        return true;
      }
      if (item.anim !== undefined || item.hitRow) {
        if (item.anim === "HIDEPIC_ANIM")
          this.enemyHidden = true;
        else if (item.anim === "SHOWPIC_ANIM")
          this.enemyHidden = false;
        if (item.anim && !item.animDelayed) {
          item.animDelayed = true;
          this.queue.unshift(item);
          this.waitFrames = MOVE_ANIM_PRE;
          return true;
        }
        const engineRow = item.anim === "HIDEPIC_ANIM" || item.anim === "SHOWPIC_ANIM";
        if (!engineRow && item.attackerIsPlayer !== undefined) {
          const attacker = item.attackerIsPlayer ? SIDE_PLAYER : SIDE_ENEMY;
          const defender = item.attackerIsPlayer ? SIDE_ENEMY : SIDE_PLAYER;
          let hold = this.startAnim("lunge", attacker);
          if (item.hit)
            hold = Math.max(hold, this.startAnim("hit", defender));
          const hs = typeof item.hit === "object" ? item.hit?.sfx : null;
          if (hs?.sound)
            this.audioCues.push(`move:${hs.sound}:${hs.pitch}:0`);
          const played = this.startMoveAnim(item.anim, item.attackerIsPlayer, defender, item);
          hold = Math.max(hold, played);
          this.waitFrames = hold;
        }
        this.current = null;
        return true;
      }
      this.startMessage(item);
    }
    if (this.msgWaiting) {
      if (this.msgPreWait > 0) {
        this.msgPreWait -= 1;
        return true;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.msgWaiting = false;
        this.beginMsgLine();
        this.waitFrames = TEXT_SCROLL_PAIR;
      }
      return true;
    }
    const cur = this.shown[this.shown.length - 1];
    if (cur.revealed < this.codes.length) {
      let delay = 3;
      if (input.isDown("a") || input.isDown("b"))
        delay = 1;
      this.charTimer += 1;
      while (this.charTimer >= delay && cur.revealed < this.codes.length) {
        this.charTimer -= delay;
        cur.revealed += 1;
      }
    } else if (this.lineIndex < this.lines.length) {
      if (this.lines[this.lineIndex].cont) {
        this.msgWaiting = true;
        this.msgPreWait = TEXT_PRE_ADVANCE;
      } else {
        this.beginMsgLine();
      }
    } else {
      const item = this.current;
      if (item?.choice && !item.choiceOpen) {
        item.choiceOpen = true;
        this.choiceOpen = true;
        this.choiceYes = true;
        return true;
      }
      if (item?.choice && this.choiceOpen) {
        if (this.choicePending !== null) {
          this.choiceHold -= 1;
          if (this.choiceHold <= 0) {
            const answer = this.choicePending;
            const fn = item.choice;
            this.choicePending = null;
            this.choiceOpen = false;
            this.current = null;
            fn(answer);
          }
          return true;
        }
        if (input.wasPressed("up") || input.wasPressed("down")) {
          this.choiceYes = !this.choiceYes;
        } else if (input.wasPressed("a")) {
          this.audioCues.push("sfx:Press_AB");
          this.choicePending = this.choiceYes;
          this.choiceHold = YES_NO_ANSWER;
        } else if (input.wasPressed("b")) {
          this.audioCues.push("sfx:Press_AB");
          this.choiceYes = false;
          this.choicePending = false;
          this.choiceHold = YES_NO_ANSWER;
        }
        return true;
      }
      if (item?.auto) {
        this.msgAutoWait = this.msgAutoWait ?? item.autoDelay ?? 0;
        if (this.msgAutoWait > 0) {
          this.msgAutoWait -= 1;
        } else {
          this.msgAutoWait = null;
          this.msgHold = true;
          this.current = null;
        }
      } else {
        if (!this.msgPrompt) {
          this.msgPrompt = true;
          this.msgPromptWait = TEXT_PRE_ADVANCE;
        }
        if (this.msgPromptWait > 0) {
          this.msgPromptWait -= 1;
        } else if (input.wasPressed("a") || input.wasPressed("b")) {
          this.msgPrompt = false;
          this.current = null;
        }
      }
    }
    return true;
  }
  enter() {
    if (this.dead) {
      this.result = "lose";
      this.say(`${this.save.player.name} is out of
useable POKéMON!`);
      this.say(`${this.save.player.name} blacked
out!`);
      this.phase = "messages";
      this.afterQueue = "finish";
      return;
    }
    this.queue.push({ wait: BATTLE_SLIDE_IN_FRAMES });
    this.enemyIntro();
    this.act(() => {
      this.introBalls = false;
    });
    if (this.sendsPlayerMon()) {
      this.queue.push({ wait: BATTLE_START_SENDOUT });
      this.queue.push({ wait: 18 });
      this.act(() => {
        this.showPlayerBack = false;
        this.sendingOut = true;
      });
      this.say(this.sendOutText(this.player.name));
      this.queue.push({ anim: "POOF_ANIM", attackerIsPlayer: false });
      this.act(() => {
        this.sendingOut = false;
      });
    }
    this.markParticipant();
    this.phase = "messages";
    this.afterQueue = "menu";
  }
  enemyIntro() {
    if (this.disguised) {
      this.say(`The GHOST
appeared!`);
      if (this.scopeReveal) {
        this.say(ghostText(this.data, "_UnveiledGhostText", `SILPH SCOPE
unveiled the
GHOST's identity!`));
        this.act(() => {
          this.disguised = false;
          this.enemy.name = this.ghostRealName;
          markSeen(this.save, this.enemy.mon.species);
          this.audioCues.push(`cry:${this.enemy.mon.species}`);
        });
        this.say(`Wild ${this.ghostRealName}
appeared!`);
      }
      return;
    }
    markSeen(this.save, this.enemy.mon.species);
    this.act(() => this.audioCues.push(`cry:${this.enemy.mon.species}`));
    if (this.hooked) {
      this.say(ghostText(this.data, "_HookedMonAttackedText", `The hooked
{RAM:wEnemyMonNick}
attacked!`).replace("{RAM:wEnemyMonNick}", this.enemy.name));
      return;
    }
    this.say(`Wild ${this.enemy.name}
appeared!`);
  }
  sendOutText(name) {
    const e = this.enemy.mon;
    let pct = 100;
    if (e.hp > 0 && Math.floor(e.stats.hp / 4) > 0) {
      pct = Math.floor(e.hp * 25 / Math.floor(e.stats.hp / 4));
    }
    if (pct >= 70)
      return `Go! ${name}!`;
    if (pct >= 40)
      return `Do it! ${name}!`;
    if (pct >= 10)
      return `Get'm! ${name}!`;
    return `The enemy's weak!
Get'm! ${name}!`;
  }
  markParticipant() {
    if (this.player?.mon)
      this.participants.add(this.player.mon);
  }
  musicKind() {
    return "wild";
  }
  victoryMusicKind() {
    return "wild";
  }
  animationsOn() {
    return this.save.options?.animations !== false;
  }
  safariMenu(_input) {
    return false;
  }
  sendsPlayerMon() {
    return !this.demo;
  }
  startAnim(kind, side) {
    if (kind !== "faint" && !this.animationsOn())
      return 0;
    const total = animFrames(kind);
    this.anims = this.anims.filter((a) => a.side !== side);
    this.anims.push({ kind, side, frame: 0, total });
    return total;
  }
  startMoveAnim(id, attackerIsPlayer, defender, opts) {
    this.moveAnim = null;
    this.moveAnimFrame = 0;
    if (!id || !this.animationsOn())
      return 0;
    const anim = new MoveAnim(this.data.battle_anims ?? null, id, attackerIsPlayer, {
      shakes: opts.shakes,
      ball: opts.ball
    });
    if (anim.frames <= 0)
      return 0;
    this.moveAnim = anim;
    this.moveAnimDefender = defender;
    return anim.frames;
  }
  animSprites() {
    return this.moveAnim ? this.moveAnim.spritesAt(this.moveAnimFrame) : [];
  }
  applyAnimEvent(e) {
    if (e.sound !== undefined && e.sound !== null) {
      const def = this.moveByIndex(e.sound);
      const a = def?.anim;
      if (a?.sound) {
        this.audioCues.push(`move:${a.sound}:${a.pitch ?? 0}:${a.tempo ?? 0}`);
      }
    }
    if (!e.effect)
      return;
    if (e.effect.includes("SHAKE") || e.effect.includes("FLASH_SCREEN")) {
      this.startAnim("hit", this.moveAnimDefender);
    }
  }
  moveByIndex(index) {
    if (!this.moveSfxIndex) {
      this.moveSfxIndex = new Map;
      for (const def of Object.values(this.data.moves ?? {})) {
        const d = def;
        if (typeof d.index === "number")
          this.moveSfxIndex.set(d.index, d);
      }
    }
    return this.moveSfxIndex.get(index);
  }
  update(input) {
    this.frame += 1;
    if (this.moveAnim) {
      const from = this.moveAnimFrame;
      this.moveAnimFrame += 1;
      for (const e of this.moveAnim.eventsIn(from, this.moveAnimFrame))
        this.applyAnimEvent(e);
      if (this.moveAnim.done(this.moveAnimFrame))
        this.moveAnim = null;
    }
    if (this.anims.length > 0) {
      for (const a of this.anims)
        a.frame += 1;
      this.anims = this.anims.filter((a) => a.frame < a.total);
    }
    if (this.phase === "menu") {
      for (const b of [this.player, this.enemy]) {
        if (!b)
          continue;
        b.shownHP = b.mon.hp;
        b.drainFloor = undefined;
        b.shownStatus = b.mon.status ?? null;
      }
    }
    if (this.phase === "messages") {
      if (!this.updateQueue(input)) {
        if (this.afterQueue === "menu") {
          this.phase = "menu";
        } else {
          this.finish();
        }
      }
      return;
    }
    if (this.phase === "menu") {
      if (this.safariMenu(input))
        return;
      if (this.demo) {
        this.demoTimer += 1;
        if (this.demoTimer > DEMO_MENU_HOLD) {
          this.demoTimer = 0;
          this.oldManThrow();
        }
        return;
      }
      if (this.player.mon.hp <= 0) {
        if (firstHealthy(this.save.party)) {
          this.openParty(true);
        }
        return;
      }
      this.clearTurnFlinches();
      const locked = this.menuLockedAction(this.player);
      if (locked) {
        this.resolveTurn(locked);
        return;
      }
      const col0 = (this.menuIndex - 1) % 2;
      const row0 = Math.floor((this.menuIndex - 1) / 2);
      let col = col0;
      let row = row0;
      if (input.wasPressed("left"))
        col = Math.max(0, col - 1);
      else if (input.wasPressed("right"))
        col = Math.min(1, col + 1);
      else if (input.wasPressed("up"))
        row = Math.max(0, row - 1);
      else if (input.wasPressed("down"))
        row = Math.min(1, row + 1);
      this.menuIndex = row * 2 + col + 1;
      if (input.wasPressed("a")) {
        const choice = ["fight", "pkmn", "item", "run"][this.menuIndex - 1];
        if (choice === "fight") {
          const fightLock = this.fightLockedAction(this.player);
          if (fightLock) {
            this.resolveTurn(fightLock);
            return;
          }
          if (!this.playerHasPP()) {
            this.say(`${this.player.name} has no
moves left!`);
            this.resolveTurn({ id: "STRUGGLE", pp: 1, struggle: true });
            return;
          }
          this.phase = "moveSelect";
          this.moveIndex = Math.min(this.moveIndex, this.player.curMoves.length);
          this.moveSwapIndex = null;
        } else if (choice === "run") {
          this.tryRun();
        } else if (choice === "item") {
          this.openItems();
        } else {
          this.openParty(false);
        }
      }
      return;
    }
    if (this.phase === "moveSelect") {
      const moves = this.player.curMoves;
      if (pressedDir(input)) {
        this.moveIndex = gridStep(input, this.moveIndex - 1, GEAR_GRID_COLS, moves.length) + 1;
      } else if (input.wasPressed("select")) {
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
        } else {
          this.moveSwapIndex = this.moveIndex;
        }
      } else if (input.wasPressed("b")) {
        this.moveSwapIndex = null;
        this.phase = "menu";
      } else if (input.wasPressed("a")) {
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
          return;
        }
        const mv = moves[this.moveIndex - 1];
        if (this.player.disabledSlot === this.moveIndex) {
          this.say(`The move is
disabled!`);
          this.phase = "messages";
          this.afterQueue = "menu";
        } else if (mv.pp <= 0) {
          this.say(`No PP left for
this move!`);
          this.phase = "messages";
          this.afterQueue = "menu";
        } else {
          this.resolveTurn(mv);
        }
      }
      return;
    }
    if (this.phase === "forget") {
      this.updateForget(input);
      return;
    }
    if (this.phase === "party") {
      this.updateParty(input);
      return;
    }
    if (this.phase === "item") {
      this.updateItems(input);
      return;
    }
  }
  clearTurnFlinches() {
    for (const b of [this.player, this.enemy]) {
      if (b && !(b.mustRecharge || b.rageMove))
        b.flinched = false;
    }
  }
  menuLockedAction(b) {
    if (b.mustRecharge)
      return { id: "", pp: 0, special: "recharge" };
    if (b.charging)
      return b.charging;
    if (b.thrashTurns !== undefined && b.thrashTurns > 0 && b.thrashMove)
      return b.thrashMove;
    if (b.rageMove)
      return b.rageMove;
    return null;
  }
  fightLockedAction(b) {
    if (b.trappingTurns !== undefined && b.trappingTurns > 0) {
      return { id: "", pp: 0, special: "trapping" };
    }
    if (b.bideTurns !== undefined)
      return { id: "", pp: 0, special: "bide" };
    const opp = b.isPlayer ? this.enemy : this.player;
    if (opp && opp.trappingTurns !== undefined)
      return { id: "", pp: 0, special: "bound" };
    return null;
  }
  lockedAction(b) {
    return this.menuLockedAction(b) ?? this.fightLockedAction(b);
  }
  playerHasPP() {
    return this.player.curMoves.some((mv, i) => mv.pp > 0 && this.player.disabledSlot !== i + 1);
  }
  swapMoves(i, j) {
    if (i === j)
      return;
    const moves = this.player.curMoves;
    const a = moves[i - 1];
    const b = moves[j - 1];
    if (!a || !b)
      return;
    moves[i - 1] = b;
    moves[j - 1] = a;
    if (this.player.disabledSlot === i)
      this.player.disabledSlot = j;
    else if (this.player.disabledSlot === j)
      this.player.disabledSlot = i;
  }
  enemyAction() {
    const locked = this.lockedAction(this.enemy);
    if (locked)
      return locked;
    const usable = [];
    this.enemy.curMoves.forEach((mv, i) => {
      if (this.enemy.disabledSlot !== i + 1 && (this.ruleset.enemyUnlimitedPP || mv.pp > 0)) {
        usable.push(mv);
      }
    });
    if (usable.length === 0)
      return { id: "STRUGGLE", pp: 1, struggle: true };
    return usable[randRange(this.rng, 1, usable.length) - 1];
  }
  resolveTurn(playerAction) {
    const enemyAction = this.enemyAction();
    this.turnCount += 1;
    const pMove = this.data.moves[playerAction.id] ?? null;
    const eMove = this.data.moves[enemyAction.id] ?? null;
    const pFirst = firstMover(this.player, pMove, this.enemy, eMove, this.rng);
    const order2 = pFirst ? [
      [this.player, this.enemy, playerAction],
      [this.enemy, this.player, enemyAction]
    ] : [
      [this.enemy, this.player, enemyAction],
      [this.player, this.enemy, playerAction]
    ];
    this.phase = "messages";
    this.afterQueue = "menu";
    for (const [user, target, action] of order2) {
      this.act(() => {
        this.executeAction(user, target, action);
      });
    }
    this.act(() => {
      this.endOfTurn();
    });
  }
  residualAfterMove() {
    return this.ruleset.residualAfterMove !== false;
  }
  residualFor(b, opp) {
    if (this.result)
      return;
    if (this.player !== b && this.enemy !== b)
      return;
    if (b.mon.hp <= 0 || opp.mon.hp <= 0)
      return;
    const msgs = residual(b, opp);
    for (const m of msgs)
      this.sayNext(prefixEnemy(m, b));
    if (b.leechSeeded && b.mon.hp > 0) {
      this.animNext("ABSORB", opp.isPlayer);
    }
    if (msgs.length > 0)
      this.drainNext();
    if (b.mon.hp <= 0)
      this.onFaint(b);
  }
  queueResidual(b, opp) {
    if (this.residualAfterMove()) {
      this.act(() => this.residualFor(b, opp));
    }
  }
  endOfTurn() {
    if (this.result)
      return;
    const sweep = !this.residualAfterMove();
    const playerAlive = this.player.mon.hp > 0;
    const enemyAlive = this.enemy.mon.hp > 0;
    const pairs = [
      [this.player, this.enemy, enemyAlive],
      [this.enemy, this.player, playerAlive]
    ];
    for (const [b, opp, oppAlive] of pairs) {
      if (sweep && b.mon.hp > 0 && oppAlive) {
        const msgs = residual(b, opp);
        for (const m of msgs)
          this.sayNext(prefixEnemy(m, b));
        if (msgs.length > 0)
          this.drainNext();
        if (b.mon.hp <= 0)
          this.onFaint(b);
      }
      b.skipMove = undefined;
      if (b.trappingTurns !== undefined && b.trappingTurns <= 0) {
        b.trappingTurns = undefined;
      }
    }
  }
  syncShownStatus() {
    for (const b of [this.player, this.enemy]) {
      if (b)
        b.shownStatus = b.mon.status ?? null;
    }
  }
  executeAction(user, target, action) {
    if (this.result)
      return;
    if (user.mon.hp <= 0 || target.mon.hp <= 0)
      return;
    if (!action)
      return;
    if (this.disguised && user === this.player) {
      this.sayAuto(ghostText(this.data, "_ScaredText", `{RAM:wBattleMonNick} is too
scared to move!`).replace("{RAM:wBattleMonNick}", user.name));
      return;
    }
    if (this.disguised && user === this.enemy) {
      this.sayAuto(ghostText(this.data, "_GetOutText", `GHOST: Get out...
Get out...`));
      return;
    }
    user.boundTurns = target.trappingTurns !== undefined ? Math.max(1, target.trappingTurns) : undefined;
    if (action.special === "recharge") {
      if (!this.preRechargeChecks(user, target)) {
        user.mustRecharge = undefined;
        this.sayNext(`${displayName(user)}
must recharge!`);
      }
    } else if (action.special === "bound") {
      if (target.trappingTurns !== undefined)
        this.statusInterrupt(user, target);
    } else if (action.special === "trapping") {
      if (!this.statusInterrupt(user, target))
        this.continueTrapping(user, target);
    } else if (action.special === "bide") {
      if (!this.statusInterrupt(user, target))
        this.continueBide(user, target);
    } else if (!this.statusInterrupt(user, target)) {
      this.performMove(user, target, action, false);
    }
    this.actNext(() => this.syncShownStatus());
    if (this.residualAfterMove()) {
      this.actNext(() => this.residualFor(user, target));
    }
  }
  statusInterrupt(user, target) {
    const res = beforeMove(user, this.rng);
    for (const m of res.messages)
      this.sayNext(prefixEnemy(m, user));
    if (res.selfHit) {
      const [dmg] = this.computeDamage(user, user, { id: "CONFUSED", power: 40, type: "NORMAL", accuracy: 100 }, { rng: this.rng, forceCrit: false, typeless: true, screens: target });
      this.sayNext(`It hurt itself in
its confusion!`);
      this.clearVolatiles(user, true);
      this.applyDamage(user, dmg);
      if (user.mon.hp <= 0)
        this.onFaint(user);
      return true;
    }
    if (!res.canMove) {
      const last = res.messages[res.messages.length - 1];
      if (user.mon.status === "PAR" && last && last.includes("fully paralyzed")) {
        this.clearVolatiles(user, false);
      }
      return true;
    }
    return false;
  }
  clearVolatiles(user, selfHit) {
    user.bideTurns = undefined;
    user.bideDamage = undefined;
    user.thrashTurns = undefined;
    user.thrashMove = undefined;
    user.thrashAnnounced = undefined;
    user.charging = undefined;
    user.chargeReady = undefined;
    user.trappingTurns = undefined;
    if (selfHit) {
      user.invulnerable = undefined;
      user.flinched = false;
    }
  }
  primaryEffectFailed(msgs) {
    if (!msgs || msgs.length === 0)
      return true;
    if (msgs.failed)
      return true;
    const m = msgs[0].replace(/\s+$/, "");
    if (m === "But, it failed!" || m === "Nothing happened!")
      return true;
    if (m.includes("didn't affect"))
      return true;
    if (m.includes("is unaffected"))
      return true;
    if (m.includes("protected by MIST"))
      return true;
    if (m.includes("Already"))
      return true;
    return false;
  }
  performMove(user, target, moveInst, isCalled) {
    const move = this.data.moves[moveInst.id];
    if (!move) {
      console.warn(`unknown move instance ${moveInst.id}`);
      return;
    }
    const record = effectRecord(move.effect);
    const releasing = user.charging === moveInst && user.chargeReady;
    if (releasing) {
      user.charging = undefined;
      user.chargeReady = undefined;
      user.invulnerable = undefined;
    }
    const isContinuation = releasing || user.thrashTurns !== undefined && user.thrashTurns > 0 && moveInst === user.thrashMove || moveInst === user.rageMove;
    const enemyUnlimited = !user.isPlayer && this.ruleset.enemyUnlimitedPP;
    if (!isContinuation && !moveInst.struggle && !isCalled && !enemyUnlimited) {
      moveInst.pp = Math.max(0, moveInst.pp - 1);
    }
    this.moveAnimRow = null;
    if (!(user.thrashTurns !== undefined && moveInst === user.thrashMove && user.thrashAnnounced)) {
      this.sayNextAuto(`${displayName(user)}
used ${move.name}!`);
      if (!(record && record.announceAnim === false)) {
        const row = { anim: move.id, attackerIsPlayer: user.isPlayer };
        this.insertNext(row);
        this.moveAnimRow = row;
      }
    }
    const ctx = makeCtx(this, user, target, move, moveInst, isCalled);
    if (record?.callsMove) {
      const pick = record.callsMove(ctx);
      if (move.id === "MIRROR_MOVE" || !pick)
        this.cancelMoveAnim();
      if (pick)
        this.performMove(user, target, { id: pick, pp: 1 }, true);
      return;
    }
    user.lastMove = move.id;
    if (record?.charge && !releasing) {
      this.cancelMoveAnim();
      user.charging = moveInst;
      user.chargeReady = true;
      if (record.charge.invulnerable || move.id === "DIG")
        user.invulnerable = true;
      let chargeAnim = record.charge.anim;
      if (move.id === "DIG")
        chargeAnim = "SLIDE_DOWN_ANIM";
      else if (record.charge.enemyAnim && !user.isPlayer)
        chargeAnim = record.charge.enemyAnim;
      if (chargeAnim)
        this.animNext(chargeAnim, user.isPlayer);
      const text = CHARGE_TEXT[move.id] ?? `%s
is charging up!`;
      this.sayNext(text.replace("%s", displayName(user)));
      return;
    }
    if (record?.perform) {
      record.perform(ctx);
      return;
    }
    if (move.power === 0 && record?.kind === "primary" && record.run) {
      if (record.accuracyChecked && (target.invulnerable || !this.accuracyRoll(move, user, target))) {
        this.cancelMoveAnim();
        this.sayNext(`${displayName(user)}'s
attack missed!`);
        return;
      }
      const msgs = record.run(ctx);
      if (this.primaryEffectFailed(msgs)) {
        this.cancelMoveAnim();
      } else if (SLOW_SHAKE_EFFECTS.has(move.effect) && this.moveAnimRow) {
        this.moveAnimRow.hit = { sfx: null, animType: user.isPlayer ? 6 : 3 };
      }
      for (const m of msgs)
        this.sayNext(m);
      this.drainNext();
      return;
    }
    if (move.power === 0 && record?.kind !== "full") {
      if (move.effect)
        warnUnknown(move.effect);
      this.cancelMoveAnim();
      this.sayNext("But, it failed!");
      return;
    }
    runDamaging(this, ctx, record);
  }
  preRechargeChecks(user, target) {
    if (user.skipMove) {
      user.skipMove = undefined;
      return true;
    }
    const mon = user.mon;
    if (mon.status === "SLP") {
      user.sleepTurns = (user.sleepTurns ?? 1) - 1;
      if (user.sleepTurns <= 0) {
        mon.status = null;
        this.sayNext(`${displayName(user)}
woke up!`);
      } else {
        this.sayNext(`${displayName(user)}
is fast asleep!`);
      }
      return true;
    }
    if (mon.status === "FRZ") {
      this.sayNext(`${displayName(user)}
is frozen solid!`);
      return true;
    }
    if (target.trappingTurns !== undefined) {
      this.sayNext(`${displayName(user)}
can't move!`);
      return true;
    }
    if (user.flinched) {
      user.flinched = false;
      this.sayNext(`${displayName(user)}
flinched!`);
      return true;
    }
    return false;
  }
  continueTrapping(user, target) {
    this.sayNext(`${displayName(user)}'s
attack continues!`);
    if (user.trapMove)
      this.animNext(user.trapMove, user.isPlayer);
    user.trappingTurns = (user.trappingTurns ?? 1) - 1;
    this.applyDamage(target, user.trapDamage ?? 1);
    if (target.mon.hp <= 0)
      this.onFaint(target);
  }
  continueBide(user, target) {
    user.bideTurns = (user.bideTurns ?? 1) - 1;
    if (user.bideTurns > 0) {
      this.sayNext(`${displayName(user)}
is storing energy!`);
      return;
    }
    this.sayNext(`${displayName(user)}
unleashed energy!`);
    const dmg = (user.bideDamage ?? 0) * 2;
    user.bideTurns = undefined;
    user.bideDamage = undefined;
    if (dmg <= 0) {
      this.sayNext("But, it failed!");
      return;
    }
    this.animNext("BIDE", user.isPlayer);
    this.applyDamage(target, dmg);
    if (target.mon.hp <= 0)
      this.onFaint(target);
  }
  selfDestruct(user) {
    user.mon.hp = 0;
    this.onFaint(user);
  }
  payDay = 0;
  get trainerBattle() {
    return this.isTrainer === true;
  }
  escape() {
    this.result = "run";
    this.afterQueue = "finish";
  }
  accuracyRoll(move, user, target) {
    return accuracyRoll(this.ruleset, move, user, target, this.rng);
  }
  computeDamage(user, target, move, opts) {
    return compute(this.ruleset, this.chart, user, target, move, opts);
  }
  inflictStatus(target, status, opts) {
    return inflictStatus(this, target, status, opts);
  }
  applyDamage(target, dmg) {
    if (target.substituteHP !== undefined) {
      target.substituteHP -= dmg;
      if (target.substituteHP <= 0) {
        target.substituteHP = undefined;
        this.sayNext(`${displayName(target)}'s
SUBSTITUTE broke!`);
      } else {
        this.sayNext(`The SUBSTITUTE
took damage for
${displayName(target)}!`);
      }
      return dmg;
    }
    const dealt = Math.min(dmg, target.mon.hp);
    target.mon.hp -= dealt;
    if (dealt > 0)
      this.drainNext(target, target.mon.hp);
    if (target.bideTurns !== undefined) {
      target.bideDamage = (target.bideDamage ?? 0) + dealt;
    }
    if (target.rageMove && dealt > 0) {
      target.stages.attack = Math.min(6, (target.stages.attack ?? 0) + 1);
      this.sayNext(`${displayName(target)}'s
RAGE is building!`);
    }
    return dealt;
  }
  onFaint(battler) {
    if (battler.faintQueued)
      return;
    battler.faintQueued = true;
    if (battler.isPlayer) {
      this.participants.delete(battler.mon);
    }
    this.actNext(() => {
      battler.fainted = true;
      this.startAnim("faint", battler.isPlayer ? SIDE_PLAYER : SIDE_ENEMY);
    });
    this.insertNext({ wait: FAINT_SLIDE });
    if (!battler.isPlayer) {
      const kind = this.victoryMusicKind();
      if (kind)
        this.actNext(() => this.audioCues.push(`music:victory:${kind}`));
    }
    this.sayNext(`${displayName(battler)}
fainted!`);
    if (battler.isPlayer) {
      this.act(() => this.playerMonFainted());
    } else {
      this.act(() => this.enemyMonFainted());
    }
  }
  awardExp() {
    let participants = 0;
    const alive = [];
    for (const mon of this.save.party) {
      if (this.participants.has(mon)) {
        participants += 1;
        if (mon.hp > 0)
          alive.push(mon);
      }
    }
    if (participants === 0 && this.player.mon.hp > 0) {
      participants = 1;
      alive.length = 0;
      alive.push(this.player.mon);
    }
    const applyShare = (mon, split, announce) => {
      const [levels, gained] = apply(this.data, mon, this.enemy.def, this.enemy.mon.level, false, split, mon.traded);
      if (levels.length > 0)
        this.leveledUp.add(mon);
      const name = mon.nickname ?? this.data.pokemon[mon.species].name;
      if (announce === "expAll") {
        this.sayNext(`${name} gained
with EXP.ALL,\v${gained} EXP. Points!`);
      } else if (mon.traded) {
        this.sayNext(`${name} gained
a boosted\v${gained} EXP. Points!`);
      } else {
        this.sayNext(`${name} gained
${gained} EXP. Points!`);
      }
      for (const lv of levels) {
        this.sayNext(`${name} grew
to level ${lv}!`);
        this.statBoxNext(mon);
        if (mon === this.player.mon)
          this.drainNext();
        for (const moveId of movesLearnedAt(this.data.pokemon[mon.species], lv)) {
          this.learnMove(mon, moveId);
        }
      }
    };
    const expAll = (this.save.inventory.EXP_ALL ?? 0) > 0;
    for (const mon of alive) {
      applyShare(mon, participants * (expAll ? 2 : 1), true);
    }
    if (expAll) {
      for (const mon of this.save.party) {
        if (mon.hp > 0) {
          applyShare(mon, Math.max(1, participants) * this.save.party.length * 2, "expAll");
        }
      }
    }
    this.participants = new Set;
  }
  learnMove(mon, moveId) {
    const mdef = this.data.moves[moveId];
    if (!mdef)
      return;
    if (mon.moves.some((mv) => mv.id === moveId))
      return;
    const name = mon.nickname ?? this.data.pokemon[mon.species].name;
    if (mon.moves.length < 4) {
      mon.moves.push({ id: moveId, pp: mdef.pp });
      this.sayNext(`${name} learned
${mdef.name}!`);
      return;
    }
    this.sayNext(`${name} is trying to
learn ${mdef.name}!`);
    this.sayNext(`But ${name} can't
learn more than\f4 moves!`);
    this.actNext(() => {
      this.learnPending = { mon, moveId };
      this.forgetIndex = 0;
      this.phase = "forget";
    });
  }
  forgetView() {
    const p = this.learnPending;
    if (this.phase !== "forget" || !p)
      return null;
    return {
      name: p.mon.nickname ?? this.data.pokemon[p.mon.species].name,
      moves: p.mon.moves.map((mv) => this.data.moves[mv.id]?.name ?? mv.id),
      index: this.forgetIndex,
      learning: this.data.moves[p.moveId]?.name ?? p.moveId
    };
  }
  updateForget(input) {
    const p = this.learnPending;
    if (!p) {
      this.phase = "messages";
      return;
    }
    const rows = p.mon.moves.length + 1;
    const step = listStep(input);
    if (step) {
      this.forgetIndex = (this.forgetIndex + step + rows) % rows;
      return;
    }
    const name = p.mon.nickname ?? this.data.pokemon[p.mon.species].name;
    const learning = this.data.moves[p.moveId]?.name ?? p.moveId;
    const decline = () => {
      this.learnPending = null;
      this.say(`${name} did not learn
${learning}!`);
      this.phase = "messages";
    };
    if (input.wasPressed("b") || input.wasPressed("a") && this.forgetIndex >= rows - 1) {
      decline();
      return;
    }
    if (!input.wasPressed("a"))
      return;
    const slot = p.mon.moves[this.forgetIndex];
    if (!slot) {
      decline();
      return;
    }
    if (this.hmMoves().has(slot.id)) {
      this.say(`HM moves can't be
forgotten now!`);
      this.phase = "messages";
      return;
    }
    const forgotten = this.data.moves[slot.id]?.name ?? slot.id;
    const mdef = this.data.moves[p.moveId];
    p.mon.moves[this.forgetIndex] = { id: p.moveId, pp: mdef?.pp ?? 0 };
    this.learnPending = null;
    this.say(`1, 2 and... Poof!\f${name} forgot
${forgotten}!\fAnd...`);
    this.sayNext(`${name} learned
${learning}!`);
    this.phase = "messages";
  }
  hmMoves() {
    if (!this.hmCache) {
      this.hmCache = new Set;
      for (const it of Object.values(this.data.items ?? {})) {
        const m = it.machine;
        if (m?.kind === "HM" && m.move)
          this.hmCache.add(m.move);
      }
    }
    return this.hmCache;
  }
  swapEnemy(mon) {
    this.enemy = makeBattler(this.data, mon, false);
    this.player.trappingTurns = undefined;
    this.player.trapMove = undefined;
    this.player.trapDamage = undefined;
  }
  enemyMonFainted() {
    this.awardExp();
    this.result = "win";
    this.afterQueue = "finish";
  }
  playerMonFainted() {
    const nextMon = firstHealthy(this.save.party);
    if (!nextMon && this.result !== "lose") {
      this.blackedOut = true;
      this.sayNext(`${this.save.player.name} is out of
useable POKéMON!`);
      this.sayNext(`${this.save.player.name} blacked
out!`);
      this.result = "lose";
      this.afterQueue = "finish";
      return;
    }
    if (this.result)
      return;
    this.sayChoice("Use next POKéMON?", (yes) => {
      if (yes)
        return;
      const pSpd = this.save.party[0]?.stats.speed ?? 0;
      if (this.runRoll(pSpd, effectiveSpeed(this.enemy))) {
        this.say("Got away safely!");
        this.result = "run";
        this.afterQueue = "finish";
      } else {
        this.say("Can't escape!");
      }
    });
  }
  runRoll(pSpd, eSpd) {
    this.runAttempts += 1;
    if (pSpd >= eSpd)
      return true;
    const b = Math.floor(eSpd / 4) % 256;
    if (b === 0)
      return true;
    let x = Math.floor(pSpd * 32 / b);
    x += 30 * (this.runAttempts - 1);
    return x >= 256 || this.rng.byte() <= x;
  }
  tryRun() {
    this.phase = "messages";
    this.afterQueue = "menu";
    const escaped = this.runRoll(effectiveSpeed(this.player), effectiveSpeed(this.enemy));
    if (escaped) {
      this.say("Got away safely!");
      this.result = "run";
      this.afterQueue = "finish";
    } else {
      this.say("Can't escape!");
      this.act(() => {
        this.executeAction(this.enemy, this.player, this.enemyAction());
      });
      this.queueResidual(this.player, this.enemy);
      this.act(() => this.endOfTurn());
    }
  }
  isTrainerBattle() {
    return false;
  }
  itemBattle() {
    return {
      kind: this.isTrainerBattle() ? "trainer" : "wild",
      player: this.player,
      enemy: this.enemy
    };
  }
  itemTarget = null;
  openItems() {
    this.itemList = order(this.save).filter((id) => (this.save.inventory[id] ?? 0) > 0);
    if (this.itemList.length === 0) {
      this.say(`There are no
items to use!`);
      this.phase = "messages";
      this.afterQueue = "menu";
      return;
    }
    this.itemIndex = Math.min(this.itemIndex, this.itemList.length - 1);
    this.phase = "item";
  }
  updateItems(input) {
    const step = listStep(input);
    if (step) {
      this.itemIndex = Math.max(0, Math.min(this.itemList.length - 1, this.itemIndex + step));
    } else if (input.wasPressed("b")) {
      this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const id = this.itemList[this.itemIndex];
      if (isBall(id)) {
        this.save.inventory[id] = (this.save.inventory[id] ?? 1) - 1;
        if (this.save.inventory[id] <= 0)
          delete this.save.inventory[id];
        this.phase = "messages";
        this.afterQueue = "menu";
        this.throwBall(id);
        return;
      }
      if (needsTarget(this.data, id) && !refusedInBattle(this.data, id)) {
        this.itemTarget = id;
        this.partyForced = false;
        this.partyIndex = 0;
        this.phase = "party";
        return;
      }
      this.useBattleItem(id, this.player.mon);
    }
  }
  useBattleItem(id, mon) {
    const moveIndex = needsMove(id) ? Math.max(0, mon.moves.findIndex((mv) => {
      const cap = maxPP(this.data, mv);
      return cap !== null && mv.pp < cap;
    })) : undefined;
    const r = useItem(this.data, this.save, id, mon, this.itemBattle(), moveIndex);
    this.phase = "messages";
    this.afterQueue = "menu";
    if (r.kind === "failed") {
      for (const m of r.msgs)
        this.say(m);
      return;
    }
    remove(this.save, id, 1);
    for (const m of r.msgs)
      this.say(m);
    if (r.kind === "consumed_escape") {
      this.act(() => this.escape());
      return;
    }
    this.act(() => {
      this.executeAction(this.enemy, this.player, this.enemyAction());
    });
    this.queueResidual(this.player, this.enemy);
    this.act(() => this.endOfTurn());
  }
  ballMissMessage(shakes) {
    if (shakes === 0)
      return `You missed the
POKéMON!`;
    if (shakes === 1)
      return `Darn! The POKéMON
broke free!`;
    if (shakes === 2)
      return `Aww! It appeared
to be caught!`;
    return `Shoot! It was so
close too!`;
  }
  ballChain(caught, shakes, ball) {
    this.animNext("TOSS_ANIM", true, undefined, ball);
    this.animNext("POOF_ANIM", true);
    if (!caught && shakes === 0)
      return;
    this.animNext("HIDEPIC_ANIM", true);
    this.animNext("SHAKE_ANIM", true, shakes);
    if (!caught) {
      this.animNext("POOF_ANIM", true);
      this.animNext("SHOWPIC_ANIM", true);
    }
  }
  throwBall(ball) {
    const itemName = this.data.items?.[ball]?.name ?? ball;
    this.sayAuto(`${this.save.player.name} used
${itemName}!`);
    if (this.isTrainerBattle()) {
      this.act(() => {
        this.lastBall = ball;
        this.animNext("TOSS_ANIM", true, undefined, ball);
        this.actNext(() => this.audioCues.push("sfx:Faint_Thud"));
        this.sayNext(ghostText(this.data, "_ThrowBallAtTrainerMonText1", `The trainer
blocked the BALL!`));
        this.sayNext(ghostText(this.data, "_ThrowBallAtTrainerMonText2", "Don't be a thief!"));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      });
      return;
    }
    if (this.noCatch) {
      this.act(() => {
        this.lastBall = ball;
        this.sayNext(ghostText(this.data, "_ItemUseBallText00", `It dodged the
thrown BALL!\fThis POKéMON
can't be caught!`));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      });
      return;
    }
    this.act(() => {
      this.lastBall = ball;
      const [caught, shakes] = attempt(ball, this.enemy.mon, this.enemy.def, this.rng);
      this.insertNext({ wait: 20 });
      this.ballChain(caught, shakes, ball);
      if (caught) {
        this.sayNext(`All right!
${this.enemy.name} was
caught!`);
        this.act(() => this.storeCaughtMon());
      } else {
        this.sayNext(this.ballMissMessage(shakes));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      }
    });
  }
  caughtNewSpecies = null;
  storeCaughtMon() {
    const species = this.enemy.mon.species;
    if (!this.save.pokedex?.owned?.[species])
      this.caughtNewSpecies = species;
    markOwned(this.save, species);
    if (!partyAdd(this.save.party, this.enemy.mon)) {
      const box = deposit(this.save, this.enemy.mon);
      if (box) {
        const met = this.save.flags?.EVENT_MET_BILL;
        const pc = met ? "BILL's PC" : "someone's PC";
        this.sayNext(`${this.enemy.name} was
transferred to
${pc}!`);
      } else {
        this.sayNext(`But every BOX
is full!`);
      }
    }
    this.result = "caught";
    this.afterQueue = "finish";
  }
  openParty(forced) {
    this.partyForced = forced;
    this.partyIndex = 0;
    this.phase = "party";
  }
  updateParty(input) {
    const party = this.save.party;
    if (pressedDir(input)) {
      this.partyIndex = gridStep(input, this.partyIndex, GEAR_GRID_COLS, party.length);
    } else if (input.wasPressed("b")) {
      if (this.itemTarget) {
        this.itemTarget = null;
        this.phase = "item";
        return;
      }
      if (!this.partyForced)
        this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const mon = party[this.partyIndex];
      if (!mon)
        return;
      if (this.itemTarget) {
        const id = this.itemTarget;
        this.itemTarget = null;
        this.useBattleItem(id, mon);
        return;
      }
      if (this.partyForced) {
        if (mon.hp <= 0) {
          this.say(`There's no will
to fight!`);
          this.phase = "messages";
          this.afterQueue = "menu";
          return;
        }
        this.replaceFainted(mon);
      } else if (mon === this.player.mon) {
        this.say(`${this.player.name} is
already out!`);
        this.phase = "messages";
        this.afterQueue = "menu";
      } else if (mon.hp <= 0) {
        this.say(`There's no will
to fight!`);
        this.phase = "messages";
        this.afterQueue = "menu";
      } else {
        this.resolveSwitch(mon);
      }
    }
  }
  replaceFainted(mon) {
    this.player = makeBattler(this.data, mon, true, this.save);
    this.markParticipant();
    this.sendOutMonCursors();
    this.nextInsert = 0;
    this.sendingOut = true;
    this.sayNext(this.sendOutText(this.player.name));
    this.animNext("POOF_ANIM", false);
    this.actNext(() => {
      this.sendingOut = false;
    });
    this.phase = "messages";
    this.afterQueue = "menu";
  }
  resolveSwitch(next) {
    this.phase = "messages";
    this.afterQueue = "menu";
    this.act(() => {
      this.player = makeBattler(this.data, next, true, this.save);
      this.enemy.trappingTurns = undefined;
      this.enemy.trapMove = undefined;
      this.enemy.trapDamage = undefined;
      this.markParticipant();
      this.sendOutMonCursors();
      this.sendingOut = true;
      this.sayNext(this.sendOutText(this.player.name));
      this.animNext("POOF_ANIM", false);
      this.actNext(() => {
        this.sendingOut = false;
      });
    });
    this.act(() => {
      this.executeAction(this.enemy, this.player, this.enemyAction());
    });
    this.act(() => this.endOfTurn());
  }
  sendOutMonCursors() {
    this.menuIndex = 1;
    this.moveIndex = 1;
  }
  finish() {
    if (this.payDay > 0 && this.result === "win") {
      const save = this.save;
      if (typeof save.money === "number")
        save.money += this.payDay;
      this.say(`${this.save.player.name} picked up
$${this.payDay}!`);
      this.payDay = 0;
      this.afterQueue = "finish";
      this.phase = "messages";
      return;
    }
    if (this.result !== "lose" && !firstHealthy(this.save.party)) {
      console.warn(`battle finished ${this.result} with no healthy party; forcing blackout`);
      this.result = "lose";
    }
    this.audioCues.push("music:restore");
    this.finished = this.result ?? "run";
  }
  shownHPInt(b) {
    const shown = b.shownHP ?? b.mon.hp;
    return shown > b.mon.hp ? Math.ceil(shown) : Math.floor(shown);
  }
}

// voxelmon/game/battle/trainer.ts
var GYM_LEADER_PARTY = {
  OPP_BROCK: 1,
  OPP_MISTY: 1,
  OPP_LT_SURGE: 1,
  OPP_ERIKA: 1,
  OPP_KOGA: 1,
  OPP_SABRINA: 1,
  OPP_BLAINE: 1,
  OPP_GIOVANNI: 3
};

class TrainerBattle extends WildBattle {
  isTrainerBattle() {
    return true;
  }
  isTrainer = true;
  trainerName;
  trainerId;
  partyIndex;
  enemyParty = [];
  enemyIndex = 0;
  baseMoney;
  constructor(data, save, rng, trainerId, partyIndex = 1, displayName2, monRoster) {
    const def = data.trainers[trainerId];
    const roster = def?.parties?.[partyIndex - 1] ?? def?.parties?.[0] ?? [];
    const lead = monRoster?.[0] ?? roster[0] ?? { species: "RATTATA", level: 2 };
    super(data, save, rng, lead.species, lead.level);
    this.trainerId = trainerId;
    this.partyIndex = partyIndex;
    this.trainerName = displayName2 ?? def?.name ?? trainerId;
    this.baseMoney = def?.baseMoney ?? 0;
    this.enemyParty = monRoster ? monRoster.map((m) => ({ ...m })) : roster.map((m) => newMon(data, m.species, m.level, rng));
    this.enemyIndex = 0;
    if (monRoster?.[0]) {
      this.enemy = makeBattler(data, this.enemyParty[0], false);
    }
  }
  musicKind() {
    if (this.trainerId === "OPP_RIVAL3")
      return "final";
    if (this.trainerId === "OPP_LANCE")
      return "gym";
    const gymParty = GYM_LEADER_PARTY[this.trainerId];
    if (gymParty !== undefined && gymParty === this.partyIndex)
      return "gym";
    return "trainer";
  }
  victoryMusicKind() {
    const more = this.enemyParty.some((m, i) => i > this.enemyIndex && m.hp > 0);
    if (more)
      return null;
    return this.musicKind() === "trainer" ? "trainer" : "gym";
  }
  enemyIntro() {
    this.act(() => this.audioCues.push("sfx:Trainer_Appeared"));
    this.queue.push({ wait: TRAINER_INTRO_SFX_GAP });
    this.say(`${this.trainerName} wants
to fight!`);
    markSeen(this.save, this.enemy.mon.species);
    this.act(() => this.audioCues.push(`cry:${this.enemy.mon.species}`));
    this.say(`${this.trainerName} sent
out ${this.enemy.name}!`);
  }
  runRoll(_playerSpeed, _enemySpeed) {
    this.say(`There's no escaping
a trainer battle!`);
    return false;
  }
  enemyMonFainted() {
    this.awardExp();
    const next = this.enemyParty.find((m, i) => i > this.enemyIndex && m.hp > 0);
    if (!next) {
      this.result = "win";
      this.afterQueue = "finish";
      const top = Math.max(...this.enemyParty.map((m) => m.level ?? 1));
      const money = this.baseMoney * top;
      if (money > 0) {
        const save = this.save;
        if (typeof save.money === "number")
          save.money += money;
        this.sayNext(`${this.trainerName} paid out
$${money}!`);
      }
      return;
    }
    this.enemyIndex = this.enemyParty.indexOf(next);
    markSeen(this.save, next.species);
    this.sayNext(`${this.trainerName} sent out
${next.species}!`);
    this.act(() => this.swapEnemy(next));
  }
}

// voxelmon/game/battle/safari.ts
class SafariBattle extends WildBattle {
  isSafari = true;
  safari;
  catchFactor;
  baitFactor = 0;
  escapeFactor = 0;
  outOfBalls = false;
  constructor(data, save, rng, species, level, safari) {
    super(data, save, rng, species, level);
    this.safari = safari;
    this.catchFactor = this.enemy.def.catchRate;
  }
  sendsPlayerMon() {
    return false;
  }
  safariMenu(input) {
    if (this.safari.balls <= 0) {
      this.safariOutOfBalls();
      return true;
    }
    let col = (this.menuIndex - 1) % 2;
    let row = Math.floor((this.menuIndex - 1) / 2);
    if (input.wasPressed("left"))
      col = Math.max(0, col - 1);
    else if (input.wasPressed("right"))
      col = Math.min(1, col + 1);
    else if (input.wasPressed("up"))
      row = Math.max(0, row - 1);
    else if (input.wasPressed("down"))
      row = Math.min(1, row + 1);
    this.menuIndex = row * 2 + col + 1;
    if (input.wasPressed("a")) {
      this.safariAction(["ball", "bait", "rock", "run"][this.menuIndex - 1]);
    }
    return true;
  }
  safariCatch() {
    return attempt("SAFARI_BALL", this.enemy.mon, this.enemy.def, this.rng, this.catchFactor, { statuses: this.data.statuses });
  }
  safariAction(choice) {
    this.phase = "messages";
    this.afterQueue = "menu";
    const name = this.save.player.name;
    if (choice === "run") {
      this.audioCues.push("sfx:Run");
      this.say("Got away safely!");
      this.result = "run";
      this.afterQueue = "finish";
      return;
    }
    if (choice === "ball") {
      this.safari.balls -= 1;
      this.sayAuto(`${name} used
SAFARI BALL!`);
      this.act(() => this.throwSafariBall());
      return;
    }
    if (choice === "bait") {
      this.say(`${name} threw
some BAIT.`);
      this.catchFactor = Math.floor(this.catchFactor / 2);
      this.baitFactor = Math.min(255, this.baitFactor + this.rollFactor());
      this.escapeFactor = 0;
    } else {
      this.say(`${name} threw a
ROCK.`);
      this.catchFactor = Math.min(255, this.catchFactor * 2);
      this.escapeFactor = Math.min(255, this.escapeFactor + this.rollFactor());
      this.baitFactor = 0;
    }
    this.act(() => this.safariEnemyTurn());
  }
  rollFactor() {
    return 1 + this.rng.byte() % 5;
  }
  throwSafariBall() {
    this.audioCues.push("sfx:Ball_Toss");
    const [caught, shakes] = this.safariCatch();
    this.ballChain(caught, shakes, "SAFARI_BALL");
    if (caught) {
      this.sayNext(`All right!
${this.enemy.name} was
caught!`);
      this.act(() => this.storeCaughtMon());
      return;
    }
    this.sayNext(this.ballMissMessage(shakes));
    this.act(() => this.safariEnemyTurn());
  }
  safariEnemyTurn() {
    if (this.baitFactor > 0) {
      this.baitFactor -= 1;
      this.sayNext(`Wild ${this.enemy.name}
is eating!`);
    } else if (this.escapeFactor > 0) {
      this.escapeFactor -= 1;
      if (this.escapeFactor === 0)
        this.catchFactor = this.enemy.def.catchRate;
      this.sayNext(`Wild ${this.enemy.name}
is angry!`);
    }
    this.act(() => this.fleeCheck());
  }
  fleeCheck() {
    const speed = this.enemy.mon.stats.speed % 256;
    let fled = speed > 127;
    if (!fled) {
      let b = speed * 2 % 256;
      if (this.baitFactor > 0)
        b = Math.floor(b / 4);
      if (this.escapeFactor > 0)
        b = Math.min(255, b * 2);
      fled = this.rng.byte() < b;
    }
    if (!fled)
      return;
    this.sayNext(`Wild ${this.enemy.name}
ran!`);
    this.audioCues.push("sfx:Run");
    this.result = "run";
    this.afterQueue = "finish";
  }
  safariOutOfBalls() {
    this.outOfBalls = true;
    this.say(`PA: You're out of
SAFARI BALLs!`);
    this.phase = "messages";
    this.result = "run";
    this.afterQueue = "finish";
  }
}

// voxelmon/game/battle/arena.ts
var SHAPES = [
  { id: ARENA_SHAPE.wide, w: 3, h: 6, enemy: [1, 1], player: [1, 4] },
  { id: ARENA_SHAPE.narrow, w: 1, h: 4, enemy: [0, 0], player: [0, 3] }
];
function openCell(map, cx, cy, surfing) {
  if (!map.inBounds(cx, cy))
    return false;
  if (map.warpAtCell(cx, cy))
    return false;
  if (map.isWarpTileCell(cx, cy))
    return false;
  if (map.isGrassCell(cx, cy))
    return false;
  if (map.isWalkableCell(cx, cy))
    return true;
  return surfing && map.isWaterCell(cx, cy);
}
function openGrid(map, surfing) {
  const w = map.widthCells;
  const h = map.heightCells;
  const grid = new Array(w * h);
  for (let cy = 0;cy < h; cy++) {
    const row = cy * w;
    for (let cx = 0;cx < w; cx++) {
      grid[row + cx] = openCell(map, cx, cy, surfing);
    }
  }
  return [grid, w, h];
}
function fits(grid, gw, x, y, w, h) {
  for (let cy = y;cy < y + h; cy++) {
    const row = cy * gw;
    for (let cx = x;cx < x + w; cx++) {
      if (!grid[row + cx])
        return false;
    }
  }
  return true;
}
function place(shape, x, y) {
  return {
    shape: shape.id,
    x,
    y,
    w: shape.w,
    h: shape.h,
    enemyCell: [x + shape.enemy[0], y + shape.enemy[1]],
    playerCell: [x + shape.player[0], y + shape.player[1]]
  };
}
function search(map, fromX, fromY, surfing) {
  const [grid, gw, gh] = openGrid(map, surfing);
  for (const shape of SHAPES) {
    let best = null;
    let bestD = Infinity;
    for (let y = 0;y <= gh - shape.h; y++) {
      for (let x = 0;x <= gw - shape.w; x++) {
        if (!fits(grid, gw, x, y, shape.w, shape.h))
          continue;
        const mx = x + (shape.w - 1) / 2;
        const my = y + (shape.h - 1) / 2;
        const dx = mx - fromX;
        const dy = my - fromY;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          best = place(shape, x, y);
          bestD = d;
        }
      }
    }
    if (best)
      return best;
  }
  return null;
}

// voxelmon/game/battle/staging.ts
function namedPage(data, which, key) {
  return atlasOf(data)?.[which]?.[key] ?? -1;
}
function atlasOf(data) {
  return data.atlas;
}
function picPageFor(data, speciesId) {
  return atlasOf(data)?.picFront?.[speciesId] ?? -1;
}
function orbitDir(arena, rig, q8) {
  const [ex, ey] = arena.enemyCell;
  const [px2, py] = arena.playerCell;
  const axis = Math.atan2(ex - px2, -(ey - py));
  const f = [Math.sin(axis), -Math.cos(axis)];
  const s = [-f[1], f[0]];
  const r = rig === 1 ? RIG.wide : RIG.tele;
  const base = [s[0] * r.side - f[0] * r.back, s[1] * r.side - f[1] * r.back];
  const ang = q8 / 256 * Math.PI * 2;
  const dir = [
    base[0] * Math.cos(ang) + base[1] * Math.sin(ang),
    -base[0] * Math.sin(ang) + base[1] * Math.cos(ang)
  ];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  return [dir[0] / len, dir[1] / len];
}
function chooseOrbit(map, arena, rig) {
  const [ex, ey] = arena.enemyCell;
  const [px2, py] = arena.playerCell;
  const mid = [(ex + px2) / 2, (ey + py) / 2];
  const blocked = (cx, cy) => {
    const x = Math.round(cx);
    const y = Math.round(cy);
    if (!map.inBounds(x, y))
      return false;
    return !map.isWalkableCell(x, y) && !map.isWaterCell(x, y);
  };
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let step = 0;step < ORBIT_STEPS; step++) {
    const q8 = Math.round(step * 256 / ORBIT_STEPS);
    const [ux, uy] = orbitDir(arena, rig, q8);
    let score = 0;
    for (let d = 1;d <= ORBIT_REACH_CELLS; d++) {
      const w = 1 + (ORBIT_REACH_CELLS - d) / ORBIT_REACH_CELLS;
      for (const side of [0, 1, -1]) {
        const cx = mid[0] + ux * d - uy * side;
        const cy = mid[1] + uy * d + ux * side;
        if (blocked(cx, cy))
          score += side === 0 ? w * 2 : w;
      }
    }
    const turn = Math.min(step, ORBIT_STEPS - step) / ORBIT_STEPS;
    score += turn * ORBIT_TURN_COST;
    if (score < bestScore) {
      bestScore = score;
      best = q8;
    }
  }
  return best;
}
var ORBIT_STEPS = 8;
var ORBIT_REACH_CELLS = 8;
var ORBIT_TURN_COST = 2;
function computeStaging(map, playerCellX, playerCellY, surfing) {
  const arena = search(map, playerCellX, playerCellY, surfing);
  if (!arena)
    return null;
  const indoor = map.def.tileset !== "OVERWORLD";
  const rig = indoor ? 1 : 0;
  return {
    mapIndex: map.def.index,
    arena,
    rig,
    orbit: chooseOrbit(map, arena, rig)
  };
}
function desiredCards(data, battle, staging) {
  const out = [];
  const [ex, ey] = staging.arena.enemyCell;
  const [px2, py] = staging.arena.playerCell;
  const anims = battle.anims;
  const fainting = (side) => anims.some((a) => a.side === side && a.kind === "faint");
  const [towardPlayerX, towardPlayerZ] = towardCell([ex, ey], [px2, py]);
  if (battle.enemy && (!battle.enemy.fainted || fainting(SIDE_ENEMY)) && !battle.enemyHidden && battle.result !== "caught") {
    const pic = picPageFor(data, battle.disguised ? "GHOST" : battle.enemy.mon.species);
    const fx = cardFx(anims, SIDE_ENEMY, towardPlayerX, towardPlayerZ);
    if (pic >= 0 && !fx.hidden) {
      out.push({ side: SIDE_ENEMY, pic, x: ex, y: ey, dx: fx.dx, dy: fx.dy, dz: fx.dz });
    }
  }
  if (battle.player && (!battle.player.fainted || fainting(SIDE_PLAYER)) && !battle.showPlayerBack && !battle.sendingOut) {
    const pic = picPageFor(data, battle.player.mon.species);
    const fx = cardFx(anims, SIDE_PLAYER, -towardPlayerX, -towardPlayerZ);
    if (pic >= 0 && !fx.hidden) {
      out.push({ side: SIDE_PLAYER, pic, x: px2, y: py, dx: fx.dx, dy: fx.dy, dz: fx.dz });
    }
  }
  return out;
}

// voxelmon/game/battle/ui.ts
var ENEMY_HUD_W = 10;
var ENEMY_HUD_H = 4;
var PLAYER_HUD_W = 10;
var PLAYER_HUD_H = 5;
var HUD_HP_LABEL = 113;
var HUD_BAR_LEFT = 98;
var HUD_BAR_EMPTY = 99;
var HUD_BAR_FULL = 107;
var HUD_CAP_NUB = 108;
var HUD_CAP_DOUBLE = 109;
var HUD_LV = 110;
var HUD_TICK = 115;
var HUD_EDGE_L = 116;
var HUD_LINE = 118;
var HUD_EDGE_DOWN = 119;
var HUD_EDGE_R = 120;
var HUD_HALF_ARROW = 111;
var HP_BAR_SEGMENTS = HP_BAR_PIXELS / 8;
function hpBarTiles(hp, maxHP, playerSide) {
  const px2 = hpBarPixels(hp, maxHP);
  const out = [HUD_HP_LABEL, HUD_BAR_LEFT];
  for (let i = 0;i < HP_BAR_SEGMENTS; i++) {
    const seg = Math.min(8, Math.max(0, px2 - i * 8));
    out.push(seg >= 8 ? HUD_BAR_FULL : HUD_BAR_EMPTY + seg);
  }
  out.push(playerSide ? HUD_CAP_DOUBLE : HUD_CAP_NUB);
  return out;
}
function nameTileX(tx, name) {
  const n = encodeGlyphs(name).length;
  return tx + (n <= 2 ? 2 : n <= 4 ? 1 : 0);
}
class BattleUi {
  mode = null;
  msgRows = [];
  msgVisible = false;
  arrowShown = false;
  enemyBar = null;
  playerBar = null;
  playerDigits = null;
  enemyLevel = null;
  playerLevel = null;
  cursorCell = null;
  swapCell = null;
  chromeTextDirty = false;
  emit(host, battle) {
    const enemyHud = this.enemyHudVisible(battle);
    const playerHud = this.playerHudVisible(battle);
    const mode = [
      battle.phase,
      enemyHud ? 1 : 0,
      playerHud ? 1 : 0,
      battle.statBoxMon ? 1 : 0,
      battle.phase === "party" ? battle.save.party.length : 0,
      battle.phase === "item" ? battle.itemList.length : 0
    ].join("|");
    this.chromeTextDirty = false;
    if (mode !== this.mode) {
      this.mode = mode;
      this.repaint(host, battle, enemyHud, playerHud);
    } else {
      this.deltas(host, battle, enemyHud, playerHud);
    }
    this.emitMessage(host, battle);
  }
  reset() {
    this.mode = null;
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;
  }
  enemyHudVisible(battle) {
    return !!battle.enemy && !battle.introBalls && !battle.enemy.fainted;
  }
  playerHudVisible(battle) {
    return !!battle.player && !battle.showPlayerBack && !battle.sendingOut;
  }
  box(host, x, y, w, h) {
    host.uiTile(x, y, BORDER_TL);
    host.uiFill(x + 1, y, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y, BORDER_TR);
    host.uiFill(x, y + 1, 1, h - 2, BORDER_V);
    host.uiFill(x + w - 1, y + 1, 1, h - 2, BORDER_V);
    host.uiTile(x, y + h - 1, BORDER_BL);
    host.uiFill(x + 1, y + h - 1, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y + h - 1, BORDER_BR);
    host.uiFill(x + 1, y + 1, w - 2, h - 2, SPACE);
  }
  text(host, x, y, s) {
    const glyphs = encodeGlyphs(s);
    for (let i = 0;i < glyphs.length; i++)
      host.uiTile(x + i, y, glyphs[i]);
    this.chromeTextDirty = true;
  }
  repaint(host, battle, enemyHud, playerHud) {
    host.uiClear();
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;
    const slide = !battle.statBoxMon;
    host.uiPanel(1, 0, 0, enemyHud && slide ? ENEMY_HUD_W : 0, ENEMY_HUD_H);
    host.uiPanel(0, 10, 7, playerHud && slide ? PLAYER_HUD_W : 0, PLAYER_HUD_H);
    if (enemyHud)
      this.paintEnemyHud(host, battle);
    if (playerHud)
      this.paintPlayerHud(host, battle);
    if (battle.statBoxMon) {
      this.box(host, 9, 2, 11, 10);
      const s = battle.statBoxMon.stats;
      const rows = [
        ["ATTACK", s.attack],
        ["DEFENSE", s.defense],
        ["SPEED", s.speed],
        ["SPECIAL", s.special]
      ];
      rows.forEach(([label, v], i) => {
        this.text(host, 11, 3 + i * 2, label);
        this.text(host, 16, 4 + i * 2, String(v).padStart(3));
      });
    }
  }
  paintEnemyHud(host, battle) {
    const e = battle.enemy;
    this.text(host, nameTileX(0, e.name), 0, e.name);
    this.paintLevelOrStatus(host, battle, e, 3, 1, false);
    host.uiTile(0, 2, HUD_TICK);
    this.paintBar(host, battle, e, 1, 2, false);
    host.uiTile(0, 3, HUD_EDGE_L);
    host.uiFill(1, 3, 8, 1, HUD_LINE);
    host.uiTile(9, 3, HUD_EDGE_R);
  }
  paintPlayerHud(host, battle) {
    const p = battle.player;
    this.text(host, nameTileX(10, p.name), 7, p.name);
    this.paintLevelOrStatus(host, battle, p, 15, 8, true);
    this.paintBar(host, battle, p, 11, 9, true);
    this.paintPlayerDigits(host, battle);
    host.uiTile(19, 10, HUD_TICK);
    host.uiTile(10, 11, HUD_HALF_ARROW);
    host.uiFill(11, 11, 8, 1, HUD_LINE);
    host.uiTile(19, 11, HUD_EDGE_DOWN);
  }
  paintLevelOrStatus(host, battle, b, lvX, y, player) {
    const label = b.shownStatus ? b.shownStatus : String(b.mon.level);
    if (b.shownStatus) {
      this.text(host, lvX + 1, y, label);
    } else {
      host.uiTile(lvX, y, HUD_LV);
      this.text(host, lvX + 1, y, label);
    }
    if (player)
      this.playerLevel = label;
    else
      this.enemyLevel = label;
  }
  paintBar(host, battle, b, tx, ty, player) {
    const tiles = hpBarTiles(battle.shownHPInt(b), b.mon.stats.hp, player);
    tiles.forEach((t, i) => host.uiTile(tx + i, ty, t));
    if (player)
      this.playerBar = tiles;
    else
      this.enemyBar = tiles;
  }
  paintPlayerDigits(host, battle) {
    const p = battle.player;
    const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
    this.text(host, 12, 10, digits);
    this.playerDigits = digits;
  }
  paintMenuCursor(host, battle) {
    const col = (battle.menuIndex - 1) % 2;
    const row = Math.floor((battle.menuIndex - 1) / 2);
    const cell = [col === 0 ? 9 : 15, 14 + row * 2];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }
  paintMoveCursor(host, battle) {
    const cell = [5, 12 + battle.moveIndex];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
    if (battle.moveSwapIndex !== null && battle.moveSwapIndex !== battle.moveIndex) {
      const swap = [5, 12 + battle.moveSwapIndex];
      host.uiTile(swap[0], swap[1], ARROW_HOLLOW);
      this.swapCell = swap;
    } else {
      this.swapCell = null;
    }
  }
  deltas(host, battle, enemyHud, playerHud) {
    if (enemyHud) {
      const e = battle.enemy;
      const bar = hpBarTiles(battle.shownHPInt(e), e.mon.stats.hp, false);
      if (this.enemyBar) {
        bar.forEach((t, i) => {
          if (this.enemyBar[i] !== t)
            host.uiTile(1 + i, 2, t);
        });
      }
      this.enemyBar = bar;
      const label = e.shownStatus ?? String(e.mon.level);
      if (label !== this.enemyLevel)
        this.paintLevelOrStatus(host, battle, e, 3, 1, false);
    }
    if (playerHud) {
      const p = battle.player;
      const bar = hpBarTiles(battle.shownHPInt(p), p.mon.stats.hp, true);
      if (this.playerBar) {
        bar.forEach((t, i) => {
          if (this.playerBar[i] !== t)
            host.uiTile(11 + i, 9, t);
        });
      }
      this.playerBar = bar;
      const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
      if (digits !== this.playerDigits)
        this.paintPlayerDigits(host, battle);
      const label = p.shownStatus ?? String(p.mon.level);
      if (label !== this.playerLevel)
        this.paintLevelOrStatus(host, battle, p, 15, 8, true);
    }
  }
  moveCursor(host, cell) {
    const old = this.cursorCell;
    if (old && old[0] === cell[0] && old[1] === cell[1])
      return;
    if (old)
      host.uiTile(old[0], old[1], SPACE);
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }
  emitMessage(host, battle) {
    return;
  }
}

// voxelmon/game/input.ts
var BUTTONS = Object.keys(VOX_BTN);

class Input {
  state = {};
  pressed = {};
  pressQueue = [];
  sources = {};
  lastMask = 0;
  reset() {
    this.state = {};
    this.pressed = {};
    this.pressQueue = [];
    this.sources = {};
    this.lastMask = 0;
  }
  sourcePress(btn, source) {
    let sources = this.sources[btn];
    if (!sources) {
      sources = new Set;
      this.sources[btn] = sources;
    }
    if (!sources.has(source)) {
      sources.add(source);
      this.pressQueue.push(btn);
    }
    this.state[btn] = true;
  }
  sourceRelease(btn, source) {
    const sources = this.sources[btn];
    if (sources) {
      sources.delete(source);
      if (sources.size === 0) {
        this.state[btn] = false;
      }
    } else {
      this.state[btn] = false;
    }
  }
  injectPress(btn) {
    this.pressQueue.push(btn);
  }
  setButtons(mask) {
    for (const btn of BUTTONS) {
      const bit = VOX_BTN[btn];
      const now = (mask & bit) !== 0;
      const was = (this.lastMask & bit) !== 0;
      if (now && !was)
        this.sourcePress(btn, "host");
      else if (!now && was)
        this.sourceRelease(btn, "host");
    }
    this.lastMask = mask;
  }
  step() {
    this.pressed = {};
    for (const btn of this.pressQueue) {
      this.pressed[btn] = true;
      const sources = this.sources[btn];
      if (sources === undefined) {
        this.state[btn] = true;
      } else if (sources.size > 0) {
        this.state[btn] = true;
      }
    }
    for (const btn of Object.keys(this.sources)) {
      if (this.sources[btn].size === 0) {
        delete this.sources[btn];
      }
    }
    this.pressQueue = [];
  }
  isDown(btn) {
    return this.state[btn] === true;
  }
  wasPressed(btn) {
    return this.pressed[btn] === true;
  }
}

// voxelmon/game/rules/evolution.ts
var METHODS = {
  LEVEL: {
    check: (mon, evo, trigger) => trigger.kind === "levelup" && mon.level >= (evo.level ?? 0)
  },
  ITEM: {
    check: (_mon, evo, trigger) => trigger.kind === "item" && trigger.item === evo.item,
    consumesItem: true
  },
  TRADE: {
    check: (_mon, _evo, trigger) => trigger.kind === "trade"
  }
};
function pendingFor(data, mon, trigger) {
  const trig = trigger ?? { kind: "manual" };
  const def = data.pokemon[mon.species];
  const methods = data.evolution_methods ?? METHODS;
  for (const evo of def.evolutions ?? []) {
    const method = methods[evo.method];
    if (method?.check && method.check(mon, evo, trig)) {
      return [evo.species, evo];
    }
  }
  return null;
}
function checkParty(data, party, leveledUp) {
  const pending = [];
  if (!leveledUp)
    return pending;
  for (const mon of party) {
    if (!leveledUp.has(mon))
      continue;
    const hit = pendingFor(data, mon, { kind: "levelup" });
    if (hit)
      pending.push({ mon, to: hit[0], evo: hit[1] });
  }
  return pending;
}
function apply2(data, mon, newSpecies, pokedex) {
  const newDef = data.pokemon[newSpecies];
  if (!newDef)
    throw new Error(`evolve into unknown species ${newSpecies}`);
  const hpLost = mon.stats.hp - mon.hp;
  mon.species = newSpecies;
  mon.stats = calc(newDef, mon.level, mon.dvs, mon.statExp);
  mon.hp = Math.max(1, mon.stats.hp - hpLost);
  if (pokedex) {
    pokedex.seen[newSpecies] = true;
    pokedex.owned[newSpecies] = true;
  }
}

// voxelmon/game/rules/badges.ts
var VANILLA = [
  { id: "BOULDERBADGE" },
  { id: "CASCADEBADGE" },
  { id: "THUNDERBADGE" },
  { id: "RAINBOWBADGE" },
  { id: "SOULBADGE" },
  { id: "MARSHBADGE" },
  { id: "VOLCANOBADGE" },
  { id: "EARTHBADGE" }
];
function list(data) {
  const configured = data?.constants?.badges;
  if (Array.isArray(configured) && configured.length > 0)
    return configured;
  return VANILLA;
}
function itemFor(entry) {
  return entry.item ?? entry.id;
}
function label(entry) {
  const name = entry.name ?? entry.id;
  return name.endsWith("BADGE") && name.length > 5 ? name.slice(0, -5) : name;
}
function count(data, save) {
  const inv = save?.inventory;
  if (!inv)
    return 0;
  let n = 0;
  for (const entry of list(data)) {
    if (inv[itemFor(entry)])
      n += 1;
  }
  return n;
}

// voxelmon/game/ui/trainercard.ts
var UI_SCALE = VIEW_H / GB_H;
var UI_ORIGIN_X = (VIEW_W - GB_W * UI_SCALE) / 2;
var UI_TILE_PX = TILE_PX * UI_SCALE;
var CARD_PIC_CELL = { x: 13, y: 1, w: 7, h: 7 };
function cellsToPicRect(c) {
  return {
    x: Math.round(UI_ORIGIN_X + c.x * UI_TILE_PX),
    y: Math.round(c.y * UI_TILE_PX),
    w: Math.round(c.w * UI_TILE_PX),
    h: Math.round(c.h * UI_TILE_PX)
  };
}
var CARD_PIC_RECT = cellsToPicRect(CARD_PIC_CELL);
function formatPlayTime(seconds) {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

class TrainerCardState {
  game;
  kind = "trainercard";
  constructor(game) {
    this.game = game;
  }
  update() {
    const p = this.game.input.pressed;
    if (p.a || p.b || p.start)
      this.game.pop();
  }
  view() {
    const save = this.game.save ?? {};
    const inv = save.inventory ?? {};
    return {
      name: String(save.player?.name ?? "RED"),
      money: Number(save.money ?? 0),
      time: formatPlayTime(Number(save.playTime ?? 0)),
      badges: list(this.game.data).map((entry, i) => ({
        n: i + 1,
        name: label(entry),
        owned: !!inv[itemFor(entry)]
      })),
      picPage: this.game.data?.atlas?.trainerCardPic ?? -1
    };
  }
}

// voxelmon/game/world/map.ts
var WATER_TILES = [20];
var SHORE_TILES = [50, 72];
var NO_SHORE_TILESETS = new Set(["SHIP_PORT"]);
var OUTSIDE_TILESETS = ["OVERWORLD", "PLATEAU"];
var WARP_PAD_TILES = {
  FACILITY: { 32: "pad", 17: "hole" },
  CAVERN: { 34: "hole" },
  INTERIOR: { 85: "pad" }
};
function walkableList(ts) {
  return Array.isArray(ts.walkable) ? ts.walkable : [];
}
function waterTileSet(def, ts, waterTilesets) {
  if (waterTilesets && !waterTilesets.includes(def.tileset))
    return new Set;
  const t = ts;
  const water = new Set(t.waterTiles ?? WATER_TILES);
  let shore = t.shoreTiles;
  if (shore === undefined && !NO_SHORE_TILESETS.has(def.tileset))
    shore = SHORE_TILES;
  for (const s of shore ?? [])
    water.add(s);
  return water;
}
function defCellTile(def, ts, cx, cy) {
  if (!def || !ts || !ts.blocks)
    return null;
  const tx = cx * 2;
  const ty = cy * 2 + 1;
  const bx = Math.floor(tx / 4);
  const by = Math.floor(ty / 4);
  let id;
  if (bx < 0 || by < 0 || bx >= def.width || by >= def.height) {
    id = def.borderBlock;
  } else {
    id = def.blocks[by * def.width + bx];
  }
  const block = ts.blocks[id ?? 0];
  if (!block)
    return null;
  return block[mod4(ty) * 4 + mod4(tx)];
}
function mod4(n) {
  return (n % 4 + 4) % 4;
}
function defIsWalkableCell(def, ts, cx, cy) {
  if (!ts || !ts.walkable)
    return false;
  const tile = defCellTile(def, ts, cx, cy);
  if (tile === null)
    return false;
  return walkableList(ts).includes(tile);
}
function defIsWaterCell(def, ts, cx, cy) {
  if (!def || !ts)
    return false;
  const tile = defCellTile(def, ts, cx, cy);
  if (tile === null)
    return false;
  return waterTileSet(def, ts).has(tile);
}
function defPassable(def, ts, cx, cy, surfing) {
  if (!def || !ts || !ts.blocks || !ts.walkable)
    return false;
  if (defIsWalkableCell(def, ts, cx, cy))
    return true;
  if (surfing && defIsWaterCell(def, ts, cx, cy))
    return true;
  return false;
}
function isOutdoor(def) {
  const d = def;
  if (d.outdoor !== undefined)
    return d.outdoor;
  return def.tileset === "OVERWORLD";
}
function isOutside(def, tilesets) {
  if (isOutdoor(def))
    return true;
  for (const ts of tilesets ?? OUTSIDE_TILESETS) {
    if (ts === def.tileset)
      return true;
  }
  return false;
}

class GameMap {
  def;
  tileset;
  id;
  widthCells;
  heightCells;
  walkable = new Set;
  doorTiles = new Set;
  warpTiles = new Set;
  waterTiles;
  warpAt = new Map;
  signAt = new Map;
  cuttableAt = new Set;
  cutAt = new Set;
  openAt = new Set;
  constructor(def, tilesetDef, waterTilesets) {
    this.def = def;
    this.tileset = tilesetDef;
    this.id = def.id;
    this.widthCells = def.width * 2;
    this.heightCells = def.height * 2;
    for (const t of walkableList(tilesetDef))
      this.walkable.add(t);
    for (const t of tilesetDef.doorTiles ?? [])
      this.doorTiles.add(t);
    for (const t of tilesetDef.warpTiles ?? [])
      this.warpTiles.add(t);
    this.waterTiles = waterTileSet(def, tilesetDef, waterTilesets);
    (def.warps ?? []).forEach((w, i) => {
      this.warpAt.set(w.y * this.widthCells + w.x, { index: i, def: w });
    });
    for (const s of def.signs ?? []) {
      this.signAt.set(s.y * this.widthCells + s.x, s);
    }
    for (const [cx, cy] of def.cuttableCells ?? []) {
      this.cuttableAt.add(cy * this.widthCells + cx);
    }
  }
  blockAt(bx, by) {
    if (bx < 0 || by < 0 || bx >= this.def.width || by >= this.def.height) {
      return this.def.borderBlock;
    }
    return this.def.blocks[by * this.def.width + bx];
  }
  tileAt(tx, ty) {
    const bx = Math.floor(tx / 4);
    const by = Math.floor(ty / 4);
    const block = this.tileset.blocks[this.blockAt(bx, by)];
    return block[mod4(ty) * 4 + mod4(tx)];
  }
  cellTile(cx, cy) {
    return this.tileAt(cx * 2, cy * 2 + 1);
  }
  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.widthCells && cy < this.heightCells;
  }
  isWalkableCell(cx, cy) {
    const i = cy * this.widthCells + cx;
    if (this.cutAt.has(i))
      return true;
    if (this.openAt.has(i))
      return true;
    return this.walkable.has(this.cellTile(cx, cy));
  }
  markCut(cx, cy) {
    this.cutAt.add(cy * this.widthCells + cx);
  }
  markOpen(cx, cy) {
    this.openAt.add(cy * this.widthCells + cx);
  }
  markShut(cx, cy) {
    this.openAt.delete(cy * this.widthCells + cx);
  }
  isOpenedDoor(cx, cy) {
    return this.openAt.has(cy * this.widthCells + cx);
  }
  isGrassCell(cx, cy) {
    if (!this.inBounds(cx, cy))
      return false;
    const grass = this.tileset.grassTile;
    return grass !== undefined && this.cellTile(cx, cy) === grass;
  }
  isWaterCell(cx, cy) {
    return this.waterTiles.has(this.cellTile(cx, cy));
  }
  isDoorTileCell(cx, cy) {
    return this.doorTiles.has(this.cellTile(cx, cy));
  }
  isWarpTileCell(cx, cy) {
    const t = this.cellTile(cx, cy);
    return this.doorTiles.has(t) || this.warpTiles.has(t);
  }
  warpPadOrHoleAt(cx, cy) {
    const t = this.tileset;
    const table = t.warpPadTiles ?? WARP_PAD_TILES[this.def.tileset];
    if (!table)
      return;
    return table[this.cellTile(cx, cy)];
  }
  isCounterCell(cx, cy) {
    const t = this.cellTile(cx, cy);
    return (this.tileset.counterTiles ?? []).includes(t);
  }
  warpAtCell(cx, cy) {
    return this.warpAt.get(cy * this.widthCells + cx);
  }
  signAtCell(cx, cy) {
    return this.signAt.get(cy * this.widthCells + cx);
  }
  isCuttableCell(cx, cy) {
    const i = cy * this.widthCells + cx;
    if (this.cutAt.has(i))
      return false;
    return this.cuttableAt.has(i);
  }
  connection(dir) {
    return this.def.connections?.[dir];
  }
}

// voxelmon/game/ui/partyscreen.ts
var SUMMARY_PIC_CELL = { x: 1, y: 0, w: 7, h: 7 };
function partyIconCell(i) {
  return { x: 1, y: i * 2, w: 2, h: 2 };
}
var FIELD_MOVES = ["CUT", "FLY", "SURF", "STRENGTH", "FLASH", "DIG", "TELEPORT", "SOFTBOILED"];

class PartyState {
  game;
  opts;
  kind = "party";
  index = 0;
  mode = "list";
  submenuIndex = 0;
  swapFrom = null;
  constructor(game, opts) {
    this.game = game;
    this.opts = opts;
  }
  prompt() {
    const t = this.game.data.text ?? {};
    if (this.swapFrom !== null)
      return t._PartyMenuSwapMonText ?? `Move POKéMON
where?`;
    if (this.opts?.prompt)
      return this.opts.prompt;
    if (this.opts?.onPick)
      return t._PartyMenuItemUseText ?? `Use item on which
POKéMON?`;
    return t._PartyMenuNormalText ?? "Choose a POKéMON.";
  }
  party() {
    return this.game.save.party ?? [];
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "submenu")
      return this.updateSubmenu(p);
    const n = Math.max(1, this.party().length);
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (p.b) {
      if (this.swapFrom !== null) {
        this.swapFrom = null;
        return;
      }
      this.game.pop();
      this.opts?.onCancel?.();
      return;
    }
    if (p.a && this.index < this.party().length) {
      const pick = this.opts?.onPick;
      if (pick) {
        this.game.pop();
        pick(this.index);
        return;
      }
      if (this.swapFrom !== null) {
        if (this.swapFrom !== this.index) {
          const party = this.party();
          const tmp = party[this.swapFrom];
          party[this.swapFrom] = party[this.index];
          party[this.index] = tmp;
        }
        this.swapFrom = null;
      } else {
        this.mode = "submenu";
        this.submenuIndex = 0;
      }
    }
  }
  submenuItems() {
    const mon = this.party()[this.index];
    const knows = (id) => mon?.moves?.some((m) => m.id === id) ?? false;
    const items = ["STATS", "SWITCH"];
    for (const id of FIELD_MOVES)
      if (knows(id) && this.fieldMoveOffered(id))
        items.push(id);
    items.push("CANCEL");
    return items;
  }
  fieldMoveOffered(id) {
    const map = this.game.overworld?.map;
    if (id === "TELEPORT")
      return !!map && isOutside(map.def);
    if (id === "DIG") {
      return !!map && ESCAPE_ROPE_TILESETS.has(map.def?.tileset ?? "") && map.id !== "AGATHAS_ROOM";
    }
    return true;
  }
  softboiled() {
    const party = this.party();
    const from = this.index;
    const user = party[from];
    if (!user)
      return;
    const share = Math.floor((user.stats?.hp ?? user.hp) / 5);
    if (user.hp < share || share <= 0) {
      this.game.showText?.("Not enough HP!");
      return;
    }
    this.game.push(new PartyState(this.game, {
      onPick: (i) => {
        const target = party[i];
        const max = target?.stats?.hp ?? target?.hp ?? 0;
        if (!target || i === from || target.hp <= 0 || target.hp >= max) {
          this.game.showText?.(`It won't have any
effect.`);
          return;
        }
        user.hp -= share;
        target.hp = Math.min(max, target.hp + share);
      },
      onCancel: () => {}
    }));
  }
  updateSubmenu(p) {
    const items = this.submenuItems();
    const n = items.length;
    if (p.up)
      this.submenuIndex = (this.submenuIndex + n - 1) % n;
    if (p.down)
      this.submenuIndex = (this.submenuIndex + 1) % n;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a)
      return;
    const label2 = items[this.submenuIndex];
    this.mode = "list";
    if (label2 === "STATS")
      this.game.push(new SummaryState(this.game, this.index));
    else if (label2 === "SWITCH")
      this.swapFrom = this.index;
    else if (FIELD_MOVES.includes(label2))
      this.useFieldMove(label2);
  }
  useFieldMove(moveId) {
    const mon = this.party()[this.index];
    const name = mon?.nickname ?? this.game.data.pokemon?.[mon?.species]?.name ?? mon?.species ?? "";
    if (moveId === "SOFTBOILED") {
      this.softboiled();
      return;
    }
    this.game.closeToOverworld();
    const verb = {
      CUT: "use_cut",
      FLY: "use_fly",
      SURF: "use_surf",
      STRENGTH: "use_strength",
      FLASH: "use_flash",
      DIG: "use_dig",
      TELEPORT: "use_teleport"
    }[moveId];
    this.game.overworld.runScript([[verb, name]]);
  }
  view() {
    const entries = this.party().map((m) => ({
      name: m.nickname ?? this.game.data.pokemon?.[m.species]?.name ?? m.species,
      species: m.species,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null
    }));
    return {
      entries,
      index: this.index,
      mode: this.mode,
      submenuIndex: this.submenuIndex,
      swapFrom: this.swapFrom,
      submenuItems: this.submenuItems(),
      prompt: this.prompt()
    };
  }
}

class SummaryState {
  game;
  slot;
  mon;
  kind = "summary";
  page = 1;
  constructor(game, slot, mon) {
    this.game = game;
    this.slot = slot;
    this.mon = mon;
  }
  update() {
    const p = this.game.input.pressed;
    if (p.b) {
      this.game.pop();
      return;
    }
    if (p.a) {
      if (this.page === 1)
        this.page = 2;
      else
        this.game.pop();
    }
  }
  view() {
    const m = this.mon ?? (this.game.save.party ?? [])[this.slot];
    const def = this.game.data.pokemon?.[m.species];
    const moves = (m.moves ?? []).map((ms) => {
      const base = this.game.data.moves?.[ms.id]?.pp;
      const maxPp = typeof base === "number" ? base + (ms.ppUps ?? 0) * Math.floor(base / 5) : ms.pp;
      return { name: this.game.data.moves?.[ms.id]?.name ?? ms.id, pp: ms.pp, maxPp };
    });
    const cap = this.game.data.constants?.levelCap ?? 100;
    const nextLevel = Math.min(cap, m.level + 1);
    const expToNext = m.level < cap && def ? Math.max(0, expForLevel(def.growthRate, nextLevel) - (m.exp ?? 0)) : 0;
    const player = this.game.save.player;
    return {
      name: m.nickname ?? def?.name ?? m.species,
      species: def?.name ?? m.species,
      speciesId: m.species,
      dex: def?.dex ?? 0,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null,
      types: def?.types ?? [],
      stats: {
        atk: m.stats?.attack ?? 0,
        def: m.stats?.defense ?? 0,
        spd: m.stats?.speed ?? 0,
        spc: m.stats?.special ?? 0
      },
      moves,
      page: this.page,
      exp: m.exp ?? 0,
      expToNext,
      nextLevel,
      otName: player?.name ?? "RED",
      otId: player?.id ?? 0
    };
  }
}

// voxelmon/game/ui/tradeanim.ts
var TRADE_SHOW_FRAMES = 60;
var TRADE_GAP_FRAMES = 40;
var TRADE_PIC_CELL = { x: 6, y: 3, w: 7, h: 7 };

class TradeAnimState {
  game;
  opts;
  kind = "tradeanim";
  phase = "sending";
  t = 0;
  cried = "";
  constructor(game, opts) {
    this.game = game;
    this.opts = opts;
  }
  cryOnce(species) {
    if (this.cried === species)
      return;
    this.cried = species;
    this.game.audio?.playCry?.(species);
  }
  update() {
    this.t += 1;
    if (this.phase === "sending") {
      this.cryOnce(this.opts.sending.species);
      if (this.t >= TRADE_SHOW_FRAMES) {
        this.phase = "gap";
        this.t = 0;
      }
      return;
    }
    if (this.phase === "gap") {
      if (this.t >= TRADE_GAP_FRAMES) {
        this.phase = "receiving";
        this.t = 0;
        this.cried = "";
      }
      return;
    }
    if (this.phase === "receiving") {
      this.cryOnce(this.opts.receiving.species);
      if (this.t >= TRADE_SHOW_FRAMES) {
        this.phase = "done";
        this.game.pop();
        this.opts.onDone();
      }
    }
  }
  view() {
    if (this.phase === "sending") {
      return {
        phase: this.phase,
        mon: this.opts.sending,
        line: `${this.opts.sending.name} is
transferred.`
      };
    }
    if (this.phase === "gap") {
      return { phase: this.phase, mon: null, line: `${this.opts.peerName} waves
farewell as` };
    }
    return {
      phase: "receiving",
      mon: this.opts.receiving,
      line: `${this.opts.peerName} sends
${this.opts.receiving.name}.`
    };
  }
}

// voxelmon/game/ui/evoscreen.ts
var EVO_PIC_CELL = { x: 6, y: 1, w: 7, h: 7 };
var EVO_FLASH_FRAMES = 220;
function flashPeriod(t) {
  return Math.max(4, 28 - Math.floor(t / 40) * 6);
}

class EvolutionState {
  game;
  mon;
  newSpecies;
  via;
  evolve;
  onDone;
  kind = "evolution";
  t = 0;
  done = false;
  canceled = false;
  cancelable;
  oldName;
  oldPage;
  newPage;
  constructor(game, mon, newSpecies, via, evolve, onDone) {
    this.game = game;
    this.mon = mon;
    this.newSpecies = newSpecies;
    this.via = via;
    this.evolve = evolve;
    this.onDone = onDone;
    this.cancelable = via === "LEVEL";
    this.oldName = mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species;
    this.oldPage = picPageFor(game.data, mon.species);
    this.newPage = picPageFor(game.data, newSpecies);
  }
  update() {
    this.t += 1;
    if (this.done)
      return;
    if (this.cancelable && this.game.input.isDown("b")) {
      this.done = true;
      this.canceled = true;
      const line = this.text("_StoppedEvolvingText", `Huh? ${this.oldName}
stopped evolving!`);
      this.game.showText(line, () => this.finish());
      return;
    }
    if (this.t < EVO_FLASH_FRAMES)
      return;
    this.done = true;
    this.evolve(this.mon, this.newSpecies);
    this.game.audio?.playCry?.(this.newSpecies);
    const newName = this.game.data.pokemon[this.newSpecies]?.name ?? this.newSpecies;
    this.game.showText(`Congratulations!
Your ${this.oldName}
evolved into
${newName}!`, () => this.finish());
  }
  finish() {
    this.game.pop();
    this.onDone();
  }
  text(key, fallback) {
    const table = this.game.data.text;
    const line = table?.[key];
    return typeof line === "string" && line.length > 0 ? line : fallback;
  }
  view() {
    if (this.done) {
      return { picPage: this.canceled ? this.oldPage : this.newPage, lines: [] };
    }
    const showNew = Math.floor(this.t / flashPeriod(this.t)) % 2 === 1;
    return {
      picPage: showNew ? this.newPage : this.oldPage,
      lines: ["What?", `${this.oldName} is`, "evolving!"]
    };
  }
}

// voxelmon/game/rules/encounter.ts
var ENCOUNTER_BUCKETS = [
  51,
  102,
  141,
  166,
  191,
  216,
  229,
  242,
  253,
  256
];
function roll(encounterDef, rng, buckets = ENCOUNTER_BUCKETS) {
  if (!encounterDef)
    return null;
  const grass = encounterDef.grass;
  if (!grass || grass.rate === 0)
    return null;
  if (rng.byte() >= grass.rate)
    return null;
  const pick = rng.byte();
  const thresholds = grass.buckets ?? buckets;
  for (let i = 0;i < thresholds.length; i++) {
    if (pick < thresholds[i]) {
      const slot = grass.slots[i];
      if (slot) {
        return { species: slot.species, level: slot.level };
      }
      return null;
    }
  }
  return null;
}

// voxelmon/game/world/collision.ts
var DIR_CYCLE = ["up", "right", "down", "left"];
function rotateDir(d, quarterTurns) {
  const i = DIR_CYCLE.indexOf(d);
  if (i < 0)
    return d;
  const q = (Math.round(quarterTurns) % 4 + 4) % 4;
  return DIR_CYCLE[(i + q) % 4];
}
var DELTA = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0]
};
function target(cx, cy, dir) {
  const d = DELTA[dir];
  return [cx + d[0], cy + d[1]];
}
function occupied(entities, cx, cy, ignore) {
  for (const e of entities) {
    if (e !== ignore && !e.passable && !e.hidden) {
      if (e.cellX === cx && e.cellY === cy || e.targetX === cx && e.targetY === cy) {
        return e;
      }
    }
  }
  return null;
}
function pairBlocked(map, mover, sx, sy, tx, ty, tilePairs) {
  if (!tilePairs)
    return false;
  const list2 = mover.surfing ? tilePairs.water : tilePairs.land;
  if (!list2 || list2.length === 0)
    return false;
  const tileset = map.def.tileset;
  const a = map.cellTile(sx, sy);
  const b = map.cellTile(tx, ty);
  for (const p of list2) {
    if (p.tileset === tileset && (p.a === a && p.b === b || p.a === b && p.b === a)) {
      return true;
    }
  }
  return false;
}
function canMove(map, entities, mover, dir, tilePairs) {
  const [tx, ty] = target(mover.cellX, mover.cellY, dir);
  if (!map.inBounds(tx, ty)) {
    return { ok: false, why: "bounds" };
  }
  if (!map.isWalkableCell(tx, ty)) {
    if (!(mover.surfing && map.isWaterCell(tx, ty))) {
      return { ok: false, why: "tile" };
    }
  }
  if (pairBlocked(map, mover, mover.cellX, mover.cellY, tx, ty, tilePairs)) {
    return { ok: false, why: "tile" };
  }
  if (occupied(entities, tx, ty, mover)) {
    return { ok: false, why: "entity" };
  }
  return { ok: true };
}

// voxelmon/game/world/npc.ts
var STEP_FRAMES = 16;
var FACING_FROM_RANGE = {
  DOWN: "down",
  UP: "up",
  LEFT: "left",
  RIGHT: "right"
};
var ROAM_DIRS = {
  ANY_DIR: ["up", "down", "left", "right"],
  UP_DOWN: ["up", "down"],
  LEFT_RIGHT: ["left", "right"]
};

class NPC {
  def;
  id;
  cellX;
  cellY;
  px;
  py;
  facing;
  moving = false;
  progress = 0;
  stepFlip = false;
  frozen = false;
  wanders;
  roamDirs;
  timer;
  targetX;
  targetY;
  passable;
  marching = false;
  constructor(mapId, objDef, rng) {
    this.def = objDef;
    this.id = `${mapId}_obj_${objDef.index}`;
    this.cellX = objDef.x;
    this.cellY = objDef.y;
    this.px = this.cellX * 16;
    this.py = this.cellY * 16;
    this.facing = FACING_FROM_RANGE[objDef.range] ?? "down";
    this.wanders = objDef.movement === "WALK";
    this.roamDirs = ROAM_DIRS[objDef.range] ?? ROAM_DIRS.ANY_DIR;
    this.timer = randRange(rng, 30, 120);
  }
  facePlayer(player) {
    const dx = player.cellX - this.cellX;
    const dy = player.cellY - this.cellY;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? "right" : "left";
    } else {
      this.facing = dy > 0 ? "down" : "up";
    }
  }
  update(map, entities, rng, tilePairs) {
    const stepLen = STEP_FRAMES;
    if (this.moving) {
      this.progress += 1;
      if (this.marching) {
        if (this.progress >= stepLen) {
          this.progress = 0;
          this.moving = false;
          this.marching = false;
          this.stepFlip = !this.stepFlip;
        }
        return;
      }
      const d = DELTA[this.facing];
      const moved = Math.floor(this.progress * 16 / stepLen);
      this.px = this.cellX * 16 + d[0] * moved;
      this.py = this.cellY * 16 + d[1] * moved;
      if (this.progress >= stepLen) {
        this.cellX = this.targetX;
        this.cellY = this.targetY;
        this.targetX = undefined;
        this.targetY = undefined;
        this.px = this.cellX * 16;
        this.py = this.cellY * 16;
        this.moving = false;
        this.stepFlip = !this.stepFlip;
      }
      return;
    }
    if (this.frozen || !this.wanders)
      return;
    this.timer -= 1;
    if (this.timer > 0)
      return;
    this.timer = randRange(rng, 30, 180);
    const dir = this.roamDirs[rng.int(this.roamDirs.length)];
    this.facing = dir;
    if (rng.byte() < 128)
      return;
    const [tx, ty] = target(this.cellX, this.cellY, dir);
    if (map.warpAtCell(tx, ty))
      return;
    if (canMove(map, entities, this, dir, tilePairs).ok) {
      this.targetX = tx;
      this.targetY = ty;
      this.moving = true;
      this.progress = 0;
    }
  }
  walkPhase() {
    if (!this.moving)
      return 0;
    const p = this.progress % 16;
    return p >= 4 && p < 12 ? 1 : 0;
  }
}

// voxelmon/game/world/player.ts
var STEP_FRAMES2 = 16;
var TURN_FRAMES = 4;

class Player {
  cellX;
  cellY;
  px;
  py;
  facing;
  moving = false;
  progress = 0;
  stepFlip = false;
  turnTimer = 0;
  turnArmed = true;
  inputLocked = false;
  targetX;
  targetY;
  stepFrames = STEP_FRAMES2;
  onBike = false;
  bikeStepFrames = BIKE_STEP_FRAMES;
  turnFrames = TURN_FRAMES;
  stepFramesCur;
  bumpFrames;
  hopFrames;
  hopTotal;
  animClock = 0;
  stepLanded = false;
  landedCount = 0;
  surfing = false;
  lastBlockReason;
  constructor(cx, cy, facing) {
    this.cellX = cx;
    this.cellY = cy;
    this.px = cx * 16;
    this.py = cy * 16;
    this.facing = facing ?? "down";
  }
  tryMove(dir, map, entities, tilePairs) {
    if (this.moving || this.inputLocked)
      return null;
    if (this.facing !== dir) {
      this.facing = dir;
      this.bumpFrames = undefined;
      if (this.turnArmed) {
        this.turnArmed = false;
        this.turnTimer = this.turnFrames;
        return "turned";
      }
    }
    if (this.turnTimer > 0)
      return null;
    const { ok, why } = canMove(map, entities, this, dir, tilePairs);
    if (!ok) {
      this.bumpFrames = this.stepFrames;
      this.lastBlockReason = why;
      return "blocked";
    }
    const [tx, ty] = target(this.cellX, this.cellY, dir);
    this.targetX = tx;
    this.targetY = ty;
    this.moving = true;
    this.bumpFrames = undefined;
    this.progress = 0;
    this.stepFramesCur = this.stepSpeed();
    return "moved";
  }
  stepSpeed() {
    return this.onBike ? this.bikeStepFrames : this.stepFrames;
  }
  update() {
    this.stepLanded = false;
    if (this.hopFrames !== undefined && this.hopFrames > 0) {
      this.hopFrames -= 1;
    }
    if (this.turnTimer > 0) {
      this.turnTimer -= 1;
    }
    if (!this.moving && this.bumpFrames !== undefined && this.bumpFrames > 0) {
      this.bumpFrames -= 1;
      this.animClock += 1;
    }
    if (!this.moving)
      return false;
    const stepLen = this.stepFramesCur ?? this.stepFrames;
    this.progress += 1;
    this.animClock += 1;
    const d = DELTA[this.facing];
    const px2 = Math.floor(this.progress * 16 / stepLen);
    this.px = this.cellX * 16 + d[0] * px2;
    this.py = this.cellY * 16 + d[1] * px2;
    if (this.progress >= stepLen) {
      this.cellX = this.targetX;
      this.cellY = this.targetY;
      this.targetX = undefined;
      this.targetY = undefined;
      this.px = this.cellX * 16;
      this.py = this.cellY * 16;
      this.moving = false;
      this.stepFlip = !this.stepFlip;
      this.stepLanded = true;
      this.landedCount += 1;
      return true;
    }
    return false;
  }
  facingCell() {
    return target(this.cellX, this.cellY, this.facing);
  }
  walkPhase() {
    if (!this.moving && !this.stepLanded && !(this.bumpFrames !== undefined && this.bumpFrames > 0)) {
      return 0;
    }
    const p = this.animClock % 16;
    return p >= 4 && p < 12 ? 1 : 0;
  }
  animFlip() {
    return Math.floor(this.animClock / 16) % 2 === 1;
  }
  hopLift() {
    if (this.hopFrames === undefined || this.hopFrames <= 0)
      return 0;
    const total = this.hopTotal ?? 32;
    const t = 1 - this.hopFrames / total;
    return Math.floor(10 * Math.sin(t * Math.PI) + 0.5);
  }
  bobTimer = 0;
  surfBob() {
    if (!this.surfing) {
      this.bobTimer = 0;
      return 0;
    }
    this.bobTimer = (this.bobTimer + 1) % 32;
    return this.bobTimer < 16 ? 0 : -1;
  }
}

// voxelmon/game/world/gamecorner.ts
var COIN_CAP = 9999;
var COIN_SALE_LIMIT = 9990;
var COINS_PER_SALE = 50;
var COIN_SALE_PRICE = 1000;
function coinClerkRows() {
  return [
    ["face_player"],
    ["ask", "_GameCornerClerk1DoYouNeedSomeGameCoinsText"],
    ["jump_if_false", "no"],
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["check_coins_below", COIN_SALE_LIMIT],
    ["jump_if_false", "full"],
    ["check_money", COIN_SALE_PRICE],
    ["jump_if_false", "poor"],
    ["take_money", COIN_SALE_PRICE],
    ["give_coins", COINS_PER_SALE],
    ["show_text", "_GameCornerClerk1ThanksHereAre50CoinsText"],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", "_GameCornerClerk1PleaseComePlaySometimeText"],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", "_GameCornerClerk1DontHaveCoinCaseText"],
    ["jump", "end"],
    ["label", "full"],
    ["show_text", "_GameCornerClerk1CoinCaseIsFullText"],
    ["jump", "end"],
    ["label", "poor"],
    ["show_text", "_GameCornerClerk1CantAffordTheCoinsText"]
  ];
}
function coinGiverRows(g) {
  return [
    ["face_player"],
    ["check_flag", g.flag],
    ["jump_if_true", "already"],
    ["show_text", g.ask],
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["check_coins_below", COIN_SALE_LIMIT],
    ["jump_if_false", "full"],
    ["give_coins", g.amount],
    ["set_flag", g.flag],
    ["show_text", g.received],
    ["jump", "end"],
    ["label", "already"],
    ["show_text", g.already],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", "_GameCornerOopsForgotCoinCaseText"],
    ["jump", "end"],
    ["label", "full"],
    ["show_text", g.full]
  ];
}
var COIN_GIVERS = {
  FISHING_GURU: {
    flag: "EVENT_GOT_10_COINS",
    amount: 10,
    ask: "_GameCornerFishingGuruWantToPlayText",
    received: "_GameCornerFishingGuruReceived10CoinsText",
    full: "_GameCornerFishingGuruDontNeedMyCoinsText",
    already: "_GameCornerFishingGuruWinsComeAndGoText"
  },
  CLERK2: {
    flag: "EVENT_GOT_20_COINS_2",
    amount: 20,
    ask: "_GameCornerClerk2WantSomeCoinsText",
    received: "_GameCornerClerk2Received20CoinsText",
    full: "_GameCornerClerk2YouHaveLotsOfCoinsText",
    already: "_GameCornerClerk2INeedMoreCoinsText"
  },
  GENTLEMAN: {
    flag: "EVENT_GOT_20_COINS",
    amount: 20,
    ask: "_GameCornerGentlemanThrowingMeOffText",
    received: "_GameCornerGentlemanReceived20CoinsText",
    full: "_GameCornerGentlemanYouGotYourOwnCoinsText",
    already: "_GameCornerGentlemanCloselyWatchTheReelsText"
  }
};
var PRIZE_WINDOWS = [
  [
    { kind: "mon", species: "ABRA", level: 9, cost: 180 },
    { kind: "mon", species: "CLEFAIRY", level: 8, cost: 500 },
    { kind: "mon", species: "NIDORINA", level: 17, cost: 1200 }
  ],
  [
    { kind: "mon", species: "DRATINI", level: 18, cost: 2800 },
    { kind: "mon", species: "SCYTHER", level: 25, cost: 5500 },
    { kind: "mon", species: "PORYGON", level: 26, cost: 9999 }
  ],
  [
    { kind: "item", item: "TM_DRAGON_RAGE", cost: 3300 },
    { kind: "item", item: "TM_HYPER_BEAM", cost: 5500 },
    { kind: "item", item: "TM_SUBSTITUTE", cost: 7700 }
  ]
];
function prizeCounterRows(window) {
  return [
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["show_text", "_ExchangeCoinsForPrizesText"],
    ["open_prizes", window],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", "_RequireCoinCaseText"]
  ];
}

// voxelmon/game/world/elevator.ts
function floorsOf(data, elevatorMapId) {
  const maps = data.maps ?? {};
  const floors = [];
  for (const [mapId, def] of Object.entries(maps)) {
    const warps = def?.warps ?? [];
    for (let i = 0;i < warps.length; i++) {
      if (warps[i]?.destMap !== elevatorMapId)
        continue;
      floors.push({
        map: mapId,
        token: mapId.slice(mapId.lastIndexOf("_") + 1) || mapId,
        warpIdx: i + 1
      });
      break;
    }
  }
  floors.sort((a, b) => floorNumber(a.token) - floorNumber(b.token));
  return floors;
}
function floorNumber(token) {
  const m = /\d+/.exec(token);
  return m ? Number(m[0]) : 0;
}
function setExit(mapDef, floor) {
  if (!mapDef?.warps || !floor)
    return;
  for (const w of mapDef.warps) {
    w.destMap = floor.map;
    w.destWarp = floor.warpIdx;
  }
}
function seedExit(mapDef, floors, fromMapId) {
  let exit = floors[0];
  if (fromMapId) {
    const came = floors.find((f) => f.map === fromMapId);
    if (came)
      exit = came;
  }
  setExit(mapDef, exit);
  return exit;
}

// voxelmon/game/world/safari.ts
var SAFARI_FEE = 500;
var SAFARI_BALLS = 30;
var SAFARI_STEPS = 502;
var SAFARI_WALK_IN_STEPS = 2;
var SAFARI_STEP_MAPS = new Set([
  "SAFARI_ZONE_CENTER",
  "SAFARI_ZONE_EAST",
  "SAFARI_ZONE_NORTH",
  "SAFARI_ZONE_WEST",
  "SAFARI_ZONE_CENTER_REST_HOUSE",
  "SAFARI_ZONE_EAST_REST_HOUSE",
  "SAFARI_ZONE_NORTH_REST_HOUSE",
  "SAFARI_ZONE_WEST_REST_HOUSE",
  "SAFARI_ZONE_SECRET_HOUSE"
]);
var SAFARI_EXIT = { map: "SAFARI_ZONE_GATE", x: 4, y: 3, facing: "down" };
var SAFARI_JOIN_CELLS = [[3, 2], [4, 2]];
var SAFARI_RETURN_LEFT = [14, 25];
var SAFARI_RETURN_RIGHT = [15, 25];
function inSafariStepZone(mapId) {
  return SAFARI_STEP_MAPS.has(mapId);
}
function safariJoinRows() {
  return [
    ["ask", "_SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText"],
    ["jump_if_false", "decline"],
    ["check_money", SAFARI_FEE],
    ["jump_if_false", "broke"],
    ["take_money", SAFARI_FEE],
    ["safari_start"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1ThatllBe500PleaseText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1CallYouOnThePAText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"],
    ["safari_walk_in"],
    ["jump", "end"],
    ["label", "broke"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1NotEnoughMoneyText"],
    ["move_player", "down", 1],
    ["jump", "end"],
    ["label", "decline"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1PleaseComeAgainText"],
    ["move_player", "down", 1]
  ];
}
function safariLeavingRows(fromRightWarp) {
  const back = fromRightWarp ? SAFARI_RETURN_RIGHT : SAFARI_RETURN_LEFT;
  return [
    ["ask", "_SafariZoneGateSafariZoneWorker1LeavingEarlyText"],
    ["jump_if_false", "stay"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1ReturnSafariBallsText"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodHaulComeAgainText"],
    ["safari_end"],
    ["move_player", "down", 3],
    ["jump", "end"],
    ["label", "stay"],
    ["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"],
    ["warp", "SAFARI_ZONE_CENTER", back[0], back[1], "up"]
  ];
}

// voxelmon/game/world/vending.ts
var VENDING_DRINKS = ["FRESH_WATER", "SODA_POP", "LEMONADE"];
function vendingRows() {
  return [["open_vending"]];
}
var GIRL_TMS = [
  {
    drink: "FRESH_WATER",
    tm: "TM_ICE_BEAM",
    flag: "EVENT_GOT_TM13",
    yay: "_CeladonMartRoofLittleGirlYayFreshWaterText",
    received: "_CeladonMartRoofLittleGirlReceivedTM13Text",
    explain: "_CeladonMartRoofLittleGirlTM13ExplanationText"
  },
  {
    drink: "SODA_POP",
    tm: "TM_ROCK_SLIDE",
    flag: "EVENT_GOT_TM48",
    yay: "_CeladonMartRoofLittleGirlYaySodaPopText",
    received: "_CeladonMartRoofLittleGirlReceivedTM48Text",
    explain: "_CeladonMartRoofLittleGirlTM48ExplanationText"
  },
  {
    drink: "LEMONADE",
    tm: "TM_TRI_ATTACK",
    flag: "EVENT_GOT_TM49",
    yay: "_CeladonMartRoofLittleGirlYayLemonadeText",
    received: "_CeladonMartRoofLittleGirlReceivedTM49Text",
    explain: "_CeladonMartRoofLittleGirlTM49ExplanationText"
  }
];
function thirstyGirlRows(_ow, save) {
  const inv = save?.inventory ?? {};
  const flags = save?.flags ?? {};
  const g = GIRL_TMS.find((t) => (inv[t.drink] ?? 0) > 0 && !flags[t.flag]);
  if (!g) {
    return [
      ["face_player"],
      ["show_text", "_CeladonMartRoofLittleGirlImThirstyText"]
    ];
  }
  return [
    ["face_player"],
    ["ask", "_CeladonMartRoofLittleGirlGiveHerADrinkText"],
    ["jump_if_false", "end"],
    ["show_text", g.yay],
    ["give_item", g.tm, 1, g.received],
    ["take_item", g.drink, 1],
    ["set_flag", g.flag],
    ["show_text", g.explain]
  ];
}

// voxelmon/game/world/saffrongate.ts
var GUARD_DRINKS = ["FRESH_WATER", "SODA_POP", "LEMONADE"];
var GAVE_DRINK_FLAG = "EVENT_GAVE_GUARDS_DRINK";
var ACCEPTED = [
  ["show_text", "_SaffronGateGuardImParchedText"],
  ["show_text", "_SaffronGateGuardYouCanGoOnThroughText"]
];
function saffronGuardTalkRows() {
  return [
    ["face_player"],
    ["check_flag", GAVE_DRINK_FLAG],
    ["jump_if_true", "thanks"],
    ["take_guard_drink"],
    ["jump_if_false", "thirsty"],
    ...ACCEPTED,
    ["jump", "end"],
    ["label", "thanks"],
    ["show_text", "_SaffronGateGuardThanksForTheDrinkText"],
    ["jump", "end"],
    ["label", "thirsty"],
    ["show_text", "_SaffronGateGuardGeeImThirstyText"]
  ];
}
function saffronGateStepRows(back) {
  return [
    ["take_guard_drink"],
    ["jump_if_false", "block"],
    ...ACCEPTED,
    ["jump", "end"],
    ["label", "block"],
    ["show_text", "_SaffronGateGuardGeeImThirstyText"],
    ["move_player", back, 1]
  ];
}
var SAFFRON_GATES = {
  ROUTE_5_GATE: { guardText: "TEXT_ROUTE5GATE_GUARD", triggers: [[3, 3], [4, 3]] },
  ROUTE_6_GATE: { guardText: "TEXT_ROUTE6GATE_GUARD", triggers: [[3, 2], [4, 2]] },
  ROUTE_7_GATE: {
    guardText: "TEXT_ROUTE7GATE_GUARD",
    triggers: [[3, 3], [3, 4]],
    horizontal: true
  },
  ROUTE_8_GATE: {
    guardText: "TEXT_ROUTE8GATE_GUARD",
    triggers: [[2, 3], [2, 4]],
    horizontal: true
  }
};
function saffronGateScript(gate) {
  return {
    talk: { [gate.guardText]: saffronGuardTalkRows() },
    onStep: (ow, save) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!gate.triggers.some(([cx, cy]) => cx === x && cy === y))
        return null;
      if (save?.flags?.[GAVE_DRINK_FLAG])
        return null;
      const back = gate.horizontal ? p.facing === "left" ? "right" : "left" : p.facing === "up" ? "down" : "up";
      return saffronGateStepRows(back);
    }
  };
}

// voxelmon/game/world/mapscripts.ts
function gymLeader(o) {
  const rows = [
    ["check_flag", o.beatFlag],
    ["jump_if_true", "beaten"],
    ["show_text", o.preText],
    ["start_battle", "trainer", o.trainerClass, o.party ?? 1],
    ["jump_if_false", "end"],
    ["set_flag", o.beatFlag]
  ];
  for (const d of o.deactivate ?? [])
    rows.push(["set_flag", d]);
  rows.push(["give_item", o.badge, 1, false]);
  for (const t of o.badgeText)
    rows.push(["show_text", t]);
  rows.push(["label", "give_tm"]);
  rows.push(["show_text", o.tmPre]);
  rows.push(["give_item", o.tm, 1, false]);
  rows.push(["set_flag", o.gotFlag]);
  for (const t of o.tmText)
    rows.push(["show_text", t]);
  rows.push(["jump", "end"]);
  rows.push(["label", "beaten"]);
  rows.push(["check_flag", o.gotFlag]);
  rows.push(["jump_if_false", "give_tm"]);
  rows.push(["show_text", o.advice]);
  for (const r of o.afterAdvice ?? [])
    rows.push(r);
  return rows;
}
function gymTrainerFlags(prefix, last) {
  return Array.from({ length: last + 1 }, (_, i) => `${prefix}${i}`);
}
function mtMoonNerdWalk(px2, py, itemId) {
  if (px2 === 12 && py === 7 || px2 === 11 && py === 6 || px2 === 12 && py === 5) {
    return ["right", "up"];
  }
  if (px2 === 13 && py === 7 || px2 === 14 && py === 6 || px2 === 14 && py === 5) {
    return ["up"];
  }
  return itemId === "DOME_FOSSIL" ? ["right", "up"] : ["up"];
}
function mtMoonFossil(itemId, selfName, otherName, gotFlag) {
  return (ow, save) => {
    const f = save?.flags ?? {};
    if (f.EVENT_GOT_DOME_FOSSIL || f.EVENT_GOT_HELIX_FOSSIL)
      return null;
    const nerd = ow.findNpc?.(1);
    if (nerd && !ow.trainerDefeated?.(nerd))
      return [["engage_trainer", 1]];
    const dirs = mtMoonNerdWalk(ow?.player?.cellX ?? 0, ow?.player?.cellY ?? 0, itemId);
    const wantText = itemId === "DOME_FOSSIL" ? "_MtMoonB2FDomeFossilYouWantText" : "_MtMoonB2FHelixFossilYouWantText";
    return [
      ["ask", wantText],
      ["jump_if_false", "end"],
      ["play_sound", "Get_Key_Item"],
      ["give_item", itemId, 1, "_MtMoonB2FReceivedFossilText"],
      ["hide_object", "MT_MOON_B2F", selfName],
      ["set_flag", gotFlag],
      ["walk_npc", 1, dirs],
      ["show_text", "_MtMoonB2FSuperNerdThenThisIsMineText"],
      ["play_sound", "Get_Key_Item"],
      ["hide_object", "MT_MOON_B2F", otherName]
    ];
  };
}
function staticMon(map, object, text, species, level, flag) {
  return [
    ["play_cry", species],
    ["show_text", text],
    ["check_flag", flag],
    ["jump_if_true", "end"],
    ["static_battle", species, level],
    ["jump_if_false", "end"],
    ["set_flag", flag],
    ["hide_object", map, object],
    ["label", "end"]
  ];
}
function tradeRows(index, flag) {
  return [["face_player"], ["trade", index, flag]];
}
var E4_RESET_FLAGS = [
  "EVENT_BEAT_LORELEIS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_LORELEIS_ROOM",
  "EVENT_BEAT_BRUNOS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_BRUNOS_ROOM",
  "EVENT_BEAT_AGATHAS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_AGATHAS_ROOM",
  "EVENT_BEAT_LANCES_ROOM_TRAINER_0",
  "EVENT_BEAT_LANCE",
  "EVENT_LANCES_ROOM_LOCK_DOOR",
  "EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN"
];
var E4_TRAINER_KEYS = [
  "LORELEIS_ROOM_obj_1",
  "BRUNOS_ROOM_obj_1",
  "AGATHAS_ROOM_obj_1",
  "LANCES_ROOM_obj_1"
];
var FOSSIL_MONS = {
  DOME_FOSSIL: "KABUTO",
  HELIX_FOSSIL: "OMANYTE",
  OLD_AMBER: "AERODACTYL"
};
var FOSSIL_ORDER = ["DOME_FOSSIL", "HELIX_FOSSIL", "OLD_AMBER"];
function fossilScientistRows(ow, save) {
  const f = save?.flags ?? {};
  const data = ow?.data ?? ow?.shell?.data;
  const monName2 = (sp) => data?.pokemon?.[sp]?.name ?? sp;
  const itemName = (id) => data?.items?.[id]?.name ?? id;
  const L = "_CinnabarLabFossilRoomScientist1";
  if (f.EVENT_GAVE_FOSSIL_TO_LAB) {
    if (f.EVENT_LAB_STILL_REVIVING_FOSSIL) {
      return [["face_player"], ["show_text", `${L}GoForAWalkText`]];
    }
    const species = save.labFossilMon;
    const rows2 = [["face_player"]];
    if (!species) {
      return [
        ...rows2,
        ["clear_flag", "EVENT_GAVE_FOSSIL_TO_LAB"],
        ["show_text", `${L}Text`]
      ];
    }
    return [
      ...rows2,
      ["show_text", `${L}FossilIsBackToLifeText`, { "RAM:wStringBuffer": monName2(species) }],
      ["check_party_room"],
      ["jump_if_false", "full"],
      ["play_sound", "Get_Key_Item"],
      ["give_pokemon", species, 30],
      ["show_text", `{PLAYER} got
${monName2(species)}!`],
      ["lab_fossil"],
      ["clear_flag", "EVENT_GAVE_FOSSIL_TO_LAB"],
      ["clear_flag", "EVENT_LAB_STILL_REVIVING_FOSSIL"],
      ["jump", "end"],
      ["label", "full"],
      ["show_text", `You have no room
for it!\fCome back when
you do!`],
      ["label", "end"]
    ];
  }
  const carried = FOSSIL_ORDER.filter((id) => (save?.inventory?.[id] ?? 0) > 0);
  const rows = [["face_player"], ["show_text", `${L}Text`]];
  if (carried.length === 0)
    return [...rows, ["show_text", `${L}NoFossilsText`]];
  carried.forEach((id, i) => {
    rows.push([
      "ask",
      `${L}SeesFossilText`,
      { "RAM:wNameBuffer": itemName(id), "RAM:wStringBuffer": monName2(FOSSIL_MONS[id]) }
    ], ["jump_if_true", `give${i}`]);
  });
  rows.push(["show_text", `${L}ComeAgainText`], ["jump", "end"]);
  carried.forEach((id, i) => {
    rows.push(["label", `give${i}`], ["take_item", id, 1], ["lab_fossil", FOSSIL_MONS[id]], ["set_flag", "EVENT_GAVE_FOSSIL_TO_LAB"], ["set_flag", "EVENT_LAB_STILL_REVIVING_FOSSIL"], ["show_text", `${L}TakesFossilText`, { "RAM:wNameBuffer": itemName(id) }], ["show_text", `${L}GoForAWalkText2`], ["jump", "end"]);
  });
  rows.push(["label", "end"]);
  return rows;
}
function pewterEscortRows() {
  return [
    ["show_text", "_PewterCityYoungsterYoureATrainerFollowMeText"],
    ["move_player_to", 11, 18],
    ["move_npc_to", "PEWTERCITY_YOUNGSTER", 12, 18],
    ["face_object", "PEWTERCITY_YOUNGSTER", "left"],
    ["show_text", "_PewterCityYoungsterGoTakeOnBrockText"],
    ["place_npc", "PEWTERCITY_YOUNGSTER", 35, 16, "down"]
  ];
}
function route24RecruiterScript(_ow, save) {
  const f = save?.flags ?? {};
  const rows = [];
  if (!f.EVENT_GOT_NUGGET) {
    rows.push(["show_text", `Congratulations!
You beat our 5
contest trainers!\fYou just earned a
fabulous prize!`], ["give_item", "NUGGET", 1, `{PLAYER} received
a NUGGET!`], ["set_flag", "EVENT_GOT_NUGGET"], ["ask", `By the way, would
you like to join
TEAM ROCKET?`], ["show_text", `Arrgh! You are
not convinced?\fThen I'll show
you my power!`]);
  }
  rows.push(["engage_trainer", 1]);
  return rows;
}
function ceruleanRivalRows(px2) {
  return sceneWithTheme(MEET_RIVAL, [
    ["show_object", "CERULEAN_CITY", "CERULEANCITY_RIVAL"],
    ["move_npc_to", "CERULEANCITY_RIVAL", px2, 5],
    ["face_object", "CERULEANCITY_RIVAL", "down"],
    ["show_text", "_CeruleanCityRivalPreBattleText"],
    ["rival_battle", "OPP_RIVAL1", 7],
    ["jump_if_false", "end"],
    ["set_flag", "EVENT_BEAT_CERULEAN_RIVAL"],
    ["show_text", "_CeruleanCityRivalDefeatedText"],
    ["show_text", "_CeruleanCityRivalIWentToBillsText"],
    ["move_npc_to", "CERULEANCITY_RIVAL", px2, 12],
    ["hide_object", "CERULEAN_CITY", "CERULEANCITY_RIVAL"]
  ]);
}
var ceruleanRocketRows = [
  ["face_player"],
  ["check_flag", "EVENT_GOT_TM28"],
  ["jump_if_true", "hide"],
  ["check_flag", "EVENT_BEAT_CERULEAN_ROCKET_THIEF"],
  ["jump_if_true", "retry_tm"],
  ["show_text", "_CeruleanCityRocketText"],
  ["start_battle", "trainer", "OPP_ROCKET", 5],
  ["jump_if_false", "end"],
  ["label", "retry_tm"],
  ["show_text", "_CeruleanCityRocketIllReturnTheTMText"],
  ["set_flag", "EVENT_BEAT_CERULEAN_ROCKET_THIEF"],
  ["give_item", "TM_DIG", 1, false],
  ["set_flag", "EVENT_GOT_TM28"],
  ["show_text", "_CeruleanCityRocketReceivedTM28Text"],
  ["show_text", "_CeruleanCityRocketIBetterGetMovingText"],
  ["label", "hide"],
  ["show_object", "CERULEAN_CITY", "CERULEANCITY_GUARD1"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_GUARD2"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_ROCKET"]
];
var MISTY_GYM = gymLeader({
  trainerClass: "OPP_MISTY",
  beatFlag: "EVENT_BEAT_MISTY",
  preText: "_CeruleanGymMistyPreBattleText",
  deactivate: ["EVENT_BEAT_CERULEAN_GYM_TRAINER_0", "EVENT_BEAT_CERULEAN_GYM_TRAINER_1"],
  badge: "CASCADEBADGE",
  badgeText: ["_CeruleanGymMistyReceivedCascadeBadgeText"],
  tmPre: "_CeruleanGymMistyCascadeBadgeInfoText",
  tm: "TM_BUBBLEBEAM",
  gotFlag: "EVENT_GOT_TM11",
  tmText: ["_CeruleanGymMistyReceivedTM11Text"],
  advice: "_CeruleanGymMistyTM11ExplanationText"
});
var billsHousePokemonRows = [
  ["ask", "_BillsHouseBillImNotAPokemonText"],
  ["jump_if_true", "toMachine"],
  ["show_text", "_BillsHouseBillNoYouGottaHelpText"],
  ["label", "toMachine"],
  ["show_text", "_BillsHouseBillUseSeparationSystemText"],
  ["move_npc_to", "BILLSHOUSE_BILL_POKEMON", 6, 2],
  ["hide_object", "BILLS_HOUSE", "BILLSHOUSE_BILL_POKEMON"],
  ["set_flag", "EVENT_BILL_SAID_USE_CELL_SEPARATOR"]
];
var billsHouseSsTicketRows = [
  ["face_player"],
  ["check_flag", "EVENT_GOT_SS_TICKET"],
  ["jump_if_true", "repeat"],
  ["show_text", "_BillsHouseBillThankYouText"],
  ["give_item", "S_S_TICKET", 1, false],
  ["show_text", "_SSTicketReceivedText"],
  ["set_flag", "EVENT_GOT_SS_TICKET"],
  ["show_object", "CERULEAN_CITY", "CERULEANCITY_GUARD1"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_GUARD2"],
  ["show_text", "_BillsHouseBillWhyDontYouGoInsteadOfMeText"],
  ["jump", "end"],
  ["label", "repeat"],
  ["show_text", "_BillsHouseBillWhyDontYouGoInsteadOfMeText"]
];
var billsHouseRarePokemonRows = [
  ["face_player"],
  ["show_text", "_BillsHouseBillCheckOutMyRarePokemonText"]
];
var TEXT_BILLSHOUSE_PC = "TEXT_BILLSHOUSE_PC";
function billsHousePcScript(_ow, save) {
  const f = save?.flags ?? {};
  if (f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING) {
    return [["show_text", "_BillsHousePokemonListText1"]];
  }
  if (f.EVENT_USED_CELL_SEPARATOR_ON_BILL || !f.EVENT_BILL_SAID_USE_CELL_SEPARATOR) {
    return [["show_text", "_BillsHouseMonitorText"]];
  }
  return [
    ["show_text", "_BillsHouseInitiatedText"],
    ["set_flag", "EVENT_USED_CELL_SEPARATOR_ON_BILL"],
    ["play_sound", "Switch"],
    ["wait", 32],
    ["play_sound", "Tink"],
    ["wait", 80],
    ["play_sound", "Shrink"],
    ["wait", 48],
    ["play_sound", "Tink"],
    ["wait", 32],
    ["play_sound", "Get_Item1"],
    ["wait", 30],
    ["show_object", "BILLS_HOUSE", "BILLSHOUSE_BILL1"],
    ["move_npc_to", "BILLSHOUSE_BILL1", 4, 4]
  ];
}
var LT_SURGE_GYM = gymLeader({
  trainerClass: "OPP_LT_SURGE",
  beatFlag: "EVENT_BEAT_LT_SURGE",
  preText: "_VermilionGymLTSurgePreBattleText",
  deactivate: [
    "EVENT_BEAT_VERMILION_GYM_TRAINER_0",
    "EVENT_BEAT_VERMILION_GYM_TRAINER_1",
    "EVENT_BEAT_VERMILION_GYM_TRAINER_2"
  ],
  badge: "THUNDERBADGE",
  badgeText: ["_VermilionGymLTSurgeReceivedThunderBadgeText"],
  tmPre: "_VermilionGymLTSurgeThunderBadgeInfoText",
  tm: "TM_THUNDERBOLT",
  gotFlag: "EVENT_GOT_TM24",
  tmText: ["_VermilionGymLTSurgeReceivedTM24Text", "_TM24ExplanationText"],
  advice: "_VermilionGymLTSurgePostBattleAdviceText"
});
var trashedHouseFishingGuruRows = [
  ["check_item", "TM_DIG"],
  ["jump_if_true", "has_tm"],
  ["show_text", "_CeruleanTrashedHouseFishingGuruTheyStoleATMText"],
  ["jump", "end"],
  ["label", "has_tm"],
  ["show_text", "_CeruleanTrashedHouseFishingGuruWhatsLostIsLostText"]
];
function vermilionSailorRows(save) {
  const f = save?.flags ?? {};
  if (f.EVENT_SS_ANNE_LEFT) {
    return [["show_text", "_VermilionCitySailor1ShipSetSailText"]];
  }
  return [
    ["show_text", "_VermilionCitySailor1DoYouHaveATicketText"],
    ["check_item", "S_S_TICKET"],
    ["jump_if_false", "no_ticket"],
    ["show_text", "_VermilionCitySailor1FlashedTicketText"],
    ["jump", "end"],
    ["label", "no_ticket"],
    ["show_text", "_VermilionCitySailor1YouNeedATicketText"]
  ];
}
var SILPH_ROCKET_OBJECTS = [
  ["SILPH_CO_2F", [
    "SILPHCO2F_SCIENTIST1",
    "SILPHCO2F_SCIENTIST2",
    "SILPHCO2F_ROCKET1",
    "SILPHCO2F_ROCKET2"
  ]],
  ["SILPH_CO_3F", ["SILPHCO3F_ROCKET", "SILPHCO3F_SCIENTIST"]],
  ["SILPH_CO_4F", ["SILPHCO4F_ROCKET1", "SILPHCO4F_SCIENTIST", "SILPHCO4F_ROCKET2"]],
  ["SILPH_CO_5F", [
    "SILPHCO5F_ROCKET1",
    "SILPHCO5F_SCIENTIST",
    "SILPHCO5F_ROCKER",
    "SILPHCO5F_ROCKET2"
  ]],
  ["SILPH_CO_6F", ["SILPHCO6F_ROCKET1", "SILPHCO6F_SCIENTIST", "SILPHCO6F_ROCKET2"]],
  ["SILPH_CO_7F", [
    "SILPHCO7F_ROCKET1",
    "SILPHCO7F_SCIENTIST",
    "SILPHCO7F_ROCKET2",
    "SILPHCO7F_ROCKET3"
  ]],
  ["SILPH_CO_8F", ["SILPHCO8F_ROCKET1", "SILPHCO8F_SCIENTIST", "SILPHCO8F_ROCKET2"]],
  ["SILPH_CO_9F", ["SILPHCO9F_ROCKET1", "SILPHCO9F_SCIENTIST", "SILPHCO9F_ROCKET2"]],
  ["SILPH_CO_10F", ["SILPHCO10F_ROCKET", "SILPHCO10F_SCIENTIST"]],
  ["SILPH_CO_11F", ["SILPHCO11F_ROCKET1", "SILPHCO11F_ROCKET2"]]
];
var SAFFRON_ROCKETS = [
  "SAFFRONCITY_ROCKET1",
  "SAFFRONCITY_ROCKET2",
  "SAFFRONCITY_ROCKET3",
  "SAFFRONCITY_ROCKET4",
  "SAFFRONCITY_ROCKET5",
  "SAFFRONCITY_ROCKET6",
  "SAFFRONCITY_ROCKET7",
  "SAFFRONCITY_ROCKET8",
  "SAFFRONCITY_ROCKET9"
];
var SAFFRON_CIVILIANS = [
  "SAFFRONCITY_SCIENTIST",
  "SAFFRONCITY_SILPH_WORKER_M",
  "SAFFRONCITY_SILPH_WORKER_F",
  "SAFFRONCITY_GENTLEMAN",
  "SAFFRONCITY_PIDGEOT",
  "SAFFRONCITY_ROCKER"
];
function silphAftermathRows() {
  const rows = [
    ["show_text", "_SilphCo11FGiovanniYouRuinedOurPlansText"],
    ["fade", "out"]
  ];
  for (const [map, names] of SILPH_ROCKET_OBJECTS) {
    for (const n of names)
      rows.push(["hide_object", map, n]);
  }
  rows.push(["hide_object", "SILPH_CO_11F", "SILPHCO11F_GIOVANNI"]);
  for (const n of SAFFRON_ROCKETS)
    rows.push(["hide_object", "SAFFRON_CITY", n]);
  for (const n of SAFFRON_CIVILIANS)
    rows.push(["show_object", "SAFFRON_CITY", n]);
  rows.push(["wait", 3]);
  rows.push(["fade", "in"]);
  return rows;
}
var SEVEN_BADGES = [
  "BOULDERBADGE",
  "CASCADEBADGE",
  "THUNDERBADGE",
  "RAINBOWBADGE",
  "SOULBADGE",
  "MARSHBADGE",
  "VOLCANOBADGE"
];
function hasSevenBadges(save) {
  const inv = save?.inventory ?? {};
  return SEVEN_BADGES.every((b) => (inv[b] ?? 0) > 0);
}
function lockedDoorStep(ow, at, locked, textId) {
  if (!locked)
    return null;
  const x = ow?.player?.cellX;
  const y = ow?.player?.cellY;
  if (!at.some(([dx, dy]) => dx === x && dy === y))
    return null;
  return [["show_text", textId], ["move_player", "down", 1]];
}
function route22Scene(n, py) {
  const obj = `ROUTE22_RIVAL${n}`;
  const rx = py === 4 ? 29 : 28;
  const rivalFacing = py === 4 ? "up" : "right";
  const exit = py === 4 ? ["right", "right", "down", "down", "down", "down", "down"] : ["up", "right", "right", "right", "down", "down", "down", "down", "down", "down"];
  return sceneWithTheme(MEET_RIVAL, [
    ["show_object", "ROUTE_22", obj],
    ["move_npc_to", obj, rx, 5],
    ["face_object", obj, rivalFacing],
    ["show_text", `_Route22RivalBeforeBattleText${n}`],
    [
      "rival_battle",
      n === 1 ? "OPP_RIVAL1" : "OPP_RIVAL2",
      n === 1 ? 4 : 10,
      n === 1 ? { loseable: true } : {}
    ],
    ["jump_if_false", 11],
    [
      "set_flag",
      n === 1 ? "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE" : "EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE"
    ],
    ["show_text", `_Route22Rival${n}DefeatedText`],
    ["show_text", `_Route22RivalAfterBattleText${n}`],
    ["walk_npc", obj, exit],
    ["hide_object", "ROUTE_22", obj]
  ]);
}
var TOWER_RIVAL_EXIT_RIGHT_THEN_DOWN = ["right", "down", "down", "right", "down", "down", "right", "right"];
var TOWER_RIVAL_EXIT_DOWN_THEN_RIGHT = ["down", "down", "right", "right", "right", "right", "down", "down"];
function towerRivalScript(playerX) {
  const exit = playerX === 15 ? TOWER_RIVAL_EXIT_DOWN_THEN_RIGHT : TOWER_RIVAL_EXIT_RIGHT_THEN_DOWN;
  return sceneWithTheme(MEET_RIVAL, [
    ["face_player"],
    ["check_flag", "EVENT_BEAT_POKEMON_TOWER_RIVAL"],
    ["jump_if_true", 12],
    ["show_text", "_PokemonTower2FRivalWhatBringsYouHereText"],
    ["rival_battle", "OPP_RIVAL2", 4],
    ["jump_if_false", "end"],
    ["set_flag", "EVENT_BEAT_POKEMON_TOWER_RIVAL"],
    ["show_text", "_PokemonTower2FRivalDefeatedText"],
    ["walk_npc", "POKEMONTOWER2F_RIVAL", exit],
    ["hide_object", "POKEMON_TOWER_2F", "POKEMONTOWER2F_RIVAL"],
    ["jump", "end"],
    ["show_text", "_PokemonTower2FRivalHowsYourDexText"]
  ]);
}
var JIGGLYPUFF_SPIN = ["down", "left", "up", "right"];
var JIGGLY_SILENCE = 32;
var JIGGLY_STEP = 24;
var JIGGLY_TAIL = 48;
var JIGGLY_TURNS = 12;
function jigglypuffRows() {
  const rows = [
    ["face_player"],
    ["show_text", "_PewterPokecenterJigglypuffText"],
    ["stop_music"],
    ["wait", JIGGLY_SILENCE],
    ["play_music", "Music_JigglypuffSong"]
  ];
  for (let i = 0;i < JIGGLY_TURNS; i += 1) {
    rows.push(["wait", JIGGLY_STEP]);
    rows.push([
      "face_object",
      "PEWTERPOKECENTER_JIGGLYPUFF",
      JIGGLYPUFF_SPIN[i % JIGGLYPUFF_SPIN.length]
    ]);
  }
  rows.push(["wait", JIGGLY_TAIL]);
  return rows;
}
var DEX_COMPLETE = 150;
var MAP_SCRIPTS = {
  PEWTER_CITY: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_BROCK)
        return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!(x === 35 && y === 17 || x === 36 && y === 17 || x === 37 && y === 18 || x === 37 && y === 19)) {
        return null;
      }
      return pewterEscortRows();
    },
    talk: {
      TEXT_PEWTERCITY_YOUNGSTER: (_ow, save) => save?.flags?.EVENT_BEAT_BROCK ? null : pewterEscortRows()
    }
  },
  MT_MOON_B2F: {
    onStep: (ow, save) => {
      const p = ow?.player;
      if (p?.cellX === 13 && p?.cellY === 8) {
        const nerd = ow.findNpc?.(1);
        if (nerd && !ow.trainerDefeated?.(nerd))
          return [["engage_trainer", 1]];
      }
      return null;
    },
    talk: {
      TEXT_MTMOONB2F_DOME_FOSSIL: mtMoonFossil("DOME_FOSSIL", "MTMOONB2F_DOME_FOSSIL", "MTMOONB2F_HELIX_FOSSIL", "EVENT_GOT_DOME_FOSSIL"),
      TEXT_MTMOONB2F_HELIX_FOSSIL: mtMoonFossil("HELIX_FOSSIL", "MTMOONB2F_HELIX_FOSSIL", "MTMOONB2F_DOME_FOSSIL", "EVENT_GOT_HELIX_FOSSIL")
    }
  },
  MT_MOON_POKECENTER: {
    talk: {
      TEXT_MTMOONPOKECENTER_MAGIKARP_SALESMAN: (_ow, save) => {
        if (save?.flags?.EVENT_BOUGHT_MAGIKARP) {
          return [
            ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoRefundsText"]
          ];
        }
        return [
          ["face_player"],
          ["ask", "_MtMoonPokecenterMagikarpSalesmanIGotADealText"],
          ["jump_if_false", "no"],
          ["check_money", MAGIKARP_PRICE],
          ["jump_if_false", "broke"],
          ["check_party_room"],
          ["jump_if_false", "full"],
          ["take_money", MAGIKARP_PRICE],
          ["set_flag", "EVENT_BOUGHT_MAGIKARP"],
          ["give_pokemon", "MAGIKARP", 5],
          ["jump", "end"],
          ["label", "no"],
          ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoText"],
          ["jump", "end"],
          ["label", "broke"],
          ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoMoneyText"],
          ["jump", "end"],
          ["label", "full"],
          ["show_text", "_BoxIsFullText"]
        ];
      }
    }
  },
  ROUTE_22: {
    onStep: (ow, save) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!(x === 29 && y === 4 || x === 29 && y === 5))
        return null;
      const f = save?.flags ?? {};
      const first = f.EVENT_GOT_POKEDEX && !f.EVENT_BEAT_BROCK && !f.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE;
      const second = !first && f.EVENT_BEAT_GIOVANNI && !f.EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE;
      if (!first && !second)
        return null;
      if (ow.player)
        ow.player.facing = y === 4 ? "down" : "left";
      return route22Scene(first ? 1 : 2, y);
    }
  },
  ROUTE_12: {
    talk: { TEXT_ROUTE12_SNORLAX: [["show_text", "_Route12SnorlaxText"]] }
  },
  ROUTE_16: {
    talk: { TEXT_ROUTE16_SNORLAX: [["show_text", "_Route16Text7"]] }
  },
  ROUTE_16_FLY_HOUSE: {
    talk: {
      TEXT_ROUTE16FLYHOUSE_BRUNETTE_GIRL: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_HM02"],
        ["jump_if_true", 9],
        ["show_text", "_Route16FlyHouseBrunetteGirlText"],
        ["give_item", "HM_FLY", 1, "_Route16FlyHouseBrunetteGirlReceivedHM02Text"],
        ["set_flag", "EVENT_GOT_HM02"],
        ["show_text", "_Route16FlyHouseBrunetteGirlHM02ExplanationText"],
        ["jump", "end"],
        ["show_text", "_Route16FlyHouseBrunetteGirlHM02ExplanationText"]
      ]
    }
  },
  POWER_PLANT: {
    talk: {
      TEXT_POWERPLANT_VOLTORB1: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB1", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_0"),
      TEXT_POWERPLANT_VOLTORB2: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB2", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_1"),
      TEXT_POWERPLANT_VOLTORB3: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB3", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_2"),
      TEXT_POWERPLANT_ELECTRODE1: staticMon("POWER_PLANT", "POWERPLANT_ELECTRODE1", "_PowerPlantVoltorbBattleText", "ELECTRODE", 43, "EVENT_BEAT_POWER_PLANT_VOLTORB_3"),
      TEXT_POWERPLANT_VOLTORB4: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB4", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_4"),
      TEXT_POWERPLANT_VOLTORB5: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB5", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_5"),
      TEXT_POWERPLANT_ELECTRODE2: staticMon("POWER_PLANT", "POWERPLANT_ELECTRODE2", "_PowerPlantVoltorbBattleText", "ELECTRODE", 43, "EVENT_BEAT_POWER_PLANT_VOLTORB_6"),
      TEXT_POWERPLANT_VOLTORB6: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB6", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_7"),
      TEXT_POWERPLANT_ZAPDOS: staticMon("POWER_PLANT", "POWERPLANT_ZAPDOS", "_PowerPlantZapdosBattleText", "ZAPDOS", 50, "EVENT_BEAT_ZAPDOS")
    }
  },
  SEAFOAM_ISLANDS_B4F: {
    talk: {
      TEXT_SEAFOAMISLANDSB4F_ARTICUNO: staticMon("SEAFOAM_ISLANDS_B4F", "SEAFOAMISLANDSB4F_ARTICUNO", "_SeafoamIslandsB4FArticunoBattleText", "ARTICUNO", 50, "EVENT_BEAT_ARTICUNO")
    }
  },
  VICTORY_ROAD_2F: {
    talk: {
      TEXT_VICTORYROAD2F_MOLTRES: staticMon("VICTORY_ROAD_2F", "VICTORYROAD2F_MOLTRES", "_VictoryRoad2FMoltresBattleText", "MOLTRES", 50, "EVENT_BEAT_MOLTRES")
    }
  },
  CERULEAN_CAVE_B1F: {
    talk: {
      TEXT_CERULEANCAVEB1F_MEWTWO: staticMon("CERULEAN_CAVE_B1F", "CERULEANCAVEB1F_MEWTWO", "_MewtwoBattleText", "MEWTWO", 70, "EVENT_BEAT_MEWTWO")
    }
  },
  INDIGO_PLATEAU_LOBBY: {
    onEnter: (_ow, save) => {
      const f = save?.flags;
      if (!f)
        return;
      let started = !!f.EVENT_STARTED_ELITE_4;
      if (!started)
        started = E4_RESET_FLAGS.some((flag) => f[flag]);
      if (!started)
        return;
      delete f.EVENT_STARTED_ELITE_4;
      for (const flag of E4_RESET_FLAGS)
        delete f[flag];
      for (const key of E4_TRAINER_KEYS)
        delete save.defeatedTrainers?.[key];
    }
  },
  LANCES_ROOM: {
    onEnter: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_LANCE)
        return;
      const p = ow?.player;
      if (p?.cellX !== LANCE_STAIRS[0] || p?.cellY !== LANCE_STAIRS[1])
        return;
      startLanceWalkIn(ow);
    },
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_LANCE)
        return null;
      const p = ow?.player;
      if (p?.cellX === LANCE_STAIRS[0] && p?.cellY === LANCE_STAIRS[1]) {
        startLanceWalkIn(ow);
      }
      return null;
    }
  },
  LORELEIS_ROOM: {
    onEnter: (_ow, save) => {
      if (save?.flags)
        save.flags.EVENT_STARTED_ELITE_4 = true;
    }
  },
  CHAMPIONS_ROOM: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN)
        return null;
      if (ow?.runner?.isRunning?.())
        return null;
      return [
        ["face_object", "CHAMPIONSROOM_RIVAL", "down"],
        ["show_text", "_ChampionsRoomRivalIntroText"],
        ["rival_battle", "OPP_RIVAL3", 1],
        ["jump_if_false", "end"],
        ["set_flag", "EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN"],
        ["set_flag", "EVENT_BEAT_CHAMPION_RIVAL"],
        ["show_text", "_ChampionsRoomRivalAfterBattleText"],
        ["show_text", "_ChampionsRoomOakText"],
        ["show_object", "CHAMPIONS_ROOM", "CHAMPIONSROOM_OAK"],
        ["walk_npc", "CHAMPIONSROOM_OAK", ["up", "up", "up", "up", "up"]],
        ["face_object", "CHAMPIONSROOM_RIVAL", "left"],
        ["face_object", "CHAMPIONSROOM_OAK", "down"],
        ["show_text", "_ChampionsRoomOakCongratulatesPlayerText"],
        ["face_object", "CHAMPIONSROOM_OAK", "right"],
        ["show_text", "_ChampionsRoomOakDisappointedWithRivalText"],
        ["face_object", "CHAMPIONSROOM_OAK", "down"],
        ["show_text", "_ChampionsRoomOakComeWithMeText"],
        ["walk_npc", "CHAMPIONSROOM_OAK", ["up", "up"]],
        ["hide_object", "CHAMPIONS_ROOM", "CHAMPIONSROOM_OAK"],
        ["set_flag", "EVENT_HALL_OF_FAME_PENDING"],
        ["move_player", "up", 3],
        ["warp", "HALL_OF_FAME", 4, 7, "up"]
      ];
    }
  },
  HALL_OF_FAME: {
    onStep: (ow, save) => {
      if (!save?.flags?.EVENT_HALL_OF_FAME_PENDING)
        return null;
      if (ow?.runner?.isRunning?.())
        return null;
      return [
        ["clear_flag", "EVENT_HALL_OF_FAME_PENDING"],
        ["move_player", "up", 5],
        ["face_object", "HALLOFFAME_OAK", "left"],
        ["show_text", "_HallOfFameOakText"],
        ["record_hall_of_fame"]
      ];
    }
  },
  POKEMON_TOWER_2F: {
    talk: {
      TEXT_POKEMONTOWER2F_RIVAL: (ow) => towerRivalScript(ow?.player?.cellX ?? 0)
    },
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_POKEMON_TOWER_RIVAL)
        return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!(x === 15 && y === 5 || x === 14 && y === 6))
        return null;
      if (p)
        p.facing = x === 15 ? "left" : "up";
      return towerRivalScript(x);
    }
  },
  VIRIDIAN_MART: {
    onStep: (_ow, save) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_STARTER)
        return null;
      if (f.EVENT_GOT_OAKS_PARCEL || f.EVENT_OAK_GOT_PARCEL)
        return null;
      return [
        ["show_text", "_ViridianMartClerkYouCameFromPalletTownText"],
        ["move_player", "up", 2],
        ["move_player", "left", 1],
        ["give_item", "OAKS_PARCEL", 1, "_ViridianMartClerkParcelQuestText"],
        ["set_flag", "EVENT_GOT_OAKS_PARCEL"]
      ];
    }
  },
  VIRIDIAN_CITY: {
    talk: {
      TEXT_VIRIDIANCITY_FISHER: giftRows({
        flag: "EVENT_GOT_TM42",
        item: "TM_DREAM_EATER",
        pre: `Yawn!
I must have dozed\voff in the sun.` + `\fI had this dream
about a DROWZEE\veating my dream.` + "\vWhat's this?\vWhere did this TM\vcome from?" + `\fThis is spooky!
Here, you can\vhave this TM.`,
        received: "_ViridianCityFisherReceivedTM42Text",
        explain: "_ViridianCityFisherTM42ExplanationText",
        already: "_ViridianCityFisherTM42ExplanationText"
      }),
      TEXT_VIRIDIANCITY_GAMBLER1: (_ow, save) => [
        ["face_player"],
        [
          "show_text",
          hasSevenBadges(save) && !save?.flags?.EVENT_BEAT_GIOVANNI ? "_ViridianCityGambler1GymLeaderReturnedText" : "_ViridianCityGambler1GymAlwaysClosedText"
        ]
      ],
      TEXT_VIRIDIANCITY_OLD_MAN_SLEEPY: [
        ["show_text", "_ViridianCityOldManSleepyPrivatePropertyText"],
        ["move_player", "down", 1]
      ],
      TEXT_VIRIDIANCITY_OLD_MAN: [
        ["face_player"],
        ["ask", "_ViridianCityOldManHadMyCoffeeNowText"],
        ["jump_if_true", 8],
        ["show_text", "_ViridianCityOldManKnowHowToCatchPokemonText"],
        ["old_man_demo"],
        ["show_text", "_ViridianCityOldManYouNeedToWeakenTheTargetText"],
        ["jump", 9],
        ["show_text", "_ViridianCityOldManTimeIsMoneyText"]
      ]
    },
    onStep: (ow, save) => {
      const gym = lockedDoorStep(ow, [[32, 8]], !hasSevenBadges(save), "_ViridianCityGymLockedText");
      if (gym)
        return gym;
      const f = save?.flags ?? {};
      if (f.EVENT_GOT_POKEDEX) {
        const w = ow;
        const s = w.save;
        s.objectToggles = s.objectToggles ?? {};
        const t = s.objectToggles.VIRIDIAN_CITY = s.objectToggles.VIRIDIAN_CITY ?? {};
        if (t.VIRIDIANCITY_OLD_MAN_SLEEPY !== false || t.VIRIDIANCITY_OLD_MAN !== true) {
          t.VIRIDIANCITY_OLD_MAN_SLEEPY = false;
          t.VIRIDIANCITY_OLD_MAN = true;
          w.setObjectHidden?.("VIRIDIANCITY_OLD_MAN_SLEEPY", true);
          w.setObjectHidden?.("VIRIDIANCITY_OLD_MAN", false);
        }
        return null;
      }
      const px2 = ow?.player?.cellX;
      const py = ow?.player?.cellY;
      if (px2 === 19 && py === 9) {
        return [
          ["show_text", "_ViridianCityOldManSleepyPrivatePropertyText"],
          ["move_player", "down", 1]
        ];
      }
      return null;
    }
  },
  OAKS_LAB_ONSTEP_HOST: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_STARTER)
        return null;
      if (f.EVENT_BATTLED_RIVAL_IN_OAKS_LAB)
        return null;
      const py = ow?.player?.cellY;
      if (py !== 9)
        return null;
      const px2 = ow?.player?.cellX ?? 5;
      const party = f.EVENT_CHOSE_BULBASAUR ? 3 : f.EVENT_CHOSE_SQUIRTLE ? 1 : 2;
      return sceneWithTheme(MEET_RIVAL, [
        ["move_npc_to", "SPRITE_BLUE", px2, 10],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeYouOnText"],
        ["start_battle", "trainer", "OPP_RIVAL1", party, { loseable: true }],
        ["set_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["show_text", "_OaksLabRivalSmellYouLaterText"],
        ["move_npc_to", "SPRITE_BLUE", 4, 11],
        ["hide_object", "OAKS_LAB", "SPRITE_BLUE"]
      ]);
    }
  },
  OAKS_LAB: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER) {
        if (!ow.findNpc?.("SPRITE_OAK"))
          ow.placeNpc?.("SPRITE_OAK", 5, 2, "down");
      }
      return null;
    },
    talk: {
      TEXT_OAKSLAB_OAK1: [
        ["face_player"],
        ["check_flag", "EVENT_PALLET_AFTER_GETTING_POKEBALLS"],
        ["jump_if_true", "dex_rating"],
        ["check_dex_owned", 2],
        ["jump_if_false", "no_rating"],
        ["check_flag", "EVENT_GOT_POKEDEX"],
        ["jump_if_true", "dex_rating"],
        ["label", "no_rating"],
        ["check_item", "POKE_BALL"],
        ["jump_if_true", "come_see"],
        ["check_flag", "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE"],
        ["jump_if_true", "give_balls"],
        ["check_flag", "EVENT_GOT_POKEDEX"],
        ["jump_if_true", "around_world"],
        ["check_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["jump_if_false", "pre_lab_battle"],
        ["check_item", "OAKS_PARCEL"],
        ["jump_if_false", "raise_young"],
        ["show_text", "_OaksLabOak1DeliverParcelText"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabOak1ParcelThanksText"],
        ["take_item", "OAKS_PARCEL", 1],
        ["stop_music"],
        ["play_music", "Music_MeetRival"],
        ["show_text", "_OaksLabRivalGrampsText"],
        ["place_npc", "SPRITE_BLUE", 4, 7, "up"],
        ["move_npc_to", "SPRITE_BLUE", 4, 3],
        ["play_music", "Music_OaksLab"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabRivalWhatDidYouCallMeForText"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakIHaveARequestText"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakMyInventionPokedexText"],
        ["show_text", "_OaksLabOakGotPokedexText"],
        ["play_sound", "Get_Key_Item"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_POKEDEX1"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_POKEDEX2"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakThatWasMyDreamText"],
        ["face_object", "SPRITE_BLUE", "right"],
        ["show_text", "_OaksLabRivalLeaveItAllToMeText"],
        ["set_flag", "EVENT_GOT_POKEDEX"],
        ["set_flag", "EVENT_OAK_GOT_PARCEL"],
        ["hide_object", "VIRIDIAN_CITY", "VIRIDIANCITY_OLD_MAN_SLEEPY"],
        ["show_object", "VIRIDIAN_CITY", "VIRIDIANCITY_OLD_MAN"],
        ["stop_music"],
        ["play_music", "Music_MeetRival"],
        ["move_npc_to", "SPRITE_BLUE", 4, 7],
        ["hide_object", "OAKS_LAB", "SPRITE_BLUE"],
        ["play_music", "Music_OaksLab"],
        ["set_flag", "EVENT_1ST_ROUTE22_RIVAL_BATTLE"],
        ["clear_flag", "EVENT_2ND_ROUTE22_RIVAL_BATTLE"],
        ["set_flag", "EVENT_ROUTE22_RIVAL_WANTS_BATTLE"],
        ["show_object", "ROUTE_22", "ROUTE22_RIVAL1"],
        ["jump", "end"],
        ["label", "raise_young"],
        ["show_text", "_OaksLabOak1RaiseYourYoungPokemonText"],
        ["jump", "end"],
        ["label", "pre_lab_battle"],
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "can_fight"],
        ["show_text", "_OaksLabOak1WhichPokemonDoYouWantText"],
        ["jump", "end"],
        ["label", "can_fight"],
        ["show_text", "_OaksLabOak1YourPokemonCanFightText"],
        ["jump", "end"],
        ["label", "around_world"],
        ["show_text", "_OaksLabOak1PokemonAroundTheWorldText"],
        ["jump", "end"],
        ["label", "give_balls"],
        ["check_flag", "EVENT_GOT_POKEBALLS_FROM_OAK"],
        ["jump_if_true", "come_see"],
        ["set_flag", "EVENT_GOT_POKEBALLS_FROM_OAK"],
        ["give_item", "POKE_BALL", 5, false],
        ["show_text", "_OaksLabOak1ReceivedPokeballsText"],
        ["show_text", "_OaksLabGivePokeballsExplanationText"],
        ["jump", "end"],
        ["label", "come_see"],
        ["show_text", "_OaksLabOak1ComeSeeMeSometimesText"],
        ["jump", "end"],
        ["label", "dex_rating"],
        ["show_text", "_OaksLabOak1HowIsYourPokedexComingText"],
        ["dex_rating"]
      ],
      TEXT_OAKSLAB_BULBASAUR_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantBulbasaurText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "BULBASAUR", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_BULBASAUR"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_BULBASAUR_POKE_BALL"],
        ["move_npc_to", "SPRITE_BLUE", 6, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_CHARMANDER_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"]
      ],
      TEXT_OAKSLAB_CHARMANDER_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantCharmanderText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "CHARMANDER", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_CHARMANDER"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_CHARMANDER_POKE_BALL"],
        ["move_npc_to", "SPRITE_BLUE", 7, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_SQUIRTLE_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"]
      ],
      TEXT_OAKSLAB_SQUIRTLE_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantSquirtleText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "SQUIRTLE", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_SQUIRTLE"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_SQUIRTLE_POKE_BALL"],
        ["move_npc_to", "SPRITE_BLUE", 8, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_BULBASAUR_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"]
      ]
    }
  },
  REDS_HOUSE_1F: {
    talk: {
      TEXT_REDSHOUSE1F_MOM: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", 6],
        ["show_text", "_RedsHouse1FMomWakeUpText"],
        ["jump", "end"],
        ["show_text", "_RedsHouse1FMomYouShouldRestText"],
        ["fade", "out", "white"],
        ["heal_party"],
        ["play_once", "Music_PkmnHealed"],
        ["fade", "in", "white"],
        ["show_text", "_RedsHouse1FMomLookingGreatText"]
      ]
    }
  },
  BLUES_HOUSE: {
    talk: {
      TEXT_BLUESHOUSE_DAISY_SITTING: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_TOWN_MAP"],
        ["jump_if_true", 10],
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_false", 12],
        ["show_text", "_BluesHouseDaisyOfferMapText"],
        ["give_item", "TOWN_MAP", 1, "_GotMapText"],
        ["set_flag", "EVENT_GOT_TOWN_MAP"],
        ["jump", "end"],
        ["show_text", "_BluesHouseDaisyUseMapText"],
        ["jump", "end"],
        ["show_text", "_BluesHouseDaisyRivalAtLabText"]
      ]
    }
  },
  PALLET_TOWN: {
    talk: {
      TEXT_PALLETTOWN_OAK: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", 6],
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"],
        ["jump", "end"],
        ["show_text", "_PalletTownOakItsUnsafeText"]
      ]
    },
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER)
        return null;
      const cy = ow?.player?.cellY;
      if (cy !== 1)
        return null;
      const LAB_DOOR_X = 12, LAB_DOOR_Y = 11;
      const px2 = ow?.player?.cellX ?? 0;
      const py = ow?.player?.cellY ?? 0;
      return [
        ["place_npc", "SPRITE_OAK", px2, py + 4, "up"],
        ["move_npc_to", "SPRITE_OAK", px2, py + 1],
        ["face_object", "SPRITE_OAK", "up"],
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"],
        ["show_text", "_PalletTownOakItsUnsafeText"],
        ["move_npc_to", "SPRITE_OAK", LAB_DOOR_X, LAB_DOOR_Y],
        ["move_player_to", LAB_DOOR_X, LAB_DOOR_Y + 1],
        ["warp", "OAKS_LAB", 5, 11, "up"],
        ["place_npc", "SPRITE_OAK", 5, 2, "down"],
        ["move_player", "up", 8],
        ["set_flag", "EVENT_FOLLOWED_OAK_INTO_LAB"],
        ["show_text", "_OaksLabRivalFedUpWithWaitingText"],
        ["show_text", "_OaksLabOakChooseMonText"],
        ["show_text", "_OaksLabRivalWhatAboutMeText"],
        ["show_text", "_OaksLabOakBePatientText"],
        ["set_flag", "EVENT_OAK_ASKED_TO_CHOOSE_MON"]
      ];
    }
  },
  PEWTER_GYM: {
    talk: {
      TEXT_PEWTERGYM_BROCK: gymLeader({
        trainerClass: "OPP_BROCK",
        beatFlag: "EVENT_BEAT_BROCK",
        preText: "_PewterGymBrockPreBattleText",
        deactivate: ["EVENT_BEAT_PEWTER_GYM_TRAINER_0"],
        badge: "BOULDERBADGE",
        badgeText: [
          "_PewterGymBrockReceivedBoulderBadgeText",
          "_PewterGymBrockBoulderBadgeInfoText"
        ],
        tmPre: "_PewterGymBrockWaitTakeThisText",
        tm: "TM_BIDE",
        gotFlag: "EVENT_GOT_TM34",
        tmText: ["_PewterGymReceivedTM34Text", "_TM34ExplanationText"],
        advice: "_PewterGymBrockPostBattleAdviceText"
      })
    }
  },
  ROUTE_5_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_5_GATE),
  ROUTE_6_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_6_GATE),
  ROUTE_7_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_7_GATE),
  ROUTE_8_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_8_GATE),
  SAFARI_ZONE_GATE: {
    talk: {
      TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1: (_ow, save) => {
        if (save?.safari) {
          return [["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"]];
        }
        return [
          ["face_player"],
          ["show_text", "_SafariZoneGateSafariZoneWorker1Text"],
          ...safariJoinRows()
        ];
      }
    },
    onStep: (ow, save) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (save?.safari) {
        return y !== undefined && y <= 1 ? safariLeavingRows(x !== 3) : null;
      }
      const at = SAFARI_JOIN_CELLS.some(([cx, cy]) => cx === x && cy === y);
      return at ? safariJoinRows() : null;
    }
  },
  CERULEAN_GYM: {
    talk: {
      TEXT_CERULEANGYM_MISTY: MISTY_GYM
    }
  },
  CELADON_GYM: {
    talk: {
      TEXT_CELADONGYM_ERIKA: gymLeader({
        trainerClass: "OPP_ERIKA",
        beatFlag: "EVENT_BEAT_ERIKA",
        preText: "_CeladonGymErikaPreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_CELADON_GYM_TRAINER_", 6),
        badge: "RAINBOWBADGE",
        badgeText: ["_CeladonGymErikaReceivedRainbowBadgeText"],
        tmPre: "_CeladonGymRainbowBadgeInfoText",
        tm: "TM_MEGA_DRAIN",
        gotFlag: "EVENT_GOT_TM21",
        tmText: ["_CeladonGymReceivedTM21Text", "_TM21ExplanationText"],
        advice: "_CeladonGymErikaPostBattleAdviceText"
      })
    }
  },
  FUCHSIA_GYM: {
    talk: {
      TEXT_FUCHSIAGYM_KOGA: gymLeader({
        trainerClass: "OPP_KOGA",
        beatFlag: "EVENT_BEAT_KOGA",
        preText: "_FuchsiaGymKogaBeforeBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_FUCHSIA_GYM_TRAINER_", 5),
        badge: "SOULBADGE",
        badgeText: ["_FuchsiaGymKogaReceivedSoulBadgeText"],
        tmPre: "_FuchsiaGymKogaSoulBadgeInfoText",
        tm: "TM_TOXIC",
        gotFlag: "EVENT_GOT_TM06",
        tmText: ["_FuchsiaGymKogaReceivedTM06Text", "_FuchsiaGymKogaTM06ExplanationText"],
        advice: "_FuchsiaGymKogaPostBattleAdviceText"
      })
    }
  },
  SAFFRON_GYM: {
    talk: {
      TEXT_SAFFRONGYM_SABRINA: gymLeader({
        trainerClass: "OPP_SABRINA",
        beatFlag: "EVENT_BEAT_SABRINA",
        preText: "_SaffronGymSabrinaText",
        deactivate: gymTrainerFlags("EVENT_BEAT_SAFFRON_GYM_TRAINER_", 6),
        badge: "MARSHBADGE",
        badgeText: ["_SaffronGymSabrinaReceivedMarshBadgeText"],
        tmPre: "_SaffronGymSabrinaMarshBadgeInfoText",
        tm: "TM_PSYWAVE",
        gotFlag: "EVENT_GOT_TM46",
        tmText: ["_SaffronGymSabrinaReceivedTM46Text", "_TM46ExplanationText"],
        advice: "_SaffronGymSabrinaPostBattleAdviceText"
      })
    }
  },
  CINNABAR_GYM: {
    talk: {
      TEXT_CINNABARGYM_BLAINE: gymLeader({
        trainerClass: "OPP_BLAINE",
        beatFlag: "EVENT_BEAT_BLAINE",
        preText: "_CinnabarGymBlainePreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_CINNABAR_GYM_TRAINER_", 6),
        badge: "VOLCANOBADGE",
        badgeText: ["_CinnabarGymBlaineReceivedVolcanoBadgeText"],
        tmPre: "_CinnabarGymBlaineVolcanoBadgeInfoText",
        tm: "TM_FIRE_BLAST",
        gotFlag: "EVENT_GOT_TM38",
        tmText: ["_CinnabarGymBlaineReceivedTM38Text", "_CinnabarGymBlaineTM38ExplanationText"],
        advice: "_CinnabarGymBlainePostBattleAdviceText"
      })
    }
  },
  VIRIDIAN_GYM: {
    talk: {
      TEXT_VIRIDIANGYM_GIOVANNI: gymLeader({
        trainerClass: "OPP_GIOVANNI",
        party: 3,
        beatFlag: "EVENT_BEAT_GIOVANNI",
        preText: "_ViridianGymGiovanniPreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_VIRIDIAN_GYM_TRAINER_", 7),
        badge: "EARTHBADGE",
        badgeText: ["_ViridianGymGiovanniReceivedEarthBadgeText"],
        tmPre: "_ViridianGymGiovanniEarthBadgeInfoText",
        tm: "TM_FISSURE",
        gotFlag: "EVENT_GOT_TM27",
        tmText: [
          "_ViridianGymGiovanniReceivedTM27Text",
          "_ViridianGymGiovanniTM27ExplanationText"
        ],
        advice: "_ViridianGymGiovanniPostBattleAdviceText",
        afterAdvice: [["hide_object", "VIRIDIAN_GYM", "VIRIDIANGYM_GIOVANNI"]]
      })
    }
  },
  ROUTE_24: {
    talk: {
      TEXT_ROUTE24_COOLTRAINER_M1: route24RecruiterScript
    },
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_GOT_NUGGET)
        return null;
      const p = ow?.player;
      if (p?.cellX !== 10 || p?.cellY !== 15)
        return null;
      return route24RecruiterScript(ow, save);
    }
  },
  CERULEAN_CITY: {
    talk: {
      TEXT_CERULEANCITY_ROCKET: ceruleanRocketRows,
      TEXT_CERULEANCITY_COOLTRAINER_F1: [
        ["face_player"],
        ["random_text", [
          [180, "_CeruleanCityCooltrainerF1SlowbroUseSonicboomText"],
          [100, "_CeruleanCityCooltrainerF1SlowbroPunchText"],
          [0, "_CeruleanCityCooltrainerF1SlowbroWithdrawText"]
        ]]
      ]
    },
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!f.EVENT_BEAT_CERULEAN_ROCKET_THIEF && (x === 30 && y === 7 || x === 30 && y === 9)) {
        return ceruleanRocketRows;
      }
      if (!f.EVENT_BEAT_CERULEAN_RIVAL && (x === 20 && y === 6 || x === 21 && y === 6)) {
        return ceruleanRivalRows(x);
      }
      return null;
    }
  },
  BILLS_HOUSE: {
    talk: {
      TEXT_BILLSHOUSE_BILL_POKEMON: billsHousePokemonRows,
      TEXT_BILLSHOUSE_BILL_SS_TICKET: billsHouseSsTicketRows,
      TEXT_BILLSHOUSE_BILL_CHECK_OUT_MY_RARE_POKEMON: billsHouseRarePokemonRows,
      [TEXT_BILLSHOUSE_PC]: billsHousePcScript
    }
  },
  ROUTE_25: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_SS_TICKET || f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING)
        return null;
      f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING = true;
      ow.setObjectHidden?.("ROUTE24_COOLTRAINER_M1", true);
      ow.setObjectHidden?.("BILLSHOUSE_BILL1", true);
      ow.setObjectHidden?.("BILLSHOUSE_BILL2", false);
      return null;
    }
  },
  CERULEAN_TRASHED_HOUSE: {
    talk: {
      TEXT_CERULEANTRASHEDHOUSE_FISHING_GURU: trashedHouseFishingGuruRows
    }
  },
  VERMILION_GYM: {
    talk: {
      TEXT_VERMILIONGYM_LT_SURGE: LT_SURGE_GYM
    }
  },
  VERMILION_CITY: {
    talk: {
      TEXT_VERMILIONCITY_SAILOR1: (_ow, save) => vermilionSailorRows(save)
    },
    onStep: (ow, save) => {
      const p = ow?.player;
      if (p?.cellX !== 18 || p?.cellY !== 30 || p?.facing !== "down")
        return null;
      return vermilionSailorRows(save);
    }
  },
  VERMILION_DOCK: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const mapId = ow?.map?.def?.index;
      if (f.EVENT_SS_ANNE_LEFT) {
        return [
          ["show_text", "_VermilionCitySailor1ShipSetSailText"],
          ["warp", "VERMILION_CITY", 18, 31, "up"]
        ];
      }
      if (f.EVENT_GOT_HM01 && p?.cellY === 2 && typeof mapId === "number") {
        const hideHullColumn = (cx0) => {
          const rows = [];
          for (let cx = cx0;cx < cx0 + 2; cx++) {
            for (let cy = 3;cy <= 5; cy++)
              rows.push(["stamp", mapId, cx, cy, false]);
          }
          rows.push(["wait", 20]);
          return rows;
        };
        return [
          ["set_flag", "EVENT_SS_ANNE_LEFT"],
          ["play_sound", "SS_Anne_Horn"],
          ["wait", 40],
          ...hideHullColumn(10),
          ...hideHullColumn(12),
          ...hideHullColumn(14),
          ...hideHullColumn(16),
          ["play_sound", "SS_Anne_Horn"],
          ["wait", 60],
          ["warp", "VERMILION_CITY", 18, 31, "up"]
        ];
      }
      return null;
    }
  },
  SS_ANNE_2F: {
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_SS_ANNE_RIVAL)
        return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (y !== 8 || x !== 36 && x !== 37)
        return null;
      const onLeft = x === 36;
      if (p)
        p.facing = onLeft ? "up" : "left";
      return sceneWithTheme(MEET_RIVAL, [
        ["show_object", "SS_ANNE_2F", "SSANNE2F_RIVAL"],
        ["move_npc_to", "SSANNE2F_RIVAL", 36, onLeft ? 7 : 8],
        ["face_object", "SSANNE2F_RIVAL", onLeft ? "down" : "right"],
        ["show_text", "_SSAnne2FRivalText"],
        ["rival_battle", "OPP_RIVAL2", 1],
        ["jump_if_false", 11],
        ["set_flag", "EVENT_BEAT_SS_ANNE_RIVAL"],
        ["show_text", "_SSAnne2FRivalDefeatedText"],
        ["show_text", "_SSAnne2FRivalCutMasterText"],
        [
          "walk_npc",
          "SSANNE2F_RIVAL",
          onLeft ? ["right", "down", "down", "down", "down", "down"] : ["down", "down", "down", "down"]
        ],
        ["hide_object", "SS_ANNE_2F", "SSANNE2F_RIVAL"]
      ]);
    }
  },
  GAME_CORNER_PRIZE_ROOM: {
    talk: {
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1: prizeCounterRows(1),
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_2: prizeCounterRows(2),
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_3: prizeCounterRows(3)
    }
  },
  ROUTE_2_GATE: {
    talk: {
      TEXT_ROUTE2GATE_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE2GATE_OAKS_AIDE"]
      ],
      TEXT_ROUTE2GATE_YOUNGSTER: [
        ["face_player"],
        ["show_text", "_Route2GateYoungsterText"]
      ]
    }
  },
  ROUTE_11_GATE_2F: {
    talk: {
      TEXT_ROUTE11GATE2F_YOUNGSTER: tradeRows(1, "EVENT_TRADED_NIDORINO_FOR_NIDORINA"),
      TEXT_ROUTE11GATE2F_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE11GATE2F_OAKS_AIDE"]
      ]
    }
  },
  ROUTE_15_GATE_2F: {
    talk: {
      TEXT_ROUTE15GATE2F_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE15GATE2F_OAKS_AIDE"]
      ]
    }
  },
  CINNABAR_ISLAND: {
    onStep: (ow, save) => lockedDoorStep(ow, [[18, 4]], (save?.inventory?.SECRET_KEY ?? 0) <= 0, "_CinnabarIslandDoorIsLockedText"),
    onEnter: (_ow, save) => {
      if (save?.flags)
        delete save.flags.EVENT_LAB_STILL_REVIVING_FOSSIL;
    }
  },
  ROUTE_2_TRADE_HOUSE: {
    talk: { TEXT_ROUTE2TRADEHOUSE_GAMEBOY_KID: tradeRows(2, "EVENT_TRADED_ABRA_FOR_MR_MIME") }
  },
  CERULEAN_TRADE_HOUSE: {
    talk: { TEXT_CERULEANTRADEHOUSE_GAMBLER: tradeRows(7, "EVENT_TRADED_POLIWHIRL_FOR_JYNX") }
  },
  VERMILION_TRADE_HOUSE: {
    talk: { TEXT_VERMILIONTRADEHOUSE_LITTLE_GIRL: tradeRows(5, "EVENT_TRADED_SPEAROW_FOR_FARFETCHD") }
  },
  UNDERGROUND_PATH_ROUTE_5: {
    talk: { TEXT_UNDERGROUNDPATHROUTE5_LITTLE_GIRL: tradeRows(10, "EVENT_TRADED_NIDORAN_M_FOR_NIDORAN_F") }
  },
  ROUTE_18_GATE_2F: {
    talk: { TEXT_ROUTE18GATE2F_YOUNGSTER: tradeRows(6, "EVENT_TRADED_SLOWBRO_FOR_LICKITUNG") }
  },
  CINNABAR_LAB_TRADE_ROOM: {
    talk: {
      TEXT_CINNABARLABTRADEROOM_GRAMPS: tradeRows(8, "EVENT_TRADED_RAICHU_FOR_ELECTRODE"),
      TEXT_CINNABARLABTRADEROOM_BEAUTY: tradeRows(9, "EVENT_TRADED_VENONAT_FOR_TANGELA")
    }
  },
  MUSEUM_1F: {
    onStep: (ow, save) => {
      const p = ow?.player;
      if (save?.flags?.EVENT_BOUGHT_MUSEUM_TICKET)
        return null;
      if (p?.cellY !== 4 || p?.cellX !== 9 && p?.cellX !== 10)
        return null;
      return museumTicketRows(true);
    },
    talk: {
      TEXT_MUSEUM1F_SCIENTIST1: (ow, save) => {
        if (save?.flags?.EVENT_BOUGHT_MUSEUM_TICKET) {
          return [["face_player"], ["show_text", "_Museum1FScientist1TakePlentyOfTimeText"]];
        }
        const x = ow?.player?.cellX ?? 0;
        if (x === 12)
          return [["face_player"], ["show_text", "_Museum1FScientist1GoToOtherSideText"]];
        if (x > 12) {
          return [
            ["face_player"],
            ["ask", "_Museum1FScientist1DoYouKnowWhatAmberIsText"],
            ["jump_if_false", "explain"],
            ["show_text", "_Museum1FScientist1TheresALabSomewhereText"],
            ["jump", "end"],
            ["label", "explain"],
            ["show_text", "_Museum1FScientist1AmberIsFossilizedTreeSapText"]
          ];
        }
        return [["face_player"], ...museumTicketRows(false)];
      },
      TEXT_MUSEUM1F_SCIENTIST2: (_ow, save) => save?.flags?.EVENT_GOT_OLD_AMBER ? [["face_player"], ["show_text", "_Museum1FScientist2GetTheOldAmberCheckText"]] : [
        ["face_player"],
        ["show_text", "_Museum1FScientist2TakeThisToAPokemonLabText"],
        ["give_item", "OLD_AMBER", 1, "_Museum1FScientist2ReceivedOldAmberText"],
        ["set_flag", "EVENT_GOT_OLD_AMBER"],
        ["hide_object", "MUSEUM_1F", "MUSEUM1F_OLD_AMBER"]
      ],
      TEXT_MUSEUM1F_OLD_AMBER: [["show_text", "_Museum1FOldAmberText"]],
      TEXT_MUSEUM1F_GAMBLER: [["face_player"], ["show_text", "_Museum1FGamblerText"]],
      TEXT_MUSEUM1F_SCIENTIST3: [["face_player"], ["show_text", "_Museum1FScientist3Text"]]
    }
  },
  CINNABAR_LAB_FOSSIL_ROOM: {
    talk: {
      TEXT_CINNABARLABFOSSILROOM_SCIENTIST1: fossilScientistRows,
      TEXT_CINNABARLABFOSSILROOM_SCIENTIST2: tradeRows(4, "EVENT_TRADED_PONYTA_FOR_SEEL")
    }
  },
  SILPH_CO_11F: {
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_GIOVANNI)
        return null;
      const x = ow?.player?.cellX;
      const y = ow?.player?.cellY;
      if (!(x === 6 && y === 13 || x === 7 && y === 12))
        return null;
      return [
        ["show_text", "_SilphCo11FGiovanniText"],
        ["walk_npc", "SILPHCO11F_GIOVANNI", ["down", "down", "down"]],
        ["face_object", "SILPHCO11F_GIOVANNI", "down"],
        ["start_battle", "trainer", "OPP_GIOVANNI", 2],
        ["jump_if_false", "end"],
        ["set_flag", "EVENT_BEAT_SILPH_CO_GIOVANNI"],
        ...silphAftermathRows(),
        ["label", "end"]
      ];
    },
    talk: {
      TEXT_SILPHCO11F_SILPH_PRESIDENT: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_MASTER_BALL"],
        ["jump_if_true", "already"],
        ["show_text", "_SilphCo11FSilphPresidentText"],
        ["give_item", "MASTER_BALL", 1, "_SilphCo11FSilphPresidentReceivedMasterBallText"],
        ["set_flag", "EVENT_GOT_MASTER_BALL"],
        ["show_text", "_SilphCo11FSilphPresidentMasterBallDescriptionText"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SilphCo11FSilphPresidentMasterBallDescriptionText"],
        ["label", "end"]
      ],
      TEXT_SILPHCO11F_BEAUTY: [["face_player"], ["show_text", "_SilphCo11FBeautyText"]]
    }
  },
  SAFARI_ZONE_SECRET_HOUSE: {
    talk: {
      TEXT_SAFARIZONESECRETHOUSE_FISHING_GURU: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_HM03"],
        ["jump_if_true", "already"],
        ["show_text", "_SafariZoneSecretHouseFishingGuruYouHaveWonText"],
        ["give_item", "HM_SURF", 1, "_SafariZoneSecretHouseFishingGuruReceivedHM03Text"],
        ["set_flag", "EVENT_GOT_HM03"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SafariZoneSecretHouseFishingGuruHM03ExplanationText"],
        ["label", "end"]
      ]
    }
  },
  WARDENS_HOUSE: {
    talk: {
      TEXT_WARDENSHOUSE_WARDEN: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_HM04"],
        ["jump_if_true", "gotHm04"],
        ["check_item", "GOLD_TEETH"],
        ["jump_if_false", "noTeeth"],
        ["show_text", "_WardensHouseWardenGaveTheGoldTeethText"],
        ["show_text", "_WardensHouseWardenTeethPoppedInHisTeethText"],
        ["take_item", "GOLD_TEETH", 1],
        ["set_flag", "EVENT_GAVE_GOLD_TEETH"],
        ["show_text", "_WardensHouseWardenThanksText"],
        ["give_item", "HM_STRENGTH", 1, "_WardensHouseWardenReceivedHM04Text"],
        ["set_flag", "EVENT_GOT_HM04"],
        ["jump", "end"],
        ["label", "noTeeth"],
        ["ask", "_WardensHouseWardenGibberish1Text"],
        ["jump_if_true", "gibberishYes"],
        ["show_text", "_WardensHouseWardenGibberish3Text"],
        ["jump", "end"],
        ["label", "gibberishYes"],
        ["show_text", "_WardensHouseWardenGibberish2Text"],
        ["jump", "end"],
        ["label", "gotHm04"],
        ["show_text", "_WardensHouseWardenHM04ExplanationText"],
        ["label", "end"]
      ],
      TEXT_WARDENSHOUSE_BOULDER: [["show_text", "_WardensHouseDisplayMerchandiseText"]]
    }
  },
  BIKE_SHOP: {
    talk: {
      TEXT_BIKESHOP_CLERK: [["face_player"], ["open_bike_shop"]],
      TEXT_BIKESHOP_MIDDLE_AGED_WOMAN: [
        ["face_player"],
        ["show_text", "_BikeShopMiddleAgedWomanText"]
      ],
      TEXT_BIKESHOP_YOUNGSTER: [
        ["face_player"],
        ["check_item", "BICYCLE"],
        ["jump_if_true", "gotBike"],
        ["show_text", "_BikeShopYoungsterTheseBikesAreExpensiveText"],
        ["jump", "end"],
        ["label", "gotBike"],
        ["show_text", "_BikeShopYoungsterCoolBikeText"],
        ["label", "end"]
      ]
    }
  },
  POKEMON_FAN_CLUB: {
    talk: {
      TEXT_POKEMONFANCLUB_CHAIRMAN: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_BIKE_VOUCHER"],
        ["jump_if_true", "already"],
        ["ask", "_PokemonFanClubChairmanIntroText"],
        ["jump_if_false", "noStory"],
        ["show_text", "_PokemonFanClubChairmanStoryText"],
        ["give_item", "BIKE_VOUCHER", 1, "_PokemonFanClubReceivedBikeVoucherText"],
        ["set_flag", "EVENT_GOT_BIKE_VOUCHER"],
        ["show_text", "_PokemonFanClubExplainBikeVoucherText"],
        ["jump", "end"],
        ["label", "noStory"],
        ["show_text", "_PokemonFanClubNoStoryText"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_PokemonFanClubChairFinalText"],
        ["label", "end"]
      ],
      TEXT_POKEMONFANCLUB_PIKACHU_FAN: [
        ["face_player"],
        ["check_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["jump_if_true", "better"],
        ["show_text", "_PokemonFanClubPikachuFanNormalText"],
        ["set_flag", "EVENT_SEEL_FAN_BOAST"],
        ["jump", "end"],
        ["label", "better"],
        ["show_text", "_PokemonFanClubPikachuFanBetterText"],
        ["clear_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["label", "end"]
      ],
      TEXT_POKEMONFANCLUB_SEEL_FAN: [
        ["face_player"],
        ["check_flag", "EVENT_SEEL_FAN_BOAST"],
        ["jump_if_true", "better"],
        ["show_text", "_PokemonFanClubSeelFanNormalText"],
        ["set_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["jump", "end"],
        ["label", "better"],
        ["show_text", "_PokemonFanClubSeelFanBetterText"],
        ["clear_flag", "EVENT_SEEL_FAN_BOAST"],
        ["label", "end"]
      ],
      TEXT_POKEMONFANCLUB_PIKACHU: [["show_text", "_PokemonFanClubPikachuText"]],
      TEXT_POKEMONFANCLUB_SEEL: [["show_text", "_PokemonFanClubSeelText"]]
    }
  },
  DAYCARE: {
    talk: {
      TEXT_DAYCARE_GENTLEMAN: [["open_daycare"]]
    }
  },
  SS_ANNE_CAPTAINS_ROOM: {
    talk: {
      TEXT_SSANNECAPTAINSROOM_CAPTAIN: [
        ["check_flag", "EVENT_GOT_HM01"],
        ["jump_if_true", "already"],
        ["show_text", "_SSAnneCaptainsRoomRubCaptainsBackText"],
        ["play_once", "Music_PkmnHealed"],
        ["show_text", "_SSAnneCaptainsRoomCaptainIFeelMuchBetterText"],
        ["give_item", "HM_CUT", 1, false],
        ["show_text", "_SSAnneCaptainsRoomCaptainReceivedHM01Text"],
        ["set_flag", "EVENT_GOT_HM01"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SSAnneCaptainsRoomCaptainNotSickAnymoreText"]
      ]
    }
  },
  CELADON_DINER: {
    talk: {
      TEXT_CELADONDINER_GYM_GUIDE: [
        ["check_flag", "EVENT_GOT_COIN_CASE"],
        ["jump_if_true", "already"],
        ["show_text", "_CeladonDinerGymGuideImFlatOutBustedText"],
        ["play_sound", "Get_Key_Item"],
        ["give_item", "COIN_CASE", 1, "_CeladonDinerGymGuideReceivedCoinCaseText"],
        ["set_flag", "EVENT_GOT_COIN_CASE"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_CeladonDinerGymGuideWinItBackText"]
      ]
    }
  },
  GAME_CORNER: {
    talk: {
      TEXT_GAMECORNER_POSTER: [
        ["check_flag", "EVENT_FOUND_ROCKET_HIDEOUT"],
        ["jump_if_true", "known"],
        ["play_sound", "Switch"],
        ["show_text", "_GameCornerPosterSwitchBehindPosterText"],
        ["set_flag", "EVENT_FOUND_ROCKET_HIDEOUT"],
        ["play_sound", "Go_Inside"],
        ["jump", "end"],
        ["label", "known"],
        ["show_text", "_GameCornerPosterSwitchBehindPosterText"]
      ],
      TEXT_GAMECORNER_CLERK1: coinClerkRows(),
      TEXT_GAMECORNER_CLERK: coinClerkRows(),
      TEXT_GAMECORNER_CLERK2: coinGiverRows(COIN_GIVERS.CLERK2),
      TEXT_GAMECORNER_FISHING_GURU: coinGiverRows(COIN_GIVERS.FISHING_GURU),
      TEXT_GAMECORNER_GENTLEMAN: coinGiverRows(COIN_GIVERS.GENTLEMAN),
      TEXT_GAMECORNER_ROCKET: [
        ["engage_trainer", "GAMECORNER_ROCKET"],
        ["jump_if_false", "end"],
        ["walk_npc", "GAMECORNER_ROCKET", ["up"]],
        ["hide_object", "GAME_CORNER", "GAMECORNER_ROCKET"]
      ]
    },
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_FOUND_ROCKET_HIDEOUT)
        ow.refreshGameCornerPoster?.();
      const npc = ow.findNpc?.("GAMECORNER_ROCKET");
      if (npc && ow.trainerDefeated?.(npc)) {
        ow.setObjectHidden?.("GAMECORNER_ROCKET", true);
        const toggles = save.objectToggles ??= {};
        (toggles.GAME_CORNER ??= {}).GAMECORNER_ROCKET = false;
      }
      return null;
    }
  },
  POKEMON_TOWER_5F: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const onPad = TOWER_5F_PURIFIED.has(`${p?.cellX ?? -1},${p?.cellY ?? -1}`);
      if (!onPad) {
        delete f.EVENT_IN_PURIFIED_ZONE;
        return null;
      }
      if (f.EVENT_IN_PURIFIED_ZONE)
        return null;
      f.EVENT_IN_PURIFIED_ZONE = true;
      return [
        ["heal_party"],
        ["fade", "out", "white"],
        ["wait", 3],
        ["wait", 3],
        ["fade", "in", "white"],
        ["show_text", "_PokemonTower5FPurifiedZoneText"]
      ];
    }
  },
  POKEMON_TOWER_6F: {
    onStep: (ow, save) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_GHOST_MAROWAK)
        return null;
      const p = ow?.player;
      if ((p?.cellX ?? -1) !== 10 || (p?.cellY ?? -1) !== 16)
        return null;
      const hasScope = (save?.inventory?.SILPH_SCOPE ?? 0) > 0;
      return [
        ["show_text", "_PokemonTower6FBeGoneText"],
        [
          "start_battle",
          "wild",
          "MAROWAK",
          30,
          { noCatch: true, disguised: !hasScope, unveil: hasScope }
        ],
        ["jump_if_false", "fled"],
        ["set_flag", "EVENT_BEAT_GHOST_MAROWAK"],
        ["show_text", "_PokemonTower6FGhostWasCubonesMotherText"],
        ["play_cry", "MAROWAK"],
        ["wait", 30],
        ["show_text", "_PokemonTower6FSoulWasCalmedText"],
        ["jump", "end"],
        ["label", "fled"],
        ["move_player", "right", 1]
      ];
    }
  },
  POKEMON_TOWER_7F: {
    talk: {
      TEXT_POKEMONTOWER7F_MR_FUJI: [
        ["face_player"],
        ["show_text", "_PokemonTower7FMrFujiRescueText"],
        ["set_flag", "EVENT_RESCUED_MR_FUJI"],
        ["set_flag", "EVENT_RESCUED_MR_FUJI_2"],
        ["show_object", "MR_FUJIS_HOUSE", "MRFUJISHOUSE_MR_FUJI"],
        ["hide_object", "SAFFRON_CITY", "SAFFRONCITY_ROCKET8"],
        ["show_object", "SAFFRON_CITY", "SAFFRONCITY_ROCKET9"],
        ["warp", "MR_FUJIS_HOUSE", 3, 7, "up"]
      ]
    }
  },
  MR_FUJIS_HOUSE: {
    talk: {
      TEXT_MRFUJISHOUSE_MR_FUJI: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_POKE_FLUTE"],
        ["jump_if_true", "have"],
        ["check_flag", "EVENT_RESCUED_MR_FUJI"],
        ["jump_if_false", "notyet"],
        ["show_text", "_MrFujisHouseMrFujiIThinkThisMayHelpYourQuestText"],
        ["play_sound", "Get_Key_Item"],
        ["give_item", "POKE_FLUTE", 1, false],
        ["show_text", "_MrFujisHouseMrFujiReceivedPokeFluteText"],
        ["set_flag", "EVENT_GOT_POKE_FLUTE"],
        ["show_text", "_MrFujisHouseMrFujiPokeFluteExplanationText"],
        ["jump", "end"],
        ["label", "have"],
        ["show_text", "_MrFujisHouseMrFujiHasMyFluteHelpedYouText"],
        ["jump", "end"],
        ["label", "notyet"],
        ["show_text", "_MrFujisHouseMrFujiPokedexText"]
      ]
    }
  },
  ROCKET_HIDEOUT_B4F: {
    talk: {
      TEXT_ROCKETHIDEOUTB4F_ROCKET3: liftKeyRocketRows("ROCKETHIDEOUTB4F_ROCKET3", "_RocketHideoutB4FRocket3AfterBattleText"),
      TEXT_ROCKETHIDEOUTB4F_GIOVANNI: [
        ["check_flag", "EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI"],
        ["jump_if_true", "beaten"],
        ["show_text", "_RocketHideoutB4FGiovanniImpressedYouGotHereText"],
        ["start_battle", "trainer", "OPP_GIOVANNI", 1],
        ["jump_if_false", "end"],
        ["set_flag", "EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI"],
        ["show_text", "_RocketHideoutB4FGiovanniWhatCannotBeText"],
        ["show_text", "_RocketHideoutB4FGiovanniHopeWeMeetAgainText"],
        ["fade", "out", "black"],
        ["hide_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_GIOVANNI"],
        ["show_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_SILPH_SCOPE"],
        ["fade", "in", "black"],
        ["jump", "end"],
        ["label", "beaten"],
        ["show_text", "_RocketHideoutB4FGiovanniHopeWeMeetAgainText"]
      ]
    }
  },
  ROCKET_HIDEOUT_ELEVATOR: {
    onEnter: seedElevator,
    talk: {
      TEXT_ROCKETHIDEOUTELEVATOR: [
        ["check_item", "LIFT_KEY"],
        ["jump_if_false", "no_key"],
        ["open_elevator"],
        ["jump", "end"],
        ["label", "no_key"],
        ["show_text", "_RocketHideoutElevatorAppearsToNeedKeyText"]
      ]
    }
  },
  SILPH_CO_ELEVATOR: {
    onEnter: seedElevator,
    talk: { TEXT_SILPHCOELEVATOR_ELEVATOR: [["open_elevator"]] }
  },
  VERMILION_OLD_ROD_HOUSE: {
    talk: {
      TEXT_VERMILIONOLDRODHOUSE_FISHING_GURU: rodGiverRows("_VermilionOldRodHouseFishingGuruDoYouLikeToFishText", "_VermilionOldRodHouseFishingGuruTakeThisText", "_VermilionOldRodHouseFishingGuruHowAreTheFishBitingText", "_VermilionOldRodHouseFishingGuruThatsSoDisappointingText", "OLD_ROD", "EVENT_GOT_OLD_ROD")
    }
  },
  FUCHSIA_GOOD_ROD_HOUSE: {
    talk: {
      TEXT_FUCHSIAGOODRODHOUSE_FISHING_GURU: rodGiverRows("_FuchsiaGoodRodHouseFishingGuruText", "_FuchsiaGoodRodHouseFishingGuruReceivedGoodRodText", "_FuchsiaGoodRodHouseFishingGuruHowAreTheFishText", "_FuchsiaGoodRodHouseFishingGuruThatsSoDisappointingText", "GOOD_ROD", "EVENT_GOT_GOOD_ROD")
    }
  },
  ROUTE_12_SUPER_ROD_HOUSE: {
    talk: {
      TEXT_ROUTE12SUPERRODHOUSE_FISHING_GURU: rodGiverRows("_Route12SuperRodHouseFishingGuruDoYouLikeToFishText", "_Route12SuperRodHouseFishingGuruReceivedSuperRodText", "_Route12SuperRodHouseFishingGuruTryFishingText", "_Route12SuperRodHouseFishingGuruThatsDisappointingText", "SUPER_ROD", "EVENT_GOT_SUPER_ROD")
    }
  },
  NAME_RATERS_HOUSE: {
    talk: {
      TEXT_NAMERATERSHOUSE_NAME_RATER: [
        ["face_player"],
        ["open_name_rater"]
      ]
    }
  },
  ROUTE_16_GATE_1F: {
    onStep: bikeGate([[4, 7], [4, 8], [4, 9], [4, 10]], "_Route16Gate1FGuardWaitUpText", "_Route16Gate1FGuardNoPedestriansAllowedText")
  },
  ROUTE_18_GATE_1F: {
    onStep: bikeGate([[4, 3], [4, 4], [4, 5], [4, 6]], "_Route18Gate1FGuardExcuseMeText", "_Route18Gate1FGuardYouNeedABicycleText")
  },
  CELADON_MART_3F: {
    talk: {
      TEXT_CELADONMART3F_CLERK: giftRows({
        flag: "EVENT_GOT_TM18",
        item: "TM_COUNTER",
        pre: "_CeladonMart3FClerkTM18PreReceiveText",
        received: "_CeladonMart3FClerkReceivedTM18Text",
        explain: "_CeladonMart3FClerkTM18ExplanationText",
        already: "_CeladonMart3FClerkTM18ExplanationText"
      })
    }
  },
  SILPH_CO_2F: {
    talk: {
      TEXT_SILPHCO2F_SILPH_WORKER_F: giftRows({
        flag: "EVENT_GOT_TM36",
        item: "TM_SELFDESTRUCT",
        pre: "SilphCo2FSilphWorkerFPleaseTakeThisText",
        received: "_SilphCo2FSilphWorkerFReceivedTM36Text",
        explain: "_SilphCo2FSilphWorkerFTM36ExplanationText",
        already: "_SilphCo2FSilphWorkerFTM36ExplanationText"
      })
    }
  },
  SILPH_CO_9F: {
    talk: {
      TEXT_SILPHCO9F_NURSE: [
        ["face_player"],
        ["check_flag", "EVENT_BEAT_SILPH_CO_GIOVANNI"],
        ["jump_if_true", "thanks"],
        ["show_text", `You look tired!
You should take a\vquick nap!`],
        ["heal_party"],
        ["fade", "out"],
        ["wait", 3],
        ["fade", "in"],
        ["show_text", "Don't give up!"],
        ["jump", "end"],
        ["label", "thanks"],
        ["show_text", `Thank you so
much!`]
      ]
    }
  },
  PEWTER_NIDORAN_HOUSE: {
    talk: {
      TEXT_PEWTERNIDORANHOUSE_NIDORAN: [
        ["play_cry", "NIDORAN_M"],
        ["show_text", "_PewterNidoranHouseNidoranText"]
      ]
    }
  },
  VIRIDIAN_NICKNAME_HOUSE: {
    talk: {
      TEXT_VIRIDIANNICKNAMEHOUSE_SPEAROW: [
        ["play_cry", "SPEAROW"],
        ["show_text", "_ViridianNicknameHouseSpearowText"]
      ]
    }
  },
  TRADE_CENTER: {
    talk: {
      TEXT_TRADECENTER_OPPONENT: (ow) => ow?.seatedAtTable?.() && ow?.peerSeated?.() ? [["link_trade"]] : [["show_text", "_TradeCenterOpponentText"]]
    }
  },
  COLOSSEUM: {
    talk: {
      TEXT_COLOSSEUM_OPPONENT: (ow) => ow?.seatedAtTable?.() && ow?.peerSeated?.() ? [["link_battle"]] : [["show_text", "_ColosseumOpponentText"]]
    }
  },
  PEWTER_POKECENTER: {
    talk: { TEXT_PEWTERPOKECENTER_JIGGLYPUFF: jigglypuffRows() }
  },
  SS_ANNE_KITCHEN: {
    talk: {
      TEXT_SSANNEKITCHEN_COOK7: [
        ["face_player"],
        ["show_text", "_SSAnneKitchenCook7MainCourseIsText"],
        ["random_text", [
          [128, `Salmon du Salad!\fLes guests may
gripe it's fish\vagain, however!`],
          [64, `Eels au Barbecue!\fLes guests will
mutiny, I fear.`],
          [0, `Prime Beef Steak!\fBut, have I enough
fillets du beef?`]
        ]]
      ]
    }
  },
  CELADON_MANSION_3F: {
    talk: {
      TEXT_CELADONMANSION3F_GAME_DESIGNER: [
        ["face_player"],
        ["check_dex_owned", DEX_COMPLETE],
        ["jump_if_false", "keepgoing"],
        ["show_text", "_CeladonMansion3FGameDesignerCompletedDexText"],
        ["open_diploma"],
        ["jump", "end"],
        ["label", "keepgoing"],
        ["show_text", "_CeladonMansion3FGameDesignerText"]
      ]
    }
  },
  MR_PSYCHICS_HOUSE: {
    talk: {
      TEXT_MRPSYCHICSHOUSE_MR_PSYCHIC: giftRows({
        flag: "EVENT_GOT_TM29",
        item: "TM_PSYCHIC_M",
        pre: "_MrPsychicsHouseMrPsychicYouWantedThisText",
        received: "_MrPsychicsHouseMrPsychicReceivedTM29Text",
        explain: "_MrPsychicsHouseMrPsychicTM29ExplanationText",
        already: "_MrPsychicsHouseMrPsychicTM29ExplanationText"
      })
    }
  },
  ROUTE_12_GATE_2F: {
    talk: {
      TEXT_ROUTE12GATE2F_BRUNETTE_GIRL: giftRows({
        flag: "EVENT_GOT_TM39",
        item: "TM_SWIFT",
        pre: "_Route12Gate2FBrunetteGirlYouCanHaveThisText",
        received: "_Route12Gate2FBrunetteGirlReceivedTM39Text",
        explain: "_Route12Gate2FBrunetteGirlTM39ExplanationText",
        already: "_Route12Gate2FBrunetteGirlTM39ExplanationText"
      })
    }
  },
  CELADON_CITY: {
    talk: {
      TEXT_CELADONCITY_GRAMPS3: giftRows({
        flag: "EVENT_GOT_TM41",
        item: "TM_SOFTBOILED",
        pre: "_CeladonCityGramps3Text",
        received: "_CeladonCityGramps3ReceivedTM41Text",
        explain: "_CeladonCityGramps3TM41ExplanationText",
        already: "_CeladonCityGramps3TM41ExplanationText"
      })
    }
  },
  CINNABAR_LAB_METRONOME_ROOM: {
    talk: {
      TEXT_CINNABARLABMETRONOMEROOM_SCIENTIST1: giftRows({
        flag: "EVENT_GOT_TM35",
        item: "TM_METRONOME",
        pre: "_CinnabarLabMetronomeRoomScientist1Text",
        received: "_CinnabarLabMetronomeRoomScientist1ReceivedTM35Text",
        explain: "_CinnabarLabMetronomeRoomScientist1TM35ExplanationText",
        already: "_CinnabarLabMetronomeRoomScientist1TM35ExplanationText"
      })
    }
  },
  COPYCATS_HOUSE_2F: {
    talk: {
      TEXT_COPYCATSHOUSE2F_COPYCAT: (_ow, save) => {
        if (save?.flags?.EVENT_GOT_TM31) {
          return [
            ["face_player"],
            ["show_text", "_CopycatsHouse2FCopycatTM31Explanation2Text"]
          ];
        }
        return [
          ["face_player"],
          ["show_text", "_CopycatsHouse2FCopycatDoYouLikePokemonText"],
          ["check_item", "POKE_DOLL"],
          ["jump_if_false", "end"],
          ["show_text", "_CopycatsHouse2FCopycatTM31PreReceiveText"],
          ["give_item", "TM_MIMIC", 1, "_CopycatsHouse2FCopycatReceivedTM31Text"],
          ["take_item", "POKE_DOLL", 1],
          ["set_flag", "EVENT_GOT_TM31"],
          ["show_text", "_CopycatsHouse2FCopycatTM31Explanation1Text"]
        ];
      }
    }
  },
  ROUTE_1: {
    talk: {
      TEXT_ROUTE1_YOUNGSTER1: giftRows({
        flag: "EVENT_GOT_POTION_SAMPLE",
        item: "POTION",
        pre: "_Route1Youngster1MartSampleText",
        received: "_Route1Youngster1GotPotionText",
        already: "_Route1Youngster1AlsoGotPokeballsText"
      })
    }
  },
  FIGHTING_DOJO: {
    talk: {
      TEXT_FIGHTINGDOJO_KARATE_MASTER: (_ow, save) => {
        if (save?.flags?.EVENT_BEAT_KARATE_MASTER) {
          return [
            ["face_player"],
            ["show_text", "_FightingDojoKarateMasterStayAndTrainWithUsText"]
          ];
        }
        return [
          ["face_player"],
          ["show_text", "_FightingDojoKarateMasterText"],
          ["engage_trainer", "FIGHTINGDOJO_KARATE_MASTER"],
          ["jump_if_false", "end"],
          ["set_flag", "EVENT_BEAT_KARATE_MASTER"],
          ["show_text", "_FightingDojoKarateMasterIWillGiveYouAPokemonText"]
        ];
      },
      TEXT_FIGHTINGDOJO_HITMONLEE_POKE_BALL: dojoBall("HITMONLEE", "FIGHTINGDOJO_HITMONLEE_POKE_BALL", "_FightingDojoHitmonleePokeBallText"),
      TEXT_FIGHTINGDOJO_HITMONCHAN_POKE_BALL: dojoBall("HITMONCHAN", "FIGHTINGDOJO_HITMONCHAN_POKE_BALL", "_FightingDojoHitmonchanPokeBallText")
    }
  },
  CELADON_MANSION_ROOF_HOUSE: {
    talk: {
      TEXT_CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL: (_ow, save) => {
        if (save?.flags?.EVENT_GOT_EEVEE) {
          return [[
            "hide_object",
            "CELADON_MANSION_ROOF_HOUSE",
            "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL"
          ]];
        }
        return [
          ["check_party_room"],
          ["jump_if_false", "full"],
          ["give_pokemon", "EEVEE", 25],
          ["set_flag", "EVENT_GOT_EEVEE"],
          ["hide_object", "CELADON_MANSION_ROOF_HOUSE", "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL"],
          ["play_sound", "Get_Item1"],
          ["show_text", `{PLAYER} got
EEVEE!`],
          ["jump", "end"],
          ["label", "full"],
          ["show_text", `You have no room
for it!`]
        ];
      }
    }
  },
  SILPH_CO_7F: {
    onEnter: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_RIVAL)
        return;
      ow?.setObjectHidden?.("SILPHCO7F_RIVAL", true);
    },
    talk: { TEXT_SILPHCO7F_SILPH_WORKER_M1: laprasRows },
    onStep: (ow, save) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_RIVAL)
        return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (x !== 3 || y !== 2 && y !== 3)
        return null;
      if (p)
        p.facing = "down";
      return sceneWithTheme(MEET_RIVAL, [
        ["show_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"],
        ["show_text", "_SilphCo7FRivalText"],
        ["move_npc_to", "SILPHCO7F_RIVAL", 3, y + 1],
        ["face_object", "SILPHCO7F_RIVAL", "up"],
        ["show_text", "_SilphCo7FRivalWaitedHereText"],
        ["rival_battle", "OPP_RIVAL2", 7],
        ["jump_if_false", 12],
        ["set_flag", "EVENT_BEAT_SILPH_CO_RIVAL"],
        ["show_text", "_SilphCo7FRivalDefeatedText"],
        ["show_text", "_SilphCo7FRivalGoodLuckToYouText"],
        ["move_npc_to", "SILPHCO7F_RIVAL", 5, y + 1],
        ["hide_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"]
      ]);
    }
  },
  CELADON_MART_ELEVATOR: {
    onEnter: seedElevator,
    talk: { TEXT_CELADONMARTELEVATOR: [["open_elevator"]] }
  },
  CELADON_MART_ROOF: {
    talk: {
      TEXT_CELADONMARTROOF_VENDING_MACHINE1: vendingRows(),
      TEXT_CELADONMARTROOF_VENDING_MACHINE2: vendingRows(),
      TEXT_CELADONMARTROOF_VENDING_MACHINE3: vendingRows(),
      TEXT_CELADONMARTROOF_LITTLE_GIRL: thirstyGirlRows
    }
  }
};
function seedElevator(ow) {
  const id = ow?.map?.id;
  if (!id)
    return;
  seedExit(ow.map.def, floorsOf(ow.shell?.data ?? ow.data, id), ow.cameFromMapId);
}
var TOWER_5F_PURIFIED = new Set(["10,8", "11,8", "10,9", "11,9"]);
function liftKeyRocketRows(npc, afterText) {
  return [
    ["engage_trainer", npc],
    ["jump_if_false", "end"],
    ["show_text", afterText],
    ["check_flag", "EVENT_ROCKET_DROPPED_LIFT_KEY"],
    ["jump_if_true", "end"],
    ["set_flag", "EVENT_ROCKET_DROPPED_LIFT_KEY"],
    ["show_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_LIFT_KEY"]
  ];
}
function talkScript(mapLabel, textConst) {
  return MAP_SCRIPTS[mapLabel]?.talk?.[textConst] ?? null;
}
var MEET_RIVAL = "Music_MeetRival";
function sceneWithTheme(song, rows) {
  const jumps = ["jump", "jump_if_true", "jump_if_false"];
  const bumped = rows.map((r) => jumps.includes(r[0]) && typeof r[1] === "number" ? [r[0], r[1] + 1] : r);
  return [["play_music", song], ...bumped];
}
function dojoBall(species, ball, askKey) {
  return (_ow, save) => {
    const f = save?.flags ?? {};
    if (f.EVENT_GOT_HITMONLEE || f.EVENT_GOT_HITMONCHAN) {
      return [["show_text", "_FightingDojoBetterNotGetGreedyText"]];
    }
    if (!f.EVENT_BEAT_KARATE_MASTER) {
      return [["show_text", `You'll have to
beat the master
first!`]];
    }
    return [
      ["ask", askKey],
      ["jump_if_false", "end"],
      ["check_party_room"],
      ["jump_if_false", "full"],
      ["give_pokemon", species, 30],
      ["set_flag", `EVENT_GOT_${species}`],
      ["set_flag", "EVENT_DEFEATED_FIGHTING_DOJO"],
      ["hide_object", "FIGHTING_DOJO", ball],
      ["show_text", `{PLAYER} got
${species}!`],
      ["jump", "end"],
      ["label", "full"],
      ["show_text", `You have no room
for it!`]
    ];
  };
}
function giftRows(o) {
  return [
    ["face_player"],
    ["check_flag", o.flag],
    ["jump_if_true", "already"],
    ["show_text", o.pre],
    ["give_item", o.item, 1, o.received],
    ["set_flag", o.flag],
    ...o.explain ? [["show_text", o.explain]] : [],
    ["jump", "end"],
    ["label", "already"],
    ["show_text", o.already]
  ];
}
function bikeGate(cells, stop, explain) {
  const closestY = Math.min(...cells.map((c) => c[1]));
  return (ow, save) => {
    if ((save?.inventory?.BICYCLE ?? 0) > 0)
      return null;
    const p = ow?.player;
    if (!cells.some(([x, y]) => p?.cellX === x && p?.cellY === y))
      return null;
    const dist = p.cellY - closestY;
    return [
      ["show_text", stop],
      ["show_text", explain],
      ...dist > 0 ? [["move_player", "up", dist]] : [],
      ["move_player", "right", 1]
    ];
  };
}
function museumTicketRows(walkBack) {
  const back = walkBack ? [["move_player", "down", 1]] : [];
  return [
    ["ask", "_Museum1FScientist1WouldYouLikeToComeInText"],
    ["jump_if_false", "no"],
    ["check_money", MUSEUM_TICKET],
    ["jump_if_false", "poor"],
    ["take_money", MUSEUM_TICKET],
    ["set_flag", "EVENT_BOUGHT_MUSEUM_TICKET"],
    ["show_text", "_Museum1FScientist1ThankYouText"],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", "_Museum1FScientist1ComeAgainText"],
    ...back,
    ["jump", "end"],
    ["label", "poor"],
    ["show_text", "_Museum1FScientist1DontHaveEnoughMoneyText"],
    ...back
  ];
}
var MUSEUM_TICKET = 50;
function rodGiverRows(ask, received, after, refused, rod, flag) {
  return [
    ["face_player"],
    ["check_flag", flag],
    ["jump_if_true", "already"],
    ["ask", ask],
    ["jump_if_false", "no"],
    ["give_item", rod, 1, received],
    ["set_flag", flag],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", refused],
    ["jump", "end"],
    ["label", "already"],
    ["show_text", after]
  ];
}
function laprasRows(_ow, save) {
  if (save?.flags?.EVENT_GOT_LAPRAS) {
    return [["show_text", "_SilphCo7FSilphWorkerM1LaprasDescriptionText"]];
  }
  return [
    ["face_player"],
    ["show_text", "_SilphCo7FSilphWorkerM1HaveThisPokemonText"],
    ["give_pokemon", "LAPRAS", 15],
    ["set_flag", "EVENT_GOT_LAPRAS"],
    ["show_text", "_SilphCo7FSilphWorkerM1LaprasDescriptionText"]
  ];
}
var MAGIKARP_PRICE = 500;
var LANCE_STAIRS = [24, 16];
var LANCE_WALK_IN = [
  ["down", 2],
  ["left", 6],
  ["down", 5],
  ["left", 10],
  ["up", 9],
  ["left", 2],
  ["up", 3]
];
function startLanceWalkIn(ow) {
  if (ow?.runner?.isRunning?.())
    return;
  const rows = LANCE_WALK_IN.map(([dir, n]) => ["move_player", dir, n]);
  ow.runner.run(rows, { onDone: () => ow.lanceLockDoor?.() });
}
function itemBallFlag(mapLabel, textConst) {
  return `EVENT_ITEMBALL_${mapLabel}_${textConst}`;
}
function itemBallScript(mapLabel, obj) {
  const item = obj?.item;
  const textConst = obj?.text;
  if (!item || !textConst)
    return null;
  const flag = itemBallFlag(mapLabel, textConst);
  return [
    ["check_flag", flag],
    ["jump_if_true", "end"],
    ["give_item", item],
    ["set_flag", flag],
    ["hide_object", mapLabel, textConst]
  ];
}

// voxelmon/game/world/lastmap.ts
var LAST_MAP_REWRITES = {
  ROUTE_22_GATE: {
    axis: "y",
    rules: [{ below: 4, map: "ROUTE_23" }, { map: "ROUTE_22" }]
  },
  UNDERGROUND_PATH_ROUTE_5: { rules: [{ map: "ROUTE_5" }] },
  UNDERGROUND_PATH_ROUTE_6: { rules: [{ map: "ROUTE_6" }] },
  UNDERGROUND_PATH_ROUTE_7: { rules: [{ map: "ROUTE_7" }] },
  UNDERGROUND_PATH_ROUTE_8: { rules: [{ map: "ROUTE_8" }] },
  DIGLETTS_CAVE_ROUTE_2: { rules: [{ map: "ROUTE_2" }] },
  DIGLETTS_CAVE_ROUTE_11: { rules: [{ map: "ROUTE_11" }] }
};
function rewrittenLastMap(rewrite, cellX, cellY) {
  const value = rewrite.axis === "x" ? cellX : cellY;
  for (const rule of rewrite.rules) {
    if ((rule.below === undefined || value < rule.below) && (rule.atLeast === undefined || value >= rule.atLeast)) {
      return rule.map;
    }
  }
  return null;
}

// voxelmon/game/world/marts.ts
function martStock(data, mapLabel, textConst) {
  const mart = data?.text_pointers?.[mapLabel]?.[textConst]?.mart;
  return Array.isArray(mart) && mart.length > 0 ? mart : null;
}
function martGreetScript(data, mapLabel, textConst) {
  if (!martStock(data, mapLabel, textConst))
    return null;
  return [
    ["face_player"],
    ["show_text", `Hi there!
May I help you?`],
    ["open_mart", textConst]
  ];
}

// voxelmon/game/world/fly.ts
var FLY_MAP_IDS = [
  "PALLET_TOWN",
  "VIRIDIAN_CITY",
  "PEWTER_CITY",
  "CERULEAN_CITY",
  "LAVENDER_TOWN",
  "VERMILION_CITY",
  "CELADON_CITY",
  "FUCHSIA_CITY",
  "CINNABAR_ISLAND",
  "INDIGO_PLATEAU",
  "SAFFRON_CITY"
];
function isFlyDest(mapId) {
  return FLY_MAP_IDS.includes(mapId);
}
function visit(save, mapId) {
  if (!isFlyDest(mapId))
    return false;
  const seen = save.visited ??= {};
  if (seen[mapId])
    return false;
  seen[mapId] = true;
  return true;
}
function hasVisited(save, mapId) {
  return save.visited?.[mapId] === true;
}
function flyDestinations(field, save, currentMap) {
  const warps = field?.flyWarps ?? {};
  const names = field?.townMap?.locations ?? {};
  const out = [];
  for (const map of FLY_MAP_IDS) {
    if (map === currentMap)
      continue;
    if (!hasVisited(save, map))
      continue;
    const w = warps[map];
    if (!w)
      continue;
    out.push({ map, name: names[map]?.name ?? map.replace(/_/g, " "), x: w.x, y: w.y });
  }
  return out;
}
var VISIT_EVIDENCE = [
  { map: "PEWTER_CITY", item: "BOULDERBADGE" },
  { map: "CERULEAN_CITY", item: "CASCADEBADGE" },
  { map: "VERMILION_CITY", item: "THUNDERBADGE" },
  { map: "CELADON_CITY", item: "RAINBOWBADGE" },
  { map: "FUCHSIA_CITY", item: "SOULBADGE" },
  { map: "SAFFRON_CITY", item: "MARSHBADGE" },
  { map: "CINNABAR_ISLAND", item: "VOLCANOBADGE" },
  { map: "VIRIDIAN_CITY", item: "EARTHBADGE" },
  { map: "PALLET_TOWN", flags: ["EVENT_GOT_STARTER", "EVENT_GOT_TOWN_MAP"] },
  { map: "VIRIDIAN_CITY", flags: ["EVENT_GOT_OAKS_PARCEL", "EVENT_OAK_GOT_PARCEL"] },
  {
    map: "LAVENDER_TOWN",
    flags: ["EVENT_GOT_POKE_FLUTE", "EVENT_RESCUED_MR_FUJI", "EVENT_BEAT_GHOST_MAROWAK"]
  }
];
function backfillVisited(save) {
  const inv = save.inventory ?? {};
  const flags = save.flags ?? {};
  const added = [];
  const mark = (map) => {
    if (hasVisited(save, map))
      return;
    (save.visited ??= {})[map] = true;
    added.push(map);
  };
  for (const e of VISIT_EVIDENCE) {
    if (e.item && (inv[e.item] ?? 0) > 0)
      mark(e.map);
    if (e.flags?.some((f) => flags[f] === true))
      mark(e.map);
  }
  if ((save.hallOfFame?.length ?? 0) > 0 || flags.EVENT_BEAT_CHAMPION_RIVAL === true) {
    mark("INDIGO_PLATEAU");
  }
  return added;
}

// voxelmon/game/world/freemove.ts
var FREE_RADIUS = 5.5;
function freeDir(sx, sy, yaw) {
  if (sx === 0 && sy === 0)
    return null;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x = sx * c - sy * s;
  const y = sx * s + sy * c;
  const len = Math.hypot(x, y);
  return len === 0 ? null : [x / len, y / len];
}
function quantize(x, y) {
  if (Math.abs(x) > Math.abs(y))
    return x > 0 ? "right" : "left";
  return y > 0 ? "down" : "up";
}
function bodyClear(px2, py, open) {
  const cx = px2 + 8;
  const cy = py + 8;
  for (const ox of [-FREE_RADIUS, FREE_RADIUS]) {
    for (const oy of [-FREE_RADIUS, FREE_RADIUS]) {
      if (!open(Math.floor((cx + ox) / 16), Math.floor((cy + oy) / 16)))
        return false;
    }
  }
  return true;
}
function slide(px2, py, dx, dy, open) {
  let nx = px2;
  let ny = py;
  if (dx !== 0 && bodyClear(px2 + dx, py, open))
    nx = px2 + dx;
  if (dy !== 0 && bodyClear(nx, py + dy, open))
    ny = py + dy;
  return { px: nx, py: ny, moved: nx !== px2 || ny !== py };
}
function cellOf(p) {
  return Math.round(p / 16);
}
var STICK_DEAD = 0.25;
var STICK_MIN_THROW = 0.4;
function stickPush(stick) {
  if (!stick)
    return null;
  const len = Math.hypot(stick.x, stick.y);
  if (len <= STICK_DEAD)
    return null;
  const t = Math.min(1, (len - STICK_DEAD) / (1 - STICK_DEAD));
  return {
    x: stick.x / len,
    y: stick.y / len,
    throw: STICK_MIN_THROW + t * (1 - STICK_MIN_THROW)
  };
}

// voxelmon/game/world/trashcans.ts
var DOOR_BLOCK = { bx: 2, by: 2, block: 5 };
var FIRST_LOCK = "EVENT_1ST_LOCK_OPENED";
var SECOND_LOCK = "EVENT_2ND_LOCK_OPENED";
function trashData(data) {
  return data?.field?.hiddenExtras?.trashCans ?? null;
}
function canAt(data, mapId, x, y) {
  const tc = trashData(data);
  if (!tc || mapId !== "VERMILION_GYM")
    return null;
  const hit = (tc.cans ?? []).find((c) => c.x === x && c.y === y);
  return hit ? hit.can : null;
}
function rollFirst(rand) {
  return (rand() & 14) % 16;
}
function rollSecond(adj, rand) {
  const masked = rand() & adj.length;
  return masked === 0 ? 0 : adj[masked - 1] ?? 0;
}
function openCan(data, save, can, rand) {
  if (save.flags[SECOND_LOCK])
    return { kind: "trash" };
  const puz = save.trashPuzzle ??= {};
  if (puz.first === undefined)
    puz.first = rollFirst(rand);
  if (!save.flags[FIRST_LOCK]) {
    if (can !== puz.first)
      return { kind: "trash" };
    save.flags[FIRST_LOCK] = true;
    const adj = trashData(data)?.adjacent?.[String(puz.first)] ?? [];
    puz.second = rollSecond(adj, rand);
    return { kind: "first", second: puz.second };
  }
  if (can === puz.second) {
    save.flags[SECOND_LOCK] = true;
    return { kind: "second" };
  }
  save.flags[FIRST_LOCK] = false;
  puz.first = rollFirst(rand);
  puz.second = undefined;
  return { kind: "fail", first: puz.first };
}

// voxelmon/game/world/hiddenitems.ts
function hiddenKey(mapId, x, y) {
  return `${mapId}_${x}_${y}`;
}
function findHidden(data, save, mapId, x, y, add2) {
  const key = hiddenKey(mapId, x, y);
  const taken = save.hiddenTaken ??= {};
  const items = data?.field?.hiddenItems?.[mapId] ?? [];
  for (const h of items) {
    if (h.x !== x || h.y !== y)
      continue;
    if (taken[key])
      return null;
    const name = data?.items?.[h.item]?.name ?? h.item;
    if (!add2(h.item))
      return { kind: "bagfull", item: h.item, name };
    taken[key] = true;
    return { kind: "item", item: h.item, name };
  }
  const coins = data?.field?.hiddenCoins?.[mapId] ?? [];
  for (const h of coins) {
    if (h.x !== x || h.y !== y)
      continue;
    if (taken[key])
      return null;
    if (!(save.inventory.COIN_CASE > 0))
      return { kind: "nocase" };
    taken[key] = true;
    save.coins = Math.min(9999, (save.coins ?? 0) + h.coins);
    return { kind: "coins", coins: h.coins };
  }
  return null;
}
function hiddenItemNear(data, save, mapId, px2, py) {
  const items = data?.field?.hiddenItems?.[mapId] ?? [];
  const taken = save.hiddenTaken ?? {};
  const near = (c, v, hi) => v > Math.max(c - 5, 0) && v <= c + hi;
  return items.some((h) => !taken[hiddenKey(mapId, h.x, h.y)] && near(py, h.y, 4) && near(px2, h.x, 5));
}

// voxelmon/game/world/snorlax.ts
var SNORLAX = [
  {
    map: "ROUTE_12",
    object: "ROUTE12_SNORLAX",
    beatFlag: "EVENT_BEAT_ROUTE12_SNORLAX",
    sleepText: "_Route12SnorlaxText",
    wokeText: "_Route12SnorlaxWokeUpText",
    leftText: "_Route12SnorlaxCalmedDownText"
  },
  {
    map: "ROUTE_16",
    object: "ROUTE16_SNORLAX",
    beatFlag: "EVENT_BEAT_ROUTE16_SNORLAX",
    sleepText: "_Route16Text7",
    wokeText: "_Route16SnorlaxWokeUpText",
    leftText: "_Route16SnorlaxReturnedToMountainsText"
  }
];
var SNORLAX_LEVEL = 30;
function spotFor(mapId) {
  return SNORLAX.find((s) => s.map === mapId);
}
function adjacentSnorlax(mapId, player, npcs, flags) {
  const spot = spotFor(mapId);
  if (!spot)
    return null;
  if (flags?.[spot.beatFlag] === true)
    return null;
  for (const npc of npcs) {
    if (npc.def?.name !== spot.object)
      continue;
    const dx = Math.abs(npc.cellX - player.cellX);
    const dy = Math.abs(npc.cellY - player.cellY);
    if (dx + dy === 1)
      return { spot, npc };
  }
  return null;
}

// voxelmon/game/world/toggleblocks.ts
var OPEN_BLOCK = 14;
var MANSION_BLOCKS = {
  POKEMON_MANSION_1F: [
    { bx: 12, by: 6, solid: 45, solidWhenOn: true },
    { bx: 8, by: 3, solid: 45, solidWhenOn: false },
    { bx: 10, by: 8, solid: 45, solidWhenOn: false },
    { bx: 13, by: 13, solid: 45, solidWhenOn: false }
  ],
  POKEMON_MANSION_2F: [
    { bx: 4, by: 2, solid: 95, solidWhenOn: true },
    { bx: 9, by: 4, solid: 84, solidWhenOn: false },
    { bx: 3, by: 11, solid: 95, solidWhenOn: false }
  ],
  POKEMON_MANSION_3F: [
    { bx: 7, by: 2, solid: 95, solidWhenOn: true },
    { bx: 7, by: 5, solid: 95, solidWhenOn: false }
  ],
  POKEMON_MANSION_B1F: [
    { bx: 13, by: 8, solid: 45, solidWhenOn: true },
    { bx: 6, by: 11, solid: 95, solidWhenOn: true },
    { bx: 4, by: 3, solid: 95, solidWhenOn: false },
    { bx: 8, by: 8, solid: 84, solidWhenOn: false }
  ]
};
var MANSION_SWITCHES = {
  POKEMON_MANSION_1F: { cells: [[2, 5]], text: "_PokemonMansion1F" },
  POKEMON_MANSION_2F: { cells: [[2, 11]], text: "_PokemonMansion2F" },
  POKEMON_MANSION_3F: { cells: [[10, 5]], text: "_PokemonMansion2F" },
  POKEMON_MANSION_B1F: { cells: [[20, 3], [18, 25]], text: "_PokemonMansion2F" }
};
var MANSION_HOLES = [
  { x: 16, y: 14, map: "POKEMON_MANSION_1F", dx: 16, dy: 14 },
  { x: 17, y: 14, map: "POKEMON_MANSION_1F", dx: 16, dy: 14 },
  { x: 19, y: 14, map: "POKEMON_MANSION_2F", dx: 18, dy: 14 }
];
var GYM_MACHINES = [
  { x: 15, y: 7, yes: true, gate: { bx: 9, by: 3, solid: 84, solidWhenOn: false }, npc: 3 },
  { x: 10, y: 1, yes: false, gate: { bx: 6, by: 3, solid: 84, solidWhenOn: false }, npc: 4 },
  { x: 9, y: 7, yes: false, gate: { bx: 6, by: 6, solid: 84, solidWhenOn: false }, npc: 5 },
  { x: 9, y: 13, yes: false, gate: { bx: 3, by: 8, solid: 95, solidWhenOn: false }, npc: 6 },
  { x: 1, y: 13, yes: true, gate: { bx: 2, by: 6, solid: 84, solidWhenOn: false }, npc: 7 },
  { x: 1, y: 7, yes: false, gate: { bx: 2, by: 3, solid: 84, solidWhenOn: false }, npc: 8 }
];
function gymGateFlag(i) {
  return `EVENT_CINNABAR_GYM_GATE${i}_UNLOCKED`;
}
function gymGuardKey(npc) {
  return `CINNABAR_GYM_obj_${npc}`;
}
var LEAGUE_SEALS = {
  LORELEIS_ROOM: {
    flag: "EVENT_BEAT_LORELEIS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 36 }],
    dontRun: { text: "_LoreleisRoomLoreleiDontRunAwayText", fromY: 10, x: [4, 5] }
  },
  BRUNOS_ROOM: {
    flag: "EVENT_BEAT_BRUNOS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 36 }],
    dontRun: { text: "_BrunosRoomBrunoDontRunAwayText", fromY: 10, x: [4, 5] }
  },
  AGATHAS_ROOM: {
    flag: "EVENT_BEAT_AGATHAS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 59 }],
    dontRun: { text: "_AgathasRoomAgathaDontRunAwayText", fromY: 10, x: [4, 5] }
  },
  LANCES_ROOM: {
    flag: "EVENT_LANCES_ROOM_LOCK_DOOR",
    whileSet: true,
    blocks: [
      { bx: 2, by: 6, solid: 114 },
      { bx: 3, by: 6, solid: 115 }
    ]
  }
};
var LANCE_DOOR_CELLS = [[5, 11], [6, 11]];
var ROAD_BARRIERS = {
  VICTORY_ROAD_1F: [
    {
      bx: 4,
      by: 6,
      closed: 37,
      open: 29,
      flag: "EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH",
      switchX: 17,
      switchY: 13
    }
  ],
  VICTORY_ROAD_2F: [
    {
      bx: 3,
      by: 4,
      closed: 55,
      open: 21,
      flag: "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1",
      switchX: 1,
      switchY: 16
    },
    {
      bx: 11,
      by: 7,
      closed: 37,
      open: 29,
      flag: "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2",
      switchX: 9,
      switchY: 16
    }
  ],
  VICTORY_ROAD_3F: [
    {
      bx: 3,
      by: 5,
      closed: 37,
      open: 29,
      flag: "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1",
      switchX: 3,
      switchY: 5
    }
  ]
};
function barriersFor(mapId) {
  return ROAD_BARRIERS[mapId] ?? [];
}
var ROAD_HOLES = [
  {
    map: "VICTORY_ROAD_3F",
    x: 23,
    y: 15,
    boulder: "VICTORYROAD3F_BOULDER4",
    toBoulder: "VICTORYROAD2F_BOULDER3",
    flag: "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2",
    toMap: "VICTORY_ROAD_2F",
    dx: 22,
    dy: 16
  }
];
var ROUTE_23_RESET_FLAGS = [
  "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1",
  "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2",
  "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1",
  "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2"
];

// voxelmon/game/world/seafoam.ts
function seafoamData(field) {
  return field?.seafoam;
}
function toggleToObjectName(mapId, toggle) {
  const prefix = `TOGGLE_${mapId}_`;
  if (!toggle.startsWith(prefix))
    return null;
  return `${mapId.replace(/_/g, "")}_${toggle.slice(prefix.length).replace(/_/g, "")}`;
}
function holesFor(sf, mapId) {
  const out = [];
  for (const [owner, floor] of Object.entries(sf ?? {})) {
    if (owner === mapId && floor.holeDestination) {
      for (const hole of floor.holes ?? [])
        out.push({ hole, destMap: floor.holeDestination });
    }
    if (floor.pluggedByHolesOn?.map === mapId) {
      for (const hole of floor.pluggedByHolesOn.holes)
        out.push({ hole, destMap: owner });
    }
  }
  return out;
}
function isHole(sf, mapId, x, y) {
  return holesFor(sf, mapId).some((h) => h.hole.x === x && h.hole.y === y);
}
function defaultHiddenBoulders(sf) {
  const out = {};
  const add2 = (mapId, toggle) => {
    const name = toggle ? toggleToObjectName(mapId, toggle) : null;
    if (!name)
      return;
    (out[mapId] ??= {})[name] = true;
  };
  for (const [owner, floor] of Object.entries(sf ?? {})) {
    if (floor.holeDestination) {
      for (const h of floor.holes ?? [])
        add2(floor.holeDestination, h.showObject);
    }
    for (const h of floor.pluggedByHolesOn?.holes ?? [])
      add2(owner, h.showObject);
  }
  return out;
}
var allSet = (flags, events) => (events ?? []).every((e) => flags?.[e] === true);
function forcedExitAt(sf, flags, mapId, x, y) {
  const fe = sf?.[mapId]?.forcedExit;
  if (!fe || allSet(flags, fe.activeUntilEvents))
    return 0;
  if (!fe.coords.some((c) => c.x === x && c.y === y))
    return 0;
  const top = Math.min(...fe.coords.map((c) => c.y));
  return y - (top - 1);
}
function currentAt(sf, flags, mapId, x, y) {
  const floor = sf?.[mapId];
  if (!floor)
    return null;
  const active2 = [];
  if (!allSet(flags, floor.currentsDisabledByEvents))
    active2.push(...floor.currents ?? []);
  if (floor.entryCurrent) {
    const plugged = (floor.pluggedByHolesOn?.holes ?? []).every((h) => flags?.[h.boulderEvent] === true);
    if (!plugged)
      active2.push(floor.entryCurrent);
  }
  return active2.find((c) => c.x === x && c.y === y) ?? null;
}
var FORCED_WARP_FLOORS = ["SEAFOAM_ISLANDS_B3F"];
var SURF_BLOCKED = {
  map: "SEAFOAM_ISLANDS_B4F",
  x: 7,
  y: 11,
  untilEvents: ["EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE", "EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE"]
};
function surfBlockedAt(flags, mapId, x, y) {
  return mapId === SURF_BLOCKED.map && x === SURF_BLOCKED.x && y === SURF_BLOCKED.y && !allSet(flags, SURF_BLOCKED.untilEvents);
}

// voxelmon/game/world/badgegate.ts
function gateFor(field, mapId) {
  return field?.badgeGates?.[mapId];
}
function guardAt(field, save, mapId, x, y) {
  const gate = gateFor(field, mapId);
  for (const g of gate?.guards ?? []) {
    if (g.y !== y)
      continue;
    if (g.maxX !== undefined && x > g.maxX)
      continue;
    if (save.flags?.[g.event] === true)
      continue;
    return g;
  }
  return null;
}
function hasBadge(save, guard) {
  return (save.inventory?.[guard.badge] ?? 0) > 0;
}
function fillBadgeName(text, badge) {
  return text.replace(/\{RAM:\w+\}/g, badge);
}

// voxelmon/game/world/nurses.ts
function isNurseClerk(textConst) {
  return textConst.endsWith("_NURSE");
}
function nurseGreetScript(textConst) {
  if (!isNurseClerk(textConst))
    return null;
  return [
    ["face_player"],
    ["ask", `Welcome to our
POKéMON CENTER!
Shall we heal your
POKéMON?`],
    ["jump_if_false", "bye"],
    ["show_text", `OK. We'll need
your POKéMON.`],
    ["fade", "out", "white"],
    ["heal_party"],
    ["set_heal_point"],
    ["play_once", "Music_PkmnHealed"],
    ["fade", "in", "white"],
    ["show_text", `Your POKéMON are
fighting fit!`],
    ["label", "bye"],
    ["show_text", `We hope to see
you again!`]
  ];
}

// voxelmon/game/world/cableclub.ts
function isLinkReceptionist(textConst) {
  return /_LINK_RECEPTIONIST$/.test(textConst);
}
function cableClubScript(textConst) {
  if (!isLinkReceptionist(textConst))
    return null;
  return [
    ["face_player"],
    ["show_text", "_CableClubNPCWelcomeText"],
    ["ask", "_CableClubNPCPleaseApplyHereHaveToSaveText"],
    ["jump_if_false", "bye"],
    ["save_game"],
    ["show_text", "_CableClubNPCPleaseWaitText"],
    ["link_open"],
    ["jump_if_false", "alone"],
    ["link_room"],
    ["jump_if_false", "bye"],
    ["link_enter"],
    ["jump", "end"],
    ["label", "alone"],
    ["show_text", "_CableClubNPCAreaReservedFor2FriendsLinkedByCableText"],
    ["jump", "end"],
    ["label", "bye"],
    ["show_text", "_CableClubNPCPleaseComeAgainText"]
  ];
}

// voxelmon/game/world/link.ts
var LINK_ROOM_MAP = ["TRADE_CENTER", "COLOSSEUM"];
var LINK_SEATS = [
  { enter: { x: 4, y: 2 }, seat: { x: 4, y: 3 }, facing: "down" },
  { enter: { x: 4, y: 6 }, seat: { x: 4, y: 5 }, facing: "up" }
];
var LINK_WAIT_FRAMES = 60 * 20;
var LINK_MSG = {
  hello: 1,
  room: 2,
  cancel: 3,
  offer: 4,
  answer: 5,
  pos: 6,
  party: 7,
  seed: 8,
  action: 9
};
function asciiJson(v) {
  return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
function encodeJson(kind, v) {
  const s = asciiJson(v);
  const out = new Uint8Array(1 + s.length);
  out[0] = kind;
  for (let i = 0;i < s.length; i++)
    out[1 + i] = s.charCodeAt(i) & 255;
  return out;
}
function decodeJson(frame) {
  let s = "";
  for (let i = 1;i < frame.length; i++)
    s += String.fromCharCode(frame[i]);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
var LINK_ROOM = { trade: 0, colosseum: 1 };
var LINK_VERSION = 2;
var MAX_NAME = 10;
function encodeHello(name, nonce) {
  const s = asciiJson({ n: [...name].slice(0, MAX_NAME).join(""), k: nonce });
  const out = new Uint8Array(2 + s.length);
  out[0] = LINK_MSG.hello;
  out[1] = LINK_VERSION;
  for (let i = 0;i < s.length; i++)
    out[2 + i] = s.charCodeAt(i) & 255;
  return out;
}
function decodeHello(frame) {
  let s = "";
  for (let i = 2;i < frame.length; i++)
    s += String.fromCharCode(frame[i]);
  try {
    const v = JSON.parse(s);
    return { name: typeof v?.n === "string" ? v.n : "", nonce: Number(v?.k ?? 0) };
  } catch {
    return { name: s, nonce: 0 };
  }
}

class LinkSession {
  transport;
  myName;
  state = "idle";
  peerName = "";
  myRoom = null;
  peerRoom = null;
  peerOffer = null;
  peerAnswer = null;
  peerPos = null;
  peerParty = null;
  peerSeed = null;
  actions = [];
  seat() {
    if (this.peerNonce === null)
      return 0;
    if (this.myNonce !== this.peerNonce)
      return this.myNonce > this.peerNonce ? 0 : 1;
    return this.myName >= this.peerName ? 0 : 1;
  }
  helloSent = false;
  myNonce;
  peerNonce = null;
  lastPos = "";
  constructor(transport, myName, nonce) {
    this.transport = transport;
    this.myName = myName;
    this.myNonce = nonce ?? Math.floor(Math.random() * 2147483647);
  }
  open() {
    if (this.state === "idle")
      this.state = "waiting";
  }
  chooseRoom(room) {
    this.myRoom = room;
    const f = new Uint8Array([LINK_MSG.room, room]);
    this.transport.send(f);
  }
  sendPos(x, y, facing) {
    const key = `${x},${y},${facing}`;
    if (key === this.lastPos)
      return;
    this.lastPos = key;
    this.transport.send(encodeJson(LINK_MSG.pos, { x, y, f: facing }));
  }
  sendParty(p) {
    this.transport.send(encodeJson(LINK_MSG.party, p));
  }
  sendSeed(half) {
    this.transport.send(encodeJson(LINK_MSG.seed, { s: half >>> 0 }));
  }
  battleSeed(myHalf) {
    if (this.peerSeed === null)
      return null;
    return (myHalf ^ this.peerSeed) >>> 0 || 1;
  }
  sendAction(a) {
    this.transport.send(encodeJson(LINK_MSG.action, a));
  }
  takeAction() {
    return this.actions.shift() ?? null;
  }
  offer(o) {
    this.transport.send(encodeJson(LINK_MSG.offer, o));
  }
  answer(ok) {
    this.transport.send(new Uint8Array([LINK_MSG.answer, ok ? 1 : 0]));
  }
  resetTrade() {
    this.peerOffer = null;
    this.peerAnswer = null;
  }
  cancel() {
    if (this.state !== "closed")
      this.transport.send(new Uint8Array([LINK_MSG.cancel]));
    this.close();
  }
  close() {
    this.state = "closed";
    this.transport.close();
  }
  agreedRoom() {
    if (this.myRoom === null || this.peerRoom === null)
      return null;
    return this.myRoom === this.peerRoom ? this.myRoom : null;
  }
  poll() {
    if (this.state === "idle" || this.state === "closed")
      return this.state;
    if (!this.helloSent && this.transport.connected()) {
      this.transport.send(encodeHello(this.myName, this.myNonce));
      this.helloSent = true;
    }
    for (;; ) {
      const f = this.transport.recv();
      if (!f || f.length === 0)
        break;
      switch (f[0]) {
        case LINK_MSG.hello:
          if (f[1] !== LINK_VERSION) {
            this.close();
            return this.state;
          }
          {
            const h = decodeHello(f);
            this.peerName = h.name;
            this.peerNonce = h.nonce;
          }
          if (this.state === "waiting")
            this.state = "linked";
          break;
        case LINK_MSG.pos: {
          const p = decodeJson(f);
          if (p && typeof p.x === "number" && typeof p.y === "number") {
            this.peerPos = { x: p.x, y: p.y, facing: typeof p.f === "string" ? p.f : "down" };
          }
          break;
        }
        case LINK_MSG.room:
          this.peerRoom = f[1] ?? 0;
          break;
        case LINK_MSG.party: {
          const p = decodeJson(f);
          if (p && typeof p === "object" && Array.isArray(p.mons)) {
            this.peerParty = {
              mons: p.mons.slice(0, 6),
              otName: typeof p.otName === "string" ? p.otName : "",
              otId: Number(p.otId ?? 0)
            };
          }
          break;
        }
        case LINK_MSG.seed: {
          const v = decodeJson(f);
          if (v && typeof v.s === "number")
            this.peerSeed = v.s >>> 0;
          break;
        }
        case LINK_MSG.action: {
          const v = decodeJson(f);
          if (v && typeof v === "object")
            this.actions.push(v);
          break;
        }
        case LINK_MSG.offer: {
          const o = decodeJson(f);
          if (o && typeof o === "object" && Number.isInteger(o.give) && Number.isInteger(o.take) && o.give >= 0 && o.give < 6 && o.take >= 0 && o.take < 6) {
            this.peerOffer = { give: o.give, take: o.take };
          }
          break;
        }
        case LINK_MSG.answer:
          this.peerAnswer = f[1] === 1;
          break;
        case LINK_MSG.cancel:
          this.close();
          return this.state;
        default:
          break;
      }
    }
    if (this.state === "linked" && this.agreedRoom() !== null)
      this.state = "ready";
    return this.state;
  }
}
function hostTransport() {
  const v = globalThis.voxel;
  if (!v || typeof v.linkOpen !== "function")
    return null;
  const call = (name, arg) => v[name](arg);
  const opened = call("linkOpen");
  if (typeof opened === "number" && opened <= 0)
    return null;
  const toStr = (f) => {
    let s = "";
    for (let i = 0;i < f.length; i++)
      s += String.fromCharCode(f[i]);
    return s;
  };
  const toBytes = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0;i < s.length; i++)
      out[i] = s.charCodeAt(i) & 255;
    return out;
  };
  return {
    send: (f) => {
      call("linkSend", toStr(f));
    },
    recv: () => {
      const r = call("linkRecv");
      if (typeof r === "string" && r.length > 0)
        return toBytes(r);
      return r instanceof Uint8Array && r.length > 0 ? r : null;
    },
    connected: () => call("linkState") === 1,
    close: () => {
      call("linkClose");
    }
  };
}

// voxelmon/game/world/pctiles.ts
var PC_TILES = {
  VIRIDIAN_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  PEWTER_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CERULEAN_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  VERMILION_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  LAVENDER_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CELADON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  FUCHSIA_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CINNABAR_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  SAFFRON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  MT_MOON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  ROCK_TUNNEL_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  INDIGO_PLATEAU_LOBBY: [{ x: 15, y: 7, facing: "up" }]
};
function pcTileAt(mapLabel, x, y, facing) {
  const tiles = PC_TILES[mapLabel];
  if (!tiles)
    return false;
  return tiles.some((t) => t.x === x && t.y === y && (!t.facing || t.facing === facing));
}

// voxelmon/game/world/script.ts
var EMOTE_BUBBLES = { shock: 1, question: 2, happy: 3 };
var CUT_ANIM_BEATS = 8;
var CUT_ANIM_BEAT_FRAMES = 5;
function scriptText(w, textId, subs) {
  let text = w.data.text?.[textId] ?? w.resolveText(textId) ?? textId;
  if (subs) {
    for (const [token, value] of Object.entries(subs)) {
      text = text.replace(new RegExp(`\\{${token}:?\\w*\\}`, "g"), value);
    }
  }
  return text;
}
function* show_text(ctx, ...args) {
  const runner = ctx.runner;
  const text = scriptText(ctx.world, args[0], args[1]);
  console.log("show_text[" + String(args[0]).slice(0, 28) + "] len=" + (text?.length ?? -1));
  ctx.world.showText(text, () => {
    console.log("show_text done");
    runner.resume();
  });
  yield;
}
function* ask(ctx, ...args) {
  const runner = ctx.runner;
  const text = scriptText(ctx.world, args[0], args[1]);
  ctx.world.showChoice(text, (yes) => {
    ctx.lastCheck = yes;
    runner.resume();
  });
  yield;
}
function* set_flag(ctx, ...args) {
  ctx.world.save.flags[args[0]] = true;
}
function* give_item(ctx, ...args) {
  const itemId = args[0];
  const count2 = args[1] ?? 1;
  const gotText = args[2];
  const w = ctx.world;
  const runner = ctx.runner;
  if (!add(w.save, itemId, count2, w.data)) {
    w.showText(`You can't carry
any more items!`, () => runner.resume());
    yield;
    return Number.POSITIVE_INFINITY;
  }
  const def = w.data.items?.[itemId];
  const name = def?.name ?? itemId;
  w.playSfx?.(def?.keyItem ? "Get_Key_Item" : "Get_Item1");
  if (gotText !== false) {
    const text = gotText === undefined ? `{PLAYER} got
${name}!` : scriptText(w, gotText, { "RAM:wStringBuffer": name });
    w.showText(text, () => runner.resume());
    yield;
  }
}
function* warp(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.startWarpTo(args[0], args[1], args[2], args[3], () => runner.resume());
  yield;
}
function* wait(ctx, ...args) {
  ctx.runner.waitingFrames = args[0];
  yield;
}
function* move_player(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.scriptMove(ctx.world.player, args[0], args[1] ?? 1, () => runner.resume());
  yield;
}
function* emote(ctx, ...args) {
  const targetArg = args[0];
  const bubble = args[1];
  const frames = args[2] ?? 60;
  const entity = targetArg === "player" ? ctx.world.player : ctx.npc;
  if (!entity)
    return;
  const runner = ctx.runner;
  const kind = typeof bubble === "number" ? bubble : EMOTE_BUBBLES[bubble ?? "shock"] ?? 1;
  ctx.world.setEmote(entity, kind, frames, () => runner.resume());
  yield;
}
function* jump(_ctx, ...args) {
  return args[0];
}
function* face_player(ctx) {
  if (ctx.npc)
    ctx.world.facePlayer(ctx.npc);
}
function* check_flag(ctx, ...args) {
  ctx.lastCheck = ctx.world.save.flags[args[0]] === true;
}
function* jump_if_true(ctx, ...args) {
  if (ctx.lastCheck)
    return args[0];
}
function* jump_if_false(ctx, ...args) {
  if (!ctx.lastCheck)
    return args[0];
}
function* label2() {}
function* heal_party(ctx) {
  ctx.world.healParty();
}
function* play_once(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.playOnce(args[0], () => runner.resume());
  yield;
}
function* fade(ctx, ...args) {
  const dir = args[0] === "in" ? "in" : "out";
  const frames = (typeof args[1] === "number" ? args[1] : typeof args[2] === "number" ? args[2] : undefined) ?? FADE_OUT_TO_WHITE;
  const runner = ctx.runner;
  ctx.world.fade(dir, frames, () => runner.resume());
  yield;
}
function* give_pokemon(ctx, ...args) {
  const species = args[0];
  const level = args[1] ?? 5;
  const w = ctx.world;
  markOwned(w.save, species);
  const party = w.save.party;
  if (party.length >= 6)
    return;
  const mon = newMon(w.data, species, level);
  party.push(mon);
  const runner = ctx.runner;
  if (typeof w.askNickname === "function") {
    const label3 = w.data.pokemon?.[species]?.name ?? species;
    w.askNickname(label3, (name) => {
      if (name)
        mon.nickname = name;
      runner.resume();
    });
    yield;
  }
}
function* noop_object() {
  return;
}
function* play_sound(ctx, ...args) {
  ctx.world.playSfx?.(args[0]);
}
function* play_music(ctx, ...args) {
  ctx.world.playOnce(args[0], () => {});
}
function* noop_audio() {
  return;
}
function* walk_route(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.walkRoute?.(args[0], args[1], () => runner.resume());
  yield;
}
function* start_battle(ctx, ...args) {
  const kind = String(args[0] ?? "trainer");
  const id = String(args[1] ?? "");
  const idx = args[2] ?? 1;
  const opts = args[3] ?? {};
  const runner = ctx.runner;
  const w = ctx.world;
  if (kind === "trainer" && w.startTrainerBattle) {
    w.startTrainerBattle(id, idx, undefined, (won) => {
      ctx.lastCheck = !!won;
      runner.resume();
    }, opts.loseable === true);
    yield;
    return;
  }
  if (kind === "wild" && w.startWildBattle) {
    const wopts = opts;
    w.startWildBattle(id, idx, wopts, (result) => {
      ctx.lastCheck = result === "win";
      runner.resume();
    });
    yield;
  }
}
function* trade(ctx, ...args) {
  const w = ctx.world;
  const runner = ctx.runner;
  const data = w.data;
  const t = (data.field?.trades ?? [])[args[0] - 1];
  if (!t)
    return;
  const doneFlag = args[1];
  const set = t.dialogset ?? 1;
  const subs = {
    "RAM:wInGameTradeGiveMonName": data.pokemon?.[t.give]?.name ?? t.give,
    "RAM:wInGameTradeReceiveMonName": data.pokemon?.[t.get]?.name ?? t.get
  };
  const say = function* (label3) {
    w.showText(scriptText(w, label3, subs), () => runner.resume());
    yield;
  };
  if (doneFlag && w.save.flags[doneFlag]) {
    yield* say(`_AfterTrade${set}Text`);
    return;
  }
  let yes = false;
  w.showChoice(scriptText(w, `_WannaTrade${set}Text`, subs), (y) => {
    yes = y;
    runner.resume();
  });
  yield;
  if (!yes) {
    yield* say(`_NoTrade${set}Text`);
    return;
  }
  let picked = -1;
  w.pickPartyMon((i) => {
    picked = i;
    runner.resume();
  }, () => runner.resume());
  yield;
  const party = w.save.party;
  const sent = party[picked];
  if (!sent) {
    yield* say(`_NoTrade${set}Text`);
    return;
  }
  if (sent.species !== t.give) {
    yield* say(`_WrongMon${set}Text`);
    return;
  }
  if (doneFlag)
    w.save.flags[doneFlag] = true;
  yield* say("_ConnectCableText");
  const mon = newMon(data, t.get, sent.level);
  if (t.nickname)
    mon.nickname = t.nickname;
  mon.traded = true;
  party.splice(picked, 1);
  party.push(mon);
  markOwned(w.save, t.get);
  yield* say("_TradedForText");
  yield* say(`_Thanks${set}Text`);
}
function* static_battle(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.startWildBattle)
    return;
  w.startWildBattle(args[0], args[1], undefined, (result) => {
    ctx.lastCheck = result !== null && result !== "lose";
    runner.resume();
  });
  yield;
}
function* move_player_to(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.movePlayerTo?.(args[0], args[1], () => runner.resume());
  yield;
}
function* place_npc(ctx, ...args) {
  ctx.world.placeNpc?.(args[0], args[1], args[2], args[3] ?? "down");
}
function toggleObject(ctx, args, visible) {
  const w = ctx.world;
  const hasMap = args.length >= 2;
  const curMap = String(w.map?.id ?? "");
  const mapId = hasMap ? String(args[0]) : curMap;
  const name = String(hasMap ? args[1] : args[0]);
  const key = name.toUpperCase().replace(/^TEXT_/, "");
  const save = w.save;
  save.objectToggles = save.objectToggles ?? {};
  save.objectToggles[mapId] = save.objectToggles[mapId] ?? {};
  save.objectToggles[mapId][key] = visible;
  if (mapId === curMap)
    w.setObjectHidden?.(name, !visible);
}
function* hide_object(ctx, ...args) {
  toggleObject(ctx, args, false);
}
function* show_object(ctx, ...args) {
  toggleObject(ctx, args, true);
}
function* face_object(ctx, ...args) {
  ctx.world.faceObject?.(args[0], args[1] ?? "down");
}
function* move_npc_to(ctx, ...args) {
  const runner = ctx.runner;
  ctx.world.moveNpcTo?.(args[0], args[1], args[2], () => runner.resume());
  yield;
}
function* pic(ctx, ...args) {
  ctx.world.showPic(args[0], args[1], args[2], args[3], args[4]);
}
function* pic_hide(ctx) {
  ctx.world.hidePic();
}
function* stamp(ctx, ...args) {
  ctx.world.stamp(args[0], args[1], args[2], args[3] !== false);
}
function* use_cut(ctx, ...args) {
  const w = ctx.world;
  const runner = ctx.runner;
  const monName2 = args[0] ?? "";
  const [fx, fy] = w.player.facingCell();
  const visit2 = w.cutThisVisit;
  const key = `${w.map.def.index},${fx},${fy}`;
  const already = visit2?.has(key) === true;
  if (w.map.isCuttableCell(fx, fy) && !already) {
    const cx = Math.round((fx * CELL_PX + CELL_PX / 2) * Q4);
    const cz = Math.round((fy * CELL_PX + CELL_PX / 2) * Q4);
    for (let beat = 0;beat < CUT_ANIM_BEATS; beat++) {
      w.fieldFx(cx, cz, beat % 2 === 0 ? FX_FRAME_CUT_TREE : -1);
      runner.waitingFrames = CUT_ANIM_BEAT_FRAMES;
      yield;
    }
    w.fieldFx(0, 0, -1);
    w.stamp(w.map.def.index, fx, fy, false);
    w.map.markCut?.(fx, fy);
    visit2?.add(key);
    w.showText(scriptText(w, "_UsedCutText", { "RAM:wNameBuffer": monName2 }), () => runner.resume());
  } else {
    w.showText(scriptText(w, "_NothingToCutText"), () => runner.resume());
  }
  yield;
}
function* use_surf(ctx, ...args) {
  const w = ctx.world;
  const runner = ctx.runner;
  const monName2 = args[0] ?? "";
  if (w.surfBlockedHere?.()) {
    w.showText(scriptText(w, "_CurrentTooFastText"), () => runner.resume());
    yield;
    return;
  }
  if (w.player.surfing === true || !w.canSurfHere?.()) {
    w.showText(scriptText(w, "_NoSurfingHereText", { "RAM:wNameBuffer": monName2 }), () => runner.resume());
    yield;
    return;
  }
  w.showText(scriptText(w, "_SurfingGotOnText", { "RAM:wNameBuffer": monName2 }), () => {
    w.startSurfing?.();
    runner.resume();
  });
  yield;
}
function* use_escape_move(ctx) {
  const w = ctx.world;
  if (w.escapeWarp?.())
    return;
  const runner = ctx.runner;
  w.showText(scriptText(w, "_ItemUseNotTimeText"), () => runner.resume());
  yield;
}
function* use_dig(ctx) {
  yield* use_escape_move(ctx);
}
function* use_teleport(ctx) {
  yield* use_escape_move(ctx);
}
function* random_text(ctx, ...args) {
  const rows = args[0] ?? [];
  const roll2 = ctx.world.rollByte?.() ?? 0;
  const pick = rows.find(([at]) => roll2 >= at) ?? rows[rows.length - 1];
  if (!pick)
    return;
  const runner = ctx.runner;
  ctx.world.showText(scriptText(ctx.world, pick[1]), () => runner.resume());
  yield;
}
function* play_cry(ctx, ...args) {
  ctx.world.playCry?.(String(args[0]));
}
function* use_fly(ctx, ...args) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.openFlyPicker)
    return;
  w.openFlyPicker(args[0] ?? "", () => runner.resume());
  yield;
}
function* use_strength(ctx, ...args) {
  const w = ctx.world;
  const runner = ctx.runner;
  const monName2 = args[0] ?? "";
  w.enableStrength?.();
  w.showText(scriptText(w, "_UsedStrengthText", { "RAM:wNameBuffer": monName2 }), () => runner.resume());
  yield;
}
function* use_flash(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  w.save.flashLit = true;
  w.tint(4294967295);
  w.showText(scriptText(w, "_FlashLightsAreaText"), () => runner.resume());
  yield;
}
function* open_elevator(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openElevator)
    return;
  w.openElevator(() => runner.resume());
  yield;
}
function* open_mart(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  const stock = martStock(w.data, w.map?.def?.label ?? "", String(args[0] ?? ""));
  if (stock && w.openShop) {
    w.openShop(stock, () => runner.resume());
    yield;
  }
}
function* check_money(ctx, ...args) {
  const save = ctx.world.save;
  ctx.lastCheck = (save.money ?? 0) >= args[0];
}
function* take_money(ctx, ...args) {
  const save = ctx.world.save;
  save.money = Math.max(0, (save.money ?? 0) - args[0]);
}
function* check_coins_below(ctx, ...args) {
  const save = ctx.world.save;
  ctx.lastCheck = (save.coins ?? 0) < args[0];
}
function* check_coins(ctx, ...args) {
  const save = ctx.world.save;
  ctx.lastCheck = (save.coins ?? 0) >= args[0];
}
function* give_coins(ctx, ...args) {
  const save = ctx.world.save;
  save.coins = Math.min(COIN_CAP, (save.coins ?? 0) + args[0]);
}
function* open_prizes(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openPrizes)
    return;
  w.openPrizes(args[0], () => runner.resume());
  yield;
}
function* open_name_rater(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openNameRater)
    return;
  w.openNameRater(() => runner.resume());
  yield;
}
function* open_vending(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openVending)
    return;
  w.openVending(() => runner.resume());
  yield;
}
function* oaks_aide(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openOaksAide)
    return;
  w.openOaksAide(args[0], () => runner.resume());
  yield;
}
function* open_bike_shop(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openBikeShop)
    return;
  w.openBikeShop(() => runner.resume());
  yield;
}
function* open_daycare(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.openDaycare)
    return;
  w.openDaycare(() => runner.resume());
  yield;
}
function* take_guard_drink(ctx) {
  const save = ctx.world.save;
  for (const drink of GUARD_DRINKS) {
    if ((save.inventory?.[drink] ?? 0) > 0) {
      remove(save, drink, 1);
      if (save.flags)
        save.flags[GAVE_DRINK_FLAG] = true;
      ctx.lastCheck = true;
      return;
    }
  }
  ctx.lastCheck = false;
}
function* safari_start(ctx) {
  ctx.world.safariStart?.();
}
function* safari_end(ctx) {
  ctx.world.safariEnd?.();
}
function* safari_walk_in(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.safariWalkIn?.(() => runner.resume()))
    return;
  yield;
}
function* lab_fossil(ctx, ...args) {
  const save = ctx.world.save;
  const species = args[0];
  if (species)
    save.labFossilMon = species;
  else
    delete save.labFossilMon;
}
function* check_party_room(ctx) {
  const party = ctx.world.save.party ?? [];
  ctx.lastCheck = party.length < 6;
}
function* check_item(ctx, ...args) {
  const inv = ctx.world.save.inventory ?? {};
  ctx.lastCheck = (inv[args[0]] ?? 0) > 0;
}
function* take_item(ctx, ...args) {
  remove(ctx.world.save, args[0], args[1] ?? 1);
}
function* clear_flag(ctx, ...args) {
  delete ctx.world.save.flags[args[0]];
}
function* check_dex_owned(ctx, ...args) {
  const need = args[0] ?? 1;
  const owned = ctx.world.save.pokedex?.owned ?? {};
  let n = 0;
  for (const k in owned)
    if (owned[k])
      n += 1;
  ctx.lastCheck = n >= need;
}
function* dex_rating() {}
function* rival_battle(ctx, ...args) {
  const oppClass = args[0];
  const baseParty = args[1] ?? 1;
  const opts = args[2] ?? {};
  const save = ctx.world.save;
  const offsets = opts.offsets ?? ctx.world.data.field?.starterCounterpicks;
  let offset = 0;
  if (offsets) {
    for (const [flag, mapped] of Object.entries(offsets)) {
      if (save.flags?.[flag]) {
        offset = mapped;
        break;
      }
    }
  } else if (save.flags?.EVENT_CHOSE_SQUIRTLE) {
    offset = 1;
  } else if (save.flags?.EVENT_CHOSE_BULBASAUR) {
    offset = 2;
  }
  yield* start_battle(ctx, "trainer", oppClass, baseParty + offset, { loseable: opts.loseable });
}
function* walk_npc(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  const ref = args[0];
  const dirs = args[1] ?? [];
  const entity = ref === "player" ? w.player : w.findNpc?.(ref);
  if (!entity || dirs.length === 0)
    return;
  let i = 0;
  const step = () => {
    if (i >= dirs.length) {
      runner.resume();
      return;
    }
    w.scriptMove(entity, dirs[i++], 1, step);
  };
  step();
  yield;
}
function* engage_trainer(ctx, ...args) {
  const runner = ctx.runner;
  const w = ctx.world;
  const npc = w.findNpc?.(args[0]);
  if (!npc || !w.engageTrainer) {
    ctx.lastCheck = false;
    return;
  }
  if (w.trainerDefeated?.(npc)) {
    ctx.lastCheck = true;
    return;
  }
  w.engageTrainer(npc, () => {
    ctx.lastCheck = w.trainerDefeated?.(npc) === true;
    runner.resume();
  });
  yield;
}
function* set_heal_point(ctx) {
  const w = ctx.world;
  const p = w.player;
  const save = ctx.world.save;
  save.lastHeal = {
    map: String(w.map?.id ?? ""),
    x: p?.cellX ?? 0,
    y: p?.cellY ?? 0,
    outdoor: save.lastOutdoor ? { ...save.lastOutdoor } : undefined
  };
}
function* old_man_demo(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (typeof w.startOldManDemo === "function") {
    w.startOldManDemo(() => runner.resume());
    yield;
  }
}
var VERBS = {
  show_text,
  ask,
  jump,
  jump_if_true,
  jump_if_false,
  label: label2,
  face_player,
  check_flag,
  set_flag,
  give_item,
  warp,
  wait,
  move_player,
  heal_party,
  play_once,
  fade,
  emote,
  pic,
  pic_hide,
  stamp,
  use_cut,
  use_flash,
  use_surf,
  use_fly,
  use_dig,
  use_teleport,
  play_cry,
  random_text,
  use_strength,
  give_pokemon,
  hide_object,
  show_object,
  face_object,
  move_npc_to,
  place_npc,
  move_player_to,
  start_battle,
  static_battle,
  trade,
  open_mart,
  open_vending,
  open_name_rater,
  open_elevator,
  walk_route,
  check_item,
  lab_fossil,
  check_party_room,
  check_money,
  take_money,
  check_coins,
  check_coins_below,
  give_coins,
  open_prizes,
  open_daycare,
  open_bike_shop,
  oaks_aide,
  safari_start,
  safari_end,
  take_guard_drink,
  safari_walk_in,
  take_item,
  clear_flag,
  check_dex_owned,
  dex_rating,
  rival_battle,
  walk_npc,
  engage_trainer,
  set_heal_point,
  old_man_demo,
  record_hall_of_fame,
  open_diploma,
  save_game,
  link_open,
  link_room,
  link_enter,
  link_trade,
  link_battle,
  push_screen: noop_object,
  play_sound,
  play_music,
  stop_music: noop_audio
};
function* save_game(ctx) {
  ctx.world.saveGame?.();
}
function* link_open(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.openLink?.() || !w.waitLink) {
    ctx.lastCheck = false;
    return;
  }
  w.waitLink((s) => {
    const st = s.state;
    return st === "linked" || st === "ready";
  }, LINK_WAIT_FRAMES, (ok) => {
    ctx.lastCheck = ok;
    runner.resume();
  });
  yield;
}
function* link_room(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.pickLinkRoom) {
    ctx.lastCheck = false;
    return;
  }
  w.pickLinkRoom((ok) => {
    ctx.lastCheck = ok;
    runner.resume();
  });
  yield;
}
function* link_battle(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.linkBattle)
    return;
  w.linkBattle(() => runner.resume());
  yield;
}
function* link_trade(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.linkTrade)
    return;
  w.linkTrade(() => runner.resume());
  yield;
}
function* link_enter(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.enterLinkRoom)
    return;
  w.enterLinkRoom(() => runner.resume());
  yield;
}
function* open_diploma(ctx) {
  const w = ctx.world;
  const runner = ctx.runner;
  if (!w.openDiploma)
    return;
  w.openDiploma(() => runner.resume());
  yield;
}
function* record_hall_of_fame(ctx) {
  const runner = ctx.runner;
  const w = ctx.world;
  if (!w.recordHallOfFame)
    return;
  w.recordHallOfFame(() => runner.resume());
  yield;
}
function scanLabels(script) {
  const labels = new Map;
  script.forEach((row, i) => {
    if (row[0] === "label" && typeof row[1] === "string" && !labels.has(row[1])) {
      labels.set(row[1], i + 1);
    }
  });
  return labels;
}

class ScriptRunner {
  co = null;
  waitingFrames = null;
  ctx = null;
  resuming = false;
  world;
  constructor(world) {
    this.world = world;
  }
  isRunning() {
    return this.co !== null;
  }
  run(script, extra) {
    if (this.isRunning())
      throw new Error("script already running");
    const ctx = { world: this.world, runner: this, ...extra };
    this.ctx = ctx;
    this.co = this.exec(script, ctx);
    this.resume();
  }
  *exec(script, ctx) {
    const labels = scanLabels(script);
    let pc = 1;
    while (pc <= script.length) {
      const row = script[pc - 1];
      const name = row[0];
      const fn = VERBS[name];
      if (!fn) {
        console.warn(`script: unknown command '${name}' (skipped)`);
        pc += 1;
        continue;
      }
      const jump2 = yield* fn(ctx, ...row.slice(1));
      if (typeof jump2 === "number") {
        pc = jump2;
      } else if (typeof jump2 === "string") {
        if (jump2 === "end")
          break;
        const target2 = labels.get(jump2);
        if (target2 === undefined)
          throw new Error(`jump to missing label '${jump2}' at row ${pc}`);
        pc = target2;
      } else {
        pc += 1;
      }
    }
    const done = ctx.onDone;
    if (done)
      done();
  }
  resume() {
    const co = this.co;
    if (!co)
      return;
    if (this.resuming) {
      this.waitingFrames = 1;
      return;
    }
    this.resuming = true;
    let r;
    try {
      r = co.next();
    } finally {
      this.resuming = false;
    }
    if (r.done) {
      if (this.co === co) {
        this.co = null;
        this.waitingFrames = null;
      }
    }
  }
  update() {
    if (this.isRunning() && this.waitingFrames !== null) {
      this.waitingFrames -= 1;
      if (this.waitingFrames <= 0) {
        this.waitingFrames = null;
        this.resume();
      }
    }
  }
}

// voxelmon/game/world/warp.ts
function onArrive(map, cx, cy) {
  const w = map.warpAtCell(cx, cy);
  if (w && map.isWarpTileCell(cx, cy)) {
    return w;
  }
  return null;
}
function extraCheck(map, carpets, cx, cy, dir) {
  const facingEdge = dir === "up" && cy === 0 || dir === "down" && cy === map.heightCells - 1 || dir === "left" && cx === 0 || dir === "right" && cx === map.widthCells - 1;
  if (!carpets)
    return facingEdge;
  let useCarpet;
  if (carpets.edgeMaps.includes(map.id)) {
    useCarpet = false;
  } else if (carpets.function2Maps.includes(map.id)) {
    useCarpet = true;
  } else {
    useCarpet = carpets.function2Tilesets.includes(map.def.tileset);
  }
  if (!useCarpet)
    return facingEdge;
  const [tx, ty] = target(cx, cy, dir);
  const front = map.cellTile(tx, ty);
  if (map.id === carpets.ssAnneBow.map) {
    return front === carpets.ssAnneBow.tile;
  }
  return carpets.tiles[dir].includes(front);
}
function onCollision(map, carpets, cx, cy, dir) {
  const w = map.warpAtCell(cx, cy);
  if (w && extraCheck(map, carpets, cx, cy, dir)) {
    return w;
  }
  return null;
}
function onEdge(map, cx, cy, dir) {
  const w = map.warpAtCell(cx, cy);
  if (!w)
    return null;
  const [tx, ty] = target(cx, cy, dir);
  if (!map.inBounds(tx, ty)) {
    return w;
  }
  return null;
}
function destination(data, warpDef, lastOutdoor) {
  let destMap = warpDef.destMap;
  if (destMap === "LAST_MAP") {
    if (!lastOutdoor) {
      throw new Error("LAST_MAP warp with no remembered outdoor map");
    }
    destMap = lastOutdoor.id;
    const destDef2 = data.maps?.[destMap];
    const dw2 = destDef2?.warps[warpDef.destWarp - 1];
    if (dw2) {
      return { map: destMap, x: dw2.x, y: dw2.y };
    }
    return { map: destMap, x: lastOutdoor.x, y: lastOutdoor.y };
  }
  const destDef = data.maps?.[destMap];
  if (!destDef)
    throw new Error(`warp to unknown map ${destMap}`);
  const dw = destDef.warps[warpDef.destWarp - 1];
  if (!dw)
    throw new Error(`warp to ${destMap}#${warpDef.destWarp} out of range`);
  return { map: destMap, x: dw.x, y: dw.y };
}

// voxelmon/game/world/overworld.ts
var DARK_MAPS = new Set(["ROCK_TUNNEL_1F", "ROCK_TUNNEL_B1F"]);
var DARK_TINT = 4282137660;
var BRIGHT_TINT = 4294967295;
var COMPASS = {
  up: "north",
  down: "south",
  left: "west",
  right: "east"
};
var FEMALE_TRAINERS = new Set([
  "OPP_LASS",
  "OPP_JR_TRAINER_F",
  "OPP_BEAUTY",
  "OPP_COOLTRAINER_F"
]);
var EVIL_TRAINERS = new Set([
  "OPP_UNUSED_JUGGLER",
  "OPP_GAMBLER",
  "OPP_ROCKER",
  "OPP_JUGGLER",
  "OPP_CHIEF",
  "OPP_SCIENTIST",
  "OPP_GIOVANNI",
  "OPP_ROCKET"
]);
function computeNeighbors(maps, rootId, hops) {
  const out = [];
  const rootDef = maps[rootId];
  if (!rootDef)
    return out;
  const placed = new Set([rootId]);
  const queue = [
    { def: rootDef, ox: 0, oy: 0, hops: 0 }
  ];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi];
    qi += 1;
    for (const [dir, conn] of Object.entries(cur.def.connections ?? {})) {
      const destDef = maps[conn.map];
      if (!destDef || placed.has(conn.map))
        continue;
      placed.add(conn.map);
      let ox;
      let oy;
      if (dir === "north") {
        ox = conn.offset * 32;
        oy = -destDef.height * 32;
      } else if (dir === "south") {
        ox = conn.offset * 32;
        oy = cur.def.height * 32;
      } else if (dir === "west") {
        ox = -destDef.width * 32;
        oy = conn.offset * 32;
      } else {
        ox = cur.def.width * 32;
        oy = conn.offset * 32;
      }
      ox += cur.ox;
      oy += cur.oy;
      if (cur.hops + 1 <= hops) {
        out.push({ id: conn.map, ox, oy });
        if (cur.hops + 1 < hops) {
          queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
        }
      }
    }
  }
  return out;
}
function objectToggleKey(nameOrObj) {
  const raw = typeof nameOrObj === "string" ? nameOrObj : nameOrObj.name ?? nameOrObj.text ?? "";
  return String(raw).toUpperCase().replace(/^TEXT_/, "");
}
var TOGGLE_DEFAULT_HIDDEN = {
  VIRIDIAN_CITY: { VIRIDIANCITY_OLD_MAN: true },
  VICTORY_ROAD_2F: { VICTORYROAD2F_BOULDER3: true }
};
var FORCED_BIKE_CLEAR_MAPS = ["ROUTE_16_GATE_1F", "ROUTE_18_GATE_1F"];
var POISON_STEP_INTERVAL = 4;
var BACK = { up: "down", down: "up", left: "right", right: "left" };

class Overworld {
  isCooked(mapId) {
    if (mapId === "LAST_MAP")
      return true;
    const list2 = this.shell.data.cookedMaps;
    return !list2 || list2.includes(mapId);
  }
  shell;
  map;
  player;
  npcs = [];
  entities = [];
  runner;
  scriptMoves = [];
  freeYaw;
  engaging = false;
  emote;
  lastOutdoor;
  standingOnWarp = false;
  warpEntryCell;
  transitioning = false;
  doorWarp = false;
  bumpCooldown = 0;
  oneShotPending = false;
  pendingSeamMusic = null;
  cameFromMapId;
  joyLatch;
  npcPool = new Map;
  tilePairs;
  carpets;
  encounterCount = 0;
  lastEncounter;
  constructor(shell) {
    this.shell = shell;
    const field = shell.data.field;
    this.tilePairs = field?.tilePairs ?? { land: [], water: [] };
    this.carpets = field?.warpCarpets;
    this.runner = new ScriptRunner(this);
  }
  get data() {
    return this.shell.data;
  }
  camTurns = 0;
  get save() {
    return this.shell.save;
  }
  enter(mapId, x, y, facing) {
    this.lastOutdoor = this.shell.save.lastOutdoor;
    this.setMap(mapId, x, y, facing, { via: "boot" });
    this.refreshStandingOnWarp();
  }
  setMap(mapId, x, y, facing, opts) {
    const def = this.shell.data.maps?.[mapId];
    if (!def)
      throw new Error(`unknown map ${mapId}`);
    this.cameFromMapId = this.map?.id;
    this.arrivalPending = true;
    this.pendingSeamMusic = null;
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset)
      throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(def, tileset, this.shell.data.field?.waterTilesets);
    this.applyGameCornerPoster(mapId, def);
    this.applyCardKeyDoors(mapId, def);
    this.applyToggleBlocks(mapId, def);
    this.applyLeagueSeals(mapId, def);
    if (mapId === "VICTORY_ROAD_2F" && this.save?.flags) {
      this.save.flags.EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH = false;
    }
    if (mapId === "ROUTE_23" && this.save?.flags) {
      for (const f of ROUTE_23_RESET_FLAGS)
        this.save.flags[f] = false;
      for (const h of ROAD_HOLES) {
        this.setObjectToggle(h.map, h.boulder, true);
        this.setObjectToggle(h.toMap, h.toBoulder, false);
      }
    }
    this.applyRoadBarriers(mapId, def);
    if (mapId === "VERMILION_GYM" && this.save?.flags?.[SECOND_LOCK]) {
      const door = trashData(this.shell.data)?.doorBlock ?? DOOR_BLOCK;
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
    }
    if (mapId === "VERMILION_CITY") {
      const save2 = this.save;
      (save2.trashPuzzle ??= {}).first = rollFirst(() => this.shell.rng.int(256));
    }
    for (const key of this.cutThisVisit) {
      const [mi, cx, cy] = key.split(",").map(Number);
      this.stamp(mi, cx, cy, true);
    }
    this.cutThisVisit.clear();
    const save = this.save;
    if (DARK_MAPS.has(mapId)) {
      this.tint(save.flashLit ? BRIGHT_TINT : DARK_TINT);
    } else {
      save.flashLit = undefined;
      this.tint(BRIGHT_TINT);
    }
    this.rollLuckySlot();
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map;
    }
    const sleeper = spotFor(mapId);
    if (sleeper && this.save?.flags?.[sleeper.beatFlag] === true) {
      const toggles = this.save.objectToggles ??= {};
      (toggles[mapId] ??= {})[sleeper.object] = false;
    }
    this.npcs = [];
    for (const obj of def.objects ?? []) {
      if (this.objectVisible(obj)) {
        const npc = this.pooledNPC(mapId, obj);
        npc.frozen = false;
        this.npcs.push(npc);
      }
    }
    if (this.player) {
      this.player.cellX = x;
      this.player.cellY = y;
      this.player.px = x * 16;
      this.player.py = y * 16;
      this.player.facing = facing ?? this.player.facing;
      this.player.moving = false;
      this.player.targetX = undefined;
      this.player.targetY = undefined;
    } else {
      this.player = new Player(x, y, facing);
    }
    this.entities = [this.player, ...this.npcs];
    this.syncLastMapRewrite();
    this.syncBike();
    if (FORCED_BIKE_CLEAR_MAPS.includes(mapId) || !this.save.onBike) {
      this.save.forcedBike = false;
    }
    this.syncSurf();
    visit(this.save, mapId);
    MAP_SCRIPTS[mapId]?.onEnter?.(this, this.save);
  }
  objectVisible(obj) {
    const key = objectToggleKey(obj);
    const toggles = this.save?.objectToggles?.[this.map.id];
    if (toggles && Object.prototype.hasOwnProperty.call(toggles, key)) {
      if (!toggles[key])
        return false;
    } else {
      if (TOGGLE_DEFAULT_HIDDEN[this.map.id]?.[key])
        return false;
      if (this.seafoamHidden()[this.map.id]?.[key])
        return false;
      if (obj.hidden)
        return false;
    }
    if (obj.item && this.save?.flags?.[itemBallFlag(this.map.id, obj.text)]) {
      return false;
    }
    return true;
  }
  pooledNPC(mapId, obj) {
    const key = `${mapId}_obj_${obj.index}`;
    let npc = this.npcPool.get(key);
    if (!npc) {
      npc = new NPC(mapId, obj, this.shell.npcRng);
      this.npcPool.set(key, npc);
    }
    return npc;
  }
  update() {
    if (this.bumpCooldown > 0)
      this.bumpCooldown -= 1;
    this.runner.update();
    if (this.emote) {
      this.emote.frames -= 1;
      if (this.emote.frames <= 0) {
        const done = this.emote.onDone;
        this.emote = undefined;
        done?.();
      }
      this.player.update();
      return;
    }
    for (const npc of this.npcs) {
      npc.update(this.map, this.entities, this.shell.npcRng, this.tilePairs);
    }
    this.updateScriptMoves();
    let scripted = this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined || this.engaging;
    if (!scripted && !this.transitioning) {
      this.checkTrainerSight();
      scripted = this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined || this.engaging;
    }
    if (!scripted && !this.transitioning)
      this.arrivalTriggers();
    if (!scripted && !this.transitioning) {
      if (this.freeMoveActive()) {
        this.freeWalk();
      } else {
        this.snapToCell();
        this.handleInput();
        this.rollDownhill();
      }
    }
    const stepped = this.player.update();
    const entry = this.warpEntryCell;
    if (entry && (this.player.cellX !== entry.x || this.player.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
    }
    if (stepped && this.pendingSeamMusic) {
      const pending = this.pendingSeamMusic;
      this.pendingSeamMusic = null;
      if (pending === this.map.id)
        this.shell.startMapMusic(pending);
    }
    if (stepped && !scripted) {
      this.onStepComplete();
    }
  }
  stick;
  cutThisVisit = new Set;
  freeMoveActive() {
    if (this.freeYaw === undefined)
      return false;
    const mv = this.save.options?.movement;
    return mv !== "grid";
  }
  snapToCell() {
    const p = this.player;
    if (p.moving)
      return;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
  }
  freeOpen(cx, cy) {
    const m = this.map;
    const p = this.player;
    if (!m.inBounds(cx, cy))
      return false;
    if (!m.isWalkableCell(cx, cy) && !(p.surfing && m.isWaterCell(cx, cy)))
      return false;
    if ((cx !== p.cellX || cy !== p.cellY) && occupied(this.entities, cx, cy, p))
      return false;
    return true;
  }
  freeWalk() {
    const input = this.shell.input;
    const p = this.player;
    if (p.moving)
      return;
    if (input.wasPressed("a") || input.wasPressed("start") || input.wasPressed("select")) {
      this.snapToCell();
      this.handleInput();
      return;
    }
    const stick = stickPush(this.stick);
    const sx = stick ? stick.x : (input.isDown("right") ? 1 : 0) - (input.isDown("left") ? 1 : 0);
    const sy = stick ? -stick.y : (input.isDown("down") ? 1 : 0) - (input.isDown("up") ? 1 : 0);
    const dir = sx === 0 && sy === 0 && this.slopeRolls() ? freeDir(0, 1, 0) : freeDir(sx, sy, this.freeYaw ?? 0);
    if (!dir)
      return;
    const speed = 16 / p.stepSpeed() * (stick ? stick.throw : 1);
    const r = slide(p.px, p.py, dir[0] * speed, dir[1] * speed, (x, y) => this.freeOpen(x, y));
    p.facing = quantize(dir[0], dir[1]);
    if (!r.moved) {
      if (Math.abs(p.px - p.cellX * 16) <= 8 && Math.abs(p.py - p.cellY * 16) <= 8) {
        this.snapToCell();
        this.handleInput();
      }
      return;
    }
    p.px = r.px;
    p.py = r.py;
    p.bumpFrames = 2;
    const cx = cellOf(p.px);
    const cy = cellOf(p.py);
    if (cx !== p.cellX || cy !== p.cellY) {
      p.cellX = cx;
      p.cellY = cy;
      p.stepFlip = !p.stepFlip;
      p.landedCount += 1;
      this.onStepComplete();
    }
  }
  dirHeld() {
    const input = this.shell.input;
    return input.isDown("up") || input.isDown("down") || input.isDown("left") || input.isDown("right");
  }
  canCollisionWarp() {
    return this.standingOnWarp;
  }
  refreshStandingOnWarp() {
    const p = this.player;
    this.standingOnWarp = false;
    if (this.map.warpAtCell(p.cellX, p.cellY) && !(this.map.isWarpTileCell(p.cellX, p.cellY) && !this.map.isDoorTileCell(p.cellX, p.cellY))) {
      this.standingOnWarp = true;
    }
  }
  handleInput() {
    const input = this.shell.input;
    if (this.player.moving) {
      if (input.wasPressed("a")) {
        this.joyLatch = { ...this.joyLatch, a: true };
      }
      return;
    }
    const latch = this.joyLatch;
    this.joyLatch = undefined;
    if (input.wasPressed("a") || latch?.a === true && input.isDown("a")) {
      this.interact();
      return;
    }
    if (input.wasPressed("start")) {
      this.shell?.openStartMenu?.();
      return;
    }
    for (const screenDir of ["up", "down", "left", "right"]) {
      if (!input.isDown(screenDir))
        continue;
      const dir = rotateDir(screenDir, this.camTurns);
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir))
          return;
        if (this.checkLedgeHop(dir))
          return;
        if (this.checkBoulderPush(dir))
          return;
      }
      {
        const [tx, ty] = target(this.player.cellX, this.player.cellY, dir);
        const w = this.map.warpAtCell(tx, ty);
        if (w && this.map.isWarpTileCell(tx, ty) && !this.isCooked(w.def.destMap)) {
          this.player.facing = dir;
          this.player.bumpFrames = this.player.stepFrames;
          return;
        }
      }
      const result = this.player.tryMove(dir, this.map, this.entities, this.tilePairs);
      if (result === "blocked" && this.canCollisionWarp()) {
        const w = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (w) {
          this.takeWarp(w.def);
          return;
        }
      }
      if (result === "blocked" && this.player.lastBlockReason !== "entity" && this.bumpCooldown <= 0) {
        this.shell.audio.playSfx("Collision");
        this.bumpCooldown = 16;
      }
      return;
    }
    this.player.turnArmed = true;
  }
  checkLedgeHop(dir) {
    const p = this.player;
    const tileset = this.map.def.tileset;
    const standing = this.map.cellTile(p.cellX, p.cellY);
    const [fx, fy] = target(p.cellX, p.cellY, dir);
    if (!this.map.inBounds(fx, fy))
      return false;
    const front = this.map.cellTile(fx, fy);
    const ledges = this.shell.data.field?.ledges;
    for (const ledge of ledges ?? []) {
      if ((ledge.tileset ?? "OVERWORLD") === tileset && ledge.facing === dir && ledge.input === dir && ledge.standingTile === standing && ledge.ledgeTile === front) {
        const [lx, ly] = target(fx, fy, dir);
        if (!this.map.inBounds(lx, ly)) {
          const landing = this.connectionLanding(dir);
          if (!landing)
            return false;
          const { dest, ts, x, y } = landing;
          if (!defPassable(dest, ts, x, y, p.surfing))
            return false;
          this.shell.audio.playSfx("Ledge");
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 1, () => this.checkEdgeExit(dir));
          return true;
        }
        if (!occupied(this.entities, lx, ly, p) && this.map.isWalkableCell(lx, ly)) {
          this.shell.audio.playSfx("Ledge");
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 2);
          return true;
        }
      }
    }
    return false;
  }
  checkEdgeExit(dir) {
    const p = this.player;
    const [tx, ty] = target(p.cellX, p.cellY, dir);
    if (this.map.inBounds(tx, ty))
      return false;
    const w = onEdge(this.map, p.cellX, p.cellY, dir);
    if (w) {
      if (!this.canCollisionWarp())
        return false;
      this.takeWarp(w.def);
      return true;
    }
    const conn = this.map.connection(COMPASS[dir]);
    if (conn) {
      return this.crossConnection(dir, conn);
    }
    return false;
  }
  connectionLanding(dir) {
    const conn = this.map.connection(COMPASS[dir]);
    if (!conn)
      return null;
    const dest = this.shell.data.maps?.[conn.map];
    if (!dest)
      return null;
    const ts = this.shell.data.tilesets?.[dest.tileset];
    if (!ts)
      return null;
    const p = this.player;
    const destW = dest.width * 2;
    const destH = dest.height * 2;
    let x;
    let y;
    if (dir === "up") {
      x = p.cellX - conn.offset * 2;
      y = destH - 1;
    } else if (dir === "down") {
      x = p.cellX - conn.offset * 2;
      y = 0;
    } else if (dir === "left") {
      x = destW - 1;
      y = p.cellY - conn.offset * 2;
    } else {
      x = 0;
      y = p.cellY - conn.offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return { dest, ts, x, y, conn };
  }
  crossConnection(dir, _conn) {
    if (!this.isCooked(_conn.map))
      return false;
    const landing = this.connectionLanding(dir);
    if (!landing)
      return false;
    const { dest, ts, x, y } = landing;
    const p = this.player;
    if (!defPassable(dest, ts, x, y, p.surfing)) {
      return false;
    }
    this.setMap(dest.id, x, y, p.facing, { seamless: true });
    const d = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0]
    };
    p.cellX = x - d[dir][0];
    p.cellY = y - d[dir][1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.progress = 0;
    p.animClock = 0;
    p.stepFramesCur = p.stepSpeed();
    this.pendingSeamMusic = dest.id;
    return true;
  }
  interact() {
    const p = this.player;
    const [fx, fy] = p.facingCell();
    let npc = this.npcAtCell(fx, fy);
    if (!npc && this.map.isCounterCell(fx, fy)) {
      const [fx2, fy2] = target(fx, fy, p.facing);
      npc = this.npcAtCell(fx2, fy2);
    }
    if (npc) {
      if (!npc.moving) {
        this.talkTo(npc);
      }
      return;
    }
    if (this.trySlotSeat(fx, fy))
      return;
    const sign = this.map.signAtCell(fx, fy);
    if (sign) {
      this.showMapText(sign.text);
      return;
    }
    if (this.map.id === "BILLS_HOUSE" && fx === 1 && fy === 4 && p.facing === "up") {
      this.showMapText(TEXT_BILLSHOUSE_PC);
      return;
    }
    if (this.tryCardKeyDoor(fx, fy))
      return;
    if (this.tryMansionSwitch(fx, fy))
      return;
    if (this.tryGymQuiz(fx, fy))
      return;
    if (this.tryTrashCan(fx, fy))
      return;
    if (this.tryHiddenItem(fx, fy))
      return;
    if (pcTileAt(this.map.id, fx, fy, p.facing)) {
      const t = this.shell.data.text ?? {};
      this.shell.showText(t._TurnedOnPC1Text ?? `{PLAYER} turned on
the PC.`, () => {
        this.shell.openPc?.();
      });
      return;
    }
  }
  talkTo(npc) {
    npc.frozen = true;
    const unfreeze = () => {
      npc.frozen = false;
    };
    const def = npc.def;
    if (def.trainerClass && !talkScript(this.map.id, def.text)) {
      if (!this.trainerDefeated(npc)) {
        npc.facePlayer(this.player);
        this.engageTrainer(npc, unfreeze);
        return;
      }
      const key = this.trainerHeader(npc)?.after;
      const after = key ? this.shell.data.text?.[key] : undefined;
      if (after) {
        npc.facePlayer(this.player);
        this.shell.showText(after, unfreeze);
        return;
      }
    }
    this.showMapText(npc.def.text, npc, unfreeze);
  }
  showMapText(textConst, npc, onDone) {
    const talk = talkScript(this.map.id, textConst);
    const script = (typeof talk === "function" ? talk(this, this.save) : talk) ?? itemBallScript(this.map.id, npc?.def) ?? martGreetScript(this.shell.data, this.map.def.label, textConst) ?? nurseGreetScript(textConst) ?? cableClubScript(textConst);
    if (script && !this.runner.isRunning()) {
      if (npc)
        npc.frozen = true;
      this.runner.run(script, {
        npc,
        onDone: () => {
          if (this.oneShotPending) {
            this.oneShotPending = false;
            this.shell.restoreMapMusic();
          }
          onDone?.();
        }
      });
      return;
    }
    const text = this.resolveText(textConst);
    if (text !== null) {
      if (npc)
        npc.facePlayer(this.player);
      this.shell.showText(text, onDone);
    } else {
      onDone?.();
    }
  }
  trySlotSeat(fx, fy) {
    const seats = this.shell.data.field?.slotMachines?.[this.map.id];
    if (!seats)
      return false;
    const i = seats.findIndex((s) => s.x === fx && s.y === fy);
    if (i < 0)
      return false;
    const seat = seats[i];
    const t = this.shell.data.text ?? {};
    const say = (k, fallback) => {
      this.shell.showText(t[k] ?? fallback);
      return true;
    };
    if (seat.state === "out_of_order") {
      return say("_GameCornerOutOfOrderText", `OUT OF ORDER
This is broken.`);
    }
    if (seat.state === "out_to_lunch") {
      return say("_GameCornerOutToLunchText", `OUT TO LUNCH
This is reserved.`);
    }
    if (seat.state === "keys") {
      return say("_GameCornerSomeonesKeysText", `Someone's keys!
They'll be back.`);
    }
    if (!this.save.inventory?.COIN_CASE) {
      return say("_GameCornerCoinCaseText", `A COIN CASE is
required!`);
    }
    if ((this.save.coins ?? 0) === 0) {
      return say("_GameCornerNoCoinsText", `You don't have
any coins!`);
    }
    this.shell.openSlots?.(i === this.luckySlot);
    return true;
  }
  luckySlot = -1;
  rollLuckySlot() {
    const seats = this.shell.data.field?.slotMachines?.[this.map.id];
    this.luckySlot = seats && seats.length > 0 ? this.shell.rng.int(seats.length) : -1;
  }
  openPrizes(window, onDone) {
    this.shell.openPrizes?.(window, onDone);
  }
  syncBike() {
    const save = this.save;
    const rules = this.shell.data.field?.bikeRiding;
    if (save.onBike && !bikeAllowed(this.map.id, this.map.def?.tileset, rules)) {
      save.onBike = false;
    }
    if (this.player)
      this.player.onBike = !!save.onBike;
  }
  canRideHere() {
    const rules = this.shell.data.field?.bikeRiding;
    return bikeAllowed(this.map.id, this.map.def?.tileset, rules);
  }
  openOaksAide(textId, onDone) {
    this.shell.openOaksAide?.(textId, onDone);
  }
  openBikeShop(onDone) {
    this.shell.openBikeShop?.(onDone);
  }
  canSurfHere() {
    const p = this.player;
    if (p.surfing)
      return false;
    const [fx, fy] = p.facingCell();
    if (!this.map.inBounds(fx, fy))
      return false;
    if (!this.map.isWaterCell(fx, fy))
      return false;
    return canMove(this.map, this.entities, { ...p, surfing: true }, p.facing, this.tilePairs).ok;
  }
  startSurfing() {
    const p = this.player;
    p.surfing = true;
    this.save.surfing = true;
    this.scriptMove(p, p.facing, 1);
    this.syncSurfSong();
  }
  syncSurf() {
    const p = this.player;
    const onWater = this.map.isWaterCell(p.cellX, p.cellY);
    if (p.surfing === onWater)
      return;
    p.surfing = onWater;
    this.save.surfing = onWater;
    this.syncSurfSong();
  }
  syncSurfSong() {
    const save = this.save;
    this.shell.audio?.startMap?.(this.map.id, save.onBike === true, this.player.surfing === true);
  }
  enableStrength() {
    this.save.strengthActive = true;
  }
  isBoulder(npc) {
    const def = npc?.def;
    return String(def?.sprite ?? "").includes("BOULDER");
  }
  checkBoulderPush(dir) {
    if (!this.save.strengthActive)
      return false;
    const p = this.player;
    if (this.scriptMoves.length > 0 || this.runner.isRunning())
      return false;
    const [bx, by] = target(p.cellX, p.cellY, dir);
    const boulder = this.npcs.find((n) => n.cellX === bx && n.cellY === by && this.isBoulder(n));
    if (!boulder)
      return false;
    const [tx, ty] = target(bx, by, dir);
    if (!this.map.inBounds(tx, ty))
      return false;
    const hole = isHole(this.seafoam(), this.map.id, tx, ty);
    if (!this.map.isWalkableCell(tx, ty) && !hole)
      return false;
    if (this.map.isWaterCell(tx, ty) && !hole)
      return false;
    if (occupied(this.entities, tx, ty, boulder))
      return false;
    this.shell.audio.playSfx("Push_Boulder");
    this.scriptMove(boulder, dir, 1, () => this.boulderLanded());
    this.scriptMove(p, dir, 1);
    return true;
  }
  rollByte() {
    return this.shell.npcRng.byte();
  }
  playCry(species) {
    this.shell.audio.playCry?.(species);
  }
  escapeWarp() {
    return this.shell.escapeWarp?.() ?? false;
  }
  openFlyPicker(monName2, onDone) {
    this.shell.openFlyPicker?.(monName2, onDone);
  }
  link = null;
  linkWait = null;
  openLink() {
    if (this.link && this.link.state !== "closed")
      return true;
    const shell = this.shell;
    const t = shell.linkTransport ? shell.linkTransport() : hostTransport();
    if (!t)
      return false;
    this.link = new LinkSession(t, String(this.save.player?.name ?? "RED"));
    this.link.open();
    return true;
  }
  waitLink(until, frames, done) {
    this.linkWait = { until, frames, done };
  }
  serviceLink() {
    this.pollLink();
    if (this.link && this.inLinkRoom()) {
      const p = this.player;
      this.link.sendPos(Math.round(p.px), Math.round(p.py), p.facing);
      this.syncPeerBody();
    }
  }
  pollLink() {
    const s = this.link;
    if (!s)
      return;
    s.poll();
    const w = this.linkWait;
    if (!w)
      return;
    if (w.until(s)) {
      this.linkWait = null;
      w.done(true);
      return;
    }
    w.frames -= 1;
    if (w.frames <= 0 || s.state === "closed") {
      this.linkWait = null;
      w.done(false);
    }
  }
  pickLinkRoom(done) {
    const shell = this.shell;
    if (!shell.pickLinkRoom) {
      done(false);
      return;
    }
    shell.pickLinkRoom(this.link, done);
  }
  enterLinkRoom(done) {
    const room = this.link?.agreedRoom() ?? 0;
    const seat = LINK_SEATS[this.link?.seat() ?? 0];
    const map = LINK_ROOM_MAP[room] ?? LINK_ROOM_MAP[0];
    this.startWarpTo(map, seat.enter.x, seat.enter.y, seat.facing, done);
  }
  inLinkRoom() {
    return LINK_ROOM_MAP.includes(this.map?.id ?? "");
  }
  syncPeerBody() {
    const s = this.link;
    if (!s)
      return;
    const p = s.peerPos;
    if (!p)
      return;
    const body = this.npcs.find((n) => String(n.def.name ?? "").endsWith("_OPPONENT"));
    if (!body)
      return;
    body.px = p.x;
    body.py = p.y;
    body.cellX = Math.round(p.x / 16);
    body.cellY = Math.round(p.y / 16);
    body.facing = p.facing;
  }
  seatedAtTable() {
    const s = this.link;
    if (!s || !this.inLinkRoom())
      return false;
    const mine = LINK_SEATS[s.seat()];
    const p = this.player;
    return p.cellX === mine.seat.x && p.cellY === mine.seat.y;
  }
  peerSeated() {
    const s = this.link;
    const p = s?.peerPos;
    if (!s || !p)
      return false;
    const theirs = LINK_SEATS[s.seat() === 0 ? 1 : 0];
    return Math.round(p.x / 16) === theirs.seat.x && Math.round(p.y / 16) === theirs.seat.y;
  }
  linkBattle(done) {
    const shell = this.shell;
    if (!shell.linkBattle) {
      done();
      return;
    }
    shell.linkBattle(done);
  }
  linkTrade(done) {
    const shell = this.shell;
    if (!shell.linkTrade) {
      done();
      return;
    }
    shell.linkTrade(done);
  }
  saveGame() {
    this.shell.writeSave?.();
  }
  openDiploma(onDone) {
    this.shell.openDiploma?.(onDone);
  }
  recordHallOfFame(onDone) {
    this.shell.recordHallOfFame?.(onDone);
  }
  openDaycare(onDone) {
    this.shell.openDaycare?.(onDone);
  }
  pickPartyMon(onPick, onCancel) {
    const shell = this.shell;
    if (shell.pickPartyMon)
      shell.pickPartyMon(onPick, onCancel);
    else
      onCancel();
  }
  healParty() {
    this.shell.healParty();
  }
  stamp(mapId, cx, cy, on) {
    this.shell.stamp(mapId, cx, cy, on);
  }
  fieldFx(x, z, frame) {
    this.shell.fieldFx?.(x, z, frame);
  }
  tint(abgr) {
    this.shell.tint(abgr);
  }
  playSfx(name) {
    this.shell.audio?.playSfx?.(name);
  }
  playOnce(songId, onDone) {
    this.oneShotPending = true;
    this.shell.playOnce(songId);
    onDone();
  }
  fade(_dir, frames, onDone) {
    this.shell.pushWarpFade(frames, () => {}, onDone);
  }
  facePlayer(npc) {
    npc.facePlayer(this.player);
  }
  resolveText(textConst) {
    const pointers = this.shell.data.text_pointers;
    const texts = this.shell.data.text;
    const entry = pointers?.[this.map.def.label]?.[textConst];
    if (!entry || !texts)
      return null;
    if (entry.text) {
      const s = texts[entry.text];
      if (s)
        return s;
    }
    if (entry.label) {
      const s = texts[`_${entry.label}`];
      if (s)
        return s;
    }
    return null;
  }
  npcAtCell(cx, cy) {
    return this.npcs.find((npc) => !npc.hidden && (npc.cellX === cx && npc.cellY === cy || npc.targetX === cx && npc.targetY === cy));
  }
  safariStart() {
    this.save.safari = { balls: SAFARI_BALLS, steps: SAFARI_STEPS };
  }
  safariEnd() {
    this.save.safari = null;
  }
  safariWalkIn(done) {
    const p = this.player;
    if (p.cellY !== 2)
      return false;
    const w = this.map.warpAtCell?.(p.cellX, 0);
    if (!w)
      return false;
    this.scriptMove(p, "up", 2, () => {
      const st = this.save.safari;
      if (st)
        st.steps -= SAFARI_WALK_IN_STEPS;
      this.takeWarp(w.def);
      done();
    });
    return true;
  }
  safariStep() {
    const st = this.save.safari;
    if (!st || !inSafariStepZone(this.map.id))
      return false;
    st.steps -= 1;
    if (st.steps > 0)
      return false;
    this.safariGameOver("_TimesUpText");
    return true;
  }
  safariGameOver(reasonText) {
    this.save.safari = null;
    this.shell.playOnce("Safari_Zone_PA");
    const t = this.shell.data.text ?? {};
    const reason = t[reasonText] ?? reasonText;
    const over = t._GameOverText ?? `PA: Your SAFARI
GAME is over!`;
    this.shell.showText(`${reason}\f${over}`, () => {
      this.startWarpTo(SAFARI_EXIT.map, SAFARI_EXIT.x, SAFARI_EXIT.y, SAFARI_EXIT.facing);
    });
  }
  mansionHoleStep() {
    if (this.runner.isRunning() || this.map?.id !== "POKEMON_MANSION_3F")
      return false;
    const p = this.player;
    const h = MANSION_HOLES.find((r) => r.x === p.cellX && r.y === p.cellY);
    if (!h)
      return false;
    this.shell.playOnce?.("Faint_Fall");
    this.startWarpTo(h.map, h.dx, h.dy, p.facing);
    return true;
  }
  runLandTriggers() {
    if (this.runner.isRunning())
      return false;
    const label3 = this.map?.id ?? "";
    const script = MAP_SCRIPTS[label3];
    const host = MAP_SCRIPTS[label3 + "_ONSTEP_HOST"];
    const rows = script?.onStep?.(this, this.save) ?? host?.onStep?.(this, this.save) ?? this.coordTrigger(script) ?? this.coordTrigger(host);
    if (!rows)
      return false;
    this.runScript(rows);
    return true;
  }
  arrivalPending = false;
  arrivalTriggers() {
    if (!this.arrivalPending)
      return;
    if (this.transitioning || this.player.moving)
      return;
    if (this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote || this.engaging) {
      return;
    }
    this.arrivalPending = false;
    if (this.seafoamStep())
      return;
    this.runLandTriggers();
  }
  onStepComplete() {
    if (this.safariStep())
      return;
    const rs = this.save;
    if ((rs.repelSteps ?? 0) > 0) {
      rs.repelSteps = (rs.repelSteps ?? 0) - 1;
      if (rs.repelSteps === 0) {
        const t = this.shell.data.text ?? {};
        this.shell.showText(t._RepelWoreOffText ?? `REPEL's effect
wore off.`);
      }
    }
    if (this.fieldPoisonStep())
      return;
    const dc = this.save.daycare;
    if (dc?.mon)
      dc.steps = (dc.steps ?? 0) + 1;
    this.syncLastMapRewrite();
    this.syncSurf();
    if (this.mansionHoleStep())
      return;
    if (this.roadHoleStep())
      return;
    this.lanceLockDoor();
    if (this.leagueDontRun())
      return;
    if (this.badgeGateStep())
      return;
    if (this.forcedTileStep())
      return;
    if (this.seafoamStep())
      return;
    if (this.spinnerStep())
      return;
    if (this.runLandTriggers())
      return;
    const p = this.player;
    let entry = this.warpEntryCell;
    if (entry && (p.cellX !== entry.x || p.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
      entry = undefined;
    }
    this.refreshStandingOnWarp();
    if (!entry) {
      let w = onArrive(this.map, p.cellX, p.cellY);
      const forced = this.forcedWarp;
      this.forcedWarp = false;
      if (!w && (this.dirHeld() || forced)) {
        w = onCollision(this.map, this.carpets, p.cellX, p.cellY, p.facing);
      }
      if (w) {
        this.takeWarp(w.def);
        return;
      }
    }
    const encDef = this.shell.data.encounters[this.map.id];
    const indoor = this.shell.data.field?.indoorEncounters;
    let enc = null;
    if (p.surfing && encDef?.water && this.map.isWaterCell(p.cellX, p.cellY)) {
      enc = roll({ grass: encDef.water }, this.shell.rng);
    } else if (this.map.isGrassCell(p.cellX, p.cellY)) {
      enc = roll(encDef, this.shell.rng);
    } else if (indoor && this.map.def.index >= indoor.firstIndoorMap && this.map.def.tileset !== indoor.excludedTileset) {
      enc = roll(encDef, this.shell.rng);
    }
    if (enc && repelled(this.save, enc.level))
      enc = null;
    if (enc) {
      this.encounterCount += 1;
      this.lastEncounter = enc;
      this.shell.pushStubBattle(enc.species, enc.level);
    }
  }
  takeWarp(warpDef) {
    let last = this.lastOutdoor;
    if (warpDef.destMap === "LAST_MAP" && !last) {
      const heal = this.shell.save.lastHeal;
      if (heal)
        last = { id: heal.map, x: heal.x, y: heal.y };
    }
    const dest = destination(this.shell.data, warpDef, last);
    const facing = this.player.facing;
    const pad = this.map.warpPadOrHoleAt(this.player.cellX, this.player.cellY);
    if (pad === undefined) {
      this.doorWarp = true;
    }
    this.startWarpTo(dest.map, dest.x, dest.y, facing);
  }
  syncLastMapRewrite() {
    const rewrite = LAST_MAP_REWRITES[this.map.id];
    if (!rewrite)
      return;
    const id = rewrittenLastMap(rewrite, this.player.cellX, this.player.cellY);
    if (!id || this.lastOutdoor?.id === id)
      return;
    const w = this.shell.data.maps?.[id]?.warps?.[0];
    this.rememberOutdoor(id, w?.x ?? 0, w?.y ?? 0);
  }
  rememberOutdoor(id, x, y) {
    this.lastOutdoor = { id, x, y };
    this.shell.save.lastOutdoor = this.lastOutdoor;
  }
  startWarpTo(mapId, x, y, facing, onDone) {
    if (!this.isCooked(mapId)) {
      this.doorWarp = false;
      onDone?.();
      return;
    }
    if (isOutside(this.map.def) && mapId !== this.map.id) {
      this.rememberOutdoor(this.map.id, this.player.cellX, this.player.cellY);
    }
    this.transitioning = true;
    const doorWarp = this.doorWarp;
    this.doorWarp = false;
    this.shell.pushWarpFade(WARP_FADE_OUT, () => {
      this.setMap(mapId, x, y, facing ?? "down");
      this.warpEntryCell = { x, y };
      if (doorWarp) {
        this.shell.audio.playSfx(isOutside(this.map.def) ? "Go_Outside" : "Go_Inside");
      }
      if (doorWarp && this.map.isDoorTileCell(this.player.cellX, this.player.cellY)) {
        if (canMove(this.map, this.entities, this.player, "down", this.tilePairs).ok) {
          this.warpEntryCell = undefined;
          this.scriptMove(this.player, "down", 1);
        } else {
          this.player.facing = "down";
        }
      }
    }, () => {
      this.transitioning = false;
      onDone?.();
    });
  }
  scriptMove(entity, dir, tiles, onDone) {
    this.scriptMoves.push({ entity, dir, remaining: tiles, onDone });
  }
  updateScriptMoves() {
    let i = 0;
    while (i < this.scriptMoves.length) {
      const mv = this.scriptMoves[i];
      if (!mv.entity.moving && mv.remaining <= 0) {
        this.scriptMoves.splice(i, 1);
        mv.onDone?.();
      } else {
        i += 1;
      }
    }
    for (const mv of this.scriptMoves) {
      const e = mv.entity;
      if (!e.moving && mv.remaining > 0) {
        if (mv.inPlace) {
          e.moving = true;
          e.marching = true;
          e.progress = 0;
        } else {
          e.facing = mv.dir;
          const [tx, ty] = target(e.cellX, e.cellY, mv.dir);
          e.targetX = tx;
          e.targetY = ty;
          e.moving = true;
          e.progress = 0;
          if (e instanceof Player) {
            e.stepFramesCur = e.stepSpeed();
          }
        }
        mv.remaining -= 1;
      }
    }
  }
  picShown = null;
  showPic(page, x, y, w, h) {
    this.picShown = { page, x, y, w, h };
  }
  hidePic() {
    this.picShown = null;
  }
  coordTrigger(script) {
    const coords = script?.coord;
    if (!coords)
      return null;
    const p = this.player;
    const flags = this.save?.flags ?? {};
    for (const c of coords) {
      if (c.x !== p.cellX || c.y !== p.cellY)
        continue;
      if (c.unlessFlag && flags[c.unlessFlag])
        continue;
      if (c.ifFlag && !flags[c.ifFlag])
        continue;
      return c.rows;
    }
    return null;
  }
  runScript(script, onDone) {
    this.runner.run(script, { onDone });
  }
  findNpc(ref) {
    const list2 = this.npcs;
    if (typeof ref === "number") {
      const byName = list2.find((n) => String(n?.id ?? n?.name ?? "").endsWith("_obj_" + ref));
      return byName ?? list2[ref - 1] ?? list2[ref] ?? null;
    }
    const want = String(ref);
    return list2.find((n) => n?.name === want || n?.id === want || n?.obj?.name === want || n?.def?.name === want) ?? list2.find((n) => {
      const t = String(n?.def?.text ?? "").toUpperCase();
      const w = want.toUpperCase();
      return t === w || t === "TEXT_" + w || t.replace(/^TEXT_/, "") === w;
    }) ?? list2.find((n) => {
      const sp = String(n?.def?.sprite ?? "").toUpperCase();
      return sp === want.toUpperCase();
    }) ?? null;
  }
  askNickname(defaultName, onDone) {
    const shell = this.shell ?? this.game ?? null;
    if (!shell?.askNickname) {
      onDone(null);
      return;
    }
    shell.askNickname(defaultName, onDone);
  }
  walkRoute(ref, route, onDone) {
    const list2 = route.slice();
    const next = () => {
      const wp = list2.shift();
      if (!wp) {
        onDone();
        return;
      }
      if (ref === "player")
        this.movePlayerTo(wp[0], wp[1], next);
      else
        this.moveNpcTo(ref, wp[0], wp[1], next);
    };
    next();
  }
  openElevator(onDone) {
    const shell = this.shell;
    if (shell?.openElevator)
      shell.openElevator(this.map.id, onDone);
    else
      onDone();
  }
  openNameRater(onDone) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openNameRater)
      shell.openNameRater(onDone);
    else
      onDone();
  }
  openVending(onDone) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openVending)
      shell.openVending(onDone);
    else
      onDone();
  }
  openShop(stock, onQuit) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openShop)
      shell.openShop(stock, onQuit);
    else
      onQuit();
  }
  openBox() {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    shell?.openBox?.();
  }
  trainerHeader(npc) {
    const headers = this.shell.data.trainer_headers;
    const forMap = headers?.[this.map.def.label];
    if (!forMap)
      return;
    if (Array.isArray(forMap))
      return forMap[npc.def.index - 1];
    return forMap[npc.def.index];
  }
  trainerDefeated(npc) {
    if (this.save.defeatedTrainers?.[npc.id])
      return true;
    const ev = this.trainerHeader(npc)?.event;
    return !!ev && this.save.flags?.[ev] === true;
  }
  markTrainerDefeated(npc, event) {
    const save = this.save;
    (save.defeatedTrainers ??= {})[npc.id] = true;
    if (event && this.save.flags)
      this.save.flags[event] = true;
    this.syncGymGates();
    this.syncLeagueSeal();
  }
  syncGymGates() {
    if (this.map?.id !== "CINNABAR_GYM")
      return;
    const flags = this.save.flags;
    if (!flags)
      return;
    let opened = false;
    GYM_MACHINES.forEach((m, i) => {
      const beaten = this.save.defeatedTrainers?.[gymGuardKey(m.npc)] === true;
      if (beaten && flags[gymGateFlag(i)] !== true) {
        flags[gymGateFlag(i)] = true;
        opened = true;
      }
    });
    if (opened)
      this.shell.playOnce?.("Go_Inside");
    this.applyToggleBlocks(this.map.id, this.map.def);
  }
  meetTrainerTheme(cls) {
    if (!cls || cls.includes("RIVAL"))
      return null;
    if (EVIL_TRAINERS.has(cls))
      return "Music_MeetEvilTrainer";
    if (FEMALE_TRAINERS.has(cls))
      return "Music_MeetFemaleTrainer";
    return "Music_MeetMaleTrainer";
  }
  engageTrainer(npc, onDone) {
    const header = this.trainerHeader(npc);
    npc.facePlayer(this.player);
    if (!this.engaging) {
      const theme = this.meetTrainerTheme(npc.def.trainerClass);
      if (theme)
        this.shell.playOnce(theme);
    }
    const launch = () => this.startTrainerBattle(npc.def.trainerClass ?? "", npc.def.trainerParty ?? 1, undefined, (won) => {
      if (won)
        this.markTrainerDefeated(npc, header?.event);
      onDone?.();
    });
    const taunt = this.beforeBattleText(npc, header?.battle);
    if (taunt)
      this.showText(taunt, launch);
    else
      launch();
  }
  beforeBattleText(npc, key) {
    const texts = this.shell.data.text;
    const keyed = key ? texts?.[key] : undefined;
    return keyed ?? this.resolveText(npc.def.text);
  }
  checkTrainerSight() {
    if (this.player.moving || this.engaging)
      return;
    const p = this.player;
    const DIRVEC = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0]
    };
    for (const npc of this.npcs) {
      const def = npc.def;
      if (!def.trainerClass || npc.moving || npc.frozen)
        continue;
      if (this.trainerDefeated(npc))
        continue;
      if (talkScript(this.map.id, def.text))
        continue;
      const dx = npc.cellX - p.cellX;
      const dy = npc.cellY - p.cellY;
      if (dx < -4 || dx > 5 || dy < -4 || dy > 4)
        continue;
      const range = this.trainerHeader(npc)?.range ?? 0;
      const vec = DIRVEC[npc.facing];
      if (range <= 0 || !vec)
        continue;
      let dist = null;
      if (vec[0] !== 0 && npc.cellY === p.cellY)
        dist = (p.cellX - npc.cellX) * vec[0];
      else if (vec[1] !== 0 && npc.cellX === p.cellX)
        dist = (p.cellY - npc.cellY) * vec[1];
      if (dist !== null && dist >= 1 && dist <= range) {
        this.startTrainerApproach(npc, dist);
        return;
      }
    }
  }
  startTrainerApproach(npc, dist) {
    this.engaging = true;
    npc.frozen = true;
    const def = npc.def;
    const header = this.trainerHeader(npc);
    const fight = () => {
      const launch = () => this.startTrainerBattle(def.trainerClass ?? "", def.trainerParty ?? 1, undefined, (won) => {
        if (won)
          this.markTrainerDefeated(npc, header?.event);
        npc.frozen = false;
        this.engaging = false;
      });
      const taunt = this.beforeBattleText(npc, header?.battle);
      if (taunt)
        this.showText(taunt, launch);
      else
        launch();
    };
    const theme = this.meetTrainerTheme(def.trainerClass);
    if (theme)
      this.shell.playOnce(theme);
    this.setEmote(npc, 1, 60, () => {
      const steps = dist - 1;
      if (steps > 0)
        this.scriptMove(npc, npc.facing, steps, fight);
      else
        fight();
    });
  }
  startTrainerBattle(id, idx, name, onDone, loseable = false) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startTrainerBattle)
      shell.startTrainerBattle(id, idx, name, onDone, loseable);
    else
      onDone?.(false);
  }
  refreshGameCornerPoster() {
    this.applyGameCornerPoster(String(this.map?.id ?? ""), this.map?.def);
  }
  applyToggleBlocks(mapId, def) {
    const on = this.save?.flags?.EVENT_MANSION_SWITCH_ON === true;
    for (const b of MANSION_BLOCKS[mapId] ?? []) {
      this.setToggleBlock(def, b, b.solidWhenOn === on);
    }
    if (mapId === "CINNABAR_GYM") {
      GYM_MACHINES.forEach((m, i) => {
        this.setToggleBlock(def, m.gate, !this.gymGateOpen(i));
      });
    }
  }
  applyLeagueSeals(mapId, def) {
    const seal = LEAGUE_SEALS[mapId];
    if (!seal)
      return;
    const set = this.save?.flags?.[seal.flag] === true;
    const solid = seal.whileSet ? set : !set;
    for (const b of seal.blocks) {
      this.setToggleBlock(def, { ...b, solidWhenOn: false }, solid);
    }
  }
  syncLeagueSeal() {
    const id = this.map?.id ?? "";
    if (!LEAGUE_SEALS[id])
      return;
    this.applyLeagueSeals(id, this.map.def);
  }
  spinnerStep() {
    const list2 = this.shell.data.field?.spinners?.[this.map.id];
    if (!list2)
      return false;
    const p = this.player;
    const sp = list2.find((s) => s.x === p.cellX && s.y === p.cellY);
    if (!sp)
      return false;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    this.shell.audio?.playSfx?.("Arrow_Tiles");
    const run = (i) => {
      const mv = sp.moves[i];
      if (!mv) {
        p.spinning = false;
        this.onStepComplete();
        return;
      }
      p.spinning = true;
      this.scriptMove(p, mv.dir, mv.count, () => run(i + 1));
    };
    run(0);
    return true;
  }
  leagueDontRun() {
    const seal = LEAGUE_SEALS[this.map?.id ?? ""];
    const dr = seal?.dontRun;
    if (!dr || this.runner.isRunning())
      return false;
    const p = this.player;
    if (p.cellY < dr.fromY || p.cellX < dr.x[0] || p.cellX > dr.x[1])
      return false;
    const t = this.shell.data.text ?? {};
    this.shell.showText(t[dr.text] ?? "Don't run away!", () => {
      this.scriptMove(p, "up", 1);
    });
    return true;
  }
  badgeGateStep() {
    if (this.runner.isRunning() || this.scriptMoves.length > 0)
      return false;
    const field = this.shell.data.field;
    const p = this.player;
    const guard = guardAt(field, this.save, this.map?.id ?? "", p.cellX, p.cellY);
    if (!guard)
      return false;
    const gate = gateFor(field, this.map.id);
    const t = this.shell.data.text ?? {};
    const say = (key, fallback) => fillBadgeName(t[key ?? ""] ?? fallback, guard.badge);
    if (guard.sprite !== undefined)
      this.faceObject?.(guard.sprite, "down");
    if (!hasBadge(this.save, guard)) {
      this.shell.showText(say(gate?.failText, "You can pass here only if you have the {RAM:wNameBuffer}!"), () => {
        this.scriptMove(p, "down", 1);
      });
      return true;
    }
    this.save.flags[guard.event] = true;
    this.shell.showText(say(gate?.passText, "Oh! That is the {RAM:wNameBuffer}!"), () => {
      this.shell.showText(t._Route23GoRightAheadText ?? "OK then! Please, go right ahead!");
    });
    return true;
  }
  lanceLockDoor() {
    if (this.map?.id !== "LANCES_ROOM")
      return false;
    const p = this.player;
    if (!LANCE_DOOR_CELLS.some(([x, y]) => x === p.cellX && y === p.cellY))
      return false;
    if (this.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR)
      return false;
    this.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR = true;
    this.shell.playOnce?.("Go_Inside");
    this.applyLeagueSeals(this.map.id, this.map.def);
    return false;
  }
  applyRoadBarriers(mapId, def) {
    const list2 = barriersFor(mapId);
    if (list2.length === 0)
      return;
    for (const b of list2) {
      const open = this.save?.flags?.[b.flag] === true;
      const i = b.by * def.width + b.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = open ? b.open : b.closed;
      }
      for (let dy = 0;dy < 2; dy++) {
        for (let dx = 0;dx < 2; dx++) {
          const cx = b.bx * 2 + dx;
          const cy = b.by * 2 + dy;
          this.stamp(def.index, cx, cy, !this.map.isWalkableCell(cx, cy));
        }
      }
    }
  }
  fieldPoisonStep() {
    const save = this.save;
    save.poisonSteps = ((save.poisonSteps ?? 0) + 1) % POISON_STEP_INTERVAL;
    if (save.poisonSteps !== 0)
      return false;
    const party = save.party ?? [];
    const fainted = [];
    let any = false;
    for (const mon of party) {
      if (mon.status !== "PSN" || mon.hp <= 0)
        continue;
      any = true;
      mon.hp -= 1;
      if (mon.hp <= 0) {
        mon.hp = 0;
        mon.status = null;
        const species = this.shell.data.pokemon?.[mon.species];
        fainted.push(mon.nickname ?? species?.name ?? mon.species);
      }
    }
    if (!any)
      return false;
    this.shell.audio?.playSfx?.("Poisoned");
    const alive = party.some((m) => m.hp > 0);
    if (fainted.length === 0 && alive)
      return false;
    const rows = fainted.map((n) => ["show_text", `${n}
fainted!`]);
    if (!alive)
      rows.push(["show_text", `${save.player?.name ?? "RED"} blacked
out!`]);
    this.runScript(rows, () => {
      if (!alive)
        this.shell.blackout?.();
    });
    return true;
  }
  forcedMovement() {
    return this.shell.data.field?.forcedMovement;
  }
  slopeRolls() {
    const fm = this.forcedMovement();
    if (!fm?.slopeMaps?.includes(this.map.id))
      return false;
    if (!this.save.onBike)
      return false;
    if (this.player.moving || this.transitioning)
      return false;
    if (this.runner.isRunning() || this.scriptMoves.length > 0 || this.engaging)
      return false;
    const input = this.shell.input;
    return !(input.isDown("a") || input.isDown("b"));
  }
  rollDownhill() {
    if (this.dirHeld() || !this.slopeRolls())
      return;
    const p = this.player;
    p.facing = "down";
    p.tryMove("down", this.map, this.entities, this.tilePairs);
  }
  forcedTileStep() {
    const tiles = this.forcedMovement()?.tiles?.[this.map.id];
    if (!tiles)
      return false;
    const p = this.player;
    const t = tiles.find((t2) => t2.x === p.cellX && t2.y === p.cellY);
    if (!t)
      return false;
    const save = this.save;
    if (t.mode === "bike") {
      if (save.onBike) {
        save.forcedBike = true;
        return false;
      }
      if ((save.inventory?.BICYCLE ?? 0) > 0) {
        save.onBike = true;
        save.forcedBike = true;
        this.syncBike();
        this.syncSurfSong();
        return false;
      }
      this.showText(`You need a
BICYCLE for the
Cycling Road!`, () => {
        this.scriptMove(p, BACK[p.facing], 1);
      });
      return true;
    }
    if (!p.surfing) {
      p.surfing = true;
      this.save.surfing = true;
      save.onBike = false;
      this.syncBike();
      this.syncSurfSong();
    }
    return false;
  }
  forcedWarp = false;
  seafoamHiddenCache;
  seafoam() {
    return seafoamData(this.shell.data.field);
  }
  seafoamHidden() {
    if (!this.seafoamHiddenCache)
      this.seafoamHiddenCache = defaultHiddenBoulders(this.seafoam());
    return this.seafoamHiddenCache;
  }
  seafoamStep() {
    const sf = this.seafoam();
    if (!sf)
      return false;
    const p = this.player;
    const flags = this.save.flags;
    const up = forcedExitAt(sf, flags, this.map.id, p.cellX, p.cellY);
    if (up > 0 && p.surfing) {
      this.forcedWarp = false;
      this.shell.audio?.playSfx?.("Collision");
      p.px = p.cellX * 16;
      p.py = p.cellY * 16;
      this.scriptMove(p, "up", up);
      return true;
    }
    if (!p.surfing)
      return false;
    const c = currentAt(sf, flags, this.map.id, p.cellX, p.cellY);
    if (!c)
      return false;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    if (FORCED_WARP_FLOORS.includes(this.map.id))
      this.forcedWarp = true;
    const run = (i) => {
      const mv = c.moves[i];
      if (!mv) {
        this.onStepComplete();
        return;
      }
      this.scriptMove(p, mv.dir, mv.count, () => run(i + 1));
    };
    run(0);
    return true;
  }
  surfBlockedHere() {
    const p = this.player;
    return surfBlockedAt(this.save.flags, this.map.id, p.cellX, p.cellY);
  }
  roadHoleStep() {
    if (this.runner.isRunning())
      return false;
    const p = this.player;
    const h = ROAD_HOLES.find((r) => r.map === this.map?.id && r.x === p.cellX && r.y === p.cellY);
    if (!h)
      return false;
    this.shell.playOnce?.("Faint_Fall");
    this.startWarpTo(h.toMap, h.dx, h.dy, p.facing);
    return true;
  }
  setObjectToggle(mapId, name, visible) {
    const save = this.save;
    save.objectToggles = save.objectToggles ?? {};
    save.objectToggles[mapId] = save.objectToggles[mapId] ?? {};
    save.objectToggles[mapId][objectToggleKey(name)] = visible;
    if (mapId === this.map?.id)
      this.setObjectHidden(name, !visible);
  }
  boulderFell() {
    const mapId = this.map?.id ?? "";
    for (const { hole, destMap } of holesFor(this.seafoam(), mapId)) {
      if (this.save.flags?.[hole.boulderEvent] === true)
        continue;
      const on = this.npcs.find((n) => this.isBoulder(n) && !n.hidden && n.cellX === hole.x && n.cellY === hole.y);
      if (!on)
        continue;
      this.save.flags[hole.boulderEvent] = true;
      this.setObjectToggle(mapId, String(on.def?.name ?? ""), false);
      const shown = hole.showObject ? toggleToObjectName(destMap, hole.showObject) : null;
      if (shown)
        this.setObjectToggle(destMap, shown, true);
      this.shell.audio?.playSfx?.("Faint_Thud");
      this.shell.showText(`The boulder fell
through the hole!`);
      return true;
    }
    for (const h of ROAD_HOLES) {
      if (h.map !== mapId || this.save.flags?.[h.flag] === true)
        continue;
      const on = this.npcs.find((n) => this.isBoulder(n) && !n.hidden && n.cellX === h.x && n.cellY === h.y);
      if (!on)
        continue;
      this.save.flags[h.flag] = true;
      this.setObjectToggle(h.map, String(on.def?.name ?? h.boulder), false);
      this.setObjectToggle(h.toMap, h.toBoulder, true);
      return true;
    }
    return false;
  }
  boulderLanded() {
    if (this.boulderFell())
      return;
    const mapId = this.map?.id ?? "";
    const list2 = barriersFor(mapId);
    if (list2.length === 0)
      return;
    let opened = false;
    for (const b of list2) {
      if (this.save.flags?.[b.flag] === true)
        continue;
      const on = this.npcs.some((n) => this.isBoulder(n) && n.cellX === b.switchX && n.cellY === b.switchY);
      if (!on)
        continue;
      this.save.flags[b.flag] = true;
      opened = true;
    }
    if (!opened)
      return;
    this.shell.playOnce?.("Go_Inside");
    this.applyRoadBarriers(mapId, this.map.def);
  }
  gymGateOpen(i) {
    const f = this.save?.flags ?? {};
    const beaten = this.save?.defeatedTrainers ?? {};
    return f[gymGateFlag(i)] === true || beaten[gymGuardKey(GYM_MACHINES[i].npc)] === true;
  }
  setToggleBlock(def, b, solid) {
    const i = b.by * def.width + b.bx;
    if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
      def.blocks[i] = solid ? b.solid : OPEN_BLOCK;
    }
    for (let dy = 0;dy < 2; dy++) {
      for (let dx = 0;dx < 2; dx++) {
        const cx = b.bx * 2 + dx;
        const cy = b.by * 2 + dy;
        this.stamp(def.index, cx, cy, solid);
        if (solid)
          this.map.markShut(cx, cy);
        else
          this.map.markOpen(cx, cy);
      }
    }
  }
  tryMansionSwitch(fx, fy) {
    const cfg = MANSION_SWITCHES[this.map.id];
    if (!cfg || this.player.facing !== "up")
      return false;
    if (!cfg.cells.some(([x, y]) => x === fx && y === fy))
      return false;
    const t = this.shell.data.text ?? {};
    this.shell.showChoice(t[`${cfg.text}SwitchText`] ?? `A secret switch!
Press it?`, (yes) => {
      if (!yes) {
        this.shell.showText(t[`${cfg.text}SwitchNotPressedText`] ?? "Not quite yet!");
        return;
      }
      const f = this.save.flags;
      f.EVENT_MANSION_SWITCH_ON = !f.EVENT_MANSION_SWITCH_ON;
      this.applyToggleBlocks(this.map.id, this.map.def);
      this.shell.playOnce?.("Go_Inside");
      this.shell.showText(t[`${cfg.text}SwitchPressedText`] ?? "Who wouldn't?");
    });
    return true;
  }
  tryGymQuiz(fx, fy) {
    if (this.map.id !== "CINNABAR_GYM" || this.player.facing !== "up")
      return false;
    const i = GYM_MACHINES.findIndex((m2) => m2.x === fx && m2.y === fy);
    if (i < 0)
      return false;
    const m = GYM_MACHINES[i];
    const t = this.shell.data.text ?? {};
    this.shell.showText(t._CinnabarGymQuizIntroText ?? "POKéMON Quiz!", () => {
      this.shell.showChoice(t[`_CinnabarQuizQuestionsText${i + 1}`] ?? "Well?", (yes) => {
        if (yes === m.yes) {
          this.shell.playOnce?.("Get_Item1");
          this.shell.showText(t._CinnabarGymQuizCorrectText ?? `You're absolutely
correct!`, () => {
            if (!this.gymGateOpen(i)) {
              this.save.flags[gymGateFlag(i)] = true;
              this.shell.playOnce?.("Go_Inside");
            }
            this.applyToggleBlocks(this.map.id, this.map.def);
          });
          return;
        }
        this.shell.playOnce?.("Denied");
        this.shell.showText(t._CinnabarGymQuizIncorrectText ?? "Sorry! Bad call!", () => {
          const npc = this.findNpc(m.npc);
          if (npc && !this.trainerDefeated(npc))
            this.engageTrainer(npc, () => {});
        });
      });
    });
    return true;
  }
  tryTrashCan(fx, fy) {
    const data = this.shell.data;
    const t = this.shell.data.text ?? {};
    const trash = t._VermilionGymTrashText ?? `Nope, there's
only trash here.`;
    const plain = (this.shell.data.field?.hiddenExtras?.printTrash ?? {})[this.map.id] ?? [];
    if (plain.some((h) => h.x === fx && h.y === fy)) {
      this.shell.showText(trash);
      return true;
    }
    const can = canAt(data, this.map.id, fx, fy);
    if (can === null)
      return false;
    const r = openCan(data, this.save, can, () => this.shell.rng.int(256));
    const say = (line, sfx) => this.shell.showText(line, () => this.shell.audio.playSfx(sfx));
    if (r.kind === "trash") {
      this.shell.showText(trash);
    } else if (r.kind === "first") {
      say(t._VermilionGymTrashSuccessText1 ?? `Hey! There's a
switch under the
trash!\fThe 1st electric
lock opened!`, "Switch");
    } else if (r.kind === "second") {
      const def = this.map.def;
      const door = trashData(data)?.doorBlock ?? DOOR_BLOCK;
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
      for (let dy = 0;dy < 2; dy++) {
        for (let dx = 0;dx < 2; dx++) {
          const cx = door.bx * 2 + dx;
          const cy = door.by * 2 + dy;
          this.stamp(def.index, cx, cy, false);
          this.map.markOpen(cx, cy);
        }
      }
      say(t._VermilionGymTrashSuccessText3 ?? `The 2nd electric
lock opened!\fThe motorized door
opened!`, "Go_Inside");
    } else {
      say(t._VermilionGymTrashFailText ?? `Nope! There's
only trash here.\fHey! The electric
locks were reset!`, "Denied");
    }
    return true;
  }
  tryHiddenItem(fx, fy) {
    const data = this.shell.data;
    const t = this.shell.data.text ?? {};
    const player = String(this.save.player?.name ?? "RED");
    const line = (k, fallback, subs = {}) => {
      let s = t[k] ?? fallback;
      s = s.replace(/\{PLAYER\}/g, player).replace(/\{RAM:wNameBuffer\}/g, subs.name ?? "");
      return s.replace(/\{NUM:[^}]*\}/g, subs.num ?? "");
    };
    const r = findHidden(data, this.save, this.map.id, fx, fy, (item) => add(this.save, item, 1, data));
    if (!r || r.kind === "nocase")
      return false;
    if (r.kind === "item") {
      this.playSfx("Get_Item2");
      this.shell.showText(line("_FoundHiddenItemText", `{PLAYER} found
{RAM:wNameBuffer}!`, { name: r.name }));
    } else if (r.kind === "bagfull") {
      this.shell.showText(line("_FoundHiddenItemText", `{PLAYER} found
{RAM:wNameBuffer}!`, { name: r.name }) + "\f" + line("_HiddenItemBagFullText", `But, {PLAYER} has
no more room for
other items!`));
    } else {
      this.playSfx("Get_Item2");
      this.shell.showText(line("_FoundHiddenCoinsText", `{PLAYER} found
{NUM} coins!`, { num: String(r.coins) }));
    }
    return true;
  }
  hiddenItemNearby() {
    const p = this.player;
    return hiddenItemNear(this.shell.data, this.save, this.map.id, p.cellX, p.cellY);
  }
  cardKeyDoors(mapId) {
    const ck = this.shell.data.field?.cardKeyDoors;
    return ck?.closedDoors?.[mapId] ?? [];
  }
  doorUnlocked(door) {
    const f = this.save?.flags ?? {};
    const events = door.events ?? (door.event ? [door.event] : []);
    return events.length > 0 && events.every((e) => f[e] === true);
  }
  applyCardKeyDoors(mapId, def) {
    for (const door of this.cardKeyDoors(mapId)) {
      if (this.doorUnlocked(door)) {
        this.openDoorCells(def, door);
        continue;
      }
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
    }
  }
  refreshDoors() {
    const def = this.map?.def;
    if (!def || !Array.isArray(def.blocks))
      return;
    let opened = false;
    for (const door of this.cardKeyDoors(this.map.id)) {
      if (!this.doorUnlocked(door))
        continue;
      const i = door.by * def.width + door.bx;
      if (i < 0 || i >= def.blocks.length || def.blocks[i] === door.open)
        continue;
      this.openDoorCells(def, door);
      opened = true;
    }
    if (opened)
      this.playSfx("Go_Inside");
  }
  openDoorCells(def, door) {
    const i = door.by * def.width + door.bx;
    if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
      def.blocks[i] = door.open;
    }
    for (let dy = 0;dy < 2; dy++) {
      for (let dx = 0;dx < 2; dx++) {
        const cx = door.bx * 2 + dx;
        const cy = door.by * 2 + dy;
        this.stamp(def.index, cx, cy, false);
        this.map.markOpen(cx, cy);
      }
    }
  }
  tryCardKeyDoor(fx, fy) {
    const mapId = this.map.id;
    const door = this.cardKeyDoors(mapId).find((d) => {
      const cx = d.bx * 2;
      const cy = d.by * 2;
      return fx >= cx && fx <= cx + 1 && fy >= cy && fy <= cy + 1;
    });
    if (!door || this.doorUnlocked(door))
      return false;
    const t = this.shell.data.text ?? {};
    if ((this.save.inventory?.CARD_KEY ?? 0) <= 0) {
      this.shell.showText(t._CardKeyFailText ?? `Darn! It needs a
CARD KEY!`);
      return true;
    }
    const events = door.events ?? (door.event ? [door.event] : []);
    for (const e of events)
      this.save.flags[e] = true;
    this.openDoorCells(this.map.def, door);
    this.shell.playOnce?.("Go_Inside");
    this.shell.showText((t._CardKeySuccessText1 ?? "Bingo!") + (t._CardKeySuccessText2 ?? `
The CARD KEY
opened the door!`));
    return true;
  }
  applyGameCornerPoster(mapId, def) {
    const p = this.shell.data.field?.gameCornerPoster;
    if (!p || p.map !== mapId || !Array.isArray(def.blocks))
      return;
    const open = this.save?.flags?.[p.event] === true;
    const block = open ? p.openBlock : p.closedBlock;
    const i = p.y * def.width + p.x;
    if (i >= 0 && i < def.blocks.length)
      def.blocks[i] = block;
    if (!open)
      return;
    for (let dy = 0;dy < 2; dy++) {
      for (let dx = 0;dx < 2; dx++) {
        this.stamp(def.index, p.x * 2 + dx, p.y * 2 + dy, false);
      }
    }
  }
  startWildBattle(species, level, opts, onDone) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startWildBattle)
      shell.startWildBattle(species, level, opts, onDone);
    else
      onDone?.(null);
  }
  startOldManDemo(onDone) {
    const self = this;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startOldManDemo)
      shell.startOldManDemo(onDone);
    else
      onDone?.();
  }
  movePlayerTo(tx, ty, onDone) {
    const p = this.player;
    const path = this.findPath(p.cellX ?? 0, p.cellY ?? 0, tx, ty, p);
    let i = 0;
    const step = () => {
      if (i >= path.length) {
        onDone();
        return;
      }
      const [nx, ny] = path[i++];
      const dx = nx - (p.cellX ?? 0);
      const dy = ny - (p.cellY ?? 0);
      const dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
      this.scriptMove(p, dir, 1, step);
    };
    step();
  }
  placeNpc(sprite, x, y, facing = "down") {
    let existing = this.findNpc(sprite);
    if (!existing) {
      const def = (this.map.def.objects ?? []).find((o) => o.sprite === sprite && !this.npcs.some((n) => n.def === o));
      if (def) {
        existing = this.pooledNPC(this.map.id, def);
        this.npcs.push(existing);
        this.entities = [this.player, ...this.npcs];
      }
    }
    if (existing) {
      existing.hidden = false;
      existing.cellX = x;
      existing.cellY = y;
      existing.px = x * 16;
      existing.py = y * 16;
      existing.facing = facing;
      return existing;
    }
    const obj = { sprite, x, y, cellX: x, cellY: y, facing, movement: "static" };
    const self = this;
    const npc = self.pooledNPC(self.mapId ?? self.map?.id ?? "", obj);
    npc.def = npc.def ?? obj;
    npc.cellX = x;
    npc.cellY = y;
    npc.px = x * 16;
    npc.py = y * 16;
    npc.facing = facing;
    npc.frozen = false;
    npc.wanders = false;
    this.npcs.push(npc);
    this.entities = [this.player, ...this.npcs];
    return npc;
  }
  setObjectHidden(objName, hidden) {
    let npc = this.findNpc(objName);
    if (!npc && !hidden) {
      const want = String(objName).toUpperCase();
      const def = (this.map.def.objects ?? []).find((o) => {
        const name = String(o.name ?? "").toUpperCase();
        const text = String(o.text ?? "").toUpperCase();
        const matches = name === want || text === want || text === "TEXT_" + want || text.replace(/^TEXT_/, "") === want;
        return matches && !this.npcs.some((n) => n.def === o);
      });
      if (def) {
        npc = this.pooledNPC(this.map.id, def);
        this.npcs.push(npc);
        this.entities = [this.player, ...this.npcs];
      }
    }
    if (npc)
      npc.hidden = hidden;
  }
  faceObject(ref, dir) {
    const npc = this.findNpc(ref);
    if (npc)
      npc.facing = dir;
  }
  findPath(sx, sy, tx, ty, mover) {
    const W = 64, H = 64;
    const key = (x, y) => y * W + x;
    const prev = new Map;
    const seen = new Set([key(sx, sy)]);
    let q = [[sx, sy]];
    const ok = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H)
        return false;
      try {
        return this.map.isWalkableCell(x, y) && !occupied(this.entities, x, y, mover);
      } catch {
        return false;
      }
    };
    while (q.length) {
      const nq = [];
      for (const [x, y] of q) {
        if (x === tx && y === ty) {
          const out = [];
          let k = key(x, y);
          while (k !== key(sx, sy)) {
            out.push([k % W, Math.floor(k / W)]);
            const p2 = prev.get(k);
            if (p2 === undefined)
              break;
            k = p2;
          }
          return out.reverse();
        }
        for (const [nx, ny] of [[x, y + 1], [x, y - 1], [x + 1, y], [x - 1, y]]) {
          const nk = key(nx, ny);
          if (seen.has(nk) || !(ok(nx, ny) || nx === tx && ny === ty))
            continue;
          seen.add(nk);
          prev.set(nk, key(x, y));
          nq.push([nx, ny]);
        }
      }
      q = nq;
    }
    return [];
  }
  moveNpcTo(ref, tx, ty, onDone) {
    const npc = this.findNpc(ref);
    if (!npc) {
      onDone();
      return;
    }
    const path = this.findPath(npc.cellX ?? 0, npc.cellY ?? 0, tx, ty, npc);
    let i = 0;
    const step = () => {
      if (i >= path.length) {
        onDone();
        return;
      }
      const [nx, ny] = path[i++];
      const dx = nx - (npc.cellX ?? 0);
      const dy = ny - (npc.cellY ?? 0);
      const dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
      this.scriptMove(npc, dir, 1, step);
    };
    step();
  }
  showText(text, onDone) {
    this.shell.showText(text, onDone);
  }
  showChoice(text, choice) {
    this.shell.showChoice(text, choice);
  }
  setEmote(entity, kind, frames, onDone) {
    this.emote = { entity, kind, frames, onDone };
  }
}

// voxelmon/game/scene.ts
var STAND = { down: 0, up: 1, left: 2, right: 2 };
var WALK = { down: 3, up: 4, left: 5, right: 5 };
function poseDir(facing, camTurns) {
  return rotateDir(facing, -camTurns);
}

class Scene {
  host;
  started = false;
  lastCamX = Number.NaN;
  lastCamY = Number.NaN;
  lastPalette = null;
  lastMap = null;
  mapSlots = [null, null, null, null, null];
  entVals = new Int32Array(ENTS_MAX * 6);
  entShown = new Uint8Array(ENTS_MAX);
  entSeen = new Uint8Array(ENTS_MAX);
  sheetCache = new Map;
  lastEmote = null;
  uiOwner = null;
  namingSig = null;
  picSig = "";
  titleSig = null;
  introSig = null;
  menuSig = null;
  bagSig = null;
  shopSig = null;
  boxSig = null;
  partySig = null;
  dexSig = null;
  hofSig = null;
  diplomaSig = null;
  tradeSig = null;
  creditsSig = null;
  evoSig = null;
  summarySig = null;
  uiRows = [];
  uiPage = -1;
  uiArrow = false;
  choiceDrawn = false;
  choiceYes = true;
  battleActive = false;
  arenaStaged = false;
  cardShown = new Map;
  constructor(host) {
    this.host = host;
  }
  emit(view) {
    const host = this.host;
    if (!this.started) {
      this.started = true;
      host.pitch(2);
    }
    const p = view.prof;
    const t0 = p ? p.now() : 0;
    this.emitMaps(view);
    const t1 = p ? p.now() : 0;
    const bv = view.battleView();
    if (!bv) {
      this.emitCam(view);
      this.emitEnts(view);
      this.emitEmote(view);
    }
    const t2 = p ? p.now() : 0;
    if (p) {
      p.maps += t1 - t0;
      p.ents += t2 - t1;
    }
    if (bv) {
      this.emitBattle(view, bv);
      if (p)
        p.ui += p.now() - t2;
      return;
    }
    if (this.battleActive) {
      this.endBattle();
    }
    this.emitUi(view);
    if (p)
      p.ui += p.now() - t2;
  }
  emitAnimSprites(view, bv) {
    const host = this.host;
    const sprites = bv.battle.animSprites();
    if (sprites.length === 0) {
      if (this.animEmitted) {
        host.animClear();
        this.animEmitted = false;
      }
      return;
    }
    const tilesets = view.data.battle_anims?.tilesets ?? [];
    host.animClear();
    this.animEmitted = true;
    for (const s of sprites) {
      const page = tilesets[s.ts]?.page ?? -1;
      if (page < 0)
        continue;
      host.animSprite(page, s.tile, s.x - 8, s.y - 16, (s.xf ? 1 : 0) | (s.yf ? 2 : 0));
    }
  }
  emitIntroTiles(tiles) {
    const host = this.host;
    if (tiles.length === 0) {
      if (this.animEmitted) {
        host.animClear();
        this.animEmitted = false;
      }
      return;
    }
    host.animClear();
    this.animEmitted = true;
    for (const t of tiles) {
      if (t.page < 0)
        continue;
      host.animSprite(t.page, t.tile, t.x, t.y, t.flags);
    }
  }
  animEmitted = false;
  emitBattle(view, bv) {
    const host = this.host;
    if (!this.battleActive) {
      this.battleActive = true;
      this.hideAllEnts();
      this.uiOwner = null;
      this.uiRows = [];
      this.uiPage = -1;
      this.uiArrow = false;
      this.choiceDrawn = false;
      if (bv.staging) {
        const a = bv.staging.arena;
        host.arena(bv.staging.mapIndex, a.x, a.y, a.shape, bv.staging.rig);
        host.battleCam(bv.staging.orbit ?? 0, 0, Q8);
        this.arenaStaged = true;
      }
    }
    const desired = bv.staging ? desiredCards(view.data, bv.battle, bv.staging) : [];
    const seen = new Set;
    for (const c of desired) {
      seen.add(c.side);
      const key = `${c.pic},${c.x},${c.y},${c.dx},${c.dy},${c.dz}`;
      if (this.cardShown.get(c.side) !== key) {
        host.card(c.side, c.pic, c.x, c.y, c.dx, c.dy, c.dz);
        this.cardShown.set(c.side, key);
      }
    }
    for (const side of [...this.cardShown.keys()]) {
      if (!seen.has(side)) {
        host.cardHide(side);
        this.cardShown.delete(side);
      }
    }
    this.emitAnimSprites(view, bv);
    bv.ui.emit(host, bv.battle);
  }
  endBattle() {
    const host = this.host;
    for (const side of [...this.cardShown.keys()]) {
      host.cardHide(side);
    }
    this.cardShown.clear();
    if (this.arenaStaged) {
      host.arenaEnd();
      this.arenaStaged = false;
    }
    if (this.animEmitted) {
      host.animClear();
      this.animEmitted = false;
    }
    host.uiClear();
    this.battleActive = false;
  }
  emitMaps(view) {
    const ow = view.overworld;
    if (ow.map === this.lastMap)
      return;
    this.lastMap = ow.map;
    const maps = view.data.maps;
    const desired = [
      { id: ow.map.id, index: ow.map.def.index, ox: 0, oy: 0 }
    ];
    for (const n of computeNeighbors(maps, ow.map.id, 1).slice(0, 4)) {
      if (n.hidden)
        continue;
      if (view.data.cookedMaps && !view.data.cookedMaps.includes(n.id))
        continue;
      desired.push({ id: n.id, index: maps[n.id].index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0;slot < 5; slot++) {
      const want2 = desired[slot] ?? null;
      const key = want2 ? `${want2.id}@${want2.ox},${want2.oy}` : null;
      if (key === this.mapSlots[slot])
        continue;
      if (want2) {
        this.host.mapShow(slot, want2.index, want2.ox, want2.oy);
      } else {
        this.host.mapHide(slot);
      }
      this.mapSlots[slot] = key;
    }
    const want = view.data.mapPalette?.[ow.map.id] ?? -1;
    if (want !== this.lastPalette) {
      this.host.palette(want);
      this.lastPalette = want;
    }
  }
  emitCam(view) {
    const p = view.overworld.player;
    const cx = (p.px + 16) * Q4;
    const cy = (p.py + 8) * Q4;
    if (cx !== this.lastCamX || cy !== this.lastCamY) {
      this.host.cam(cx, cy);
      this.lastCamX = cx;
      this.lastCamY = cy;
    }
  }
  sheetIndex(view, spriteId) {
    const hit = this.sheetCache.get(spriteId);
    if (hit !== undefined)
      return hit;
    const atlas = view.data.atlas;
    const name = spriteId.replace(/^SPRITE_/, "").toLowerCase();
    const page = atlas?.sprites?.[name];
    const index = typeof page === "number" ? page : -1;
    this.sheetCache.set(spriteId, index);
    return index;
  }
  emitSlot(slot, sheet, frame, x, y, lift, flags) {
    const b = slot * 6;
    const v = this.entVals;
    this.entSeen[slot] = 1;
    if (this.entShown[slot] !== 0 && v[b] === sheet && v[b + 1] === frame && v[b + 2] === x && v[b + 3] === y && v[b + 4] === lift && v[b + 5] === flags) {
      return;
    }
    this.host.ent(slot, sheet, frame, x, y, lift, flags);
    v[b] = sheet;
    v[b + 1] = frame;
    v[b + 2] = x;
    v[b + 3] = y;
    v[b + 4] = lift;
    v[b + 5] = flags;
    this.entShown[slot] = 1;
  }
  emitEnts(view) {
    const ow = view.overworld;
    this.entSeen.fill(0);
    const seenAs = (d) => poseDir(d, ow.camTurns);
    const p = ow.player;
    {
      const phase = p.walkPhase();
      const pf = seenAs(p.facing);
      const frame = phase === 1 ? WALK[pf] : STAND[pf];
      const mirror = pf === "right" || (pf === "down" || pf === "up") && phase === 1 && p.animFlip();
      let flags = ENT_FLAG.ghost | ENT_FLAG.walker;
      if (mirror)
        flags |= ENT_FLAG.mirror;
      const sheet = p.surfing ? "SPRITE_SEEL" : p.onBike ? "SPRITE_RED_BIKE" : "SPRITE_RED";
      const hop = p.hopLift();
      this.emitSlot(0, this.sheetIndex(view, sheet), frame, p.px * Q4, p.py * Q4, hop !== 0 ? hop : p.surfBob(), flags);
    }
    const npcs = ow.npcs;
    for (let i = 0;i < npcs.length; i++) {
      const npc = npcs[i];
      const slot = i + 1;
      if (slot >= ENTS_MAX)
        break;
      if (npc.hidden)
        continue;
      const def = view.data.sprites?.[npc.def.sprite];
      const frames = def?.frames ?? 6;
      const walker = def?.walker ?? frames > 1;
      const phase = npc.walkPhase();
      const nf = seenAs(npc.facing);
      const frame = frames <= 1 ? 0 : phase === 1 && walker ? WALK[nf] : STAND[nf];
      const mirror = frames > 1 && (nf === "right" || (nf === "down" || nf === "up") && phase === 1 && npc.stepFlip);
      let flags = walker ? ENT_FLAG.walker : 0;
      if (mirror)
        flags |= ENT_FLAG.mirror;
      this.emitSlot(slot, this.sheetIndex(view, npc.def.sprite), frame, npc.px * Q4, npc.py * Q4, 0, flags);
    }
    for (let slot = 0;slot < ENTS_MAX; slot++) {
      if (this.entSeen[slot] === 0 && this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
  }
  hideAllEnts() {
    for (let slot = 0;slot < ENTS_MAX; slot++) {
      if (this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
    this.entSeen.fill(0);
  }
  emitEmote(view) {
    const ow = view.overworld;
    const e = ow.emote;
    if (e) {
      const slot = e.entity === ow.player ? 0 : ow.npcs.indexOf(e.entity) + 1;
      if (!this.lastEmote || this.lastEmote.slot !== slot || this.lastEmote.kind !== e.kind) {
        this.host.emote(slot, e.kind);
        this.lastEmote = { slot, kind: e.kind };
      }
    } else if (this.lastEmote) {
      this.host.emote(this.lastEmote.slot, 0);
      this.lastEmote = null;
    }
  }
  stamp(host, x, y, s) {
    const codes = encodeGlyphs(s);
    for (let i = 0;i < codes.length; i++)
      host.uiTile(x + i, y, codes[i]);
  }
  frame(host, x, y, w, h) {
    host.uiTile(x, y, BORDER_TL);
    host.uiFill(x + 1, y, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y, BORDER_TR);
    host.uiFill(x, y + 1, 1, h - 2, BORDER_V);
    host.uiFill(x + w - 1, y + 1, 1, h - 2, BORDER_V);
    host.uiFill(x + 1, y + 1, w - 2, h - 2, SPACE);
    host.uiTile(x, y + h - 1, BORDER_BL);
    host.uiFill(x + 1, y + h - 1, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y + h - 1, BORDER_BR);
  }
  level(host, x, y, level) {
    if (level < 100)
      this.stamp(host, x, y, `<LV>${level}`);
    else
      this.stamp(host, x, y, String(level));
  }
  drawPartyMenu(host, pv) {
    host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
    if (pv.entries.length === 0)
      this.stamp(host, 2, 8, "No POKéMON!");
    pv.entries.forEach((e, i) => {
      const y = i * 2;
      host.uiFill(1, y, 2, 2, 0);
      this.stamp(host, 3, y, e.name);
      this.level(host, 13, y, e.level);
      if (e.hp <= 0)
        this.stamp(host, 17, y, "FNT");
      else if (e.status)
        this.stamp(host, 17, y, e.status);
      const bar = hpBarTiles(e.hp, e.maxHp, false).slice(0, -1);
      bar.forEach((code, k) => host.uiTile(5 + k, y + 1, code));
      const hp = `${String(e.hp).padStart(3, " ")}/${String(e.maxHp).padStart(3, " ")}`;
      this.stamp(host, 13, y + 1, hp);
      if (i === pv.index)
        host.uiTile(0, y + 1, ARROW_CURSOR);
      else if (pv.swapFrom === i)
        host.uiTile(0, y + 1, ARROW_CURSOR);
    });
    this.frame(host, 0, 12, UI_COLS, 6);
    String(pv.prompt ?? "").split(`
`).forEach((line, k) => {
      this.stamp(host, 1, 14 + k * 2, line);
    });
    if (pv.mode === "submenu") {
      const items = pv.submenuItems;
      const n = items.length;
      const sy = 17 - n * 2 - 1;
      this.frame(host, 9, sy, 11, n * 2 + 2);
      items.forEach((label3, k) => {
        this.stamp(host, 11, 17 - n * 2 + k * 2, label3);
        if (k === pv.submenuIndex)
          host.uiTile(10, 17 - n * 2 + k * 2, ARROW_CURSOR);
      });
    }
  }
  drawStatusScreen(host, sv) {
    host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
    const c = SUMMARY_PIC_CELL;
    host.uiFill(c.x, c.y, c.w, c.h, 0);
    this.stamp(host, 9, 1, sv.name);
    this.stamp(host, 1, 7, `No.${String(sv.dex).padStart(3, "0")}`);
    host.uiFill(19, 1, 1, 10, BORDER_V);
    const n3 = (v) => String(v).padStart(3, " ");
    if (sv.page === 1) {
      this.level(host, 14, 2, sv.level);
      hpBarTiles(sv.hp, sv.maxHp, false).forEach((code, k) => host.uiTile(11 + k, 3, code));
      this.stamp(host, 12, 4, `${n3(sv.hp)}/${n3(sv.maxHp)}`);
      this.stamp(host, 9, 6, "STATUS/");
      this.stamp(host, 16, 6, sv.status ?? "OK");
      this.frame(host, 0, 8, 10, 10);
      const stats = [
        ["ATTACK", sv.stats.atk],
        ["DEFENSE", sv.stats.def],
        ["SPEED", sv.stats.spd],
        ["SPECIAL", sv.stats.spc]
      ];
      stats.forEach(([label3, v], k) => {
        this.stamp(host, 1, 9 + k * 2, label3);
        this.stamp(host, 6, 10 + k * 2, n3(v));
      });
      this.stamp(host, 10, 9, "TYPE1/");
      this.stamp(host, 11, 10, String(sv.types[0] ?? ""));
      if (sv.types[1]) {
        this.stamp(host, 10, 11, "TYPE2/");
        this.stamp(host, 11, 12, String(sv.types[1]));
      }
      this.stamp(host, 10, 13, "IDNo/");
      this.stamp(host, 12, 14, String(sv.otId).padStart(5, "0"));
      this.stamp(host, 10, 15, "OT/");
      this.stamp(host, 12, 16, String(sv.otName));
    } else {
      this.stamp(host, 9, 3, "EXP POINTS");
      this.stamp(host, 12, 4, String(sv.exp).padStart(7, " "));
      this.stamp(host, 9, 5, "LEVEL UP");
      this.stamp(host, 7, 6, String(sv.expToNext).padStart(7, " "));
      this.stamp(host, 14, 6, "to");
      this.level(host, 16, 6, sv.nextLevel);
      this.frame(host, 0, 8, UI_COLS, 10);
      for (let k = 0;k < 4; k++) {
        const mv = sv.moves[k];
        const y = 9 + k * 2;
        if (mv) {
          this.stamp(host, 2, y, mv.name);
          this.stamp(host, 11, y + 1, "PP");
          this.stamp(host, 14, y + 1, `${String(mv.pp).padStart(2, " ")}/${String(mv.maxPp).padStart(2, " ")}`);
        } else {
          this.stamp(host, 2, y, "-");
          this.stamp(host, 14, y + 1, "--");
        }
      }
    }
  }
  emitUi(view) {
    const host = this.host;
    const rawPic = view.pic?.();
    const picList = Array.isArray(rawPic) ? rawPic : rawPic ? [rawPic] : [];
    const psig = picList.map((q, i) => `${i}:${q.page},${q.x},${q.y},${q.w},${q.h},${q.d ?? 0}`).join("|");
    if (psig !== this.picSig) {
      this.picSig = psig;
      for (let i = 0;i < PICS_MAX; i++) {
        const q = picList[i];
        if (!q) {
          host.picHide(i);
          continue;
        }
        host.pic(i, q.page, q.x, q.y, q.w, q.h);
        if (q.d)
          host.picDepth(i, q.d);
      }
    }
    const intro = view.intro?.();
    if (intro) {
      this.emitIntroTiles(intro.tiles);
      if (this.introSig === null) {
        this.introSig = "open";
        this.uiOwner = null;
        host.uiClear();
      }
      return;
    }
    if (this.introSig !== null) {
      this.introSig = null;
      this.emitIntroTiles([]);
      host.uiClear();
      this.uiOwner = null;
    }
    const bx = view.box?.();
    if (bx) {
      const sig = [
        bx.mode,
        bx.currentBox,
        bx.menuIndex,
        bx.listIndex,
        bx.listTop,
        bx.submenuIndex,
        bx.confirmYes,
        bx.footer ?? "",
        bx.list.map((e) => `${e.label}${e.right}`).join(",")
      ].join("|");
      if (sig !== this.boxSig) {
        this.boxSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box2 = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        const footerBox = () => {
          if (!bx.footer)
            return;
          box2(0, 12, 19, 4);
          String(bx.footer).split(`
`).forEach((ln, i) => {
            this.stamp(host, 1, 13 + i, ln);
          });
        };
        box2(12, 0, 7, 1);
        this.stamp(host, 14, 1, `BOX No.${bx.currentBox}`);
        if (bx.mode === "menu") {
          const items = ["WITHDRAW", "DEPOSIT", "RELEASE", "CHANGE BOX", "SEE YA!"];
          box2(0, 3, 13, items.length * 2);
          items.forEach((label3, i) => {
            this.stamp(host, 2, 5 + i * 2, label3);
            if (i === bx.menuIndex)
              host.uiTile(1, 5 + i * 2, ARROW_CURSOR);
          });
        } else if (bx.mode === "list") {
          const total = bx.list.length + 1;
          const X = 0, Y = 3, W = 15, H = bx.rows * 2;
          box2(X, Y, W, H);
          for (let r = 0;r < bx.rows; r++) {
            const li = bx.listTop + r;
            if (li >= total)
              break;
            const rowY = Y + 2 + r * 2;
            if (li < bx.list.length) {
              const e = bx.list[li];
              this.stamp(host, X + 2, rowY, e.label);
              if (e.right)
                this.stamp(host, X + W - e.right.length, rowY, e.right);
            } else {
              this.stamp(host, X + 2, rowY, "CANCEL");
            }
            if (li === bx.listIndex)
              host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (bx.listTop + bx.rows < total)
            host.uiTile(X + W - 1, Y + H, ARROW_MORE);
        } else if (bx.mode === "submenu") {
          const items = [bx.submenuLabel, "STATS", "CANCEL"];
          box2(9, 9, 9, 6);
          items.forEach((label3, i) => {
            this.stamp(host, 12, 11 + i * 2, label3);
            if (i === bx.submenuIndex)
              host.uiTile(11, 11 + i * 2, ARROW_CURSOR);
          });
        } else if (bx.mode === "confirm") {
          box2(14, 8, 4, 2);
          this.stamp(host, 16, 9, "YES");
          this.stamp(host, 16, 10, "NO");
          host.uiTile(15, bx.confirmYes ? 9 : 10, ARROW_CURSOR);
          footerBox();
        }
        if (bx.mode === "list" || bx.mode === "message")
          footerBox();
      }
      return;
    }
    if (this.boxSig !== null) {
      this.boxSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.shopSig = this.summarySig = this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }
    const sh = view.shop?.();
    if (sh) {
      const sig = [
        sh.mode,
        sh.money,
        sh.menuIndex,
        sh.buying,
        sh.listIndex,
        sh.listTop,
        sh.qty,
        sh.total,
        sh.confirmYes,
        sh.footer ?? "",
        sh.list.map((e) => `${e.label}${e.right}`).join(",")
      ].join("|");
      if (sig !== this.shopSig) {
        this.shopSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box2 = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        const footer = () => {
          if (!sh.footer)
            return;
          box2(0, 13, 19, 3);
          String(sh.footer).split(`
`).forEach((ln, i) => {
            this.stamp(host, 1, 14 + i, ln);
          });
        };
        box2(11, 0, 8, 1);
        const money = `¥${sh.money}`;
        this.stamp(host, 19 - money.length, 1, money);
        if (sh.mode === "menu") {
          box2(0, 3, 8, 6);
          ["BUY", "SELL", "QUIT"].forEach((label3, i) => {
            this.stamp(host, 3, 5 + i * 2, label3);
            if (i === sh.menuIndex)
              host.uiTile(2, 5 + i * 2, ARROW_CURSOR);
          });
        } else if (sh.mode === "list") {
          const total = sh.list.length + 1;
          const X = 0, Y = 3, W = 19, H = sh.rows * 2;
          box2(X, Y, W, H);
          for (let r = 0;r < sh.rows; r++) {
            const li = sh.listTop + r;
            if (li >= total)
              break;
            const rowY = Y + 2 + r * 2;
            if (li < sh.list.length) {
              const e = sh.list[li];
              this.stamp(host, X + 2, rowY, e.label);
              this.stamp(host, X + W - e.right.length, rowY, e.right);
            } else {
              this.stamp(host, X + 2, rowY, "CANCEL");
            }
            if (li === sh.listIndex)
              host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (sh.listTop + sh.rows < total)
            host.uiTile(X + W - 1, Y + H, ARROW_MORE);
          footer();
        } else if (sh.mode === "quantity") {
          box2(3, 6, 13, 2);
          this.stamp(host, 5, 7, sh.selName);
          this.stamp(host, 5, 8, `×${sh.qty}`);
          const t = `¥${sh.total}`;
          this.stamp(host, 15 - t.length, 8, t);
          footer();
        } else if (sh.mode === "confirm") {
          box2(14, 9, 4, 2);
          this.stamp(host, 16, 10, "YES");
          this.stamp(host, 16, 11, "NO");
          host.uiTile(15, sh.confirmYes ? 10 : 11, ARROW_CURSOR);
          footer();
        }
      }
      return;
    }
    if (this.shopSig !== null) {
      this.shopSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.summarySig = this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }
    const sv = view.summary?.();
    if (sv) {
      const sig = `${sv.name},${sv.hp}/${sv.maxHp},${sv.status},${sv.level},${sv.page},${sv.exp}`;
      if (sig !== this.summarySig) {
        this.summarySig = sig;
        this.uiOwner = null;
        host.uiClear();
        this.drawStatusScreen(host, sv);
      }
      return;
    }
    if (this.summarySig !== null) {
      this.summarySig = null;
      host.uiClear();
      this.uiOwner = null;
      this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }
    const pv = view.party?.();
    if (pv) {
      const total = pv.entries.length + 1;
      const sig = pv.entries.map((e) => `${e.name}${e.level}:${e.hp}/${e.maxHp}:${e.status ?? ""}`).join(";") + `#${pv.index}|${pv.mode}|${pv.submenuIndex}|${pv.swapFrom}`;
      if (sig !== this.partySig) {
        this.partySig = sig;
        this.uiOwner = null;
        host.uiClear();
        this.drawPartyMenu(host, pv);
      }
      return;
    }
    if (this.partySig !== null) {
      this.partySig = null;
      host.uiClear();
      this.uiOwner = null;
      this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }
    const bg = view.bag?.();
    if (bg) {
      const total = bg.entries.length + 1;
      const sig = `${bg.index},${bg.top},${bg.mode},${bg.submenuIndex},${bg.qty},` + bg.entries.map((e) => `${e.name}×${e.qty}`).join(";");
      if (sig !== this.bagSig) {
        this.bagSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 2, Y = 2, W = 16, H = bg.rows * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        for (let r = 0;r < bg.rows; r++) {
          const li = bg.top + r;
          if (li >= total)
            break;
          const rowY = Y + 2 + r * 2;
          if (li < bg.entries.length) {
            const e = bg.entries[li];
            this.stamp(host, X + 2, rowY, e.name);
            const qs = `×${e.qty}`;
            this.stamp(host, X + W - qs.length, rowY, qs);
          } else {
            this.stamp(host, X + 2, rowY, "CANCEL");
          }
          if (li === bg.index)
            host.uiTile(X + 1, rowY, ARROW_CURSOR);
        }
        if (bg.top + bg.rows < total)
          host.uiTile(X + W - 1, Y + H, ARROW_MORE);
        const sub = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        if (bg.mode === "submenu") {
          sub(11, 11, 7, 4);
          this.stamp(host, 13, 13, "USE");
          this.stamp(host, 13, 15, "TOSS");
          host.uiTile(12, bg.submenuIndex === 0 ? 13 : 15, ARROW_CURSOR);
        } else if (bg.mode === "quantity") {
          sub(11, 11, 7, 2);
          this.stamp(host, 14, 13, `×${String(bg.qty).padStart(2, "0")}`);
        }
      }
      return;
    }
    if (this.bagSig !== null) {
      this.bagSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.menuSig = this.titleSig = this.namingSig = null;
      this.hofSig = this.creditsSig = this.evoSig = this.diplomaSig = null;
      this.tradeSig = null;
    }
    const evo = view.evolutionScreen?.();
    if (evo) {
      const sig = `E${evo.lines.join("|")}`;
      if (sig !== this.evoSig) {
        this.evoSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        const c = EVO_PIC_CELL;
        host.uiFill(c.x, c.y, c.w, c.h, 0);
        evo.lines.forEach((ln, i) => this.stamp(host, 1, 13 + i, ln));
      }
      return;
    }
    const tsv = view.tradeScreen?.();
    if (tsv) {
      const sig = `T${tsv.side},${tsv.index},${tsv.chosenMine}`;
      if (sig !== this.tradeSig) {
        this.tradeSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        const list2 = (rows, row0, selected) => {
          rows.forEach((e, i) => {
            const y = row0 + i;
            host.uiFill(1, y, 1, 1, 0);
            this.stamp(host, 2, y, String(e.name).slice(0, 10));
            this.level(host, 13, y, e.level);
            if (e.hp <= 0)
              this.stamp(host, 17, y, "FNT");
            else if (e.status)
              this.stamp(host, 17, y, e.status);
            if (selected === i)
              host.uiTile(19, y, ARROW_CURSOR);
          });
        };
        this.stamp(host, 1, 1, String(tsv.peerName).slice(0, 10));
        list2(tsv.theirs, 2, null);
        this.stamp(host, 1, 9, String(tsv.myName).slice(0, 10));
        list2(tsv.mine, 10, tsv.chosenMine);
        const row = (tsv.side === 0 ? 10 : 2) + tsv.index;
        host.uiTile(0, row, ARROW_CURSOR);
        this.frame(host, 0, 16, UI_COLS, 2);
        this.stamp(host, 1, 17, String(tsv.prompt ?? "").split(`
`)[0] ?? "");
      }
      return;
    }
    const tav = view.tradeAnim?.();
    if (tav) {
      const sig = `A${tav.phase}`;
      if (sig !== this.tradeSig) {
        this.tradeSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        if (tav.mon) {
          const c = TRADE_PIC_CELL;
          host.uiFill(c.x, c.y, c.w, c.h, 0);
        }
        String(tav.line ?? "").split(`
`).forEach((line, k) => {
          this.stamp(host, 1, 13 + k * 2, line);
        });
      }
      return;
    }
    const dip = view.diplomaScreen?.();
    if (dip) {
      const sig = `D${dip.name}`;
      if (sig !== this.diplomaSig) {
        this.diplomaSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        const F = UI_TILE.frame;
        const x1 = UI_COLS - 1;
        const y1 = UI_ROWS - 1;
        host.uiTile(0, 0, F + 2);
        host.uiTile(x1, 0, F + 4);
        host.uiTile(0, y1, F + 6);
        host.uiTile(x1, y1, F + 7);
        host.uiFill(1, 0, UI_COLS - 2, 1, F + 3);
        host.uiFill(1, y1, UI_COLS - 2, 1, F + 0);
        host.uiFill(0, 1, 1, UI_ROWS - 2, F + 5);
        host.uiFill(x1, 1, 1, UI_ROWS - 2, F + 1);
        const centre = (s) => Math.max(1, Math.floor((UI_COLS - s.length) / 2));
        this.stamp(host, centre(dip.title), 2, dip.title);
        this.stamp(host, centre(dip.name), 5, dip.name);
        dip.lines.forEach((ln, i) => this.stamp(host, 2, 8 + i, String(ln)));
        this.stamp(host, Math.max(1, UI_COLS - 2 - dip.signature.length), 15, dip.signature);
      }
      return;
    }
    const hof = view.hallOfFameScreen?.();
    if (hof) {
      const sig = `H${hof.index},${hof.mon ? hof.mon.name + hof.mon.level : "-"}`;
      if (sig !== this.hofSig) {
        this.hofSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        this.stamp(host, Math.max(0, Math.floor((UI_COLS - hof.title.length) / 2)), 1, hof.title);
        if (hof.mon) {
          this.stamp(host, 3, 12, hof.mon.dexNo);
          this.stamp(host, 3, 14, hof.mon.name);
          this.stamp(host, 3, 16, hof.mon.level);
        }
      }
      return;
    }
    const cr = view.creditsScreen?.();
    if (cr) {
      const sig = cr.theEnd ? "CEND" : `C${cr.index}`;
      if (sig !== this.creditsSig) {
        this.creditsSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        if (cr.theEnd) {
          const end = "THE END";
          this.stamp(host, Math.max(0, Math.floor((UI_COLS - end.length) / 2)), 8, end);
        } else {
          cr.lines.forEach((ln, i) => {
            this.stamp(host, Math.max(0, ln.column), 5 + i * 2, String(ln.text));
          });
        }
      }
      return;
    }
    const dx = view.pokedexScreen?.();
    if (dx) {
      let sig;
      if (dx.mode === "list") {
        sig = `L,${dx.index},${dx.top},${dx.entries.length}`;
      } else if (dx.mode === "submenu") {
        sig = `S,${dx.index},${dx.submenuIndex}`;
      } else {
        const e = dx.entry;
        sig = `E,${e ? e.name + "," + e.owned + "," + e.lines.length : "?"}`;
      }
      if (sig !== this.dexSig) {
        this.dexSig = sig;
        this.uiOwner = null;
        host.uiClear();
        if (dx.mode === "entry" && dx.entry) {
          const e = dx.entry;
          this.stamp(host, 9, 1, e.name);
          this.stamp(host, 9, 3, e.no);
          this.stamp(host, 9, 4, e.kind);
          if (e.height)
            this.stamp(host, 9, 6, e.height);
          if (e.weight)
            this.stamp(host, 9, 7, e.weight);
          e.lines.forEach((ln, i) => {
            if (i < 7)
              this.stamp(host, 1, 10 + i, ln);
          });
        } else {
          const X = 1, Y = 1, W = 17, H = dx.rows * 2;
          host.uiTile(X, Y, BORDER_TL);
          host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
          host.uiTile(X + W, Y, BORDER_TR);
          host.uiFill(X, Y + 1, 1, H, BORDER_V);
          host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
          host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
          host.uiTile(X, Y + 1 + H, BORDER_BL);
          host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
          host.uiTile(X + W, Y + 1 + H, BORDER_BR);
          this.stamp(host, 2, 0, "POKéDEX");
          for (let r = 0;r < dx.rows; r++) {
            const li = dx.top + r;
            if (li >= dx.entries.length)
              break;
            const row = dx.entries[li];
            const rowY = Y + 2 + r * 2;
            if (row.owned)
              this.stamp(host, X + 2, rowY, "*");
            this.stamp(host, X + 3, rowY, row.label);
            if (li === dx.index)
              host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (dx.top + dx.rows < dx.entries.length) {
            host.uiTile(X + W - 1, Y + H, ARROW_MORE);
          }
          this.stamp(host, 2, Y + 2 + H, dx.footer);
          if (dx.mode === "submenu") {
            const MX = 11, MY = 8, MW = 7, MH = dx.submenu.length * 2;
            host.uiTile(MX, MY, BORDER_TL);
            host.uiFill(MX + 1, MY, MW - 1, 1, BORDER_H);
            host.uiTile(MX + MW, MY, BORDER_TR);
            host.uiFill(MX, MY + 1, 1, MH, BORDER_V);
            host.uiFill(MX + MW, MY + 1, 1, MH, BORDER_V);
            host.uiFill(MX + 1, MY + 1, MW - 1, MH, SPACE);
            host.uiTile(MX, MY + 1 + MH, BORDER_BL);
            host.uiFill(MX + 1, MY + 1 + MH, MW - 1, 1, BORDER_H);
            host.uiTile(MX + MW, MY + 1 + MH, BORDER_BR);
            dx.submenu.forEach((s, i) => {
              this.stamp(host, MX + 2, MY + 2 + i * 2, s);
              if (i === dx.submenuIndex)
                host.uiTile(MX + 1, MY + 2 + i * 2, ARROW_CURSOR);
            });
          }
        }
      }
      return;
    }
    if (this.dexSig !== null) {
      this.dexSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.menuSig = this.titleSig = this.namingSig = null;
    }
    const mf = view.moveForget?.();
    if (mf) {
      const rows = [...mf.moves, mf.cancel ?? "DON'T LEARN"];
      const sig = `f${mf.index},${rows.length},${rows[rows.length - 1]}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 6, W = 15, H = rows.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        rows.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e.slice(0, W - 2));
          if (i === mf.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const flp = view.floorPicker?.();
    if (flp) {
      const sig = `L${flp.index},${flp.top},${flp.total}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 0, W = 8, H = flp.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        flp.entries.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, String(e).slice(0, W - 2));
          if (i === flp.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const fp = view.flyPicker?.();
    if (fp) {
      const sig = `f${fp.index},${fp.top},${fp.total}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 0, W = 16, H = fp.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        fp.entries.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e.slice(0, W - 2));
          if (i === fp.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const wp = view.warpPicker?.();
    if (wp) {
      const sig = `w${wp.index},${wp.top},${wp.total}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 0, W = 19, H = wp.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        wp.entries.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e.slice(0, W - 2));
          if (i === wp.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const sl = view.slots?.();
    if (sl) {
      const sig = `s${sl.stage},${sl.grid.map((c) => c.join("")).join("|")},` + `${sl.bet},${sl.coins},${sl.payout},${sl.message ?? ""},${sl.yesno},${sl.flash}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        const REEL_X = [4, 9, 14];
        const REEL_Y = [1, 3, 5];
        const box2 = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        box2(2, 0, 15, 6);
        const order2 = sl.order ?? [];
        sl.grid.forEach((col, w) => {
          col.forEach((sym, r) => {
            const i = order2.indexOf(sym);
            if (i < 0)
              return;
            const base = UI_TILE.slotSymbol + i * UI_TILE.slotSymbolStride;
            const x = REEL_X[w];
            const y = REEL_Y[r];
            host.uiTile(x, y, base);
            host.uiTile(x + 1, y, base + 1);
            host.uiTile(x, y + 1, base + 2);
            host.uiTile(x + 1, y + 1, base + 3);
          });
        });
        this.stamp(host, 2, 8, `COINS ${sl.coins}`);
        if (sl.payout > 0)
          this.stamp(host, 12, 8, `PAYOUT ${sl.payout}`);
        box2(0, 10, 19, 6);
        if (sl.stage === "bet") {
          this.stamp(host, 2, 11, "BET HOW MANY?");
          ["x3", "x2", "x1"].forEach((label3, i) => {
            this.stamp(host, 5, 13 + i, label3);
            if (i === sl.betIndex)
              host.uiTile(4, 13 + i, ARROW_CURSOR);
          });
        } else if (sl.stage === "intro" || sl.stage === "onemore") {
          this.stamp(host, 2, 11, sl.stage === "intro" ? "A SLOT MACHINE!" : "ONE MORE GO?");
          ["YES", "NO"].forEach((label3, i) => {
            this.stamp(host, 5, 13 + i, label3);
            if (i + 1 === sl.yesno)
              host.uiTile(4, 13 + i, ARROW_CURSOR);
          });
        } else if (sl.message) {
          String(sl.message).split(`
`).forEach((line, i) => {
            this.stamp(host, 2, 12 + i, line.slice(0, 17));
          });
        } else if (sl.stage === "spin") {
          this.stamp(host, 2, 12, "PRESS A TO STOP");
        }
      }
      return;
    }
    const pcv = view.pc?.();
    if (pcv) {
      const cursor = view.pcCursor?.() ?? 0;
      const sig = `p${pcv.mode},${pcv.index},${pcv.top},${pcv.qty},${cursor},` + pcv.entries.map((e) => `${e.name}×${e.qty}`).join(";");
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box2 = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        if (pcv.mode === "root" || pcv.mode === "items") {
          const labels = pcv.labels;
          box2(0, 0, 17, labels.length * 2);
          labels.forEach((l, i) => {
            this.stamp(host, 2, 2 + i * 2, l);
            if (i === cursor)
              host.uiTile(1, 2 + i * 2, ARROW_CURSOR);
          });
        } else {
          const total = pcv.entries.length + 1;
          const X = 2, Y = 2, W = 16, H = pcv.rows * 2;
          box2(X, Y, W, H);
          for (let r = 0;r < pcv.rows; r++) {
            const li = pcv.top + r;
            if (li >= total)
              break;
            const rowY = Y + 2 + r * 2;
            if (li < pcv.entries.length) {
              const e = pcv.entries[li];
              this.stamp(host, X + 2, rowY, e.name);
              const qs = `×${e.qty}`;
              this.stamp(host, X + W - qs.length, rowY, qs);
            } else {
              this.stamp(host, X + 2, rowY, "CANCEL");
            }
            if (li === pcv.index)
              host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (pcv.top + pcv.rows < total)
            host.uiTile(X + W - 1, Y + H, ARROW_MORE);
          if (pcv.mode === "quantity") {
            box2(11, 11, 7, 2);
            this.stamp(host, 14, 13, `×${String(pcv.qty).padStart(2, "0")}`);
          }
        }
      }
      return;
    }
    const bs = view.bikeShop?.();
    if (bs) {
      const sig = `k${bs.index},${bs.rows.join(",")},${bs.footer ?? ""}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box2 = (x, y, w, h) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        box2(0, 0, 15, 4);
        this.stamp(host, 2, 2, bs.rows[0] ?? "BICYCLE");
        this.stamp(host, 8, 3, bs.price);
        this.stamp(host, 2, 4, bs.rows[1] ?? "CANCEL");
        host.uiTile(1, bs.index === 0 ? 2 : 4, ARROW_CURSOR);
        if (bs.footer) {
          box2(0, 12, 19, 4);
          String(bs.footer).split(`
`).forEach((ln, i) => {
            this.stamp(host, 1, 14 + i, ln);
          });
        }
      }
      return;
    }
    const pz = view.prizes?.();
    if (pz) {
      const sig = `z${pz.index},${pz.coins},${pz.rows.map((r) => r.label).join(",")}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const rows = [...pz.rows.map((r) => r.label), "NO THANKS"];
        const X = 0, Y = 0, W = 19, H = rows.length * 2 + 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        rows.forEach((label3, i) => {
          const y = Y + 2 + i * 2;
          this.stamp(host, X + 2, y, label3.slice(0, 12));
          const r = pz.rows[i];
          if (r) {
            const cost = String(r.cost);
            this.stamp(host, X + W - cost.length, y, cost);
          }
          if (i === pz.index)
            host.uiTile(X + 1, y, ARROW_CURSOR);
        });
        this.stamp(host, X + 2, Y + H, `COINS ${pz.coins}`);
      }
      return;
    }
    const op = view.optionsMenu?.();
    if (op) {
      const first = op.first ?? 0;
      const visible = op.visible ?? op.rows.length + 1;
      const sig = `o${op.index},${first},${op.rows.map((r) => r.index).join(",")}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, 20, 18, SPACE);
        for (let k = 0;k < visible; k++) {
          const i = first + k;
          const labelY = 1 + k * 4;
          if (i === op.rows.length) {
            this.stamp(host, 2, labelY, "CANCEL");
            if (op.index === i)
              host.uiTile(1, labelY, ARROW_CURSOR);
            break;
          }
          const r = op.rows[i];
          if (!r)
            break;
          this.stamp(host, 1, labelY, r.label);
          let x = 1;
          r.choices.forEach((c, j) => {
            this.stamp(host, x + 1, labelY + 2, c);
            if (j === r.index)
              host.uiTile(x, labelY + 2, ARROW_CURSOR);
            x += c.length + 2;
          });
          if (i === op.index)
            host.uiTile(0, labelY, ARROW_HOLLOW);
        }
        if (first + visible < op.rows.length + 1)
          host.uiTile(18, 17, ARROW_CURSOR);
      }
      return;
    }
    const tc = view.trainerCard?.();
    if (tc) {
      const owned = tc.badges.map((b) => b.owned ? "1" : "0").join("");
      const sig = `c${tc.name},${tc.money},${tc.time},${owned},${tc.picPage}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiFill(0, 0, UI_COLS, UI_ROWS, SPACE);
        const F = UI_TILE.frame;
        const frameBox = (tx, ty, tw, th) => {
          const x1 = tx + tw - 1;
          const y1 = ty + th - 1;
          host.uiTile(tx, ty, F + 2);
          host.uiTile(x1, ty, F + 4);
          host.uiTile(tx, y1, F + 6);
          host.uiTile(x1, y1, F + 7);
          host.uiFill(tx + 1, ty, tw - 2, 1, F + 3);
          host.uiFill(tx + 1, y1, tw - 2, 1, F + 0);
          host.uiFill(tx, ty + 1, 1, th - 2, F + 5);
          host.uiFill(x1, ty + 1, 1, th - 2, F + 1);
        };
        frameBox(0, 0, UI_COLS, 9);
        if (tc.picPage >= 0) {
          const c = CARD_PIC_CELL;
          host.uiFill(c.x, c.y, c.w, c.h, 0);
        }
        this.stamp(host, 2, 2, `NAME/${tc.name}`);
        this.stamp(host, 2, 4, `MONEY/¥${tc.money}`);
        this.stamp(host, 2, 6, `TIME/${tc.time}`);
        frameBox(0, 9, UI_COLS, 3);
        host.uiTile(6, 10, UI_TILE.circle);
        this.stamp(host, 7, 10, "BADGES");
        host.uiTile(13, 10, UI_TILE.circle);
        frameBox(0, 12, UI_COLS, 6);
        tc.badges.forEach((b, i) => {
          const cx = 2 + i % 4 * 4;
          const cy = 13 + Math.floor(i / 4) * 2;
          host.uiTile(cx, cy, UI_TILE.number + i);
          const base = UI_TILE.badge + i * UI_TILE.badgeStride + (b.owned ? UI_TILE.badgeHalf : 0);
          host.uiTile(cx + 1, cy, base);
          host.uiTile(cx + 2, cy, base + 1);
          host.uiTile(cx + 1, cy + 1, base + 2);
          host.uiTile(cx + 2, cy + 1, base + 3);
        });
      }
      return;
    }
    const dv = view.devMenu?.();
    if (dv) {
      const sig = `d${dv.index},${dv.entries.length}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const W = 12, X = 20 - W - 1, Y = 0, H = dv.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        dv.entries.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e);
          if (i === dv.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const sm = view.startMenu?.();
    if (sm) {
      const sf = sm.safari;
      const sig = `${sm.index},${sm.entries.length},${sf ? `${sf.balls}/${sf.steps}` : ""}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        if (sf) {
          const SW = 8, SH = 4;
          host.uiTile(0, 0, BORDER_TL);
          host.uiFill(1, 0, SW - 1, 1, BORDER_H);
          host.uiTile(SW, 0, BORDER_TR);
          host.uiFill(0, 1, 1, SH, BORDER_V);
          host.uiFill(SW, 1, 1, SH, BORDER_V);
          host.uiFill(1, 1, SW - 1, SH, SPACE);
          host.uiTile(0, 1 + SH, BORDER_BL);
          host.uiFill(1, 1 + SH, SW - 1, 1, BORDER_H);
          host.uiTile(SW, 1 + SH, BORDER_BR);
          this.stamp(host, 1, 1, "BALLS");
          this.stamp(host, 2, 2, String(sf.balls));
          this.stamp(host, 1, 3, "STEPS");
          this.stamp(host, 2, 4, String(sf.steps));
        }
        const W = 10, X = 20 - W - 1, Y = 0, H = sm.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        sm.entries.forEach((e, i) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e);
          if (i === sm.index)
            host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    if (this.menuSig !== null) {
      this.menuSig = null;
      host.uiClear();
      this.uiOwner = null;
    }
    const ttl = view.title?.();
    if (ttl) {
      const sig = `${ttl.phase},${ttl.index},${ttl.monPage}`;
      if (sig !== this.titleSig) {
        this.titleSig = sig;
        this.uiOwner = null;
        host.uiClear();
        if (ttl.phase === "press") {
          this.stamp(host, 5, 15, "PRESS START");
        } else {
          const MX = 0, MY = 0, MW = 12;
          const MH = ttl.menu.length * 2;
          host.uiTile(MX, MY, BORDER_TL);
          host.uiFill(MX + 1, MY, MW - 1, 1, BORDER_H);
          host.uiTile(MX + MW, MY, BORDER_TR);
          host.uiFill(MX, MY + 1, 1, MH, BORDER_V);
          host.uiFill(MX + MW, MY + 1, 1, MH, BORDER_V);
          host.uiFill(MX + 1, MY + 1, MW - 1, MH, SPACE);
          host.uiTile(MX, MY + 1 + MH, BORDER_BL);
          host.uiFill(MX + 1, MY + 1 + MH, MW - 1, 1, BORDER_H);
          host.uiTile(MX + MW, MY + 1 + MH, BORDER_BR);
          ttl.menu.forEach((m, i) => {
            this.stamp(host, MX + 3, MY + 2 + i * 2, m);
            if (i === ttl.index)
              host.uiTile(MX + 2, MY + 2 + i * 2, ARROW_CURSOR);
          });
        }
      }
      return;
    }
    if (this.titleSig !== null) {
      this.titleSig = null;
      host.uiClear();
      this.uiOwner = null;
    }
    const nam = view.naming();
    if (nam) {
      const v = nam.view();
      const sig = `${v.row},${v.col},${v.name},${v.grid[0][0]}`;
      if (sig !== this.namingSig) {
        this.namingSig = sig;
        this.uiOwner = null;
        host.uiClear();
        host.uiTile(0, 0, BORDER_TL);
        host.uiFill(1, 0, 18, 1, BORDER_H);
        host.uiTile(19, 0, BORDER_TR);
        host.uiFill(0, 1, 1, 16, BORDER_V);
        host.uiFill(19, 1, 1, 16, BORDER_V);
        host.uiTile(0, 17, BORDER_BL);
        host.uiFill(1, 17, 18, 1, BORDER_H);
        host.uiTile(19, 17, BORDER_BR);
        host.uiFill(1, 1, 18, 16, SPACE);
        this.stamp(host, 2, 1, v.title);
        this.stamp(host, 3, 3, v.name);
        host.uiFill(3 + v.name.length, 3, v.maxLen - v.name.length, 1, 118);
        for (let r = 0;r < v.grid.length; r++) {
          const row = v.grid[r];
          for (let c = 0;c < row.length; c++) {
            this.stamp(host, 2 + c * 2, 6 + r * 2, row[c]);
          }
        }
        host.uiTile(1 + v.col * 2, 6 + v.row * 2, ARROW_CURSOR);
      }
      return;
    }
    if (this.namingSig !== null) {
      this.namingSig = null;
      host.uiClear();
      this.uiOwner = null;
    }
    const owner = view.uiBox();
    const choice = view.uiChoice();
    if (!owner) {
      if (this.uiOwner) {
        host.uiClear();
        this.uiOwner = null;
        this.uiRows = [];
        this.uiPage = -1;
        this.uiArrow = false;
        this.choiceDrawn = false;
      }
      return;
    }
    const box = owner.box;
    let textsEmitted = false;
    if (owner !== this.uiOwner) {
      if (this.uiOwner)
        host.uiClear();
      this.uiOwner = owner;
      this.uiRows = [];
      this.uiPage = box.pageIndex;
      this.uiArrow = false;
      this.choiceDrawn = false;
      const panel = view.savePanel?.();
      if (panel && panel.length > 0) {
        const W = 19, H = panel.length;
        host.uiTile(0, 0, BORDER_TL);
        host.uiFill(1, 0, W - 1, 1, BORDER_H);
        host.uiTile(W, 0, BORDER_TR);
        host.uiFill(0, 1, 1, H, BORDER_V);
        host.uiFill(W, 1, 1, H, BORDER_V);
        host.uiFill(1, 1, W - 1, H, SPACE);
        host.uiTile(0, 1 + H, BORDER_BL);
        host.uiFill(1, 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(W, 1 + H, BORDER_BR);
        panel.forEach((line, i) => this.stamp(host, 2, 1 + i, line));
      }
      host.uiTile(BOX_TX, BOX_TY, BORDER_TL);
      host.uiFill(BOX_TX + 1, BOX_TY, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY, BORDER_TR);
      host.uiFill(BOX_TX, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiFill(BOX_TX + BOX_TW - 1, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiTile(BOX_TX, BOX_TY + BOX_TH - 1, BORDER_BL);
      host.uiFill(BOX_TX + 1, BOX_TY + BOX_TH - 1, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY + BOX_TH - 1, BORDER_BR);
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
    } else if (box.pageIndex !== this.uiPage) {
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
      this.uiRows = [];
      this.uiPage = box.pageIndex;
    }
    for (let i = 0;i < box.shown.length; i++) {
      const line = box.shown[i];
      const isLast = i === box.shown.length - 1;
      const y = i === 0 ? LINE1_Y : LINE2_Y;
      const cached = this.uiRows[i];
      if (cached && cached.line === line && cached.wasLast === isLast) {
        continue;
      }
      if (!isLast) {
        const codes = encodeGlyphs(line.text);
        for (let c = 0;c < codes.length; c++)
          host.uiTile(TEXT_X + c, y, codes[c]);
        if (codes.length < MAX_COLS) {
          host.uiFill(TEXT_X + codes.length, y, MAX_COLS - codes.length, 1, SPACE);
        }
        this.uiRows[i] = { line, wasLast: isLast, text: line.text, revealed: -1 };
        continue;
      }
      const text = toCells(line.text);
      if (!cached || cached.text !== text) {
        host.uiText(TEXT_X, y, text);
        this.uiRows[i] = { line, wasLast: isLast, text, revealed: -1 };
        textsEmitted = true;
      } else {
        cached.line = line;
        cached.wasLast = isLast;
      }
    }
    this.uiRows.length = box.shown.length;
    const last = box.shown[box.shown.length - 1];
    if (last) {
      const cached = this.uiRows[box.shown.length - 1];
      if (textsEmitted || cached.revealed !== last.revealed) {
        host.uiReveal(last.revealed);
        cached.revealed = last.revealed;
      }
    }
    const arrow = box.arrowVisible() && !choice;
    if (arrow !== this.uiArrow) {
      if (arrow) {
        host.uiTile(ARROW_X, ARROW_Y, ARROW_MORE);
      } else {
        const under = box.shown[1];
        const codes = under ? encodeGlyphs(under.text) : [];
        const idx = ARROW_X - TEXT_X;
        const glyph = under && codes.length > idx && under.revealed > idx ? codes[idx] : SPACE;
        host.uiTile(ARROW_X, ARROW_Y, glyph);
      }
      this.uiArrow = arrow;
    }
    if (choice) {
      if (!this.choiceDrawn) {
        this.choiceDrawn = true;
        this.choiceYes = choice.yes;
        const cx = 14;
        const cy = 7;
        host.uiTile(cx, cy, BORDER_TL);
        host.uiFill(cx + 1, cy, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy, BORDER_TR);
        host.uiFill(cx, cy + 1, 1, 3, BORDER_V);
        host.uiFill(cx + 5, cy + 1, 1, 3, BORDER_V);
        host.uiTile(cx, cy + 4, BORDER_BL);
        host.uiFill(cx + 1, cy + 4, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy + 4, BORDER_BR);
        host.uiFill(cx + 1, cy + 1, 4, 3, SPACE);
        this.stamp(host, cx + 2, cy + 1, "YES");
        this.stamp(host, cx + 2, cy + 3, "NO");
        host.uiTile(cx + 1, choice.yes ? cy + 1 : cy + 3, ARROW_CURSOR);
      } else if (choice.yes !== this.choiceYes) {
        this.choiceYes = choice.yes;
        host.uiTile(15, choice.yes ? 10 : 8, SPACE);
        host.uiTile(15, choice.yes ? 8 : 10, ARROW_CURSOR);
      }
    } else if (this.choiceDrawn) {
      host.uiFill(14, 7, 6, 5, 0);
      this.choiceDrawn = false;
    }
  }
}

// voxelmon/game/world/daycare.ts
var DAYCARE_BASE_FEE = 100;
var DAYCARE_FEE_PER_LEVEL = 100;
function daycareFee(levelsGrown) {
  return DAYCARE_BASE_FEE + levelsGrown * DAYCARE_FEE_PER_LEVEL;
}
function daycareQuote(data, state, levelCap = 100) {
  const def = data.pokemon[state.mon.species];
  let exp = (state.mon.exp ?? 0) + state.steps;
  let newLevel = levelForExp(def?.growthRate ?? "MEDIUM_FAST", exp, levelCap, data.growth_rates);
  if (newLevel >= levelCap) {
    newLevel = levelCap;
    if (def)
      exp = expForLevel(def.growthRate, levelCap, data.growth_rates);
  }
  const levelsGrown = Math.max(0, newLevel - (state.depositLevel ?? state.mon.level));
  return { exp, newLevel, levelsGrown, fee: daycareFee(levelsGrown) };
}
function applyDaycareGrowth(data, mon, startLevel, newLevel) {
  const def = data.pokemon[mon.species];
  if (!def)
    return;
  mon.level = newLevel;
  mon.stats = calc(def, mon.level, mon.dvs, mon.statExp);
  mon.hp = mon.stats.hp;
  learnMovesFromDayCare(data, mon, startLevel, newLevel);
}
function learnMovesFromDayCare(data, mon, startLevel, newLevel) {
  const learnset = data.pokemon[mon.species]?.learnset;
  if (!Array.isArray(learnset))
    return;
  for (const entry of learnset) {
    if (entry.level > newLevel)
      break;
    if (entry.level <= startLevel)
      continue;
    if (mon.moves.some((mv) => mv.id === entry.move))
      continue;
    const slot = { id: entry.move, pp: data.moves[entry.move]?.pp ?? 0 };
    if (mon.moves.length < 4)
      mon.moves.push(slot);
    else {
      mon.moves.shift();
      mon.moves.push(slot);
    }
  }
}
function fillDaycareText(text, subs) {
  return text.replace(/\{RAM:([^}]*)\}/g, (_, name) => String(subs[name] ?? "")).replace(/\{NUM:([\w_]+)[^}]*\}/g, (_, name) => String(subs[name] ?? 0));
}

// voxelmon/game/world/textbox.ts
var TEXT_SPEEDS = [
  { delay: 1, label: "FAST" },
  { delay: 3, label: "MEDIUM" },
  { delay: 5, label: "SLOW" }
];
var TEXT_SPEED_DEFAULT = 3;
function substitute(text, ctx) {
  return text.replace(/\{(\w+):?\w*\}/g, (_, token) => {
    if (token === "PLAYER")
      return ctx.player ?? "RED";
    if (token === "RIVAL")
      return ctx.rival ?? "BLUE";
    return "";
  });
}
function paginate(text, maxCols = MAX_COLS) {
  const pages = [];
  const pushLine = (page, line, wait2) => {
    while (glyphLen(line) > maxCols) {
      let head = sliceGlyphs(line, maxCols);
      const sp = head.lastIndexOf(" ");
      if (sp > 0)
        head = line.slice(0, sp + 1);
      page.lines.push(head);
      page.contBefore.push(wait2);
      wait2 = false;
      line = line.slice(head.length);
    }
    page.lines.push(line);
    page.contBefore.push(wait2);
  };
  for (const pageText of `${text}\f`.split("\f").slice(0, -1)) {
    if (pageText === "")
      continue;
    const page = { lines: [], contBefore: [] };
    let pos = 0;
    let waitNext = false;
    for (;; ) {
      const npos = pageText.slice(pos).search(/[\n\v]/);
      if (npos < 0) {
        pushLine(page, pageText.slice(pos), waitNext);
        break;
      }
      pushLine(page, pageText.slice(pos, pos + npos), waitNext);
      waitNext = pageText[pos + npos] === "\v";
      pos += npos + 1;
    }
    if (page.lines[page.lines.length - 1] === "") {
      page.lines.pop();
      page.contBefore.pop();
    }
    if (page.lines.length > 0)
      pages.push(page);
  }
  if (pages.length === 0)
    pages.push({ lines: [""], contBefore: [false] });
  return pages;
}

class Textbox {
  pages;
  pageIndex = 0;
  lineIndex = 0;
  charIndex = 0;
  shown = [];
  waiting = false;
  preWait = 0;
  contAdvance = false;
  holdFrames = 0;
  done = false;
  closed = false;
  blink = 0;
  charTimer = 0;
  lineGlyphs = 0;
  speed;
  auto;
  autoLeft = 0;
  constructor(text, ctx = {}, opts = {}) {
    this.pages = paginate(substitute(text, ctx));
    this.speed = opts.speed ?? TEXT_SPEED_DEFAULT;
    this.auto = opts.auto;
    this.beginLine();
  }
  currentLine() {
    return this.pages[this.pageIndex].lines[this.lineIndex];
  }
  beginLine() {
    this.charIndex = 0;
    this.lineGlyphs = glyphLen(this.currentLine());
    if (this.shown.length >= 2) {
      this.shown.shift();
    }
    this.shown.push({ text: this.currentLine(), revealed: 0 });
  }
  update(input) {
    this.blink = (this.blink + 1) % 60;
    if (this.holdFrames > 0) {
      this.holdFrames -= 1;
      return;
    }
    if (this.done) {
      if (this.auto) {
        if (this.autoLeft > 0)
          this.autoLeft -= 1;
        else
          this.closed = true;
        return;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.closed = true;
      }
      return;
    }
    if (this.waiting) {
      if (this.preWait > 0) {
        this.preWait -= 1;
        return;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.waiting = false;
        if (this.contAdvance) {
          this.contAdvance = false;
          this.lineIndex += 1;
          this.beginLine();
          this.holdFrames = TEXT_SCROLL_PAIR;
        } else {
          this.shown = [];
          this.pageIndex += 1;
          this.lineIndex = 0;
          this.beginLine();
          this.holdFrames = TEXT_PAGE_CLEAR;
        }
      }
      return;
    }
    let delay = this.speed;
    if (input.isDown("a") || input.isDown("b"))
      delay = 1;
    this.charTimer += 1;
    while (this.charTimer >= delay) {
      this.charTimer -= delay;
      if (this.charIndex < this.lineGlyphs) {
        this.charIndex += 1;
        this.shown[this.shown.length - 1].revealed = this.charIndex;
      } else {
        const page = this.pages[this.pageIndex];
        if (this.lineIndex < page.lines.length - 1) {
          const nextIdx = this.lineIndex + 1;
          if (page.contBefore[nextIdx]) {
            this.waiting = true;
            this.preWait = TEXT_PRE_ADVANCE;
            this.contAdvance = true;
          } else {
            this.lineIndex = nextIdx;
            this.beginLine();
          }
        } else if (this.pageIndex < this.pages.length - 1) {
          this.waiting = true;
          this.preWait = TEXT_PRE_ADVANCE;
          this.contAdvance = false;
        } else {
          this.done = true;
          this.autoLeft = this.auto?.delay ?? 0;
        }
        break;
      }
    }
  }
  arrowVisible() {
    if (this.done && this.auto)
      return false;
    return (this.waiting || this.done) && this.blink < 30;
  }
  get isAuto() {
    return this.auto !== undefined;
  }
}

// voxelmon/game/ui/naming.ts
var GRID_UPPER = [
  ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  ["J", "K", "L", "M", "N", "O", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X", "Y", "Z", " "],
  ["*", "(", ")", ":", ";", "[", "]", "PK", "MN"],
  ["-", "?", "!", "M", "F", "/", ".", ",", "ED"],
  ["lower case"]
];
var GRID_LOWER = [
  ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
  ["j", "k", "l", "m", "n", "o", "p", "q", "r"],
  ["s", "t", "u", "v", "w", "x", "y", "z", " "],
  ["*", "(", ")", ":", ";", "[", "]", "PK", "MN"],
  ["-", "?", "!", "M", "F", "/", ".", ",", "ED"],
  ["UPPER CASE"]
];

class NamingState {
  game;
  kind = "naming";
  glyphs = [];
  row = 0;
  col = 0;
  lower = false;
  title;
  maxLen;
  onDone;
  pick;
  fallback;
  constructor(game, opts) {
    this.game = game;
    this.title = opts.title ?? "YOUR NAME?";
    this.maxLen = opts.maxLen ?? 7;
    this.onDone = opts.onDone;
    this.pick = opts.pick;
    this.fallback = opts.fallback ?? "RED";
    if (opts.default)
      this.glyphs = [...opts.default].slice(0, this.maxLen);
  }
  grid() {
    if (this.pick)
      return this.pick.map((p) => [p]);
    return this.lower ? GRID_LOWER : GRID_UPPER;
  }
  clamp() {
    const g = this.grid();
    if (this.row < 0)
      this.row = g.length - 1;
    if (this.row >= g.length)
      this.row = 0;
    const w = g[this.row].length;
    if (this.col >= w)
      this.col = w - 1;
    if (this.col < 0)
      this.col = 0;
  }
  confirm() {
    const name = this.glyphs.join("");
    this.game.pop();
    this.onDone(name.length > 0 ? name : this.fallback);
  }
  commit(cell) {
    if (this.pick) {
      this.game.pop();
      this.onDone(cell);
      return;
    }
    if (cell === "ED") {
      this.confirm();
      return;
    }
    if (cell === "lower case" || cell === "UPPER CASE") {
      this.lower = !this.lower;
      this.row = 0;
      this.col = 0;
      return;
    }
    if (this.glyphs.length < this.maxLen)
      this.glyphs.push(cell);
  }
  update() {
    const inp = this.game.input;
    const p = inp.pressed;
    if (p.up)
      this.row -= 1;
    if (p.down)
      this.row += 1;
    if (p.left)
      this.col -= 1;
    if (p.right)
      this.col += 1;
    if (p.up || p.down || p.left || p.right)
      this.clamp();
    if (p.select) {
      this.lower = !this.lower;
      this.row = 0;
      this.col = 0;
    }
    if (p.b)
      this.glyphs.pop();
    if (p.start && !this.pick)
      this.confirm();
    if (p.a) {
      const cell = this.grid()[this.row]?.[this.col];
      if (cell !== undefined)
        this.commit(cell);
    }
  }
  view() {
    return {
      title: this.title,
      grid: this.grid(),
      row: this.row,
      col: this.col,
      name: this.glyphs.join(""),
      maxLen: this.maxLen
    };
  }
}

// voxelmon/game/ui/title.ts
var CYCLE = [
  "CHARMANDER",
  "SQUIRTLE",
  "BULBASAUR",
  "PIKACHU",
  "MEWTWO",
  "NIDOKING",
  "GENGAR",
  "ONIX",
  "GYARADOS",
  "LAPRAS"
];
var TITLE_PAGES = { copyright: 421, gamefreak: 422, logo: 423, player: 424 };
function titlePage(data, key) {
  const p = namedPage(data, "picTitle", key);
  return p >= 0 ? p : TITLE_PAGES[key];
}
var CYCLE_PAGES = { CHARMANDER: 84, SQUIRTLE: 202, BULBASAUR: 79, PIKACHU: 176, MEWTWO: 155, NIDOKING: 159, GENGAR: 112, ONIX: 169, GYARADOS: 123, LAPRAS: 141 };

class TitleState {
  game;
  onChoose;
  kind = "title";
  phase = "press";
  timer = 0;
  cycleAt = 0;
  index = 0;
  menu;
  constructor(game, onChoose) {
    this.game = game;
    this.onChoose = onChoose;
    this.menu = game.hasSave ? ["CONTINUE", "NEW GAME", "OPTION", "MAP VIEWER"] : ["NEW GAME", "OPTION", "MAP VIEWER"];
  }
  monPage() {
    const species = CYCLE[this.cycleAt % CYCLE.length];
    const p = this.game.picPageFor ? this.game.picPageFor(species) : picPageFor(this.game.data, species);
    return p >= 0 ? p : CYCLE_PAGES[species] ?? -1;
  }
  update() {
    const p = this.game.input.pressed;
    this.timer += 1;
    if (this.timer === 2) {
      this.game.audio?.play?.("Music_TitleScreen");
    }
    if (this.phase === "press") {
      if (this.timer % 150 === 0)
        this.cycleAt += 1;
      if (p.start || p.a) {
        this.phase = "menu";
        this.index = 0;
      }
      return;
    }
    if (p.up)
      this.index = (this.index + this.menu.length - 1) % this.menu.length;
    if (p.down)
      this.index = (this.index + 1) % this.menu.length;
    if (p.b) {
      this.phase = "press";
      return;
    }
    if (p.a) {
      const pick = this.menu[this.index];
      this.game.pop();
      if (pick === "CONTINUE")
        this.onChoose("continue");
      else if (pick === "NEW GAME")
        this.onChoose("new");
      else if (pick === "MAP VIEWER")
        this.onChoose("viewer");
      else
        this.onChoose("option");
    }
  }
  view() {
    return {
      phase: this.phase,
      monPage: this.monPage(),
      menu: this.menu,
      index: this.index,
      hasSave: !!this.game.hasSave
    };
  }
}

// voxelmon/game/ui/intro.ts
var UI_SCALE2 = VIEW_H / GB_H;
var UI_ORIGIN_X2 = (VIEW_W - GB_W * UI_SCALE2) / 2;
var sx = (gx) => Math.round(UI_ORIGIN_X2 + gx * UI_SCALE2);
var sy = (gy) => Math.round(gy * UI_SCALE2);
var sw = (gw) => Math.round(gw * UI_SCALE2);
var COPYRIGHT_FRAMES = 180;
var STAR_START = 64;
var STAR_FRAMES = 40;
var FLASH_START = STAR_START + STAR_FRAMES;
var FLASH_FRAMES = 30;
var WAVES_START = FLASH_START + FLASH_FRAMES;
var WAVE_FRAMES = 24;
var WAVES_END = WAVES_START + 6 * WAVE_FRAMES;
var SPLASH_FRAMES = WAVES_END + 40;
var LOGO_X = 72;
var LOGO_Y = 56;
var TEXT_X2 = 40;
var TEXT_Y = 80;
var STAR_WAVES = [
  [40, 56, 80, 112],
  [48, 64, 88, 104],
  [44, 68, 76, 92],
  [52, 84, 100, 108]
];
var COPY_PREFIX = [0, 1, 2, 1, 3, 1, 4];
var COPY_NINTENDO = [5, 6, 7, 8, 9, 10];
var COPY_CREATURES = [11, 12, 13, 14, 15, 16, 17, 18];
var COPY_GAMEFREAK = [0, 1, 2, 3, 4, 5, 6, 7, 8];
var COPY_ROWS = [56, 72, 88];
var FLAP_W = 88;
var FLAP_H = 80;
var FLAP_AT = [
  { x: 0, y: 0, dx: -1, dy: -1 },
  { x: GB_W - FLAP_W, y: 0, dx: 1, dy: -1 },
  { x: 0, y: GB_H - FLAP_H, dx: -1, dy: 1 },
  { x: GB_W - FLAP_W, y: GB_H - FLAP_H, dx: 1, dy: 1 }
];
var BANNER_AT = 6;
var BANNER_POP = 24;
var BANNER_BLINK = 8;
var WHOOSH_AT = 56;
var BREACH_AT = 82;
var BURST_FRAMES = 46;
var ZOOM_FRAMES = 80;
var TEAR_FRAMES = BURST_FRAMES + ZOOM_FRAMES;
var FIST_AT = 8;
function burstOf(tear) {
  return Math.max(0, Math.min(1, tear / BURST_FRAMES));
}
function zoomOf(tear) {
  return Math.max(0, Math.min(1, (tear - BURST_FRAMES) / ZOOM_FRAMES));
}
function fistScale(tear) {
  if (tear < FIST_AT || tear > BURST_FRAMES)
    return 0;
  const u = (tear - FIST_AT) / (BURST_FRAMES - FIST_AT);
  return 0.08 + Math.pow(u, 2.4) * 3.3;
}
function fistPop(tear) {
  if (tear < FIST_AT || tear > BURST_FRAMES)
    return 0;
  const u = (tear - FIST_AT) / (BURST_FRAMES - FIST_AT);
  return Math.min(1, u * 1.4);
}
var ANIM = [
  [[0, 0], [-2, 2], [-1, 2], [1, 2], [2, 2]],
  [[0, 0], [-2, -2], [-1, -2], [1, -2], [2, -2]],
  [[0, 0], [-12, 6], [-8, 6], [8, 6], [12, 6]],
  [[0, 0], [-8, -4], [-4, -4], [4, -4], [8, -4]],
  [[0, 0], [-8, 4], [-4, 4], [4, 4], [8, 4]],
  [[0, 0], [2, 0], [2, 0], [0, 0]],
  [[-8, -16], [-7, -14], [-6, -12], [-4, -10]]
];
var FIGHT = [
  { move: "scrollIn", px: 80 },
  { sfx: "Intro_Hip" },
  { anim: 1 },
  { sfx: "Intro_Hop" },
  { anim: 2 },
  { wait: 10 },
  { sfx: "Intro_Hip" },
  { anim: 1 },
  { sfx: "Intro_Hop" },
  { anim: 2 },
  { wait: 30 },
  { pose: 2 },
  { sfx: "Intro_Raise" },
  { move: "gengar", dx: -8 },
  { wait: 30 },
  { pose: 3 },
  { sfx: "Intro_Crash" },
  { move: "gengar", dx: 16 },
  { sfx: "Intro_Hip" },
  { frame: 2 },
  { anim: 3 },
  { wait: 30 },
  { move: "gengar", dx: -8 },
  { pose: 1 },
  { wait: 60 },
  { sfx: "Intro_Hip" },
  { frame: 1 },
  { anim: 4 },
  { sfx: "Intro_Hop" },
  { anim: 5 },
  { wait: 20 },
  { frame: 2 },
  { anim: 6 },
  { wait: 30 },
  { sfx: "Intro_Lunge" },
  { frame: 3 },
  { anim: 7 },
  { fade: 24 }
];

class IntroState {
  game;
  onDone;
  kind = "intro";
  phase = "copyright";
  t = 0;
  done = false;
  gengarX = 104;
  gengarY = 56;
  nidoX = -8;
  nidoY = 72;
  pose = 1;
  frame = 1;
  op = 0;
  opT = 0;
  fade = 0;
  tear = -1;
  constructor(game, onDone) {
    this.game = game;
    this.onDone = onDone;
  }
  page(key) {
    return namedPage(this.game.data, "picIntro", key);
  }
  titleArt(key) {
    return namedPage(this.game.data, "picTitle", key);
  }
  animPage() {
    const a = this.game.data.atlas;
    return a?.animPages?.["battleanim/46ee"] ?? -1;
  }
  finish() {
    if (this.done)
      return;
    this.done = true;
    this.game.audio?.stop();
    this.game.pop();
    this.onDone();
  }
  update() {
    const p = this.game.input.pressed;
    if (p.a || p.b || p.start) {
      this.finish();
      return;
    }
    this.t += 1;
    if (this.tear >= 0)
      this.tear += 1;
    if (this.phase === "copyright") {
      if (this.t >= COPYRIGHT_FRAMES)
        this.start("splash");
      return;
    }
    if (this.phase === "splash") {
      if (this.t === STAR_START)
        this.game.audio?.playSfx("Shooting_Star");
      if (this.t >= SPLASH_FRAMES)
        this.start("punch");
      return;
    }
    if (this.phase === "punch") {
      if (this.t === WHOOSH_AT)
        this.game.audio?.playSfx("Intro_Whoosh");
      if (this.t >= BREACH_AT) {
        this.game.audio?.playSfx("Intro_Crash");
        this.tear = 0;
        this.start("fight");
      }
      return;
    }
    this.fightStep();
  }
  start(phase) {
    this.phase = phase;
    this.t = 0;
    if (phase === "fight")
      this.game.audio?.playOnce("Music_IntroBattle");
  }
  fightStep() {
    for (;; ) {
      const op = FIGHT[this.op];
      if (!op) {
        this.finish();
        return;
      }
      if (op.sfx) {
        this.game.audio?.playSfx(op.sfx);
      } else if (op.pose !== undefined) {
        this.pose = op.pose;
      } else if (op.frame !== undefined) {
        this.frame = op.frame;
      } else if (op.move) {
        if (this.opT % 2 === 0) {
          if (op.move === "scrollIn") {
            this.gengarX -= 2;
            this.nidoX += 2;
          } else {
            this.gengarX += (op.dx ?? 0) > 0 ? 2 : -2;
          }
        }
        this.opT += 1;
        if (this.opT < (op.px ?? Math.abs(op.dx ?? 0)))
          return;
      } else if (op.anim !== undefined) {
        const list2 = ANIM[op.anim - 1];
        if (this.opT % 5 === 0) {
          const d = list2[this.opT / 5];
          if (d) {
            this.nidoY += d[0];
            this.nidoX += d[1];
          }
        }
        this.opT += 1;
        if (this.opT < list2.length * 5)
          return;
      } else if (op.wait !== undefined) {
        this.opT += 1;
        if (this.opT < op.wait)
          return;
      } else if (op.fade !== undefined) {
        this.opT += 1;
        this.fade = this.opT / op.fade;
        if (this.opT >= op.fade)
          this.finish();
        return;
      }
      this.op += 1;
      this.opT = 0;
    }
  }
  paper(out) {
    const page = this.page("white");
    if (page < 0)
      return;
    out.push({ page, x: 0, y: 0, w: VIEW_W, h: VIEW_H });
  }
  gb(out, key, gy, gh) {
    const page = this.page(key);
    if (page < 0)
      return;
    out.push({ page, x: sx(0), y: sy(gy), w: sw(GB_W), h: sw(gh) });
  }
  bars(out) {
    const black = this.page("black");
    if (black < 0)
      return;
    out.push({ page: black, x: 0, y: 0, w: VIEW_W, h: sy(32) });
    out.push({ page: black, x: 0, y: sy(GB_H - 32), w: VIEW_W, h: VIEW_H - sy(GB_H - 32) });
  }
  splashArt(out, dim) {
    const logo = this.page(dim ? "gflogo_dim" : "gflogo");
    if (logo >= 0) {
      out.push({ page: logo, x: sx(LOGO_X), y: sy(LOGO_Y), w: sw(16), h: sw(24) });
    }
    const text = this.page("gftext");
    if (text >= 0) {
      out.push({ page: text, x: sx(TEXT_X2), y: sy(TEXT_Y), w: sw(80), h: sw(8) });
    }
  }
  marquee(out, clock) {
    const page = this.page("in3d");
    if (page < 0 || clock < BANNER_AT)
      return;
    if (Math.floor(clock / BANNER_BLINK) % 2 !== 0)
      return;
    const W = 60, H = 16;
    const pop = Math.min(1, (clock - BANNER_AT) / BANNER_POP);
    out.push({
      page,
      x: sx((GB_W - W) / 2),
      y: sy(36),
      w: sw(W),
      h: sw(H),
      d: Math.round(pop * 160)
    });
  }
  copyrightTiles(out) {
    const strip = this.titleArt("copyright");
    const gf = this.titleArt("gamefreak");
    const row = (page, seq, x, y) => {
      if (page < 0)
        return;
      seq.forEach((t, i) => out.push({ page, tile: t, x: x + i * 8, y, flags: 0 }));
    };
    COPY_ROWS.forEach((y) => row(strip, COPY_PREFIX, 16, y));
    row(strip, COPY_NINTENDO, 80, COPY_ROWS[0]);
    row(strip, COPY_CREATURES, 80, COPY_ROWS[1]);
    row(gf, COPY_GAMEFREAK, 80, COPY_ROWS[2]);
  }
  unbarred(y) {
    return y >= 32 && y + 8 <= 112;
  }
  bigStar(out) {
    const page = this.animPage();
    if (page < 0)
      return;
    const n = this.t - STAR_START + 1;
    const x = 152 - 4 * n;
    const y = -16 + 4 * n;
    for (const pair of [[3, 0], [19, 8]]) {
      const tile = pair[0];
      const dy = pair[1];
      if (!this.unbarred(y + dy))
        continue;
      out.push({ page, tile, x, y: y + dy, flags: 0 });
      out.push({ page, tile, x: x + 8, y: y + dy, flags: 1 });
    }
  }
  fallingStars(out) {
    const star = this.page("star");
    const blink = this.page("star_blink");
    if (star < 0)
      return;
    const substep = Math.floor((Math.min(this.t, WAVES_END) - WAVES_START) / 3);
    const page = substep % 2 === 0 ? star : blink >= 0 ? blink : star;
    STAR_WAVES.forEach((xs, w) => {
      const spawn = w * 8;
      if (substep < spawn)
        return;
      const y = 88 + (substep - spawn);
      if (!this.unbarred(y))
        return;
      for (const x of xs)
        out.push({ page, tile: 0, x, y, flags: 0 });
    });
  }
  fightArt(out) {
    const nido = this.page(`nido${this.frame}`);
    if (nido >= 0) {
      out.push({ page: nido, x: sx(this.nidoX), y: sy(this.nidoY), w: sw(48), h: sw(48) });
    }
    const gengar = this.page(`gengar${this.pose}`);
    if (gengar >= 0) {
      out.push({ page: gengar, x: sx(this.gengarX), y: sy(this.gengarY), w: sw(56), h: sw(56) });
    }
  }
  tearArt(out) {
    const tear = Math.max(0, this.tear);
    const burst = burstOf(tear);
    const zoom = zoomOf(tear);
    const piece = (kind, fly, grow) => {
      FLAP_AT.forEach((at, q) => {
        const page = this.page(`${kind}${q}`);
        if (page < 0)
          return;
        const gx = at.dx < 0 ? at.x : at.x + FLAP_W - FLAP_W * grow;
        const gy = at.dy < 0 ? at.y : at.y + FLAP_H - FLAP_H * grow;
        const quad = {
          page,
          x: sx(gx) + Math.round(at.dx * fly),
          y: sy(gy) + Math.round(at.dy * fly * 0.75),
          w: sw(FLAP_W * grow),
          h: sw(FLAP_H * grow)
        };
        if (quad.x >= VIEW_W || quad.y >= VIEW_H)
          return;
        if (quad.x + quad.w <= 0 || quad.y + quad.h <= 0)
          return;
        out.push(quad);
      });
    };
    if (zoom < 1)
      piece("flap", zoom * zoom * 700, 1 + zoom * 2.2);
    if (zoom < 1) {
      piece("patch", Math.pow(burst, 0.75) * 120 + zoom * zoom * 760, 1 + burst * 0.2 + zoom * 2.4);
    }
    const scale = fistScale(tear);
    if (scale <= 0)
      return;
    const fist = this.page("fist");
    if (fist < 0)
      return;
    const size = Math.round(VIEW_H * scale);
    const pop = fistPop(tear);
    const away = pop * pop * pop;
    out.push({
      page: fist,
      x: Math.round(VIEW_W / 2 - size / 2 - away * 150),
      y: Math.round(VIEW_H / 2 - size / 2 + away * 90),
      w: size,
      h: size,
      d: Math.round(pop * 256)
    });
  }
  view() {
    const pics = [];
    const tiles = [];
    this.paper(pics);
    if (this.phase === "copyright") {
      this.copyrightTiles(tiles);
    } else if (this.phase === "splash") {
      if (this.t >= STAR_START) {
        const flashing = this.t >= FLASH_START && this.t < FLASH_START + FLASH_FRAMES;
        this.splashArt(pics, flashing && Math.floor((this.t - FLASH_START) / 5) % 2 === 0);
      }
      if (this.t >= STAR_START && this.t < FLASH_START)
        this.bigStar(tiles);
      if (this.t >= WAVES_START)
        this.fallingStars(tiles);
      this.bars(pics);
    } else if (this.phase === "punch") {
      this.tearArt(pics);
      this.marquee(pics, this.t);
      this.bars(pics);
    } else {
      const bursting = this.tear >= 0 && burstOf(this.tear) < 1;
      if (bursting)
        this.gb(pics, "black", 0, GB_H);
      else
        this.fightArt(pics);
      if (this.tear >= 0 && this.tear <= TEAR_FRAMES)
        this.tearArt(pics);
      if (bursting)
        this.marquee(pics, BREACH_AT + this.tear);
      this.bars(pics);
      if (this.fade > 0) {
        const white = this.page("white");
        if (white >= 0 && this.fade >= 2 / 3) {
          pics.push({ page: white, x: 0, y: 0, w: VIEW_W, h: VIEW_H });
        }
      }
    }
    return { phase: this.phase, pics, tiles };
  }
}

// voxelmon/game/ui/startmenu.ts
class StartMenuState {
  game;
  onPick;
  kind = "startmenu";
  index = 0;
  entries;
  actions;
  constructor(game, onPick) {
    this.game = game;
    this.onPick = onPick;
    this.entries = [];
    this.actions = [];
    this.rebuild();
  }
  rebuild() {
    const game = this.game;
    const f = game.save?.flags ?? {};
    const party = game.save?.party ?? [];
    const e = [];
    if (f.EVENT_GOT_POKEDEX)
      e.push(["POKéDEX", "pokedex"]);
    if (party.length > 0)
      e.push(["POKéMON", "pokemon"]);
    e.push(["ITEM", "item"]);
    e.push([String(game.save?.player?.name ?? "RED"), "trainer"]);
    e.push(["SAVE", "save"]);
    e.push(["OPTION", "option"]);
    if (game.save?.options?.devMenu === true)
      e.push(["DEV", "dev"]);
    e.push(["EXIT", "exit"]);
    this.entries = e.map((x) => x[0]);
    this.actions = e.map((x) => x[1]);
    if (this.index >= this.entries.length)
      this.index = this.entries.length - 1;
  }
  update() {
    this.rebuild();
    const p = this.game.input.pressed;
    if (p.up)
      this.index = (this.index + this.entries.length - 1) % this.entries.length;
    if (p.down)
      this.index = (this.index + 1) % this.entries.length;
    if (p.b || p.start) {
      this.game.pop();
      return;
    }
    if (p.a) {
      const act = this.actions[this.index];
      if (act === "exit") {
        this.game.pop();
        return;
      }
      this.onPick(act);
    }
  }
  view() {
    const s = this.game.save?.safari;
    return {
      entries: this.entries,
      index: this.index,
      safari: s ? { balls: s.balls, steps: s.steps } : null
    };
  }
}

// voxelmon/game/ui/devmenu.ts
var ENTRIES = [
  ["WARP", "warp"],
  ["RARE CANDY", "candy"],
  ["CARD TEST", "cardtest"],
  ["CANCEL", "exit"]
];

class DevMenuState {
  game;
  onPick;
  kind = "devmenu";
  index = 0;
  constructor(game, onPick) {
    this.game = game;
    this.onPick = onPick;
  }
  update() {
    const p = this.game.input.pressed;
    const n = ENTRIES.length;
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (p.b || p.start) {
      this.game.pop();
      return;
    }
    if (p.a) {
      const act = ENTRIES[this.index][1];
      if (act === "exit") {
        this.game.pop();
        return;
      }
      this.onPick(act);
    }
  }
  view() {
    return { entries: ENTRIES.map((e) => e[0]), index: this.index };
  }
}

// voxelmon/game/ui/hofscreen.ts
var HOF_MON_FRAMES = 150;
var CREDITS_SCREEN_FRAMES = 110;
var CREDITS_END_FRAMES = 180;
function dexNumber(data, species) {
  const mons = data?.pokemon;
  const n = mons?.[species]?.dex;
  return n ? `No.${String(n).padStart(3, "0")}` : "";
}

class HallOfFameState {
  game;
  entry;
  onDone;
  kind = "halloffame";
  index = 0;
  timer = 0;
  constructor(game, entry, onDone) {
    this.game = game;
    this.entry = entry;
    this.onDone = onDone;
  }
  update() {
    this.timer += 1;
    const p = this.game.input.pressed;
    const skip = p.a === true || p.b === true || p.start === true;
    if (!skip && this.timer < HOF_MON_FRAMES)
      return;
    this.timer = 0;
    this.index += 1;
    if (this.index < this.entry.length)
      return;
    const done = this.onDone;
    this.game.pop();
    done();
  }
  view() {
    const mon = this.entry[this.index];
    const name = String(this.game.save?.player?.name ?? "RED");
    return {
      index: this.index,
      total: this.entry.length,
      title: `${name}'s HALL OF FAME`,
      mon: mon ? {
        dexNo: dexNumber(this.game.data, mon.species),
        name: mon.nickname && mon.nickname.length > 0 ? mon.nickname : mon.species,
        level: `LEVEL${String(mon.level).padStart(3, " ")}`,
        picPage: picPageFor(this.game.data, mon.species)
      } : null
    };
  }
}

class CreditsState {
  game;
  screens;
  onDone;
  kind = "credits";
  index = 0;
  timer = 0;
  ended = false;
  constructor(game, screens, onDone) {
    this.game = game;
    this.screens = screens;
    this.onDone = onDone;
  }
  get atEnd() {
    return this.index >= this.screens.length;
  }
  update() {
    this.timer += 1;
    const p = this.game.input.pressed;
    const skip = p.a === true || p.b === true || p.start === true;
    const hold = this.atEnd ? CREDITS_END_FRAMES : CREDITS_SCREEN_FRAMES;
    if (!skip && this.timer < hold)
      return;
    this.timer = 0;
    if (this.atEnd) {
      if (this.ended)
        return;
      this.ended = true;
      const done = this.onDone;
      this.game.pop();
      done();
      return;
    }
    this.index += 1;
  }
  view() {
    const s = this.screens[this.index];
    return {
      index: this.index,
      total: this.screens.length,
      lines: s?.lines ?? [],
      picPage: s?.mon ? picPageFor(this.game.data, s.mon) : -1,
      theEnd: this.atEnd
    };
  }
}

// voxelmon/game/ui/diploma.ts
var DIPLOMA_ARM_FRAMES = 3;

class DiplomaState {
  game;
  onDone;
  kind = "diploma";
  t = 0;
  constructor(game, onDone) {
    this.game = game;
    this.onDone = onDone;
  }
  update() {
    this.t += 1;
    if (this.t < DIPLOMA_ARM_FRAMES)
      return;
    const p = this.game.input.pressed;
    if (p.a || p.b || p.start) {
      this.game.pop();
      this.onDone?.();
    }
  }
  view() {
    return {
      title: "Diploma",
      name: this.game.save.player?.name ?? "RED",
      lines: [
        "Congratulations!",
        "This diploma",
        "certifies that",
        "you have",
        "completed your",
        "POKéDEX."
      ],
      signature: "GAME FREAK"
    };
  }
}

// voxelmon/game/ui/tradescreen.ts
var TRADE_THEIRS_ROW = 2;
var TRADE_MINE_ROW = 10;

class TradeScreenState {
  game;
  opts;
  kind = "tradescreen";
  side = 0;
  index = 0;
  chosenMine = null;
  closed = false;
  constructor(game, opts) {
    this.game = game;
    this.opts = opts;
  }
  finish(choice) {
    if (this.closed)
      return;
    this.closed = true;
    this.game.pop();
    this.opts.onDone(choice);
  }
  update() {
    if (this.closed)
      return;
    if (this.opts.watch.peerOffer) {
      this.finish({ kind: "incoming" });
      return;
    }
    if (this.opts.watch.state === "closed") {
      this.finish({ kind: "cancel" });
      return;
    }
    const p = this.game.input.pressed;
    const list2 = this.side === 0 ? this.opts.mine : this.opts.theirs;
    const n = Math.max(1, list2.length);
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (p.b) {
      if (this.side === 1) {
        this.side = 0;
        this.index = this.chosenMine ?? 0;
        this.chosenMine = null;
      } else
        this.finish({ kind: "cancel" });
      return;
    }
    if (!p.a || list2.length === 0)
      return;
    if (this.side === 0) {
      this.chosenMine = this.index;
      this.side = 1;
      this.index = 0;
      return;
    }
    this.finish({ kind: "propose", give: this.chosenMine ?? 0, take: this.index });
  }
  view() {
    return {
      myName: this.opts.myName,
      peerName: this.opts.peerName,
      mine: this.opts.mine,
      theirs: this.opts.theirs,
      side: this.side,
      index: this.index,
      chosenMine: this.chosenMine,
      prompt: this.side === 0 ? "Choose a POKéMON." : `Which POKéMON
for theirs?`
    };
  }
}

// voxelmon/game/battle/linkbattle.ts
class LinkBattle extends TrainerBattle {
  link;
  wireAction = null;
  pendingMine = null;
  lastPeerAction = null;
  constructor(data, save, rng, peerName, peerParty, link) {
    super(data, save, rng, "", 1, peerName, peerParty);
    this.link = link;
  }
  waitingForPeer() {
    return this.pendingMine !== null;
  }
  enemyAction() {
    return this.wireAction ?? { id: "STRUGGLE", pp: 1, struggle: true };
  }
  resolveTurn(mine) {
    if (this.wireAction) {
      super.resolveTurn(mine);
      return;
    }
    this.pendingMine = mine;
    this.link.sendAction(mine);
  }
  update(input) {
    const mine = this.pendingMine;
    if (mine) {
      const theirs = this.link.takeAction();
      if (!theirs || typeof theirs.id !== "string")
        return;
      this.wireAction = theirs;
      this.lastPeerAction = theirs;
      this.pendingMine = null;
      super.resolveTurn(mine);
      this.wireAction = null;
      return;
    }
    super.update(input);
  }
}

// voxelmon/game/world/halloffame.ts
var POST_GAME_HOME = {
  map: "REDS_HOUSE_2F",
  x: 3,
  y: 6,
  facing: "down"
};
var POST_GAME_OUTDOOR = { id: "PALLET_TOWN", x: 5, y: 6 };
var HALL_OF_FAME_MAX = 50;
function recordHallOfFame(save) {
  const entry = (save.party ?? []).map((mon) => {
    const rec = {
      species: String(mon.species ?? ""),
      level: Number(mon.level ?? 0)
    };
    if (mon.nickname)
      rec.nickname = mon.nickname;
    return rec;
  });
  const hall = save.hallOfFame ??= [];
  hall.push(entry);
  while (hall.length > HALL_OF_FAME_MAX)
    hall.shift();
  return entry;
}
function applyPostGameHome(save) {
  save.lastOutdoor = { ...POST_GAME_OUTDOOR };
}
function postGameRescue(save) {
  const p = save.player;
  if (!p || p.map !== "HALL_OF_FAME")
    return false;
  if ((save.hallOfFame?.length ?? 0) === 0)
    return false;
  if (save.flags?.EVENT_HALL_OF_FAME_PENDING === true)
    return false;
  p.map = POST_GAME_HOME.map;
  p.x = POST_GAME_HOME.x;
  p.y = POST_GAME_HOME.y;
  p.facing = POST_GAME_HOME.facing;
  applyPostGameHome(save);
  return true;
}

// voxelmon/game/ui/optionsmenu.ts
var OPTIONS_VISIBLE = 4;
var CAMERA_SPEEDS = [
  { key: "slow", label: "SLOW", q8: 128 },
  { key: "normal", label: "NORMAL", q8: 256 },
  { key: "fast", label: "FAST", q8: 448 }
];
var CAMERA_SPEED_DEFAULT_Q8 = 256;

class OptionsMenuState {
  game;
  kind = "options";
  index = 0;
  first = 0;
  constructor(game) {
    this.game = game;
  }
  opts() {
    const save = this.game.save;
    return save.options ??= {};
  }
  cameraIndex() {
    const at = CAMERA_SPEEDS.findIndex((s) => s.key === this.opts().cameraSpeed);
    return at >= 0 ? at : 1;
  }
  speedIndex() {
    const cur = this.opts().textSpeed ?? TEXT_SPEED_DEFAULT;
    const at = TEXT_SPEEDS.findIndex((s) => s.delay === cur);
    return at >= 0 ? at : 1;
  }
  rows() {
    return [
      {
        label: "TEXT SPEED",
        choices: TEXT_SPEEDS.map((s) => s.label),
        index: this.speedIndex()
      },
      {
        label: "BATTLE ANIMATION",
        choices: ["ON", "OFF"],
        index: this.opts().animations === false ? 1 : 0
      },
      {
        label: "MOVEMENT",
        choices: ["FREE", "GRID"],
        index: this.opts().movement === "grid" ? 1 : 0
      },
      {
        label: "CAMERA SPEED",
        choices: CAMERA_SPEEDS.map((s) => s.label),
        index: this.cameraIndex()
      },
      {
        label: "DEV MENU",
        choices: ["OFF", "ON"],
        index: this.opts().devMenu === true ? 1 : 0
      }
    ];
  }
  set(row, to) {
    const rows = this.rows();
    const r = rows[row];
    if (!r)
      return;
    const at = Math.max(0, Math.min(r.choices.length - 1, to));
    if (row === 0)
      this.opts().textSpeed = TEXT_SPEEDS[at].delay;
    else if (row === 1)
      this.opts().animations = at === 0;
    else if (row === 2)
      this.opts().movement = at === 1 ? "grid" : "free";
    else if (row === 3)
      this.opts().cameraSpeed = CAMERA_SPEEDS[at].key;
    else if (row === 4)
      this.opts().devMenu = at === 1;
  }
  update() {
    const p = this.game.input.pressed;
    const rows = this.rows();
    const n = rows.length + 1;
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (this.index < this.first)
      this.first = this.index;
    if (this.index >= this.first + OPTIONS_VISIBLE)
      this.first = this.index - OPTIONS_VISIBLE + 1;
    if (this.index < rows.length) {
      const r = rows[this.index];
      if (p.left)
        this.set(this.index, (r.index + r.choices.length - 1) % r.choices.length);
      if (p.right)
        this.set(this.index, (r.index + 1) % r.choices.length);
      if (p.a)
        this.set(this.index, (r.index + 1) % r.choices.length);
    } else if (p.a) {
      this.game.pop();
      return;
    }
    if (p.b || p.start) {
      this.game.pop();
      return;
    }
  }
  view() {
    return { rows: this.rows(), index: this.index, first: this.first, visible: OPTIONS_VISIBLE };
  }
}

// voxelmon/game/ui/prizescreen.ts
class PrizeState {
  game;
  prizes;
  onDone;
  kind = "prizes";
  index = 0;
  closing = false;
  constructor(game, prizes, onDone) {
    this.game = game;
    this.prizes = prizes;
    this.onDone = onDone;
  }
  label(p) {
    if (p.kind === "mon") {
      const name = this.game.data.pokemon?.[p.species]?.name ?? p.species;
      return `${name} L${p.level}`;
    }
    return this.game.data.items?.[p.item]?.name ?? p.item;
  }
  close(msg) {
    if (this.closing)
      return;
    this.closing = true;
    this.game.pop();
    if (msg)
      this.game.showText(msg, this.onDone);
    else
      this.onDone?.();
  }
  buy(p) {
    const save = this.game.save;
    const t = this.game.data.text ?? {};
    if ((save.coins ?? 0) < p.cost) {
      this.close(t._SorryNeedMoreCoinsText ?? `Sorry, you need
more coins.`);
      return;
    }
    const roomless = t._OopsYouDontHaveEnoughRoomText ?? `Oops! You don't
have enough room.`;
    if (p.kind === "mon") {
      if (!this.game.givePrizeMon(p.species, p.level)) {
        this.close(roomless);
        return;
      }
    } else if (!add(this.game.save, p.item, 1, this.game.data)) {
      this.close(roomless);
      return;
    }
    save.coins = (save.coins ?? 0) - p.cost;
    this.close();
  }
  update() {
    if (this.closing)
      return;
    const p = this.game.input.pressed;
    const n = this.prizes.length + 1;
    if (p.up || p.left)
      this.index = (this.index + n - 1) % n;
    if (p.down || p.right)
      this.index = (this.index + 1) % n;
    if (p.b || p.a && this.index === this.prizes.length) {
      this.close();
      return;
    }
    if (!p.a)
      return;
    const prize = this.prizes[this.index];
    const t = this.game.data.text ?? {};
    const ask2 = (t._SoYouWantPrizeText ?? `So, you want
{RAM:wNameBuffer}?`).replace("{RAM:wNameBuffer}", this.label(prize));
    this.game.showChoice(ask2, (yes) => {
      if (!yes) {
        this.close(t._OhFineThenText ?? "Oh, fine then.");
        return;
      }
      this.buy(prize);
    });
  }
  view() {
    return {
      rows: this.prizes.map((p) => ({ label: this.label(p), cost: p.cost })),
      index: this.index,
      coins: this.game.save?.coins ?? 0,
      message: null
    };
  }
}

// voxelmon/game/ui/slotmachine.ts
var PAYOUT = {
  "7": 300,
  BAR: 100,
  CHERRY: 8,
  MOUSE: 15,
  FISH: 15,
  BIRD: 15
};
var LINES = [
  { rows: [0, 1, 2], bet: 3 },
  { rows: [2, 1, 0], bet: 3 },
  { rows: [2, 2, 2], bet: 2 },
  { rows: [0, 0, 0], bet: 2 },
  { rows: [1, 1, 1], bet: 1 }
];
var STEP_FRAMES3 = 2;
var SPINUP_STEPS = 20;
var COIN_CAP2 = 9999;
function at(wheel, pos, off) {
  return wheel[((pos + off - 1) % wheel.length + wheel.length) % wheel.length];
}
function rowsAt(wheel, pos) {
  return [at(wheel, pos, 0), at(wheel, pos, 1), at(wheel, pos, 2)];
}
function evaluate(wheels, stops, bet) {
  for (const line of LINES) {
    if (bet < line.bet)
      continue;
    const a = at(wheels[0], stops[0], line.rows[0]);
    const b = at(wheels[1], stops[1], line.rows[1]);
    const c = at(wheels[2], stops[2], line.rows[2]);
    if (a === b && b === c)
      return { payout: PAYOUT[a] ?? 15, symbol: a };
  }
  return null;
}
function stopWheel1Early(wheels, pos1, sevenBar) {
  if (sevenBar)
    return false;
  return rowsAt(wheels[0], pos1)[1] !== "CHERRY";
}
function findWheel1Wheel2Matches(wheels, pos1, pos2) {
  const [b1, m1, t1] = rowsAt(wheels[0], pos1);
  const [b2, m2, t2] = rowsAt(wheels[1], pos2);
  if (b2 === b1)
    return [true, b2];
  if (m2 === b1)
    return [true, m2];
  if (m2 === m1)
    return [true, m2];
  if (m2 === t1)
    return [true, m2];
  if (t2 === t1)
    return [true, t2];
  return [false, b2];
}
function stopWheel2Early(wheels, pos1, pos2, sevenBar) {
  const [matched, tile] = findWheel1Wheel2Matches(wheels, pos1, pos2);
  if (sevenBar)
    return tile === "7" || tile === "BAR";
  return matched;
}
function checkForMatch(wheels, stops, bet, canWin, sevenBar) {
  const win = evaluate(wheels, stops, bet);
  if (!win)
    return ["nomatch", null];
  if (!(canWin || sevenBar))
    return ["roll", win];
  if (!sevenBar && (win.symbol === "7" || win.symbol === "BAR"))
    return ["roll", win];
  return ["accept", win];
}

class SlotMachineState {
  game;
  rng;
  onDone;
  kind = "slots";
  wheels;
  order;
  stage = "intro";
  yesno = 1;
  betIndex = 0;
  bet = 3;
  payoutDisplay = 0;
  flash = false;
  offset = [29, 29, 29];
  stopping = 0;
  slip = [4, 4];
  reroll = 4;
  frame = 0;
  message = null;
  afterMessage = null;
  exitTimer = null;
  spinupSteps = 0;
  rerollSteps = 0;
  win = null;
  payoutRemaining = 0;
  flashLeft = 0;
  flashTimer = 0;
  dripFrames = 8;
  dripTimer = 0;
  dripFlash = 5;
  sevenBarChance;
  allowMatches = 0;
  canWin = false;
  sevenBar = false;
  constructor(game, rng, lucky, onDone) {
    this.game = game;
    this.rng = rng;
    this.onDone = onDone;
    this.wheels = game.data.field?.slotWheels ?? [[], [], []];
    this.order = game.data.field?.slotSymbols?.order ?? [];
    this.sevenBarChance = lucky ? 250 : 253;
  }
  coins() {
    return this.game.save.coins ?? 0;
  }
  sfx(name) {
    this.game.playSfx?.(name);
  }
  setFlags() {
    if (this.sevenBar)
      return;
    if (this.allowMatches > 0) {
      this.canWin = true;
      return;
    }
    const r = this.rng.byte();
    if (r === 0) {
      this.allowMatches = 60;
      return;
    }
    if (r > this.sevenBarChance) {
      this.sevenBar = true;
      return;
    }
    this.canWin = r > 210;
  }
  animWheel(w) {
    this.offset[w] = (this.offset[w] + 1) % 30;
  }
  stops() {
    return this.offset.map((o) => (o + 1) / 2);
  }
  stopOrAnimWheel(w) {
    if (this.stopping < w + 1) {
      this.animWheel(w);
      return;
    }
    const o = this.offset[w];
    if (o % 2 === 0) {
      this.animWheel(w);
      return;
    }
    if (this.slip[w] === 0)
      return;
    this.slip[w] = this.slip[w] - 1;
    const stop = w === 0 ? stopWheel1Early(this.wheels, (o + 1) / 2, this.sevenBar) : stopWheel2Early(this.wheels, (this.offset[0] + 1) / 2, (o + 1) / 2, this.sevenBar);
    if (stop) {
      this.slip[w] = 0;
      return;
    }
    this.animWheel(w);
  }
  stopOrAnimWheel3() {
    if (this.stopping < 3) {
      this.animWheel(2);
      return false;
    }
    if (this.offset[2] % 2 === 1)
      return true;
    this.animWheel(2);
    return false;
  }
  checkForMatches() {
    const [action, win] = checkForMatch(this.wheels, this.stops(), this.bet, this.canWin, this.sevenBar);
    if (action === "accept") {
      this.resolveWin(win);
      return;
    }
    if (action === "nomatch") {
      if (!(this.canWin || this.sevenBar)) {
        this.resolveLose();
        return;
      }
      this.reroll -= 1;
      if (this.reroll === 0) {
        this.resolveLose();
        return;
      }
    }
    this.stage = "reroll";
    this.rerollSteps = 2;
  }
  resolveWin(win) {
    const { symbol: sym, payout: pay } = win;
    let flashes;
    if (sym === "7") {
      this.sfx("Get_Item2");
      if (this.rng.byte() >= 128) {
        this.canWin = false;
        this.sevenBar = false;
      }
      this.allowMatches = 0;
      flashes = 20;
    } else if (sym === "BAR") {
      this.sfx("Get_Key_Item");
      this.canWin = false;
      this.sevenBar = false;
      flashes = 8;
    } else {
      if (this.allowMatches > 0)
        this.allowMatches -= 1;
      flashes = pay === 8 ? 2 : 4;
    }
    this.win = win;
    this.payoutRemaining = pay;
    this.payoutDisplay = pay;
    this.message = `${sym} lined up!
Scored ${pay} coins!`;
    this.stage = "flash";
    this.flashLeft = flashes;
    this.flashTimer = 0;
    this.flash = false;
  }
  resolveLose() {
    this.message = "Not this time!";
    this.stage = "message";
    this.afterMessage = "onemore";
  }
  enterBet() {
    this.stage = "bet";
    this.betIndex = 0;
    this.bet = 3;
    this.message = null;
    this.payoutDisplay = 0;
  }
  enterOneMore() {
    this.stage = "onemore";
    this.yesno = 1;
    this.message = null;
    this.payoutDisplay = 0;
  }
  afterSpin() {
    if (this.coins() === 0) {
      this.message = `Darn!
Ran out of coins!`;
      this.stage = "message";
      this.afterMessage = null;
      this.exitTimer = 60;
    } else {
      this.enterOneMore();
    }
  }
  startPayout() {
    this.stage = "payout";
    const sym = this.win?.symbol;
    this.dripFrames = sym === "7" || sym === "BAR" ? 4 : 8;
    this.dripTimer = 0;
    this.dripFlash = 5;
    this.flash = false;
  }
  close() {
    this.game.pop();
    this.onDone?.();
  }
  updateYesNo(p, onYes) {
    if (p.up || p.down)
      this.yesno = this.yesno === 1 ? 2 : 1;
    else if (p.a) {
      this.sfx("Press_AB");
      if (this.yesno === 1)
        onYes();
      else
        this.close();
    } else if (p.b) {
      this.sfx("Press_AB");
      this.close();
    }
  }
  update() {
    const p = this.game.input.pressed;
    const save = this.game.save;
    switch (this.stage) {
      case "intro":
        this.updateYesNo(p, () => this.enterBet());
        return;
      case "message": {
        if (this.exitTimer !== null) {
          this.exitTimer -= 1;
          if (this.exitTimer <= 0)
            this.close();
          return;
        }
        if (!(p.a || p.b))
          return;
        this.sfx("Press_AB");
        const after = this.afterMessage;
        this.afterMessage = null;
        if (after === "payout")
          this.startPayout();
        else if (after === "onemore")
          this.afterSpin();
        else
          this.enterBet();
        return;
      }
      case "onemore":
        this.updateYesNo(p, () => this.enterBet());
        return;
      case "flash":
        this.flashTimer += 1;
        if (this.flashTimer >= 5) {
          this.flashTimer = 0;
          this.flash = !this.flash;
          this.flashLeft -= 1;
          if (this.flashLeft <= 0) {
            this.flash = false;
            this.stage = "message";
            this.afterMessage = "payout";
          }
        }
        return;
      case "payout":
        if (this.payoutRemaining <= 0) {
          this.flash = false;
          this.payoutDisplay = 0;
          this.afterSpin();
          return;
        }
        this.dripTimer += 1;
        if (this.dripTimer >= this.dripFrames) {
          this.dripTimer = 0;
          save.coins = Math.min(COIN_CAP2, this.coins() + 1);
          this.payoutRemaining -= 1;
          this.payoutDisplay = this.payoutRemaining;
          this.sfx("Slots_Reward");
          this.dripFlash -= 1;
          if (this.dripFlash <= 0) {
            this.dripFlash = 5;
            this.flash = !this.flash;
          }
        }
        return;
      case "bet":
        if (p.b) {
          this.close();
          return;
        }
        if (p.up)
          this.betIndex = Math.max(0, this.betIndex - 1);
        if (p.down)
          this.betIndex = Math.min(2, this.betIndex + 1);
        this.bet = 3 - this.betIndex;
        if (!p.a)
          return;
        if (this.coins() < this.bet) {
          this.message = `Not enough
coins!`;
          this.afterMessage = "bet";
          this.stage = "message";
          return;
        }
        save.coins = this.coins() - this.bet;
        this.setFlags();
        this.stopping = 0;
        this.slip = [4, 4];
        this.reroll = 4;
        this.frame = 0;
        this.spinupSteps = SPINUP_STEPS;
        this.stage = "spinup";
        this.sfx("Slots_New_Spin");
        return;
      case "spinup":
        this.frame += 1;
        if (this.frame % STEP_FRAMES3 === 0) {
          for (let w = 0;w < 3; w++)
            this.animWheel(w);
          this.spinupSteps -= 1;
          if (this.spinupSteps === 0)
            this.stage = "spin";
        }
        return;
      case "spin": {
        if (p.a) {
          const held = this.stopping === 1 && this.slip[0] > 0 || this.stopping === 2 && this.slip[1] > 0;
          if (!held) {
            this.stopping += 1;
            this.sfx("Slots_Stop_Wheel");
          }
        }
        this.frame += 1;
        if (this.frame % STEP_FRAMES3 === 0) {
          this.stopOrAnimWheel(0);
          this.stopOrAnimWheel(1);
          if (this.stopOrAnimWheel3())
            this.checkForMatches();
        }
        return;
      }
      case "reroll":
        this.animWheel(2);
        this.rerollSteps -= 1;
        if (this.rerollSteps === 0)
          this.checkForMatches();
        return;
    }
  }
  view() {
    const grid = this.offset.map((o, w) => {
      const pos = Math.floor((o + 1) / 2);
      const [b, m, t] = rowsAt(this.wheels[w] ?? [], pos);
      return [t, m, b];
    });
    return {
      stage: this.stage,
      grid,
      bet: this.bet,
      betIndex: this.betIndex,
      coins: this.coins(),
      payout: this.payoutDisplay,
      message: this.message,
      yesno: this.yesno,
      flash: this.flash,
      order: this.order
    };
  }
}

// voxelmon/game/ui/bikeshop.ts
var BIKE_PRICE = 1e6;

class BikeShopState {
  game;
  footer;
  onChoose;
  kind = "bikeshop";
  index = 0;
  answered = false;
  constructor(game, footer, onChoose) {
    this.game = game;
    this.footer = footer;
    this.onChoose = onChoose;
  }
  update() {
    if (this.answered)
      return;
    const p = this.game.input.pressed;
    if (p.up)
      this.index = 0;
    if (p.down)
      this.index = 1;
    if (!p.a && !p.b)
      return;
    const cancelled = !!p.b;
    this.game.playSfx("Press_AB");
    this.answered = true;
    this.onChoose(!cancelled && this.index === 0);
  }
  close() {
    this.game.pop();
  }
  view() {
    const name = this.game.data?.items?.BICYCLE?.name ?? "BICYCLE";
    return {
      rows: [name, "CANCEL"],
      price: `¥${BIKE_PRICE}`,
      index: this.index,
      footer: this.footer
    };
  }
}

// voxelmon/game/world/oaksaide.ts
var OAKS_AIDES = {
  TEXT_ROUTE2GATE_OAKS_AIDE: {
    threshold: 10,
    item: "HM_FLASH",
    repeatText: "_Route2GateOaksAideFlashExplanationText"
  },
  TEXT_ROUTE11GATE2F_OAKS_AIDE: {
    threshold: 30,
    item: "ITEMFINDER",
    repeatText: "_Route11Gate2FOaksAideItemfinderDescriptionText"
  },
  TEXT_ROUTE15GATE2F_OAKS_AIDE: {
    threshold: 50,
    item: "EXP_ALL",
    repeatText: "_Route15Gate2FOaksAideExpAllText"
  }
};
function oaksAideFlag(item) {
  return `EVENT_GOT_${item}`;
}
function countOwned(save) {
  const owned = save.pokedex?.owned ?? {};
  let n = 0;
  for (const k in owned)
    if (owned[k])
      n += 1;
  return n;
}
function fillAideText(text, subs) {
  return text.replace(/\{NUM:[^}]*\}/g, () => String(subs.num ?? "")).replace(/\{RAM:[^}]*\}/g, () => subs.item ?? "");
}

// voxelmon/game/ui/kantogear.ts
var COLS = 20;
var ROWS = 18;
var TILE_W = 320 / COLS;
var TILE_H = 240 / ROWS;
function stampBottom(host, x, y, s, bit = 0) {
  const codes = encodeGlyphs(s);
  for (let i = 0;i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i] | bit);
  }
}
function stampRight(host, y, s) {
  stampBottom(host, Math.max(0, COLS - s.length - 1), y, s);
}
function tilesBottom(host, x, y, tiles) {
  for (let i = 0;i < tiles.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, tiles[i]);
  }
}
var LIGHT_BIT = 32768;
function stampLight(host, x, y, s) {
  const codes = encodeGlyphs(s);
  for (let i = 0;i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i] | LIGHT_BIT);
  }
}
var FILL_BIT = 16384;
var DARKTEXT_BIT = 8192;
function fillCellBottom(host, x0, y0, w, h) {
  for (let y = y0;y < y0 + h; y++) {
    for (let x = x0;x < x0 + w && x < COLS; x++) {
      host.uiTileBottom(x, y, SPACE | FILL_BIT);
    }
  }
}
function stampFill(host, x, y, s) {
  const codes = encodeGlyphs(s);
  for (let i = 0;i < codes.length && x + i < COLS; i++) {
    host.uiTileBottom(x + i, y, codes[i] | FILL_BIT);
  }
}
function boxBottom(host, x0, y0, w, h, bit = 0) {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  host.uiTileBottom(x0, y0, BORDER_TL | bit);
  host.uiTileBottom(x1, y0, BORDER_TR | bit);
  host.uiTileBottom(x0, y1, BORDER_BL | bit);
  host.uiTileBottom(x1, y1, BORDER_BR | bit);
  for (let x = x0 + 1;x < x1; x++) {
    host.uiTileBottom(x, y0, BORDER_H | bit);
    host.uiTileBottom(x, y1, BORDER_H | bit);
  }
  for (let y = y0 + 1;y < y1; y++) {
    host.uiTileBottom(x0, y, BORDER_V | bit);
    host.uiTileBottom(x1, y, BORDER_V | bit);
  }
}
function clockStr() {
  try {
    const d = new Date;
    const m = d.getMinutes();
    let h = d.getHours();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0)
      h = 12;
    const mm = m < 10 ? "0" + String(m) : String(m);
    return String(h) + ":" + mm + ap;
  } catch {
    return "";
  }
}
function drawTopBar(host, title) {
  stampLight(host, 1, 0, title);
  const t = clockStr();
  if (t)
    stampLight(host, Math.max(0, COLS - t.length - 1), 0, t);
}
var BATTLE_ACTIONS = ["FIGHT", "PKMN", "ITEM", "RUN"];
var SAFARI_ACTIONS = ["BALL", "BAIT", "ROCK", "RUN"];
function drawActionGrid(host, menuIndex, showCursor, safari) {
  host.uiClearBottom();
  drawTopBar(host, safari ? `SAFARI BALLS ${safari.balls}` : "BATTLE");
  const cellW = 10;
  const cellH = 8;
  const colX = [0, 10];
  const rowY = [2, 10];
  for (let i = 0;i < 4; i++) {
    const x0 = colX[i % 2];
    const y0 = rowY[i / 2 | 0];
    const label3 = (safari ? SAFARI_ACTIONS : BATTLE_ACTIONS)[i];
    const iw = cellW - 2;
    const lx = x0 + 1 + Math.max(0, Math.floor((iw - label3.length) / 2));
    const ly = y0 + Math.floor(cellH / 2);
    if (showCursor && i === menuIndex - 1) {
      fillCellBottom(host, x0, y0, cellW, cellH);
      boxBottom(host, x0, y0, cellW, cellH);
      stampFill(host, lx, ly, label3);
    } else {
      boxBottom(host, x0, y0, cellW, cellH, DARKTEXT_BIT);
      stampBottom(host, lx, ly, label3, DARKTEXT_BIT);
    }
  }
}
function effLabel(e10) {
  if (e10 % 10 === 0)
    return String(e10 / 10) + "X";
  return (e10 / 10).toString().replace(/^0/, "") + "X";
}
function drawMoveSelect(host, game, b) {
  host.uiClearBottom();
  drawTopBar(host, "MOVES");
  const moves = b.player.curMoves;
  const cellW = 10;
  const cellH = 8;
  const colX = [0, 10];
  const rowY = [2, 10];
  const qmark = encodeGlyphs("?")[0];
  for (let i = 0;i < 4; i++) {
    if (i >= moves.length)
      continue;
    const x0 = colX[i % 2];
    const y0 = rowY[i / 2 | 0];
    const slot = moves[i];
    const def = game.data.moves[slot.id];
    const name = (def?.name ?? slot.id).slice(0, 7);
    const maxPp = def?.pp ?? slot.pp;
    const type = (def?.type ?? "").toUpperCase().slice(0, 6);
    const power = def?.power ?? 0;
    const selected = i === b.moveIndex - 1;
    const bit = selected ? FILL_BIT : DARKTEXT_BIT;
    if (selected)
      fillCellBottom(host, x0, y0, cellW, cellH);
    boxBottom(host, x0, y0, cellW, cellH, selected ? 0 : DARKTEXT_BIT);
    stampBottom(host, x0 + 1, y0 + 1, name, bit);
    host.uiTileBottom(x0 + cellW - 2, y0 + 1, qmark | bit);
    stampBottom(host, x0 + 1, y0 + 3, "PP " + String(slot.pp) + "/" + String(maxPp), bit);
    stampBottom(host, x0 + 1, y0 + 5, type, bit);
    let eff = "--";
    if (power > 0 && b.enemy && b.chart) {
      eff = effLabel(b.chart.effectiveness(def.type ?? "", b.enemy.curTypes));
    }
    stampBottom(host, x0 + cellW - 1 - eff.length, y0 + 5, eff, bit);
  }
}
function drawForgetList(host, b) {
  host.uiClearBottom();
  const f = b.forgetView?.();
  if (!f)
    return;
  drawTopBar(host, ("LEARN " + f.learning).slice(0, 18));
  stampBottom(host, 1, 2, (f.name + " FORGETS?").slice(0, 18));
  f.moves.forEach((name, i) => {
    const y = 4 + i * 2;
    stampBottom(host, 2, y, name.slice(0, 14));
    if (i === f.index)
      host.uiTileBottom(0, y, ARROW_CURSOR);
  });
  const cancelY = 4 + f.moves.length * 2;
  stampBottom(host, 2, cancelY, "DON'T LEARN");
  if (f.index >= f.moves.length)
    host.uiTileBottom(0, cancelY, ARROW_CURSOR);
}
var ITEM_ROWS = 12;
function itemListTop(b) {
  return Math.max(0, Math.min(b.itemIndex - (ITEM_ROWS - 1), b.itemList.length - ITEM_ROWS));
}
function drawItemList(host, game, b) {
  host.uiClearBottom();
  drawTopBar(host, "ITEMS");
  const top = itemListTop(b);
  for (let i = top;i < b.itemList.length && i < top + ITEM_ROWS; i++) {
    const id = b.itemList[i];
    const name = game.data.items[id]?.name ?? id;
    const count2 = game.save?.inventory?.[id] ?? 0;
    const y = 2 + (i - top);
    stampBottom(host, 2, y, name.slice(0, 13));
    stampRight(host, y, "x" + String(count2));
    if (i === b.itemIndex)
      host.uiTileBottom(0, y, ARROW_CURSOR);
  }
}
function drawPartyList(host, game, title, cursor) {
  host.uiClearBottom();
  drawTopBar(host, title);
  const party = game.save?.party ?? [];
  const cellW = 10;
  const cellH = 5;
  const colX = [0, 10];
  const rowY = [2, 7, 12];
  for (let i = 0;i < 6; i++) {
    const x0 = colX[i % 2];
    const y0 = rowY[i / 2 | 0];
    if (i >= party.length)
      continue;
    const mon = party[i];
    const full = mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species;
    const name = full.length > 7 ? full.slice(0, 6) + "." : full;
    const maxHp = mon.stats?.hp ?? mon.hp;
    boxBottom(host, x0, y0, cellW, cellH, DARKTEXT_BIT);
    const spritePage = picPageFor(game.data, mon.species);
    if (spritePage >= 0) {
      host.uiSpriteBottom(spritePage, (x0 + 1) * TILE_W, (y0 + 1) * TILE_H, 2 * TILE_W - 2, 2 * TILE_H - 1);
    }
    if (cursor === i)
      host.uiTileBottom(x0, y0, ARROW_CURSOR | DARKTEXT_BIT);
    stampBottom(host, x0 + 3, y0 + 1, name, DARKTEXT_BIT);
    stampBottom(host, x0 + 3, y0 + 2, "L" + String(mon.level), DARKTEXT_BIT);
    tilesBottom(host, x0 + 1, y0 + 3, hpBarTiles(mon.hp, maxHp, true).slice(1));
    if (mon.status)
      stampBottom(host, x0 + 6, y0 + 2, mon.status.slice(0, 3), DARKTEXT_BIT);
  }
}
function drawBattleMessage(host, b) {
  host.uiClearBottom();
  drawTopBar(host, "BATTLE");
  boxBottom(host, 0, 2, COLS, 14, DARKTEXT_BIT);
  const rows = [5, 7];
  b.shown.forEach((line, i) => {
    if (i >= rows.length)
      return;
    const isLast = i === b.shown.length - 1;
    const n = isLast ? line.revealed : line.codes.length;
    for (let c = 0;c < n && c < line.codes.length && 2 + c < COLS - 1; c++) {
      host.uiTileBottom(2 + c, rows[i], line.codes[c] | DARKTEXT_BIT);
    }
  });
  if (b.msgWaiting || b.msgPrompt) {
    for (let x = 2;x < COLS - 2; x++) {
      host.uiTileBottom(x, 11, BORDER_H | DARKTEXT_BIT);
    }
    const tip = "TAP TO CONTINUE";
    const tx = Math.max(2, Math.floor((COLS - tip.length) / 2));
    stampBottom(host, tx, 13, tip, DARKTEXT_BIT);
  }
  if (b.choiceOpen) {
    boxBottom(host, 14, 7, 6, 5, DARKTEXT_BIT);
    stampBottom(host, 16, 8, "YES", DARKTEXT_BIT);
    stampBottom(host, 16, 10, "NO", DARKTEXT_BIT);
    host.uiTileBottom(15, b.choiceYes ? 8 : 10, ARROW_CURSOR | DARKTEXT_BIT);
  }
}
function drawBattleGear(host, game, b) {
  switch (b.phase) {
    case "forget":
      drawForgetList(host, b);
      return;
    case "moveSelect":
      drawMoveSelect(host, game, b);
      return;
    case "party":
      drawPartyList(host, game, "PKMN", b.partyIndex);
      return;
    case "item":
      drawItemList(host, game, b);
      return;
    case "menu":
      drawActionGrid(host, b.menuIndex, true, b.safari ?? null);
      return;
    default:
      drawBattleMessage(host, b);
      return;
  }
}
function gearTabs(game) {
  const tabs = [{ id: "party", label: "PARTY" }];
  if ((game.save?.inventory?.TOWN_MAP ?? 0) > 0 && hasTownMap(game)) {
    tabs.push({ id: "map", label: "MAP" });
  }
  return tabs;
}
function hasTownMap(game) {
  const a = game.data.atlas;
  return typeof a?.townMapPage === "number" && a.townMapPage >= 0;
}
function activeView(game) {
  const want = game.gearView ?? "party";
  return gearTabs(game).some((t) => t.id === want) ? want : "party";
}
function gearViewStep(game, dir) {
  const tabs = gearTabs(game);
  const at2 = Math.max(0, tabs.findIndex((t) => t.id === activeView(game)));
  return tabs[(at2 + dir + tabs.length) % tabs.length].id;
}
var CLOCK_COL = COLS - 8;
function drawGearHeader(host, game, label3) {
  const many = gearTabs(game).length > 1;
  const w = label3.length + (many ? 4 : 0);
  const x = Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  if (many) {
    host.uiTileBottom(x, 0, UI_TILE.arrowLeft | LIGHT_BIT);
    host.uiTileBottom(x + w - 1, 0, ARROW_CURSOR | LIGHT_BIT);
  }
  stampLight(host, x + (many ? 2 : 0), 0, label3);
  const t = clockStr();
  if (t)
    stampLight(host, Math.max(0, COLS - t.length - 1), 0, t);
}
function headerArrowCols(game, label3) {
  if (gearTabs(game).length < 2)
    return null;
  const w = label3.length + 4;
  const x = Math.max(0, Math.floor((CLOCK_COL - w) / 2));
  return { left: x, right: x + w - 1 };
}
function drawBottomBar(host, text) {
  fillCellBottom(host, 0, ROWS - 1, COLS, 1);
  stampFill(host, Math.max(0, Math.floor((COLS - text.length) / 2)), ROWS - 1, text);
}
var MAP_W = 160;
var MAP_H = 144;
var MAP_INSET = 4;
var MAP_AREA_Y = Math.round(TILE_H) + MAP_INSET;
var MAP_AREA_H = Math.round((ROWS - 1) * TILE_H) - MAP_AREA_Y - MAP_INSET;
var MAP_SCALE = Math.min(320 / MAP_W, MAP_AREA_H / MAP_H);
var MAP_DRAW_W = Math.round(MAP_W * MAP_SCALE);
var MAP_DRAW_H = Math.round(MAP_H * MAP_SCALE);
var MAP_X = Math.round((320 - MAP_DRAW_W) / 2);
var MAP_Y = MAP_AREA_Y + Math.round((MAP_AREA_H - MAP_DRAW_H) / 2);
function locPixel(loc) {
  return { x: loc.x * 8 + 16, y: loc.y * 8 + 8 };
}
function mapToScreen(px2, py) {
  return { x: MAP_X + Math.round(px2 * MAP_SCALE), y: MAP_Y + Math.round(py * MAP_SCALE) };
}
function townMapLocations(game) {
  return game.data.field?.townMap?.locations ?? {};
}
function townMapPlaces(game) {
  const bySquare = new Map;
  for (const id of Object.keys(townMapLocations(game)).sort()) {
    const loc = townMapLocations(game)[id];
    const key = `${loc.x},${loc.y}`;
    const held = bySquare.get(key);
    if (!held || held.id.replace(/_/g, " ") !== held.loc.name && id.replace(/_/g, " ") === loc.name) {
      bySquare.set(key, { id, loc });
    }
  }
  return [...bySquare.values()];
}
function focusedLocation(game) {
  const locs = townMapLocations(game);
  const picked = game.gearMapPick;
  if (picked && locs[picked])
    return { id: picked, loc: locs[picked] };
  const ow = game.overworld;
  const here = ow?.mapId ?? ow?.map?.id;
  if (here && locs[here])
    return { id: here, loc: locs[here] };
  return null;
}
function drawTownMapView(host, game) {
  host.uiClearBottom();
  const focus = focusedLocation(game);
  drawGearHeader(host, game, "MAP");
  drawBottomBar(host, focus?.loc.name ?? "TOWN MAP");
  const page = game.data.atlas?.townMapPage;
  if (typeof page !== "number" || page < 0) {
    stampBottom(host, 2, 4, "NO MAP DATA", DARKTEXT_BIT);
    return;
  }
  host.uiSpriteBottom(page, MAP_X, MAP_Y, MAP_DRAW_W, MAP_DRAW_H);
  const cursorPage = game.data.atlas?.townMapCursorPage;
  if (focus && typeof cursorPage === "number" && cursorPage >= 0) {
    const p = locPixel(focus.loc);
    const at2 = mapToScreen(p.x - 4, p.y - 4);
    const size = Math.round(16 * MAP_SCALE);
    host.uiSpriteBottom(cursorPage, at2.x, at2.y, size, size);
  }
}
function drawKantoGear(host, game) {
  const bv = game.battleView?.();
  const b = bv?.battle;
  if (b) {
    drawBattleGear(host, game, b);
    return;
  }
  if (activeView(game) === "map") {
    drawTownMapView(host, game);
    return;
  }
  drawPartyList(host, game, "", -1);
  drawGearHeader(host, game, "PARTY");
}
function gearMapTouch(game, x, y) {
  if (!game.setGearMapPick)
    return;
  const px2 = (x - MAP_X) / MAP_SCALE;
  const py = (y - MAP_Y) / MAP_SCALE;
  if (px2 < 0 || py < 0 || px2 >= MAP_W || py >= MAP_H)
    return;
  let bestId = null;
  let bestD = Infinity;
  for (const { id, loc } of townMapPlaces(game)) {
    const p = locPixel(loc);
    const d = (p.x + 4 - px2) ** 2 + (p.y + 4 - py) ** 2;
    if (d < bestD) {
      bestD = d;
      bestId = id;
    }
  }
  game.setGearMapPick(bestD <= 16 * 16 ? bestId : null);
}
var TAP_A = {
  isDown: () => false,
  wasPressed: (btn) => btn === "a"
};
function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
var armed = false;
function gearTouchDown(game, x, y) {
  armed = false;
  const b = game.battleView?.()?.battle;
  const col = clampInt(Math.floor(x / TILE_W), 0, COLS - 1);
  const row = clampInt(Math.floor(y / TILE_H), 0, ROWS - 1);
  if (!b) {
    const view = activeView(game);
    const arrows = headerArrowCols(game, view === "map" ? "MAP" : "PARTY");
    if (row === 0 && arrows) {
      if (col <= arrows.left) {
        game.setGearView?.(gearViewStep(game, -1));
        return;
      }
      if (col >= arrows.right && col < CLOCK_COL) {
        game.setGearView?.(gearViewStep(game, 1));
        return;
      }
      return;
    }
    if (view === "map")
      gearMapTouch(game, x, y);
    return;
  }
  if (b.choiceOpen) {
    if (col >= 14 && col <= 19 && row >= 7 && row <= 11) {
      b.choiceYes = row < 9;
    }
    armed = true;
    return;
  }
  const cell2x2 = () => (row < 10 ? 0 : 2) + (col < 10 ? 0 : 1);
  switch (b.phase) {
    case "menu": {
      b.menuIndex = cell2x2() + 1;
      armed = true;
      return;
    }
    case "moveSelect": {
      const i = cell2x2();
      if (i >= b.player.curMoves.length)
        return;
      b.moveIndex = i + 1;
      armed = true;
      return;
    }
    case "party": {
      const r = row < 7 ? 0 : row < 12 ? 1 : 2;
      const i = r * 2 + (col < 10 ? 0 : 1);
      if (i >= (game.save?.party?.length ?? 0))
        return;
      b.partyIndex = i;
      armed = true;
      return;
    }
    case "item": {
      const i = row - 2 + itemListTop(b);
      if (row < 2 || i >= b.itemList.length)
        return;
      b.itemIndex = i;
      armed = true;
      return;
    }
    default:
      b.update(TAP_A);
      return;
  }
}
function gearTouchUp(game) {
  if (!armed)
    return;
  armed = false;
  const b = game.battleView?.()?.battle;
  if (!b)
    return;
  b.update(TAP_A);
}

// voxelmon/game/ui/warppicker.ts
var ROWS2 = 8;

class WarpPickerState {
  game;
  onPick;
  kind = "warppicker";
  index = 0;
  top = 0;
  maps;
  constructor(game, here, onPick) {
    this.game = game;
    this.onPick = onPick;
    const data = game.data ?? {};
    const cooked = Array.isArray(data.cookedMaps) ? data.cookedMaps : [];
    const known = data.maps ?? {};
    this.maps = cooked.filter((m) => known[m]).sort();
    const at2 = this.maps.indexOf(here);
    if (at2 >= 0)
      this.index = at2;
    this.clampScroll();
  }
  clampScroll() {
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS2)
      this.top = this.index - ROWS2 + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.maps.length - ROWS2)));
  }
  update() {
    const p = this.game.input.pressed;
    const n = this.maps.length;
    if (n === 0) {
      this.game.pop();
      return;
    }
    if (p.up)
      this.index = (this.index + n - 1) % n;
    else if (p.down)
      this.index = (this.index + 1) % n;
    else if (p.left)
      this.index = Math.max(0, this.index - ROWS2);
    else if (p.right)
      this.index = Math.min(n - 1, this.index + ROWS2);
    else if (p.select)
      this.index = this.nextLetter();
    this.clampScroll();
    if (p.b || p.start) {
      this.game.pop();
      return;
    }
    if (p.a) {
      const pick = this.maps[this.index];
      this.game.pop();
      this.onPick(pick);
    }
  }
  nextLetter() {
    const c = this.maps[this.index][0];
    for (let i = this.index + 1;i < this.maps.length; i++) {
      if (this.maps[i][0] !== c)
        return i;
    }
    return this.maps.length - 1;
  }
  view() {
    return {
      entries: this.maps.slice(this.top, this.top + ROWS2),
      index: this.index - this.top,
      top: this.top,
      total: this.maps.length
    };
  }
}

// voxelmon/game/ui/flypicker.ts
var ROWS3 = 9;

class FlyPickerState {
  game;
  dests;
  onPick;
  onCancel;
  kind = "flypicker";
  index = 0;
  top = 0;
  constructor(game, dests, onPick, onCancel) {
    this.game = game;
    this.dests = dests;
    this.onPick = onPick;
    this.onCancel = onCancel;
  }
  clampScroll() {
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS3)
      this.top = this.index - ROWS3 + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.dests.length - ROWS3)));
  }
  update() {
    const p = this.game.input.pressed;
    const n = this.dests.length;
    if (n === 0) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.up)
      this.index = (this.index + n - 1) % n;
    else if (p.down)
      this.index = (this.index + 1) % n;
    this.clampScroll();
    if (p.b || p.start) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.a) {
      const pick = this.dests[this.index];
      this.game.pop();
      this.onPick(pick);
    }
  }
  view() {
    return {
      entries: this.dests.map((d) => d.name),
      index: this.index,
      top: this.top,
      total: this.dests.length
    };
  }
}

// voxelmon/game/ui/floorpicker.ts
var ROWS4 = 9;

class FloorPickerState {
  game;
  floors;
  onPick;
  onCancel;
  kind = "floorpicker";
  index = 0;
  top = 0;
  constructor(game, floors, onPick, onCancel) {
    this.game = game;
    this.floors = floors;
    this.onPick = onPick;
    this.onCancel = onCancel;
  }
  clampScroll() {
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS4)
      this.top = this.index - ROWS4 + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.floors.length - ROWS4)));
  }
  update() {
    const p = this.game.input.pressed;
    const n = this.floors.length;
    if (n === 0) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.up)
      this.index = (this.index + n - 1) % n;
    else if (p.down)
      this.index = (this.index + 1) % n;
    this.clampScroll();
    if (p.b || p.start) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.a) {
      const pick = this.floors[this.index];
      this.game.pop();
      this.onPick(pick);
    }
  }
  view() {
    return {
      entries: this.floors.map((f) => f.token),
      index: this.index,
      top: this.top,
      total: this.floors.length
    };
  }
}

// voxelmon/game/ui/moveforget.ts
class MoveForgetState {
  game;
  mon;
  onPick;
  cancelLabel;
  kind = "moveforget";
  index = 0;
  constructor(game, mon, onPick, cancelLabel = "DON'T LEARN") {
    this.game = game;
    this.mon = mon;
    this.onPick = onPick;
    this.cancelLabel = cancelLabel;
  }
  update() {
    const p = this.game.input.pressed;
    const rows = this.mon.moves.length + 1;
    if (p.up || p.left)
      this.index = (this.index + rows - 1) % rows;
    else if (p.down || p.right)
      this.index = (this.index + 1) % rows;
    if (p.b) {
      this.game.pop();
      this.onPick(-1);
      return;
    }
    if (p.a) {
      const slot = this.index >= this.mon.moves.length ? -1 : this.index;
      this.game.pop();
      this.onPick(slot);
    }
  }
  view() {
    const names = this.mon.moves.map((mv) => this.game.data.moves?.[mv.id]?.name ?? mv.id);
    return {
      name: this.mon.nickname ?? this.game.data.pokemon?.[this.mon.species]?.name ?? "",
      moves: names,
      index: this.index,
      cancel: this.cancelLabel
    };
  }
}

// voxelmon/game/ui/bagscreen.ts
var ROWS5 = 4;
var USABLE_IN_FIELD = new Set([
  "BICYCLE",
  "POKE_FLUTE",
  "OLD_ROD",
  "GOOD_ROD",
  "SUPER_ROD",
  "REPEL",
  "SUPER_REPEL",
  "MAX_REPEL",
  "ESCAPE_ROPE",
  "COIN_CASE",
  "TOWN_MAP",
  "ITEMFINDER"
]);

class BagState {
  game;
  kind = "bag";
  index = 0;
  top = 0;
  mode = "list";
  submenuIndex = 0;
  qty = 1;
  constructor(game) {
    this.game = game;
  }
  ids() {
    return order(this.game.save);
  }
  selected() {
    return this.ids()[this.index];
  }
  line(key, fallback) {
    return (this.game.data?.text ?? {})[key] ?? fallback;
  }
  itemName(id) {
    return this.game.data.items?.[id]?.name ?? id;
  }
  toss(id, qty) {
    if (precious(this.game.data, id)) {
      this.mode = "list";
      this.game.showText(this.line("_TooImportantToTossText", `That's too impor-
tant to toss!`));
      return;
    }
    const ask2 = this.line("_IsItOKToTossItemText", `Is it OK to toss
{RAM:wStringBuffer}?`).replace(/\{RAM:\w+\}/g, this.itemName(id));
    this.game.showChoice(ask2, (yes) => {
      this.mode = "list";
      if (!yes)
        return;
      remove(this.game.save, id, qty);
      const n = this.ids().length;
      if (this.index > n)
        this.index = n;
      if (this.top > this.index)
        this.top = this.index;
    });
  }
  updateSubmenu(p) {
    const id = this.selected();
    if (!id) {
      this.mode = "list";
      return;
    }
    if (p.up)
      this.submenuIndex = 0;
    if (p.down)
      this.submenuIndex = 1;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a)
      return;
    if (this.submenuIndex === 1) {
      const have = this.game.save.inventory?.[id] ?? 0;
      if (precious(this.game.data, id) || have <= 1) {
        this.toss(id, 1);
      } else {
        this.qty = 1;
        this.mode = "quantity";
      }
      return;
    }
    this.mode = "list";
    this.use(id);
  }
  updateQuantity(p) {
    const id = this.selected();
    if (!id) {
      this.mode = "list";
      return;
    }
    const have = this.game.save.inventory?.[id] ?? 1;
    if (p.up)
      this.qty = Math.min(have, this.qty + 1);
    if (p.down)
      this.qty = Math.max(1, this.qty - 1);
    if (p.right)
      this.qty = Math.min(have, this.qty + 10);
    if (p.left)
      this.qty = Math.max(1, this.qty - 10);
    if (p.b) {
      this.mode = "submenu";
      return;
    }
    if (p.a)
      this.toss(id, this.qty);
  }
  use(id) {
    const teach = !!this.game.data.items?.[id]?.machine?.move;
    if (USABLE_IN_FIELD.has(id) || BATTLE_ONLY.has(id)) {
      this.game.closeToOverworld();
      this.game.useKeyItem(id);
      return;
    }
    if (teach || needsTarget(this.game.data, id)) {
      this.game.push(new PartyState(this.game, {
        onPick: (i) => teach ? this.game.teachMachine(i, id) : this.game.useItem(i, id)
      }));
    }
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "submenu")
      return this.updateSubmenu(p);
    if (this.mode === "quantity")
      return this.updateQuantity(p);
    const n = this.ids().length + 1;
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS5)
      this.top = this.index - ROWS5 + 1;
    if (p.b || p.a && this.index === n - 1) {
      this.game.pop();
      return;
    }
    if (p.a && this.index < this.ids().length) {
      this.mode = "submenu";
      this.submenuIndex = 0;
    }
  }
  view() {
    const save = this.game.save;
    const items = this.ids().map((id) => ({
      name: this.game.data.items?.[id]?.name ?? id,
      qty: save.inventory?.[id] ?? 0
    }));
    return {
      entries: items,
      index: this.index,
      top: this.top,
      rows: ROWS5,
      mode: this.mode,
      submenuIndex: this.submenuIndex,
      qty: this.qty
    };
  }
}

// voxelmon/game/ui/shopscreen.ts
var ROWS6 = 4;
var MONEY_CAP = 999999;
var GREET = "Take your time.";
var NOT_ENOUGH = `You don't have
enough money.`;
var BAG_FULL = `You can't carry
any more items.`;
var UNSELLABLE = `I can't put a
price on that.`;
var BOUGHT = `Here you are!
Thank you!`;
var POPPED = (name) => `${name}
popped out!`;
var SOLD = "Thank you!";

class ShopState {
  game;
  stock;
  onQuit;
  vending;
  kind = "shop";
  mode = "menu";
  menuIndex = 0;
  buying = true;
  list = [];
  listIndex = 0;
  listTop = 0;
  selId = "";
  selName = "";
  unitPrice = 0;
  maxQty = 1;
  qty = 1;
  confirmYes = true;
  footer = null;
  constructor(game, stock, onQuit, vending = false) {
    this.game = game;
    this.stock = stock;
    this.onQuit = onQuit;
    this.vending = vending;
    if (vending) {
      this.buying = true;
      this.buildBuyList();
      this.mode = "list";
      this.footer = null;
    }
  }
  get greeting() {
    return this.vending ? null : GREET;
  }
  name(id) {
    return this.game.data.items?.[id]?.name ?? id;
  }
  price(id) {
    return this.game.data.items?.[id]?.price ?? 0;
  }
  quit() {
    this.game.pop();
    this.onQuit?.();
  }
  buildBuyList() {
    this.list = this.stock.filter((id) => this.game.data.items?.[id]).map((id) => ({ id, label: this.name(id), right: `¥${this.price(id)}` }));
    this.listIndex = 0;
    this.listTop = 0;
    this.footer = this.greeting;
  }
  buildSellList() {
    this.list = order(this.game.save).map((id) => ({
      id,
      label: this.name(id),
      right: `x${this.game.save.inventory?.[id] ?? 0}`
    }));
    this.listIndex = 0;
    this.listTop = 0;
    this.footer = this.greeting;
  }
  clampWindow() {
    if (this.listIndex < this.listTop)
      this.listTop = this.listIndex;
    if (this.listIndex >= this.listTop + ROWS6)
      this.listTop = this.listIndex - ROWS6 + 1;
  }
  unsellable(id) {
    return precious(this.game.data, id);
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "menu") {
      if (p.up)
        this.menuIndex = (this.menuIndex + 2) % 3;
      if (p.down)
        this.menuIndex = (this.menuIndex + 1) % 3;
      if (p.b) {
        this.quit();
        return;
      }
      if (p.a) {
        if (this.menuIndex === 0) {
          this.buying = true;
          this.buildBuyList();
          this.mode = "list";
        } else if (this.menuIndex === 1) {
          this.buying = false;
          this.buildSellList();
          this.mode = "list";
        } else
          this.quit();
      }
      return;
    }
    if (this.mode === "list") {
      const n = this.list.length + 1;
      if (p.up)
        this.listIndex = (this.listIndex + n - 1) % n;
      if (p.down)
        this.listIndex = (this.listIndex + 1) % n;
      this.clampWindow();
      if (p.b || p.a && this.listIndex === this.list.length) {
        if (this.vending) {
          this.quit();
          return;
        }
        this.mode = "menu";
        this.footer = null;
        return;
      }
      if (p.a && this.listIndex < this.list.length)
        this.chooseItem(this.list[this.listIndex]);
      return;
    }
    if (this.mode === "quantity") {
      if (p.up)
        this.qty = Math.min(this.maxQty, this.qty + 1);
      if (p.down)
        this.qty = Math.max(1, this.qty - 1);
      if (p.right)
        this.qty = Math.min(this.maxQty, this.qty + 10);
      if (p.left)
        this.qty = Math.max(1, this.qty - 10);
      if (p.b) {
        this.mode = "list";
        this.footer = this.greeting;
        return;
      }
      if (p.a) {
        const total = this.unitPrice * this.qty;
        this.footer = this.buying ? `${this.selName}?
That will be
¥${total}. OK?` : `I can pay you
¥${total} for that.`;
        this.confirmYes = true;
        this.mode = "confirm";
      }
      return;
    }
    if (this.mode === "confirm") {
      if (p.up || p.down)
        this.confirmYes = !this.confirmYes;
      if (p.b) {
        this.mode = "list";
        this.footer = this.greeting;
        return;
      }
      if (p.a) {
        if (this.confirmYes)
          this.commit();
        else {
          this.mode = "list";
          this.footer = this.greeting;
        }
      }
      return;
    }
  }
  chooseItem(row) {
    const save = this.game.save;
    if (this.buying) {
      const price = this.price(row.id);
      if ((save.money ?? 0) < price) {
        this.footer = NOT_ENOUGH;
        return;
      }
      this.selId = row.id;
      this.selName = row.label;
      this.unitPrice = price;
      this.maxQty = Math.min(99, Math.floor((save.money ?? 0) / Math.max(1, price)));
      this.qty = 1;
      this.mode = "quantity";
      if (this.vending) {
        this.maxQty = 1;
        this.footer = `${this.selName}?
That will be
¥${price}. OK?`;
        this.confirmYes = true;
        this.mode = "confirm";
      }
    } else {
      if (this.unsellable(row.id)) {
        this.footer = UNSELLABLE;
        return;
      }
      this.selId = row.id;
      this.selName = row.label;
      this.unitPrice = Math.floor(this.price(row.id) / 2);
      this.maxQty = save.inventory?.[row.id] ?? 1;
      this.qty = 1;
      this.mode = "quantity";
    }
  }
  commit() {
    const save = this.game.save;
    const total = this.unitPrice * this.qty;
    if (this.buying) {
      if ((save.money ?? 0) < total) {
        this.footer = NOT_ENOUGH;
        this.mode = "list";
        return;
      }
      if (!add(save, this.selId, this.qty, this.game.data)) {
        this.footer = BAG_FULL;
        this.mode = "list";
        return;
      }
      save.money = (save.money ?? 0) - total;
      this.footer = this.vending ? POPPED(this.selName) : BOUGHT;
    } else {
      save.money = Math.min(MONEY_CAP, (save.money ?? 0) + total);
      remove(save, this.selId, this.qty);
      this.buildSellList();
      this.footer = SOLD;
    }
    this.mode = "list";
  }
  view() {
    return {
      mode: this.mode,
      money: this.game.save.money ?? 0,
      menuIndex: this.menuIndex,
      buying: this.buying,
      list: this.list,
      listIndex: this.listIndex,
      listTop: this.listTop,
      rows: ROWS6,
      selName: this.selName,
      qty: this.qty,
      total: this.unitPrice * this.qty,
      confirmYes: this.confirmYes,
      footer: this.footer
    };
  }
}

// voxelmon/game/world/fishing.ts
var OLD_ROD_CATCH = { species: "MAGIKARP", level: 5 };
var GOOD_ROD_POOL = [
  { species: "GOLDEEN", level: 10 },
  { species: "POLIWAG", level: 10 }
];
function isRod(id) {
  return id === "OLD_ROD" || id === "GOOD_ROD" || id === "SUPER_ROD";
}
function rodPool(data, rod, mapId) {
  if (rod === "GOOD_ROD")
    return GOOD_ROD_POOL;
  if (rod === "SUPER_ROD") {
    const groups = data?.field?.superRod;
    return groups?.[mapId] ?? [];
  }
  return [];
}
function rollFishingGroup(group, rand) {
  if (group.length === 0)
    return null;
  for (let guard = 0;guard < 64; guard++) {
    const r = rand() & 255;
    if (r % 2 === 1)
      return null;
    const pick = Math.floor(r / 2) % 4;
    if (pick < group.length)
      return { ...group[pick] };
  }
  return null;
}
function fishingCatch(data, rod, mapId, rand) {
  if (rod === "OLD_ROD")
    return { ...OLD_ROD_CATCH };
  return rollFishingGroup(rodPool(data, rod, mapId), rand);
}

// voxelmon/game/ui/boxscreen.ts
var ROWS7 = 4;
var PARTY_MAX2 = 6;
var MENU = ["WITHDRAW", "DEPOSIT", "RELEASE", "CHANGE BOX", "SEE YA!"];

class BoxState {
  game;
  onQuit;
  kind = "box";
  mode = "menu";
  menuIndex = 0;
  kindOfList = "withdraw";
  list = [];
  listIndex = 0;
  listTop = 0;
  submenuIndex = 0;
  confirmYes = false;
  confirmKind = "release";
  pendingBox = 1;
  footer = null;
  returnMode = "menu";
  constructor(game, onQuit) {
    this.game = game;
    this.onQuit = onQuit;
    ensure(game.save);
  }
  monName(mon) {
    return mon.nickname ?? this.game.data.pokemon?.[mon.species]?.name ?? mon.species;
  }
  monLabel(mon) {
    return `${this.monName(mon)} <LV>${mon.level}`;
  }
  cry(mon) {
    this.game.playCry?.(mon.species);
  }
  quit() {
    this.game.pop();
    this.onQuit?.();
  }
  box() {
    return active(this.game.save);
  }
  party() {
    return this.game.save.party ?? [];
  }
  toMessage(text, ret) {
    this.footer = text;
    this.returnMode = ret;
    this.mode = "message";
  }
  openList(kind) {
    this.kindOfList = kind;
    this.listIndex = 0;
    this.listTop = 0;
    if (kind === "changebox") {
      const boxes = ensure(this.game.save);
      this.list = boxes.map((b, i) => ({
        label: `${i + 1 === this.game.save.currentBox ? "*" : " "}BOX ${i + 1}`,
        right: `${b.length}/${BOX_CAPACITY}`
      }));
    } else if (kind === "deposit") {
      this.list = this.party().map((m) => ({ label: this.monLabel(m), right: "" }));
    } else {
      this.list = this.box().map((m) => ({ label: this.monLabel(m), right: "" }));
    }
    this.mode = "list";
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "menu")
      return this.updateMenu(p);
    if (this.mode === "list")
      return this.updateList(p);
    if (this.mode === "submenu")
      return this.updateSubmenu(p);
    if (this.mode === "confirm")
      return this.updateConfirm(p);
    if (this.mode === "message") {
      if (p.a || p.b) {
        if (this.returnMode === "release-list")
          this.rebuildAfterRelease();
        else
          this.mode = this.returnMode;
      }
      return;
    }
  }
  updateMenu(p) {
    const n = MENU.length;
    if (p.up)
      this.menuIndex = (this.menuIndex + n - 1) % n;
    if (p.down)
      this.menuIndex = (this.menuIndex + 1) % n;
    if (p.b) {
      this.quit();
      return;
    }
    if (!p.a)
      return;
    switch (this.menuIndex) {
      case 0:
        if (this.box().length === 0)
          return this.toMessage(`What? There are
no POKéMON here!`, "menu");
        if (this.party().length >= PARTY_MAX2) {
          return this.toMessage(`You can't take
any more POKéMON.`, "menu");
        }
        return this.openList("withdraw");
      case 1:
        if (this.party().length <= 1)
          return this.toMessage(`You can't deposit
the last POKéMON!`, "menu");
        if (this.box().length >= BOX_CAPACITY) {
          return this.toMessage(`Oops! This Box is
full of POKéMON.`, "menu");
        }
        return this.openList("deposit");
      case 2:
        if (this.box().length === 0)
          return this.toMessage(`What? There are
no POKéMON here!`, "menu");
        return this.openList("release");
      case 3:
        return this.openList("changebox");
      default:
        return this.quit();
    }
  }
  clampWindow() {
    if (this.listIndex < this.listTop)
      this.listTop = this.listIndex;
    if (this.listIndex >= this.listTop + ROWS7)
      this.listTop = this.listIndex - ROWS7 + 1;
  }
  updateList(p) {
    const n = this.list.length + 1;
    if (p.up)
      this.listIndex = (this.listIndex + n - 1) % n;
    if (p.down)
      this.listIndex = (this.listIndex + 1) % n;
    this.clampWindow();
    if (p.b || p.a && this.listIndex === this.list.length) {
      this.mode = "menu";
      return;
    }
    if (!(p.a && this.listIndex < this.list.length))
      return;
    if (this.kindOfList === "changebox") {
      this.pendingBox = this.listIndex + 1;
      this.confirmKind = "changebox";
      this.confirmYes = false;
      this.footer = `When you change a
POKéMON BOX, data
will be saved. OK?`;
      this.mode = "confirm";
      return;
    }
    if (this.kindOfList === "release") {
      this.confirmKind = "release";
      this.confirmYes = false;
      const mon = this.box()[this.listIndex];
      this.footer = `Once released,
${this.monName(mon)} is
gone forever. OK?`;
      this.mode = "confirm";
      return;
    }
    this.submenuIndex = 0;
    this.mode = "submenu";
  }
  updateSubmenu(p) {
    if (p.up)
      this.submenuIndex = (this.submenuIndex + 2) % 3;
    if (p.down)
      this.submenuIndex = (this.submenuIndex + 1) % 3;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a)
      return;
    if (this.submenuIndex === 0)
      return this.doTransfer();
    if (this.submenuIndex === 1) {
      const mon = this.kindOfList === "deposit" ? this.party()[this.listIndex] : this.box()[this.listIndex];
      if (mon)
        this.game.push(new SummaryState(this.game, -1, mon));
      return;
    }
    this.mode = "list";
  }
  doTransfer() {
    if (this.kindOfList === "withdraw") {
      const box = this.box();
      const mon = box[this.listIndex];
      if (!mon) {
        this.mode = "list";
        return;
      }
      if (this.party().length >= PARTY_MAX2)
        return this.toMessage("The party is full!", "list");
      box.splice(this.listIndex, 1);
      this.party().push(mon);
      this.cry(mon);
      this.toMessage(`${this.monName(mon)} is
taken out.`, "menu");
    } else {
      const mon = this.party()[this.listIndex];
      if (!mon) {
        this.mode = "list";
        return;
      }
      if (this.party().length <= 1)
        return this.toMessage(`You need at least
one POKéMON!`, "list");
      const box = this.box();
      if (box.length >= BOX_CAPACITY) {
        return this.toMessage(`BOX ${this.game.save.currentBox} is full!`, "list");
      }
      this.party().splice(this.listIndex, 1);
      box.push(mon);
      this.cry(mon);
      this.toMessage(`${this.monName(mon)} was
stored in Box ${this.game.save.currentBox}.`, "menu");
    }
  }
  updateConfirm(p) {
    if (p.up || p.down)
      this.confirmYes = !this.confirmYes;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a)
      return;
    if (!this.confirmYes) {
      this.mode = "list";
      return;
    }
    if (this.confirmKind === "changebox") {
      this.game.save.currentBox = this.pendingBox;
      this.game.writeSave?.();
      this.mode = "menu";
      return;
    }
    const box = this.box();
    const mon = box[this.listIndex];
    if (!mon) {
      this.mode = "list";
      return;
    }
    box.splice(this.listIndex, 1);
    this.cry(mon);
    this.toMessage(`${this.monName(mon)} was
released outside.
Bye ${this.monName(mon)}!`, "release-list");
  }
  rebuildAfterRelease() {
    if (this.box().length === 0) {
      this.mode = "menu";
      return;
    }
    this.openList("release");
    this.listIndex = Math.max(0, Math.min(this.listIndex, this.list.length - 1));
    this.clampWindow();
  }
  view() {
    return {
      mode: this.mode,
      currentBox: this.game.save.currentBox ?? 1,
      menuIndex: this.menuIndex,
      list: this.list,
      listIndex: this.listIndex,
      listTop: this.listTop,
      rows: ROWS7,
      submenuLabel: this.kindOfList === "deposit" ? "DEPOSIT" : "WITHDRAW",
      submenuIndex: this.submenuIndex,
      confirmYes: this.confirmYes,
      footer: this.footer
    };
  }
}

// voxelmon/game/world/pcitems.ts
var PC_ITEM_CAPACITY = 50;
function pcBag(save) {
  return save.pc ??= { inventory: {}, bagOrder: [] };
}
function pcCapacityData(data) {
  const cap = data?.field?.pcItemCap;
  return {
    constants: {
      ...data?.constants ?? {},
      bagSize: typeof cap === "number" && cap >= 1 ? cap : PC_ITEM_CAPACITY
    }
  };
}
function pcOrder(save) {
  return order(pcBag(save));
}
function deposit2(save, id, qty, data) {
  const have = save.inventory?.[id] ?? 0;
  const n = Math.min(qty, have);
  if (n <= 0)
    return false;
  if (!add(pcBag(save), id, n, pcCapacityData(data)))
    return false;
  remove(save, id, n);
  return true;
}
function withdraw(save, id, qty, data) {
  const box = pcBag(save);
  const have = box.inventory?.[id] ?? 0;
  const n = Math.min(qty, have);
  if (n <= 0)
    return false;
  if (!add(save, id, n, data))
    return false;
  remove(box, id, n);
  return true;
}
function tossFromPc(save, id, qty) {
  remove(pcBag(save), id, qty);
}

// voxelmon/game/ui/pcscreen.ts
var ROWS8 = 4;
var ROOT = ["SOMEONE'S PC", "MY PC", "LOG OFF"];
var ITEMS = ["WITHDRAW ITEM", "DEPOSIT ITEM", "TOSS ITEM", "LOG OFF"];

class PcState {
  game;
  onDone;
  kind = "pc";
  mode = "root";
  index = 0;
  top = 0;
  menuIndex = 0;
  itemsIndex = 0;
  qty = 1;
  action = "withdraw";
  constructor(game, onDone) {
    this.game = game;
    this.onDone = onDone;
  }
  line(key, fallback) {
    return (this.game.data?.text ?? {})[key] ?? fallback;
  }
  name(id) {
    return this.game.data.items?.[id]?.name ?? id;
  }
  ids() {
    if (this.action === "deposit")
      return order(this.game.save);
    return pcOrder(this.game.save);
  }
  held(id) {
    const inv = this.action === "deposit" ? this.game.save.inventory : pcBag(this.game.save).inventory;
    return inv?.[id] ?? 0;
  }
  close() {
    this.game.pop();
    this.onDone?.();
  }
  startAction(a) {
    this.action = a;
    const empty = this.ids().length === 0;
    if (empty) {
      this.game.showText(a === "deposit" ? this.line("_NothingToDepositText", `You have nothing
to deposit.`) : this.line("_NothingStoredText", `There is nothing
stored.`));
      return;
    }
    this.game.showText(a === "deposit" ? this.line("_WhatToDepositText", `What do you want
to deposit?`) : a === "withdraw" ? this.line("_WhatToWithdrawText", `What do you want
to withdraw?`) : this.line("_WhatToTossText", `What do you want
to toss away?`));
    this.index = 0;
    this.top = 0;
    this.mode = "list";
  }
  commit(id, n) {
    const save = this.game.save;
    if (this.action === "deposit") {
      if (!deposit2(save, id, n, this.game.data)) {
        this.game.showText(this.line("_NoRoomToStoreText", `No room left to
store items.`));
      }
    } else if (this.action === "withdraw") {
      if (!withdraw(save, id, n, this.game.data)) {
        this.game.showText(this.line("_CantCarryMoreText", `You can't carry
any more items.`));
      } else {
        this.game.showText(this.line("_WithdrewItemText", `Withdrew
{RAM:wNameBuffer}.`).replace(/\{RAM:\w+\}/g, this.name(id)));
      }
    } else {
      if (precious(this.game.data, id)) {
        this.game.showText(this.line("_TooImportantToTossText", `That's too impor-
tant to toss!`));
      } else {
        tossFromPc(save, id, n);
      }
    }
    const len = this.ids().length;
    if (this.index > len)
      this.index = Math.max(0, len);
    if (this.top > this.index)
      this.top = this.index;
    this.mode = this.ids().length === 0 ? "items" : "list";
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "root")
      return this.updateRoot(p);
    if (this.mode === "items")
      return this.updateItems(p);
    if (this.mode === "quantity")
      return this.updateQuantity(p);
    return this.updateList(p);
  }
  updateRoot(p) {
    const n = ROOT.length;
    if (p.up)
      this.menuIndex = (this.menuIndex + n - 1) % n;
    if (p.down)
      this.menuIndex = (this.menuIndex + 1) % n;
    if (p.b) {
      this.close();
      return;
    }
    if (!p.a)
      return;
    if (this.menuIndex === 0) {
      this.game.showText(this.line("_AccessedSomeonesPCText", `Accessed someone's
PC.`), () => this.game.openBox());
      return;
    }
    if (this.menuIndex === 1) {
      this.game.showText(this.line("_AccessedMyPCText", "Accessed my PC."));
      this.itemsIndex = 0;
      this.mode = "items";
      return;
    }
    this.close();
  }
  updateItems(p) {
    const n = ITEMS.length;
    if (p.up)
      this.itemsIndex = (this.itemsIndex + n - 1) % n;
    if (p.down)
      this.itemsIndex = (this.itemsIndex + 1) % n;
    if (p.b) {
      this.mode = "root";
      return;
    }
    if (!p.a)
      return;
    if (this.itemsIndex === 0)
      this.startAction("withdraw");
    else if (this.itemsIndex === 1)
      this.startAction("deposit");
    else if (this.itemsIndex === 2)
      this.startAction("toss");
    else
      this.mode = "root";
  }
  updateList(p) {
    const ids = this.ids();
    const n = ids.length + 1;
    if (p.up)
      this.index = (this.index + n - 1) % n;
    if (p.down)
      this.index = (this.index + 1) % n;
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS8)
      this.top = this.index - ROWS8 + 1;
    if (p.b || p.a && this.index === n - 1) {
      this.mode = "items";
      return;
    }
    if (!p.a)
      return;
    const id = ids[this.index];
    if (!id)
      return;
    if (this.held(id) <= 1 || precious(this.game.data, id))
      this.commit(id, 1);
    else {
      this.qty = 1;
      this.mode = "quantity";
    }
  }
  updateQuantity(p) {
    const id = this.ids()[this.index];
    if (!id) {
      this.mode = "list";
      return;
    }
    const have = this.held(id);
    if (p.up)
      this.qty = Math.min(have, this.qty + 1);
    if (p.down)
      this.qty = Math.max(1, this.qty - 1);
    if (p.right)
      this.qty = Math.min(have, this.qty + 10);
    if (p.left)
      this.qty = Math.max(1, this.qty - 10);
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (p.a)
      this.commit(id, this.qty);
  }
  view() {
    const ids = this.mode === "root" || this.mode === "items" ? [] : this.ids();
    return {
      mode: this.mode,
      entries: ids.map((id) => ({ name: this.name(id), qty: this.held(id) })),
      index: this.index,
      top: this.top,
      rows: ROWS8,
      labels: this.mode === "root" ? ROOT : this.mode === "items" ? ITEMS : [],
      qty: this.qty,
      action: this.action.toUpperCase()
    };
  }
  menuCursor() {
    return this.mode === "root" ? this.menuIndex : this.itemsIndex;
  }
}

// voxelmon/game/ui/pokedexscreen.ts
var ROWS9 = 7;
class PokedexState {
  game;
  onCancel;
  kind = "pokedex";
  mode = "list";
  index = 0;
  top = 0;
  submenuIndex = 0;
  entrySpecies = null;
  entries = [];
  seen = 0;
  owned = 0;
  digits;
  static SUBMENU = ["DATA", "CRY", "QUIT"];
  standalone = false;
  constructor(game, onCancel, opts) {
    this.game = game;
    this.onCancel = onCancel;
    const data = game.data;
    const dex = game.save?.pokedex ?? { seen: {}, owned: {} };
    const constants = data.constants ?? {};
    this.digits = constants.dexDigits ?? 3;
    const size = constants.dexSize ?? 151;
    const byDex = {};
    const mons = data.pokemon;
    for (const id in mons) {
      const def = mons[id];
      if (def?.dex)
        byDex[def.dex] = def;
    }
    for (let n = 1;n <= size; n++) {
      const def = byDex[n];
      if (!def)
        continue;
      const isOwned = !!dex.owned?.[def.id];
      const isSeen = isOwned || !!dex.seen?.[def.id];
      if (isOwned)
        this.owned += 1;
      if (isSeen)
        this.seen += 1;
      const num = String(n).padStart(this.digits, "0");
      this.entries.push({
        n,
        label: isSeen ? `${num} ${def.name}` : `${num} -----`,
        owned: isOwned,
        value: isSeen ? def.id : null
      });
    }
    if (opts?.species && mons[opts.species]) {
      this.standalone = true;
      this.mode = "entry";
      this.entrySpecies = opts.species;
      const at2 = this.entries.findIndex((e) => e.value === opts.species);
      if (at2 >= 0)
        this.index = at2;
    }
  }
  update() {
    const p = this.game.input.pressed;
    if (this.mode === "entry") {
      if (p.a || p.b) {
        if (this.standalone) {
          this.game.pop();
          this.onCancel?.();
        } else {
          this.mode = "submenu";
        }
      }
      return;
    }
    if (this.mode === "submenu")
      return this.updateSubmenu(p);
    this.updateList(p);
  }
  updateList(p) {
    const n = this.entries.length;
    if (n === 0) {
      if (p.a || p.b)
        this.close();
      return;
    }
    if (p.up)
      this.index = Math.max(0, this.index - 1);
    else if (p.down)
      this.index = Math.min(n - 1, this.index + 1);
    else if (p.left)
      this.index = Math.max(0, this.index - ROWS9);
    else if (p.right)
      this.index = Math.min(n - 1, this.index + ROWS9);
    this.syncScroll();
    if (p.b) {
      this.close();
      return;
    }
    if (p.a) {
      if (this.entries[this.index]?.value) {
        this.submenuIndex = 0;
        this.mode = "submenu";
      }
    }
  }
  updateSubmenu(p) {
    const items = PokedexState.SUBMENU;
    if (p.up)
      this.submenuIndex = (this.submenuIndex + items.length - 1) % items.length;
    if (p.down)
      this.submenuIndex = (this.submenuIndex + 1) % items.length;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a)
      return;
    const value = this.entries[this.index]?.value;
    if (!value) {
      this.mode = "list";
      return;
    }
    switch (items[this.submenuIndex]) {
      case "DATA":
        this.entrySpecies = value;
        this.mode = "entry";
        break;
      case "CRY":
        this.game.playCry?.(value);
        break;
      case "QUIT":
        this.close();
        break;
    }
  }
  close() {
    this.game.pop();
    if (this.onCancel)
      this.onCancel();
  }
  syncScroll() {
    if (this.index < this.top)
      this.top = this.index;
    if (this.index >= this.top + ROWS9)
      this.top = this.index - ROWS9 + 1;
  }
  buildEntry() {
    const id = this.entrySpecies;
    if (!id)
      return null;
    const def = this.game.data.pokemon[id];
    if (!def)
      return null;
    const e = def.dexEntry ?? {};
    const owned = !!this.game.save?.pokedex?.owned?.[id];
    const num = String(def.dex ?? 0).padStart(this.digits, "0");
    let height = null;
    let weight = null;
    if (owned && e.heightFt !== undefined) {
      height = `HT ${e.heightFt}'${String(e.heightIn ?? 0).padStart(2, "0")}"`;
      weight = `WT ${((e.weight ?? 0) / 10).toFixed(1)}lb`;
    }
    let lines = ["Data unknown."];
    const textStore = this.game.data.text;
    const raw = owned && e.text ? textStore?.[e.text] ?? e.text : null;
    if (raw) {
      lines = String(raw).replace(/[\f\v]/g, `
`).split(`
`).filter((l) => l.length > 0);
    }
    return {
      name: def.name,
      no: `No.${num}`,
      kind: e.kind ?? "?",
      owned,
      height,
      weight,
      lines,
      spritePage: picPageFor(this.game.data, id)
    };
  }
  view() {
    return {
      mode: this.mode,
      rows: ROWS9,
      top: this.top,
      index: this.index,
      entries: this.entries,
      footer: `SEEN ${String(this.seen).padStart(3)}  OWN ${String(this.owned).padStart(3)}`,
      submenuIndex: this.submenuIndex,
      submenu: PokedexState.SUBMENU,
      entry: this.mode === "entry" ? this.buildEntry() : null
    };
  }
}

// voxelmon/game/save-lua.ts
function quote(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"')
      out += "\\\"";
    else if (ch === "\\")
      out += "\\\\";
    else if (ch === `
`)
      out += "\\\n";
    else if (ch === "\r")
      out += "\\r";
    else if (c < 32 || c === 127)
      out += "\\" + String(c);
    else
      out += ch;
  }
  return out + '"';
}
var BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function sortKeys(keys) {
  return keys.slice().sort((a, b) => {
    const ta = typeof a === "number" ? "number" : "string";
    const tb = typeof b === "number" ? "number" : "string";
    if (ta !== tb)
      return ta < tb ? -1 : 1;
    if (ta === "number")
      return a - b;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function serialize(v, indent = 0) {
  const pad = "  ".repeat(indent);
  if (typeof v === "number" || typeof v === "boolean")
    return String(v);
  if (typeof v === "string")
    return quote(v);
  if (v === null || v === undefined)
    return "nil";
  let entries;
  if (Array.isArray(v)) {
    entries = v.map((x, i) => [i + 1, x]);
  } else if (typeof v === "object") {
    entries = Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [/^\d+$/.test(k) ? Number(k) : k, x]);
  } else {
    throw new Error("cannot serialize " + typeof v);
  }
  if (entries.length === 0)
    return "{}";
  const byKey = new Map(entries);
  const parts = [];
  for (const k of sortKeys(entries.map((e) => e[0]))) {
    const key = typeof k === "string" && BARE.test(k) ? k : "[" + serialize(k) + "]";
    parts.push(pad + "  " + key + " = " + serialize(byKey.get(k), indent + 1));
  }
  return `{
` + parts.join(`,
`) + `,
` + pad + "}";
}
function encodeSave(data) {
  return "return " + serialize(data) + `
`;
}

// voxelmon/game/save-read.ts
class P {
  src;
  pos = 0;
  constructor(src) {
    this.src = src;
  }
  skip() {
    while (this.pos < this.src.length && ` 	\r
`.includes(this.src[this.pos]))
      this.pos++;
  }
  eat(ch) {
    this.skip();
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }
  expect(ch) {
    if (!this.eat(ch))
      throw new Error(`expected ${ch} at ${this.pos}`);
  }
}
function parseString(p) {
  p.expect('"');
  let out = "";
  while (p.pos < p.src.length) {
    const c = p.src[p.pos++];
    if (c === '"')
      return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = p.src[p.pos++];
    if (e === "n")
      out += `
`;
    else if (e === "r")
      out += "\r";
    else if (e === "t")
      out += "\t";
    else if (e === `
`)
      out += `
`;
    else if (e >= "0" && e <= "9") {
      let digits = e;
      while (digits.length < 3 && /[0-9]/.test(p.src[p.pos] ?? ""))
        digits += p.src[p.pos++];
      out += String.fromCharCode(Number(digits));
    } else
      out += e;
  }
  throw new Error("unterminated string");
}
function parseValue(p, depth = 0) {
  if (depth > 128)
    throw new Error("too deep");
  p.skip();
  const c = p.src[p.pos];
  if (c === '"')
    return parseString(p);
  if (c === "{")
    return parseTable(p, depth);
  const m = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|nil)/i.exec(p.src.slice(p.pos));
  if (!m)
    throw new Error(`bad value at ${p.pos}`);
  p.pos += m[0].length;
  if (m[0] === "true")
    return true;
  if (m[0] === "false")
    return false;
  if (m[0] === "nil")
    return;
  return Number(m[0]);
}
function parseTable(p, depth) {
  p.expect("{");
  const out = {};
  const arr = [];
  let isArray = true;
  for (;; ) {
    p.skip();
    if (p.eat("}"))
      break;
    let key;
    if (p.eat("[")) {
      const k = parseValue(p, depth + 1);
      p.expect("]");
      key = k;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(p.src.slice(p.pos));
      if (!m)
        throw new Error(`bad key at ${p.pos}`);
      p.pos += m[0].length;
      key = m[0];
    }
    p.expect("=");
    const v = parseValue(p, depth + 1);
    if (typeof key === "number")
      arr[key - 1] = v;
    else {
      isArray = false;
      out[key] = v;
    }
    p.eat(",");
  }
  if (isArray && arr.length > 0)
    return arr;
  return out;
}
var ARRAY_FIELDS = [
  ["party"],
  ["party", "*", "moves"],
  ["bagOrder"],
  ["pc", "bagOrder"],
  ["pcItems", "bagOrder"],
  ["box"],
  ["boxes"],
  ["boxes", "*"],
  ["boxes", "*", "*", "moves"]
];
function atPath(root, path) {
  let level = [];
  let containers = [root];
  for (let i = 0;i < path.length; i++) {
    const key = path[i];
    const next = [];
    level = [];
    for (const c of containers) {
      if (!c || typeof c !== "object")
        continue;
      const obj = c;
      if (key === "*") {
        for (const k of Object.keys(obj)) {
          level.push({ owner: obj, key: k });
          next.push(obj[k]);
        }
      } else {
        level.push({ owner: obj, key });
        next.push(obj[key]);
      }
    }
    containers = next;
  }
  return level;
}
function fixArrays(save) {
  for (const path of ARRAY_FIELDS) {
    for (const { owner, key } of atPath(save, path)) {
      const v = owner[key];
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
        owner[key] = [];
      }
    }
  }
}
function decodeSave(text) {
  const p = new P(text);
  p.skip();
  if (!p.src.startsWith("return", p.pos))
    throw new Error("not a save file");
  p.pos += 6;
  const save = parseValue(p);
  if (save && typeof save === "object")
    fixArrays(save);
  return save;
}

// voxelmon/game/game.ts
var SAVE_HOLD = 120;
var SAVE_DONE_HOLD = 30;
var SAVE_FORMAT = 4;
var PIC_NAMES = { oak: "prof.oak", player: "red", rival: "rival1" };
var PIC_FALLBACK = { oak: 406, player: 408, rival: 409, nidorino: 164 };

class OverworldState {
  ow;
  kind = "overworld";
  constructor(ow) {
    this.ow = ow;
  }
  update() {
    this.ow.update();
  }
}

class TextBoxState {
  game;
  onDone;
  choice;
  kind = "textbox";
  box;
  choicePushed = false;
  constructor(game, text, onDone, choice, opts) {
    this.game = game;
    this.onDone = onDone;
    this.choice = choice;
    this.box = new Textbox(text, { player: game.save.player.name, rival: game.save.player.rival }, { speed: game.textSpeed(), ...opts });
  }
  update() {
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    const wasWaiting = this.box.waiting;
    const wasDone = this.box.done;
    this.box.update(this.game.input);
    if (!this.box.isAuto && (wasDone && this.box.closed || wasWaiting && !this.box.waiting)) {
      this.game.audio.playSfx("Press_AB");
    }
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice));
      }
      return;
    }
    if (this.box.closed) {
      this.game.pop();
      this.onDone?.();
    }
  }
}

class ChoiceState {
  game;
  cb;
  kind = "choice";
  yes;
  pending = null;
  holdFrames = 0;
  constructor(game, cb, opts) {
    this.game = game;
    this.cb = cb;
    this.yes = !opts?.defaultNo;
    this.noSound = opts?.noSound === true;
  }
  noSound;
  update() {
    const input = this.game.input;
    if (this.pending !== null) {
      this.holdFrames -= 1;
      if (this.holdFrames <= 0) {
        const yes = this.pending;
        this.pending = null;
        this.game.pop();
        this.game.pop();
        this.cb(yes);
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.yes = !this.yes;
    } else if (input.wasPressed("a")) {
      if (!this.noSound)
        this.game.audio.playSfx("Press_AB");
      this.pending = this.yes;
      this.holdFrames = YES_NO_ANSWER;
    } else if (input.wasPressed("b")) {
      if (!this.noSound)
        this.game.audio.playSfx("Press_AB");
      this.yes = false;
      this.pending = false;
      this.holdFrames = YES_NO_ANSWER;
    }
  }
}

class WarpFadeState {
  game;
  frames;
  midpoint;
  onDone;
  kind = "warpfade";
  constructor(game, frames, midpoint, onDone) {
    this.game = game;
    this.frames = frames;
    this.midpoint = midpoint;
    this.onDone = onDone;
  }
  update() {
    this.frames -= 1;
    if (this.frames <= 0) {
      this.game.pop();
      this.midpoint();
      this.onDone?.();
    }
  }
}

class BattleGameState {
  game;
  kind = "battle";
  battle;
  staging;
  ui = new BattleUi;
  onDone = null;
  loseable = false;
  popped = false;
  constructor(game, species, level, prebuilt) {
    this.game = game;
    this.battle = prebuilt ?? new WildBattle(game.data, game.save, game.battleRng, species, level);
    const ow = game.overworld;
    this.staging = computeStaging(ow.map, ow.player.cellX, ow.player.cellY, ow.player.surfing);
    this.battle.enter();
  }
  update() {
    const b = this.battle;
    if (b.finished) {
      const done = this.onDone;
      this.onDone = null;
      if (this.popped)
        return;
      this.popped = true;
      this.game.pop();
      if (done)
        done();
      if (b.finished === "lose" && !this.loseable)
        this.game.blackout();
      else
        this.game.overworld.refreshDoors();
      this.game.runEvolutions(b.leveledUp);
      const caught = b.caughtNewSpecies;
      if (caught) {
        b.caughtNewSpecies = null;
        this.game.showCaughtDexEntry(caught);
      }
      if (b.outOfBalls) {
        this.game.overworld.safariGameOver("_OutOfSafariBallsText");
      }
      return;
      this.game.pop();
      if (b.finished === "lose")
        this.game.blackout();
      this.game.pushWarpFade(POST_BATTLE_RETURN + MAP_ENTRY_AFTER_BATTLE, () => {}, () => this.game.runEvolutions(b.leveledUp));
      return;
    }
    b.update(this.game.input);
  }
}

class VoxelmonGame {
  data;
  host;
  input = new Input;
  rng;
  npcRng;
  battleRng;
  save;
  overworld;
  audio = new AudioDirector(null);
  stack = [];
  scene;
  tickIndex = 0;
  prof;
  audioMap = null;
  audioBattle = false;
  audioRestored = false;
  constructor(data, host, seed = 1) {
    this.data = data;
    this.host = host;
    this.rng = seededRng(seed >>> 0);
    this.npcRng = seededRng((seed >>> 0 ^ 2654435769) >>> 0);
    this.battleRng = seededRng((seed >>> 0 ^ 2246822507) >>> 0);
    this.scene = new Scene(host);
  }
  setAudio(banks) {
    this.host.audiodata();
    this.audio = new AudioDirector(banks, this.host);
  }
  setAudioFromPak() {
    this.audio = new AudioDirector(fromSection(this.host.audiodata()), this.host);
  }
  driveAudio() {
    const bv = this.battleView();
    if (bv) {
      if (!this.audioBattle) {
        this.audioBattle = true;
        this.audio.playBattle(bv.battle.musicKind());
      }
      this.drainBattleCues(bv.battle);
      return;
    }
    if (this.audioBattle) {
      this.audioBattle = false;
      if (!this.audioRestored)
        this.audio.restore();
      this.audioRestored = false;
      return;
    }
    const mapId = this.overworld.map.id;
    if (mapId !== this.audioMap && !this.overworld.pendingSeamMusic) {
      this.audioMap = mapId;
      const top = this.stack[this.stack.length - 1];
      if (top?.kind === "intro" || top?.kind === "title") {
        this.audio.noteMap(mapId);
      } else {
        this.audio.startMap(mapId, !!this.save.onBike);
      }
    }
  }
  drainBattleCues(battle) {
    const cues = battle.audioCues;
    for (const cue of cues) {
      if (cue.startsWith("cry:")) {
        this.audio.playCry(cue.slice(4));
      } else if (cue.startsWith("move:")) {
        const [name, pitch, tempo] = cue.slice(5).split(":");
        this.audio.playSfx(name, Number(pitch) || 0, Number(tempo) || undefined);
      } else if (cue.startsWith("sfx:")) {
        this.audio.playSfx(cue.slice(4));
      } else if (cue.startsWith("music:victory")) {
        const kind = cue.slice("music:victory:".length);
        this.audio.playVictory(kind || "wild");
      } else if (cue === "music:restore") {
        this.audio.restore();
        this.audioRestored = true;
        this.audioMap = this.overworld.map.id;
      }
    }
    cues.length = 0;
  }
  newGame() {
    this.save = {
      meta: { format: SAVE_FORMAT, mods: {} },
      version: "red",
      player: {
        map: "REDS_HOUSE_2F",
        x: 3,
        y: 6,
        facing: "down",
        name: "RED",
        rival: "BLUE",
        id: Math.floor(Math.random() * 65536)
      },
      flags: {},
      inventory: {},
      pcItems: { POTION: 1 },
      party: [],
      box: {},
      money: 3000,
      defeatedTrainers: {},
      pokedex: { seen: {}, owned: {} },
      lastHeal: { map: "PALLET_TOWN", x: 5, y: 6 },
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
      repelSteps: 0,
      modData: {},
      options: {}
    };
    this.overworld = new Overworld(this);
    this.stack = [new OverworldState(this.overworld)];
    this.overworld.enter("REDS_HOUSE_2F", 3, 6, "down");
    this.hasSave = !!this.host.saveData?.();
    this.push(new TitleState(this, (choice) => {
      if (choice === "viewer") {
        this.host.viewer?.();
        return;
      }
      if (choice === "continue") {
        const text = this.host.saveData?.();
        if (text) {
          try {
            this.save = decodeSave(text);
            backfillVisited(this.save);
            postGameRescue(this.save);
            const pl = this.save.player ?? {};
            const lo = this.save.lastOutdoor ?? {};
            this.overworld.enter(pl.map ?? lo.id ?? "PALLET_TOWN", pl.x ?? lo.x ?? 5, pl.y ?? lo.y ?? 6, pl.facing ?? "down");
            return;
          } catch {}
        }
      }
      this.startIntro();
    }));
  }
  boot() {
    this.newGame();
    this.push(new IntroState(this, () => {}));
  }
  blackout() {
    for (const mon of this.save.party)
      healMon(this.data, mon);
    this.save.money = Math.floor((this.save.money ?? 0) / 2);
    const heal = this.save.lastHeal;
    if (heal) {
      this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
      if (heal.outdoor) {
        this.overworld.rememberOutdoor(heal.outdoor.id, heal.outdoor.x, heal.outdoor.y);
      }
    }
  }
  playTimeFrames = 0;
  advancePlayTime() {
    this.playTimeFrames += 1;
    if (this.playTimeFrames < 60)
      return;
    this.playTimeFrames = 0;
    const save = this.save;
    save.playTime = Math.floor(save.playTime ?? 0) + 1;
  }
  tick(buttons) {
    const p = this.prof;
    const t0 = p ? p.now() : 0;
    this.input.setButtons(buttons);
    this.input.step();
    this.overworld.serviceLink();
    const top = this.stack[this.stack.length - 1];
    top?.update();
    this.advancePlayTime();
    const t1 = p ? p.now() : 0;
    this.scene.emit(this);
    const t2 = p ? p.now() : 0;
    this.driveAudio();
    this.host.frameDone(this.tickIndex, buttons);
    if (p) {
      p.upd += t1 - t0;
      p.emit += t2 - t1;
      p.aud += p.now() - t2;
      if (this.tickIndex % 300 === 299) {
        p.line(`j${this.tickIndex} upd ${Math.round(p.upd)} emit ${Math.round(p.emit)}` + ` aud ${Math.round(p.aud)} maps ${Math.round(p.maps)}` + ` ents ${Math.round(p.ents)} ui ${Math.round(p.ui)}`);
        p.upd = p.emit = p.aud = p.maps = p.ents = p.ui = 0;
      }
    }
    this.tickIndex += 1;
  }
  push(state) {
    this.stack.push(state);
  }
  pop() {
    this.stack.pop();
  }
  closeToOverworld() {
    while (this.stack.length > 1)
      this.stack.pop();
  }
  top() {
    return this.stack[this.stack.length - 1];
  }
  stackKinds() {
    return this.stack.map((s) => s.kind);
  }
  healParty() {
    for (const mon of this.save.party)
      healMon(this.data, mon);
  }
  stamp(mapId, cx, cy, on) {
    this.host.stamp(mapId, cx, cy, on ? 1 : 0);
  }
  fieldFx(x, z, frame) {
    this.host.fieldFx?.(x, z, frame);
  }
  tint(abgr) {
    this.host.tint(abgr);
  }
  playOnce(song) {
    this.audio.playOnce(song);
  }
  restoreMapMusic() {
    this.audio.restore();
  }
  startMapMusic(mapId) {
    this.audioMap = mapId;
    this.audio.startMap(mapId, !!this.save.onBike);
  }
  showText(text, onDone) {
    this.push(new TextBoxState(this, text, onDone));
  }
  showAuto(text, delay, opts) {
    if (opts?.sfx)
      this.audio.playSfx(opts.sfx);
    this.push(new TextBoxState(this, text, opts?.onDone, undefined, { auto: { delay } }));
  }
  textSpeed() {
    const v = this.save.options?.textSpeed;
    return typeof v === "number" && v > 0 ? v : TEXT_SPEED_DEFAULT;
  }
  setStick(x, y, range) {
    const r = range > 0 ? range : 1;
    this.overworld.stick = {
      x: Math.max(-1, Math.min(1, x / r)),
      y: Math.max(-1, Math.min(1, y / r))
    };
  }
  cameraSpeedQ8() {
    const v = this.save.options?.cameraSpeed;
    return CAMERA_SPEEDS.find((s) => s.key === v)?.q8 ?? CAMERA_SPEED_DEFAULT_Q8;
  }
  animationsOn() {
    return this.save.options?.animations !== false;
  }
  showChoice(text, choice) {
    this.push(new TextBoxState(this, text, undefined, choice));
  }
  pushWarpFade(frames, midpoint, onDone) {
    this.push(new WarpFadeState(this, frames, midpoint, onDone));
  }
  runEvolutions(leveledUp) {
    const pending = checkParty(this.data, this.save.party, leveledUp);
    if (pending.length === 0)
      return;
    const step = (i) => {
      const row = pending[i];
      if (!row)
        return;
      this.push(new EvolutionState(this, row.mon, row.to, "LEVEL", (mon, to) => apply2(this.data, mon, to, this.save.pokedex), () => this.learnMovesAtLevel(row.mon, () => step(i + 1))));
    };
    step(0);
  }
  evolutionScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "evolution" ? top.view?.() ?? null : null;
  }
  learnMovesAtLevel(mon, onDone) {
    const def = this.data.pokemon[mon.species];
    const learned = movesLearnedAt(def, mon.level);
    const name = mon.nickname ?? def.name;
    const step = (i) => {
      const moveId = learned[i];
      if (!moveId) {
        onDone();
        return;
      }
      const mdef = this.data.moves[moveId];
      if (!mdef || mon.moves.some((mv) => mv.id === moveId)) {
        step(i + 1);
        return;
      }
      if (mon.moves.length < 4) {
        mon.moves.push({ id: moveId, pp: mdef.pp });
        this.showText(`${name} learned
${mdef.name}!`, () => step(i + 1));
        return;
      }
      this.offerReplaceMove(mon, moveId, () => step(i + 1));
    };
    step(0);
  }
  offerReplaceMove(mon, moveId, onDone) {
    const def = this.data.pokemon[mon.species];
    const name = mon.nickname ?? def.name;
    const mname = this.data.moves[moveId]?.name ?? moveId;
    const decline = () => this.showText(`${name} did not learn
${mname}!`, onDone);
    this.showChoice(`${name} is trying to
learn ${mname}!\fBut ${name} can't
learn more than\f4 moves!\f` + `Delete an older move
to make room for\f${mname}?`, (yes) => {
      if (!yes) {
        decline();
        return;
      }
      this.push(new MoveForgetState(this, mon, (slot) => {
        if (slot < 0) {
          decline();
          return;
        }
        const old = mon.moves[slot];
        if (this.hmMoveIds().has(old.id)) {
          this.showText(`HM moves can't be
forgotten now!`, () => this.offerReplaceMove(mon, moveId, onDone));
          return;
        }
        const forgotten = this.data.moves[old.id]?.name ?? old.id;
        mon.moves[slot] = { id: moveId, pp: this.data.moves[moveId]?.pp ?? 0 };
        this.showText(`1, 2 and... Poof!\f${name} forgot
${forgotten}!\fAnd...\f${name} learned
${mname}!`, onDone);
      }));
    });
  }
  hmMoveIds() {
    const out = new Set;
    for (const it of Object.values(this.data.items ?? {})) {
      const m = it.machine;
      if (m?.kind === "HM" && m.move)
        out.add(m.move);
    }
    return out;
  }
  teachMachine(partyIndex, itemId) {
    const mon = this.save.party[partyIndex];
    const item = this.data.items?.[itemId];
    const moveId = item?.machine?.move;
    if (!mon || !item || !moveId)
      return;
    const def = this.data.pokemon[mon.species];
    const name = mon.nickname ?? def.name;
    const mdef = this.data.moves[moveId];
    const mname = mdef?.name ?? moveId;
    if (mon.moves.some((mv) => mv.id === moveId)) {
      this.showText(`${name} knows
${mname} already!`);
      return;
    }
    if (!(def.tmhm ?? []).includes(moveId)) {
      this.showText(`${name} is not
compatible with
${item.name}!`);
      return;
    }
    if (mon.moves.length >= 4) {
      this.offerReplaceMove(mon, moveId, () => {
        if (mon.moves.some((mv) => mv.id === moveId) && item.machine?.kind === "TM") {
          remove(this.save, itemId, 1);
        }
      });
      return;
    }
    mon.moves.push({ id: moveId, pp: mdef?.pp ?? 0 });
    if (item.machine?.kind === "TM")
      remove(this.save, itemId, 1);
    this.showText(`${name} learned
${mname}!`);
  }
  pushStubBattle(species, level) {
    const safari = this.save.safari;
    if (safari && inSafariStepZone(this.overworld.map.id)) {
      this.push(new BattleGameState(this, species, level, new SafariBattle(this.data, this.save, this.battleRng, species, level, safari)));
      return;
    }
    this.push(new BattleGameState(this, species, level, new WildBattle(this.data, this.save, this.battleRng, species, level)));
  }
  uiBox() {
    for (let i = this.stack.length - 1;i >= 0; i--) {
      const s = this.stack[i];
      if (s.box)
        return s;
    }
    return null;
  }
  picNamed(which) {
    const p = namedPage(this.data, "picTrainer", PIC_NAMES[which]);
    return p >= 0 ? p : PIC_FALLBACK[which];
  }
  startIntro() {
    this.audio?.play?.("Music_MeetProfOak");
    const P_OAK = this.picNamed("oak");
    const P_PLR = this.picNamed("player");
    const P_RIV = this.picNamed("rival");
    const nido = picPageFor(this.data, "NIDORINO");
    const P_NIDO = nido >= 0 ? nido : PIC_FALLBACK.nidorino;
    const A = [
      ["pic", P_OAK, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText1"],
      ["pic", P_NIDO, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText2A"],
      ["pic", P_OAK, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText2B"],
      ["show_text", "_IntroducePlayerText"],
      ["pic", P_PLR, 184, 24, 112, 112]
    ];
    const B = [
      ["pic", P_RIV, 184, 24, 112, 112],
      ["show_text", "_IntroduceRivalText"]
    ];
    const C = [
      ["pic", P_PLR, 184, 24, 112, 112],
      ["show_text", "_OakSpeechText3"],
      ["pic", P_PLR, 184, 24, 112, 112],
      ["wait", 4],
      ["pic", P_PLR, 192, 32, 96, 96],
      ["wait", 4],
      ["pic", P_PLR, 200, 40, 80, 80],
      ["wait", 4],
      ["pic", P_PLR, 208, 48, 64, 64],
      ["wait", 4],
      ["pic", P_PLR, 216, 56, 48, 48],
      ["wait", 4],
      ["pic", P_PLR, 224, 64, 32, 32],
      ["wait", 4],
      ["pic_hide"]
    ];
    const run = (rows, done) => this.overworld.runScript(rows, done);
    const presets = this.data.field?.presetNames;
    const askName = (title, list2, fallback, onDone) => {
      const names = list2 && list2.length > 0 ? list2 : [fallback];
      const custom = presets?.customOption ?? "NEW NAME";
      this.push(new NamingState(this, {
        title,
        pick: [custom, ...names],
        onDone: (choice) => {
          if (choice !== custom) {
            onDone(choice);
            return;
          }
          this.push(new NamingState(this, { title, fallback: names[0], onDone }));
        }
      }));
    };
    run(A, () => {
      askName("YOUR NAME?", presets?.player, "RED", (name) => {
        this.save.player.name = name;
        run(B, () => {
          askName("RIVAL'S NAME?", presets?.rival, "BLUE", (rival) => {
            this.save.player.rival = rival;
            run(C, () => {
              this.audio?.startMap?.("REDS_HOUSE_2F");
            });
          });
        });
      });
    });
  }
  pic() {
    let top = this.stack[this.stack.length - 1];
    const under = this.stack[this.stack.length - 2];
    if (top?.kind === "textbox" && under?.kind === "evolution")
      top = under;
    if (top?.kind === "intro")
      return top.view().pics;
    if (top?.kind === "title") {
      const v = top.view();
      const out = [
        { page: titlePage(this.data, "logo"), x: 96, y: 16, w: 288, h: 108 }
      ];
      out.push({ page: this.picNamed("player"), x: 160, y: 132, w: 112, h: 112 });
      if (v.monPage >= 0)
        out.push({ page: v.monPage, x: 248, y: 140, w: 104, h: 104 });
      return out;
    }
    if (top?.kind === "trainercard") {
      const v = top.view();
      if (v.picPage < 0)
        return [];
      const r = CARD_PIC_RECT;
      return [{ page: v.picPage, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "summary") {
      const v = top.view();
      const page = picPageFor(this.data, v.speciesId);
      if (page < 0)
        return [];
      const r = cellsToPicRect(SUMMARY_PIC_CELL);
      return [{ page, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "party") {
      const v = top.view();
      const out = [];
      v.entries.forEach((e, i) => {
        const page = picPageFor(this.data, e.species);
        if (page < 0)
          return;
        const r = cellsToPicRect(partyIconCell(i));
        out.push({ page, x: r.x, y: r.y, w: r.w, h: r.h });
      });
      return out;
    }
    if (top?.kind === "tradeanim") {
      const v = top.view();
      if (!v?.mon)
        return [];
      const page = picPageFor(this.data, v.mon.species);
      if (page < 0)
        return [];
      const r = cellsToPicRect(TRADE_PIC_CELL);
      return [{ page, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "tradescreen") {
      const v = top.view();
      const out = [];
      const add2 = (list2, row0) => {
        list2.forEach((e, i) => {
          const page = picPageFor(this.data, e.species);
          if (page < 0)
            return;
          const r = cellsToPicRect({ x: 1, y: row0 + i, w: 1, h: 1 });
          out.push({ page, x: r.x, y: r.y, w: r.w, h: r.h });
        });
      };
      add2(v.theirs, TRADE_THEIRS_ROW);
      add2(v.mine, TRADE_MINE_ROW);
      return out;
    }
    if (top?.kind === "evolution") {
      const v = top.view();
      if (!v || v.picPage < 0)
        return [];
      const r = cellsToPicRect(EVO_PIC_CELL);
      return [{ page: v.picPage, x: r.x, y: r.y, w: r.w, h: r.h }];
    }
    if (top?.kind === "halloffame") {
      const v = top.view();
      if (!v.mon || v.mon.picPage < 0)
        return [];
      return [{ page: v.mon.picPage, x: 188, y: 40, w: 112, h: 112 }];
    }
    if (top?.kind === "credits") {
      const v = top.view();
      if (v.picPage < 0)
        return [];
      return [{ page: v.picPage, x: 40, y: 68, w: 96, h: 96 }];
    }
    if (top?.kind === "pokedex") {
      const v = top.view();
      if (v.mode === "entry" && v.entry && v.entry.spritePage >= 0) {
        return [{ page: v.entry.spritePage, x: 16, y: 24, w: 104, h: 104 }];
      }
      return [];
    }
    return this.overworld.picShown;
  }
  openOaksAide(textId, onDone) {
    const post = OAKS_AIDES[textId];
    if (!post) {
      onDone?.();
      return;
    }
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const itemName = this.data.items?.[post.item]?.name ?? post.item;
    const flag = oaksAideFlag(post.item);
    const fill = (k, fallback, num) => fillAideText(line(k, fallback), { num, item: itemName });
    if (this.save.flags?.[flag]) {
      this.showText(fill(post.repeatText, `I gave you the
${itemName}!`), onDone);
      return;
    }
    this.showChoice(fill("_OaksAideHiText", `Hi! Remember me?
I'm PROF.OAK's
AIDE!`, post.threshold), (yes) => {
      if (!yes) {
        this.showText(fill("_OaksAideComeBackText", "Oh. I see.", post.threshold), onDone);
        return;
      }
      const owned = countOwned(this.save);
      if (owned < post.threshold) {
        this.showText(fill("_OaksAideUhOhText", `Let's see...
Uh-oh!`, owned), onDone);
        return;
      }
      if (!add(this.save, post.item, 1, this.data)) {
        this.showText(fill("_OaksAideNoRoomText", `Oh! You have no
room for it.`), onDone);
        return;
      }
      this.save.flags[flag] = true;
      this.audio.playSfx("Get_Key_Item");
      this.showText(fill("_OaksAideHereYouGoText", `Great!
Here you go!`, owned), () => {
        this.showText(fill("_OaksAideGotItemText", `{PLAYER} got the
${itemName}!`), onDone);
      });
    });
  }
  setCamTurns(q) {
    this.overworld.camTurns = q;
  }
  setCamYaw(yaw) {
    this.overworld.freeYaw = yaw;
  }
  lastSaveOk = true;
  runWriteTest() {
    const h = this.host;
    if (!h?.writeTest) {
      this.showText(`This build cannot
test card writes.`);
      return;
    }
    const ok = h.writeTest();
    if (ok) {
      this.showText(`CARD WRITE OK
writetest.txt was
written and read
back.`);
      return;
    }
    const why = (h.writeErr?.() ?? "unknown").slice(0, 40);
    this.showText(`CARD WRITE FAILED
${why}`);
  }
  openPc(onDone) {
    this.push(new PcState(this, onDone));
  }
  pc() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pc" ? top.view() : null;
  }
  pcCursor() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pc" ? top.menuCursor() : 0;
  }
  playSfx(name) {
    this.audio.playSfx(name);
  }
  bikeShop() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "bikeshop" ? top.view() : null;
  }
  openBikeShop(onDone) {
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const save = this.save;
    if ((this.save.inventory?.BICYCLE ?? 0) > 0 || save.flags?.EVENT_GOT_BICYCLE) {
      this.showText(line("_BikeShopClerkHowDoYouLikeYourBicycleText", `How do you like
your new BICYCLE?`), onDone);
      return;
    }
    if ((this.save.inventory?.BIKE_VOUCHER ?? 0) > 0) {
      this.showText(line("_BikeShopClerkOhThatsAVoucherText", "Oh, that's...\fA BIKE VOUCHER!"), () => {
        if (!add(this.save, "BICYCLE", 1, this.data)) {
          this.showText(line("_BikeShopBagFullText", `You better make
room for this!`), onDone);
          return;
        }
        remove(this.save, "BIKE_VOUCHER", 1);
        save.flags.EVENT_GOT_BICYCLE = true;
        this.audio.playSfx("Get_Key_Item");
        this.showText(line("_BikeShopExchangedVoucherText", `{PLAYER} exchanged
the BIKE VOUCHER
for a BICYCLE.`), onDone);
      });
      return;
    }
    this.showText(line("_BikeShopClerkWelcomeText", `Hi! Welcome to
our BIKE SHOP.`), () => {
      const pitch = line("_BikeShopClerkDoYouLikeItText", `It's a cool BIKE!
Do you want it?`);
      const pages = paginate(substitute(pitch, { player: this.save.player?.name }));
      const tail = pages[pages.length - 1]?.lines.join(`
`) ?? null;
      const win = new BikeShopState(this, tail, (bought) => {
        const comeAgain = () => {
          this.showText(line("_BikeShopComeAgainText", `Come back again
some time!`), () => {
            win.close();
            onDone?.();
          });
        };
        if (bought)
          this.showText(line("_BikeShopCantAffordText", `Sorry! You can't
afford it!`), comeAgain);
        else
          comeAgain();
      });
      this.push(win);
    });
  }
  useKeyItem(itemId) {
    if (itemId === "BICYCLE")
      this.toggleBike();
    else if (itemId === "POKE_FLUTE")
      this.playPokeFlute();
    else if (isRod(itemId))
      this.goFishing(itemId);
    else
      this.useFieldItem(itemId);
  }
  showLines(lines, onDone) {
    const next = (i) => {
      const line = lines[i];
      if (line === undefined) {
        onDone?.();
        return;
      }
      this.showText(line, () => next(i + 1));
    };
    next(0);
  }
  escapeWarp() {
    const heal = this.save.lastHeal;
    if (!heal)
      return false;
    this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
    if (heal.outdoor)
      this.overworld.rememberOutdoor(heal.outdoor.id, heal.outdoor.x, heal.outdoor.y);
    return true;
  }
  useFieldItem(itemId) {
    const r = useItem(this.data, this.save, itemId, null, null);
    if (r.kind === "escape_rope") {
      const map = this.overworld.map;
      const heal = this.save.lastHeal;
      if (!map || !ESCAPE_ROPE_TILESETS.has(map.def?.tileset) || map.id === "AGATHAS_ROOM" || !heal) {
        this.showText(itemText(this.data, "_ItemUseNotTimeText", `OAK: {PLAYER}!
This isn't the
time to use that!`, { player: this.save.player?.name ?? "RED" }));
        return;
      }
      remove(this.save, itemId, 1);
      this.escapeWarp();
      return;
    }
    if (r.kind === "townmap") {
      this.setGearView("map");
      return;
    }
    if (r.kind === "itemfinder") {
      const t = this.data.text ?? {};
      this.showText(this.overworld.hiddenItemNearby() ? t._ItemfinderFoundItemText ?? `Yes! ITEMFINDER
indicates there's
an item nearby.` : t._ItemfinderFoundNothingText ?? `Nope! ITEMFINDER
isn't responding.`);
      return;
    }
    if (r.kind === "consumed")
      remove(this.save, itemId, 1);
    this.showLines(r.msgs);
  }
  goFishing(rod) {
    const t = this.data.text ?? {};
    const line = (k, fallback) => (t[k] ?? fallback).replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED"));
    const ow = this.overworld;
    const p = ow?.player;
    if (!p)
      return;
    if (p.surfing) {
      this.showText(line("_ItemUseNotTimeText", `OAK: {PLAYER}!
This isn't the
time to use that!`));
      return;
    }
    const [fx, fy] = p.facingCell();
    if (!ow.map?.inBounds(fx, fy) || !ow.map.isWaterCell(fx, fy)) {
      this.showText(`No good! It's not
even near water.`);
      return;
    }
    const hooked = fishingCatch(this.data, rod, ow.map.id, () => this.rng.int(256));
    this.showText(". . .", () => {
      if (!hooked) {
        this.showText(line("_NoNibbleText", "Not even a nibble!"));
        return;
      }
      this.showText(line("_ItsABiteText", `Oh!
It's a bite!`), () => {
        this.startWildBattle(hooked.species, hooked.level, { hooked: true });
      });
    });
  }
  playPokeFlute() {
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const found = adjacentSnorlax(this.overworld.map?.id ?? "", this.overworld.player, this.overworld.npcs, this.save.flags);
    if (!found) {
      this.showText(line("_PlayedFluteNoEffectText", `Played the POKé
FLUTE.\fNow, that's a
catchy tune!`));
      return;
    }
    const { spot } = found;
    const player = String(this.save.player?.name ?? "RED");
    this.showText(line("_PlayedFluteHadEffectText", `{PLAYER} played the
POKé FLUTE.`).replace(/\{PLAYER\}/g, player), () => {
      this.showText(line(spot.wokeText, "SNORLAX woke up!"), () => {
        this.save.objectToggles ??= {};
        const toggles = this.save.objectToggles;
        (toggles[spot.map] ??= {})[spot.object] = false;
        this.overworld.setObjectHidden(spot.object, true);
        this.startWildBattle("SNORLAX", SNORLAX_LEVEL, undefined, (result) => {
          this.save.flags[spot.beatFlag] = true;
          if (result === "caught")
            return;
          this.showText(line(spot.leftText, "SNORLAX returned to the mountains!"));
        });
      });
    });
  }
  toggleBike() {
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const save = this.save;
    const name = this.data.items?.BICYCLE?.name ?? "BICYCLE";
    const pair = (a, b) => `${line(a, "")}
${line(b, "").replace(/\{RAM:\w+\}/g, name)}`;
    if (save.forcedBike) {
      this.showText(line("_CannotGetOffHereText", `You can't get off
here.`));
      return;
    }
    if (save.onBike) {
      save.onBike = false;
      this.overworld.syncBike();
      this.startMapMusic(this.overworld.map.id);
      this.showText(pair("_GotOffBicycleText1", "_GotOffBicycleText2"));
      return;
    }
    if (!this.overworld.canRideHere()) {
      this.showText(line("_NoCyclingAllowedHereText", `No cycling
allowed here.`));
      return;
    }
    save.onBike = true;
    this.overworld.syncBike();
    this.startMapMusic(this.overworld.map.id);
    this.showText(pair("_GotOnBicycleText1", "_GotOnBicycleText2"));
  }
  recordHallOfFame(onDone) {
    const entry = recordHallOfFame(this.save);
    const finish = () => {
      this.healParty();
      applyPostGameHome(this.save);
      this.overworld.lastOutdoor = this.save.lastOutdoor;
      this.writeSave?.(POST_GAME_HOME);
      this.overworld.startWarpTo(POST_GAME_HOME.map, POST_GAME_HOME.x, POST_GAME_HOME.y, POST_GAME_HOME.facing);
      onDone?.();
    };
    const rollCredits = () => {
      const screens = this.data.field?.credits?.screens ?? [];
      if (screens.length === 0) {
        finish();
        return;
      }
      this.push(new CreditsState(this, screens, finish));
    };
    if (entry.length === 0) {
      rollCredits();
      return;
    }
    this.push(new HallOfFameState(this, entry, rollCredits));
  }
  openNameRater(onDone) {
    const t = this.data.text ?? {};
    const fill = (k, fallback, name = "") => (t[k] ?? fallback).replace(/\{RAM:wNameBuffer\}/g, name).replace(/\{RAM:wBuffer\}/g, name);
    const bye = () => this.showText(fill("_NameRatersHouseNameRaterComeAnyTimeYouLikeText", `Fine! Come any
time you like!`), onDone);
    this.showChoice(fill("_NameRatersHouseNameRaterWantMeToRateText", `Hello, hello!
I am the official
NAME RATER!\fWant me to rate
the nicknames of
your POKéMON?`), (yes) => {
      if (!yes) {
        bye();
        return;
      }
      this.showText(fill("_NameRatersHouseNameRaterWhichPokemonText", `Which POKéMON
should I look at?`), () => {
        this.pickPartyMon((index) => {
          const mon = this.save.party[index];
          if (!mon) {
            bye();
            return;
          }
          const def = this.data.pokemon[mon.species];
          const species = def?.name ?? mon.species;
          const cur = mon.nickname ?? species;
          if (mon.traded === true) {
            this.showText(fill("_NameRatersHouseNameRaterATrulyImpeccableNameText", `{RAM:wNameBuffer}, is it?
That is a truly
impeccable name!\fTake good care of
{RAM:wNameBuffer}!`, cur), onDone);
            return;
          }
          this.showChoice(fill("_NameRatersHouseNameRaterGiveItANiceNameText", `{RAM:wNameBuffer}, is it?
That is a decent
nickname!\fBut, would you
like me to give
it a nicer name?\fHow about it?`, cur), (rename) => {
            if (!rename) {
              bye();
              return;
            }
            this.showText(fill("_NameRatersHouseNameRaterWhatShouldWeNameItText", `Fine! What should
we name it?`), () => {
              this.askNickname(species, (name) => {
                mon.nickname = name ?? undefined;
                this.showText(fill("_NameRatersHouseNameRaterPokemonHasBeenRenamedText", `OK! This POKéMON
has been renamed
{RAM:wBuffer}!\fThat's a better
name than before!`, mon.nickname ?? species), onDone);
              });
            });
          });
        }, bye);
      });
    });
  }
  pickPartyMon(onPick, onCancel) {
    this.push(new PartyState(this, { onPick, onCancel }));
  }
  openDaycare(onDone) {
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const dc = this.save.daycare;
    const name = (m) => m.nickname ?? this.data.pokemon[m.species]?.name ?? m.species;
    if (dc?.mon) {
      this.daycareCollect(dc, onDone);
      return;
    }
    this.showChoice(line("_DaycareGentlemanIntroText", "I run a DAYCARE."), (yes) => {
      if (!yes) {
        this.showText(line("_DaycareGentlemanComeAgainText", "come again."), onDone);
        return;
      }
      if (this.save.party.length < 2) {
        this.showText(line("_DaycareGentlemanOnlyHaveOneMonText", `You only have one
POKéMON with you.`), onDone);
        return;
      }
      this.showText(line("_DaycareGentlemanWhichMonText", `Which POKéMON
should I raise?`), () => {
        this.push(new PartyState(this, {
          onCancel: () => onDone?.(),
          onPick: (i) => {
            const mon = this.save.party[i];
            if (!mon) {
              onDone?.();
              return;
            }
            if (mon.moves.some((mv) => this.hmMoveIds().has(mv.id))) {
              this.showText(line("_DaycareGentlemanCantAcceptMonWithHMText", `I can't accept a
POKéMON that
knows an HM move.`), onDone);
              return;
            }
            this.save.party.splice(i, 1);
            this.save.daycare = {
              mon,
              steps: 0,
              depositLevel: mon.level
            };
            const said = fillDaycareText(line("_DaycareGentlemanWillLookAfterMonText", `Fine, I'll look
after {RAM:wNameBuffer}.`), { wNameBuffer: name(mon) });
            this.showText(said, () => {
              this.showText(line("_DaycareGentlemanComeSeeMeInAWhileText", `Come see me in
a while.`), onDone);
            });
          }
        }));
      });
    });
  }
  daycareCollect(dc, onDone) {
    const t = this.data.text ?? {};
    const line = (k, fallback) => t[k] ?? fallback;
    const mon = dc.mon;
    const monName2 = mon.nickname ?? this.data.pokemon[mon.species]?.name ?? mon.species;
    const cap = this.data.constants?.levelCap ?? 100;
    const quote2 = daycareQuote(this.data, dc, cap);
    mon.exp = quote2.exp;
    dc.steps = 0;
    const subs = {
      wNameBuffer: monName2,
      wDayCareMonName: monName2,
      wDayCareNumLevelsGrown: quote2.levelsGrown,
      wDayCareTotalCost: quote2.fee
    };
    const status = quote2.levelsGrown > 0 ? line("_DaycareGentlemanMonHasGrownText", `Your {RAM:wNameBuffer}
has grown a lot!`) : line("_DaycareGentlemanMonNeedsMoreTimeText", "Back already?");
    this.showText(fillDaycareText(status, subs), () => {
      if (this.save.party.length >= 6) {
        this.showText(line("_DaycareGentlemanNoRoomForMonText", `You have no room
for this POKéMON!`), onDone);
        return;
      }
      const owe = fillDaycareText(line("_DaycareGentlemanOweMoneyText", `You owe me ¥{NUM:wDayCareTotalCost}
for the return
of this POKéMON.`), subs);
      this.showChoice(owe, (yes) => {
        if (!yes) {
          this.showText(line("_DaycareGentlemanAllRightThenText", `All right then,
`) + line("_DaycareGentlemanComeAgainText", "come again."), onDone);
          return;
        }
        if ((this.save.money ?? 0) < quote2.fee) {
          this.showText(line("_DaycareGentlemanNotEnoughMoneyText", `Hey, you don't
have enough ¥!`), onDone);
          return;
        }
        this.save.money = (this.save.money ?? 0) - quote2.fee;
        applyDaycareGrowth(this.data, mon, dc.depositLevel ?? mon.level, quote2.newLevel);
        this.save.party.push(mon);
        this.save.daycare = null;
        this.showText(line("_DaycareGentlemanHeresYourMonText", `Thank you! Here's
your POKéMON!`), () => {
          this.showText(fillDaycareText(line("_DaycareGentlemanGotMonBackText", `{PLAYER} got
{RAM:wDayCareMonName} back!`), subs), onDone);
        });
      });
    });
  }
  openSlots(lucky) {
    this.push(new SlotMachineState(this, this.battleRng, lucky));
  }
  slots() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "slots" ? top.view() : null;
  }
  openPrizes(window, onDone) {
    const prizes = PRIZE_WINDOWS[window - 1];
    if (!prizes) {
      onDone?.();
      return;
    }
    this.push(new PrizeState(this, prizes, onDone));
  }
  prizes() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "prizes" ? top.view() : null;
  }
  givePrizeMon(species, level) {
    if (this.save.party.length >= 6)
      return false;
    this.save.party.push(newMon(this.data, species, level, this.battleRng));
    markOwned(this.save, species);
    return true;
  }
  openShop(stock, onQuit) {
    this.push(new ShopState(this, stock, onQuit));
  }
  openVending(onQuit) {
    this.push(new ShopState(this, [...VENDING_DRINKS], onQuit, true));
  }
  openBox() {
    this.push(new BoxState(this));
  }
  playCry(species) {
    this.audio.playCry(species);
  }
  openStartMenu() {
    this.push(new StartMenuState(this, (act) => {
      if (act === "pokedex") {
        this.push(new PokedexState(this));
      }
      if (act === "item") {
        this.push(new BagState(this));
      }
      if (act === "pokemon") {
        this.push(new PartyState(this));
      }
      if (act === "trainer") {
        this.push(new TrainerCardState(this));
      }
      if (act === "dev")
        this.openDevMenu();
      if (act === "save")
        this.openSaveScreen();
      if (act === "option") {
        this.push(new OptionsMenuState(this));
      }
    }));
  }
  openSaveScreen() {
    const save = this.save;
    const name = save.player.name ?? "RED";
    const badges = count(this.data, this.save);
    const owned = Object.keys(save.pokedex?.owned ?? {}).length;
    const t = Math.max(0, Math.floor(save.playTime ?? 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    this.savePanelLines = [
      `PLAYER ${name}`,
      `BADGES    ${badges}`,
      `POKéDEX ${String(owned).padStart(3)}`,
      `TIME ${String(h).padStart(6)}:${String(m).padStart(2, "0")}`
    ];
    const close = () => {
      this.savePanelLines = null;
    };
    this.showChoice(`Would you like to
SAVE the game?`, (yes) => {
      if (!yes) {
        close();
        return;
      }
      this.showAuto("Now saving...", SAVE_HOLD, {
        onDone: () => {
          this.writeSave();
          this.showAuto(`${name} saved
the game!`, SAVE_DONE_HOLD, {
            sfx: "Save",
            onDone: close
          });
        }
      });
    });
  }
  gearView = "party";
  gearMapPick = null;
  setGearView(v) {
    this.gearView = v;
    if (v !== "map")
      this.gearMapPick = null;
  }
  cycleGearView(dir) {
    this.setGearView(gearViewStep(this, dir));
  }
  setGearMapPick(id) {
    this.gearMapPick = id;
  }
  savePanelLines = null;
  savePanel() {
    return this.savePanelLines;
  }
  writeSave(at2) {
    const ow = this.overworld;
    const p = this.save.player;
    p.map = at2?.map ?? ow.mapId ?? ow.map?.id ?? p.map;
    p.x = at2?.x ?? ow.player?.cellX ?? p.x;
    p.y = at2?.y ?? ow.player?.cellY ?? p.y;
    p.facing = at2?.facing ?? ow.player?.facing ?? p.facing;
    const h = this.host ?? this.hostApi ?? globalThis.voxel;
    if (!h?.saveWrite) {
      console.log("save: no host.saveWrite");
      return;
    }
    const ok = h.saveWrite(encodeSave(this.save));
    this.lastSaveOk = ok !== false;
    if (ok === false) {
      const why = h.writeErr?.() ?? "";
      this.showText(`SAVE FAILED!
The SD card did
not take it.${why ? `
${why.slice(0, 24)}` : ""}`);
    }
  }
  optionsMenu() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "options" ? top.view() : null;
  }
  openDevMenu() {
    this.push(new DevMenuState(this, (act) => {
      if (act === "warp") {
        const ow = this.overworld;
        const here = String(ow.mapId ?? ow.map?.id ?? "");
        this.push(new WarpPickerState(this, here, (mapId) => {
          this.closeToOverworld();
          const def = this.data.maps?.[mapId];
          const w = (def?.warps ?? [])[0];
          ow.startWarpTo(mapId, w?.x ?? 1, w?.y ?? 1, "down", () => {});
        }));
      }
      if (act === "candy")
        this.giveRareCandies();
      if (act === "cardtest")
        this.runWriteTest();
    }));
  }
  giveRareCandies() {
    const have = this.save.inventory?.RARE_CANDY ?? 0;
    const want = 99 - have;
    if (want <= 0) {
      this.showText(`You already have
99 RARE CANDY!`);
      return;
    }
    if (!add(this.save, "RARE_CANDY", want, this.data)) {
      this.showText("The BAG is full!");
      return;
    }
    this.showText(`Got ${want} RARE CANDY!
Now x99.`);
  }
  useItem(partyIndex, itemId, moveIndex) {
    if (itemId === "RARE_CANDY") {
      this.useRareCandy(partyIndex);
      return;
    }
    const mon = this.save.party[partyIndex];
    if (!mon)
      return;
    if (needsMove(itemId) && moveIndex === undefined) {
      this.push(new MoveForgetState(this, mon, (slot) => {
        if (slot >= 0)
          this.useItem(partyIndex, itemId, slot);
      }, "CANCEL"));
      return;
    }
    const r = useItem(this.data, this.save, itemId, mon, null, moveIndex);
    if (r.kind === "consumed")
      remove(this.save, itemId, 1);
    if (r.evolveTo) {
      const to = r.evolveTo;
      this.push(new EvolutionState(this, mon, to, "ITEM", (m, t) => apply2(this.data, m, t, this.save.pokedex), () => this.learnMovesAtLevel(mon, () => {})));
      return;
    }
    this.showLines(r.msgs);
  }
  useRareCandy(partyIndex) {
    const mon = this.save.party[partyIndex];
    if (!mon)
      return;
    const def = this.data.pokemon[mon.species];
    const name = mon.nickname ?? def.name;
    const cap = this.data.constants?.levelCap ?? 100;
    if (mon.level >= cap) {
      this.showText(`It won't have any
effect.`);
      return;
    }
    remove(this.save, "RARE_CANDY", 1);
    mon.level += 1;
    mon.exp = expForLevel(def.growthRate, mon.level, this.data.growth_rates);
    const old = mon.stats;
    mon.stats = calc(def, mon.level, mon.dvs, mon.statExp);
    mon.hp = Math.min(mon.stats.hp, mon.hp + (mon.stats.hp - old.hp));
    this.showText(`${name} grew
to level ${mon.level}!`, () => {
      this.learnMovesAtLevel(mon, () => this.runEvolutions(new Set([mon])));
    });
  }
  bag() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "bag" ? top.view() : null;
  }
  shop() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "shop" ? top.view() : null;
  }
  box() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "box" ? top.view() : null;
  }
  party() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "party" ? top.view() : null;
  }
  linkCarrier = null;
  linkTransport() {
    return this.linkCarrier ?? hostTransport();
  }
  pickLinkRoom(session, done) {
    if (!session) {
      done(false);
      return;
    }
    const CANCEL = "CANCEL";
    this.push(new NamingState(this, {
      title: "CABLE CLUB",
      pick: ["TRADE CENTER", "COLOSSEUM", CANCEL],
      onDone: (choice) => {
        if (choice === CANCEL) {
          session.cancel();
          done(false);
          return;
        }
        session.chooseRoom(choice === "COLOSSEUM" ? LINK_ROOM.colosseum : LINK_ROOM.trade);
        this.showText("_CableClubNPCPleaseWaitText");
        this.overworld.waitLink((s) => s.agreedRoom() !== null, LINK_WAIT_FRAMES, done);
      }
    }));
  }
  linkBattle(done) {
    const ow = this.overworld;
    const s = ow.link;
    const t = this.data.text ?? {};
    const finish = () => done?.();
    const canceled = () => this.showText(t._LinkCanceledText ?? `The link was
canceled.`, finish);
    if (!s || s.state === "closed") {
      canceled();
      return;
    }
    const wellFormed = (m) => {
      const o = m;
      return !!o && typeof o === "object" && typeof o.species === "string" && !!this.data.pokemon?.[o.species] && typeof o.level === "number" && o.level >= 1 && o.level <= 100 && typeof o.hp === "number" && !!o.stats && Array.isArray(o.moves);
    };
    const myHalf = Math.floor(Math.random() * 4294967295) >>> 0 || 1;
    s.sendParty({
      mons: JSON.parse(JSON.stringify(this.save.party)),
      otName: String(this.save.player?.name ?? "RED"),
      otId: Number(this.save.player?.id ?? 0)
    });
    s.sendSeed(myHalf);
    ow.waitLink((x) => x.peerParty !== null && x.peerSeed !== null, LINK_WAIT_FRAMES, (ready) => {
      const theirParty = s.peerParty;
      const seed = s.battleSeed(myHalf);
      if (!ready || !theirParty || seed === null) {
        canceled();
        return;
      }
      const theirs = theirParty.mons.filter(wellFormed);
      if (theirs.length === 0 || this.save.party.length === 0) {
        canceled();
        return;
      }
      const battle = new LinkBattle(this.data, this.save, seededRng(seed), s.peerName, theirs, s);
      const st = new BattleGameState(this, "", 0, battle);
      st.loseable = true;
      st.onDone = () => finish();
      this.push(st);
    });
  }
  linkTrade(done) {
    const ow = this.overworld;
    const s = ow.link;
    const t = this.data.text ?? {};
    const finish = () => done?.();
    const say = (k, f, subs, after) => {
      let str = t[k] ?? f;
      str = str.replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED"));
      str = str.replace(/\{RAM:(\w+)\}/g, (_m, n) => subs[n] ?? "");
      this.showText(str, after);
    };
    const canceled = (after) => say("_LinkCanceledText", `The link was
canceled.`, {}, after);
    if (!s || s.state === "closed") {
      canceled(finish);
      return;
    }
    const nameOf = (m) => m.nickname ?? this.data.pokemon?.[m.species]?.name ?? m.species;
    const wellFormed = (m) => {
      const o = m;
      return !!o && typeof o === "object" && typeof o.species === "string" && !!this.data.pokemon?.[o.species] && typeof o.level === "number" && o.level >= 1 && o.level <= 100 && typeof o.hp === "number" && !!o.stats && Array.isArray(o.moves);
    };
    const entry = (m) => ({
      name: nameOf(m),
      level: m.level,
      species: m.species,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null
    });
    s.resetTrade();
    s.sendParty({
      mons: JSON.parse(JSON.stringify(this.save.party)),
      otName: String(this.save.player?.name ?? "RED"),
      otId: Number(this.save.player?.id ?? 0)
    });
    ow.waitLink((x) => x.peerParty !== null, LINK_WAIT_FRAMES, (arrived) => {
      const theirParty = s.peerParty;
      if (!arrived || !theirParty) {
        canceled(finish);
        return;
      }
      const theirs = theirParty.mons.filter(wellFormed);
      if (theirs.length === 0) {
        canceled(finish);
        return;
      }
      const swap = (mySlot, theirSlot, after) => {
        const mine = this.save.party[mySlot];
        const got = theirs[theirSlot];
        if (!mine || !got) {
          canceled(after);
          return;
        }
        const arrival = {
          ...got,
          traded: true,
          otName: theirParty.otName,
          otId: theirParty.otId
        };
        this.save.party[mySlot] = arrival;
        const dex = this.save.pokedex;
        if (dex) {
          (dex.seen ??= {})[arrival.species] = true;
          (dex.owned ??= {})[arrival.species] = true;
        }
        s.resetTrade();
        this.push(new TradeAnimState(this, {
          sending: entry(mine),
          receiving: entry(arrival),
          peerName: s.peerName,
          onDone: () => {
            const subs = {
              wLinkEnemyTrainerName: s.peerName,
              wNameBuffer: nameOf(arrival),
              wStringBuffer: nameOf(mine),
              wNameOfPlayerMonToBeTraded: nameOf(mine)
            };
            say("_TradeWentToText", `{RAM:wStringBuffer} went
to {RAM:wLinkEnemyTrainerName}.`, subs, () => say("_TradeTakeCareText", `Take good care of
{RAM:wNameBuffer}.`, subs, () => {
              const hit = pendingFor(this.data, arrival, { kind: "trade" });
              if (!hit) {
                after();
                return;
              }
              this.push(new EvolutionState(this, arrival, hit[0], "TRADE", (mon, to) => apply2(this.data, mon, to, this.save.pokedex), after));
            }));
          }
        }));
      };
      const openScreen = () => {
        this.push(new TradeScreenState(this, {
          myName: String(this.save.player?.name ?? "RED"),
          peerName: s.peerName,
          mine: this.save.party.map(entry),
          theirs: theirs.map(entry),
          watch: s,
          onDone: (choice) => {
            if (choice.kind === "cancel") {
              s.answer(false);
              finish();
              return;
            }
            if (choice.kind === "propose") {
              s.offer({ give: choice.give, take: choice.take });
              ow.waitLink((x) => x.peerAnswer !== null, LINK_WAIT_FRAMES, (answered) => {
                if (!answered || s.peerAnswer !== true) {
                  s.resetTrade();
                  canceled(finish);
                  return;
                }
                swap(choice.give, choice.take, finish);
              });
              return;
            }
            const o = s.peerOffer;
            if (!o) {
              canceled(finish);
              return;
            }
            const incoming = theirs[o.give];
            const outgoing = this.save.party[o.take];
            if (!incoming || !outgoing) {
              s.answer(false);
              canceled(finish);
              return;
            }
            const subs = {
              wLinkEnemyTrainerName: s.peerName,
              wNameBuffer: nameOf(incoming),
              wStringBuffer: nameOf(outgoing)
            };
            say("_TradeWillTradeText", `{RAM:wLinkEnemyTrainerName} will
trade {RAM:wNameBuffer}`, subs, () => {
              let ask2 = t._TradeforText ?? `for {PLAYER}'s
{RAM:wStringBuffer}.`;
              ask2 = ask2.replace(/\{PLAYER\}/g, String(this.save.player?.name ?? "RED")).replace(/\{RAM:(\w+)\}/g, () => nameOf(outgoing));
              this.showChoice(ask2, (yes) => {
                s.answer(yes);
                if (!yes) {
                  s.resetTrade();
                  canceled(finish);
                  return;
                }
                swap(o.take, o.give, finish);
              });
            });
          }
        }));
      };
      openScreen();
    });
  }
  openDiploma(onDone) {
    this.push(new DiplomaState(this, onDone));
  }
  tradeAnim() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "tradeanim" ? top.view?.() ?? null : null;
  }
  tradeScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "tradescreen" ? top.view?.() ?? null : null;
  }
  diplomaScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "diploma" ? top.view?.() ?? null : null;
  }
  hallOfFameScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "halloffame" ? top.view() : null;
  }
  creditsScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "credits" ? top.view() : null;
  }
  pokedexScreen() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pokedex" ? top.view() : null;
  }
  summary() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "summary" ? top.view() : null;
  }
  startMenu() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "startmenu" ? top.view() : null;
  }
  trainerCard() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "trainercard" ? top.view() : null;
  }
  devMenu() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "devmenu" ? top.view() : null;
  }
  openFlyPicker(monName2, onDone) {
    const t = this.data.text ?? {};
    const here = this.overworld.map?.def;
    if (here && !isOutside(here)) {
      this.showText(t._CannotFlyHereText ?? "You cannot FLY here.", onDone);
      return;
    }
    const dests = flyDestinations(this.data.field, this.save, this.overworld.map?.id);
    if (dests.length === 0) {
      this.showText(t._CannotFlyHereText ?? `You cannot FLY
here.`, onDone);
      return;
    }
    this.push(new FlyPickerState(this, dests, (dest) => this.overworld.startWarpTo(dest.map, dest.x, dest.y, "down", onDone), onDone));
  }
  openElevator(elevatorMapId, onDone) {
    const floors = floorsOf(this.data, elevatorMapId);
    if (floors.length === 0) {
      onDone?.();
      return;
    }
    this.push(new FloorPickerState(this, floors, (floor) => {
      setExit(this.overworld.map?.def, floor);
      this.audio?.playSfx?.("Safari_Zone_PA");
      onDone?.();
    }, onDone));
  }
  floorPicker() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "floorpicker" ? top.view() : null;
  }
  flyPicker() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "flypicker" ? top.view() : null;
  }
  warpPicker() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "warppicker" ? top.view() : null;
  }
  moveForget() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "moveforget" ? top.view() : null;
  }
  title() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "title" ? top.view() : null;
  }
  intro() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "intro" ? top.view() : null;
  }
  showCaughtDexEntry(species) {
    const name = this.data.pokemon[species]?.name ?? species;
    this.showText(`New POKéDEX data
will be added for
${name}!`, () => {
      this.push(new PokedexState(this, undefined, { species }));
    });
  }
  askNickname(defaultName, onDone) {
    this.push(new NamingState(this, {
      title: `${defaultName} NICKNAME?`,
      default: defaultName,
      onDone: (n) => onDone(n === defaultName ? null : n)
    }));
  }
  startTrainerBattle(trainerId, partyIndex = 1, name, onDone, loseable = false) {
    const battle = new TrainerBattle(this.data, this.save, this.battleRng, trainerId, partyIndex, name);
    const st = new BattleGameState(this, "", 0, battle);
    st.onDone = () => onDone?.(battle.finished === "win");
    st.loseable = loseable;
    this.push(st);
  }
  startWildBattle(species, level, opts, onDone) {
    const battle = new WildBattle(this.data, this.save, this.battleRng, species, level);
    battle.noCatch = opts?.noCatch === true;
    if (opts?.disguised)
      battle.makeGhost();
    else if (opts?.unveil)
      battle.makeUnveiledGhost();
    battle.hooked = opts?.hooked === true;
    const st = new BattleGameState(this, species, level, battle);
    st.onDone = () => onDone?.(battle.finished);
    this.push(st);
  }
  startOldManDemo(onDone) {
    const om = this.data.field?.oldManBattle ?? { species: "WEEDLE", level: 5 };
    const battle = new WildBattle(this.data, this.save, this.battleRng, om.species, om.level);
    battle.makeOldManDemo();
    const st = new BattleGameState(this, "", 0, battle);
    st.onDone = () => onDone?.();
    this.push(st);
  }
  naming() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "naming" ? top : null;
  }
  uiChoice() {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "choice" ? top : null;
  }
  battleView() {
    for (let i = this.stack.length - 1;i >= 0; i--) {
      const s = this.stack[i];
      if (s.kind === "battle")
        return s;
    }
    return null;
  }
}

// voxelmon/game/psp-main.ts
var SEED = 17;
var native = globalThis.voxel;
var STICK_RANGE = 156;

class QuickJsHost {
  saveWrite(text) {
    return native.saveWrite(text);
  }
  viewer() {
    native.viewer?.();
  }
  writeTest() {
    return native.writeTest ? native.writeTest() === true : true;
  }
  writeErr() {
    return native.writeErr ? native.writeErr() : undefined;
  }
  saveData() {
    return native.saveData();
  }
  gamedata() {
    return null;
  }
  audiodata() {
    return native.audiodata ? native.audiodata() ?? null : null;
  }
  stats() {
    native.stats();
    return null;
  }
  reset() {
    native.reset();
  }
  mapShow(slot, mapId, ox, oy) {
    native.mapShow(slot, mapId, ox, oy);
  }
  mapHide(slot) {
    native.mapHide(slot);
  }
  cam(x, y) {
    native.cam(x, y);
  }
  pitch(rung) {
    native.pitch(rung);
  }
  tint(abgr) {
    native.tint(abgr);
  }
  stamp(mapId, cx, cy, on) {
    native.stamp(mapId, cx, cy, on);
  }
  palette(index) {
    native.palette(index);
  }
  ent(slot, sheet, frame, x, y, lift, flags) {
    native.ent(slot, sheet, frame, x, y, lift, flags);
  }
  pic(slot, page, x, y, w, h) {
    native.pic(slot, page, x, y, w, h);
  }
  picDepth(slot, depthQ8) {
    native.picDepth(slot, depthQ8);
  }
  picHide(slot) {
    native.picHide(slot);
  }
  entHide(slot) {
    native.entHide(slot);
  }
  emote(slot, kind) {
    native.emote(slot, kind);
  }
  uiTile(x, y, tile) {
    native.uiTile(x, y, tile);
  }
  uiFill(x, y, w, h, tile) {
    native.uiFill(x, y, w, h, tile);
  }
  uiText(x, y, str) {
    native.uiText(x, y, str);
  }
  uiReveal(n) {
    native.uiReveal(n);
  }
  uiClear() {
    native.uiClear();
  }
  uiTileBottom(x, y, tile) {
    native.uiTileBottom(x, y, tile);
  }
  uiFillBottom(x, y, w, h, tile) {
    native.uiFillBottom(x, y, w, h, tile);
  }
  uiClearBottom() {
    native.uiClearBottom();
  }
  uiSpriteBottom(page, x, y, w, h) {
    native.uiSpriteBottom(page, x, y, w, h);
  }
  animSprite(page, tile, x, y, flags) {
    native.animSprite(page, tile, x, y, flags);
  }
  animClear() {
    native.animClear();
  }
  uiPanel(side, x, y, w, h) {
    native.uiPanel(side, x, y, w, h);
  }
  fieldFx(x, z, frame) {
    native.fieldFx(x, z, frame);
  }
  arena(mapId, x, y, shape, rig) {
    native.arena(mapId, x, y, shape, rig);
  }
  card(side, pic2, x, y, dx = 0, dy = 0, dz = 0) {
    native.card(side, pic2, x, y, dx, dy, dz);
  }
  cardHide(side) {
    native.cardHide(side);
  }
  battleCam(orbit, pitch, zoom) {
    native.battleCam(orbit, pitch, zoom);
  }
  arenaEnd() {
    native.arenaEnd();
  }
  music(bank, addr, engine, flags) {
    native.music?.(bank, addr, engine, flags);
  }
  musicStop() {
    native.musicStop?.();
  }
  musicFade(ticks) {
    native.musicFade?.(ticks);
  }
  sfx(bank, addr, engine, pitch, tempo, flags) {
    native.sfx?.(bank, addr, engine, pitch, tempo, flags);
  }
  cry(bank, addr, engine, pitch, length) {
    native.cry?.(bank, addr, engine, pitch, length);
  }
  audioWaves(engine, bank, addr) {
    native.audioWaves?.(engine, bank, addr);
  }
  audioDrum(engine, drum, bank, addr) {
    native.audioDrum?.(engine, drum, bank, addr);
  }
  frameDone(_tick, _buttons) {}
}
var host = new QuickJsHost;
var source = JSON.parse(native.gamedata());
var game = new VoxelmonGame(fromObject(source), host, SEED);
game.setAudioFromPak();
game.boot();
var nat = native;
if (nat.now && nat.perf) {
  game.prof = {
    now: nat.now,
    line: nat.perf,
    upd: 0,
    emit: 0,
    aud: 0,
    maps: 0,
    ents: 0,
    ui: 0
  };
}
var prevTouch = false;
var prevGearNext = false;
var prevGearPrev = false;
globalThis.frame = (buttons) => {
  const phys = buttons & 255;
  const touching = (buttons >> 8 & 1) !== 0;
  if (touching && !prevTouch) {
    const tx = buttons >> 9 & 511;
    const ty = buttons >> 18 & 255;
    gearTouchDown(game, tx, ty);
  } else if (!touching && prevTouch) {
    gearTouchUp(game);
  }
  prevTouch = touching;
  game.setCamTurns(buttons >> 24 & 3);
  native.camSpeed?.(game.cameraSpeedQ8());
  const st = native.stick?.();
  if (st !== undefined) {
    const sx2 = st >> 16 << 16 >> 16;
    const sy2 = st << 16 >> 16;
    game.setStick(sx2, sy2, STICK_RANGE);
  }
  {
    const e = (buttons >> 24 & 3) << 4 | buttons >>> 28 & 15;
    game.setCamYaw(((e - 8) % 64 + 64) % 64 * (Math.PI * 2 / 64));
  }
  const gearNext = (buttons >> 26 & 1) !== 0;
  const gearPrev = (buttons >> 27 & 1) !== 0;
  if (gearNext && !prevGearNext)
    game.cycleGearView(1);
  if (gearPrev && !prevGearPrev)
    game.cycleGearView(-1);
  prevGearNext = gearNext;
  prevGearPrev = gearPrev;
  game.tick(phys);
  drawKantoGear(host, game);
};
