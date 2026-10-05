// Port of gen1recomp src/import/gba/extract_audio.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FireRed M4A song table, track bytecode, DirectSound samples, and cries.
// Samples stored as raw little-endian s8 PCM.
//
// The ROM is a 0-based Uint8Array here (the Lua reads a byte string with
// data:byte(off + 1)); binary outputs are byte strings or Uint8Arrays.
// The Lua tables this module writes with encode_lua_table are plain objects
// (integer-valued keys are the Lua's number keys) or arrays (a Lua sequence:
// element i is key i + 1); encode_lua_table sorts keys as the Lua does, so
// the output never depends on iteration order.

import { Versions } from "./versions.ts";
import { ExtractMapEvents } from "./extract_map_events.ts";
import { MapCatalog } from "./map_catalog.ts";
import { Constants, type ConstantSet } from "../../game/gen3/core/constants.ts";
import { format, fromBytes, mod, tonumber, toBytes, tostring } from "./lua.ts";
import { luaSort } from "./luasort.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

/** A Lua table as this module builds it (see the header). */
type LuaTable = { [k: string]: unknown } | unknown[];
export type AudioRomInput = Uint8Array | string | { data?: Uint8Array | string } | Rom;

// pret sound.c sFanfares[] -- frame durations for waitfanfare.
const FRLG_FANFARES: Record<number, { frames: number; name: string }> = {
  256: { frames: 160, name: "MUS_HEAL" },
  257: { frames: 80, name: "MUS_LEVEL_UP" },
  258: { frames: 160, name: "MUS_OBTAIN_ITEM" },
  259: { frames: 220, name: "MUS_EVOLVED" },
  260: { frames: 340, name: "MUS_OBTAIN_BADGE" },
  261: { frames: 220, name: "MUS_OBTAIN_TMHM" },
  262: { frames: 120, name: "MUS_OBTAIN_BERRY" },
  268: { frames: 250, name: "MUS_SLOTS_JACKPOT" },
  269: { frames: 150, name: "MUS_SLOTS_WIN" },
  270: { frames: 180, name: "MUS_MOVE_DELETED" },
  271: { frames: 160, name: "MUS_TOO_BAD" },
  317: { frames: 196, name: "MUS_DEX_RATING" },
  318: { frames: 170, name: "MUS_OBTAIN_KEY_ITEM" },
  338: { frames: 450, name: "MUS_POKE_FLUTE" },
};

const ROLE_NAMES: Record<string, string> = {
  battleWild: "MUS_VS_WILD", battleTrainer: "MUS_VS_TRAINER",
  battleGymLeader: "MUS_VS_GYM_LEADER", battleChampion: "MUS_VS_CHAMPION",
  victoryWild: "MUS_VICTORY_WILD", victoryTrainer: "MUS_VICTORY_TRAINER",
  victoryGymLeader: "MUS_VICTORY_GYM_LEADER",
  encounterBoy: "MUS_ENCOUNTER_BOY", encounterGirl: "MUS_ENCOUNTER_GIRL",
  encounterRival: "MUS_ENCOUNTER_RIVAL", encounterRocket: "MUS_ENCOUNTER_ROCKET",
  encounterGymLeader: "MUS_ENCOUNTER_GYM_LEADER", pokeCenter: "MUS_POKE_CENTER",
  heal: "MUS_HEAL", surf: "MUS_SURF", cycling: "MUS_CYCLING",
  caught: "MUS_CAUGHT", caughtIntro: "MUS_CAUGHT_INTRO", evolution: "MUS_EVOLUTION",
  evolutionIntro: "MUS_EVOLUTION_INTRO", evolved: "MUS_EVOLVED",
  levelUp: "MUS_LEVEL_UP", obtainItem: "MUS_OBTAIN_ITEM", followMe: "MUS_FOLLOW_ME",
  title: "MUS_TITLE",
};

const PLAYERS: Record<number, string> = { 0: "bgm", 1: "se1", 2: "se2", 3: "cry" };

const SONG_PREFIXES = ["MUS_", "SE_", "PH_"];

const hasOwn = Object.prototype.hasOwnProperty;

// Lua: extract_audio.lua:55
function game_id(): string {
  const id = Versions.active ? Versions.active() : undefined;
  if (typeof id !== "string") throw new Error("extract_audio: no active gen 3 game");
  return id;
}

// Lua: extract_audio.lua:61
function game_constants(id?: string): ConstantSet {
  return Constants.of(id ?? game_id());
}

// Lua: extract_audio.lua:65
function song_id(C: ConstantSet, name: string): number | undefined {
  const byName = C.songs.byName as Record<string, unknown>;
  const id = hasOwn.call(byName, name) ? byName[name] : undefined;
  if (typeof id !== "number") return undefined;
  return id;
}

// Lua: extract_audio.lua:71
function song_name(C: ConstantSet, id: number | undefined): string | undefined {
  if (id === undefined) return undefined;
  for (const prefix of SONG_PREFIXES) {
    const names = C.songs.byId[prefix] as Record<number, string> | undefined;
    if (names && names[id] !== undefined) return names[id];
  }
  return undefined;
}

