/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The Gen 3 guest's natives (platform/host.ts
   G3Host), added to `globalThis.voxel` beside the shared ones
   (vendor/quickjs/voxel_shim.c):

     g3TexUpload(id, w, h, ArrayBuffer | typed array, repeat)
     g3TexFromCache(id, path) -> [w, h] | undefined   (PNG decoded here)
     g3Canvas(id, w, h), g3TexFree(id)
     g3Draw(Float32Array)                              (the frame's draw list)
     g3Read(path) -> byte string | undefined           (one char per byte)
     g3ReadBuf(path) -> ArrayBuffer | undefined
     g3Exists(path) -> bool
     g3Ents(Float32Array, n)                           (the field's billboards,
                                                        platform/worldview.ts)
     g3Strips(mode, r, g, b, a)                        (the top screen's side
                                                        strips, worldview.ts)
     g3PngDecode(byte string) -> [w, h, Uint8Array] | undefined
                                                       (RGBA8, what platform/
                                                        pngdecode.ts gives)
     g3Bytes(byte string) -> Uint8Array | undefined    (lua.ts toBytes' bytes)
     g3Log(line)                                       (to the log file alone:
                                                        console.log also prints
                                                        it to stdout, slowly)

   Paths are the cache's (data/generated/gba/...), under
   sdmc:/3ds/voxelmon/firered/. */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <malloc.h>
#include "quickjs.h"

int g3_tex_upload(int id, int w, int h, const uint8_t *rgba, size_t len, int repeat);
int g3_tex_from_cache(int id, const char *path, int *ow, int *oh);
void g3_canvas_new(int id, int w, int h);
void g3_tex_free(int id);
void g3_draw(const float *f, size_t n);
void g3_batch_upload(int id, int tex, const float *q, int n);
void g3_batch_free(int id);
void g3_ents_set(const float *f, int n);
void g3_strips_set(int mode, float r, float g, float b, float a);
uint8_t *g3_read_file(const char *path, size_t *len);
int g3_exists(const char *path);
uint8_t *g3_png_decode(const uint8_t *png, size_t len, int *ow, int *oh);
int g3_png_same(const uint8_t *png, size_t len);
void g3_dlog(const char *s, int len);

/* The bytes of an ArrayBuffer or a typed array (the guest's own memory). */
static const uint8_t *g3_bytes(JSContext *ctx, JSValueConst v, size_t *len) {
    size_t off = 0, blen = 0, bpe = 0, size = 0;
    *len = 0;
    uint8_t *p = JS_GetArrayBuffer(ctx, &size, v);
    if (p) { *len = size; return p; }
    JS_FreeValue(ctx, JS_GetException(ctx));
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &blen, &bpe);
    if (JS_IsException(ab)) { JS_FreeValue(ctx, JS_GetException(ctx)); return NULL; }
    p = JS_GetArrayBuffer(ctx, &size, ab);
    JS_FreeValue(ctx, ab);
    if (!p || off + blen > size) return NULL;
    *len = blen;
    return p + off;
}

static JSValue g3_texupload(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 4) return JS_FALSE;
    int32_t id = 0, w = 0, h = 0;
    JS_ToInt32(ctx, &id, v[0]);
    JS_ToInt32(ctx, &w, v[1]);
    JS_ToInt32(ctx, &h, v[2]);
    int rep = c > 4 ? JS_ToBool(ctx, v[4]) : 0;
    size_t len = 0;
    const uint8_t *p = g3_bytes(ctx, v[3], &len);
    return JS_NewBool(ctx, p && g3_tex_upload(id, w, h, p, len, rep));
}

static JSValue g3_texfromcache(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 2) return JS_UNDEFINED;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, v[0]);
    const char *path = JS_ToCString(ctx, v[1]);
    if (!path) return JS_UNDEFINED;
    int w = 0, h = 0;
    int ok = g3_tex_from_cache(id, path, &w, &h);
    JS_FreeCString(ctx, path);
    if (!ok) return JS_UNDEFINED;
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, w));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, h));
    return a;
}

static JSValue g3_canvas(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 3) return JS_UNDEFINED;
    int32_t id = 0, w = 0, h = 0;
    JS_ToInt32(ctx, &id, v[0]);
    JS_ToInt32(ctx, &w, v[1]);
    JS_ToInt32(ctx, &h, v[2]);
    g3_canvas_new(id, w, h);
    return JS_UNDEFINED;
}

static JSValue g3_texfree(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, v[0]);
    g3_tex_free(id);
    return JS_UNDEFINED;
}

