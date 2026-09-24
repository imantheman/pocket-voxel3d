
#include <3ds.h>
#include <citro3d.h>

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
