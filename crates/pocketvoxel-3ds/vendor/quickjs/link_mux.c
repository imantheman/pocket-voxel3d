/* Two carriers, one CABLE CLUB.
 *
 * uds_link.c is 3DS local wireless: console to console with no router and
 * nothing configured, which is what the cable was. net_link.c is UDP over
 * the IP stack: it reaches an emulator, a PC, or anything else willing to
 * speak the protocol, because an emulator hands SOC to the host's real
 * network while putting nothing on the air for UDS to find.
 *
 * Both are kept, but they cannot both run: the 3DS has one wireless module,
 * and bringing up a UDS network puts it into local-wireless mode, which
 * drops the access point SOC is talking through. So this tries the network
 * first and falls back to local wireless only when there is no IP stack to
 * use. That ordering is not a preference about quality, it is the one that
 * works in the most places:
 *
 *   - console and emulator, or console and a PC tool: only the network can
 *     do it, and that is the case a trade-compatibility bridge needs.
 *   - console and console on the same wifi: the network does it.
 *   - console and console with no router at all: nothing answers on the
 *     network, socInit fails or finds nobody, and local wireless takes it.
 *
 * Both consoles run the same build and make the same choice in the same
 * order, so they land on the same carrier without either player being
 * asked a "wireless or internet?" question the ROM never asked.
 */

int pv_uds_open(void);
int pv_uds_state(void);
int pv_uds_send(const char *buf, int len);
int pv_uds_recv(char *buf, int cap);
void pv_uds_close(void);

int pv_net_open(void);
int pv_net_state(void);
int pv_net_send(const char *buf, int len);
int pv_net_recv(char *buf, int cap);
void pv_net_close(void);

extern void voxel_log(const char *s, int len);
static void say(const char *s) { int n = 0; while (s[n]) n++; voxel_log(s, n); }

enum { PV_CLOSED = 0, PV_READY = 1, PV_SEARCHING = 2 };

static int g_open;
static int g_pick;   /* 0 undecided, 1 uds, 2 net */

/* 0 none, 1 local wireless, 2 the network. Fixed at open; see the header. */
static int g_carrier;

int pv_link_open(void) {
    if (g_open) return g_pick ? PV_READY : PV_SEARCHING;

    if (pv_net_open() > 0) {
        g_carrier = 2;
        say("[pv] link: on the network, looking for a peer");
    } else if (pv_uds_open() > 0) {
        g_carrier = 1;
        say("[pv] link: on local wireless, looking for a console");
    } else {
        say("[pv] link: no carrier -- no network and no local wireless");
        return PV_CLOSED;
    }
    g_open = 1;
    g_pick = 0;
    return PV_SEARCHING;
}

static void decide(void) {
    if (g_pick || !g_carrier) return;
    if (g_carrier == 1 ? pv_uds_state() : pv_net_state()) {
        g_pick = g_carrier;
        say(g_carrier == 1 ? "[pv] link: a console answered"
                           : "[pv] link: a peer answered");
    }
}

int pv_link_state(void) {
    if (!g_open) return 0;
    decide();
    return g_pick ? 1 : 0;
}

int pv_link_send(const char *buf, int len) {
    if (!g_open) return 0;
    decide();
    if (!g_pick) return 0;
    return g_carrier == 1 ? pv_uds_send(buf, len) : pv_net_send(buf, len);
}

int pv_link_recv(char *buf, int cap) {
    if (!g_open) return 0;
    /* A carrier's own discovery runs inside its recv, so this has to be
       called every frame whether or not a peer has been found yet. */
    int n = g_carrier == 1 ? pv_uds_recv(buf, cap) : pv_net_recv(buf, cap);
    if (n > 0 && !g_pick) { g_pick = g_carrier; say("[pv] link: a peer answered"); }
    if (n <= 0) decide();
    return n;
}

void pv_link_close(void) {
    if (!g_open) return;
    if (g_carrier == 1) pv_uds_close(); else pv_net_close();
    g_open = 0;
    g_pick = 0;
    g_carrier = 0;
}
