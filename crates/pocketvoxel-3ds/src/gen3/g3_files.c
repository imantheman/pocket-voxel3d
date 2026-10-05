/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The cache's files on the card, for g3Read /
   g3ReadBuf / g3Exists (g3_shim.c) and g3TexFromCache (g3_render.c).

   The card cook (voxelmon/cook/gen3data.ts) puts the whole cache in ONE
   file, firered/data.pvpk, because the console opens files slowly (a
   thousand-odd opens at boot) and the SD card is filled over FTP, where
   eight thousand small files take far longer than their bytes:

     0   "PVPK"  u32 version (1)  u32 count  u32 names_size
     16  count x { u32 name_off, u32 name_len, u32 data_off, u32 data_len }
         sorted by name (bytes, memcmp then length); name_off into the names
         block, data_off from the start of the file
     ..  names block, then the data

   While the pack is there it answers every path (a path it does not hold
   does not exist -- the runtime probes many, and a failed open on the card
   is slow; a path some entry lies under is a directory). Without it, files
   are read loose from the folder, as before.
   A file of either kind that starts "\0PVZ1" is deflated (u32 LE raw
   length, then a raw deflate stream) and comes back inflated.

   Paths arrive as JS_ToCString makes them from the guest's byte strings:
   a byte 0x80..0xFF is two UTF-8 bytes, which are folded back here. Only
   the guest's main thread reads (the sound thread has its own files). */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void voxel_log(const char *s, int len);
uint8_t *g3_inflate(const uint8_t *src, size_t len, size_t raw_len);

static char g3_root[256] = "sdmc:/3ds/voxelmon/firered/";

/* the folder the cache lives in (tools/gen3/qjs_run.c points it elsewhere) */
void g3_files_root(const char *root) {
    snprintf(g3_root, sizeof(g3_root), "%s", root);
}

static void flog(const char *m, const char *p) {
    char b[300];
    int n = snprintf(b, sizeof(b), "[pv] g3: %s%s", m, p ? p : "");
    if (n > (int)sizeof(b) - 1) n = sizeof(b) - 1;
    voxel_log(b, n);
}

typedef struct { uint32_t name_off, name_len, data_off, data_len; } PkEnt;
static FILE *pk_f;
static PkEnt *pk_ent;
static uint8_t *pk_names;
static uint32_t pk_n;
static int pk_tried;

static uint32_t le32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static void pk_open(void) {
    if (pk_tried) return;
    pk_tried = 1;
    char full[300];
    snprintf(full, sizeof(full), "%sdata.pvpk", g3_root);
    FILE *f = fopen(full, "rb");
    if (!f) return;
    uint8_t h[16];
    if (fread(h, 1, 16, f) != 16 || memcmp(h, "PVPK", 4) || le32(h + 4) != 1) { fclose(f); flog("not a pack: ", full); return; }
    uint32_t n = le32(h + 8), ns = le32(h + 12);
    uint8_t *raw = (uint8_t *)malloc((size_t)n * 16);
    uint8_t *names = (uint8_t *)malloc(ns ? ns : 1);
    PkEnt *ent = (PkEnt *)malloc((size_t)n * sizeof(PkEnt) + 1);
    if (!raw || !names || !ent || fread(raw, 1, (size_t)n * 16, f) != (size_t)n * 16 || fread(names, 1, ns, f) != ns) {
        free(raw); free(names); free(ent); fclose(f); flog("pack index unreadable: ", full); return;
    }
    for (uint32_t i = 0; i < n; i++) {
        ent[i].name_off = le32(raw + i * 16);
        ent[i].name_len = le32(raw + i * 16 + 4);
        ent[i].data_off = le32(raw + i * 16 + 8);
        ent[i].data_len = le32(raw + i * 16 + 12);
    }
    free(raw);
    pk_f = f; pk_ent = ent; pk_names = names; pk_n = n;
    char m[64];
    snprintf(m, sizeof(m), "pack: %u files in ", (unsigned)n);
    flog(m, full);
}

