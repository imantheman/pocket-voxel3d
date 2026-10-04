
#include <3ds.h>
#include <citro3d.h>
#include <stdlib.h>
#include <string.h>

void c3d_depth_test(int on) {
    C3D_DepthTest(on ? true : false, GPU_GREATER, GPU_WRITE_ALL);
}
void c3d_alpha_test(int on, int ref) {
    C3D_AlphaTest(on ? true : false, GPU_GREATER, ref);
}

/* The PICA's early depth test: reject a fragment against a coarse depth
   buffer BEFORE it is textured and combined, instead of after. It only
   pays when the near geometry is drawn first, which the frame's cull now
   guarantees (draw.rs sorts the survivors near-to-far).

   GREATER, to match c3d_depth_test above: this projection puts the near
   plane at the high end, so a closer fragment has the LARGER depth value.
   Enabling also flags the early buffer for a clear (citro3d effect.c), so
   this is called once per eye pass rather than once at boot. */
void c3d_early_depth(int on) {
    C3D_EarlyDepthTest(on ? true : false, GPU_EARLYDEPTH_GREATER, 0);
}


/* Flush a CPU-written buffer so the GPU can't sample stale bytes. The
   emulator doesn't model the data cache, so this only bites on hardware. */
void gsp_flush(const void *p, u32 len) {
    GSPGPU_FlushDataCache(p, len);
}

/* C3D_RenderTargetClear is static inline (renderqueue.h); TILT SHIFT clears
   its texture target, and the screen after it, through this. */
void c3d_target_clear(C3D_RenderTarget* target, unsigned bits, unsigned colour, unsigned depth) {
    C3D_RenderTargetClear(target, (C3D_ClearBits)bits, colour, depth);
}

/* VIEW 2D's canvas textures (main.rs CanvasTex): raw RGBA5551 textures in
   linear memory the host writes into itself, a changed tile row at a time,
   instead of uploading the whole picture on every change (1 MB at 2D ZOOM
   OUT MAX). `smooth`: linear when the texture shrinks onto the screen;
   `repeat`: wrapped (the map ring) rather than clamped (the people). */
void *c3d_tex_new(int w, int h, int smooth, int repeat) {
    C3D_Tex *t = (C3D_Tex *)malloc(sizeof(C3D_Tex));
    if (!t) return NULL;
    if (!C3D_TexInit(t, (u16)w, (u16)h, GPU_RGBA5551)) { free(t); return NULL; }
    C3D_TexSetFilter(t, GPU_NEAREST, smooth ? GPU_LINEAR : GPU_NEAREST);
    GPU_TEXTURE_WRAP_PARAM wrap = repeat ? GPU_REPEAT : GPU_CLAMP_TO_EDGE;
    C3D_TexSetWrap(t, wrap, wrap);
    memset(t->data, 0, (size_t)w * (size_t)h * 2);
    GSPGPU_FlushDataCache(t->data, (u32)w * (u32)h * 2);
    return t;
}
void *c3d_tex_data(void *t) { return t ? ((C3D_Tex *)t)->data : NULL; }
void c3d_tex_bind(void *t) { if (t) C3D_TexBind(0, (C3D_Tex *)t); }
void c3d_tex_free(void *t) {
    if (!t) return;
    C3D_TexDelete((C3D_Tex *)t);
    free(t);
}