// Lua: extract_audio.lua:86
function write(cache: Cache | undefined, path: string, data: string | Uint8Array): boolean {
  if (cache && cache.write) return cache.write(path, data);
  // NOT FAITHFUL: the Lua falls back to love.filesystem.write; the port has
  // no global filesystem (callers always pass a cache).
  return false;
}

// Lua: extract_audio.lua:96 -- the ROM bytes (0-based)
function rom_bytes(rom: AudioRomInput | undefined): Uint8Array | undefined {
  if (typeof rom === "string") return toBytes(rom);
  if (rom instanceof Uint8Array) return rom;
  if (rom && typeof rom === "object") {
    const d = (rom as { data?: unknown }).data;
    if (typeof d === "string") return toBytes(d);
    if (d instanceof Uint8Array) return d;
    if (typeof (rom as Rom).ensureBuffer === "function") return (rom as Rom).ensureBuffer();
  }
  return undefined;
}

// Lua: extract_audio.lua:103
function ru8(data: Uint8Array, off: number): number | undefined {
  if (off < 0 || off >= data.length) return undefined;
  return data[off];
}

// Lua: extract_audio.lua:108
function ru16(data: Uint8Array, off: number): number | undefined {
  const b0 = ru8(data, off), b1 = ru8(data, off + 1);
  if (b0 === undefined || b1 === undefined) return undefined;
  return b0 + b1 * 256;
}

// Lua: extract_audio.lua:114 (the Lua only checks b0; a short read past the end errors there)
function ru32(data: Uint8Array, off: number): number | undefined {
  const b0 = ru8(data, off), b1 = ru8(data, off + 1), b2 = ru8(data, off + 2), b3 = ru8(data, off + 3);
  if (b0 === undefined) return undefined;
  if (b1 === undefined || b2 === undefined || b3 === undefined) throw new Error("attempt to perform arithmetic on a nil value");
  return b0 + b1 * 256 + b2 * 65536 + b3 * 16777216;
}

// Lua: extract_audio.lua:120
function gba_off(ptr: number | undefined): number | undefined {
  if (ptr === undefined || ptr < 0x08000000 || ptr >= 0x0A000000) return undefined;
  return ptr - 0x08000000;
}

// Lua: extract_audio.lua:153
function append_bytes(parts: string[], data: Uint8Array, off: number, len: number): void {
  if (len <= 0) return;
  parts.push(fromBytes(data, Math.max(off, 0), Math.min(off + len, data.length)));
}

/** A table's keys as the Lua sees them: [key, isNumber][] (absent/undefined values skipped). */
function luaEntries(tbl: LuaTable): [string | number, unknown][] {
  const out: [string | number, unknown][] = [];
  if (Array.isArray(tbl)) {
    tbl.forEach((v, i) => { if (v !== undefined && v !== null) out.push([i + 1, v]); });
    return out;
  }
  for (const k of Object.keys(tbl)) {
    const v = tbl[k];
    if (v === undefined || v === null) continue;
    out.push([/^-?(0|[1-9]\d*)$/.test(k) ? Number(k) : k, v]);
  }
  return out;
}

// Lua: extract_audio.lua:158
function encode_lua_table(tbl: LuaTable, indent = ""): string {
  const parts: string[] = ["{\n"];
  const entries = luaEntries(tbl);
  luaSort(entries, (ea, eb) => {
    const a = ea[0], b = eb[0];
    const ta = typeof a, tb = typeof b;
    if (ta === tb && ta === "number") return (a as number) < (b as number);
    if (ta === "number") return true;
    if (tb === "number") return false;
    return tostring(a) < tostring(b);
  });
  for (const [k, v] of entries) {
    const ks = typeof k === "number" ? format("[%s]", k) : format("[%q]", tostring(k));
    if (typeof v === "object") {
      parts.push(indent + "  " + ks + " = " + encode_lua_table(v as LuaTable, indent + "  ") + ",\n");
    } else if (typeof v === "string") {
      parts.push(indent + "  " + ks + " = " + format("%q", v) + ",\n");
    } else if (typeof v === "boolean") {
      parts.push(indent + "  " + ks + " = " + tostring(v) + ",\n");
    } else if (typeof v === "number") {
      parts.push(indent + "  " + ks + " = " + tostring(v) + ",\n");
    }
  }
  parts.push(indent + "}");
  return parts.join("");
}

// GameFreak DPCM (WaveData.type == 1): 64 samples -> 0x21 bytes per block.
// Matches agbplay MP2KChnPCM::sampleFetchCallbackGFDPCMDecomp / pret gDeltaEncodingTable.
const DPCM_DELTA = [0, 1, 4, 9, 16, 25, 36, 49, -64, -49, -36, -25, -16, -9, -4, -1];

// Lua: extract_audio.lua:195
function s8_byte(b: number): number {
  return b >= 128 ? b - 256 : b;
}

// Lua: extract_audio.lua:199
function clamp_s8(v: number): number {
  if (v > 127) return 127;
  if (v < -128) return -128;
  return v;
}