static JSValue g3_drawlist(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t len = 0;
    const uint8_t *p = g3_bytes(ctx, v[0], &len);
    if (!p || ((uintptr_t)p & 3)) return JS_UNDEFINED;
    g3_draw((const float *)p, len / 4);
    return JS_UNDEFINED;
}

/* g3BatchUpload(id, tex, Float32Array, count) / g3BatchFree(id): a sprite
   batch the renderer keeps for OP_BATCH (platform/host.ts batchUpload). */
static JSValue g3_batchupload(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 4) return JS_UNDEFINED;
    int32_t id = 0, tex = 0, n = 0; /* int32_t is long on devkitARM */
    JS_ToInt32(ctx, &id, v[0]);
    JS_ToInt32(ctx, &tex, v[1]);
    JS_ToInt32(ctx, &n, v[3]);
    size_t len = 0;
    const uint8_t *p = g3_bytes(ctx, v[2], &len);
    if (n < 0 || (p == NULL && n > 0) || ((uintptr_t)p & 3) || len / 4 < (size_t)n * 12) return JS_UNDEFINED;
    g3_batch_upload((int)id, (int)tex, (const float *)p, (int)n);
    return JS_UNDEFINED;
}

static JSValue g3_batchfree(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    int32_t id = 0;
    if (c >= 1) JS_ToInt32(ctx, &id, v[0]);
    g3_batch_free((int)id);
    return JS_UNDEFINED;
}

/* g3Ents(Float32Array, n): the field's billboards for the world pass
   (worldview.ts ENT_FLOATS = 13 floats each), kept until the next call. */
static JSValue g3_ents(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 2) return JS_UNDEFINED;
    int32_t n = 0;
    JS_ToInt32(ctx, &n, v[1]);
    size_t len = 0;
    const uint8_t *p = g3_bytes(ctx, v[0], &len);
    if (n < 0 || (p == NULL && n > 0) || ((uintptr_t)p & 3) || len / 4 < (size_t)n * 13) return JS_UNDEFINED;
    g3_ents_set((const float *)p, (int)n);
    return JS_UNDEFINED;
}

/* g3Strips(mode, r, g, b, a): the side strips beside the 2D layer
   (worldview.ts WorldStrips: 0 off, 1 a colour, 2 the layer's edge columns
   stretched), kept until the next call. */
static JSValue g3_strips(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 5) return JS_UNDEFINED;
    int32_t mode = 0;
    double r = 0, g = 0, b = 0, a = 0;
    JS_ToInt32(ctx, &mode, v[0]);
    JS_ToFloat64(ctx, &r, v[1]);
    JS_ToFloat64(ctx, &g, v[2]);
    JS_ToFloat64(ctx, &b, v[3]);
    JS_ToFloat64(ctx, &a, v[4]);
    g3_strips_set((int)mode, (float)r, (float)g, (float)b, (float)a);
    return JS_UNDEFINED;
}

/* The file as a JS string of one char per byte: the bytes re-encoded as
   UTF-8 (0x80..0xff take two), which QuickJS decodes into an 8-bit string. */
static JSValue g3_read(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    const char *path = JS_ToCString(ctx, v[0]);
    if (!path) return JS_UNDEFINED;
    size_t n = 0;
    uint8_t *b = g3_read_file(path, &n);
    JS_FreeCString(ctx, path);
    if (!b) return JS_UNDEFINED;
    size_t hi = 0;
    for (size_t i = 0; i < n; i++) hi += b[i] >> 7;
    JSValue r;
    if (!hi) {
        r = JS_NewStringLen(ctx, (const char *)b, n);
    } else {
        uint8_t *u = (uint8_t *)malloc(n + hi);
        if (!u) { free(b); return JS_ThrowOutOfMemory(ctx); }
        size_t k = 0;
        for (size_t i = 0; i < n; i++) {
            uint8_t x = b[i];
            if (x < 0x80) u[k++] = x;
            else { u[k++] = (uint8_t)(0xC0 | (x >> 6)); u[k++] = (uint8_t)(0x80 | (x & 0x3F)); }
        }
        r = JS_NewStringLen(ctx, (const char *)u, k);
        free(u);
    }
    free(b);
    return r;
}

/* the buffer's realloc hook: size 0 frees it (the only call a fixed buffer gets) */
static void *g3_realloc_buf(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    (void)rt; (void)opaque;
    if (size == 0) { free(ptr); return NULL; }
    return realloc(ptr, size);
}

