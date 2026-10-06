/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The world's lean: FireRed's cook stores its
   buildings and prop cards upright and lean-coded (voxelmon/cook/
   gen3terrain.ts, "the lean code"); g3_world.pica leans them for the frame's
   camera. main.rs draws the terrain spans and the tree instances with its
   own program; gen3/mod.rs swaps this one in around those two loops
   (g3_world_on / g3_world_off) and hands it the frame's numbers.

   The two programs share the register layout of projection, uvx and toff
   (g3_world.pica declares them first, in vshader.pica's order), so
   main.rs's uniform binds hold across the swap. This program's own uniforms
   are set after every bind: binding a program reloads its constants, which
   may sit in the registers the other program's uniforms use. */
#include <3ds.h>
#include <citro3d.h>
#include <string.h>
#include <stdlib.h>

static shaderProgram_s p_world, p_main;
static DVLB_s *dv_world, *dv_main;
static int ok, bound;
static int loc_f, loc_c, loc_c2, loc_tint;
/* the frame's numbers (g3_world_params) */
static float u_f[4], u_c[4] = {1, 0, 0, 0}, u_c2[4], u_tint[4] = {1, 1, 1, 1};

static DVLB_s *parse(const uint8_t *shbin, uint32_t len) {
    /* the shader wants its bytes word-aligned, and keeps pointing into them */
    u32 *sh = (u32 *)malloc((len + 3) & ~3u);
    if (!sh) return NULL;
    memcpy(sh, shbin, len);
    return DVLB_ParseFile(sh, len);
}

/* The world program, and a copy of main.rs's (the same bytes as its
   SHADER_BYTES) to put back after. 1 when both are ready. */
int g3_world_init(const uint8_t *wsh, uint32_t wlen, const uint8_t *msh, uint32_t mlen) {
    dv_world = parse(wsh, wlen);
    dv_main = parse(msh, mlen);
    if (!dv_world || !dv_main) return 0;
    shaderProgramInit(&p_world);
    shaderProgramSetVsh(&p_world, &dv_world->DVLE[0]);
    shaderProgramInit(&p_main);
    shaderProgramSetVsh(&p_main, &dv_main->DVLE[0]);
    loc_f = shaderInstanceGetUniformLocation(p_world.vertexShader, "g3f");
    loc_c = shaderInstanceGetUniformLocation(p_world.vertexShader, "g3c");
    loc_c2 = shaderInstanceGetUniformLocation(p_world.vertexShader, "g3c2");
    loc_tint = shaderInstanceGetUniformLocation(p_world.vertexShader, "g3tint");
    if (loc_f < 0 || loc_c < 0 || loc_c2 < 0 || loc_tint < 0) return 0;
    /* projection/uvx/toff must be where main.rs's program has them */
    if (shaderInstanceGetUniformLocation(p_world.vertexShader, "projection") != shaderInstanceGetUniformLocation(p_main.vertexShader, "projection")
        || shaderInstanceGetUniformLocation(p_world.vertexShader, "uvx") != shaderInstanceGetUniformLocation(p_main.vertexShader, "uvx")
        || shaderInstanceGetUniformLocation(p_world.vertexShader, "toff") != shaderInstanceGetUniformLocation(p_main.vertexShader, "toff"))
        return 0;
    ok = 1;
    return 1;
}

/* 16 floats: g3f, g3c, g3c2, g3tint (g3_world.pica). */
void g3_world_params(const float *p) {
    memcpy(u_f, p, sizeof(u_f));
    memcpy(u_c, p + 4, sizeof(u_c));
    memcpy(u_c2, p + 8, sizeof(u_c2));
    memcpy(u_tint, p + 12, sizeof(u_tint));
}

void g3_world_on(void) {
    if (!ok) return;
    C3D_BindProgram(&p_world);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_f, u_f[0], u_f[1], u_f[2], u_f[3]);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_c, u_c[0], u_c[1], u_c[2], u_c[3]);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_c2, u_c2[0], u_c2[1], u_c2[2], u_c2[3]);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, loc_tint, u_tint[0], u_tint[1], u_tint[2], u_tint[3]);
    bound = 1;
}

void g3_world_off(void) {
    if (!bound) return;
    C3D_BindProgram(&p_main);
    bound = 0;
}
