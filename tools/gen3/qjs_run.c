/* Port tooling: run a bundled script under the 3DS's QuickJS on the desktop.
 * cc_g3_qjsbench.sh builds it.
 *   qjs_run <script.js> [cache-root]
 * Globals:
 *   print(...)            stdout
 *   readFile(path)        the file under cache-root as a byte string (one char
 *                         per byte, as the 3DS host's g3Read), or undefined,
 *                         read by the host's own g3_read_file (src/gen3/g3_files.c:
 *                         a card's data.pvpk, deflated files)
 *   nowUs()               microseconds, monotonic
 *   memUsage()            [bytes in use, peak bytes] of the QuickJS heap
 *   memPeakReset()        start a new peak from the current use
 *   memDetail()           the heap by kind (JS_ComputeMemoryUsage): {str, obj, binary, ...} bytes
 *   gc()                  run the cycle collector
 *   gcHold(on)            hold the collector off / run it and re-arm (g3Gc)
 *   pngDecode(bytes)      the host PNG decoder (g3PngDecode): [w, h, Uint8Array] or undefined
 *   texStore(id, w, h, rgba) / texDrop(id) / texRead(id, w, h, probe) / texBytes()
 *                         textures kept outside the QuickJS heap, read back as
 *                         the 3DS host's g3TexRead
 *   refCount(object)      QuickJS's reference count of it (the host's g3RefCount)
 *   gcThreshold()         the heap size at which QuickJS next collects cycles
 *   gcClamp()             the console's hold on that threshold (g3_shim.c g3_gc_clamp)
 * QJS_LIMIT_MB=<n> sets JS_SetMemoryLimit, as a console's heap would.
 *
 *   qjs_run --compile <script.js> <out.qbc> [strip]
 * compiles a script to QuickJS bytecode (JS_WriteObject; strip = none,
 * source, debug or all: JS_WRITE_OBJ_STRIP_*), as the 3DS loads FireRed's
 * bundle (cc_build_firered.sh). A <script> ending in .qbc is run from bytecode.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>
#include "quickjs.h"

static const char *g_root = ".";

/* the 3DS host's own card reads (src/gen3/g3_files.c: the pack, loose
   files, deflated files) */
uint8_t *g3_read_file(const char *path, size_t *len);
void g3_files_root(const char *root);
void voxel_log(const char *s, int len) { fprintf(stderr, "%.*s\n", len, s); }

/* the runtime's allocator, counting what is in use and its peak */
static size_t g_use, g_peak;
static void *cnt_malloc(void *o, size_t n) {
    (void)o;
    size_t *p = malloc(n + 16);
    if (!p) return NULL;
    p[0] = n; g_use += n; if (g_use > g_peak) g_peak = g_use;
    return (char *)p + 16;
}
static void *cnt_calloc(void *o, size_t c, size_t n) {
    void *p = cnt_malloc(o, c * n);
    if (p) memset(p, 0, c * n);
    return p;
}
static void cnt_free(void *o, void *ptr) {
    (void)o;
    if (!ptr) return;
    size_t *p = (size_t *)((char *)ptr - 16);
    g_use -= p[0];
    free(p);
}
static void *cnt_realloc(void *o, void *ptr, size_t n) {
    if (!ptr) return cnt_malloc(o, n);
    if (n == 0) { cnt_free(o, ptr); return NULL; }
    size_t *p = (size_t *)((char *)ptr - 16);
    size_t old = p[0];
    size_t *q = realloc(p, n + 16);
    if (!q) return NULL;
    q[0] = n; g_use = g_use - old + n; if (g_use > g_peak) g_peak = g_use;
    return (char *)q + 16;
}
static size_t cnt_usable(const void *ptr) {
    return ptr ? ((const size_t *)((const char *)ptr - 16))[0] : 0;
}
static const JSMallocFunctions cnt_mf = { cnt_calloc, cnt_malloc, cnt_free, cnt_realloc, cnt_usable };
static JSRuntime *g_rt;

static JSValue js_memusage(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewFloat64(ctx, (double)g_use));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewFloat64(ctx, (double)g_peak));
    return a;
}
/* memDetail() -> {str, obj, prop, shape, func, code, binary, ...}: the
   QuickJS heap by kind of thing (JS_ComputeMemoryUsage), sizes in bytes */
