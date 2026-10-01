// Gen 2 event-flag bitfield (wEventFlags). Flag SET -> object with that
// eventFlag is hidden (CheckObjectFlag in map_objects_2.asm).
// A port of gen1recomp src/world/gen2/Events.lua at bdfac727 (MIT).
//
// `flags` is byte index -> byte value, exactly as the Lua kept it: flag id N
// lives in byte floor(N / 8), bit N % 8. A byte never written is absent (the
// Lua's nil) and reads as 0.

import { Runtime } from "../shared/mods/Runtime.ts";
import { tonumber } from "../platform/lua.ts";

const FLAGS_PER_BYTE = 8;

type FlagId = number | null | undefined | false;

export class Events {
  flags: Record<number, number> = {};

  // Lua: Events.lua:9-15
  static new(initial?: unknown): Events {
    const self = new Events();
    if (Array.isArray(initial)) {
      for (const id of initial) self.set(id, true);
    } else if (initial !== null && typeof initial === "object") {
      // ipairs over a non-array table: the 1.. run of integer keys
      const t = initial as Record<number, number>;
      for (let i = 1; t[i] != null; i++) self.set(t[i], true);
    }
    return self;
  }

  // Lua: Events.lua:17-23
  get(id: FlagId): boolean {
    if (id == null || id === false || id < 0) return false;
    const byte = Math.floor(id / FLAGS_PER_BYTE);
    const bitn = id % FLAGS_PER_BYTE;
    const row = this.flags[byte] ?? 0;
    return Math.floor(row / 2 ** bitn) % 2 === 1;
  }

  // Lua: Events.lua:39-60 -- flag.changed carries the SAME name and payload
  // keys Gen 1's src/script/Flags.lua emits, only on a real transition. `name`
  // holds a NUMBER here (Gen 2 flags are bits in wEventFlags, not string keys),
  // so a dual-generation listener branches on typeof payload.name.
  // restore and resetMapBuffer deliberately do NOT come through here: a save
  // load and HandleNewMap's one-byte wipe are not script writes.
  set(id: FlagId, value: unknown): void {
    if (id == null || id === false || id < 0) return;
    const watched = Runtime.wants("flag.changed");
    const before = watched ? this.get(id) : false;
    const byte = Math.floor(id / FLAGS_PER_BYTE);
    const bitn = id % FLAGS_PER_BYTE;
    const mask = 2 ** bitn;
    const row = this.flags[byte] ?? 0;
    const on = value !== undefined && value !== null && value !== false;
    if (on) {
      this.flags[byte] = row + (Math.floor(row / mask) % 2 === 0 ? mask : 0);
    } else {
      if (Math.floor(row / mask) % 2 === 1) {
        this.flags[byte] = row - mask;
      }
    }
    if (watched) {
      const after = on;
      if (before !== after) {
        Runtime.emit("flag.changed", { name: id, value: after });
      }
    }
  }

  // Lua: Events.lua:62-71 -- ResetMapBufferEventFlags (home/flag.asm): `xor a
  // / ld hl, wEventFlags / ld [hli], a` zeroes exactly ONE byte -- flags 0-7,
  // the EVENT_TEMPORARY_UNTIL_MAP_RELOAD block -- and HandleNewMap runs it on
  // every map load. This re-arms every "once per visit" script latch (Bill's
  // grandpa's one stone per entry, Kurt's house, the ports, Dragon's Den B1F,
  // the National Park gate).
  resetMapBuffer(): void {
    delete this.flags[0];
  }

  // Lua: Events.lua:73-77
  objectVisible(eventFlag: number | null | undefined): boolean {
    // Extracted maps may keep 0xFFFF instead of nil for "always appear".
    if (eventFlag == null || eventFlag === 0xffff) return true;
    return !this.get(eventFlag);
  }

  // Lua: Events.lua:79-88 -- the bitfield as a plain table for the save file:
  // byte -> value rather than a flag list, because that is what the cart's
  // SRAM holds, and a sparse map keeps a save small (most bytes are 0).
  serialize(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const key of Object.keys(this.flags)) {
      const byte = Number(key);
      const value = this.flags[byte]!;
      if (value !== 0) out[byte] = value;
    }
    return out;
  }

  // Lua: Events.lua:90-98
  restore(bytes: unknown): Events {
    if (bytes === null || typeof bytes !== "object") return this;
    this.flags = {};
    const t = bytes as Record<string, number>;
    for (const byte of Object.keys(t)) {
      const index = tonumber(byte);
      if (index !== undefined) this.flags[index] = t[byte]!;
    }
    return this;
  }
}

export default Events;
