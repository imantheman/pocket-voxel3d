// Port of gen1recomp src/import/gba/rom.lua (GPLv3 + additional terms; see LICENSE.md).
// The ROM as one buffer (a 1.1 dump already rebuilt in its 1.0 layout).
// Lua differences: readBytes returns a 0-based Uint8Array (the Lua a 1-based
// table); readString a byte string (as the Lua).

import { format, fromBytes } from "./lua.ts";
import { RevisionView, type Imports, type ImportInfo } from "./revision_view.ts";
import { Versions } from "./versions.ts";

export class Rom {
  imports: Imports;
  id: string;
  size: number;
  md5: string;
  _info: ImportInfo;
  _raw: Uint8Array;

  private constructor(imports: Imports, id: string, info: ImportInfo) {
    this.imports = imports;
    this.id = id;
    this.size = info.size;
    this.md5 = info.md5;
    this._info = info;
    const view = RevisionView.forImports(imports, id, info);
    this._raw = view && view.length === this.size ? view : imports.bytes(id);
  }

  // Lua: rom.lua:25 -- [rom] or [undefined, err]
  static open(imports: Imports, importId: string): [Rom | undefined, string?] {
    const info = imports.info(importId);
    if (!info) return [undefined, "undeclared"];
    Versions.select(info.md5);
    return [new Rom(imports, importId, info)];
  }

  // Lua: rom.lua:43
  ensureBuffer(): Uint8Array {
    return this._raw;
  }

  /** The buffer itself, for hot loops (the Lua anchors an FFI pointer). */
  get raw(): Uint8Array {
    return this._raw;
  }

  // Lua: rom.lua:80 -- byte at a 0-based offset
  get(offset: number): number {
    if (offset < 0 || offset >= this.size) throw new Error(format("ROM OOB 0x%X (size 0x%X)", offset, this.size));
    return this._raw[offset]!;
  }

  // Lua: rom.lua:92
  u16(offset: number): number {
    if (offset < 0 || offset + 1 >= this.size) throw new Error(format("ROM OOB u16 0x%X", offset));
    const r = this._raw;
    return r[offset]! + r[offset + 1]! * 256;
  }

  // Lua: rom.lua:110
  u32(offset: number): number {
    if (offset < 0 || offset + 3 >= this.size) throw new Error(format("ROM OOB u32 0x%X", offset));
    const r = this._raw;
    return r[offset]! + r[offset + 1]! * 256 + r[offset + 2]! * 65536 + r[offset + 3]! * 16777216;
  }

  // Lua: rom.lua:134 -- binary byte string
  readString(offset: number, length: number): string {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error(format("ROM OOB readString 0x%X + %d", offset, length));
    if (length === 0) return "";
    return fromBytes(this._raw, offset, offset + length);
  }

  // Lua: rom.lua:146 -- 0-based copy
  readBytes(offset: number, length: number): Uint8Array {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error(format("ROM OOB readBytes 0x%X + %d", offset, length));
    return this._raw.slice(offset, offset + length);
  }

  // Lua: rom.lua:167 -- GBA pointer (0x08XXXXXX) -> file offset, or undefined
  ptrOffset(gbaPtr: number | undefined): number | undefined {
    if (gbaPtr === undefined || gbaPtr < 0x08000000 || gbaPtr >= 0x0a000000) return undefined;
    return gbaPtr - 0x08000000;
  }

  // Lua: rom.lua:172
  clearCache(): void {}
}

export default Rom;