static JSValue js_memdetail(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(g_rt, &mu);
    JSValue o = JS_NewObject(ctx);
#define MD(k, x) JS_SetPropertyStr(ctx, o, k, JS_NewFloat64(ctx, (double)(x)))
    MD("total", mu.malloc_size); MD("str", mu.str_size); MD("strN", mu.str_count);
    MD("obj", mu.obj_size); MD("objN", mu.obj_count); MD("prop", mu.prop_size); MD("shape", mu.shape_size);
    MD("func", mu.js_func_size); MD("code", mu.js_func_code_size); MD("pc2line", mu.js_func_pc2line_size);
    MD("arrayN", mu.array_count); MD("fastArrayN", mu.fast_array_count); MD("fastElems", mu.fast_array_elements);
    MD("binary", mu.binary_object_size); MD("binaryN", mu.binary_object_count); MD("atoms", mu.atom_size);
#undef MD
    return o;
}
static JSValue js_mempeakreset(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    g_peak = g_use;
    return JS_UNDEFINED;
}
static JSValue js_gc(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    JS_RunGC(g_rt);
    return JS_UNDEFINED;
}

/* gcHold(true|false): as the 3DS host's g3Gc (src/gen3/g3_shim.c) */
static JSValue js_gchold(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c > 0 && JS_ToBool(ctx, v[0])) JS_SetGCThreshold(g_rt, (size_t)-1);
    else { JS_RunGC(g_rt); JS_SetGCThreshold(g_rt, g_use + g_use / 2); }
    return JS_UNDEFINED;
}

static JSValue js_print(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    for (int i = 0; i < c; i++) {
        const char *s = JS_ToCString(ctx, v[i]);
        if (s) { fputs(s, stdout); JS_FreeCString(ctx, s); }
    }
    fputc('\n', stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue js_readfile(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    const char *rel = JS_ToCString(ctx, v[0]);
    if (!rel) return JS_UNDEFINED;
    size_t got = 0;
    unsigned char *b = g3_read_file(rel, &got);
    JS_FreeCString(ctx, rel);
    if (!b) return JS_UNDEFINED;
    /* bytes -> UTF-8 so QuickJS makes an 8-bit string of the same chars */
    char *u = malloc(got * 2 + 1);
    size_t k = 0;
    for (size_t i = 0; i < got; i++) {
        unsigned char ch = b[i];
        if (ch < 0x80) u[k++] = (char)ch;
        else { u[k++] = (char)(0xc0 | (ch >> 6)); u[k++] = (char)(0x80 | (ch & 0x3f)); }
    }
    JSValue s = JS_NewStringLen(ctx, u, k);
    free(u); free(b);
    return s;
}

/* pngDecode(byteString): the 3DS host's g3PngDecode (src/gen3/g3_shim.c):
   [w, h, Uint8Array] when g3_png_same, else undefined */
uint8_t *g3_png_decode(const uint8_t *png, size_t len, int *ow, int *oh);
int g3_png_same(const uint8_t *png, size_t len);
static void *js_realloc_buf(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    (void)rt; (void)opaque;
    if (size == 0) { free(ptr); return NULL; }
    return realloc(ptr, size);
}
static JSValue js_pngdecode(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v[0]);
    if (!u) return JS_UNDEFINED;
    uint8_t *b = malloc(ulen + 1);
    size_t n = 0;
    for (size_t i = 0; i < ulen; i++) {
        uint8_t x = (uint8_t)u[i];
        if (x < 0x80) b[n++] = x;
        else { b[n++] = (uint8_t)(((x & 0x1F) << 6) | ((uint8_t)u[i + 1] & 0x3F)); i++; }
    }
    JS_FreeCString(ctx, u);
    if (!g3_png_same(b, n)) { free(b); return JS_UNDEFINED; }
    int w = 0, h = 0;
    uint8_t *rgba = g3_png_decode(b, n, &w, &h);
    free(b);
    if (!rgba) return JS_UNDEFINED;
    JSValue arr = JS_NewUint8Array(ctx, rgba, (size_t)w * h * 4, js_realloc_buf, NULL, false);
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewInt32(ctx, w));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewInt32(ctx, h));
    JS_SetPropertyUint32(ctx, a, 2, arr);
    return a;
}

