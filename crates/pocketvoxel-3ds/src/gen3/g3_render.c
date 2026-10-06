/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The Gen 3 display: the guest's per-frame draw list
   (voxelmon/game/gen3/platform/drawlist.ts) drawn on the GPU with citro3d.

   - Textures by id (guest uploads, cache PNGs, canvases): RGBA8 (or, for an
     image every pixel of which is grey, luminance + alpha: the same values
     sampled in a half or a quarter of the memory), allocated a power of two
     (8..1024) and swizzled on upload; the padding repeats the last row and
     column, so a clamped tap past the image reads its edge.
   - Canvases are render targets (citro3d render-to-texture), which citro3d
     wants in VRAM; a fresh one is cleared by a memory fill at the start of
     the next frame (before anything can draw into it).
   - Each list is executed into a 256x256 target (the 240x160 GBA screen),
     which the shared world loop (main.rs, through gen3/mod.rs) lays over
     the top screen at 1.5x (360x240, centred) as the 2D layer: over the
     voxel world where the guest drew, the world showing where it left the
     frame clear (g3_composite), and the 20 px strips either side of it
     coloured or edge-stretched while a fade or a wipe covers the screen
     (g3_strips_set). The guest's billboards (the field's people, doors and
     field effects) are drawn in the world's own pass (g3_bb_*).
   - One vertex buffer per frame (two, alternating); primitives are batched
     until the target, texture or state changes.
   - Blend modes per LOVE 11 (rasterize.ts blendPx). Scissor, the target's
     own bounds, the band of gba_fx and the wrap of a non-power-of-two
     repeating texture are all done by clipping geometry on the CPU (exact at
     pixel centres, and independent of the framebuffer's orientation).
   - Effects (platform/effects/*.ts, ids by registration order): the packed
     ones on the TEV where they fit; level_flash, mosaic, region_map and
     stat_mask as CPU-recoloured copies of the drawn texture, cached. The
     guest's own CPU variants (anim_pal, g1_remap, palrot, remap_nearest)
     arrive as ordinary textures. See the NOT FAITHFUL notes below.

   Orientation: a texture's first row in memory is v = 1 (the image's top),
   and a render target's clip-space top lands there too (main.rs TILT SHIFT
   relies on the same), so guest y (down) maps to clip y with an ortho whose
   top is 0, and an image row r to v = 1 - r / th. */

#include <3ds.h>
#include <citro3d.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void voxel_log(const char *s, int len);
uint8_t *g3_png_decode(const uint8_t *png, size_t len, int *ow, int *oh);

static void g3log(const char *fmt, ...) {
    char b[256];
    int n = snprintf(b, sizeof(b), "[pv] g3: ");
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(b + n, sizeof(b) - n, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof(b) - 1) n = sizeof(b) - 1;
    voxel_log(b, n);
}

/* ---------------------------------------------------------------- files */

/* g3_files.c: the pack, loose files, deflated files */
uint8_t *g3_read_file(const char *path, size_t *len);

/* ---------------------------------------------------------------- textures */

typedef struct G3Tex {
    C3D_Tex tex;
    int w, h;            /* the image */
    int tw, th;          /* the allocation */
    uint8_t repeat;      /* wrap = repeat */
    uint8_t canvas;      /* a render target (GPU-written: not CPU-readable) */
    uint8_t fresh;       /* a canvas not cleared yet */
    uint32_t serial;     /* unique per allocation (CPU variant keys) */
    C3D_RenderTarget *rt;
    /* An image taller than the GPU's 1024 (the font sheets are 256x1040)
       is kept folded: rows fold.. sit beside rows 0..fold-1, so w x h holds
       a lw x lh image (w = 2 lw). 0 = not folded. emit_poly maps the image's
       u, v onto the halves. */
    int fold, lw, lh;
    uint8_t vram;        /* allocated in VRAM (canvases, the frame) */
    uint8_t fmt;         /* TF_*: how the texels are stored */
    uint32_t bytes;      /* the allocation's size (g3_tex_stats) */
} G3Tex;

/* Texel formats. An upload whose every pixel a smaller format holds exactly
   is stored in it (pick_fmt): grey images -- the font sheets, white glyphs
   the guest tints -- as luminance + alpha. The GPU reads LA texels as
   (L, L, L, A), so it samples the very values RGBA8 would have held. */
enum { TF_RGBA8, TF_LA8, TF_LA4 };
static const uint8_t TF_BPP[3] = {4, 2, 1};

/* Live textures (allocated, retired ones included until destroyed): count
   and bytes in linear memory, bytes in VRAM (g3_tex_stats). */
static int tex_live_n;
static uint32_t tex_live_lin, tex_live_vram;
/* canvases made and not cleared yet (g3_frame_offscreen walks the table
   only while there are some) */
static int tex_fresh_n;

static G3Tex **texs;
static int ntexs;
static uint32_t tex_serial = 1;
static G3Tex *white;     /* 8x8 opaque white: flat triangles, missing textures */
static G3Tex *frame_tex; /* target 0 */

/* Freed a few frames late: the GPU may still be reading the last frame. */
typedef struct { G3Tex *t; int frames; } Retired;
static Retired *retired;
static int nretired, capretired;

static void tex_destroy(G3Tex *t) {
    if (!t) return;
    if (t->rt) C3D_RenderTargetDelete(t->rt);
    C3D_TexDelete(&t->tex);
    tex_live_n--;
    if (t->vram) tex_live_vram -= t->bytes; else tex_live_lin -= t->bytes;
    if (t->fresh) tex_fresh_n--;
    free(t);
}

/* the quads the host's sprite batches hold (g3_batch_upload) */
static uint32_t batch_bytes;
/* [live textures, their bytes in linear memory, bytes in VRAM, batch bytes] */
void g3_tex_stats(uint32_t out[4]) {
    out[0] = (uint32_t)tex_live_n;
    out[1] = tex_live_lin;
    out[2] = tex_live_vram;
    out[3] = batch_bytes;
}

static void tex_retire(G3Tex *t) {
    if (!t) return;
    if (nretired == capretired) {
        capretired = capretired ? capretired * 2 : 32;
        retired = (Retired *)realloc(retired, sizeof(Retired) * capretired);
    }
    retired[nretired].t = t;
    retired[nretired].frames = 3;
    nretired++;
}

static void retire_tick(void) {
    int j = 0;
    for (int i = 0; i < nretired; i++) {
        if (--retired[i].frames <= 0) tex_destroy(retired[i].t);
        else retired[j++] = retired[i];
    }
    nretired = j;
}

static int po2(int n) { int p = 8; while (p < n) p <<= 1; return p; }

static G3Tex *tex_get(int id) { return (id > 0 && id < ntexs) ? texs[id] : NULL; }

static void tex_set(int id, G3Tex *t) {
    if (id <= 0) { tex_retire(t); return; }
    if (id >= ntexs) {
        int n = ntexs ? ntexs : 256;
        while (n <= id) n *= 2;
        texs = (G3Tex **)realloc(texs, sizeof(G3Tex *) * n);
        memset(texs + ntexs, 0, sizeof(G3Tex *) * (n - ntexs));
        ntexs = n;
    }
    if (texs[id]) tex_retire(texs[id]);
    texs[id] = t;
}

/* Index of texel (x, y) in a tw-wide texture's 8x8 Morton tiles. */
static inline uint32_t tile_idx(int x, int y, int tw) {
    static const uint8_t MX[8] = {0, 1, 4, 5, 16, 17, 20, 21};
    static const uint8_t MY[8] = {0, 2, 8, 10, 32, 34, 40, 42};
    return (((y >> 3) * (tw >> 3) + (x >> 3)) << 6) + MX[x & 7] + MY[y & 7];
}
/* Byte offset of texel (x, y) in a tw-wide RGBA8 texture. */
static inline uint32_t tile_off(int x, int y, int tw) { return tile_idx(x, y, tw) << 2; }

/* The smallest format that holds every pixel of w x h RGBA8 exactly. */
static int pick_fmt(const uint8_t *rgba, int w, int h) {
    int la4 = 1;
    const uint8_t *p = rgba, *e = rgba + (size_t)w * h * 4;
    for (; p < e; p += 4) {
        if (p[0] != p[1] || p[1] != p[2]) return TF_RGBA8;
        /* a 4-bit channel n is read as n * 17 */
        if (la4 && (p[0] % 17 || p[3] % 17)) la4 = 0;
    }
    return la4 ? TF_LA4 : TF_LA8;
}

static G3Tex *tex_alloc_fmt(int w, int h, int repeat, int vram, int fmt) {
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return NULL;
    G3Tex *t = (G3Tex *)calloc(1, sizeof(G3Tex));
    if (!t) return NULL;
    t->w = w; t->h = h; t->tw = po2(w); t->th = po2(h);
    t->repeat = (uint8_t)(repeat != 0);
    t->serial = tex_serial++;
    GPU_TEXCOLOR gf = fmt == TF_LA4 ? GPU_LA4 : fmt == TF_LA8 ? GPU_LA8 : GPU_RGBA8;
    if (!(vram ? C3D_TexInitVRAM(&t->tex, (u16)t->tw, (u16)t->th, gf)
               : C3D_TexInit(&t->tex, (u16)t->tw, (u16)t->th, gf))) { free(t); return NULL; }
    t->vram = (uint8_t)(vram != 0);
    t->fmt = (uint8_t)fmt;
    t->bytes = (uint32_t)t->tw * t->th * TF_BPP[fmt];
    tex_live_n++;
    if (vram) tex_live_vram += t->bytes; else tex_live_lin += t->bytes;
    C3D_TexSetFilter(&t->tex, GPU_NEAREST, GPU_NEAREST);
    /* the GPU's repeat wraps at the allocation: right only for a power of two
       (the rest is split into periods on the CPU, see emit_poly) */
    GPU_TEXTURE_WRAP_PARAM wr = (repeat && t->w == t->tw && t->h == t->th) ? GPU_REPEAT : GPU_CLAMP_TO_EDGE;
    C3D_TexSetWrap(&t->tex, wr, wr);
    return t;
}

static G3Tex *tex_alloc(int w, int h, int repeat, int vram) { return tex_alloc_fmt(w, h, repeat, vram, TF_RGBA8); }

/* Texel (x, y) of t from an RGBA8 pixel, in t's format. */
static inline void tex_put(G3Tex *t, int x, int y, const uint8_t *p) {
    void *data = t->tex.data;
    uint32_t i = tile_idx(x, y, t->tw);
    if (t->fmt == TF_LA4)      /* LA4 texel: L in the high nibble, A in the low */
        ((uint8_t *)data)[i] = (uint8_t)(((p[0] / 17) << 4) | (p[3] / 17));
    else if (t->fmt == TF_LA8) /* LA8 texel: bytes A, L */
        ((uint16_t *)data)[i] = (uint16_t)((p[0] << 8) | p[3]);
    else                       /* RGBA8 texel: bytes A, B, G, R */
        ((uint32_t *)data)[i] = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

/* Rows y0..y1-1 and columns x0..x1-1 of t from its w x h RGBA8 image -- the
   padding past the image's right and bottom edges repeating its edge
   texels when the rect reaches them -- and the touched tile rows flushed. */
static void tex_fill_rect(G3Tex *t, const uint8_t *rgba, int x0, int y0, int x1, int y1) {
    int xe = x1 >= t->w ? t->tw : x1, ye = y1 >= t->h ? t->th : y1;
    for (int y = y0; y < ye; y++) {
        const uint8_t *row = rgba + (size_t)(y < t->h ? y : t->h - 1) * t->w * 4;
        for (int x = x0; x < xe; x++) tex_put(t, x, y, row + (x < t->w ? x : t->w - 1) * 4);
    }
    uint32_t rowb = (uint32_t)(t->tw >> 3) * 64 * TF_BPP[t->fmt]; /* one row of 8x8 tiles */
    uint32_t r0 = (uint32_t)y0 >> 3, r1 = ((uint32_t)ye + 7) >> 3;
    GSPGPU_FlushDataCache((uint8_t *)t->tex.data + r0 * rowb, (r1 - r0) * rowb);
}

/* Swizzle w*h RGBA8 into t in its format (padding = the edge texels), and flush. */
static void tex_fill(G3Tex *t, const uint8_t *rgba) { tex_fill_rect(t, rgba, 0, 0, t->w, t->h); }

static inline void tex_texel(const G3Tex *t, int x, int y, float out[4]) {
    uint32_t i = tile_idx(x, y, t->tw);
    uint32_t r, g, b, a;
    if (t->fmt == TF_LA4) {
        uint8_t v = ((const uint8_t *)t->tex.data)[i];
        r = g = b = (uint32_t)(v >> 4) * 17; a = (uint32_t)(v & 15) * 17;
    } else if (t->fmt == TF_LA8) {
        uint16_t v = ((const uint16_t *)t->tex.data)[i];
        r = g = b = v >> 8; a = v & 255;
    } else {
        uint32_t v = ((const uint32_t *)t->tex.data)[i];
        r = v >> 24; g = (v >> 16) & 255; b = (v >> 8) & 255; a = v & 255;
    }
    out[0] = (float)r / 255.0f;
    out[1] = (float)g / 255.0f;
    out[2] = (float)b / 255.0f;
    out[3] = (float)a / 255.0f;
}

/* Nearest sample at (u, v) over the image, clamped (rasterize.ts sample). */
static void tex_sample(const G3Tex *t, float u, float v, float out[4]) {
    int ix = (int)floorf(u * t->w), iy = (int)floorf(v * t->h);
    if (t->repeat) { ix = ((ix % t->w) + t->w) % t->w; iy = ((iy % t->h) + t->h) % t->h; }
    else { ix = ix < 0 ? 0 : ix >= t->w ? t->w - 1 : ix; iy = iy < 0 ? 0 : iy >= t->h ? t->h - 1 : iy; }
    tex_texel(t, ix, iy, out);
}

/* An image of 1025..1536 rows and up to 512 columns, folded in two columns
   at FOLD_ROW (a multiple of 16, so a font's glyph rows never straddle it;
   a quad that does is cut there by emit_poly). */
#define FOLD_ROW 512
static G3Tex *tex_alloc_folded(int w, int h, const uint8_t *rgba) {
    if (w <= 0 || w > 512 || h <= 1024 || h - FOLD_ROW > 1024) return NULL;
    int pw = w * 2, ph = h - FOLD_ROW > FOLD_ROW ? h - FOLD_ROW : FOLD_ROW;
    uint8_t *px = (uint8_t *)malloc((size_t)pw * ph * 4);
    if (!px) return NULL;
    for (int y = 0; y < ph; y++) {
        /* left: rows y; right: rows FOLD_ROW + y (edge-repeated past the image) */
        int yl = y < FOLD_ROW ? y : FOLD_ROW - 1;
        int yr = FOLD_ROW + y < h ? FOLD_ROW + y : h - 1;
        memcpy(px + ((size_t)y * pw) * 4, rgba + (size_t)yl * w * 4, (size_t)w * 4);
        memcpy(px + ((size_t)y * pw + w) * 4, rgba + (size_t)yr * w * 4, (size_t)w * 4);
    }
    G3Tex *t = tex_alloc_fmt(pw, ph, 0, 0, pick_fmt(rgba, w, h));
    if (t) { tex_fill(t, px); t->fold = FOLD_ROW; t->lw = w; t->lh = h; }
    if (t) g3log("texUpload %dx%d folded: %s, %u KB", w, h, t->fmt == TF_LA4 ? "LA4" : t->fmt == TF_LA8 ? "LA8" : "RGBA8", (unsigned)(t->bytes >> 10));
    free(px);
    return t;
}

int g3_tex_upload(int id, int w, int h, const uint8_t *rgba, size_t len, int repeat) {
    if (!rgba || len < (size_t)w * h * 4) return 0;
    if (h > 1024 && !repeat) {
        G3Tex *f = tex_alloc_folded(w, h, rgba);
        if (f) { tex_set(id, f); return 1; }
    }
    G3Tex *t = tex_alloc_fmt(w, h, repeat, 0, pick_fmt(rgba, w, h));
    if (!t) { g3log("texUpload %d: cannot make %dx%d", id, w, h); return 0; }
    tex_fill(t, rgba);
    tex_set(id, t);
    return 1;
}

int g3_tex_from_cache(int id, const char *path, int *ow, int *oh) {
    size_t n = strlen(path);
    if (n < 4 || strcmp(path + n - 4, ".png") != 0) return 0;
    size_t len = 0;
    uint8_t *png = g3_read_file(path, &len);
    if (!png) return 0;
    int w = 0, h = 0;
    uint8_t *rgba = g3_png_decode(png, len, &w, &h);
    free(png);
    if (!rgba) { g3log("texFromCache: cannot decode %s", path); return 0; }
    int ok = g3_tex_upload(id, w, h, rgba, (size_t)w * h * 4, 0);
    free(rgba);
    if (!ok) return 0;
    *ow = w; *oh = h;
    return 1;
}

void g3_canvas_new(int id, int w, int h) {
    G3Tex *t = tex_alloc(w, h, 0, 1);
    if (!t) { g3log("canvas %d: cannot make %dx%d (VRAM)", id, w, h); return; }
    t->rt = C3D_RenderTargetCreateFromTex(&t->tex, GPU_TEXFACE_2D, 0, -1);
    if (!t->rt) { g3log("canvas %d: no render target", id); tex_destroy(t); return; }
    t->canvas = 1;
    t->fresh = 1;
    tex_fresh_n++;
    tex_set(id, t);
}

void g3_tex_free(int id) {
    G3Tex *t = tex_get(id);
    if (!t) return;
    texs[id] = NULL;
    tex_retire(t);
}

/* ---------------------------------------------------------------- GPU */

typedef struct { float x, y, z; uint8_t c[4]; float u, v; } Vtx;

#define VBUF_VERTS 24576
/* what a draw list may fill: the rest of the frame's buffer is the
   composite quad's and the billboards' (G3_ENTS_MAX quads) */
#define VBUF_LIST_VERTS (VBUF_VERTS - 512)
static Vtx *vbuf[2];
static int vcur;          /* which buffer this frame writes */
static int vn;            /* vertices written this frame */
static int vstart;        /* first vertex of the pending batch */
static int vdropped;

static shaderProgram_s prog;
static DVLB_s *dvlb;
static int loc_proj, loc_uvx, loc_toff;
/* the latest draw list from the guest, not drawn yet */
static float *list;
static size_t list_n, list_cap;
static int list_new;

/* stats, summed until read */
static uint32_t st_frames, st_lists, st_quads, st_tris, st_calls, st_verts, st_vars;
static double st_build_us;

/* The 2D layer's GPU side, inside the shared loop's citro3d (main.rs made
   the instance and owns the screens): the program (main.rs's own shader
   bytes, so the same uniform registers as its program), the two per-frame
   vertex buffers, the white texture and the frame target. */
int g3_gpu_init_shared(const uint8_t *shbin, uint32_t len) {
    /* the shader wants its bytes word-aligned, and keeps pointing into them */
    u32 *sh = (u32 *)malloc((len + 3) & ~3u);
    if (!sh) return -3;
    memcpy(sh, shbin, len);
    dvlb = DVLB_ParseFile(sh, len);
    if (!dvlb) return -4;
    shaderProgramInit(&prog);
    shaderProgramSetVsh(&prog, &dvlb->DVLE[0]);
    loc_proj = shaderInstanceGetUniformLocation(prog.vertexShader, "projection");
    loc_uvx = shaderInstanceGetUniformLocation(prog.vertexShader, "uvx");
    loc_toff = shaderInstanceGetUniformLocation(prog.vertexShader, "toff");
    for (int i = 0; i < 2; i++) {
        vbuf[i] = (Vtx *)linearAlloc(sizeof(Vtx) * VBUF_VERTS);
        if (!vbuf[i]) return -5;
    }
    uint8_t px[8 * 8 * 4];
    memset(px, 255, sizeof(px));
    white = tex_alloc(8, 8, 1, 0);
    if (!white) return -6;
    tex_fill(white, px);
    frame_tex = tex_alloc(240, 160, 0, 1);
    if (!frame_tex) return -7;
    frame_tex->fresh = 1;
    frame_tex->rt = C3D_RenderTargetCreateFromTex(&frame_tex->tex, GPU_TEXFACE_2D, 0, -1);
    if (!frame_tex->rt) return -8;
    frame_tex->canvas = 1;
    g3log("gpu ready (shared loop): frame %dx%d in %dx%d, %d verts/frame", frame_tex->w, frame_tex->h, frame_tex->tw, frame_tex->th, VBUF_VERTS);
    return 1;
}

/* ---------------------------------------------------------------- sprite batches */

/* The guest's sprite batches (OP_BATCH): quads of 12 floats each -- x0 y0 x1
   y1 x2 y2 x3 y3 u0 v0 u1 v1, batch-local -- kept until replaced or freed,
   so a batch that did not change costs one op a frame instead of its quads. */
typedef struct { int tex; float *q; int n, cap; } G3Batch;
static G3Batch *batches;
static int nbatches;

void g3_batch_upload(int id, int tex, const float *q, int n) {
    if (id <= 0 || n < 0) return;
    if (id >= nbatches) {
        int c = nbatches ? nbatches : 64;
        while (c <= id) c *= 2;
        G3Batch *nb = (G3Batch *)realloc(batches, (size_t)c * sizeof(G3Batch));
        if (!nb) return;
        memset(nb + nbatches, 0, (size_t)(c - nbatches) * sizeof(G3Batch));
        batches = nb;
        nbatches = c;
    }
    G3Batch *b = &batches[id];
    if (n * 12 > b->cap) {
        float *nq = (float *)realloc(b->q, (size_t)n * 12 * sizeof(float));
        if (!nq) { b->n = 0; return; }
        b->q = nq;
        batch_bytes += (uint32_t)(n * 12 - b->cap) * 4;
        b->cap = n * 12;
    }
    if (n) memcpy(b->q, q, (size_t)n * 12 * sizeof(float));
    b->n = n;
    b->tex = tex;
}

void g3_batch_free(int id) {
    if (id <= 0 || id >= nbatches) return;
    batch_bytes -= (uint32_t)batches[id].cap * 4;
    free(batches[id].q);
    memset(&batches[id], 0, sizeof(G3Batch));
}

void g3_draw(const float *f, size_t n) {
    if (n > list_cap) {
        size_t c = list_cap ? list_cap : 4096;
        while (c < n) c *= 2;
        float *nl = (float *)realloc(list, c * sizeof(float));
        if (!nl) return;
        list = nl; list_cap = c;
    }
    memcpy(list, f, n * sizeof(float));
    list_n = n;
    list_new = 1;
}

/* ---------------------------------------------------------------- state */

enum { BLEND_ALPHA, BLEND_ALPHA_PREMUL, BLEND_ADD, BLEND_ADD_PREMUL, BLEND_MULTIPLY, BLEND_REPLACE, BLEND_SUBTRACT };

/* effect ids: platform/effects/index.ts registration order */
enum {
    FX_NONE, FX_AFFINE_COLOR, FX_ANIM_PAL, FX_BLEND5, FX_BLEND5_PRE, FX_G1_REMAP, FX_GBA_FX, FX_GRAY5, FX_GRAY5_PRE,
    FX_GRAY_LUMA, FX_LEVEL_FLASH, FX_MASK_OVERLAY, FX_MASK_WRITE, FX_MIX_TARGET, FX_MOSAIC, FX_PALROT,
    FX_REGION_MAP, FX_REMAP_NEAREST, FX_SCREEN_FX, FX_SILHOUETTE, FX_SOLID_MASK, FX_STAT_MASK, FX_TINT_ALPHA,
};

/* how a primitive's vertex colour is made from the draw list's rgba */
enum { VC_PLAIN, VC_SCALE, VC_GBAFX, VC_WHITE };

typedef struct {
    C3D_TexEnv env[6];
    int bufmask;
    int atest;
    int vc;          /* VC_* */
    float vcscale;   /* VC_SCALE: rgb multiplier */
    float bldy;      /* VC_GBAFX: brightness 0..16 when there is no band */
    int band;        /* VC_GBAFX: the band is on (split at its kinks) */
    float bandy;
    int cpu;         /* a host CPU variant effect: draw its recoloured copy */
} Prog;

typedef struct {
    G3Tex *target;   /* NULL = the frame */
    int blend, effect;
    float p[16];
    int sc_on;
    float sc[4];
    Prog prog;
    uint32_t serial; /* bumped whenever blend/effect/params change */
} State;

static State S;
static G3Tex *bound_target;
static G3Tex *bound_tex;
static uint32_t bound_serial;
static int bound_valid;

static inline u32 rgba32(float r, float g, float b, float a) {
    #define C8(v) ((u32)((v) <= 0 ? 0 : (v) >= 1 ? 255 : (int)((v) * 255.0f + 0.5f)))
    return C8(r) | (C8(g) << 8) | (C8(b) << 16) | (C8(a) << 24);
    #undef C8
}

static inline float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

#define RC GPU_TEVOP_RGB_SRC_COLOR
#define RA GPU_TEVOP_RGB_SRC_ALPHA
#define RR GPU_TEVOP_RGB_SRC_R
#define RG GPU_TEVOP_RGB_SRC_G
#define RB GPU_TEVOP_RGB_SRC_B
#define RIC GPU_TEVOP_RGB_ONE_MINUS_SRC_COLOR
#define AA GPU_TEVOP_A_SRC_ALPHA
#define AR GPU_TEVOP_A_SRC_R
#define TEX GPU_TEXTURE0
#define PRI GPU_PRIMARY_COLOR
#define CON GPU_CONSTANT
#define PRV GPU_PREVIOUS
#define BUF GPU_PREVIOUS_BUFFER

static void rgb(C3D_TexEnv *e, int s1, int s2, int s3, int o1, int o2, int o3, int func, int scale) {
    C3D_TexEnvSrc(e, C3D_RGB, (GPU_TEVSRC)s1, (GPU_TEVSRC)s2, (GPU_TEVSRC)s3);
    C3D_TexEnvOpRgb(e, (GPU_TEVOP_RGB)o1, (GPU_TEVOP_RGB)o2, (GPU_TEVOP_RGB)o3);
    C3D_TexEnvFunc(e, C3D_RGB, (GPU_COMBINEFUNC)func);
    C3D_TexEnvScale(e, C3D_RGB, (GPU_TEVSCALE)scale);
}
static void alp(C3D_TexEnv *e, int s1, int s2, int s3, int o1, int o2, int o3, int func, int scale) {
    C3D_TexEnvSrc(e, C3D_Alpha, (GPU_TEVSRC)s1, (GPU_TEVSRC)s2, (GPU_TEVSRC)s3);
    C3D_TexEnvOpAlpha(e, (GPU_TEVOP_A)o1, (GPU_TEVOP_A)o2, (GPU_TEVOP_A)o3);
    C3D_TexEnvFunc(e, C3D_Alpha, (GPU_COMBINEFUNC)func);
    C3D_TexEnvScale(e, C3D_Alpha, (GPU_TEVSCALE)scale);
}
/* the common stages */
static void s_modulate(C3D_TexEnv *e) { /* tex * primary, both */
    rgb(e, TEX, PRI, PRI, RC, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
    alp(e, TEX, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
}
static void s_pass_alpha(C3D_TexEnv *e) { alp(e, PRV, PRV, PRV, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_1); }
/* rgb = sum_i src.i * w_i over three stages starting at k (src TEX or BUF for
   channels after the first; the first reads `first`) */
static int s_weighted(Prog *p, int k, int first, int rest, float wr, float wg, float wb) {
    C3D_TexEnv *e = p->env;
    rgb(&e[k], first, CON, CON, RR, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
    C3D_TexEnvColor(&e[k], rgba32(wr, wr, wr, 0));
    rgb(&e[k + 1], rest, CON, PRV, RG, RC, RC, GPU_MULTIPLY_ADD, GPU_TEVSCALE_1);
    C3D_TexEnvColor(&e[k + 1], rgba32(wg, wg, wg, 0));
    s_pass_alpha(&e[k + 1]);
    rgb(&e[k + 2], rest, CON, PRV, RB, RC, RC, GPU_MULTIPLY_ADD, GPU_TEVSCALE_1);
    C3D_TexEnvColor(&e[k + 2], rgba32(wb, wb, wb, 0));
    s_pass_alpha(&e[k + 2]);
    return k + 3;
}

/* Build the TEV program for an effect and its packed params. */
static void prog_build(Prog *p, int effect, const float *q) {
    memset(p, 0, sizeof(*p));
    for (int i = 0; i < 6; i++) C3D_TexEnvInit(&p->env[i]);
    C3D_TexEnv *e = p->env;
    p->vc = VC_PLAIN;
    switch (effect) {
    case FX_AFFINE_COLOR: {
        /* clamp(t*c*m + off): m folded into the vertex colour (with the
           stage's 2x/4x when it is over 1), off added and subtracted.
           NOT FAITHFUL: with m > 1 the product is clamped before a negative
           offset applies (the shader clamps once, after the sum); the vertex
           colour carries c*m in 8 bits. */
        float m = q[0];
        int sc = GPU_TEVSCALE_1;
        float div = 1;
        if (m > 2) { sc = GPU_TEVSCALE_4; div = 4; } else if (m > 1) { sc = GPU_TEVSCALE_2; div = 2; }
        p->vc = VC_SCALE;
        p->vcscale = m / div;
        s_modulate(&e[0]);
        C3D_TexEnvScale(&e[0], C3D_RGB, (GPU_TEVSCALE)sc);
        rgb(&e[1], PRV, CON, CON, RC, RC, RC, GPU_ADD, GPU_TEVSCALE_1);
        C3D_TexEnvColor(&e[1], rgba32(q[1] > 0 ? q[1] : 0, q[2] > 0 ? q[2] : 0, q[3] > 0 ? q[3] : 0, 0));
        s_pass_alpha(&e[1]);
        rgb(&e[2], PRV, CON, CON, RC, RC, RC, GPU_SUBTRACT, GPU_TEVSCALE_1);
        C3D_TexEnvColor(&e[2], rgba32(q[1] < 0 ? -q[1] : 0, q[2] < 0 ? -q[2] : 0, q[3] < 0 ? -q[3] : 0, 0));
        s_pass_alpha(&e[2]);
        break;
    }
    case FX_BLEND5:
    case FX_BLEND5_PRE: {
        /* c + floor((T - c) * k / 16) in 5-bit steps, as a mix toward T/31 by
           k/16. NOT FAITHFUL: the shader's floor to the 5-bit step is not
           taken (within 1/31 per channel). */
        u32 k = rgba32(q[1] / 31.0f, q[2] / 31.0f, q[3] / 31.0f, q[0] / 16.0f);
        if (effect == FX_BLEND5) {
            rgb(&e[0], CON, TEX, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            alp(&e[0], TEX, TEX, TEX, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[0], k);
            rgb(&e[1], PRV, PRI, PRI, RC, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
            alp(&e[1], PRV, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        } else {
            s_modulate(&e[0]);
            rgb(&e[1], CON, PRV, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[1], k);
            s_pass_alpha(&e[1]);
        }
        break;
    }
    case FX_MIX_TARGET:
        /* mix(t, T, k) * c: exact up to the TEV's 8 bits */
        rgb(&e[0], CON, TEX, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, TEX, TEX, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_1);
        C3D_TexEnvColor(&e[0], rgba32(q[0], q[1], q[2], q[3]));
        rgb(&e[1], PRV, PRI, PRI, RC, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
        alp(&e[1], PRV, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        break;
    case FX_GRAY5: {
        /* floor((c5 r + c5 g + c5 b) / 3) / 31, times c. NOT FAITHFUL: the
           average is not floored to a 5-bit step. */
        int k = s_weighted(p, 0, TEX, TEX, 1.0f / 3, 1.0f / 3, 1.0f / 3);
        alp(&e[0], TEX, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        rgb(&e[k], PRV, PRI, PRI, RC, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
        s_pass_alpha(&e[k]);
        break;
    }
    case FX_GRAY5_PRE:
    case FX_GRAY_LUMA: {
        /* grey of t*c: stage 0's product kept in the combiner buffer for the
           channel sums. gray5_pre NOT FAITHFUL as gray5 (no 5-bit floor). */
        s_modulate(&e[0]);
        p->bufmask = 1;
        if (effect == FX_GRAY5_PRE) s_weighted(p, 1, PRV, BUF, 1.0f / 3, 1.0f / 3, 1.0f / 3);
        else s_weighted(p, 1, PRV, BUF, 0.299f, 0.587f, 0.114f);
        s_pass_alpha(&e[1]);
        break;
    }
    case FX_GBA_FX: {
        /* p: fadeY, fadeColor rgb (0..31), gray, bldy, mode, k, bandOn,
           bandY, win... The texel's alpha below 0.5 is discarded (an alpha
           step into the alpha test); the 5-bit colour, then grey, then the
           fade toward fadeColor by fadeY/16, then brightness toward white by
           bldy/16 -- or by the band's 15 - |y - bandY|, carried per vertex in
           the primary colour's red and split at its kinks, so it is exact at
           pixel centres -- then the mode.
           NOT FAITHFUL: no 5-bit floors (within 1/31 per step); grey is the
           GBA luma without the shader's seven-level quantisation; the window
           (winTex / winRect / winBldy) is ignored. */
        int mode = q[6] > 1.5f ? 2 : q[6] > 0.5f ? 1 : 0;
        int k = 0;
        p->vc = VC_GBAFX;
        p->atest = 1;
        p->band = q[8] > 0.5f;
        p->bandy = q[9];
        p->bldy = q[5];
        if (q[4] > 0.5f) k = s_weighted(p, 0, TEX, TEX, 76.0f / 256, 151.0f / 256, 29.0f / 256);
        else { rgb(&e[0], TEX, TEX, TEX, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1); k = 1; }
        /* alpha: (t.a - 0.5) * 4 -> 0 below the half, 1 from 0.75; times the
           vertex alpha in mode 0 (the shader returns col.a), 1 otherwise */
        alp(&e[0], TEX, CON, CON, AA, AA, AA, GPU_ADD_SIGNED, GPU_TEVSCALE_4);
        C3D_TexEnvColor(&e[0], e[0].color & 0x00FFFFFF);
        if (mode == 0) alp(&e[1], PRV, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        else s_pass_alpha(&e[1]);
        if (q[0] > 0) {
            float f = q[0] / 16.0f;
            rgb(&e[k], CON, PRV, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[k], rgba32(q[1] / 31.0f, q[2] / 31.0f, q[3] / 31.0f, clamp01(f)));
            if (k > 1) s_pass_alpha(&e[k]);
            k++;
        }
        if (p->band || q[5] > 0) {
            rgb(&e[k], CON, PRV, PRI, RC, RC, RR, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[k], 0xFFFFFFFF);
            if (k > 1) s_pass_alpha(&e[k]);
            k++;
        }
        if (mode == 2) {
            rgb(&e[k], PRV, CON, CON, RC, RC, RC, GPU_MODULATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[k], rgba32(q[7], q[7], q[7], 1));
            if (k > 1) s_pass_alpha(&e[k]);
            k++;
        } else if (mode == 1) {
            rgb(&e[k], CON, CON, CON, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[k], rgba32(q[7], q[7], q[7], 1));
            if (k > 1) s_pass_alpha(&e[k]);
            k++;
        }
        break;
    }
    case FX_MASK_OVERLAY:
        /* (fx, amount * t.r) */
        rgb(&e[0], CON, CON, CON, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, CON, CON, AR, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        C3D_TexEnvColor(&e[0], rgba32(q[0], q[1], q[2], q[3]));
        break;
    case FX_MASK_WRITE:
        /* (value, 0, 0, 1), discarding t.a < 0.01. NOT FAITHFUL: alpha
           between 0 and 1/16 is not treated as opaque (masks are 0/1). */
        rgb(&e[0], CON, CON, CON, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, TEX, TEX, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_4);
        C3D_TexEnvColor(&e[0], rgba32(q[0], 0, 0, 1));
        alp(&e[1], PRV, PRV, PRV, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_4);
        p->atest = 1;
        break;
    case FX_SCREEN_FX: {
        int type = (int)q[0];
        s_modulate(&e[0]);
        if (type == 1) {
            rgb(&e[1], PRV, PRV, PRV, RIC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
            s_pass_alpha(&e[1]);
        } else if (type == 2 || type == 3 || type == 5) {
            float r = type == 2 ? 1 : type == 3 ? 0 : q[2], g = type == 2 ? 1 : type == 3 ? 0 : q[3], b = type == 2 ? 1 : type == 3 ? 0 : q[4];
            rgb(&e[1], CON, PRV, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[1], rgba32(r, g, b, q[1]));
            s_pass_alpha(&e[1]);
        } else if (type == 4) {
            p->bufmask = 1;
            s_weighted(p, 1, PRV, BUF, 0.299f, 0.587f, 0.114f);
            s_pass_alpha(&e[1]);
            rgb(&e[4], PRV, BUF, CON, RC, RC, RA, GPU_INTERPOLATE, GPU_TEVSCALE_1);
            C3D_TexEnvColor(&e[4], rgba32(0, 0, 0, q[1]));
            s_pass_alpha(&e[4]);
        }
        break;
    }
    case FX_SILHOUETTE:
        /* (c.rgb, t.a*c.a), discarding transparent texels (alpha test > 0;
           the shader's cut is t.a < 0.05 -- the same for 0/1 alpha) */
        rgb(&e[0], PRI, PRI, PRI, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        p->atest = 1;
        break;
    case FX_TINT_ALPHA:
        rgb(&e[0], PRI, PRI, PRI, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, PRI, PRI, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        break;
    case FX_SOLID_MASK:
        /* c where t.a > 0, else 0: the step as t.a * 16 (two 4x stages).
           NOT FAITHFUL for alpha in (0, 1/16) (images are 0/1). */
        rgb(&e[0], PRI, PRI, PRI, RC, RC, RC, GPU_REPLACE, GPU_TEVSCALE_1);
        alp(&e[0], TEX, TEX, TEX, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_4);
        alp(&e[1], PRV, PRV, PRV, AA, AA, AA, GPU_REPLACE, GPU_TEVSCALE_4);
        rgb(&e[2], PRI, PRV, PRV, RC, RA, RC, GPU_MODULATE, GPU_TEVSCALE_1);
        alp(&e[2], PRI, PRV, PRV, AA, AA, AA, GPU_MODULATE, GPU_TEVSCALE_1);
        break;
    case FX_LEVEL_FLASH:
    case FX_MOSAIC:
    case FX_REGION_MAP:
    case FX_STAT_MASK:
        p->cpu = 1;
        s_modulate(&e[0]);
        p->vc = effect == FX_MOSAIC ? VC_PLAIN : VC_WHITE;
        break;
    default:
        /* none, and the guest's CPU variants (their textures are recoloured) */
        s_modulate(&e[0]);
        break;
    }
}

static void apply_blend(int mode) {
    switch (mode) {
    case BLEND_ALPHA_PREMUL:
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA); break;
    case BLEND_ADD:
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE, GPU_ZERO, GPU_ONE); break;
    case BLEND_ADD_PREMUL:
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ONE, GPU_ZERO, GPU_ONE); break;
    case BLEND_MULTIPLY:
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_DST_COLOR, GPU_ZERO, GPU_DST_ALPHA, GPU_ZERO); break;
    case BLEND_REPLACE:
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ZERO, GPU_ONE, GPU_ZERO); break;
    case BLEND_SUBTRACT:
        C3D_AlphaBlend(GPU_BLEND_REVERSE_SUBTRACT, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE, GPU_ZERO, GPU_ONE); break;
    default: /* BLEND_ALPHA */
        C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA); break;
    }
}

static void apply_prog(const Prog *p) {
    for (int i = 0; i < 6; i++) C3D_SetTexEnv(i, (C3D_TexEnv *)&p->env[i]);
    C3D_TexEnvBufUpdate(C3D_Both, p->bufmask);
    C3D_AlphaTest(p->atest ? true : false, GPU_GREATER, 0);
}

static void flush(void) {
    if (vn > vstart) {
        C3D_DrawArrays(GPU_TRIANGLES, vstart, vn - vstart);
        st_calls++;
    }
    vstart = vn;
}

static void select_target(G3Tex *t) {
    flush();
    C3D_FrameDrawOn(t->rt);
    C3D_Mtx m;
    Mtx_Ortho(&m, 0.0f, (float)t->tw, (float)t->th, 0.0f, -1.0f, 1.0f, true);
    C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, loc_proj, &m);
    bound_target = t;
    bound_valid = 0;
}

/* Make the GPU ready to draw with `tex` under the current state. */
static void gpu_bind(G3Tex *tex, const Prog *p, int blend, uint32_t serial) {
    if (bound_valid && bound_tex == tex && bound_serial == serial) return;
    flush();
    if (!bound_valid || bound_serial != serial) {
        apply_blend(blend);
        apply_prog(p);
    }
    C3D_TexBind(0, &tex->tex);
    bound_tex = tex;
    bound_serial = serial;
    bound_valid = 1;
}

/* ---------------------------------------------------------------- CPU variants */

typedef struct {
    uint32_t src, mask;  /* source / mask texture serials */
    int effect;
    float p[16];
    u32 col;
    G3Tex *tex;
    uint32_t used;
} Var;

#define NVARS 48
static Var vars[NVARS];
static uint32_t frame_no;

static void fx_pixel_cpu(int effect, const float *t, const float *c, const float *q, float tu, float tv,
                         const G3Tex *mask, float out[4], int *discard) {
    *discard = 0;
    switch (effect) {
    case FX_LEVEL_FLASH: {
        float o[4] = {t[0] * c[0], t[1] * c[1], t[2] * c[2], t[3] * c[3]};
        float d1 = sqrtf((o[0] - q[0]) * (o[0] - q[0]) + (o[1] - q[1]) * (o[1] - q[1]) + (o[2] - q[2]) * (o[2] - q[2]));
        float d2 = sqrtf((o[0] - q[3]) * (o[0] - q[3]) + (o[1] - q[4]) * (o[1] - q[4]) + (o[2] - q[5]) * (o[2] - q[5]));
        if (d1 < 0.04f || d2 < 0.04f) {
            float k = q[9];
            for (int i = 0; i < 3; i++) o[i] = o[i] * (1 - k) + q[6 + i] * k;
        }
        memcpy(out, o, sizeof(o));
        break;
    }
    case FX_REGION_MAP: {
        float cc[3];
        for (int i = 0; i < 3; i++) cc[i] = floorf(t[i] * c[i] * 31 + 0.5f);
        if (q[0] > 0.5f) {
            float gray = floorf((cc[0] * 76 + cc[1] * 151 + cc[2] * 29) / 256);
            for (int i = 0; i < 3; i++) { float v = floorf(q[1 + i] * gray / 256); cc[i] = v < 31 ? v : 31; }
        }
        if (q[4] > 0) for (int i = 0; i < 3; i++) cc[i] = cc[i] + floorf((0 - cc[i]) * q[4] / 16);
        if (q[5] > 2.5f) for (int i = 0; i < 3; i++) cc[i] = cc[i] - floorf(cc[i] * q[6] / 16);
        else if (q[5] > 1.5f) for (int i = 0; i < 3; i++) cc[i] = cc[i] + floorf((31 - cc[i]) * q[6] / 16);
        out[0] = cc[0] / 31; out[1] = cc[1] / 31; out[2] = cc[2] / 31; out[3] = t[3] * c[3];
        break;
    }
    case FX_STAT_MASK: {
        if (t[3] < 0.01f) { *discard = 1; return; }
        float tx = q[9] > 0.5f ? 1 - tu : tu;
        float px = floorf(q[1] + tx * q[3]), py = floorf(q[2] + tv * q[4]);
        float k[4] = {0, 0, 0, 0};
        if (mask) tex_sample(mask, (px + q[5] + 0.5f) / 256, (py + q[6] + 0.5f) / 256, k);
        if (k[3] < 0.01f) { *discard = 1; return; }
        if (q[11] > 0.5f) { out[0] = out[1] = out[2] = 0; }
        else { out[0] = k[0]; out[1] = k[1]; out[2] = k[2]; }
        out[3] = q[10];
        break;
    }
    default:
        memcpy(out, t, 4 * sizeof(float));
    }
}

/* The recoloured copy of `src` for the current (CPU) effect and colour. */
static G3Tex *variant(G3Tex *src, const float *col) {
    int effect = S.effect;
    if (src->canvas) return src; /* NOT FAITHFUL: a canvas is GPU-written; drawn plain */
    G3Tex *mask = NULL;
    if (effect == FX_STAT_MASK) {
        mask = tex_get((int)S.p[0]);
        if (mask && mask->canvas) mask = NULL;
    }
    u32 ckey = (effect == FX_LEVEL_FLASH || effect == FX_REGION_MAP) ? rgba32(col[0], col[1], col[2], col[3]) : 0;
    uint32_t mkey = mask ? mask->serial : 0;
    int lru = 0;
    for (int i = 0; i < NVARS; i++) {
        Var *v = &vars[i];
        if (v->tex && v->src == src->serial && v->mask == mkey && v->effect == effect && v->col == ckey
            && !memcmp(v->p, S.p, sizeof(S.p))) {
            v->used = frame_no;
            return v->tex;
        }
        if (vars[i].used < vars[lru].used) lru = i;
    }
    for (int i = 0; i < NVARS; i++) if (!vars[i].tex) { lru = i; break; }
    Var *v = &vars[lru];
    if (v->tex) tex_retire(v->tex);
    v->tex = NULL;
    int w = src->w, h = src->h;
    uint8_t *px = (uint8_t *)malloc((size_t)w * h * 4);
    if (!px) return src;
    float c[4];
    if (ckey) memcpy(c, col, sizeof(c)); else c[0] = c[1] = c[2] = c[3] = 1;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            float t[4], o[4];
            int disc = 0;
            float tu = (x + 0.5f) / w, tv = (y + 0.5f) / h;
            if (effect == FX_MOSAIC) {
                /* params texSize w h, block: the block's corner texel */
                float bw = S.p[0], bh = S.p[1], b = S.p[2] > 0 ? S.p[2] : 1;
                float mx = floorf(tu * bw / b) * b, my = floorf(tv * bh / b) * b;
                tex_sample(src, (mx + 0.5f) / bw, (my + 0.5f) / bh, o);
            } else {
                tex_texel(src, x, y, t);
                fx_pixel_cpu(effect, t, c, S.p, tu, tv, mask, o, &disc);
            }
            uint8_t *d = px + ((size_t)y * w + x) * 4;
            if (disc) { d[0] = d[1] = d[2] = d[3] = 0; continue; }
            u32 q = rgba32(o[0], o[1], o[2], o[3]);
            d[0] = q & 255; d[1] = (q >> 8) & 255; d[2] = (q >> 16) & 255; d[3] = q >> 24;
        }
    }
    G3Tex *t = tex_alloc(w, h, src->repeat, 0);
    if (t) { tex_fill(t, px); t->fold = src->fold; t->lw = src->lw; t->lh = src->lh; }
    free(px);
    if (!t) return src;
    v->tex = t;
    v->src = src->serial;
    v->mask = mkey;
    v->effect = effect;
    v->col = ckey;
    memcpy(v->p, S.p, sizeof(S.p));
    v->used = frame_no;
    st_vars++;
    return t;
}

/* ---------------------------------------------------------------- geometry */

/* A polygon vertex: x, y (target pixels), u, v (over the image) */
typedef struct { float a[4]; } PV;
#define PMAX 24

/* Keep the part of `in` where a[k] >= val (sign 1) or a[k] <= val (sign -1). */
static int clip(const PV *in, int n, PV *out, int k, float val, int sign) {
    int m = 0;
    for (int i = 0; i < n; i++) {
        const PV *A = &in[i], *B = &in[(i + 1) % n];
        float da = (A->a[k] - val) * sign, db = (B->a[k] - val) * sign;
        if (da >= 0) { if (m < PMAX) out[m++] = *A; }
        if ((da >= 0) != (db >= 0)) {
            float t = da / (da - db);
            PV p;
            for (int j = 0; j < 4; j++) p.a[j] = A->a[j] + (B->a[j] - A->a[j]) * t;
            p.a[k] = val;
            if (m < PMAX) out[m++] = p;
        }
    }
    return m;
}

/* the current primitive's look */
static G3Tex *P_tex;
static u32 P_col;          /* packed vertex colour (non-band) */
static float P_ua, P_va;   /* u, v scale onto the allocation */
static float P_col_f[4];
static float P_eu, P_ev;    /* the tie-break bias, in uv */

static inline void put_vtx(const PV *p, float du, float dv) {
    Vtx *o = &vbuf[vcur][vn++];
    o->x = p->a[0]; o->y = p->a[1]; o->z = 0.5f;
    memcpy(o->c, &P_col, 4);
    if (S.prog.vc == VC_GBAFX && S.prog.band) {
        float b = 15.0f - fabsf(p->a[1] - (S.prog.bandy + 0.5f));
        b = b < 0 ? 0 : b;
        o->c[0] = (uint8_t)(b / 16.0f * 255.0f + 0.5f);
    }
    /* + 1/100 of a texel down and right: a pixel centre exactly on a
       texel edge (any 1/2^n scale) takes the texel the reference's floor
       takes -- the rows run bottom-up on the GPU, so v's tie went up */
    o->u = (p->a[2] + du) * P_ua + P_eu;
    o->v = 1.0f - (p->a[3] + dv) * P_va - P_ev;
}

static void emit_fan(const PV *p, int n, float du, float dv) {
    if (n < 3) return;
    if (vn + (n - 2) * 3 > VBUF_LIST_VERTS - 6) { vdropped++; return; }
    for (int i = 1; i + 1 < n; i++) {
        put_vtx(&p[0], du, dv);
        put_vtx(&p[i], du, dv);
        put_vtx(&p[i + 1], du, dv);
    }
}

static void emit_poly1(PV *poly, int n);

/* Emit a polygon (3 or 4 vertices) clipped to the scissor and target, split
   into periods when the texture repeats without being a power of two, and
   at the gba_fx band's kinks. A folded texture's polygon is cut at the fold
   row and each part's u, v moved onto its half of the allocation. */
static void emit_poly(PV *poly, int n) {
    if (!P_tex || !P_tex->fold) { emit_poly1(poly, n); return; }
    const G3Tex *t = P_tex;
    float fv = (float)t->fold / t->lh;
    PV a[PMAX], b[PMAX];
    int m = clip(poly, n, a, 3, fv, -1); /* the rows above the fold: the left half */
    for (int i = 0; i < m; i++) {
        a[i].a[2] = a[i].a[2] * t->lw / t->w;
        a[i].a[3] = a[i].a[3] * t->lh / t->h;
    }
    if (m >= 3) emit_poly1(a, m);
    m = clip(poly, n, b, 3, fv, 1);      /* the rows from the fold: the right half */
    for (int i = 0; i < m; i++) {
        b[i].a[2] = (b[i].a[2] * t->lw + t->lw) / t->w;
        b[i].a[3] = (b[i].a[3] * t->lh - t->fold) / t->h;
    }
    if (m >= 3) emit_poly1(b, m);
}

static void emit_poly1(PV *poly, int n) {
    G3Tex *tg = S.target ? S.target : frame_tex;
    float x0 = 0, y0 = 0, x1 = (float)tg->w, y1 = (float)tg->h;
    if (S.sc_on) {
        float sx0 = floorf(S.sc[0]), sy0 = floorf(S.sc[1]);
        float sx1 = floorf(S.sc[0] + S.sc[2]), sy1 = floorf(S.sc[1] + S.sc[3]);
        if (sx0 > x0) x0 = sx0;
        if (sy0 > y0) y0 = sy0;
        if (sx1 < x1) x1 = sx1;
        if (sy1 < y1) y1 = sy1;
        if (x1 <= x0 || y1 <= y0) return;
    }
    float bx0 = 1e30f, by0 = 1e30f, bx1 = -1e30f, by1 = -1e30f;
    float umin = 1e30f, umax = -1e30f, vmin = 1e30f, vmax = -1e30f;
    for (int i = 0; i < n; i++) {
        const float *a = poly[i].a;
        if (a[0] < bx0) bx0 = a[0];
        if (a[0] > bx1) bx1 = a[0];
        if (a[1] < by0) by0 = a[1];
        if (a[1] > by1) by1 = a[1];
        if (a[2] < umin) umin = a[2];
        if (a[2] > umax) umax = a[2];
        if (a[3] < vmin) vmin = a[3];
        if (a[3] > vmax) vmax = a[3];
    }
    if (bx1 <= x0 || by1 <= y0 || bx0 >= x1 || by0 >= y1) return;
    int need_clip = bx0 < x0 || by0 < y0 || bx1 > x1 || by1 > y1;
    int split_u = 0, split_v = 0;
    if (P_tex->repeat && (P_tex->w != P_tex->tw || P_tex->h != P_tex->th)) {
        split_u = umin < 0 || umax > 1;
        split_v = vmin < 0 || vmax > 1;
    }
    int band = S.prog.vc == VC_GBAFX && S.prog.band;
    if (!need_clip && !split_u && !split_v && !band) { emit_fan(poly, n, 0, 0); return; }
    PV a[PMAX], b[PMAX];
    int m = n;
    memcpy(a, poly, sizeof(PV) * n);
    if (need_clip) {
        m = clip(a, m, b, 0, x0, 1);
        m = clip(b, m, a, 0, x1, -1);
        m = clip(a, m, b, 1, y0, 1);
        m = clip(b, m, a, 1, y1, -1);
        if (m < 3) return;
    }
    int ku0 = 0, ku1 = 0, kv0 = 0, kv1 = 0;
    if (split_u) { ku0 = (int)floorf(umin); ku1 = (int)ceilf(umax) - 1; }
    if (split_v) { kv0 = (int)floorf(vmin); kv1 = (int)ceilf(vmax) - 1; }
    if (ku1 - ku0 > 64) ku1 = ku0 + 64;
    if (kv1 - kv0 > 64) kv1 = kv0 + 64;
    float cuts[4];
    int ncut = 0;
    if (band) {
        float c = S.prog.bandy + 0.5f;
        cuts[0] = c - 15; cuts[1] = c; cuts[2] = c + 15;
        ncut = 3;
    }
    for (int ku = ku0; ku <= ku1; ku++) {
        PV pu[PMAX], t1[PMAX];
        int mu = m;
        memcpy(pu, a, sizeof(PV) * m);
        if (split_u) {
            mu = clip(pu, mu, t1, 2, (float)ku, 1);
            mu = clip(t1, mu, pu, 2, (float)(ku + 1), -1);
            if (mu < 3) continue;
        }
        for (int kv = kv0; kv <= kv1; kv++) {
            PV pv[PMAX], t2[PMAX];
            int mv = mu;
            memcpy(pv, pu, sizeof(PV) * mu);
            if (split_v) {
                mv = clip(pv, mv, t2, 3, (float)kv, 1);
                mv = clip(t2, mv, pv, 3, (float)(kv + 1), -1);
                if (mv < 3) continue;
            }
            float du = split_u ? (float)-ku : 0, dv = split_v ? (float)-kv : 0;
            if (!ncut) { emit_fan(pv, mv, du, dv); continue; }
            for (int s = 0; s <= ncut; s++) {
                PV ps[PMAX], t3[PMAX];
                int ms = mv;
                memcpy(ps, pv, sizeof(PV) * mv);
                if (s > 0) { ms = clip(ps, ms, t3, 1, cuts[s - 1], 1); memcpy(ps, t3, sizeof(PV) * ms); }
                if (s < ncut && ms >= 3) { ms = clip(ps, ms, t3, 1, cuts[s], -1); memcpy(ps, t3, sizeof(PV) * ms); }
                if (ms >= 3) emit_fan(ps, ms, du, dv);
            }
        }
    }
}

/* Set up P_* for a primitive drawn with `tex` (NULL = white) in colour `c`. */
static void prim_begin(G3Tex *tex, const float *c) {
    if (!tex) tex = white;
    memcpy(P_col_f, c, sizeof(P_col_f));
    if (S.prog.cpu) tex = variant(tex, c);
    P_tex = tex;
    P_ua = (float)tex->w / tex->tw;
    P_va = (float)tex->h / tex->th;
    P_eu = 0.01f / tex->tw;
    P_ev = 0.01f / tex->th;
    switch (S.prog.vc) {
    case VC_SCALE: P_col = rgba32(c[0] * S.prog.vcscale, c[1] * S.prog.vcscale, c[2] * S.prog.vcscale, c[3]); break;
    case VC_GBAFX: P_col = rgba32(clamp01(S.prog.bldy / 16.0f), 0, 0, c[3]); break;
    case VC_WHITE: P_col = 0xFFFFFFFF; break;
    default: P_col = rgba32(c[0], c[1], c[2], c[3]); break;
    }
    gpu_bind(tex, &S.prog, S.blend, S.serial);
}

static Prog prog_plain;

/* LOVE's clear: the whole target, colour and alpha replaced (no scissor). */
static void clear_target(const float *c) {
    G3Tex *tg = S.target ? S.target : frame_tex;
    State save = S;
    S.sc_on = 0;
    S.prog = prog_plain;
    S.blend = BLEND_REPLACE;
    S.serial = 0xFFFFFFF0u;
    float col[4] = {clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])};
    prim_begin(white, col);
    PV q[4] = {{{0, 0, 0, 0}}, {{(float)tg->w, 0, 1, 0}}, {{(float)tg->w, (float)tg->h, 1, 1}}, {{0, (float)tg->h, 0, 1}}};
    emit_fan(q, 4, 0, 0);
    S = save;
    bound_valid = 0; /* the next primitive re-applies its blend and TEV */
}

static void run_list(const float *f, size_t n) {
    memset(&S, 0, sizeof(S));
    S.blend = BLEND_ALPHA;
    prog_build(&S.prog, FX_NONE, S.p);
    S.serial = 1;
    uint32_t serial = 1;
    select_target(frame_tex);
    size_t i = 0;
    while (i < n) {
        int op = (int)f[i];
        if (op == 1) { /* OP_TARGET */
            if (i + 2 > n) break;
            int id = (int)f[i + 1];
            G3Tex *t = id == 0 ? NULL : tex_get(id);
            if (t && !t->canvas) t = NULL;
            S.target = t;
            select_target(t ? t : frame_tex);
            i += 2;
        } else if (op == 2) { /* OP_CLEAR */
            if (i + 5 > n) break;
            clear_target(f + i + 1);
            i += 5;
        } else if (op == 3) { /* OP_STATE */
            if (i + 24 > n) break;
            int blend = (int)f[i + 1], effect = (int)f[i + 2], np = (int)f[i + 3];
            float p[16];
            for (int k = 0; k < 16; k++) p[k] = k < np ? f[i + 4 + k] : 0;
            const float *sc = f + i + 20;
            if (blend != S.blend || effect != S.effect || memcmp(p, S.p, sizeof(p)) != 0) {
                S.blend = blend;
                S.effect = effect;
                memcpy(S.p, p, sizeof(p));
                prog_build(&S.prog, effect, p);
                S.serial = ++serial;
            }
            S.sc_on = sc[0] >= 0;
            memcpy(S.sc, sc, sizeof(S.sc));
            i += 24;
        } else if (op == 4) { /* OP_QUAD */
            if (i + 18 > n) break;
            const float *q = f + i + 2;
            int id = (int)f[i + 1];
            G3Tex *t = tex_get(id);
            prim_begin(t, q + 12);
            float u0 = q[8], v0 = q[9], u1 = q[10], v1 = q[11];
            PV p[4] = {{{q[0], q[1], u0, v0}}, {{q[2], q[3], u1, v0}}, {{q[4], q[5], u1, v1}}, {{q[6], q[7], u0, v1}}};
            emit_poly(p, 4);
            st_quads++;
            i += 18;
        } else if (op == 6) { /* OP_BATCH: id tex a b c d e f r g b a */
            if (i + 13 > n) break;
            int id = (int)f[i + 1];
            const float *m = f + i + 3;
            G3Batch *b = (id > 0 && id < nbatches) ? &batches[id] : NULL;
            if (b && b->n > 0) {
                G3Tex *t = tex_get((int)f[i + 2]);
                prim_begin(t, f + i + 9);
                const float *q = b->q;
                for (int k = 0; k < b->n; k++, q += 12) {
                    /* a hidden entry (graphics.ts uploadBatch parks it at -1e6) */
                    if (q[0] < -1e5f || q[1] < -1e5f) continue;
                    float u0 = q[8], v0 = q[9], u1 = q[10], v1 = q[11];
                    PV p[4] = {
                        {{m[0] * q[0] + m[2] * q[1] + m[4], m[1] * q[0] + m[3] * q[1] + m[5], u0, v0}},
                        {{m[0] * q[2] + m[2] * q[3] + m[4], m[1] * q[2] + m[3] * q[3] + m[5], u1, v0}},
                        {{m[0] * q[4] + m[2] * q[5] + m[4], m[1] * q[4] + m[3] * q[5] + m[5], u1, v1}},
                        {{m[0] * q[6] + m[2] * q[7] + m[4], m[1] * q[6] + m[3] * q[7] + m[5], u0, v1}},
                    };
                    emit_poly(p, 4);
                }
                st_quads += b->n;
            }
            i += 13;
        } else if (op == 5) { /* OP_TRIS */
            if (i + 6 > n) break;
            int nt = (int)f[i + 1];
            if (i + 6 + (size_t)nt * 6 > n) break;
            prim_begin(NULL, f + i + 2);
            const float *t = f + i + 6;
            for (int k = 0; k < nt; k++, t += 6) {
                PV p[3] = {{{t[0], t[1], 0.5f, 0.5f}}, {{t[2], t[3], 0.5f, 0.5f}}, {{t[4], t[5], 0.5f, 0.5f}}};
                emit_poly(p, 3);
            }
            st_tris += nt;
            i += 6 + (size_t)nt * 6;
        } else {
            g3log("draw list: bad op %d at %u", op, (unsigned)i);
            break;
        }
    }
    flush();
}

static inline double tick_us(void) { return (double)svcGetSystemTick() / 268.111856; }

/* ---------------------------------------------------------------- the shared loop's passes */

/* The vertex layout and buffer of this file's draws (main.rs's cards use the
   same float layout; its terrain does not, hence restore_main). */
static void use_g3_vertices(void) {
    C3D_AttrInfo *ai = C3D_GetAttrInfo();
    AttrInfo_Init(ai);
    AttrInfo_AddLoader(ai, 0, GPU_FLOAT, 3);
    AttrInfo_AddLoader(ai, 1, GPU_UNSIGNED_BYTE, 4);
    AttrInfo_AddLoader(ai, 2, GPU_FLOAT, 2);
    C3D_BufInfo *bi = C3D_GetBufInfo();
    BufInfo_Init(bi);
    BufInfo_Add(bi, vbuf[vcur], sizeof(Vtx), 3, 0x210);
}

/* Back to the state main.rs's passes assume (citro3d-rs's frame defaults
   plus what its render_to sets): depth GREATER/all, no alpha test, alpha
   blend, stage 0 = texture x vertex colour and the rest pass-through, no
   culling, and its i16 terrain vertex layout. */
static void restore_main(void) {
    C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_ALL);
    C3D_AlphaTest(false, GPU_ALWAYS, 0);
    C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA, GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA);
    for (int i = 0; i < 6; i++) C3D_SetTexEnv(i, &prog_plain.env[i]);
    C3D_TexEnvBufUpdate(C3D_Both, 0);
    C3D_CullFace(GPU_CULL_NONE);
    C3D_AttrInfo *ai = C3D_GetAttrInfo();
    AttrInfo_Init(ai);
    AttrInfo_AddLoader(ai, 0, GPU_SHORT, 4);
    AttrInfo_AddLoader(ai, 1, GPU_UNSIGNED_BYTE, 4);
    AttrInfo_AddLoader(ai, 2, GPU_FLOAT, 2);
    bound_valid = 0;
}

static inline void put_raw(float x, float y, float z, u32 col, float u, float v) {
    Vtx *o = &vbuf[vcur][vn++];
    o->x = x; o->y = y; o->z = z;
    memcpy(o->c, &col, 4);
    o->u = u; o->v = v;
}

/* the composite quad's place in this frame's buffer (-1: none yet) */
static int comp_start = -1;

/* The side strips (worldview.ts WorldStrips): 0 off; 1 the colour below
   (a full-screen fade); 2 the frame's first and last columns stretched over
   the strips (a battle transition's wipe, the flash's darkness: whatever
   the guest drew at the frame's edge carries on to the screen's). Set by
   the guest's frame, laid out in g3_frame_offscreen, drawn after the
   composite. */
static int strip_mode;
static float strip_col[4];
static int strip_start = -1;

void g3_strips_set(int mode, float r, float g, float b, float a) {
    strip_mode = (mode == 1 || mode == 2) ? mode : 0;
    strip_col[0] = clamp01(r); strip_col[1] = clamp01(g); strip_col[2] = clamp01(b); strip_col[3] = clamp01(a);
}

/* First in the frame (inside citro3d-rs's frame, before the eyes): the
   newest list (if one came since the last frame) into the frame target and
   its canvases; then the composite quad for the eyes to draw. */
void g3_frame_offscreen(void) {
    double t0 = tick_us();
    frame_no++;
    retire_tick();
    if (frame_tex->fresh) { C3D_RenderTargetClear(frame_tex->rt, C3D_CLEAR_COLOR, 0, 0); frame_tex->fresh = 0; }
    /* (texture ids are never reused, so the table only grows: walked only
       while a new canvas waits for its clear) */
    for (int i = 1; tex_fresh_n > 0 && i < ntexs; i++) {
        G3Tex *t = texs[i];
        if (t && t->fresh) { C3D_RenderTargetClear(t->rt, C3D_CLEAR_COLOR, 0, 0); t->fresh = 0; tex_fresh_n--; }
    }
    vcur ^= 1;
    vn = vstart = 0;
    if (list_new) {
        C3D_BindProgram(&prog);
        use_g3_vertices();
        C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_uvx, 1.0f, 1.0f, 0.0f, 0.0f);
        C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_toff, 0.0f, 0.0f, 0.0f, 0.0f);
        C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
        C3D_CullFace(GPU_CULL_NONE);
        bound_valid = 0;
        run_list(list, list_n);
        list_new = 0;
        st_lists++;
        flush();
        restore_main();
    }
    /* the 240x160 frame at 1.5x, centred on the 400x240 screen; a texture's
       first row is v = 1 (see the top of this file) */
    comp_start = vn;
    {
        float u1 = (float)frame_tex->w / frame_tex->tw, v1 = 1.0f - (float)frame_tex->h / frame_tex->th;
        u32 c = 0xFFFFFFFFu;
        put_raw(20, 0, 0.5f, c, 0, 1);   put_raw(380, 0, 0.5f, c, u1, 1);    put_raw(380, 240, 0.5f, c, u1, v1);
        put_raw(20, 0, 0.5f, c, 0, 1);   put_raw(380, 240, 0.5f, c, u1, v1); put_raw(20, 240, 0.5f, c, 0, v1);
        /* the strips: 0..20 and 380..400, from the frame's edge texels or a
           colour (premultiplied, as the frame is) over the white texture */
        strip_start = -1;
        if (strip_mode) {
            float ul, ur;
            u32 sc = 0xFFFFFFFFu;
            if (strip_mode == 2) {
                ul = 0.5f / frame_tex->tw;
                ur = ((float)frame_tex->w - 0.5f) / frame_tex->tw;
            } else {
                float a = strip_col[3];
                sc = rgba32(strip_col[0] * a, strip_col[1] * a, strip_col[2] * a, a);
                ul = ur = 0.5f;
                v1 = 0.5f;
            }
            float vt = strip_mode == 2 ? 1.0f : 0.5f;
            strip_start = vn;
            put_raw(0, 0, 0.5f, sc, ul, vt);   put_raw(20, 0, 0.5f, sc, ul, vt);    put_raw(20, 240, 0.5f, sc, ul, v1);
            put_raw(0, 0, 0.5f, sc, ul, vt);   put_raw(20, 240, 0.5f, sc, ul, v1);  put_raw(0, 240, 0.5f, sc, ul, v1);
            put_raw(380, 0, 0.5f, sc, ur, vt); put_raw(400, 0, 0.5f, sc, ur, vt);   put_raw(400, 240, 0.5f, sc, ur, v1);
            put_raw(380, 0, 0.5f, sc, ur, vt); put_raw(400, 240, 0.5f, sc, ur, v1); put_raw(380, 240, 0.5f, sc, ur, v1);
        }
    }
    vstart = vn;
    st_verts += vn;
    st_frames++;
    st_build_us += tick_us() - t0;
}

/* Last in each eye's pass: the frame over the screen. The frame holds
   colour already multiplied by its alpha (drawn with alpha blending over a
   clear of 0), so it goes on premultiplied. */
/* The GPU command buffer: words used so far this frame, and its size
   (gen3/mod.rs warns past three quarters). */
int g3_cmd_used(int *size) {
    u32 *addr; u32 sz = 0, off = 0;
    GPUCMD_GetBuffer(&addr, &sz, &off);
    if (size) *size = (int)sz;
    return (int)off;
}

void g3_composite(void) {
    if (comp_start < 0) return;
    use_g3_vertices();
    C3D_Mtx m;
    Mtx_OrthoTilt(&m, 0.0f, 400.0f, 240.0f, 0.0f, -1.0f, 1.0f, true);
    C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, loc_proj, &m);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_uvx, 1.0f, 1.0f, 0.0f, 0.0f);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_toff, 0.0f, 0.0f, 0.0f, 0.0f);
    C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
    C3D_AlphaTest(false, GPU_ALWAYS, 0);
    C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA, GPU_ONE, GPU_ONE_MINUS_SRC_ALPHA);
    for (int i = 0; i < 6; i++) C3D_SetTexEnv(i, &prog_plain.env[i]);
    C3D_TexEnvBufUpdate(C3D_Both, 0);
    C3D_TexBind(0, &frame_tex->tex);
    C3D_DrawArrays(GPU_TRIANGLES, comp_start, 6);
    st_calls++;
    if (strip_start >= 0) {
        if (strip_mode != 2) C3D_TexBind(0, &white->tex);
        C3D_DrawArrays(GPU_TRIANGLES, strip_start, 12);
        st_calls++;
    }
    restore_main();
}

