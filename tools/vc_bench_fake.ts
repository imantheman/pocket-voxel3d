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
    let sum = 0;
    for (let i = 0x2598; i < 0x3523; i++) sum = (sum + b[i]!) & 0xff;
    console.log(`[pv] vcbench: fake vcWrite ${b.length} bytes, checksum ${((~sum) & 0xff) === b[0x3523] ? "ok" : "BAD"}`);
    return true;
  };
  v.vcInfo = (): string => "fake";
  console.log("[pv] vcbench: fake VC title in place");
}