/* The bytes of a typed array. */
static uint8_t *ta_bytes(JSContext *ctx, JSValueConst v, size_t *len) {
    size_t off = 0, blen = 0, bpe = 0, size = 0;
    *len = 0;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &blen, &bpe);
    if (JS_IsException(ab)) { JS_FreeValue(ctx, JS_GetException(ctx)); return NULL; }
    uint8_t *p = JS_GetArrayBuffer(ctx, &size, ab);
    JS_FreeValue(ctx, ab);
    if (!p || off + blen > size) return NULL;
    *len = blen;
    return p + off;
}

/* nativeBytes(s): a byte string's bytes, as the 3DS host's g3Bytes (undefined
   for a char over 0xFF) -- so a profile here pays what the console pays */
static JSValue js_nativebytes(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1 || !JS_IsString(v[0])) return JS_UNDEFINED;
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v[0]);
    if (!u) return JS_UNDEFINED;
    uint8_t *b = malloc(ulen + 1);
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
    return JS_NewUint8Array(ctx, b, n, js_realloc_buf, NULL, false);
}

/* nativeBlit(dst, dw, dx, dy, src, sw, sx, sy, w, h): the 3DS host's g3Blit */
static JSValue js_nativeblit(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 10) return JS_FALSE;
    int32_t a[8];
    size_t dl = 0, sl = 0;
    uint8_t *d = ta_bytes(ctx, v[0], &dl);
    const uint8_t *s = ta_bytes(ctx, v[4], &sl);
    JS_ToInt32(ctx, &a[0], v[1]); JS_ToInt32(ctx, &a[1], v[2]); JS_ToInt32(ctx, &a[2], v[3]);
    JS_ToInt32(ctx, &a[3], v[5]); JS_ToInt32(ctx, &a[4], v[6]); JS_ToInt32(ctx, &a[5], v[7]);
    JS_ToInt32(ctx, &a[6], v[8]); JS_ToInt32(ctx, &a[7], v[9]);
    int dw = a[0], dx = a[1], dy = a[2], sw = a[3], sx = a[4], sy = a[5], w = a[6], h = a[7];
    if (!d || !s || dw <= 0 || sw <= 0 || w <= 0 || h <= 0 || dx < 0 || dy < 0 || sx < 0 || sy < 0
        || dx + w > dw || sx + w > sw
        || ((size_t)(dy + h) * dw * 4) > dl || ((size_t)(sy + h) * sw * 4) > sl) return JS_FALSE;
    for (int y = 0; y < h; y++)
        memcpy(d + ((size_t)(dy + y) * dw + dx) * 4, s + ((size_t)(sy + y) * sw + sx) * 4, (size_t)w * 4);
    return JS_TRUE;
}

/* nativeMd5 / nativeBake: the 3DS host's g3Md5 / g3Bake (g3_fast.c, the same file) */
#include "../../crates/pocketvoxel-3ds/src/gen3/g3_fast.c"

static uint8_t *str_bytes(JSContext *ctx, JSValueConst v, size_t *out_n) {
    *out_n = 0;
    if (!JS_IsString(v)) return NULL;
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v);
    if (!u) return NULL;
    uint8_t *b = malloc(ulen + 1);
    size_t n = 0;
    int bad = !b;
    for (size_t i = 0; !bad && i < ulen; i++) {
        uint8_t x = (uint8_t)u[i];
        if (x < 0x80) b[n++] = x;
        else if ((x == 0xC2 || x == 0xC3) && i + 1 < ulen) { b[n++] = (uint8_t)(((x & 0x1F) << 6) | ((uint8_t)u[i + 1] & 0x3F)); i++; }
        else bad = 1;
    }
    JS_FreeCString(ctx, u);
    if (bad) { free(b); return NULL; }
    *out_n = n;
    return b;
}

static JSValue js_nativemd5(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t n = 0;
    uint8_t *b = str_bytes(ctx, v[0], &n);
    if (!b) return JS_UNDEFINED;
    char hex[33];
    g3_md5_hex(b, n, hex);
    free(b);
    return JS_NewStringLen(ctx, hex, 32);
}

