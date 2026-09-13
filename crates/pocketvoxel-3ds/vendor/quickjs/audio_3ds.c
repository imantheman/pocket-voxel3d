// ndsp playback for the core's chip synth. The PSP host runs a ring with
// credit events through pocketjs's audio module; the 3DS doesn't have that,
// and doesn't need it — two alternating wave buffers are enough, and the
// host asks how much room is free each tick.
#include <3ds.h>
#include <string.h>

// One wave buffer per queued tick. Eight of them is ~130ms of slack at
// 60Hz, which is what lets a frame hitch (a map rebuild, a pak load) pass
// without the channel running dry. Four was not enough: a single long frame
// emptied the queue and you heard the gap.
#define NBUF 8

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

/**
 * Queue interleaved stereo i16. Returns frames accepted.
 *
 * Takes the first FREE buffer, not strictly the next one round-robin. The
 * old version looked only at s_buf[s_next] and returned 0 when that one
 * happened to still be playing -- even with three others sitting idle. The
 * caller has already advanced the synth by then, so a refusal is not a
 * retry, it is a hole punched in the music: the click you hear when a frame
 * runs long. NDSP finishes buffers in the order they were added, so
 * scanning from s_next keeps them in order and only skips ones that are
 * genuinely still in flight.
 */
int audio3ds_queue(const s16 *pcm, int frames) {
    if (!s_ready || frames <= 0) return 0;
    for (int k = 0; k < NBUF; k++) {
        int i = (s_next + k) % NBUF;
        ndspWaveBuf *wb = &s_buf[i];
        if (wb->status != NDSP_WBUF_DONE && wb->status != NDSP_WBUF_FREE) continue;
        int n = frames > s_cap ? s_cap : frames;
        memcpy(s_mem[i], pcm, n * 2 * sizeof(s16));
        DSP_FlushDataCache(s_mem[i], n * 2 * sizeof(s16));
        wb->nsamples = n;
        ndspChnWaveBufAdd(0, wb);
        s_next = (i + 1) % NBUF;
        return n;
    }
    // Every buffer in flight: we are genuinely ahead of the DSP. Dropping is
    // the right answer here (it pulls us back in step) and is not the gap
    // case above -- that one had room and threw the audio away anyway.
    return 0;
}

void audio3ds_exit(void) {
    if (!s_ready) return;
    ndspChnWaveBufClear(0);
    ndspExit();
    for (int i = 0; i < NBUF; i++) if (s_mem[i]) linearFree(s_mem[i]);
    s_ready = 0;
}
