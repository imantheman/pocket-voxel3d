/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). PNG decoding for g3TexFromCache: a small RFC 1951
   inflate (stored, fixed and dynamic blocks, puff-style canonical Huffman)
   and the PNG filters, to RGBA8. Non-interlaced; bit depth 8 for every
   colour type, 1/2/4 for grey and palette, 16 by taking the high byte --
   more than the importer writes (8-bit RGBA and palette, stored deflate). */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------ inflate */

typedef struct {
    const uint8_t *src; size_t len, pos;
    uint32_t bitbuf; int bitcnt;
    uint8_t *out; size_t outcap, outlen;
    int err;
} Inf;

static int bits(Inf *s, int need) {
    uint32_t v = s->bitbuf;
    while (s->bitcnt < need) {
        if (s->pos >= s->len) { s->err = 1; return 0; }
        v |= (uint32_t)s->src[s->pos++] << s->bitcnt;
        s->bitcnt += 8;
    }
    s->bitbuf = v >> need;
    s->bitcnt -= need;
    return (int)(v & ((1u << need) - 1));
}

typedef struct { uint16_t count[16]; uint16_t symbol[320]; } Huff;

static int huff_build(Huff *h, const uint8_t *len, int n) {
    uint16_t offs[16];
    memset(h->count, 0, sizeof(h->count));
    for (int i = 0; i < n; i++) h->count[len[i]]++;
    if (h->count[0] == n) return 0;
    int left = 1;
    for (int l = 1; l < 16; l++) { left <<= 1; left -= h->count[l]; if (left < 0) return -1; }
    offs[1] = 0;
    for (int l = 1; l < 15; l++) offs[l + 1] = offs[l] + h->count[l];
    for (int i = 0; i < n; i++) if (len[i]) h->symbol[offs[len[i]]++] = (uint16_t)i;
    return left;
}