// Lua: extract_audio.lua:206 -- GameFreak DPCM -> raw s8 samples (length = sampleCount).
function decode_gfdpcm(data: Uint8Array, pcmOff: number, sampleCount: number | undefined): Uint8Array {
  sampleCount = sampleCount ?? 0;
  if (sampleCount <= 0) return new Uint8Array(0);
  let blocks = Math.ceil(sampleCount / 64);
  const need = blocks * 0x21;
  if (pcmOff + need > data.length) {
    // Truncate to available blocks
    blocks = Math.floor((data.length - pcmOff) / 0x21);
    sampleCount = Math.min(sampleCount, blocks * 64);
    if (sampleCount <= 0) return new Uint8Array(0);
  }
  const out = new Uint8Array(sampleCount);
  let n = 0;
  const push = (v: number): void => {
    v = clamp_s8(v);
    out[n] = mod(v + 256, 256);
    n = n + 1;
  };
  for (let bi = 0; bi < blocks; bi++) {
    const bp = pcmOff + bi * 0x21;
    let acc = s8_byte(data[bp]!);
    push(acc);
    if (n >= sampleCount) break;
    acc = acc + DPCM_DELTA[data[bp + 1]! % 16]!;
    push(acc);
    if (n >= sampleCount) break;
    for (let h = 2; h <= 32; h++) {
      const byte = data[bp + h]!;
      acc = acc + DPCM_DELTA[Math.floor(byte / 16) % 16]!;
      push(acc);
      if (n >= sampleCount) break;
      acc = acc + DPCM_DELTA[byte % 16]!;
      push(acc);
      if (n >= sampleCount) break;
    }
    if (n >= sampleCount) break;
  }
  return out.subarray(0, n);
}

interface SampleMeta {
  id: number; type: number; compressed: boolean; status: number; freq: number;
  loopStart: number; size: number; offset: number;
}
interface SampleState { map: Map<number, SampleMeta>; parts: Uint8Array[]; cursor: number[] }

// Lua: extract_audio.lua:246
function read_wave(data: Uint8Array, wavOff: number, st: SampleState): SampleMeta {
  const known = st.map.get(wavOff);
  if (known) return known;
  const typ = ru16(data, wavOff) ?? 0;
  // WaveData.type low byte: 0 = linear s8 PCM, 1 = GameFreak DPCM
  const compressed = typ % 256 === 1;
  const status = ru16(data, wavOff + 2) ?? 0;
  const freq = ru32(data, wavOff + 4) ?? 0;
  const loopStart = ru32(data, wavOff + 8) ?? 0;
  let size = ru32(data, wavOff + 12) ?? 0; // decoded sample count
  if (size > 2 * 1024 * 1024) size = 0;
  const pcmOff = wavOff + 16;
  const id = st.map.size + 1;
  const entry: SampleMeta = { id, type: typ, compressed, status, freq, loopStart, size, offset: st.cursor[0]! };
  st.map.set(wavOff, entry);
  if (size > 0) {
    let pcm: Uint8Array | undefined;
    if (compressed) {
      pcm = decode_gfdpcm(data, pcmOff, size);
    } else if (pcmOff + size <= data.length) {
      pcm = data.slice(pcmOff, pcmOff + size);
    }
    if (pcm && pcm.length > 0) {
      entry.size = pcm.length;
      st.parts.push(pcm);
      st.cursor[0] = st.cursor[0]! + pcm.length;
    } else {
      entry.size = 0;
    }
  } else {
    entry.size = 0;
  }
  return entry;
}

// Lua: extract_audio.lua:293 -- [sample | undefined, type]
function read_tone_sample(data: Uint8Array, toneOff: number, st: SampleState): [SampleMeta | undefined, number] {
  const typ = ru8(data, toneOff) ?? 0;
  // DirectSound / fixed: type bits without CGB/SPL/RHY
  if (typ >= 0x40) {
    // SPL/RHY -- wav field is a sub-voicegroup pointer, not WaveData
    return [undefined, typ];
  }
  const kind = typ % 8;
  if (kind === 1 || kind === 2 || kind === 3 || kind === 4) {
    // CGB square/wave/noise -- no DirectSound WaveData
    return [undefined, typ];
  }
  const wavPtr = ru32(data, toneOff + 4);
  const wavOff = gba_off(wavPtr);
  if (wavOff === undefined) return [undefined, typ];
  return [read_wave(data, wavOff, st), typ];
}

// Lua: extract_audio.lua:312 -- primary DirectSound sample for a song (voice 0), for SE-first playback.
function song_primary_sample(data: Uint8Array, headerOff: number, st: SampleState): number | undefined {
  const vgPtr = ru32(data, headerOff + 4);
  const vgOff = gba_off(vgPtr);
  if (vgOff === undefined) return undefined;
  const [sample] = read_tone_sample(data, vgOff, st);
  return sample ? sample.id : undefined;
}

