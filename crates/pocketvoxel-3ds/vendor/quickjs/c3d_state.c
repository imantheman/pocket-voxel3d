
#include <3ds.h>
#include <citro3d.h>

void c3d_depth_test(int on) {
    C3D_DepthTest(on ? true : false, GPU_GREATER, GPU_WRITE_ALL);
}
void c3d_alpha_test(int on, int ref) {
    C3D_AlphaTest(on ? true : false, GPU_GREATER, ref);
}