/* the guest's byte string back from JS_ToCString's UTF-8 */
static size_t to_bytes(const char *path, uint8_t *out, size_t cap) {
    size_t k = 0;
    for (const uint8_t *p = (const uint8_t *)path; *p && k < cap; p++) {
        if ((p[0] == 0xC2 || p[0] == 0xC3) && (p[1] & 0xC0) == 0x80) { out[k++] = (uint8_t)(((p[0] & 3) << 6) | (p[1] & 0x3F)); p++; }
        else out[k++] = *p;
    }
    return k;
}

static int pk_cmp(uint32_t i, const uint8_t *key, size_t len) {
    const PkEnt *e = &pk_ent[i];
    size_t m = e->name_len < len ? e->name_len : len;
    int c = memcmp(pk_names + e->name_off, key, m);
    if (c) return c;
    return e->name_len < len ? -1 : e->name_len > len ? 1 : 0;
}

/* first entry >= key */
static uint32_t pk_lower(const uint8_t *key, size_t len) {
    uint32_t lo = 0, hi = pk_n;
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2;
        if (pk_cmp(mid, key, len) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/* 1: the pack answers this path; *ent = the entry or -1 */
static int pk_find(const char *path, long *ent, int *is_dir) {
    pk_open();
    *ent = -1; *is_dir = 0;
    if (!pk_f) return 0;
    uint8_t key[512];
    size_t len = to_bytes(path, key, sizeof(key) - 1);
    uint32_t i = pk_lower(key, len);
    if (i < pk_n && pk_cmp(i, key, len) == 0) { *ent = (long)i; return 1; }
    /* a directory: some entry starts with path + "/" */
    if (len && key[len - 1] != '/') key[len++] = '/';
    i = pk_lower(key, len);
    if (i < pk_n && pk_ent[i].name_len >= len && !memcmp(pk_names + pk_ent[i].name_off, key, len)) *is_dir = 1;
    return 1;
}

static uint8_t *unzip(uint8_t *b, size_t *len, const char *path) {
    if (*len >= 9 && !memcmp(b, "\0PVZ1", 5)) {
        size_t raw = (size_t)b[5] | ((size_t)b[6] << 8) | ((size_t)b[7] << 16) | ((size_t)b[8] << 24);
        uint8_t *u = g3_inflate(b + 9, *len - 9, raw);
        free(b);
        if (!u) { flog("inflate failed: ", path); *len = 0; return NULL; }
        *len = raw;
        return u;
    }
    return b;
}

/* A cache file's bytes (malloc'd), or NULL. */
uint8_t *g3_read_file(const char *path, size_t *len) {
    *len = 0;
    long e; int dir;
    if (pk_find(path, &e, &dir)) {
        if (e < 0) return NULL;
        const PkEnt *pe = &pk_ent[e];
        uint8_t *b = (uint8_t *)malloc(pe->data_len ? pe->data_len : 1);
        if (!b) return NULL;
        if (fseek(pk_f, (long)pe->data_off, SEEK_SET) != 0 || fread(b, 1, pe->data_len, pk_f) != pe->data_len) {
            free(b); flog("pack read failed: ", path); return NULL;
        }
        *len = pe->data_len;
        return unzip(b, len, path);
    }
    char full[600];
    snprintf(full, sizeof(full), "%s%s", g3_root, path);
    FILE *f = fopen(full, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) { fclose(f); return NULL; }
    uint8_t *b = (uint8_t *)malloc(n > 0 ? (size_t)n : 1);
    if (!b) { fclose(f); return NULL; }
    size_t got = n > 0 ? fread(b, 1, (size_t)n, f) : 0;
    fclose(f);
    if ((long)got != n) { free(b); return NULL; }
    *len = (size_t)n;
    return unzip(b, len, path);
}

int g3_exists(const char *path) {
    long e; int dir;
    if (pk_find(path, &e, &dir)) return e >= 0 || dir;
    char full[600];
    snprintf(full, sizeof(full), "%s%s", g3_root, path);
    FILE *f = fopen(full, "rb");
    if (!f) return 0;
    fclose(f);
    return 1;
}