// Lua: extract_audio.lua:321 -- Dump one voicegroup (128 ToneData). SPL/RHY recurse into sub-groups once.
function dump_voicegroup(data: Uint8Array, vgOff: number | undefined, st: SampleState,
  vgMap: Map<number, number>, voicegroups: Record<number, unknown>, depth?: number): number | undefined {
  if (vgOff === undefined || (depth ?? 0) > 5) return undefined;
  const known = vgMap.get(vgOff);
  if (known !== undefined) return known;
  const id = vgMap.size + 1;
  vgMap.set(vgOff, id);
  const tones: Record<number, Record<string, unknown>> = {};
  for (let i = 0; i <= 127; i++) {
    const toff = vgOff + i * 12;
    if (toff + 12 > data.length) break;
    const typ = ru8(data, toff) ?? 0;
    const entry: Record<string, unknown> = {
      type: typ,
      key: ru8(data, toff + 1) ?? 60,
      length: ru8(data, toff + 2) ?? 0,
      pan: ru8(data, toff + 3) ?? 0,
    };
    const spl = Math.floor(typ / 64) % 2 === 1;
    const rhy = typ >= 128;
    if (spl || rhy) {
      const subOff = gba_off(ru32(data, toff + 4));
      if (subOff !== undefined) {
        entry.subVgId = dump_voicegroup(data, subOff, st, vgMap, voicegroups, (depth ?? 0) + 1);
      }
      if (spl) {
        // KeySplitTable* is packed where attack..release normally live.
        const ksOff = gba_off(ru32(data, toff + 8));
        if (ksOff !== undefined && ksOff + 128 <= data.length) {
          const ks: Record<number, number> = {};
          for (let k = 0; k <= 127; k++) ks[k] = ru8(data, ksOff + k) ?? 0;
          entry.keySplit = ks;
        }
      }
    } else {
      const kind = typ % 8;
      if (kind === 0) {
        const [sample] = read_tone_sample(data, toff, st);
        entry.sampleId = sample ? sample.id : undefined;
        entry.attack = ru8(data, toff + 8) ?? 0xFF;
        entry.decay = ru8(data, toff + 9) ?? 0;
        entry.sustain = ru8(data, toff + 10) ?? 0xFF;
        entry.release = ru8(data, toff + 11) ?? 0;
      } else {
        // CGB: square stores duty in wav low bits; wave ch.3 points at 16-byte nibble table.
        const wavParam = ru32(data, toff + 4) ?? 0;
        entry.wavParam = wavParam;
        entry.attack = ru8(data, toff + 8) ?? 0;
        entry.decay = ru8(data, toff + 9) ?? 0;
        entry.sustain = ru8(data, toff + 10) ?? 0;
        entry.release = ru8(data, toff + 11) ?? 0;
        if (kind === 3) {
          const waveOff = gba_off(wavParam);
          if (waveOff !== undefined && waveOff + 16 <= data.length) {
            const wave: number[] = []; // a Lua sequence (keys 1..32)
            for (let bi = 0; bi <= 15; bi++) {
              const b = ru8(data, waveOff + bi) ?? 0;
              wave.push(Math.floor(b / 16) % 16);
              wave.push(b % 16);
            }
            entry.wave = wave;
          }
        }
      }
    }
    tones[i] = entry;
  }
  voicegroups[id] = tones;
  return id;
}

// Command operand lengths for 0xCD (XCMD), keys 0..13.
const XARGS = [0, 4, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 4];

/**
 * Lua: extract_audio.lua:398 -- Walk reachable bytecode, including patterns
 * beyond FINE or before the entry. Returns [body, entry - first, hasGoto].
 */
function collect_track(data: Uint8Array, entry: number): [string, number, boolean] {
  const pending: { pc: number; pattern: boolean }[] = [{ pc: entry, pattern: false }];
  const visited = new Set<number>();
  const pointers = new Map<number, number>();
  let first = entry, last = entry;
  let budget = 65536;
  let hasGoto = false;
  while (pending.length > 0) {
    const branch = pending.pop()!;
    let pc = branch.pc;
    const pattern = branch.pattern;
    while (pc >= 0 && pc < data.length) {
      const state = pc * 2 + (pattern ? 1 : 0);
      if (visited.has(state)) break;
      budget = budget - 1;
      if (budget < 0) throw new Error("M4A track exceeds bytecode limit");
      visited.add(state);
      const cmd = ru8(data, pc)!;
      let length = 1, stop = false;
      let pointer: number | undefined;
      if (cmd === 0xB2 || cmd === 0xB3) {
        length = 5; pointer = pc + 1;
        stop = cmd === 0xB2;
        if (stop) hasGoto = true;
      } else if (cmd === 0xB5) {
        length = 6; pointer = pc + 2;
      } else if (cmd === 0xB4) {
        // Inline patterns fall through PEND on their first, uncalled pass.
        stop = pattern;
      } else if (cmd === 0xB9) {
        length = 4;
        const op = ru8(data, pc + 1) ?? 0;
        if (op >= 6 && op <= 17) { length = 8; pointer = pc + 4; }
      } else if (cmd === 0xCD) {
        const op = ru8(data, pc + 1) ?? 0;
        length = 2 + (XARGS[op] ?? 0);
        stop = op === 0 || op === 3 || XARGS[op] === undefined;
      } else if (cmd === 0xCC) { // PORT: register offset, value
        length = 3;
      } else if ((cmd >= 0xBA && cmd <= 0xC5) || cmd === 0xC8) {
        length = 2;
      } else if ((cmd >= 0xB1 && cmd <= 0xB8) || cmd === 0xC6 || cmd === 0xC7 || (cmd >= 0xC9 && cmd <= 0xCB)) {
        stop = true; // FINE, PEND, or an unused command mapped to ply_fine
      }
      if (pc + length > data.length) throw new Error("Truncated M4A instruction");
      first = Math.min(first, pc);
      last = Math.max(last, pc + length);
      if (last - first > 1024 * 1024) throw new Error("M4A track span exceeds limit");
      if (pointer !== undefined) {
        const target = gba_off(ru32(data, pointer));
        if (target === undefined || target >= data.length) throw new Error("Invalid M4A branch pointer");
        pointers.set(pointer, target);
        pending.push({ pc: target, pattern: cmd === 0xB3 || pattern });
      }
      if (stop) break;
      pc = pc + length;
    }
  }
  const le32 = (value: number): string => String.fromCharCode(mod(value, 256), mod(Math.floor(value / 256), 256),
    mod(Math.floor(value / 65536), 256), mod(Math.floor(value / 16777216), 256));
  const ordered = luaSort([...pointers.keys()]);
  const parts: string[] = [];
  let cursor = first;
  for (const pointer of ordered) {
    parts.push(fromBytes(data, cursor, Math.max(cursor, pointer)));
    parts.push(le32(pointers.get(pointer)! - first));
    cursor = pointer + 4;
  }
  parts.push(fromBytes(data, cursor, Math.max(cursor, last)));
  return [parts.join(""), entry - first, hasGoto];
}

