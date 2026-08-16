// ndsp playback for the core's chip synth. The PSP host runs a ring with
// credit events through pocketjs's audio module; the 3DS doesn't have that,
// and doesn't need it — two alternating wave buffers are enough, and the
// host asks how much room is free each tick.
#include <3ds.h>
#include <string.h>

#define NBUF 2

static ndspWaveBuf s_buf[NBUF];
static s16 *s_mem[NBUF];
static int s_next = 0;
static int s_cap = 0;      // frames per buffer
static int s_ready = 0;

int audio3ds_init(int rate, int frames_per_buf) {
    if (s_ready) return 1;
    if (ndspInit() != 0) return 0;
    ndspSetOutputMode(NDSP_OUTPUT_STEREO);
    ndspChnReset(0);
    ndspChnSetInterp(0, NDSP_INTERP_LINEAR);
    ndspChnSetRate(0, (float)rate);
    ndspChnSetFormat(0, NDSP_FORMAT_STEREO_PCM16);

    s_cap = frames_per_buf;
    for (int i = 0; i < NBUF; i++) {
        s_mem[i] = (s16 *)linearAlloc(s_cap * 2 * sizeof(s16));
        if (!s_mem[i]) return 0;
        memset(s_mem[i], 0, s_cap * 2 * sizeof(s16));
        memset(&s_buf[i], 0, sizeof(ndspWaveBuf));
        s_buf[i].data_vaddr = s_mem[i];
        s_buf[i].nsamples = s_cap;
        s_buf[i].status = NDSP_WBUF_DONE;
    }
    s_ready = 1;
    return 1;
}

/** Frames we can accept right now (0 when both buffers are still playing). */
int audio3ds_free_frames(void) {
    if (!s_ready) return 0;
    int free_frames = 0;
    for (int i = 0; i < NBUF; i++) {
        if (s_buf[i].status == NDSP_WBUF_DONE || s_buf[i].status == NDSP_WBUF_FREE) {
            free_frames += s_cap;
        }
    }
    return free_frames;
}

/** Queue interleaved stereo i16. Returns frames accepted. */
int audio3ds_queue(const s16 *pcm, int frames) {
    if (!s_ready || frames <= 0) return 0;
    ndspWaveBuf *wb = &s_buf[s_next];
    if (wb->status != NDSP_WBUF_DONE && wb->status != NDSP_WBUF_FREE) return 0;
    int n = frames > s_cap ? s_cap : frames;
    memcpy(s_mem[s_next], pcm, n * 2 * sizeof(s16));
    DSP_FlushDataCache(s_mem[s_next], n * 2 * sizeof(s16));
    wb->nsamples = n;
    ndspChnWaveBufAdd(0, wb);
    s_next = (s_next + 1) % NBUF;
    return n;
}

void audio3ds_exit(void) {
    if (!s_ready) return;
    ndspChnWaveBufClear(0);
    ndspExit();
    for (int i = 0; i < NBUF; i++) if (s_mem[i]) linearFree(s_mem[i]);
    s_ready = 0;
}
