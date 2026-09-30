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
  /** options.lua's text, or undefined. Optional: default is memory. */
  readOptions?(): string | undefined;
  /** Commit options.lua's text. Optional: default is memory. */
  writeOptions?(text: string): boolean;
}

/** A memory-only store: the default, and what tests use. */
export function memorySaveIo(initial?: string, initialOptions?: string): SaveIo & { text: string | undefined; options: string | undefined } {
  const io = {
    text: initial,
    options: initialOptions,
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

export const SaveIoSeam = { read, write, readOptions, writeOptions, setSaveIo, saveIo, memorySaveIo };
export default SaveIoSeam;
