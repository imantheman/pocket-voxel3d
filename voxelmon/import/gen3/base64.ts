// Port of gen1recomp src/core/Base64.lua (GPLv3 + additional terms; see LICENSE.md).
// Byte strings in and out (see lua.ts THE STRING RULE).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = 61;
const DEC: Record<number, number> = {};
for (let i = 0; i < 64; i++) DEC[ALPHABET.charCodeAt(i)] = i;

export const Base64 = {
  // Lua: Base64.lua:20
  encode(bytes: string): string {
    let out = "";
    const n = bytes.length;
    let i = 0;
    while (i + 2 < n) {
      const word = bytes.charCodeAt(i) * 65536 + bytes.charCodeAt(i + 1) * 256 + bytes.charCodeAt(i + 2);
      out += ALPHABET[Math.floor(word / 262144)]! + ALPHABET[Math.floor(word / 4096) % 64]!
        + ALPHABET[Math.floor(word / 64) % 64]! + ALPHABET[word % 64]!;
      i += 3;
    }
    const rest = n - i;
    if (rest === 1) {
      const a = bytes.charCodeAt(i);
      out += ALPHABET[Math.floor(a / 4)]! + ALPHABET[(a % 4) * 16]! + "==";
    } else if (rest === 2) {
      const word = bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1);
      out += ALPHABET[Math.floor(word / 1024)]! + ALPHABET[Math.floor(word / 16) % 64]! + ALPHABET[(word % 16) * 4]! + "=";
    }
    return out;
  },

  // Lua: Base64.lua:44 -- [bytes] or [undefined, error]
  decode(text: string): [string | undefined, string?] {
    const n = text.length;
    if (n % 4 !== 0) return [undefined, "base64 length must be a multiple of four"];
    if (n === 0) return [""];
    let out = "";
    const last = n - 4;
    for (let i = 0; i < n; i += 4) {
      const b3 = text.charCodeAt(i + 2), b4 = text.charCodeAt(i + 3);
      const v1 = DEC[text.charCodeAt(i)], v2 = DEC[text.charCodeAt(i + 1)];
      if (v1 === undefined || v2 === undefined) return [undefined, "base64 holds a character outside the alphabet"];
      if (i === last && b3 === PAD) {
        if (b4 !== PAD) return [undefined, "base64 padding is malformed"];
        if (v2 % 16 !== 0) return [undefined, "base64 padding carries data bits"];
        out += String.fromCharCode(v1 * 4 + Math.floor(v2 / 16));
      } else if (i === last && b4 === PAD) {
        const v3 = DEC[b3];
        if (v3 === undefined) return [undefined, "base64 holds a character outside the alphabet"];
        if (v3 % 4 !== 0) return [undefined, "base64 padding carries data bits"];
        const word = v1 * 1024 + v2 * 16 + Math.floor(v3 / 4);
        out += String.fromCharCode(Math.floor(word / 256), word % 256);
      } else {
        const v3 = DEC[b3], v4 = DEC[b4];
        if (v3 === undefined || v4 === undefined) return [undefined, "base64 holds a character outside the alphabet"];
        const word = v1 * 262144 + v2 * 4096 + v3 * 64 + v4;
        out += String.fromCharCode(Math.floor(word / 65536), Math.floor(word / 256) % 256, word % 256);
      }
    }
    return [out];
  },
};

export default Base64;
