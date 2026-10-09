// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The host's C versions of two of the runtime's hot loops
// (crates/pocketvoxel-3ds/src/gen3/g3_fast.c, byte for byte what the TS gives),
// where the binary has them: the tileset atlases' MD5 cache key
// (core/palette.ts md5hex) and their bake (import/gen3/native_pack.ts
// bakeRgba); and a hook telling the host where a warp is going, for its
// read-ahead. A leaf module with no imports, so the host (qjs_host.ts, the
// desktop runner's qjs_boot_host.ts) can fill it in before any runtime module
// is evaluated. The two loops return undefined for an input they cannot take,
// and the caller then runs its own code.

export const Fast: {
  /** MD5 of a byte string as 32 hex digits. */
  md5?: (s: string) => string | undefined;
  /** bakeRgba from a mids.idx blob: its pixels from `pix0` (0-based), the
   *  atlas's mid count, cols and rows, and the 256 RGBA entries (1024 bytes). */
  bake?: (blob: string, pix0: number, midCount: number, cols: number, rows: number, lut: Uint8Array) => string | undefined;
  /** A warp to `map` (world.json's name) has begun (core/warp.ts announce):
   *  the host may start reading that map's world (g3_shim.c g3ReadAhead). */
  warpHint?: (map: string) => void;
} = {};