/**
 * Lua: extract_audio.lua:473 -- Packed song bin: header + (offset,length,entry)
 * per track. Returns [bytes, tracks, hasGoto].
 */
function dump_song_tracks(data: Uint8Array, headerOff: number, songId: number, cache: Cache | undefined, root: string): [number, number, boolean] {
  let tracks = ru8(data, headerOff) ?? 0;
  if (tracks === 0 || tracks > 16) tracks = 0;
  const blocks = ru8(data, headerOff + 1) ?? 0;
  const priority = ru8(data, headerOff + 2) ?? 0;
  const reverb = ru8(data, headerOff + 3) ?? 0;
  const vgPtr = ru32(data, headerOff + 4) ?? 0;

  const romOffs: (number | undefined)[] = [];
  for (let t = 0; t < tracks; t++) romOffs[t] = gba_off(ru32(data, headerOff + 8 + t * 4));

  const headerSize = 8 + tracks * 12;
  let cursor = headerSize;
  const trackMeta: { offset: number; length: number; entry: number }[] = [];
  const bodyParts: string[] = [];
  let hasGoto = false;
  for (let t = 0; t < tracks; t++) {
    const off = romOffs[t];
    let body = "", entry = 0;
    if (off !== undefined) {
      let loop: boolean;
      [body, entry, loop] = collect_track(data, off);
      hasGoto = hasGoto || loop;
    }
    trackMeta[t] = { offset: cursor, length: body.length, entry };
    bodyParts.push(body);
    cursor = cursor + body.length;
  }

  const u32le = (v: number): string => String.fromCharCode(mod(v, 256), mod(Math.floor(v / 256), 256),
    mod(Math.floor(v / 65536), 256), mod(Math.floor(v / 16777216), 256));
  const hdr: string[] = [
    String.fromCharCode(tracks % 256, blocks % 128 + 128, priority % 256, reverb % 256),
    u32le(vgPtr),
  ];
  for (let t = 0; t < tracks; t++) {
    const m = trackMeta[t] ?? { offset: 0, length: 0, entry: 0 };
    hdr.push(u32le(m.offset) + u32le(m.length) + u32le(m.entry ?? 0));
  }
  const blob = hdr.join("") + bodyParts.join("");
  write(cache, format("%s/songs/%d.bin", root, songId), blob);
  return [blob.length, tracks, hasGoto];
}

/**
 * Lua: extract_audio.lua:526 -- map id -> song from each map header.
 * A Rom (with u16) parses the header; a bare byte buffer (runIntroAudio's
 * romShim) reads the music field at +16.
 */
function build_map_songs_frlg(rom: AudioRomInput | undefined, data: Uint8Array | undefined): Record<string, number> {
  const mapSongs: Record<string, number> = {};
  const headers = Versions.MAP_HEADERS;
  if (headers === null || typeof headers !== "object") return mapSongs;
  for (const mapId of Object.keys(headers)) {
    const headerOff = headers[mapId] as number;
    let music: number | undefined;
    if (rom && typeof rom === "object" && typeof (rom as Rom).u16 === "function") {
      const hdr = ExtractMapEvents.parseHeader(rom as Rom, headerOff);
      music = hdr ? hdr.music : undefined;
    } else if (data) {
      music = ru16(data, headerOff + 16);
    }
    if (music !== undefined && music !== 0xFFFF) mapSongs[mapId] = music;
  }
  return mapSongs;
}