/* ---------------------------------------------------------------- billboards */

/* The guest's billboards (g3Ents, worldview.ts): records of G3_ENT_FLOATS
   floats -- texture id, feet x, feet z, lift, width, height, u0 v0 u1 v1
   (over the image, v down), alpha, kind, param -- kept until the next call.
   gen3/mod.rs reads them, lays each out (a card facing the camera, a decal
   on the floor or on a facade) and hands back the quads. */
#define G3_ENTS_MAX 96
#define G3_ENT_FLOATS 13
static float ents[G3_ENTS_MAX * G3_ENT_FLOATS];
static int nents;

void g3_ents_set(const float *f, int n) {
    if (n < 0) n = 0;
    if (n > G3_ENTS_MAX) n = G3_ENTS_MAX;
    if (n) memcpy(ents, f, sizeof(float) * G3_ENT_FLOATS * (size_t)n);
    nents = n;
}

const float *g3_ents_get(int *n) { *n = nents; return ents; }

typedef struct { G3Tex *tex; int start; } BbRun;
static BbRun bb_runs[G3_ENTS_MAX];
static int nbb;

void g3_bb_reset(void) { nbb = 0; }

/* One billboard: corners bottom-left, bottom-right, top-right, top-left
   (xyz, terrain space), the frame's uv over the image (u0 > u1 mirrors). */
