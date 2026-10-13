// Where the Gold save's bytes go. gen1recomp writes save_gold.lua (plus a
// .bak and a .tmp) through love.filesystem (Save.lua:154-159, :883-984) and
// the shared options.lua through SaveData (SaveData.lua:569-733). We have no
// filesystem: the host keeps one save slot (VoxelHost.saveData/saveWrite in
// voxelmon/game/host.ts), and the entry wires it here with `setSaveIo`.
//
// The text is exactly what Brian's SaveSerializer.encode writes ("return
// {...}\n"), so the file format is his.
//
// Options are a second channel, because Brian keeps them in a file of their
// own that survives New Game. The host has one slot, so by default options
// live in memory only; an entry that wants them persisted supplies
// readOptions/writeOptions (for example by multiplexing both into the slot).
//
// This module must stay free of Node imports: it is in the device bundle.

export interface SaveIo {
  /** The last committed save text, or undefined when there is none. */
  read(): string | undefined;
  /** Commit the save text. False means nothing was saved. */
  write(text: string): boolean;
  /**
   * Keep the save that is in storage now (as the host first read it) aside,
   * before a save the game could not read is written over. False: it was
   * not kept, and nothing may be written. Optional: a store without it
   * keeps no copy, and the write goes ahead.
   */
  backup?(): boolean;
  /**
   * Keep a dated copy of the save as it is in storage now (the 3DS:
   * save_backup/, the last 10), before a save copied from a VC title is
   * written over it. False: not kept, and nothing may be written (why:
   * `writeErr`). Optional: a store without it cannot take a copied save.
   */
  keepCopy?(): boolean;
  /** Why the last write or copy did not take, from the store. */
  writeErr?(): string | undefined;
  /** options.lua's text, or undefined. Optional: default is memory. */
  readOptions?(): string | undefined;
  /** Commit options.lua's text. Optional: default is memory. */
  writeOptions?(text: string): boolean;
}

/** A memory-only store: the default, and what tests use. */
export function memorySaveIo(
  initial?: string,
  initialOptions?: string,
): SaveIo & { text: string | undefined; options: string | undefined; backups: string[]; kept: string[] } {
  const io = {
    text: initial,
    options: initialOptions,
    backups: [] as string[],
    kept: [] as string[],
    backup() {
      if (io.text !== undefined) io.backups.push(io.text);
      return true;
    },
    keepCopy() {
      if (io.text !== undefined && io.text !== "") io.kept.push(io.text);
      return true;
    },
    read: () => io.text,
    write(t: string) {
      io.text = t;
      return true;
    },
    readOptions: () => io.options,
    writeOptions(t: string) {
      io.options = t;
      return true;
    },
  };
  return io;
}

let io: SaveIo = memorySaveIo();
let memOptions: string | undefined;

/** The entry points this at the host (VoxelHost.saveData / saveWrite). */
export function setSaveIo(next: SaveIo | undefined): void {
  io = next ?? memorySaveIo();
}

/** The seam in use. */
export function saveIo(): SaveIo {
  return io;
}

/** The committed save text, or undefined (never throws). */
export function read(): string | undefined {
  try {
    const t = io.read();
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Commit the save text; false when it did not reach storage. */
export function write(text: string): boolean {
  try {
    return io.write(text) !== false;
  } catch {
    return false;
  }
}

/** Keep the stored save aside (SaveIo.backup); true when there is no such channel. */
export function backup(): boolean {
  try {
    return io.backup ? io.backup() !== false : true;
  } catch {
    return false;
  }
}

/** A dated copy of the stored save (SaveIo.keepCopy); false when the
 *  store has no such channel or the copy did not take. */
export function keepCopy(): boolean {
  try {
    return io.keepCopy ? io.keepCopy() === true : false;
  } catch {
    return false;
  }
}

/** The store's reason the last write or copy failed, if it says. */
export function writeErr(): string | undefined {
  try {
    const e = io.writeErr?.();
    return typeof e === "string" && e !== "" ? e : undefined;
  } catch {
    return undefined;
  }
}

/** options.lua's text, or undefined. */
export function readOptions(): string | undefined {
  try {
    if (io.readOptions) {
      const t = io.readOptions();
      return typeof t === "string" ? t : undefined;
    }
  } catch {
    return undefined;
  }
  return memOptions;
}

/** Commit options.lua's text. */
export function writeOptions(text: string): boolean {
  try {
    if (io.writeOptions) return io.writeOptions(text) !== false;
  } catch {
    return false;
  }
  memOptions = text;
  return true;
}

export const SaveIoSeam = { read, write, backup, keepCopy, writeErr, readOptions, writeOptions, setSaveIo, saveIo, memorySaveIo };
export default SaveIoSeam;