static JSValue js_nativebake(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 6) return JS_UNDEFINED;
    int32_t pix0 = 0, mids = 0, cols = 0, rows = 0;
    JS_ToInt32(ctx, &pix0, v[1]); JS_ToInt32(ctx, &mids, v[2]);
    JS_ToInt32(ctx, &cols, v[3]); JS_ToInt32(ctx, &rows, v[4]);
    size_t ll = 0;
    const uint8_t *lut = ta_bytes(ctx, v[5], &ll);
    if (!lut || ll < 1024 || pix0 < 0 || mids < 0 || cols < 1 || rows < 1 || cols * rows > 16384) return JS_UNDEFINED;
    size_t n = 0;
    uint8_t *blob = str_bytes(ctx, v[0], &n);
    if (!blob) return JS_UNDEFINED;
    size_t w = (size_t)cols * 16, h = (size_t)rows * 16, len = w * h * 4;
    uint8_t *out = malloc(len);
    size_t npix = (size_t)pix0 < n ? n - (size_t)pix0 : 0;
    if (npix > (size_t)mids * 256) npix = (size_t)mids * 256;
    g3_bake_rgba(blob + ((size_t)pix0 < n ? (size_t)pix0 : n), npix, (int)mids, (int)cols, (int)rows, lut, out);
    free(blob);
    /* as a byte string: chars 0x80..0xFF go in as two bytes of UTF-8 */
    size_t hi = 0;
    for (size_t i = 0; i < len; i++) hi += out[i] >> 7;
    uint8_t *u = malloc(len + hi);
    size_t k = 0;
    for (size_t i = 0; i < len; i++) {
        uint8_t x = out[i];
        if (x < 0x80) u[k++] = x;
        else { u[k++] = (uint8_t)(0xC0 | (x >> 6)); u[k++] = (uint8_t)(0x80 | (x & 0x3F)); }
    }
    free(out);
    JSValue r = JS_NewStringLen(ctx, (const char *)u, k);
    free(u);
    return r;
}

/* The host's textures, as the 3DS keeps them, outside the QuickJS heap:
   texStore(id, w, h, rgba) keeps a copy, texDrop(id) lets it go,
   texRead(id, w, h, probe) is the 3DS host's g3TexRead (its pixels back as
   a Uint8Array, or undefined; probe: whether it can be). */
typedef struct { int w, h; uint8_t *px; } Tex;
static Tex *g_tex;
static int g_ntex;
static size_t g_tex_bytes;
static JSValue js_texstore(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 4) return JS_UNDEFINED;
    int32_t id = 0, w = 0, h = 0;
    JS_ToInt32(ctx, &id, v[0]); JS_ToInt32(ctx, &w, v[1]); JS_ToInt32(ctx, &h, v[2]);
    size_t len = 0;
    const uint8_t *p = ta_bytes(ctx, v[3], &len);
    if (id <= 0 || w <= 0 || h <= 0 || !p || len < (size_t)w * h * 4) return JS_UNDEFINED;
    if (id >= g_ntex) {
        int n = g_ntex ? g_ntex : 256;
        while (n <= id) n *= 2;
        g_tex = realloc(g_tex, sizeof(Tex) * n);
        memset(g_tex + g_ntex, 0, sizeof(Tex) * (n - g_ntex));
        g_ntex = n;
    }
    Tex *x = &g_tex[id];
    if (x->px) g_tex_bytes -= (size_t)x->w * x->h * 4;
    free(x->px);
    x->w = w; x->h = h;
    x->px = malloc((size_t)w * h * 4);
    memcpy(x->px, p, (size_t)w * h * 4);
    g_tex_bytes += (size_t)w * h * 4;
    return JS_UNDEFINED;
}
static JSValue js_texdrop(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    int32_t id = 0;
    if (c < 1) return JS_UNDEFINED;
    JS_ToInt32(ctx, &id, v[0]);
    if (id > 0 && id < g_ntex && g_tex[id].px) {
        g_tex_bytes -= (size_t)g_tex[id].w * g_tex[id].h * 4;
        free(g_tex[id].px);
        g_tex[id].px = NULL;
    }
    return JS_UNDEFINED;
}
static JSValue js_texread(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 4) return JS_UNDEFINED;
    int32_t id = 0, w = 0, h = 0;
    JS_ToInt32(ctx, &id, v[0]); JS_ToInt32(ctx, &w, v[1]); JS_ToInt32(ctx, &h, v[2]);
    int ok = id > 0 && id < g_ntex && g_tex[id].px && g_tex[id].w == w && g_tex[id].h == h;
    if (JS_ToBool(ctx, v[3])) return JS_NewBool(ctx, ok);
    if (!ok) return JS_UNDEFINED;
    uint8_t *b = malloc((size_t)w * h * 4);
    memcpy(b, g_tex[id].px, (size_t)w * h * 4);
    return JS_NewUint8Array(ctx, b, (size_t)w * h * 4, js_realloc_buf, NULL, false);
}
/* gcClamp(): the console's per-frame hold on the collector's next threshold
   (src/gen3/g3_shim.c g3_gc_clamp: 6 MB past the heap in use at most);
   the number of collections QuickJS ran since the last call. */