static JSValue g3_readbuf(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    const char *path = JS_ToCString(ctx, v[0]);
    if (!path) return JS_UNDEFINED;
    size_t n = 0;
    uint8_t *b = g3_read_file(path, &n);
    JS_FreeCString(ctx, path);
    if (!b) return JS_UNDEFINED;
    return JS_NewArrayBuffer(ctx, b, n, 0, g3_realloc_buf, NULL, false);
}

static JSValue g3_log_js(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[0]);
    if (!s) { JS_FreeValue(ctx, JS_GetException(ctx)); return JS_UNDEFINED; }
    g3_dlog(s, (int)len);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* A byte string's bytes (lua.ts toBytes, in C): undefined if a char is
   over 0xFF, which toBytes alone handles (it keeps the low byte). */
static JSValue g3_bytes_js(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1 || !JS_IsString(v[0])) return JS_UNDEFINED;
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v[0]);
    if (!u) { JS_FreeValue(ctx, JS_GetException(ctx)); return JS_UNDEFINED; }
    uint8_t *b = (uint8_t *)malloc(ulen + 1);
    size_t n = 0;
    int bad = !b;
    for (size_t i = 0; !bad && i < ulen; i++) {
        uint8_t x = (uint8_t)u[i];
        if (x < 0x80) b[n++] = x;
        else if ((x == 0xC2 || x == 0xC3) && i + 1 < ulen) { b[n++] = (uint8_t)(((x & 0x1F) << 6) | ((uint8_t)u[i + 1] & 0x3F)); i++; }
        else bad = 1;
    }
    JS_FreeCString(ctx, u);
    if (bad) { free(b); return JS_UNDEFINED; }
    JSValue arr = JS_NewUint8Array(ctx, b, n, g3_realloc_buf, NULL, false);
    if (JS_IsException(arr)) { free(b); JS_FreeValue(ctx, JS_GetException(ctx)); return JS_UNDEFINED; }
    return arr;
}

/* A PNG (a byte string, as g3Read gives) decoded here rather than by the
   guest's inflate: [w, h, RGBA8 Uint8Array], or undefined when g3_png_same
   says no or it fails (the guest then decodes it itself). */
static JSValue g3_pngdecode(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v[0]);
    if (!u) { JS_FreeValue(ctx, JS_GetException(ctx)); return JS_UNDEFINED; }
    /* the string's UTF-8 back to its bytes (each char is one byte, 0..255) */
    uint8_t *b = (uint8_t *)malloc(ulen + 1);
    size_t n = 0;
    int bad = !b;
    for (size_t i = 0; !bad && i < ulen; i++) {
        uint8_t x = (uint8_t)u[i];
        if (x < 0x80) b[n++] = x;
        else if ((x & 0xE0) == 0xC0 && i + 1 < ulen) { b[n++] = (uint8_t)(((x & 0x1F) << 6) | ((uint8_t)u[i + 1] & 0x3F)); i++; }
        else bad = 1;
    }
    JS_FreeCString(ctx, u);
    if (bad || !g3_png_same(b, n)) { free(b); return JS_UNDEFINED; }
    int w = 0, h = 0;
    uint8_t *rgba = g3_png_decode(b, n, &w, &h);
    free(b);
    if (!rgba) return JS_UNDEFINED;
    JSValue arr = JS_NewUint8Array(ctx, rgba, (size_t)w * h * 4, g3_realloc_buf, NULL, false);
    if (JS_IsException(arr)) { free(rgba); return arr; }
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, w));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, h));
    JS_SetPropertyUint32(ctx, a, 2, arr);
    return a;
}

static JSValue g3_exists_js(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_FALSE;
    const char *path = JS_ToCString(ctx, v[0]);
    if (!path) return JS_FALSE;
    int ok = g3_exists(path);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}

/* ------------------------------------------------------------------ sound
   The G3Audio natives (platform/audio.ts), over the M4A engine in
   src/gen3/audio.rs (g3a_*):

     g3SongPlay(id) -> bool, g3SongStop(), g3SongPause(), g3SongResume(),
     g3SongVolume(gain), g3Song() -> id | -1, g3SongPaused() -> bool,
     g3SeMono(bool)
     g3SePlay(id, looping?, maxSec?, pan, gain) -> bool
     g3SeStop(id | -1 | undefined), g3SePlaying(id | -1 | undefined) -> bool,
     g3SePan(pan) -> pan
     g3FanfarePlay(id, volume) -> bool, g3FanfarePlaying() -> bool,
     g3FanfareStop()
     g3CryPlay(species, mode, pan, volume, length?, release?, pitch?,
               chorus?, reverse?, cryVolume?) -> frames | undefined
     g3CryStop(), g3CryPlaying() -> bool, g3AudioStopAll(), g3AudioReady()

   A missing optional argument is undefined (Lua nil): -1 for an id or a
   flag, NaN for a number. */

