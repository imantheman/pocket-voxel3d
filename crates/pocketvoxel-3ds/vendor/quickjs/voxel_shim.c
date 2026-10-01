
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "quickjs.h"

/* Rust side */
extern void voxel_log(const char *s, int len);
extern int voxel_save_write(const char *s, int len);
extern int voxel_write_test(void);
extern const uint8_t *voxel_write_err_ptr(void);
extern uint32_t voxel_write_err_len(void);
extern const uint8_t *voxel_save_ptr(void);
extern uint32_t voxel_save_len(void);
extern int voxel_options_write(const char *s, int len);
extern const uint8_t *voxel_options_ptr(void);
extern uint32_t voxel_options_len(void);
extern void voxel_op(uint32_t code, const int32_t *args, int n);
extern void voxel_op_text(uint32_t code, const int32_t *args, int n,
                          const char *s, int len);
extern const uint8_t *voxel_game_ptr(void);
extern uint32_t voxel_game_len(void);
extern const uint8_t *voxel_audio_ptr(void);
extern uint32_t voxel_audio_len(void);
extern int32_t voxel_stick(void);
extern int32_t voxel_last_step(void);

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

/* stick() - the circle pad, (x << 16) | (y & 0xffff), signed halves. */
static JSValue vox_stick(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return JS_NewInt32(ctx, voxel_stick());
}

/* lastStep() - whether this tick is the last before the host renders. */
static JSValue vox_laststep(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return JS_NewBool(ctx, voxel_last_step() != 0);
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

/* The GB screen's string ops: (number, hexString), op code in `magic`. */
static JSValue vox_numtext(JSContext *ctx, JSValueConst t, int c, JSValueConst *v, int magic) {
    (void)t;
    int32_t a[1]; a[0] = 0;
    if (c >= 2) JS_ToInt32(ctx, &a[0], v[0]);
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[c >= 2 ? 1 : 0]);
    if (s) { voxel_op_text((uint32_t)magic, a, 1, s, (int)len); JS_FreeCString(ctx, s); }
    return JS_UNDEFINED;
}

static JSValue vox_savewrite(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_FALSE;
    size_t len = 0;
    int ok = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[0]);
    if (s) { ok = voxel_save_write(s, (int)len); JS_FreeCString(ctx, s); }
    return ok ? JS_TRUE : JS_FALSE;
}

/* Write a file and read it back, so the game can say whether the card is
   writable at all rather than leaving it to be guessed at from outside. */
static JSValue vox_writetest(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return voxel_write_test() ? JS_TRUE : JS_FALSE;
}

static JSValue vox_writeerr(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    if (voxel_write_err_len() == 0) return JS_UNDEFINED;
    return JS_NewStringLen(ctx, (const char *)voxel_write_err_ptr(), voxel_write_err_len());
}

static JSValue vox_savedata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    if (voxel_save_len() == 0) return JS_UNDEFINED;
    return JS_NewStringLen(ctx, (const char *)voxel_save_ptr(), voxel_save_len());
}

/* optionsWrite(text) / optionsData() - the OPTION screen's file, beside the save. */
static JSValue vox_optionswrite(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_FALSE;
    size_t len = 0;
    int ok = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[0]);
    if (s) { ok = voxel_options_write(s, (int)len); JS_FreeCString(ctx, s); }
    return ok ? JS_TRUE : JS_FALSE;
}

static JSValue vox_optionsdata(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    if (voxel_options_len() == 0) return JS_UNDEFINED;
    return JS_NewStringLen(ctx, (const char *)voxel_options_ptr(), voxel_options_len());
}

static void add_num(JSContext *ctx, JSValue obj, const char *name, int code, int len) {
    JS_SetPropertyStr(ctx, obj, name,
        JS_NewCFunctionMagic(ctx, vox_num, name, len, JS_CFUNC_generic_magic, code));
}

/* The CABLE CLUB radio (uds_link.c). Frames cross as JS strings, the way
   saveData already does: the guest builds them ASCII on purpose so a string
   carries them without a byte of it changing meaning. */
int pv_link_open(void);
int pv_link_state(void);
int pv_link_send(const char *buf, int len);
int pv_link_recv(char *buf, int cap);
void pv_link_close(void);

static JSValue vox_linkopen(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return JS_NewInt32(ctx, pv_link_open());
}

static JSValue vox_linkstate(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    return JS_NewInt32(ctx, pv_link_state());
}

static JSValue vox_linksend(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_NewInt32(ctx, 0);
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, v[0]);
    if (!s) return JS_NewInt32(ctx, 0);
    int ok = pv_link_send(s, (int)len);
    JS_FreeCString(ctx, s);
    return JS_NewInt32(ctx, ok);
}

static JSValue vox_linkrecv(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    static char frame[1400];
    int n = pv_link_recv(frame, (int)sizeof(frame));
    if (n <= 0) return JS_UNDEFINED;
    return JS_NewStringLen(ctx, frame, (size_t)n);
}

