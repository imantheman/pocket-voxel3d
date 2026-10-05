/* Port tooling: run a bundled script under the 3DS's QuickJS on the desktop,
 * with `print` (stdout) and nothing else. cc_g3_qjsbench.sh builds it.
 *   qjs_run <script.js>
 */
#include <stdio.h>
#include <stdlib.h>
#include "quickjs.h"

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

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: qjs_run <script.js>\n"); return 2; }
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
    JS_FreeValue(ctx, g);
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
