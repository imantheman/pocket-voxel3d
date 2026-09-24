/* The CABLE CLUB's carrier: UDP over the 3DS's IP stack (SOC).
 *
 * This replaced a UDS (802.11 local wireless) carrier, which was the
 * obvious choice and the wrong one for how this actually gets played. UDS
 * is the service retail games use for download play, and an emulator does
 * not put it on the air: Citra's local wireless is its own netplay between
 * Citra instances, so an emulator and a real console can never see each
 * other over it. SOC is different -- the emulator hands it to the host
 * PC's own network stack -- so plain IP sockets link an emulator to a
 * console, a console to a console, and either to a peer on a PC, as long
 * as they share a network.
 *
 * Discovery is a broadcast beacon rather than a lobby, because the Cable
 * Club has no lobby: walk up to the desk and either somebody is there or
 * they are not. A console with no peer yet shouts "PVLINK?" a few times a
 * second; anyone who hears it answers "PVLINK!" and both latch the other's
 * address. Everything after that is frames straight to that address.
 *
 * Frames are opaque here and ASCII by construction above (world/link.ts),
 * which is what lets voxel_shim.c carry them as JS strings.
 */

#include <3ds.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <malloc.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

extern void voxel_log(const char *s, int len);

static void pv_log(const char *fmt, ...) {
    char line[160];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n > 0) voxel_log(line, n > (int)sizeof(line) - 1 ? (int)sizeof(line) - 1 : n);
}

#define PV_PORT        51325
#define PV_ASK         "PVLINK?"
#define PV_ANSWER      "PVLINK!"
#define PV_BEACON_EVERY 20          /* frames between shouts */
#define PV_SOC_ALIGN   0x1000
#define PV_SOC_SIZE    0x100000

enum { PV_CLOSED = 0, PV_READY = 1, PV_SEARCHING = 2 };

static int g_inited;
static int g_sock = -1;
static u32 *g_socbuf;
static int g_have_peer;
static struct sockaddr_in g_peer;
static unsigned g_tick;

static void pv_send_raw(const char *msg, int len, const struct sockaddr_in *to) {
    if (g_sock < 0) return;
    sendto(g_sock, msg, (size_t)len, 0, (const struct sockaddr *)to, sizeof(*to));
}

/* Shout on the global broadcast and on this subnet's own, because a network
   that drops one often passes the other. */
static void pv_beacon(const char *msg) {
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_port = htons(PV_PORT);

    to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    pv_send_raw(msg, (int)strlen(msg), &to);

    u32 me = gethostid();                 /* already network order */
    if (me != 0) {
        to.sin_addr.s_addr = me | htonl(0x000000FF);
        pv_send_raw(msg, (int)strlen(msg), &to);
    }
}

static void pv_latch(const struct sockaddr_in *from) {
    if (g_have_peer) return;
    g_peer = *from;
    g_have_peer = 1;
    pv_log("[pv] link/net: peer at %s", inet_ntoa(from->sin_addr));
}

int pv_net_open(void) {
    if (g_inited) return g_have_peer ? PV_READY : PV_SEARCHING;

    g_socbuf = (u32 *)memalign(PV_SOC_ALIGN, PV_SOC_SIZE);
    if (!g_socbuf) { pv_log("[pv] link/net: no memory for the socket buffer"); return PV_CLOSED; }
    Result rc = socInit(g_socbuf, PV_SOC_SIZE);
    if (R_FAILED(rc)) {
        /* No IP stack: the console is not on a network at all. */
        pv_log("[pv] link/net: socInit failed %08lX (is wifi on?)", (unsigned long)rc);
        free(g_socbuf);
        g_socbuf = NULL;
        return PV_CLOSED;
    }

    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_sock < 0) { pv_log("[pv] link/net: socket() failed"); socExit(); free(g_socbuf); g_socbuf = NULL; return PV_CLOSED; }

    struct sockaddr_in me;
    memset(&me, 0, sizeof(me));
    me.sin_family = AF_INET;
    me.sin_port = htons(PV_PORT);
    me.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(g_sock, (struct sockaddr *)&me, sizeof(me)) < 0) {
        pv_log("[pv] link/net: bind(%d) failed", PV_PORT);
        close(g_sock); g_sock = -1; socExit(); free(g_socbuf); g_socbuf = NULL;
        return PV_CLOSED;
    }
    fcntl(g_sock, F_SETFL, fcntl(g_sock, F_GETFL, 0) | O_NONBLOCK);

    g_inited = 1;
    g_have_peer = 0;
    g_tick = 0;
    pv_log("[pv] link/net: listening on %s:%d, looking for a peer",
           inet_ntoa(*(struct in_addr *)&(u32){ gethostid() }), PV_PORT);
    return PV_SEARCHING;
}

int pv_net_state(void) {
    if (!g_inited) return 0;
    return g_have_peer ? 1 : 0;
}

int pv_net_send(const char *buf, int len) {
    if (!g_inited || !g_have_peer || len <= 0) return 0;
    pv_send_raw(buf, len, &g_peer);
    return 1;
}

/* Drives discovery as well as delivery: the guest polls this every frame,
   so it is the one place guaranteed to run. Returns a frame's length, or 0
   when there is nothing that is not housekeeping. */
int pv_net_recv(char *buf, int cap) {
    if (!g_inited || cap <= 0) return 0;

    if (!g_have_peer && (g_tick++ % PV_BEACON_EVERY) == 0) pv_beacon(PV_ASK);

    for (int i = 0; i < 8; i++) {
        struct sockaddr_in from;
        socklen_t flen = sizeof(from);
        ssize_t n = recvfrom(g_sock, buf, (size_t)cap, 0,
                             (struct sockaddr *)&from, &flen);
        if (n <= 0) return 0;

        /* Our own broadcast coming back: ignore it. */
        if (from.sin_addr.s_addr == (u32)gethostid()) continue;

        if (n == (ssize_t)strlen(PV_ASK) && memcmp(buf, PV_ASK, (size_t)n) == 0) {
            pv_send_raw(PV_ANSWER, (int)strlen(PV_ANSWER), &from);
            pv_latch(&from);
            continue;
        }
        if (n == (ssize_t)strlen(PV_ANSWER) && memcmp(buf, PV_ANSWER, (size_t)n) == 0) {
            pv_latch(&from);
            continue;
        }
        /* Anything else is a frame, and whoever sent one is the peer. */
        pv_latch(&from);
        return (int)n;
    }
    return 0;
}

void pv_net_close(void) {
    if (!g_inited) return;
    if (g_sock >= 0) { close(g_sock); g_sock = -1; }
    socExit();
    if (g_socbuf) { free(g_socbuf); g_socbuf = NULL; }
    g_inited = 0;
    g_have_peer = 0;
}
