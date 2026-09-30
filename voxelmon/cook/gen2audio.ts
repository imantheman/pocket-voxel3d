// Gold's audio manifest, as the Gen 2 guest reads it.
//
// The importer's audio.json (import/gen2/audio.ts, Brian's extractAudio
// shape) names every song, sfx and cry by {bank, address}. That is all the
// synth needs, but gen1recomp's Sound/Music also ask the PLAYING SOURCE how
// long it has left: WaitSFX, WaitPlaySFX, isPlaying, a playOnce jingle's
// restore (Sound.lua:188-197 waitFrames, :394 sfxBusy, Music.lua:629-649).
// Here the source is the core's synth, and the guest may not ask it anything
// -- a host that never pumps PCM never ends a sound. So the cook measures
// each program once, with the Gen 2 driver's own clock, and the guest counts
// frames against that.
//
// What this adds to the table (Brian's fields are untouched):
//   sfx[name].frames        60 Hz frames until the one-shot's last channel ends
//   sfx[name].channelCount  channels its header claims (Sound.lua:242 ducks
//                           a four-channel sfx; effectChannels without banks)
//   cries[species].frames   the same, with the species' length as the tempo
//   songs[name].frames      one pass without looping (playOnce's jingles)
//
// The walk is the timing half of crates/pocketvoxel-core audio.rs
// next_event_gen2, itself ChipSynth.lua@bdfac727:680-900 + :397-424: the
// same argument sizes, the same SetNoteDuration truncation, the same shared
// engine tempo, channels stepped in (time, channel) order the way the synth
// interleaves them. Every Gen 2 duration is whole frames, so frames are
// exact, not estimated.

import { AUDIO_BANK_SIZE, AUDIO_GEN2_EFFECT_MAX_SECONDS, AUDIO_SFX_TEMPO } from "../../contracts/spec/voxel-spec.ts";

interface Header {
  bank: number;
  address: number;
  [k: string]: unknown;
}

