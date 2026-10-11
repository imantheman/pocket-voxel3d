
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

/* ---- The GPU watch (main.rs vc::begin_frame_watched, vc::pass) ----
   citro3d submits each frame through one GX command queue, the first member
   of its context (__C3D_Context; citro3d's internal.h). These let the host
   begin a frame without blocking, so a GPU that never finishes the last one
   is written to the log instead of freezing the console in silence, and
   let a traced frame be cut into its passes, each run and waited for alone,
   so the log names the pass the GPU stopped in. */
extern unsigned char __C3D_Context[];
extern u32 __ctru_linear_heap;
extern u32 __ctru_linear_heap_size;
static gxCmdQueue_s *c3d_queue(void) { return (gxCmdQueue_s *)(void *)__C3D_Context; }

/* C3D_FrameBegin without the wait: 1 begun, 0 the GPU is still on the last
   frame. The caller does the vblank pacing (C3D_FrameSync) itself. */
int c3d_frame_begin_nb(void) {
    return C3D_FrameBegin(C3D_FRAME_NONBLOCK) ? 1 : 0;
}

/* Entries left in the queue (a full queue is a svcBreak in gxCmdQueueAdd). */
int c3d_queue_room(void) {
    gxCmdQueue_s *q = c3d_queue();
    return (int)q->maxEntries - (int)q->numEntries;
}

/* Mid-frame: close the command list built so far, flush the CPU's writes
   the way C3D_FrameEnd does (the whole linear heap), and start the GPU on
   everything queued. 0, and nothing done, when the queue lacks the room
   the rest of the frame needs. */
int c3d_split_and_run(int keep) {
    if (c3d_queue_room() < keep) return 0;
    C3D_FrameSplit(GX_CMDLIST_FLUSH);
    GSPGPU_FlushDataCache((const void *)__ctru_linear_heap, __ctru_linear_heap_size);
    gxCmdQueueRun(c3d_queue());
    return 1;
}

/* After a pass has finished: stop the queue again, so what the rest of the
   frame adds waits for C3D_FrameEnd (which flushes before it runs them)
   instead of starting the moment it is added. */
void c3d_queue_stop(void) {
    gxCmdQueueStop(c3d_queue());
}

/* 1 when the GPU has finished everything queued (no wait). */
int c3d_queue_done(void) {
    return gxCmdQueueWait(c3d_queue(), 0) ? 1 : 0;
}

/* Where the GPU may read: 1 when [p, p+len) lies in the linear heap or
   VRAM and has a physical address. */
int c3d_gpu_readable(const void *p, u32 len) {
    u32 a = (u32)p;
    if (osConvertVirtToPhys(p) == 0) return 0;
    if (len && osConvertVirtToPhys((const void *)(a + len - 1)) == 0) return 0;
    u32 lin = __ctru_linear_heap, linn = __ctru_linear_heap_size;
    if (a >= lin && a + len <= lin + linn) return 1;
    if (a >= 0x1F000000u && a + len <= 0x1F600000u) return 1;
    return 0;
}

/* ---- GPU-done recovery (gpuwatch::begin_frame_watched) ----
   The queue entry the GPU is on: the first one not yet signalled finished
   (lastEntry). Its GX command type (1 command list, 2 memory fill,
   3 display transfer, 4 texture copy, 5 cache flush) in *type; -1 when
   every entry has been signalled. */
int c3d_queue_pending(int *type, int *left) {
    gxCmdQueue_s *q = c3d_queue();
    *left = (int)q->numEntries - (int)q->lastEntry;
    if (q->lastEntry >= q->numEntries) { *type = 0; return -1; }
    *type = (int)(q->entries[q->lastEntry].data[0] & 0xFF);
    return (int)q->lastEntry;
}

/* The GPU's own registers (GSPGPU_ReadHWRegs, offsets from 0x1EB00000;
   the GPU block is 0x10400000 physical, offset 0x400000):
   [0] 0x1040001C memory fill 0 control (bit 0: running)
   [1] 0x1040002C memory fill 1 control (bit 0: running)
   [2] 0x10400034 status
   [3] 0x10400C18 transfer engine control (bit 0: running)
   [4] 0x104018E0 command list size   [5] 0x104018E8 command list address
   [6] 0x104018F0 command list jump
   0 on success, else the GSP result. */
int c3d_gpu_regs(u32 *out) {
    static const u32 at[7] = { 0x40001C, 0x40002C, 0x400034, 0x400C18, 0x4018E0, 0x4018E8, 0x4018F0 };
    int rc = 0;
    for (int i = 0; i < 7; i++) {
        out[i] = 0xFFFFFFFFu;
        Result r = GSPGPU_ReadHWRegs(at[i], &out[i], 4);
        if (R_FAILED(r)) rc = (int)r;
    }
    return rc;
}

/* What libctru's GSP event thread does when the GPU says an entry is done
   (gxqueue.c): count it finished and submit the next. For a completion
   signal that never arrived. */
void gxCmdQueueInterrupt(GSPGPU_Event irq);
void c3d_queue_signal(int type) {
    GSPGPU_Event ev = type == 1 ? GSPGPU_EVENT_P3D
                    : type == 2 ? GSPGPU_EVENT_PSC0
                    : GSPGPU_EVENT_PPF;
    gxCmdQueueInterrupt(ev);
}
