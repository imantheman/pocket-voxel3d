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
 *   gc()                  run the cycle collector
 *   gcHold(on)            hold the collector off / run it and re-arm (g3Gc)
 *   pngDecode(bytes)      the host PNG decoder (g3PngDecode): [w, h, Uint8Array] or undefined
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
    JS_SetPropertyStr(ctx, g, "memPeakReset", JS_NewCFunction(ctx, js_mempeakreset, "memPeakReset", 0));
    JS_SetPropertyStr(ctx, g, "gc", JS_NewCFunction(ctx, js_gc, "gc", 0));
    JS_SetPropertyStr(ctx, g, "gcHold", JS_NewCFunction(ctx, js_gchold, "gcHold", 1));
    JS_SetPropertyStr(ctx, g, "pngDecode", JS_NewCFunction(ctx, js_pngdecode, "pngDecode", 1));
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