int g3a_ready(void);
int g3a_song_play(int id);
void g3a_song_stop(void);
void g3a_song_pause(void);
void g3a_song_resume(void);
void g3a_song_volume(double gain);
int g3a_song(void);
int g3a_song_paused(void);
void g3a_mono(int mono);
int g3a_se_play(int id, int looping, double max_sec, double pan, double gain);
void g3a_se_stop(int id);
int g3a_se_playing(int id);
double g3a_se_pan(double pan);
int g3a_fanfare_play(int id, double volume);
int g3a_fanfare_playing(void);
void g3a_fanfare_stop(void);
double g3a_cry_play(int species, int mode, double pan, double volume, const double *ov);
void g3a_cry_stop(void);
int g3a_cry_playing(void);
void g3a_stop_all(void);

static int g3_arg_int(JSContext *ctx, int c, JSValueConst *v, int i, int def) {
    int32_t x = def;
    if (i >= c || JS_IsUndefined(v[i]) || JS_IsNull(v[i])) return def;
    if (JS_ToInt32(ctx, &x, v[i])) { JS_FreeValue(ctx, JS_GetException(ctx)); return def; }
    return (int)x;
}

static double g3_arg_num(JSContext *ctx, int c, JSValueConst *v, int i, double def) {
    double x = def;
    if (i >= c || JS_IsUndefined(v[i]) || JS_IsNull(v[i])) return def;
    if (JS_ToFloat64(ctx, &x, v[i])) { JS_FreeValue(ctx, JS_GetException(ctx)); return def; }
    return x;
}

/* true/false (or a number), -1 when not given */
static int g3_arg_flag(JSContext *ctx, int c, JSValueConst *v, int i) {
    if (i >= c || JS_IsUndefined(v[i]) || JS_IsNull(v[i])) return -1;
    return JS_ToBool(ctx, v[i]) ? 1 : 0;
}

static JSValue g3_songplay(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    return JS_NewBool(ctx, g3a_song_play(g3_arg_int(ctx, c, v, 0, -1)));
}
static JSValue g3_songstop(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_song_stop();
    return JS_UNDEFINED;
}
static JSValue g3_songpause(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_song_pause();
    return JS_UNDEFINED;
}
static JSValue g3_songresume(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_song_resume();
    return JS_UNDEFINED;
}
static JSValue g3_songvolume(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    g3a_song_volume(g3_arg_num(ctx, c, v, 0, 1.0));
    return JS_UNDEFINED;
}
static JSValue g3_song(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewInt32(ctx, g3a_song());
}
static JSValue g3_songpaused(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewBool(ctx, g3a_song_paused());
}
static JSValue g3_semono(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    g3a_mono(g3_arg_flag(ctx, c, v, 0) == 1);
    return JS_UNDEFINED;
}
static JSValue g3_seplay(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    return JS_NewBool(ctx, g3a_se_play(g3_arg_int(ctx, c, v, 0, -1), g3_arg_flag(ctx, c, v, 1),
        g3_arg_num(ctx, c, v, 2, NAN), g3_arg_num(ctx, c, v, 3, 0.0), g3_arg_num(ctx, c, v, 4, 1.0)));
}
static JSValue g3_sestop(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    g3a_se_stop(g3_arg_int(ctx, c, v, 0, -1));
    return JS_UNDEFINED;
}
static JSValue g3_seplaying(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    return JS_NewBool(ctx, g3a_se_playing(g3_arg_int(ctx, c, v, 0, -1)));
}
static JSValue g3_sepan(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    return JS_NewFloat64(ctx, g3a_se_pan(g3_arg_num(ctx, c, v, 0, 0.0)));
}
static JSValue g3_fanfareplay(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    return JS_NewBool(ctx, g3a_fanfare_play(g3_arg_int(ctx, c, v, 0, -1), g3_arg_num(ctx, c, v, 1, 1.0)));
}
static JSValue g3_fanfareplaying(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewBool(ctx, g3a_fanfare_playing());
}
static JSValue g3_fanfarestop(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_fanfare_stop();
    return JS_UNDEFINED;
}
static JSValue g3_cryplay(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    double ov[6];
    for (int i = 0; i < 6; i++) ov[i] = g3_arg_num(ctx, c, v, 4 + i, NAN);
    double frames = g3a_cry_play(g3_arg_int(ctx, c, v, 0, -1), g3_arg_int(ctx, c, v, 1, 0),
        g3_arg_num(ctx, c, v, 2, 0.0), g3_arg_num(ctx, c, v, 3, 1.0), ov);
    if (isnan(frames)) return JS_UNDEFINED;
    return JS_NewFloat64(ctx, frames);
}
static JSValue g3_crystop(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_cry_stop();
    return JS_UNDEFINED;
}
static JSValue g3_cryplaying(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewBool(ctx, g3a_cry_playing());
}
static JSValue g3_stopall(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    g3a_stop_all();
    return JS_UNDEFINED;
}
/* ------------------------------------------------------------------ boot
   The guest's code as QuickJS bytecode (cc_build_firered.sh compiles the
   bundle on the PC, tools/gen3/qjs_run.c --compile, source stripped): the
   console skips parsing 6 MB of JavaScript and keeps no copy of the source
   per function. game-firered.js is then just `voxel.g3RunBytecode()`. */