interface Gen2Audio {
  bankOrder: number[];
  songs: Record<string, Header>;
  sfx: Record<string, Header>;
  cries: Record<string, { header: Header; pitch: number; length: number; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** A one-shot never runs past this (ChipSynth.lua@bdfac727:1444). */
const EFFECT_CAP = AUDIO_GEN2_EFFECT_MAX_SECONDS * 60;
/** A song pass is measured up to ten minutes (a guard, not a rule). */
const SONG_CAP = 60 * 60 * 10;
/** audio.rs WALK_GUARD: this many commands without a note ends a channel. */
const WALK_GUARD = 100_000;

class Reader {
  private readonly slots = new Map<number, number>();
  constructor(
    private readonly programs: Uint8Array,
    bankOrder: number[],
  ) {
    bankOrder.forEach((bank, i) => this.slots.set(bank, i));
  }
  slot(bank: number): number | undefined {
    return this.slots.get(bank);
  }
  /** audio.rs rom_byte: undefined outside the 0x4000 window. */
  byte(slot: number, address: number): number | undefined {
    const within = address - AUDIO_BANK_SIZE;
    if (within < 0 || within >= AUDIO_BANK_SIZE) return undefined;
    return this.programs[slot * AUDIO_BANK_SIZE + within];
  }
  word(slot: number, address: number): number | undefined {
    const lo = this.byte(slot, address);
    const hi = this.byte(slot, (address + 1) & 0xffff);
    return lo === undefined || hi === undefined ? undefined : lo | (hi << 8);
  }
  /** ChipSynth.lua@bdfac727:247-261 headerChannels: [number, address][]. */
  channels(slot: number, address: number): [number, number][] {
    const first = this.byte(slot, address);
    if (first === undefined) return [];
    const out: [number, number][] = [];
    const count = ((first & 0xf0) >> 6) + 1;
    let at = address;
    for (let i = 0; i < count; i++) {
      const d = this.byte(slot, at);
      const target = this.word(slot, (at + 1) & 0xffff);
      if (d === undefined || target === undefined) break;
      out.push([(d & 0x0f) + 1, target]);
      at = (at + 3) & 0xffff;
    }
    return out;
  }
}

interface Ch {
  address: number;
  noise: boolean;
  sfx: boolean;
  executeMusic: boolean;
  frameTicks: number;
  noteLength: number;
  durationModifier: number;
  noiseSampling: boolean;
  condition: number;
  callStack: number[];
  loopCounts: Map<number, number>;
  ended: boolean;
  /** Frames of events so far. */
  time: number;
}

/**
 * How many frames a Gen 2 program sounds for: the latest channel end, capped.
 * `cryLength` makes it a cry (the tone channels' tempo is the length word);
 * otherwise an sfx channel counts $80 + `sfxTempo`. `allowLoops` false is how
 * both one-shots and a playOnce pass run.
 */
export function gen2ProgramFrames(
  programs: Uint8Array,
  bankOrder: number[],
  header: Header,
  opts: { cryLength?: number; sfxTempo?: number; cap?: number } = {},
): number {
  const rd = new Reader(programs, bankOrder);
  const slot = rd.slot(header.bank);
  if (slot === undefined) return 0;
  const cap = opts.cap ?? EFFECT_CAP;
  const chans: Ch[] = rd.channels(slot, header.address).map(([number, address]) => {
    const hardware = ((number - 1) % 4) + 1;
    const sfx = number > 4;
    // audio.rs Program::build / ChipSynth.lua@bdfac727:1307-1320
    const frameTicks =
      hardware === 4 ? 256 : opts.cryLength !== undefined ? opts.cryLength : AUDIO_SFX_TEMPO + (opts.sfxTempo ?? AUDIO_SFX_TEMPO);
    return {
      address,
      noise: hardware === 4,
      sfx,
      executeMusic: !sfx,
      frameTicks,
      noteLength: 1,
      durationModifier: 0,
      noiseSampling: false,
      condition: 0,
      callStack: [],
      loopCounts: new Map(),
      ended: false,
      time: 0,
    };
  });
  let tempo = 0x100;

  /** ChipSynth.lua@bdfac727:414-424 durationTicksGen2, in frames. */
  const duration = (c: Ch, length: number): number => {
    const t = c.sfx && !c.executeMusic ? c.frameTicks : tempo;
    const low = ((length + 1) * c.noteLength) & 0xff;
    const product = (t * low + c.durationModifier) & 0xffff;
    c.durationModifier = product & 0xff;
    return Math.max(1, product >> 8);
  };

  /** One event's frames, or undefined when the channel ended. */
  const step = (c: Ch): number | undefined => {
    const b = () => {
      const v = rd.byte(slot, c.address);
      c.address = (c.address + 1) & 0xffff;
      return v;
    };
    const w = () => {
      const v = rd.word(slot, c.address);
      c.address = (c.address + 2) & 0xffff;
      return v;
    };
    for (let guard = 0; guard < WALK_GUARD; guard++) {
      const at = c.address;
      const cmd = b();
      if (cmd === undefined) return undefined;
      if (cmd < 0xd0 && c.sfx && !c.executeMusic) {
        const frames = duration(c, cmd);
        if (b() === undefined) return undefined;
        if ((c.noise ? b() : w()) === undefined) return undefined;
        return frames;
      }
      if (cmd < 0xd0) return duration(c, cmd & 0x0f);
      let ok = true;
      const need = (v: number | undefined) => {
        if (v === undefined) ok = false;
        return v ?? 0;
      };
      if (cmd <= 0xd7) {
        // octave
      } else if (cmd === 0xd8) {
        c.noteLength = need(b());
        if (!c.noise) need(b());
      } else if (cmd === 0xda) {
        const hi = need(b());
        const lo = need(b());
        tempo = hi * 0x100 + lo;
        c.durationModifier = 0;
      } else if (cmd === 0xdf) {
        c.executeMusic = !c.executeMusic;
      } else if (cmd === 0xe0 || cmd === 0xe1 || cmd === 0xe6 || cmd === 0xeb || cmd === 0xee) {
        need(w());
      } else if (cmd === 0xe3 || cmd === 0xf0) {
        if (c.noiseSampling) c.noiseSampling = false;
        else {
          c.noiseSampling = true;
          need(b());
        }
      } else if (cmd === 0xe9) {
        const adj = need(b());
        tempo = (tempo + (adj >= 0x80 ? adj - 0x100 : adj)) & 0xffff;
      } else if (cmd === 0xea || cmd === 0xfc) {
        c.address = need(w());
      } else if (cmd === 0xfa) {
        c.condition = need(b());
      } else if (cmd === 0xfb) {
        const want = need(b());
        const target = need(w());
        if (ok && c.condition === want) c.address = target;
      } else if (cmd === 0xfd) {
        const count = need(b());
        const target = need(w());
        if (!ok) return undefined;
        if (count === 0) return undefined; // allowLoops is false here
        const remaining = (c.loopCounts.get(at) ?? count) - 1;
        if (remaining > 0) {
          c.loopCounts.set(at, remaining);
          c.address = target;
        } else c.loopCounts.delete(at);
      } else if (cmd === 0xfe) {
        c.callStack.push((c.address + 2) & 0xffff);
        c.address = need(w());
      } else if (cmd === 0xff) {
        const ret = c.callStack.pop();
        if (ret === undefined) return undefined;
        c.address = ret;
      } else if (cmd === 0xec || cmd === 0xed || (cmd >= 0xf1 && cmd <= 0xf9)) {
        // no argument
      } else {
        // d9 db dc dd de e2 e4 e5 e7 e8 ef: one byte
        need(b());
      }
      if (!ok) return undefined;
    }
    return undefined;
  };

  for (;;) {
    let next: Ch | undefined;
    for (const c of chans) if (!c.ended && (!next || c.time < next.time)) next = c;
    if (!next || next.time >= cap) break;
    const frames = step(next);
    if (frames === undefined) next.ended = true;
    else next.time += frames;
  }
  return Math.min(cap, chans.reduce((m, c) => Math.max(m, c.time), 0));
}

/** The channel count a header claims (Sound.lua@bdfac727:269 effectChannels). */
export function gen2ChannelCount(programs: Uint8Array, bankOrder: number[], header: Header): number {
  const rd = new Reader(programs, bankOrder);
  const slot = rd.slot(header.bank);
  return slot === undefined ? 0 : rd.channels(slot, header.address).length;
}

/** The importer's audio table plus the measured lengths (see the top). */
export function gen2AudioManifest<T extends Gen2Audio>(audio: T, programs: Uint8Array): T {
  const order = audio.bankOrder;
  const sfx: Record<string, Header> = {};
  for (const [name, h] of Object.entries(audio.sfx)) {
    sfx[name] = { ...h, frames: gen2ProgramFrames(programs, order, h), channelCount: gen2ChannelCount(programs, order, h) };
  }
  const cries: Gen2Audio["cries"] = {};
  for (const [species, c] of Object.entries(audio.cries)) {
    cries[species] = { ...c, frames: gen2ProgramFrames(programs, order, c.header, { cryLength: c.length }) };
  }
  const songs: Record<string, Header> = {};
  for (const [name, h] of Object.entries(audio.songs)) {
    songs[name] = { ...h, frames: gen2ProgramFrames(programs, order, h, { cap: SONG_CAP }) };
  }
  return { ...audio, sfx, cries, songs };
}
