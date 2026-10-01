/* Desktop smoke test for the Gold bundle under the 3DS's own QuickJS
 * (crates/pocketvoxel-3ds/vendor/quickjs, quickjs-ng): evaluate game-gold.js
 * against a stand-in `voxel` host whose ops do nothing, hand it the cooked
 * dataset, and pump frame(buttons) the way the 3DS host does -- so syntax
 * QuickJS cannot parse, or an exception only QuickJS raises, shows up here
 * instead of on a console. Prints per-frame timing and op counts.
 *
 *   qjs_gold_harness <game-gold.js> <gamedata.json> [frames] [press-every]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "quickjs.h"

static long g_ops = 0;
static char *g_gamedata = NULL;
static size_t g_gamedata_len = 0;

static char *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = malloc(n + 1);
    if (fread(b, 1, n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
    b[n] = 0;
    fclose(f);
    if (len) *len = n;
    return b;
}

static JSValue op_any(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    g_ops++;
    return JS_UNDEFINED;
}
static JSValue op_gamedata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    return JS_NewStringLen(ctx, g_gamedata, g_gamedata_len);
}
static JSValue op_null(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    return JS_NULL;
}
static JSValue op_log(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    for (int i = 0; i < c; i++) {
        const char *s = JS_ToCString(ctx, v[i]);
        if (s) { printf("%s%s", i ? " " : "", s); JS_FreeCString(ctx, s); }
    }
    printf("\n");
    return JS_UNDEFINED;
}

static const char *OPS[] = {
    "stats", "reset", "mapShow", "mapHide", "cam", "pitch", "tint", "stamp", "palette", "ent", "entHide",
    "emote", "pic", "picDepth", "picHide", "saveWrite", "uiTile", "uiFill", "uiText", "uiReveal", "uiClear",
    "uiTileBottom", "uiFillBottom", "uiClearBottom", "uiSpriteBottom", "uiSpriteRectBottom", "uiRectBottom",
    "animSprite", "animClear", "uiPanel", "camSpeed", "fieldFx", "arena", "card", "cardHide", "battleCam", "arenaEnd",
    "music", "musicStop", "musicFade", "sfx", "cry", "audioWaves", "audioDrum", "pikaPcm",
    "gbShow", "gbTiles", "gbReset", "gbRegs", "gbColours", "gbMap", "gbLines", "gbOam",
    "lcdShow", "lcdBank", "lcdReset", "lcdRegs", "lcdCells", "lcdObjs", "lcdPals", "lcdLines", "daytime", NULL,
};

static void dump_exception(JSContext *ctx) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    printf("EXCEPTION: %s\n", s ? s : "?");
    if (s) JS_FreeCString(ctx, s);
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    const char *ss = JS_ToCString(ctx, st);
    if (ss) { printf("%s\n", ss); JS_FreeCString(ctx, ss); }
    JS_FreeValue(ctx, st);
    JS_FreeValue(ctx, e);
}

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s game-gold.js gamedata.json [frames] [press-every]\n", argv[0]); return 2; }
    int frames = argc > 3 ? atoi(argv[3]) : 600;
    int every = argc > 4 ? atoi(argv[4]) : 0;
    size_t srclen = 0;
    char *src = slurp(argv[1], &srclen);
    g_gamedata = slurp(argv[2], &g_gamedata_len);
    if (!src || !g_gamedata) { fprintf(stderr, "cannot read inputs\n"); return 2; }

    JSRuntime *rt = JS_NewRuntime();
    JS_SetMaxStackSize(rt, 256 * 1024); /* the 3DS shim's stack budget */
    JSContext *ctx = JS_NewContext(rt);
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue vox = JS_NewObject(ctx);
    for (int i = 0; OPS[i]; i++) JS_SetPropertyStr(ctx, vox, OPS[i], JS_NewCFunction(ctx, op_any, OPS[i], 0));
    JS_SetPropertyStr(ctx, vox, "gamedata", JS_NewCFunction(ctx, op_gamedata, "gamedata", 0));
    JS_SetPropertyStr(ctx, vox, "audiodata", JS_NewCFunction(ctx, op_null, "audiodata", 0));
    JS_SetPropertyStr(ctx, vox, "saveData", JS_NewCFunction(ctx, op_null, "saveData", 0));
    JS_SetPropertyStr(ctx, g, "voxel", vox);
    JSValue con = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, con, "log", JS_NewCFunction(ctx, op_log, "log", 1));
    JS_SetPropertyStr(ctx, g, "console", con);

    double t0 = now_ms();
    JSValue r = JS_Eval(ctx, src, srclen, "game-gold.js", JS_EVAL_TYPE_GLOBAL);
    double t1 = now_ms();
    if (JS_IsException(r)) { dump_exception(ctx); return 1; }
    JS_FreeValue(ctx, r);
    printf("eval+boot %.0f ms, %ld ops\n", t1 - t0, g_ops);

    JSValue frame = JS_GetPropertyStr(ctx, g, "frame");
    if (!JS_IsFunction(ctx, frame)) { printf("no frame()\n"); return 1; }
    double worst = 0, total = 0;
    long ops0 = g_ops;
    for (int i = 0; i < frames; i++) {
        int buttons = (every > 0 && i % every == 0) ? 16 /* A */ : 0;
        if (every > 0 && i % (every * 7) == 3) buttons = 64; /* START now and then */
        JSValue arg = JS_NewInt32(ctx, buttons);
        double a = now_ms();
        JSValue res = JS_Call(ctx, frame, JS_UNDEFINED, 1, &arg);
        double b = now_ms();
        if (JS_IsException(res)) { printf("frame %d: ", i); dump_exception(ctx); return 1; }
        JS_FreeValue(ctx, res);
        total += b - a;
        if (b - a > worst) worst = b - a;
    }
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(rt, &mu);
    printf("%d frames: avg %.2f ms, worst %.1f ms, %ld ops; JS heap %lld KB\n",
           frames, total / frames, worst, g_ops - ops0, (long long)(mu.memory_used_size / 1024));
    return 0;
}