static size_t g_gc_set;
static JSValue js_gcclamp(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    JSRuntime *rt = JS_GetRuntime(ctx);
    size_t th = JS_GetGCThreshold(rt);
    if (th == g_gc_set || th == (size_t)-1) return JS_NewInt32(ctx, 0);
    size_t used = th / 3 * 2, head = (size_t)6 << 20;
    g_gc_set = used + (used / 2 < head ? used / 2 : head);
    JS_SetGCThreshold(rt, g_gc_set);
    return JS_NewInt32(ctx, 1);
}
static JSValue js_gcthreshold(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewFloat64(ctx, (double)JS_GetGCThreshold(JS_GetRuntime(ctx)));
}
static JSValue js_texbytes(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewFloat64(ctx, (double)g_tex_bytes);
}
/* refCount(object): the 3DS host's g3RefCount (the allocator block header's
   ref_count, vendor quickjs.c JSMallocBlockHeader) */
static JSValue js_refcount(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1 || !JS_IsObject(v[0])) return JS_NewInt32(ctx, -1);
    const uint8_t *p = (const uint8_t *)JS_VALUE_GET_PTR(v[0]);
    int32_t rc;
    memcpy(&rc, p - 8 + 4, sizeof rc);
    return JS_NewInt32(ctx, rc);
}

static JSValue js_nowus(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewFloat64(ctx, ts.tv_sec * 1e6 + ts.tv_nsec / 1e3);
}

static void print_exception(JSContext *ctx) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    fprintf(stderr, "exception: %s\n", s ? s : "?");
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    const char *ss = JS_ToCString(ctx, st);
    if (ss) fprintf(stderr, "%s\n", ss);
}

