/* Port tooling: a sampling profiler for the desktop QuickJS runner
 * (tools/gen3/qjs_run.c built with -DQJS_PROF; cc_g3_qjsprof.sh). This file
 * is the QuickJS translation unit itself (it includes quickjs.c), so it can
 * walk the interpreter's own stack frames from the interrupt handler.
 *
 * Every interrupt poll (QuickJS polls about every 10000 calls/back-jumps)
 * charges the wall time since the last poll to the function on top of the
 * stack (self) and once to every distinct function below it (total). The
 * cycle collector is timed apart ("<gc>"), so a screen's allocation shows as
 * gc rather than as whatever ran next. Natives run inside their JS caller's
 * self time.
 *
 * JS globals: profReset(), profDump(n = 40, title = "") -> prints two tables;
 * profFrameBegin() / profFrameEnd(keep): samples between them count only if
 * keep (a profile of the slow frames alone). QJS_PROF_TICK=<n> polls every n
 * interpreter events instead of QuickJS's 10000 (finer samples).
 * Never shipped.
 */
#define JS_RunGC JS_RunGC_inner
#include "quickjs.c"
#undef JS_RunGC

#include <time.h>

typedef struct {
    const void *key;
    char *label;
    double self_us, total_us;
    double fself_us, ftotal_us; /* this frame's, while profFrameBegin is on */
    uint32_t fstamp;            /* the frame it was last touched in */
    uint32_t stamp;
    uint32_t samples;
} ProfEnt;

#define PROF_CAP 65536
static ProfEnt prof_tab[PROF_CAP];
static uint32_t prof_stamp;
static double prof_last;
static double prof_gc_us, prof_gc_n;
static bool prof_on;
static bool prof_frame;
static bool prof_frame_mode; /* once profFrameBegin is used, samples outside frames are dropped */
static uint32_t prof_frame_no;
#define FRAME_TOUCH_MAX 8192
static ProfEnt *prof_touched[FRAME_TOUCH_MAX];
static int prof_ntouched;

static double prof_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}

void JS_RunGC(JSRuntime *rt);
void JS_RunGC(JSRuntime *rt) {
    double t = prof_now();
    JS_RunGC_inner(rt);
    double dt = prof_now() - t;
    prof_gc_us += dt;
    prof_gc_n += 1;
    /* the collector's time is not the next function's */
    prof_last += dt;
}

static ProfEnt *prof_slot(const void *key) {
    uint32_t h = (uint32_t)(((uintptr_t)key >> 4) * 2654435761u) & (PROF_CAP - 1);
    for (int i = 0; i < PROF_CAP; i++) {
        ProfEnt *e = &prof_tab[(h + i) & (PROF_CAP - 1)];
        if (e->key == key) return e;
        if (!e->key) { e->key = key; return e; }
    }
    return NULL;
}

static void prof_label(JSContext *ctx, ProfEnt *e, JSStackFrame *sf) {
    char buf[256], nb[96], fb[96];
    JSValueConst f = sf->cur_func;
    if (JS_VALUE_GET_TAG(f) == JS_TAG_OBJECT) {
        JSObject *p = JS_VALUE_GET_OBJ(f);
        if (js_class_has_bytecode(p->class_id)) {
            JSFunctionBytecode *b = p->u.func.function_bytecode;
            const char *n = JS_AtomGetStr(ctx, nb, sizeof nb, b->func_name);
            const char *fn = JS_AtomGetStr(ctx, fb, sizeof fb, b->filename);
            const char *slash = strrchr(fn, '/');
            snprintf(buf, sizeof buf, "%s (%s:%d)", n && *n ? n : "<anon>", slash ? slash + 1 : fn, b->line_num);
            e->label = strdup(buf);
            return;
        }
        const char *n = get_func_name(ctx, f);
        snprintf(buf, sizeof buf, "[native] %s", n ? n : "?");
        if (n) JS_FreeCString(ctx, n);
        e->label = strdup(buf);
        return;
    }
    e->label = strdup("<detached>");
}

static const void *prof_key(JSStackFrame *sf) {
    JSValueConst f = sf->cur_func;
    if (JS_VALUE_GET_TAG(f) != JS_TAG_OBJECT) return (const void *)1;
    JSObject *p = JS_VALUE_GET_OBJ(f);
    if (js_class_has_bytecode(p->class_id)) return p->u.func.function_bytecode;
    if (p->class_id == JS_CLASS_C_FUNCTION) return (const void *)p->u.cfunc.c_function.generic;
    return p;
}

static JSContext *prof_ctx;
static int prof_tick;