static JSValue vox_linkclose(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;(void)c;(void)v;
    pv_link_close();
    return JS_UNDEFINED;
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
    JS_SetPropertyStr(ctx, o, "stick",     JS_NewCFunction(ctx, vox_stick,     "stick", 0));
    JS_SetPropertyStr(ctx, o, "lastStep",  JS_NewCFunction(ctx, vox_laststep,  "lastStep", 0));
    JS_SetPropertyStr(ctx, o, "saveWrite", JS_NewCFunction(ctx, vox_savewrite, "saveWrite", 1));
    JS_SetPropertyStr(ctx, o, "saveData",  JS_NewCFunction(ctx, vox_savedata,  "saveData", 0));
    JS_SetPropertyStr(ctx, o, "optionsWrite", JS_NewCFunction(ctx, vox_optionswrite, "optionsWrite", 1));
    JS_SetPropertyStr(ctx, o, "optionsData",  JS_NewCFunction(ctx, vox_optionsdata,  "optionsData", 0));
    JS_SetPropertyStr(ctx, o, "writeTest", JS_NewCFunction(ctx, vox_writetest, "writeTest", 0));
    JS_SetPropertyStr(ctx, o, "linkOpen",  JS_NewCFunction(ctx, vox_linkopen,  "linkOpen", 0));
    JS_SetPropertyStr(ctx, o, "linkState", JS_NewCFunction(ctx, vox_linkstate, "linkState", 0));
    JS_SetPropertyStr(ctx, o, "linkSend",  JS_NewCFunction(ctx, vox_linksend,  "linkSend", 1));
    JS_SetPropertyStr(ctx, o, "linkRecv",  JS_NewCFunction(ctx, vox_linkrecv,  "linkRecv", 0));
    JS_SetPropertyStr(ctx, o, "linkClose", JS_NewCFunction(ctx, vox_linkclose, "linkClose", 0));
    JS_SetPropertyStr(ctx, o, "writeErr",  JS_NewCFunction(ctx, vox_writeerr,  "writeErr", 0));
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
    add_num(ctx, o, "picDepth", 35, 2);
    add_num(ctx, o, "viewer",   90, 0);
    add_num(ctx, o, "uiTile",   50, 3);
    add_num(ctx, o, "uiFill",   51, 5);
    add_num(ctx, o, "uiReveal", 53, 1);
    add_num(ctx, o, "uiClear",  54, 0);
    /* Kanto Gear companion (bottom screen) surface — ops 75-78. */
    add_num(ctx, o, "uiTileBottom",   75, 3);
    add_num(ctx, o, "uiFillBottom",   76, 5);
    add_num(ctx, o, "uiClearBottom",  77, 0);
    add_num(ctx, o, "uiSpriteBottom", 78, 5);
    add_num(ctx, o, "fieldFx",        79, 3);
    /* Move animation sprites — ops 80-81. */
    add_num(ctx, o, "animSprite",     80, 5);
    add_num(ctx, o, "animClear",      81, 0);
    /* Battle HUD panel rects the core slides — op 82. */
    add_num(ctx, o, "uiPanel",        82, 5);
    add_num(ctx, o, "camSpeed",       83, 1);
    /* Kanto Gear: sprite sub-rect and flat rect on the bottom screen. */
    add_num(ctx, o, "uiSpriteRectBottom", 84, 8);
    add_num(ctx, o, "uiRectBottom",       85, 5);
    add_num(ctx, o, "arena",    70, 5);
    add_num(ctx, o, "card",     71, 7);
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
    add_num(ctx, o, "pikaPcm",  86, 1);
    /* The GB screen (core gb.rs). */
    add_num(ctx, o, "gbShow",    87, 1);
    add_num(ctx, o, "gbTiles",   88, 4);
    add_num(ctx, o, "gbReset",   89, 0);
    add_num(ctx, o, "gbRegs",    92, 8);
    add_num(ctx, o, "gbColours", 95, 3);
    JS_SetPropertyStr(ctx, o, "gbMap",
        JS_NewCFunctionMagic(ctx, vox_numtext, "gbMap", 2, JS_CFUNC_generic_magic, 91));
    JS_SetPropertyStr(ctx, o, "gbLines",
        JS_NewCFunctionMagic(ctx, vox_numtext, "gbLines", 2, JS_CFUNC_generic_magic, 93));
    JS_SetPropertyStr(ctx, o, "gbOam",
        JS_NewCFunctionMagic(ctx, vox_numtext, "gbOam", 1, JS_CFUNC_generic_magic, 94));
    /* The Gold screen (core lcd.rs). */
    add_num(ctx, o, "lcdShow",  96, 1);
    add_num(ctx, o, "lcdBank",  97, 3);
    add_num(ctx, o, "lcdReset", 98, 0);
    add_num(ctx, o, "lcdRegs", 100, 5);
    add_num(ctx, o, "daytime", 104, 1);
    add_num(ctx, o, "tiltShift", 105, 1);
    add_num(ctx, o, "lcdTarget", 106, 1);
    JS_SetPropertyStr(ctx, o, "lcdCells",
        JS_NewCFunctionMagic(ctx, vox_numtext, "lcdCells", 2, JS_CFUNC_generic_magic, 99));
    JS_SetPropertyStr(ctx, o, "lcdObjs",
        JS_NewCFunctionMagic(ctx, vox_numtext, "lcdObjs", 1, JS_CFUNC_generic_magic, 101));
    JS_SetPropertyStr(ctx, o, "lcdPals",
        JS_NewCFunctionMagic(ctx, vox_numtext, "lcdPals", 2, JS_CFUNC_generic_magic, 102));
    JS_SetPropertyStr(ctx, o, "lcdLines",
        JS_NewCFunctionMagic(ctx, vox_numtext, "lcdLines", 2, JS_CFUNC_generic_magic, 103));

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
