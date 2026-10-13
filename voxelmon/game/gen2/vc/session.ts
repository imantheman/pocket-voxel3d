// VC saves for Gold, Silver and Crystal: the session's side of it.
//
// The host (src/vc.rs) finds the matching VC title at boot and hands its
// cartridge save over (voxel.vcData); a write goes back through
// voxel.vcWrite, which backs the title's save up to the card first, writes,
// reads back and commits. This module keeps:
//   - the bytes as read at boot, or as last written (what a VC write keeps
//     the bytes this game does not model from);
//   - where SAVE writes this session: the Lua file, or the VC title;
//   - for a VC session, this game's own settings it borrows from the Lua
//     save (the clock base; the options live in their own file anyway).
//
// core/Save.ts asks `Vc.writer()` before it writes the Lua file: in a VC
// session the save table goes to the VC title instead, and only there.

import { loadGenerated } from "../platform/data.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { cartSummary, cartToSave, engineOf, isCartSave, saveToCart, type CartSummary, type G2Data } from "./cartsave.ts";

export interface VcHost {
  data(): Uint8Array | undefined;
  write(bytes: Uint8Array): boolean;
  err(): string | undefined;
  info?(): string | undefined;
}

let host: VcHost | null = null;
let bytes: Uint8Array | null = null;
let target: "lua" | "vc" = "lua";
let fresh = false;
let lastErr = "";
/** The live map's blocks for a write (World's, after its callbacks). */
let blocksOf: (() => { map: string; blocks: number[] } | undefined) | null = null;

const log = (s: string): void => {
  console.log(`[pv] vc: ${s}`);
};

function dataset(): G2Data {
  return {
    pokemon: loadGenerated("pokemon") ?? {},
    items: loadGenerated("items") ?? {},
    moves: loadGenerated("moves") ?? {},
    maps: loadGenerated("maps") ?? {},
    constants: loadGenerated("constants") ?? {},
    landmarks: loadGenerated("landmarks") ?? {},
    sprites: loadGenerated("sprites") ?? {},
    events: loadGenerated("events") ?? {},
  } as G2Data;
}

export const Vc = {
  /** The host's natives (main.ts); without them there is no VC title. */
  setHost(h: VcHost | null): void {
    host = h;
    bytes = null;
    target = "lua";
    fresh = false;
    const b = h?.data();
    if (b && b.length >= 0x8000) {
      bytes = new Uint8Array(b.subarray(0, 0x8000));
      const sum = cartSummary(bytes, engineOf(GameVersion.get()));
      log(`${h?.info?.() ?? "VC title"}: ${sum ? `holds ${sum.name}, ${sum.badges} badges, ${sum.hours}:${String(sum.minutes).padStart(2, "0")}` : "no game in it"}`);
    }
  },

  /** Where the live map's blocks come from for a write (World). */
  setBlocksSource(fn: (() => { map: string; blocks: number[] } | undefined) | null): void {
    blocksOf = fn;
  },

  /** The VC title is on the console (its save may be empty). */
  present(): boolean {
    return bytes !== null;
  },
  /** Its save holds a game. */
  hasGame(): boolean {
    return bytes !== null && isCartSave(bytes, engineOf(GameVersion.get()));
  },
  summary(): CartSummary | null {
    return bytes ? cartSummary(bytes, engineOf(GameVersion.get())) : null;
  },

  target(): "lua" | "vc" {
    return target;
  },
  /** CONTINUE on the VC save, or a new game saving there (`isNew`: its
   *  first write builds a whole new cartridge save). */
  useVc(isNew: boolean): void {
    target = "vc";
    fresh = isNew;
    log(isNew ? "NEW GAME saves to the VC title" : "this session saves to the VC title");
  },
  useLua(): void {
    target = "lua";
    fresh = false;
  },

  /** The VC save as this game's save table (CONTINUE). Throws on a save it
   *  cannot use; the notes go to the log. */
  load(): Record<string, any> {
    if (!bytes) throw new Error("no VC title");
    const { save, notes } = cartToSave(bytes, dataset(), GameVersion.get());
    for (const n of notes) log(n);
    return save;
  },

  /** SAVE in a VC session: the save table as a cartridge save over the VC
   *  title's own, handed to the host (backup, write, read back, commit). */
  write(save: Record<string, any>): [boolean, string?] {
    if (!host || !bytes) return [false, "no VC title"];
    try {
      const live = blocksOf?.();
      const blocks = live && live.map === save.position?.map ? live.blocks : undefined;
      const w = saveToCart(save, dataset(), GameVersion.get(), fresh ? null : bytes, { blocks });
      for (const n of w.notes) log(n);
      const ok = host.write(w.bytes) === true;
      const p = save.player ?? {};
      if (ok) {
        bytes = w.bytes;
        fresh = false;
        lastErr = "";
        log(`SAVE written to the VC title (${p.name} at ${save.position?.map} ${save.position?.x},${save.position?.y})`);
        return [true];
      }
      lastErr = host.err() ?? "the VC title did not take it";
      log(`SAVE FAILED: ${lastErr}`);
      return [false, lastErr];
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      log(`SAVE FAILED: ${lastErr}`);
      return [false, lastErr];
    }
  },

  lastError(): string {
    return lastErr;
  },

  /** For tests and benches. */
  reset(): void {
    host = null;
    bytes = null;
    target = "lua";
    fresh = false;
    lastErr = "";
    blocksOf = null;
  },
};