static int prof_interrupt(JSRuntime *rt, void *opaque) {
    (void)opaque;
    double now = prof_now();
    double dt = now - prof_last;
    prof_last = now;
    if (!prof_on || !prof_ctx) return 0;
    if (prof_tick > 0) prof_ctx->interrupt_counter = prof_tick; /* QJS_PROF_TICK: sample finer */
    JSStackFrame *sf = rt->current_stack_frame;
    if (!sf) return 0;
    if (prof_frame_mode && !prof_frame) return 0;
    prof_stamp++;
    bool top = true;
    for (; sf; sf = sf->prev_frame) {
        ProfEnt *e = prof_slot(prof_key(sf));
        if (!e) break;
        if (!e->label) prof_label(prof_ctx, e, sf);
        if (prof_frame) {
            if (e->fstamp != prof_frame_no) {
                e->fstamp = prof_frame_no; e->fself_us = e->ftotal_us = 0;
                if (prof_ntouched < FRAME_TOUCH_MAX) prof_touched[prof_ntouched++] = e;
            }
            if (top) { e->fself_us += dt; top = false; }
            if (e->stamp != prof_stamp) { e->stamp = prof_stamp; e->ftotal_us += dt; }
            continue;
        }
        if (top) { e->self_us += dt; e->samples++; top = false; }
        if (e->stamp != prof_stamp) { e->stamp = prof_stamp; e->total_us += dt; }
    }
    return 0;
}

static JSValue js_prof_reset(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    for (int i = 0; i < PROF_CAP; i++) { prof_tab[i].self_us = prof_tab[i].total_us = 0; prof_tab[i].samples = 0; }
    prof_gc_us = prof_gc_n = 0;
    prof_last = prof_now();
    prof_on = true;
    return JS_UNDEFINED;
}

static JSValue js_prof_frame_begin(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)ctx; (void)t; (void)c; (void)v;
    prof_frame = true;
    prof_frame_mode = true;
    prof_frame_no++;
    prof_ntouched = 0;
    prof_last = prof_now();
    return JS_UNDEFINED;
}

static JSValue js_prof_frame_end(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    int keep = c > 0 && JS_ToBool(ctx, v[0]);
    for (int i = 0; i < prof_ntouched; i++) {
        ProfEnt *e = prof_touched[i];
        if (keep) { e->self_us += e->fself_us; e->total_us += e->ftotal_us; }
        e->fself_us = e->ftotal_us = 0;
    }
    prof_ntouched = 0;
    prof_frame = false;
    return JS_UNDEFINED;
}

static int cmp_self(const void *a, const void *b) {
    const ProfEnt *x = *(ProfEnt *const *)a, *y = *(ProfEnt *const *)b;
    return x->self_us < y->self_us ? 1 : x->self_us > y->self_us ? -1 : 0;
}
static int cmp_total(const void *a, const void *b) {
    const ProfEnt *x = *(ProfEnt *const *)a, *y = *(ProfEnt *const *)b;
    return x->total_us < y->total_us ? 1 : x->total_us > y->total_us ? -1 : 0;
}

static ProfEnt *prof_rows[PROF_CAP];

static JSValue js_prof_dump(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    int32_t n = 40;
    if (c > 0) JS_ToInt32(ctx, &n, v[0]);
    const char *title = c > 1 ? JS_ToCString(ctx, v[1]) : NULL;
    int k = 0;
    double sum = 0;
    for (int i = 0; i < PROF_CAP; i++) if (prof_tab[i].key && prof_tab[i].total_us > 0) { prof_rows[k++] = &prof_tab[i]; sum += prof_tab[i].self_us; }
    printf("=== profile %s: %.1f ms sampled in JS, gc %.1f ms in %.0f runs\n", title ? title : "", sum / 1000, prof_gc_us / 1000, prof_gc_n);
    qsort(prof_rows, k, sizeof prof_rows[0], cmp_self);
    printf("--- self\n");
    for (int i = 0; i < k && i < n; i++)
        printf("%8.1f ms %5.1f%%  %s\n", prof_rows[i]->self_us / 1000, 100 * prof_rows[i]->self_us / (sum > 0 ? sum : 1), prof_rows[i]->label);
    qsort(prof_rows, k, sizeof prof_rows[0], cmp_total);
    printf("--- total\n");
    for (int i = 0; i < k && i < n; i++)
        printf("%8.1f ms %5.1f%%  %s\n", prof_rows[i]->total_us / 1000, 100 * prof_rows[i]->total_us / (sum > 0 ? sum : 1), prof_rows[i]->label);
    fflush(stdout);
    if (title) JS_FreeCString(ctx, title);
    return JS_UNDEFINED;
}

void qjs_prof_install(JSRuntime *rt, JSContext *ctx);
void qjs_prof_install(JSRuntime *rt, JSContext *ctx) {
    prof_ctx = ctx;
    { const char *e = getenv("QJS_PROF_TICK"); prof_tick = e ? atoi(e) : 0; }
    prof_last = prof_now();
    JS_SetInterruptHandler(rt, prof_interrupt, NULL);
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "profReset", JS_NewCFunction(ctx, js_prof_reset, "profReset", 0));
    JS_SetPropertyStr(ctx, g, "profDump", JS_NewCFunction(ctx, js_prof_dump, "profDump", 2));
    JS_SetPropertyStr(ctx, g, "profFrameBegin", JS_NewCFunction(ctx, js_prof_frame_begin, "profFrameBegin", 0));
    JS_SetPropertyStr(ctx, g, "profFrameEnd", JS_NewCFunction(ctx, js_prof_frame_end, "profFrameEnd", 1));
    JS_FreeValue(ctx, g);
}