// Lua: extract_audio.lua:576
function species_to_cry_index_frlg(species: unknown, cryCount: number): number {
  const sp = tonumber(species) ?? 0;
  // Audible mapping: Bulbasaur (1) -> gCryTable[0].
  if (sp < 1) return 0;
  if (sp < 251) return sp - 1;
  if (sp <= 276) return 200; // OLD_UNOWN_Z = 276 -> SPECIES_UNOWN - 1
  // Hoenn: approximate national order into cry table (Treecko~277 -> cry ~251+)
  let idx = 251 + (sp - 277);
  if (idx < 0) idx = 0;
  if (idx >= cryCount) idx = cryCount - 1;
  return idx;
}

// Lua: extract_audio.lua:626
function read_cries(data: Uint8Array, tableOff: number, count: number, st: SampleState): Record<number, Record<string, unknown>> {
  const cries: Record<number, Record<string, unknown>> = {};
  for (let i = 0; i < count; i++) {
    const toneOff = tableOff + i * 12;
    const [sample] = read_tone_sample(data, toneOff, st);
    cries[i] = {
      sampleId: sample ? sample.id : undefined,
      key: ru8(data, toneOff + 1) ?? 60,
      attack: ru8(data, toneOff + 8) ?? 0xFF,
      decay: ru8(data, toneOff + 9) ?? 0,
      sustain: ru8(data, toneOff + 10) ?? 0xFF,
      release: ru8(data, toneOff + 11) ?? 0,
      basePitch: sample ? sample.freq : 0,
    };
  }
  return cries;
}

// Lua: extract_audio.lua:644
function audio_params(): Record<string, any> {
  const A = Versions.AUDIO;
  if (A === null || typeof A !== "object" || !(A.song_table && A.song_count && A.cry_table && A.cry_count)) {
    throw new Error("extract_audio: " + game_id() + " has no AUDIO table");
  }
  return A;
}

