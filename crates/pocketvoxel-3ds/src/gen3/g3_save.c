/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The save store on the card: what the guest writes
   through love.filesystem (the save slots, options) kept as files under
   3ds/voxelmon/<game>/save/ (platform/savefs.ts cardSaveStore over these):

     g3SaveRead(name)        -> byte string, or undefined
     g3SaveWrite(name, text) -> bool   (text: a byte string, chars < 256)
     g3SaveRemove(name)      -> bool
     g3SaveList()            -> [name, ...]   (relative, '/'-separated)

   A write never leaves a torn file: it goes to name.tmp, the previous copy
   is kept as name.bak, then name.tmp becomes name. A read falls back to
   name.bak when name is missing (power lost between the two renames).
   Names are the guest's paths ("saves/firered/slot1.lua"); "..", absolute
   and drive-qualified names are refused. */

#include <dirent.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "quickjs.h"

extern void voxel_log(const char *s, int len);

static char save_root[256] = "sdmc:/3ds/voxelmon/firered/save/";

void g3_save_root(const char *root) { snprintf(save_root, sizeof(save_root), "%s", root); }

static void slog(const char *m, const char *p) {
    char b[320];
    int n = snprintf(b, sizeof(b), "[pv] g3 save: %s%s", m, p ? p : "");
    if (n > (int)sizeof(b) - 1) n = sizeof(b) - 1;
    voxel_log(b, n);
}

/* name -> full path; 0 when the name is not a plain relative path */
static int full_path(char *out, size_t cap, const char *name) {
    if (!name || !*name || name[0] == '/' || strchr(name, ':') || strstr(name, "..")) return 0;
    int n = snprintf(out, cap, "%s%s", save_root, name);
    return n > 0 && (size_t)n < cap;
}

/* mkdir -p for the folders above `path` */
static void make_parents(const char *path) {
    char b[300];
    snprintf(b, sizeof(b), "%s", path);
    /* skip "sdmc:/" so the drive is never mkdir'd */
    char *p = strchr(b, '/');
    if (!p) return;
    for (p = p + 1; *p; p++) {
        if (*p == '/') {
            *p = 0;
            mkdir(b, 0777);
            *p = '/';
        }
    }
}

static uint8_t *read_all(const char *path, size_t *n) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); return NULL; }
    uint8_t *b = (uint8_t *)malloc((size_t)sz + 1);
    if (!b) { fclose(f); return NULL; }
    size_t got = fread(b, 1, (size_t)sz, f);
    fclose(f);
    if (got != (size_t)sz) { free(b); return NULL; }
    *n = got;
    return b;
}

/* bytes -> a JS string of those byte values (as g3Read gives) */
static JSValue byte_string(JSContext *ctx, const uint8_t *b, size_t n) {
    size_t hi = 0;
    for (size_t i = 0; i < n; i++) hi += b[i] >> 7;
    if (!hi) return JS_NewStringLen(ctx, (const char *)b, n);
    uint8_t *u = (uint8_t *)malloc(n + hi);
    if (!u) return JS_ThrowOutOfMemory(ctx);
    size_t k = 0;
    for (size_t i = 0; i < n; i++) {
        uint8_t x = b[i];
        if (x < 0x80) u[k++] = x;
        else { u[k++] = (uint8_t)(0xC0 | (x >> 6)); u[k++] = (uint8_t)(0x80 | (x & 0x3F)); }
    }
    JSValue r = JS_NewStringLen(ctx, (const char *)u, k);
    free(u);
    return r;
}

static JSValue js_save_read(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_UNDEFINED;
    const char *name = JS_ToCString(ctx, v[0]);
    if (!name) return JS_UNDEFINED;
    char path[300], bak[310];
    int ok = full_path(path, sizeof(path), name);
    JS_FreeCString(ctx, name);
    if (!ok) return JS_UNDEFINED;
    size_t n = 0;
    uint8_t *b = read_all(path, &n);
    if (!b) {
        snprintf(bak, sizeof(bak), "%s.bak", path);
        b = read_all(bak, &n);
        if (b) slog("read the backup copy of ", path);
    }
    if (!b) return JS_UNDEFINED;
    JSValue r = byte_string(ctx, b, n);
    free(b);
    return r;
}

