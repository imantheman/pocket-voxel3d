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

   Paths are the cache's (data/generated/gba/...), under
   sdmc:/3ds/voxelmon/firered/. */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "quickjs.h"

int g3_tex_upload(int id, int w, int h, const uint8_t *rgba, size_t len, int repeat);
int g3_tex_from_cache(int id, const char *path, int *ow, int *oh);
void g3_canvas_new(int id, int w, int h);
void g3_tex_free(int id);
void g3_draw(const float *f, size_t n);
void g3_batch_upload(int id, int tex, const float *q, int n);
void g3_batch_free(int id);
uint8_t *g3_read_file(const char *path, size_t *len);
int g3_exists(const char *path);

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
