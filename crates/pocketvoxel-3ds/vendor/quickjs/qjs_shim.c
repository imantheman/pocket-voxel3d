
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <malloc.h>
#include "quickjs.h"

int qjs_eval(JSContext *ctx, const char *src, int len, char *errbuf, int errlen) {
    JSValue v = JS_Eval(ctx, src, (size_t)len, "<game>", JS_EVAL_TYPE_GLOBAL);
    int failed = JS_IsException(v);
    if (failed && errbuf && errlen > 0) {
        JSValue e = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, e);
        if (s) { snprintf(errbuf, errlen, "%s", s); JS_FreeCString(ctx, s); }
        else   { snprintf(errbuf, errlen, "unknown exception"); }
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, v);
    return failed;
}

int qjs_has_global_fn(JSContext *ctx, const char *name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue f = JS_GetPropertyStr(ctx, g, name);
    int ok = JS_IsFunction(ctx, f);
    JS_FreeValue(ctx, f);
    JS_FreeValue(ctx, g);
    return ok;
}

/* Runtime with an explicit budget so the GC bounds itself instead of
   thrashing against the system heap ceiling. */
JSRuntime *qjs_new_runtime_limited(int mb) {
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return 0;
    JS_SetMemoryLimit(rt, (size_t)mb * 1024 * 1024);
    JS_SetGCThreshold(rt, (size_t)(mb / 2) * 1024 * 1024);
    JS_SetMaxStackSize(rt, 256 * 1024);
    return rt;
}

/* devkitARM newlib has no reliable malloc_usable_size; QuickJS's default
   allocator mis-accounts with it and throws bogus OOM. Supply our own. */
static void *m_calloc(void *o, size_t c, size_t s){ (void)o; return calloc(c, s); }
static void *m_malloc(void *o, size_t s){ (void)o; return malloc(s); }
static void  m_free(void *o, void *p){ (void)o; free(p); }
static void *m_realloc(void *o, void *p, size_t s){ (void)o; return realloc(p, s); }
static size_t m_usable(const void *p){ return p ? malloc_usable_size((void*)p) : 0; }

JSRuntime *qjs_new_runtime_plain(void) {
    JSMallocFunctions mf;
    memset(&mf, 0, sizeof(mf));
    mf.js_calloc = m_calloc;
    mf.js_malloc = m_malloc;
    mf.js_free = m_free;
    mf.js_realloc = m_realloc;
    mf.js_malloc_usable_size = m_usable;
    return JS_NewRuntime2(&mf, NULL);
}

/* Logging allocator: tells us exactly what QuickJS asks for when it fails. */
static size_t g_total = 0;
static void *L_calloc(void *o, size_t c, size_t sz){ (void)o; void*p=calloc(c,sz);
    if(!p) printf("CALLOC FAIL %u x %u (total %u KB)\n",(unsigned)c,(unsigned)sz,(unsigned)(g_total/1024));
    else g_total += c*sz; return p; }
static void *L_malloc(void *o, size_t sz){ (void)o; void*p=malloc(sz);
    if(!p) printf("MALLOC FAIL %u (total %u KB)\n",(unsigned)sz,(unsigned)(g_total/1024));
    else g_total += sz; return p; }
static void  L_free(void *o, void *p){ (void)o; free(p); }
static void *L_realloc(void *o, void *p, size_t sz){ (void)o;
    if(sz > 4u*1024u*1024u){
        printf("BIG REALLOC %u from %p ret=%p\n",(unsigned)sz,p,__builtin_return_address(0));
    }
    void*q=realloc(p,sz);
    if(!q && sz) printf("REALLOC FAIL %u (total %u KB) ret=%p\n",
        (unsigned)sz,(unsigned)(g_total/1024),__builtin_return_address(0));
    return q; }
static size_t L_usable(const void *p){ return p ? malloc_usable_size((void*)p) : 0; }

JSRuntime *qjs_new_runtime_logged(void) {
    JSMallocFunctions mf;
    memset(&mf, 0, sizeof(mf));
    mf.js_calloc = L_calloc;
    mf.js_malloc = L_malloc;
    mf.js_free = L_free;
    mf.js_realloc = L_realloc;
    mf.js_malloc_usable_size = L_usable;
    JSRuntime *rt = JS_NewRuntime2(&mf, NULL);
    if (rt) JS_SetMemoryLimit(rt, (size_t)-1);
    return rt;
}

/* Precompiled bundle: no parser, so no 18 MB contiguous realloc. */
extern const uint32_t qjsc_game_size;
extern const uint8_t qjsc_game[];

int qjs_run_bytecode(JSContext *ctx, char *errbuf, int errlen) {
    JSValue obj = JS_ReadObject(ctx, qjsc_game, qjsc_game_size, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(obj)) goto fail;
    JSValue v = JS_EvalFunction(ctx, obj);
    if (JS_IsException(v)) goto fail;
    JS_FreeValue(ctx, v);
    return 0;
fail: {
        JSValue e = JS_GetException(ctx);
        const char *m = JS_ToCString(ctx, e);
        if (m) { snprintf(errbuf, errlen, "%s", m); JS_FreeCString(ctx, m); }
        else   { snprintf(errbuf, errlen, "bytecode load failed"); }
        JS_FreeValue(ctx, e);
        return 1;
    }
}