static int compile(const char *in, const char *out, const char *strip) {
    FILE *f = fopen(in, "rb");
    if (!f) { perror(in); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *src = malloc(n + 1);
    if (fread(src, 1, n, f) != (size_t)n) return 2;
    src[n] = 0; fclose(f);
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue fn = JS_Eval(ctx, src, n, "<game>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(fn)) { print_exception(ctx); return 1; }
    int flags = JS_WRITE_OBJ_BYTECODE;
    if (!strcmp(strip, "source") || !strcmp(strip, "all")) flags |= JS_WRITE_OBJ_STRIP_SOURCE;
    if (!strcmp(strip, "debug") || !strcmp(strip, "all")) flags |= JS_WRITE_OBJ_STRIP_DEBUG;
    size_t len = 0;
    uint8_t *bc = JS_WriteObject(ctx, &len, fn, flags);
    if (!bc) { print_exception(ctx); return 1; }
    FILE *o = fopen(out, "wb");
    if (!o || fwrite(bc, 1, len, o) != len) { perror(out); return 2; }
    fclose(o);
    fprintf(stderr, "[qjs_run] %s: %ld bytes of source -> %zu bytes of bytecode (strip %s)\n", in, n, len, strip);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 4 && !strcmp(argv[1], "--compile")) return compile(argv[2], argv[3], argc > 4 ? argv[4] : "none");
    if (argc < 2) { fprintf(stderr, "usage: qjs_run <script.js|.qbc> [cache-root]\n"); return 2; }
    if (argc > 2) g_root = argv[2];
    { char r[1024]; snprintf(r, sizeof r, "%s/", g_root); g3_files_root(r); }
    size_t alen = strlen(argv[1]);
    int is_bc = alen > 4 && !strcmp(argv[1] + alen - 4, ".qbc");
    FILE *f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *src = malloc(n + 1);
    if (fread(src, 1, n, f) != (size_t)n) return 2;
    src[n] = 0; fclose(f);
    JSRuntime *rt = JS_NewRuntime2(&cnt_mf, NULL);
    g_rt = rt;
    const char *lim = getenv("QJS_LIMIT_MB");
    if (lim && atoi(lim) > 0) JS_SetMemoryLimit(rt, (size_t)atoi(lim) * 1024 * 1024);
    JSContext *ctx = JS_NewContext(rt);
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "print", JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, g, "readFile", JS_NewCFunction(ctx, js_readfile, "readFile", 1));
    JS_SetPropertyStr(ctx, g, "nowUs", JS_NewCFunction(ctx, js_nowus, "nowUs", 0));
    JS_SetPropertyStr(ctx, g, "memUsage", JS_NewCFunction(ctx, js_memusage, "memUsage", 0));
    JS_SetPropertyStr(ctx, g, "memDetail", JS_NewCFunction(ctx, js_memdetail, "memDetail", 0));
    JS_SetPropertyStr(ctx, g, "memPeakReset",JS_NewCFunction(ctx, js_mempeakreset, "memPeakReset", 0));
    JS_SetPropertyStr(ctx, g, "gc", JS_NewCFunction(ctx, js_gc, "gc", 0));
    JS_SetPropertyStr(ctx, g, "gcHold", JS_NewCFunction(ctx, js_gchold, "gcHold", 1));
    JS_SetPropertyStr(ctx, g, "pngDecode", JS_NewCFunction(ctx, js_pngdecode, "pngDecode", 1));
    JS_SetPropertyStr(ctx, g, "nativeBytes", JS_NewCFunction(ctx, js_nativebytes, "nativeBytes", 1));
    JS_SetPropertyStr(ctx, g, "nativeBlit", JS_NewCFunction(ctx, js_nativeblit, "nativeBlit", 10));
    if (!getenv("QJS_NO_FAST")) {
        JS_SetPropertyStr(ctx, g, "nativeMd5", JS_NewCFunction(ctx, js_nativemd5, "nativeMd5", 1));
        JS_SetPropertyStr(ctx, g, "nativeBake", JS_NewCFunction(ctx, js_nativebake, "nativeBake", 6));
    }
    JS_SetPropertyStr(ctx, g, "texStore", JS_NewCFunction(ctx, js_texstore, "texStore", 4));
    JS_SetPropertyStr(ctx, g, "texDrop", JS_NewCFunction(ctx, js_texdrop, "texDrop", 1));
    JS_SetPropertyStr(ctx, g, "texRead", JS_NewCFunction(ctx, js_texread, "texRead", 4));
    JS_SetPropertyStr(ctx, g, "texBytes", JS_NewCFunction(ctx, js_texbytes, "texBytes", 0));
    JS_SetPropertyStr(ctx, g, "refCount", JS_NewCFunction(ctx, js_refcount, "refCount", 1));
    JS_SetPropertyStr(ctx, g, "gcThreshold", JS_NewCFunction(ctx, js_gcthreshold, "gcThreshold", 0));
    JS_SetPropertyStr(ctx, g, "gcClamp", JS_NewCFunction(ctx, js_gcclamp, "gcClamp", 0));
    JS_FreeValue(ctx, g);
#ifdef QJS_PROF
    { void qjs_prof_install(JSRuntime *, JSContext *); qjs_prof_install(rt, ctx); } /* tools/gen3/qjs_prof.c */
#endif
    static const char pre[] = "globalThis.console={log:print,warn:print,error:print,info:print};";
    JS_FreeValue(ctx, JS_Eval(ctx, pre, sizeof pre - 1, "<pre>", JS_EVAL_TYPE_GLOBAL));
    double te = 0;
    { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); te = ts.tv_sec * 1e3 + ts.tv_nsec / 1e6; }
    size_t pre_use = g_use;
    JSValue r;
    if (is_bc) {
        JSValue fn = JS_ReadObject(ctx, (const uint8_t *)src, n, JS_READ_OBJ_BYTECODE);
        free(src); src = NULL;
        if (getenv("QJS_REPORT")) fprintf(stderr, "[qjs_run] bytecode read: heap %.1f MB\n", g_use / 1048576.0);
        r = JS_IsException(fn) ? fn : JS_EvalFunction(ctx, fn);
    } else {
        r = JS_Eval(ctx, src, n, argv[1], JS_EVAL_TYPE_GLOBAL);
    }
    if (getenv("QJS_REPORT")) {
        struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
        fprintf(stderr, "[qjs_run] eval %.0f ms, heap %.1f MB (before eval %.1f), peak %.1f MB\n",
            ts.tv_sec * 1e3 + ts.tv_nsec / 1e6 - te, g_use / 1048576.0, pre_use / 1048576.0, g_peak / 1048576.0);
    }
    if (JS_IsException(r)) { print_exception(ctx); return 1; }
    return 0;
}
