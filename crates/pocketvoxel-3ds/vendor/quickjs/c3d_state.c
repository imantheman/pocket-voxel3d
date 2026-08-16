
#include <3ds.h>
#include <citro3d.h>

void c3d_depth_test(int on) {
    C3D_DepthTest(on ? true : false, GPU_GREATER, GPU_WRITE_ALL);
}
void c3d_alpha_test(int on, int ref) {
    C3D_AlphaTest(on ? true : false, GPU_GREATER, ref);
}


/* Flush a CPU-written buffer so the GPU can't sample stale bytes. The
   emulator doesn't model the data cache, so this only bites on hardware. */
void gsp_flush(const void *p, u32 len) {
    GSPGPU_FlushDataCache(p, len);
}