void g3_bb_quad(int texid, const float *p, float u0, float v0, float u1, float v1, float alpha) {
    G3Tex *t = tex_get(texid);
    if (!t || t->canvas || nbb >= G3_ENTS_MAX || vn + 6 > VBUF_VERTS) return;
    float ua = (float)t->w / t->tw, va = (float)t->h / t->th;
    const float uu[4] = {u0, u1, u1, u0}, vv[4] = {v1, v1, v0, v0};
    static const int order[6] = {0, 1, 2, 0, 2, 3};
    u32 col = 0x00FFFFFFu | ((u32)(clamp01(alpha) * 255.0f + 0.5f) << 24);
    bb_runs[nbb].tex = t;
    bb_runs[nbb].start = vn;
    for (int i = 0; i < 6; i++) {
        int k = order[i];
        put_raw(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], col, uu[k] * ua, 1.0f - vv[k] * va);
    }
    nbb++;
}

/* In each eye's world pass (after the terrain and trees, depth on): the
   billboards under that eye's matrix, their clear texels cut by the alpha
   test so they hide nothing behind them. */
void g3_bb_draw(const C3D_Mtx *mvp) {
    if (nbb == 0) return;
    use_g3_vertices();
    C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, loc_proj, mvp);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_uvx, 1.0f, 1.0f, 0.0f, 0.0f);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_toff, 0.0f, 0.0f, 0.0f, 0.0f);
    C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_ALL);
    C3D_AlphaTest(true, GPU_GREATER, 0x7F);
    for (int i = 0; i < 6; i++) C3D_SetTexEnv(i, &prog_plain.env[i]);
    C3D_TexEnvBufUpdate(C3D_Both, 0);
    for (int i = 0; i < nbb; i++) {
        C3D_TexBind(0, &bb_runs[i].tex->tex);
        C3D_DrawArrays(GPU_TRIANGLES, bb_runs[i].start, 6);
        st_calls++;
    }
    restore_main();
}