static const uint8_t *g3_bc;
static size_t g3_bc_len;

void g3_set_bytecode(const uint8_t *p, size_t n) { g3_bc = p; g3_bc_len = n; }

static JSValue g3_runbytecode(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    if (!g3_bc || !g3_bc_len) return JS_ThrowInternalError(ctx, "no bytecode in this build");
    JSValue fn = JS_ReadObject(ctx, g3_bc, g3_bc_len, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(fn)) return fn;
    JSValue r = JS_EvalFunction(ctx, fn);
    if (JS_IsException(r)) return r;
    JS_FreeValue(ctx, r);
    return JS_UNDEFINED;
}

/* g3Mem() -> [QuickJS heap bytes, app heap used, app heap size, linear free,
   app heap high water (newlib's arena), QuickJS GC threshold]
   (the boot and perf lines; JS_ComputeMemoryUsage walks the heap, so not
   every frame) */
extern char *fake_heap_start, *fake_heap_end;
unsigned int linearSpaceFree(void);

/* g3Mem([cheap]): [QuickJS heap, app heap used, app heap size, linear free,
   app heap high water, GC threshold]. JS_ComputeMemoryUsage walks every
   object of the QuickJS heap (~130 ms of a frame at 300% clock in the
   field), so a cheap call -- the perf lines' -- gives -1 for the first. */
static JSValue g3_mem(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    int cheap = c > 0 && JS_ToBool(ctx, v[0]);
    JSMemoryUsage mu;
    if (!cheap) JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mu);
    struct mallinfo mi = mallinfo();
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewFloat64(ctx, cheap ? -1.0 : (double)mu.malloc_size));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewFloat64(ctx, (double)(unsigned)mi.uordblks));
    JS_SetPropertyUint32(ctx, a, 2, JS_NewFloat64(ctx, (double)(fake_heap_end - fake_heap_start)));
    JS_SetPropertyUint32(ctx, a, 3, JS_NewFloat64(ctx, (double)linearSpaceFree()));
    JS_SetPropertyUint32(ctx, a, 4, JS_NewFloat64(ctx, (double)(unsigned)mi.arena));
    JS_SetPropertyUint32(ctx, a, 5, JS_NewFloat64(ctx, (double)JS_GetGCThreshold(JS_GetRuntime(ctx))));
    return a;
}

/* g3Gc(hold): true holds QuickJS's cycle collector off (Game3.load builds
   tens of MB of tables that hold no cycles, and each collection walks all of
   them: seconds on the console); false runs one collection now and puts the
   threshold back where QuickJS would (1.5x the heap in use). */
static JSValue g3_gc(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (c > 0 && JS_ToBool(ctx, v[0])) {
        JS_SetGCThreshold(rt, (size_t)-1);
    } else {
        JS_RunGC(rt);
        JSMemoryUsage mu;
        JS_ComputeMemoryUsage(rt, &mu);
        JS_SetGCThreshold(rt, (size_t)(mu.malloc_size + mu.malloc_size / 2));
    }
    return JS_UNDEFINED;
}

static JSValue g3_audioready(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewBool(ctx, g3a_ready());
}