static int decode(Inf *s, const Huff *h) {
    int code = 0, first = 0, index = 0;
    for (int l = 1; l < 16; l++) {
        code |= bits(s, 1);
        if (s->err) return -1;
        int count = h->count[l];
        if (code - count < first) return h->symbol[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    s->err = 2;
    return -1;
}

static int put(Inf *s, uint8_t b) {
    if (s->outlen >= s->outcap) {
        size_t nc = s->outcap ? s->outcap * 2 : 65536;
        uint8_t *n = (uint8_t *)realloc(s->out, nc);
        if (!n) { s->err = 3; return 0; }
        s->out = n; s->outcap = nc;
    }
    s->out[s->outlen++] = b;
    return 1;
}

static const uint16_t LBASE[29] = {3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258};
static const uint8_t LEXT[29] = {0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0};
static const uint16_t DBASE[30] = {1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577};
static const uint8_t DEXT[30] = {0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13};

static int codes(Inf *s, const Huff *lh, const Huff *dh) {
    for (;;) {
        int sym = decode(s, lh);
        if (sym < 0) return -1;
        if (sym < 256) { if (!put(s, (uint8_t)sym)) return -1; continue; }
        if (sym == 256) return 0;
        sym -= 257;
        if (sym >= 29) { s->err = 4; return -1; }
        int len = LBASE[sym] + bits(s, LEXT[sym]);
        int ds = decode(s, dh);
        if (ds < 0 || ds >= 30) { s->err = 5; return -1; }
        size_t dist = DBASE[ds] + (size_t)bits(s, DEXT[ds]);
        if (s->err) return -1;
        if (dist > s->outlen) { s->err = 6; return -1; }
        while (len--) { if (!put(s, s->out[s->outlen - dist])) return -1; }
    }
}

static int inflate_raw(Inf *s) {
    static Huff fl, fd;
    static int fixed_ready = 0;
    int last;
    do {
        last = bits(s, 1);
        int type = bits(s, 2);
        if (s->err) return -1;
        if (type == 0) {
            s->bitbuf = 0; s->bitcnt = 0;
            if (s->pos + 4 > s->len) return -1;
            unsigned n = s->src[s->pos] | (s->src[s->pos + 1] << 8);
            s->pos += 4;
            if (s->pos + n > s->len) return -1;
            if (s->outlen + n > s->outcap) {
                size_t nc = s->outcap ? s->outcap : 65536;
                while (nc < s->outlen + n) nc *= 2;
                uint8_t *nb = (uint8_t *)realloc(s->out, nc);
                if (!nb) return -1;
                s->out = nb; s->outcap = nc;
            }
            memcpy(s->out + s->outlen, s->src + s->pos, n);
            s->outlen += n; s->pos += n;
        } else if (type == 1) {
            if (!fixed_ready) {
                uint8_t l[288];
                int i = 0;
                for (; i < 144; i++) l[i] = 8;
                for (; i < 256; i++) l[i] = 9;
                for (; i < 280; i++) l[i] = 7;
                for (; i < 288; i++) l[i] = 8;
                huff_build(&fl, l, 288);
                for (i = 0; i < 30; i++) l[i] = 5;
                huff_build(&fd, l, 30);
                fixed_ready = 1;
            }
            if (codes(s, &fl, &fd)) return -1;
        } else if (type == 2) {
            static const uint8_t ORDER[19] = {16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15};
            uint8_t lengths[320];
            Huff lh, dh;
            int nlen = bits(s, 5) + 257, ndist = bits(s, 5) + 1, ncode = bits(s, 4) + 4;
            if (s->err || nlen > 286 || ndist > 30) return -1;
            int i;
            for (i = 0; i < 19; i++) lengths[ORDER[i]] = (uint8_t)(i < ncode ? bits(s, 3) : 0);
            if (huff_build(&lh, lengths, 19) != 0) return -1;
            i = 0;
            while (i < nlen + ndist) {
                int sym = decode(s, &lh);
                if (sym < 0) return -1;
                if (sym < 16) { lengths[i++] = (uint8_t)sym; continue; }
                int len = 0, rep;
                if (sym == 16) { if (i == 0) return -1; len = lengths[i - 1]; rep = 3 + bits(s, 2); }
                else if (sym == 17) rep = 3 + bits(s, 3);
                else rep = 11 + bits(s, 7);
                if (i + rep > nlen + ndist) return -1;
                while (rep--) lengths[i++] = (uint8_t)len;
            }
            if (huff_build(&lh, lengths, nlen) < 0) return -1;
            if (huff_build(&dh, lengths + nlen, ndist) < 0) return -1;
            if (codes(s, &lh, &dh)) return -1;
        } else return -1;
        if (s->err) return -1;
    } while (!last);
    return 0;
}

/* A raw deflate stream to exactly raw_len bytes (malloc'd), or NULL: the
   card's deflated files (g3_files.c g3_read_file). */
uint8_t *g3_inflate(const uint8_t *src, size_t len, size_t raw_len) {
    Inf s;
    memset(&s, 0, sizeof(s));
    s.src = src; s.len = len;
    s.outcap = raw_len ? raw_len : 1;
    s.out = (uint8_t *)malloc(s.outcap);
    if (!s.out || inflate_raw(&s) != 0 || s.outlen != raw_len) { free(s.out); return NULL; }
    return s.out;
}

/* ------------------------------------------------------------ PNG */

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

static uint8_t paeth(int a, int b, int c) {
    int p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
    if (pa <= pb && pa <= pc) return (uint8_t)a;
    return (uint8_t)(pb <= pc ? b : c);
}

/* Decode `png` (len bytes) to a malloc'd w*h*4 RGBA8 buffer; NULL on failure. */
uint8_t *g3_png_decode(const uint8_t *png, size_t len, int *ow, int *oh) {
    static const uint8_t SIG[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (len < 33 || memcmp(png, SIG, 8) != 0) return NULL;
    uint32_t w = 0, h = 0;
    int depth = 0, ctype = 0, interlace = 0;
    uint8_t pal[256][4];
    memset(pal, 0, sizeof(pal));
    for (int i = 0; i < 256; i++) pal[i][3] = 255;
    int trns_grey = -1, trns_r = -1, trns_g = -1, trns_b = -1;
    /* the IDAT payloads, gathered (stored-deflate PNGs are one big IDAT, so
       this is usually a single copy of the stream) */
    uint8_t *z = NULL;
    size_t zlen = 0, zcap = 0;
    size_t p = 8;
    while (p + 12 <= len) {
        uint32_t n = be32(png + p);
        const uint8_t *t = png + p + 4, *d = png + p + 8;
        if (p + 12 + n > len) break;
        if (!memcmp(t, "IHDR", 4) && n >= 13) {
            w = be32(d); h = be32(d + 4); depth = d[8]; ctype = d[9]; interlace = d[12];
        } else if (!memcmp(t, "PLTE", 4)) {
            for (uint32_t i = 0; i < n / 3 && i < 256; i++) { pal[i][0] = d[i * 3]; pal[i][1] = d[i * 3 + 1]; pal[i][2] = d[i * 3 + 2]; }
        } else if (!memcmp(t, "tRNS", 4)) {
            if (ctype == 3) { for (uint32_t i = 0; i < n && i < 256; i++) pal[i][3] = d[i]; }
            else if (ctype == 0 && n >= 2) trns_grey = (d[0] << 8) | d[1];
            else if (ctype == 2 && n >= 6) { trns_r = (d[0] << 8) | d[1]; trns_g = (d[2] << 8) | d[3]; trns_b = (d[4] << 8) | d[5]; }
        } else if (!memcmp(t, "IDAT", 4)) {
            if (zlen + n > zcap) {
                size_t nc = zcap ? zcap : n;
                while (nc < zlen + n) nc *= 2;
                uint8_t *nz = (uint8_t *)realloc(z, nc);
                if (!nz) { free(z); return NULL; }
                z = nz; zcap = nc;
            }
            memcpy(z + zlen, d, n);
            zlen += n;
        } else if (!memcmp(t, "IEND", 4)) break;
        p += 12 + n;
    }
    if (!w || !h || w > 4096 || h > 4096 || interlace || !z || zlen < 2) { free(z); return NULL; }
    int chans = ctype == 0 ? 1 : ctype == 2 ? 3 : ctype == 3 ? 1 : ctype == 4 ? 2 : ctype == 6 ? 4 : 0;
    if (!chans || !(depth == 8 || depth == 16 || ((ctype == 0 || ctype == 3) && depth < 8))) { free(z); return NULL; }
    size_t bpp_bits = (size_t)chans * depth;
    size_t stride = (w * bpp_bits + 7) / 8;
    size_t bpp = (bpp_bits + 7) / 8;
    size_t raw_len = (stride + 1) * h;
    Inf s;
    memset(&s, 0, sizeof(s));
    s.src = z; s.len = zlen; s.pos = 2; /* CMF, FLG */
    s.outcap = raw_len + 64;
    s.out = (uint8_t *)malloc(s.outcap);
    if (!s.out || inflate_raw(&s) != 0 || s.outlen < raw_len) { free(s.out); free(z); return NULL; }
    free(z);
    uint8_t *raw = s.out;
    /* unfilter in place */
    for (uint32_t y = 0; y < h; y++) {
        uint8_t *row = raw + y * (stride + 1);
        uint8_t f = row[0];
        uint8_t *cur = row + 1;
        uint8_t *prev = y ? raw + (y - 1) * (stride + 1) + 1 : NULL;
        for (size_t x = 0; x < stride; x++) {
            int a = x >= bpp ? cur[x - bpp] : 0;
            int b = prev ? prev[x] : 0;
            int c = (prev && x >= bpp) ? prev[x - bpp] : 0;
            switch (f) {
                case 1: cur[x] = (uint8_t)(cur[x] + a); break;
                case 2: cur[x] = (uint8_t)(cur[x] + b); break;
                case 3: cur[x] = (uint8_t)(cur[x] + ((a + b) >> 1)); break;
                case 4: cur[x] = (uint8_t)(cur[x] + paeth(a, b, c)); break;
                default: break;
            }
        }
    }
    uint8_t *out = (uint8_t *)malloc((size_t)w * h * 4);
    if (!out) { free(raw); return NULL; }
    int step = depth == 16 ? 2 : 1;
    for (uint32_t y = 0; y < h; y++) {
        const uint8_t *r = raw + y * (stride + 1) + 1;
        uint8_t *o = out + (size_t)y * w * 4;
        for (uint32_t x = 0; x < w; x++, o += 4) {
            if (depth < 8) {
                int per = 8 / depth;
                int v = (r[x / per] >> ((per - 1 - (int)(x % per)) * depth)) & ((1 << depth) - 1);
                if (ctype == 3) { memcpy(o, pal[v], 4); }
                else {
                    uint8_t g = (uint8_t)(v * 255 / ((1 << depth) - 1));
                    o[0] = o[1] = o[2] = g; o[3] = (v == trns_grey) ? 0 : 255;
                }
                continue;
            }
            const uint8_t *q = r + x * chans * step;
            switch (ctype) {
                case 0: o[0] = o[1] = o[2] = q[0];
                        o[3] = (trns_grey >= 0 && (step == 2 ? ((q[0] << 8) | q[1]) : q[0]) == trns_grey) ? 0 : 255; break;
                case 2: o[0] = q[0]; o[1] = q[step]; o[2] = q[2 * step];
                        o[3] = (trns_r >= 0 && step == 1 && q[0] == trns_r && q[1] == trns_g && q[2] == trns_b) ? 0 : 255; break;
                case 3: memcpy(o, pal[q[0]], 4); break;
                case 4: o[0] = o[1] = o[2] = q[0]; o[3] = q[step]; break;
                default: o[0] = q[0]; o[1] = q[step]; o[2] = q[2 * step]; o[3] = q[3 * step]; break;
            }
        }
    }
    free(raw);
    *ow = (int)w; *oh = (int)h;
    return out;
}