/* The perf line's numbers since the last call: frames, lists, quads, tris,
   draw calls, vertices, variants made, build ms (avg), GPU ms (last). */
void g3_perf(float *out) {
    out[0] = (float)st_frames;
    out[1] = (float)st_lists;
    out[2] = (float)st_quads;
    out[3] = (float)st_tris;
    out[4] = (float)st_calls;
    out[5] = (float)st_verts;
    out[6] = (float)st_vars;
    out[7] = st_frames ? (float)(st_build_us / 1000.0 / st_frames) : 0;
    out[8] = C3D_GetDrawingTime();
    out[9] = (float)vdropped;
    st_frames = st_lists = st_quads = st_tris = st_calls = st_verts = st_vars = 0;
    st_build_us = 0;
}

/* The frame as the guest drew it (240x160), as a PPM at `path`. */
int g3_shot(const char *path) {
    C3D_FrameSync();
    /* the frame lives in VRAM: a raw GX copy into linear memory first */
    G3Tex copy = *frame_tex;
    void *lin = linearAlloc(256 * 256 * 4);
    if (!lin) return 0;
    GSPGPU_FlushDataCache(lin, 256 * 256 * 4);
    C3D_SyncTextureCopy((u32 *)frame_tex->tex.data, 0, (u32 *)lin, 0, 256 * 256 * 4, 8);
    GSPGPU_InvalidateDataCache(lin, 256 * 256 * 4);
    copy.tex.data = lin;
    FILE *f = fopen(path, "wb");
    if (!f) { linearFree(lin); return 0; }
    fprintf(f, "P6\n%d %d\n255\n", frame_tex->w, frame_tex->h);
    uint8_t *row = (uint8_t *)malloc((size_t)frame_tex->w * 3);
    for (int y = 0; y < frame_tex->h && row; y++) {
        for (int x = 0; x < frame_tex->w; x++) {
            float t[4];
            tex_texel(&copy, x, y, t);
            row[x * 3] = (uint8_t)(t[0] * 255 + 0.5f);
            row[x * 3 + 1] = (uint8_t)(t[1] * 255 + 0.5f);
            row[x * 3 + 2] = (uint8_t)(t[2] * 255 + 0.5f);
        }
        fwrite(row, 1, (size_t)frame_tex->w * 3, f);
    }
    free(row);
    fclose(f);
    linearFree(lin);
    return 1;
}

__attribute__((constructor)) static void g3_render_ctor(void) {
    /* prog_plain: the default modulate, built without touching the GPU */
    memset(&prog_plain, 0, sizeof(prog_plain));
    for (int i = 0; i < 6; i++) C3D_TexEnvInit(&prog_plain.env[i]);
    s_modulate(&prog_plain.env[0]);
    prog_plain.vc = VC_PLAIN;
}
