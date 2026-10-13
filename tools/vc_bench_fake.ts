// The VC bench's stand-in for a VC title (tools/vc_bench_entry.ts imports
// this first): with --define VC_FAKE_B64='"<base64 of a .sav>"' the host's
// vcData hands the guest that save and vcWrite only logs what it was given,
// so the choice and the SAVE path run on a console or in an emulator that
// has no VC title to open. Without the define it does nothing. Never shipped.
declare const VC_FAKE_B64: string;
if (typeof VC_FAKE_B64 !== "undefined") {
  const v = (globalThis as unknown as { voxel: Record<string, unknown> }).voxel;
  // (no atob in every engine: decoded by hand)
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const src = VC_FAKE_B64.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((src.length * 3) / 4));
  let acc = 0, bits = 0, o = 0;
  for (const ch of src) {
    acc = (acc << 6) | A.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[o++] = (acc >> bits) & 0xff; }
  }
  v.vcData = (): ArrayBuffer => bytes.slice().buffer;
  v.vcWrite = (b: Uint8Array): boolean => {
    // a Gen 2 save: its check bytes and 16-bit sums (main and backup)
    if (b[0x2008] === 0x63) {
      const sum = (pieces: [number, number][]): number => pieces.reduce((s, [o, n]) => { for (let i = o; i < o + n; i++) s += b[i]!; return s; }, 0) & 0xffff;
      const le = (o: number): number => b[o]! | (b[o + 1]! << 8);
      const crystal = b[0x2d0f] === 0x7f && sum([[0x2009, 0xb7a]]) === le(0x2d0d);
      const main = crystal || (b[0x2d6b] === 0x7f && sum([[0x2009, 0xd60]]) === le(0x2d69));
      const backup = crystal
        ? b[0x1208] === 0x63 && sum([[0x1209, 0xb7a]]) === le(0x1f0d)
        : b[0x7e38] === 0x63 && sum([[0x15c7, 0x226], [0x3d96, 0x1aa], [0x0c6b, 0x47d], [0x7e39, 0x34], [0x10e8, 0x4df]]) === le(0x7e6d);
      console.log(`[pv] vcbench: fake vcWrite ${b.length} bytes (${crystal ? "Crystal" : "Gold/Silver"} layout), main ${main ? "ok" : "BAD"}, backup ${backup ? "ok" : "BAD"}`);
      return true;
    }
    const ok = (from: number, to: number, at: number): boolean => {
      let sum = 0;
      for (let i = from; i < to; i++) sum = (sum + b[i]!) & 0xff;
      return ((~sum) & 0xff) === b[at];
    };
    // the main block, then the two box banks (each whole, then per box)
    let banks = true;
    for (const bank of [0x4000, 0x6000]) {
      banks &&= ok(bank, bank + 0x1a4c, bank + 0x1a4c);
      for (let n = 0; n < 6; n++) banks &&= ok(bank + n * 0x462, bank + (n + 1) * 0x462, bank + 0x1a4d + n);
    }
    console.log(`[pv] vcbench: fake vcWrite ${b.length} bytes, checksum ${ok(0x2598, 0x3523, 0x3523) ? "ok" : "BAD"}, box banks ${banks ? "ok" : "BAD"}`);
    return true;
  };
  v.vcInfo = (): string => "fake";
  console.log("[pv] vcbench: fake VC title in place");
}