int qjs_register_g3(JSContext *ctx) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue o = JS_GetPropertyStr(ctx, g, "voxel");
    if (!JS_IsObject(o)) { JS_FreeValue(ctx, o); JS_FreeValue(ctx, g); return -1; }
    JS_SetPropertyStr(ctx, o, "g3TexUpload", JS_NewCFunction(ctx, g3_texupload, "g3TexUpload", 5));
    JS_SetPropertyStr(ctx, o, "g3TexFromCache", JS_NewCFunction(ctx, g3_texfromcache, "g3TexFromCache", 2));
    JS_SetPropertyStr(ctx, o, "g3Canvas", JS_NewCFunction(ctx, g3_canvas, "g3Canvas", 3));
    JS_SetPropertyStr(ctx, o, "g3TexFree", JS_NewCFunction(ctx, g3_texfree, "g3TexFree", 1));
    JS_SetPropertyStr(ctx, o, "g3Draw", JS_NewCFunction(ctx, g3_drawlist, "g3Draw", 1));
    JS_SetPropertyStr(ctx, o, "g3BatchUpload", JS_NewCFunction(ctx, g3_batchupload, "g3BatchUpload", 4));
    JS_SetPropertyStr(ctx, o, "g3BatchFree", JS_NewCFunction(ctx, g3_batchfree, "g3BatchFree", 1));
    JS_SetPropertyStr(ctx, o, "g3Read", JS_NewCFunction(ctx, g3_read, "g3Read", 1));
    JS_SetPropertyStr(ctx, o, "g3ReadBuf", JS_NewCFunction(ctx, g3_readbuf, "g3ReadBuf", 1));
    JS_SetPropertyStr(ctx, o, "g3Exists", JS_NewCFunction(ctx, g3_exists_js, "g3Exists", 1));
    JS_SetPropertyStr(ctx, o, "g3Ents", JS_NewCFunction(ctx, g3_ents, "g3Ents", 2));
    JS_SetPropertyStr(ctx, o, "g3RunBytecode", JS_NewCFunction(ctx, g3_runbytecode, "g3RunBytecode", 0));
    JS_SetPropertyStr(ctx, o, "g3Mem", JS_NewCFunction(ctx, g3_mem, "g3Mem", 0));
    JS_SetPropertyStr(ctx, o, "g3Gc", JS_NewCFunction(ctx, g3_gc, "g3Gc", 1));
    JS_SetPropertyStr(ctx, o, "g3Strips", JS_NewCFunction(ctx, g3_strips, "g3Strips", 5));
    JS_SetPropertyStr(ctx, o, "g3PngDecode", JS_NewCFunction(ctx, g3_pngdecode, "g3PngDecode", 1));
    JS_SetPropertyStr(ctx, o, "g3Bytes", JS_NewCFunction(ctx, g3_bytes_js, "g3Bytes", 1));
    JS_SetPropertyStr(ctx, o, "g3Log", JS_NewCFunction(ctx, g3_log_js, "g3Log", 1));
    static const struct { const char *name; JSCFunction *fn; int n; } snd[] = {
        { "g3SongPlay", g3_songplay, 1 }, { "g3SongStop", g3_songstop, 0 },
        { "g3SongPause", g3_songpause, 0 }, { "g3SongResume", g3_songresume, 0 },
        { "g3SongVolume", g3_songvolume, 1 }, { "g3Song", g3_song, 0 },
        { "g3SongPaused", g3_songpaused, 0 }, { "g3SeMono", g3_semono, 1 },
        { "g3SePlay", g3_seplay, 5 }, { "g3SeStop", g3_sestop, 1 },
        { "g3SePlaying", g3_seplaying, 1 }, { "g3SePan", g3_sepan, 1 },
        { "g3FanfarePlay", g3_fanfareplay, 2 }, { "g3FanfarePlaying", g3_fanfareplaying, 0 },
        { "g3FanfareStop", g3_fanfarestop, 0 }, { "g3CryPlay", g3_cryplay, 10 },
        { "g3CryStop", g3_crystop, 0 }, { "g3CryPlaying", g3_cryplaying, 0 },
        { "g3AudioStopAll", g3_stopall, 0 }, { "g3AudioReady", g3_audioready, 0 },
    };
    for (size_t i = 0; i < sizeof(snd) / sizeof(snd[0]); i++)
        JS_SetPropertyStr(ctx, o, snd[i].name, JS_NewCFunction(ctx, snd[i].fn, snd[i].name, snd[i].n));
    JS_FreeValue(ctx, o);
    JS_FreeValue(ctx, g);
    return 0;
}