export const ExtractAudio = {
  REQUIRED: [
    "audio/index.lua",
    "audio/songtable.bin",
    "audio/crytable.bin",
    "audio/samples.bin",
    "audio/samples.lua",
    "audio/cries.lua",
    "audio/voicegroups.lua",
  ],

  // Lua: extract_audio.lua:79
  resolveRoles(C: ConstantSet, extra?: Record<string, string>): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {};
    for (const role of Object.keys(ROLE_NAMES)) out[role] = song_id(C, ROLE_NAMES[role]!);
    for (const role of Object.keys(extra ?? {})) out[role] = song_id(C, extra![role]!);
    return out;
  },

  // Lua: extract_audio.lua:125
  isSongTable(data: Uint8Array, base: number | undefined, count: number, titleId: number): boolean {
    if (base === undefined || base < 0 || base + count * 8 > data.length) return false;
    if (titleId + 1 > count) return false;
    const h0 = ru32(data, base);
    if (!(h0 !== undefined && h0 >= 0x08000000 && h0 < 0x09000000
      && ru16(data, base + 4) === 0 && ru16(data, base + 6) === 0)) {
      return false;
    }
    const e5 = base + 5 * 8;
    const h5 = ru32(data, e5);
    if (!(ru16(data, e5 + 4) === 2 && ru16(data, e5 + 6) === 2
      && h5 !== undefined && h5 >= 0x08000000 && h5 < 0x09000000
      && ru16(data, base + 8 + 4) === 1 && ru16(data, base + 8 + 6) === 1)) {
      return false;
    }
    const et = base + titleId * 8;
    return ru16(data, et + 4) === 0 && ru16(data, et + 6) === 0;
  },

  // Lua: extract_audio.lua:144
  findSongTable(data: Uint8Array, count: number, titleId: number | undefined, hint?: number): number | undefined {
    if (typeof count !== "number" || typeof titleId !== "number") throw new Error("findSongTable: count and title id required");
    if (hint !== undefined && ExtractAudio.isSongTable(data, hint, count, titleId)) return hint;
    for (let base = 0; base <= data.length - count * 8; base += 4) {
      if (ExtractAudio.isSongTable(data, base, count, titleId)) return base;
    }
    return undefined;
  },

  /**
   * Lua: extract_audio.lua:548 -- pokeemerald/include/global.fieldmap.h:177
   * (the map_groups constants' groups list is 0-based here: the Lua's
   * groups[g] is groups[g - 1]; names keyed "group:num" as the Lua builds them)
   */
  buildMapSongsRse(data: Uint8Array, C: ConstantSet,
    mapIdFor: (name: string, group: number, num: number) => string | undefined): Record<string, number> {
    const groupsOff: number = Versions.G_MAP_GROUPS;
    const numGroups: number = Versions.NUM_MAP_GROUPS;
    const names: Record<string, string> = {};
    const byName = C.map_groups.byName as Record<string, { group: number; num: number; name: string }>;
    for (const k of Object.keys(byName)) {
      const row = byName[k]!;
      names[tostring(row.group) + ":" + tostring(row.num)] = row.name;
    }
    const mapSongs: Record<string, number> = {};
    const none = song_id(C, "MUS_NONE");
    const groups = C.map_groups.groups as { count: number }[] | Record<number, { count: number }>;
    const groupAt = (g: number): { count: number } | undefined =>
      Array.isArray(groups) ? groups[g - 1] : (groups as Record<number, { count: number }>)[g];
    for (let g = 1; groupAt(g) !== undefined; g++) {
      const info = groupAt(g)!;
      const group = g - 1;
      if (group >= numGroups) break;
      const listOff = gba_off(ru32(data, groupsOff + group * 4));
      if (listOff === undefined) throw new Error(format("extract_audio: bad gMapGroups[%d] pointer", group));
      for (let num = 0; num < info.count; num++) {
        const headerOff = gba_off(ru32(data, listOff + num * 4));
        const name = names[tostring(group) + ":" + tostring(num)];
        if (!(headerOff !== undefined && name)) throw new Error(format("extract_audio: map %d.%d has no header", group, num));
        const music = ru16(data, headerOff + 16);
        if (music !== undefined && music !== none) {
          const id = mapIdFor(name, group, num);
          if (id === undefined) throw new Error("table index is nil");
          mapSongs[id] = music;
        }
      }
    }
    return mapSongs;
  },

  // Lua: extract_audio.lua:596 -- pokeemerald/src/pokemon.c:5701 (out[sp] for sp 1..numSpecies-1)
  cryIdsFromTable(data: Uint8Array, tableOff: number, tableCount: number, species: Record<string, number>, numSpecies: number): Record<number, number | undefined> {
    const celebi = species.SPECIES_CELEBI!;
    const treecko = species.SPECIES_TREECKO!;
    const unown = species.SPECIES_UNOWN!;
    const out: Record<number, number | undefined> = {};
    for (let sp = 1; sp <= numSpecies - 1; sp++) {
      const s = sp - 1;
      if (s <= celebi - 1) {
        out[sp] = s;
      } else if (s < treecko - 1) {
        out[sp] = unown - 1;
      } else {
        const i = s - (treecko - 1);
        if (i >= tableCount) throw new Error(format("extract_audio: species %d past gSpeciesIdToCryId", sp));
        out[sp] = ru16(data, tableOff + i * 2);
      }
    }
    return out;
  },

  // Lua: extract_audio.lua:616
  readFanfares(data: Uint8Array, off: number, count: number, C: ConstantSet): Record<number, { frames?: number; name?: string }> {
    const out: Record<number, { frames?: number; name?: string }> = {};
    for (let i = 0; i < count; i++) {
      const song = ru16(data, off + i * 4);
      const frames = ru16(data, off + i * 4 + 2);
      if (song === undefined) throw new Error("table index is nil");
      out[song] = { frames, name: song_name(C, song) };
    }
    return out;
  },

  // Lua: extract_audio.lua:652
  ready(cache: Cache, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? "data/generated/gba") + "/audio";
    const meta = cache.read(root + "/meta.json");
    if (typeof meta !== "string" || /"stub"\s*:\s*true/.test(meta)) return false;
    const m = /"version"\s*:\s*(\d+)/.exec(meta);
    const v = m ? tonumber(m[1]) : undefined;
    if (v !== (Versions.AUDIO_VERSION ?? 1)) return false;
    return cache.exists(root + "/index.lua");
  },

  // Lua: extract_audio.lua:661 -- [true, index]
  run(rom: AudioRomInput | undefined, cache: Cache | undefined, opts: { root?: string; cacheRoot?: string; sha1?: string } = {}): [boolean, Record<string, unknown>] {
    const root = opts.root ?? ((opts.cacheRoot ?? "data/generated/gba") + "/audio");
    const data = rom_bytes(rom);
    if (!data) throw new Error("extract_audio: no ROM bytes");
    const A = audio_params();
    const game = game_id();
    const C = game_constants(game);
    const rse = Versions.FAMILY === "rse";
    const sha1 = opts.sha1 ?? ((rse && rom && typeof rom === "object" && (rom as Rom).md5) || "");
    const FANFARES: Record<number, { frames?: number; name?: string }> = rse
      ? ExtractAudio.readFanfares(data, A.fanfares, A.fanfare_count, C) : FRLG_FANFARES;
    const ROLES = ExtractAudio.resolveRoles(C, A.roles);
    const songs: Record<number, Record<string, unknown>> = {};
    let cries: Record<number, Record<string, unknown>> = {};
    let cryIds: Record<number, number | undefined> = {};
    const sampleIndex: Record<number, Record<string, unknown>> = {}; // id -> meta
    const st: SampleState = { map: new Map(), parts: [], cursor: [0] }; // wavOff -> meta
    const vgMap = new Map<number, number>(); // vgOff -> id
    const voicegroups: Record<number, unknown> = {}; // id -> tones[0..127]

    const songCount: number = A.song_count;
    const titleId = song_id(C, "MUS_TITLE");
    const songTable = ExtractAudio.findSongTable(data, songCount, titleId, A.song_table);
    if (songTable === undefined) throw new Error("extract_audio: gSongTable not found in " + game + " ROM");

    // Song table binary + per-song metadata / track dumps / primary samples.
    const songtableParts: string[] = [];
    append_bytes(songtableParts, data, songTable, songCount * 8);
    write(cache, root + "/songtable.bin", songtableParts.join(""));

    for (let id = 0; id < songCount; id++) {
      const off = songTable + id * 8;
      const headerPtr = ru32(data, off);
      const ms = ru16(data, off + 4) ?? 0;
      const me = ru16(data, off + 6) ?? 0;
      const headerOff = gba_off(headerPtr);
      const fan = hasOwn.call(FANFARES, id) ? FANFARES[id] : undefined;
      const info: Record<string, unknown> = {
        id,
        player: ms,
        playerEnd: me,
        kind: (ms === 0 && id >= 256 && fan) ? "fanfare" : ms === 0 ? "bgm" : "se",
      };
      if (fan) {
        info.kind = "fanfare";
        info.fanfareFrames = fan.frames;
        info.name = fan.name;
      }
      if (headerOff !== undefined) {
        info.tracks = ru8(data, headerOff);
        info.priority = ru8(data, headerOff + 2);
        info.reverb = ru8(data, headerOff + 3);
        info.loop = info.kind === "bgm";
        const [nbytes, , hasGoto] = dump_song_tracks(data, headerOff, id, cache, root);
        info.hasGoto = hasGoto;
        info.songBytes = nbytes;
        info.sampleId = song_primary_sample(data, headerOff, st);
        const vgOff = gba_off(ru32(data, headerOff + 4));
        if (vgOff !== undefined) info.voicegroupId = dump_voicegroup(data, vgOff, st, vgMap, voicegroups, 0);
      } else {
        info.missing = true;
      }
      songs[id] = info;
    }

    // Cry table -> samples
    const cryTable: number = A.cry_table;
    const cryCount: number = A.cry_count;
    if (cryTable + cryCount * 12 <= data.length) {
      write(cache, root + "/crytable.bin", fromBytes(data, cryTable, cryTable + cryCount * 12));
      cries = read_cries(data, cryTable, cryCount, st);
    } else if (rse) {
      throw new Error("extract_audio: gCryTable out of range");
    }

    let criesReverse: Record<number, Record<string, unknown>> | undefined;
    let cryTableReverse: number | undefined;
    if (A.cry_table_reverse) {
      cryTableReverse = A.cry_table_reverse as number;
      const n: number = A.cry_table_reverse_count ?? cryCount;
      write(cache, root + "/crytable_reverse.bin", fromBytes(data, cryTableReverse, Math.min(data.length, cryTableReverse + n * 12)));
      criesReverse = read_cries(data, cryTableReverse, n, st);
    }

    if (A.cry_id_table) {
      cryIds = ExtractAudio.cryIdsFromTable(data, A.cry_id_table, A.cry_id_count, C.species.byName, Versions.NUM_SPECIES);
    } else {
      for (let species = 1; species <= 411; species++) cryIds[species] = species_to_cry_index_frlg(species, cryCount);
    }

    // Flatten sampleMap -> sampleIndex by id
    for (const meta of st.map.values()) {
      sampleIndex[meta.id] = {
        id: meta.id,
        type: meta.type,
        compressed: !!meta.compressed,
        status: meta.status,
        freq: meta.freq,
        loopStart: meta.loopStart,
        size: meta.size,
        offset: meta.offset,
      };
    }

    let total = 0;
    for (const p of st.parts) total += p.length;
    const samplesBin = new Uint8Array(total);
    let at = 0;
    for (const p of st.parts) { samplesBin.set(p, at); at += p.length; }
    write(cache, root + "/samples.bin", samplesBin);
    write(cache, root + "/samples.lua", "return " + encode_lua_table(sampleIndex) + "\n");
    write(cache, root + "/cries.lua", "return " + encode_lua_table(cries) + "\n");
    write(cache, root + "/voicegroups.lua", "return " + encode_lua_table(voicegroups as LuaTable) + "\n");

    let mapSongs: Record<string, number>;
    if (rse) {
      mapSongs = ExtractAudio.buildMapSongsRse(data, C, (name, group, num) =>
        MapCatalog.mapIdFor(group, num) ?? MapCatalog.pretToEngine(name));
    } else {
      mapSongs = build_map_songs_frlg(rom, data);
    }

    const index: Record<string, unknown> = {
      version: Versions.AUDIO_VERSION ?? 1,
      romSha1: sha1,
      songCount,
      songTable,
      cryTable,
      cryCount,
      players: PLAYERS,
      songs,
      cries,
      cryIds,
      cryTableReverse,
      criesReverse,
      samples: sampleIndex,
      voicegroups,
      mapSongs,
      roles: ROLES,
      fanfares: FANFARES,
      none: 0xFFFF,
    };

    write(cache, root + "/index.lua", "return " + encode_lua_table(index) + "\n");
    write(cache, root + "/meta.json", format(
      '{"version":%d,"sha1":"%s","song_count":%d,"cry_count":%d,"sample_count":%d,"has_pcm":true}\n',
      index.version, tostring(sha1), songCount, cryCount, Object.keys(sampleIndex).length));

    // Legacy filenames for older dataset paths
    write(cache, root + "/songs.lua", "return " + encode_lua_table(songs) + "\n");
    write(cache, root + "/se.lua", "return {}\n");

    return [true, index];
  },

  _encodeLuaTable: encode_lua_table,
};

export default ExtractAudio;
