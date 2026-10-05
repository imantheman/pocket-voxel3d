/* Port tooling: run a bundled script under the 3DS's QuickJS on the desktop.
 * cc_g3_qjsbench.sh builds it.
 *   qjs_run <script.js> [cache-root]
 * Globals:
 *   print(...)            stdout
 *   readFile(path)        the file under cache-root as a byte string (one char
 *                         per byte, as the 3DS host's g3Read), or undefined
 *   nowUs()               microseconds, monotonic
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "quickjs.h"

static const char *g_root = ".";

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
    char path[4096];
    snprintf(path, sizeof path, "%s/%s", g_root, rel);
    JS_FreeCString(ctx, rel);
    FILE *f = fopen(path, "rb");
    if (!f) return JS_UNDEFINED;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *b = malloc(n > 0 ? n : 1);
    size_t got = fread(b, 1, n, f);
    fclose(f);
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

static JSValue js_nowus(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewFloat64(ctx, ts.tv_sec * 1e6 + ts.tv_nsec / 1e3);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: qjs_run <script.js> [cache-root]\n"); return 2; }
    if (argc > 2) g_root = argv[2];
    FILE *f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *src = malloc(n + 1);
    if (fread(src, 1, n, f) != (size_t)n) return 2;
    src[n] = 0; fclose(f);
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "print", JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, g, "readFile", JS_NewCFunction(ctx, js_readfile, "readFile", 1));
    JS_SetPropertyStr(ctx, g, "nowUs", JS_NewCFunction(ctx, js_nowus, "nowUs", 0));
    JS_FreeValue(ctx, g);
    static const char pre[] = "globalThis.console={log:print,warn:print,error:print,info:print};";
    JS_FreeValue(ctx, JS_Eval(ctx, pre, sizeof pre - 1, "<pre>", JS_EVAL_TYPE_GLOBAL));
    JSValue r = JS_Eval(ctx, src, n, argv[1], JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(r)) {
        JSValue e = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, e);
        fprintf(stderr, "exception: %s\n", s ? s : "?");
        JSValue st = JS_GetPropertyStr(ctx, e, "stack");
        const char *ss = JS_ToCString(ctx, st);
        if (ss) fprintf(stderr, "%s\n", ss);
        return 1;
    }
    return 0;
}