static JSValue js_save_write(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 2 || !JS_IsString(v[1])) return JS_FALSE;
    const char *name = JS_ToCString(ctx, v[0]);
    if (!name) return JS_FALSE;
    char path[300], tmp[310], bak[310];
    int ok = full_path(path, sizeof(path), name);
    JS_FreeCString(ctx, name);
    if (!ok) return JS_FALSE;
    /* the byte string back to its bytes (its UTF-8 holds only U+0000..U+00FF) */
    size_t ulen = 0;
    const char *u = JS_ToCStringLen(ctx, &ulen, v[1]);
    if (!u) return JS_FALSE;
    uint8_t *b = (uint8_t *)malloc(ulen + 1);
    size_t n = 0;
    int bad = !b;
    for (size_t i = 0; !bad && i < ulen; i++) {
        uint8_t x = (uint8_t)u[i];
        if (x < 0x80) b[n++] = x;
        else if ((x == 0xC2 || x == 0xC3) && i + 1 < ulen) { b[n++] = (uint8_t)(((x & 0x1F) << 6) | ((uint8_t)u[i + 1] & 0x3F)); i++; }
        else bad = 1;
    }
    JS_FreeCString(ctx, u);
    if (bad) { free(b); slog("not a byte string: ", path); return JS_FALSE; }
    make_parents(path);
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    snprintf(bak, sizeof(bak), "%s.bak", path);
    FILE *f = fopen(tmp, "wb");
    if (!f) { free(b); slog("cannot open ", tmp); return JS_FALSE; }
    size_t put = fwrite(b, 1, n, f);
    int closed = fclose(f);
    free(b);
    if (put != n || closed != 0) { remove(tmp); slog("short write: ", tmp); return JS_FALSE; }
    /* keep the previous copy until the new one is in place */
    struct stat st;
    if (stat(path, &st) == 0) {
        remove(bak);
        if (rename(path, bak) != 0) { remove(tmp); slog("cannot keep the old copy of ", path); return JS_FALSE; }
    }
    if (rename(tmp, path) != 0) {
        slog("cannot put in place ", path);
        rename(bak, path);
        return JS_FALSE;
    }
    return JS_TRUE;
}

static JSValue js_save_remove(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t;
    if (c < 1) return JS_FALSE;
    const char *name = JS_ToCString(ctx, v[0]);
    if (!name) return JS_FALSE;
    char path[300], bak[310];
    int ok = full_path(path, sizeof(path), name);
    JS_FreeCString(ctx, name);
    if (!ok) return JS_FALSE;
    snprintf(bak, sizeof(bak), "%s.bak", path);
    int r = remove(path) == 0;
    remove(bak);
    return JS_NewBool(ctx, r);
}

/* every file under save_root (not .tmp / .bak), as relative names */
static void list_dir(JSContext *ctx, JSValue arr, uint32_t *k, const char *rel, int depth) {
    char dirp[320];
    snprintf(dirp, sizeof(dirp), "%s%s", save_root, rel);
    DIR *d = opendir(dirp);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        const char *nm = e->d_name;
        if (nm[0] == '.') continue;
        size_t L = strlen(nm);
        if ((L > 4 && (!strcmp(nm + L - 4, ".tmp") || !strcmp(nm + L - 4, ".bak")))) continue;
        char sub[320];
        snprintf(sub, sizeof(sub), "%s%s", rel, nm);
        char full[340];
        snprintf(full, sizeof(full), "%s%s", save_root, sub);
        struct stat st;
        if (stat(full, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (depth < 6) {
                char sub2[330];
                snprintf(sub2, sizeof(sub2), "%s/", sub);
                list_dir(ctx, arr, k, sub2, depth + 1);
            }
        } else {
            JS_SetPropertyUint32(ctx, arr, (*k)++, JS_NewString(ctx, sub));
        }
    }
    closedir(d);
}

static JSValue js_save_list(JSContext *ctx, JSValueConst t, int c, JSValueConst *v) {
    (void)t; (void)c; (void)v;
    JSValue arr = JS_NewArray(ctx);
    uint32_t k = 0;
    list_dir(ctx, arr, &k, "", 0);
    return arr;
}

void g3_save_register(JSContext *ctx, JSValue o) {
    JS_SetPropertyStr(ctx, o, "g3SaveRead", JS_NewCFunction(ctx, js_save_read, "g3SaveRead", 1));
    JS_SetPropertyStr(ctx, o, "g3SaveWrite", JS_NewCFunction(ctx, js_save_write, "g3SaveWrite", 2));
    JS_SetPropertyStr(ctx, o, "g3SaveRemove", JS_NewCFunction(ctx, js_save_remove, "g3SaveRemove", 1));
    JS_SetPropertyStr(ctx, o, "g3SaveList", JS_NewCFunction(ctx, js_save_list, "g3SaveList", 0));
}
