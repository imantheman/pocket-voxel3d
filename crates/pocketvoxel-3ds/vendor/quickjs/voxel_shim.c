
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "quickjs.h"

/* Rust side */
extern void voxel_log(const char *s, int len);
extern void voxel_save_write(const char *s, int len);
extern const uint8_t *voxel_save_ptr(void);
extern uint32_t voxel_save_len(void);
extern void voxel_op(uint32_t code, const int32_t *args, int n);
extern void voxel_op_text(uint32_t code, const int32_t *args, int n,
                          const char *s, int len);
extern const uint8_t *voxel_game_ptr(void);
extern uint32_t voxel_game_len(void);
extern const uint8_t *voxel_audio_ptr(void);
extern uint32_t voxel_audio_len(void);

/* One handler for every numeric op; `magic` carries the op code. */
static JSValue vox_num(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv, int magic) {
    int32_t a[8]; memset(a, 0, sizeof(a));
    int n = argc > 8 ? 8 : argc;
    for (int i = 0; i < n; i++) JS_ToInt32(ctx, &a[i], argv[i]);
    voxel_op((uint32_t)magic, a, 8);
    return JS_UNDEFINED;
}

static JSValue vox_gamedata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return JS_NewStringLen(ctx, (const char *)voxel_game_ptr(), voxel_game_len());
}

static JSValue vox_audiodata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    if (voxel_audio_len() == 0) return JS_UNDEFINED;
    return JS_NewArrayBufferCopy(ctx, voxel_audio_ptr(), voxel_audio_len());
}

static JSValue vox_stats(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx;(void)t;(void)c;(void)v; return JS_UNDEFINED;
}

/* uiText(x, y, str) - the one string-bearing op (code 52). */
static JSValue vox_uitext(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 3) return JS_UNDEFINED;
    int32_t a[2]; a[0]=0; a[1]=0;
    JS_ToInt32(ctx, &a[0], v[0]);
    JS_ToInt32(ctx, &a[1], v[1]);
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[2]);
    if (s) { voxel_op_text(52, a, 2, s, (int)len); JS_FreeCString(ctx, s); }
    return JS_UNDEFINED;
}

static JSValue vox_savewrite(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[0]);
    if (s) { voxel_save_write(s, (int)len); JS_FreeCString(ctx, s); }
    return JS_UNDEFINED;
}

static JSValue vox_savedata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    if (voxel_save_len() == 0) return JS_UNDEFINED;
    return JS_NewStringLen(ctx, (const char *)voxel_save_ptr(), voxel_save_len());
}

static void add_num(JSContext *ctx, JSValue obj, const char *name, int code, int len) {
    JS_SetPropertyStr(ctx, obj, name,
        JS_NewCFunctionMagic(ctx, vox_num, name, len, JS_CFUNC_generic_magic, code));
}

static JSValue vox_log(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    for (int i = 0; i < c; i++) {
        size_t len = 0;
        const char *s = JS_ToCStringLen(ctx, &len, v[i]);
        if (s) { voxel_log(s, (int)len); JS_FreeCString(ctx, s); }
    }
    return JS_UNDEFINED;
}

int qjs_register_voxel(JSContext *ctx) {
    {   /* QuickJS has no console; script.ts and our probes both use it. */
        JSValue g0 = JS_GetGlobalObject(ctx);
        JSValue con = JS_NewObject(ctx);
        JSValue fn = JS_NewCFunction(ctx, vox_log, "log", 1);
        JS_SetPropertyStr(ctx, con, "log", JS_DupValue(ctx, fn));
        JS_SetPropertyStr(ctx, con, "warn", JS_DupValue(ctx, fn));
        JS_SetPropertyStr(ctx, con, "error", fn);
        JS_SetPropertyStr(ctx, g0, "console", con);
        JS_FreeValue(ctx, g0);
    }

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue o = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, o, "gamedata",  JS_NewCFunction(ctx, vox_gamedata,  "gamedata", 0));
    JS_SetPropertyStr(ctx, o, "audiodata", JS_NewCFunction(ctx, vox_audiodata, "audiodata", 0));
    JS_SetPropertyStr(ctx, o, "stats",     JS_NewCFunction(ctx, vox_stats,     "stats", 0));
    JS_SetPropertyStr(ctx, o, "saveWrite", JS_NewCFunction(ctx, vox_savewrite, "saveWrite", 1));
    JS_SetPropertyStr(ctx, o, "saveData",  JS_NewCFunction(ctx, vox_savedata,  "saveData", 0));
    JS_SetPropertyStr(ctx, o, "uiText",    JS_NewCFunction(ctx, vox_uitext,    "uiText", 3));

    add_num(ctx, o, "reset",     3, 0);
    add_num(ctx, o, "quality",   4, 1);
    add_num(ctx, o, "mapShow",  10, 4);
    add_num(ctx, o, "mapHide",  11, 1);
    add_num(ctx, o, "cam",      12, 2);
    add_num(ctx, o, "pitch",    13, 1);
    add_num(ctx, o, "tint",     14, 1);
    add_num(ctx, o, "stamp",    15, 4);
    add_num(ctx, o, "palette",  16, 1);
    add_num(ctx, o, "ent",      30, 7);
    add_num(ctx, o, "entHide",  31, 1);
    add_num(ctx, o, "emote",    32, 2);
    add_num(ctx, o, "pic",      33, 6);
    add_num(ctx, o, "picHide",  34, 1);
    add_num(ctx, o, "viewer",   90, 0);
    add_num(ctx, o, "uiTile",   50, 3);
    add_num(ctx, o, "uiFill",   51, 5);
    add_num(ctx, o, "uiReveal", 53, 1);
    add_num(ctx, o, "uiClear",  54, 0);
    add_num(ctx, o, "arena",    70, 5);
    add_num(ctx, o, "card",     71, 4);
    add_num(ctx, o, "cardHide", 72, 1);
    add_num(ctx, o, "battleCam",73, 3);
    add_num(ctx, o, "arenaEnd", 74, 0);
    add_num(ctx, o, "music",    18, 4);
    add_num(ctx, o, "musicStop",19, 0);
    add_num(ctx, o, "musicFade",20, 1);
    add_num(ctx, o, "sfx",      21, 6);
    add_num(ctx, o, "cry",      22, 5);
    add_num(ctx, o, "audioWaves",23,3);
    add_num(ctx, o, "audioDrum",24, 4);

    JS_SetPropertyStr(ctx, g, "voxel", o);
    JS_FreeValue(ctx, g);
    return 0;
}

/* One guest turn: frame(buttons). 0 ok, 1 threw, 2 no frame(). */
int qjs_call_frame(JSContext *ctx, int buttons, char *errbuf, int errlen) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue f = JS_GetPropertyStr(ctx, g, "frame");
    if (!JS_IsFunction(ctx, f)) {
        JS_FreeValue(ctx, f); JS_FreeValue(ctx, g);
        snprintf(errbuf, errlen, "no frame()");
        return 2;
    }
    JSValue arg = JS_NewInt32(ctx, buttons);
    JSValue r = JS_Call(ctx, f, g, 1, &arg);
    int failed = JS_IsException(r);
    if (failed) {
        JSValue e = JS_GetException(ctx);
        const char *m = JS_ToCString(ctx, e);
        if (m) { snprintf(errbuf, errlen, "%s", m); JS_FreeCString(ctx, m); }
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, f); JS_FreeValue(ctx, g);
    return failed;
}
