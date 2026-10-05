// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Where the files gen1recomp writes through love.filesystem
// go: its save slots (saves/firered/slotN.lua), options, and the few cache
// files the runtime writes back. The 3DS host keeps them as files on the SD
// card (3ds/voxelmon/firered/...); tests use memorySaveStore().
//
// This module must stay free of Node imports: it is in the device bundle.

export interface SaveStore {
  /** A file's text (byte string), or undefined. */
  read(name: string): string | undefined;
  /** Write a file whole. False: nothing was written. */
  write(name: string, text: string): boolean;
  remove?(name: string): boolean;
  /** Every file name the store holds. */
  list?(): string[];
}

export function memorySaveStore(initial: Record<string, string> = {}): SaveStore & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (n) => files.get(n),
    write: (n, t) => { files.set(n, t); return true; },
    remove: (n) => files.delete(n),
    list: () => [...files.keys()],
  };
}

let store: SaveStore = memorySaveStore();

export function setSaveStore(s: SaveStore | undefined): void { store = s ?? memorySaveStore(); }
export function saveStore(): SaveStore { return store; }

export const SaveFs = { setSaveStore, saveStore, memorySaveStore };
export default SaveFs;
