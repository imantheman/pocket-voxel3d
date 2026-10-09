/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). Two of the guest's hot loops in C, byte for byte
   what its own code gives (it falls back to that code when a binary lacks
   them):

     g3_md5_hex    MD5 as hex (core/palette.ts md5hex: the tileset atlases'
                   cache key, hashed over the palettes and the whole mids.idx
                   blob -- seconds of QuickJS on the console at a map change)
     g3_bake_rgba  an indexed mid atlas through a 256-entry RGBA table
                   (import/gen3/native_pack.ts bakeRgba)

   Plain C with no QuickJS in it: g3_shim.c includes it for the console and
   tools/gen3/qjs_run.c for the desktop runner, so a profile there pays what
   the console pays. */

#include <stdint.h>
#include <stddef.h>
#include <string.h>

static const uint32_t G3_MD5_K[64] = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
};
static const uint8_t G3_MD5_S[64] = {
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
};

static void g3_md5_block(uint32_t h[4], const uint8_t *p) {
    uint32_t m[16];
    for (int j = 0; j < 16; j++)
        m[j] = (uint32_t)p[j * 4] | ((uint32_t)p[j * 4 + 1] << 8) | ((uint32_t)p[j * 4 + 2] << 16) | ((uint32_t)p[j * 4 + 3] << 24);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
    for (int i = 0; i < 64; i++) {
        uint32_t f;
        int g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        f = f + a + G3_MD5_K[i] + m[g];
        a = d; d = c; c = b;
        b = b + ((f << G3_MD5_S[i]) | (f >> (32 - G3_MD5_S[i])));
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
}

/* MD5 of len bytes as 32 lowercase hex digits (and a NUL). */
static void g3_md5_hex(const uint8_t *msg, size_t len, char out[33]) {
    uint32_t h[4] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
    size_t off = 0;
    for (; off + 64 <= len; off += 64) g3_md5_block(h, msg + off);
    uint8_t tail[128];
    size_t rest = len - off;
    memset(tail, 0, sizeof tail);
    memcpy(tail, msg + off, rest);
    tail[rest] = 0x80;
    size_t tlen = rest + 1 + 8 <= 64 ? 64 : 128;
    uint64_t bits = (uint64_t)len * 8;
    for (int k = 0; k < 8; k++) tail[tlen - 8 + k] = (uint8_t)(bits >> (8 * k));
    g3_md5_block(h, tail);
    if (tlen == 128) g3_md5_block(h, tail + 64);
    static const char hex[] = "0123456789abcdef";
    for (int w = 0; w < 4; w++)
        for (int k = 0; k < 4; k++) {
            uint8_t v = (uint8_t)(h[w] >> (8 * k));
            out[w * 8 + k * 2] = hex[v >> 4];
            out[w * 8 + k * 2 + 1] = hex[v & 15];
        }
    out[32] = 0;
}

/* bakeRgba: slot i of a cols x rows atlas of 16x16 mids is atlas cell
   (i % cols, i / cols); a slot past mid_count is byte 0; each byte is its
   lut entry (4 bytes, RGBA). pix holds the blob's pixel bytes from the
   table's data offset (npix of them; a byte past the blob reads 0, as
   decodeIdx's lazy pixels do). out is cols*16 x rows*16 RGBA8. */
static void g3_bake_rgba(const uint8_t *pix, size_t npix, int mid_count, int cols, int rows,
                         const uint8_t lut[1024], uint8_t *out) {
    int w = cols * 16;
    for (int ay = 0; ay < rows * 16; ay++) {
        int mid_row = ay >> 4, py = ay & 15;
        uint8_t *o = out + (size_t)ay * w * 4;
        for (int mc = 0; mc < cols; mc++, o += 64) {
            int slot = mid_row * cols + mc;
            if (slot >= mid_count) {
                for (int px = 0; px < 16; px++) memcpy(o + px * 4, lut, 4);
                continue;
            }
            size_t base = (size_t)slot * 256 + (size_t)py * 16;
            for (int px = 0; px < 16; px++) {
                size_t k = base + (size_t)px;
                uint8_t b = k < npix ? pix[k] : 0;
                memcpy(o + px * 4, lut + b * 4, 4);
            }
        }
    }
}
