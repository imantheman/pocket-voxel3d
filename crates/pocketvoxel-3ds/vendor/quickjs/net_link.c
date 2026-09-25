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
 * The beacon carries a random tag so a console can tell its own shout
 * coming back from somebody else's, which matters when two emulators sit
 * on one PC and so on one address. For the same reason the port is not
 * fixed: the first free one of a small run is taken, and the shout goes to
 * every port in the run, so two instances on one machine find each other
 * the way two consoles on one wifi do.
 *
 * Frames are opaque here. Delivery and order are NOT promised -- this is
 * UDP -- and the guest's link (world/link.ts ReliableLink) is what makes
 * them so. Frames are ASCII by construction above, which is what lets
 * voxel_shim.c carry them as JS strings.
 */

#include <3ds.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <malloc.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
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

#define PV_PORT         51325
#define PV_PORTS        4            /* 51325..51328: the run one machine may use */
#define PV_ASK          "PVLINK?"
#define PV_ANSWER       "PVLINK!"
#define PV_TAG_LEN      8            /* hex digits after the word */
#define PV_BEACON_EVERY 20           /* frames between shouts */
#define PV_SOC_ALIGN    0x1000
#define PV_SOC_SIZE     0x100000

enum { PV_CLOSED = 0, PV_READY = 1, PV_SEARCHING = 2 };

static int g_inited;
static int g_sock = -1;
static u32 *g_socbuf;
static int g_port;
static int g_have_peer;
static struct sockaddr_in g_peer;
static unsigned g_tick;
static char g_tag[PV_TAG_LEN + 1];

static void pv_send_raw(const char *msg, int len, const struct sockaddr_in *to) {
    if (g_sock < 0) return;
    sendto(g_sock, msg, (size_t)len, 0, (const struct sockaddr *)to, sizeof(*to));
}

/* Shout on the global broadcast and on this subnet's own, because a network
   that drops one often passes the other, and on every port of the run. */
static void pv_beacon(const char *word) {
    char msg[32];
    int len = snprintf(msg, sizeof(msg), "%s%s", word, g_tag);
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    u32 me = gethostid();                 /* already network order */
    for (int p = 0; p < PV_PORTS; p++) {
        to.sin_port = htons((u16)(PV_PORT + p));
        to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
        pv_send_raw(msg, len, &to);
        if (me != 0) {
            to.sin_addr.s_addr = me | htonl(0x000000FF);
            pv_send_raw(msg, len, &to);
        }
        /* And to this machine itself, for a second emulator on it: a host
           that does not hand its own broadcasts back still passes this. */
        to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        pv_send_raw(msg, len, &to);
    }
}

static void pv_answer(const struct sockaddr_in *to) {
    char msg[32];
    int len = snprintf(msg, sizeof(msg), "%s%s", PV_ANSWER, g_tag);
    pv_send_raw(msg, len, to);
}

static void pv_latch(const struct sockaddr_in *from) {
    if (g_have_peer) return;
    g_peer = *from;
    g_have_peer = 1;
    pv_log("[pv] link/net: peer at %s:%d", inet_ntoa(from->sin_addr), ntohs(from->sin_port));
}

/* True for a beacon word followed by a tag; `mine` says whether the tag is
   this console's own shout coming back. */
static int pv_is_word(const char *buf, int n, const char *word, int *mine) {
    int wl = (int)strlen(word);
    if (n != wl + PV_TAG_LEN || memcmp(buf, word, (size_t)wl) != 0) return 0;
    *mine = memcmp(buf + wl, g_tag, PV_TAG_LEN) == 0;
    return 1;
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

    int one = 1;
    setsockopt(g_sock, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
    /* NOT SO_REUSEADDR: the run of ports below relies on a taken port
       refusing the bind. With reuse on, two emulators on one PC both land
       on the first port, unicast between them goes to whichever socket the
       host picks, and a console ends up shaking hands with itself. */

    /* The first free port of the run. */
    g_port = 0;
    for (int p = 0; p < PV_PORTS; p++) {
        struct sockaddr_in me;
        memset(&me, 0, sizeof(me));
        me.sin_family = AF_INET;
        me.sin_port = htons((u16)(PV_PORT + p));
        me.sin_addr.s_addr = htonl(INADDR_ANY);
        if (bind(g_sock, (struct sockaddr *)&me, sizeof(me)) == 0) { g_port = PV_PORT + p; break; }
    }
    if (!g_port) {
        pv_log("[pv] link/net: bind failed on %d..%d", PV_PORT, PV_PORT + PV_PORTS - 1);
        close(g_sock); g_sock = -1; socExit(); free(g_socbuf); g_socbuf = NULL;
        return PV_CLOSED;
    }
    fcntl(g_sock, F_SETFL, fcntl(g_sock, F_GETFL, 0) | O_NONBLOCK);

    /* The tag: whatever entropy is to hand, so two consoles do not match. */
    u32 t = (u32)svcGetSystemTick() ^ ((u32)rand() << 8) ^ (u32)(uintptr_t)g_socbuf;
    snprintf(g_tag, sizeof(g_tag), "%08lX", (unsigned long)t);

    g_inited = 1;
    g_have_peer = 0;
    g_tick = 0;
    pv_log("[pv] link/net: listening on %s:%d as %s, looking for a peer",
           inet_ntoa(*(struct in_addr *)&(u32){ gethostid() }), g_port, g_tag);
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

        int mine = 0;
        if (pv_is_word(buf, (int)n, PV_ASK, &mine)) {
            if (mine) continue;              /* our own shout coming back */
            pv_answer(&from);
            pv_latch(&from);
            continue;
        }
        if (pv_is_word(buf, (int)n, PV_ANSWER, &mine)) {
            if (!mine) pv_latch(&from);
            continue;
        }
        /* Anything else is a frame. Only the peer's count: a third console
           shouting into an open session is not part of it. */
        if (!g_have_peer) { pv_latch(&from); return (int)n; }
        if (from.sin_addr.s_addr != g_peer.sin_addr.s_addr || from.sin_port != g_peer.sin_port) continue;
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
    g_port = 0;
}
