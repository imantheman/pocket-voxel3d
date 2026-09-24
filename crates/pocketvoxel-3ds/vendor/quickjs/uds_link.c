/* The CABLE CLUB's radio: 3DS local wireless under world/link.ts.
 *
 * The guest's link session does not know what carries its frames (see
 * world/link.ts); this is the carrier on hardware. UDS is the 3DS's own
 * local-wireless service, the one retail games use for download play and
 * local multiplayer, and libctru exposes all of it.
 *
 * There is no lobby and no "host or join" prompt, because the Cable Club
 * does not have one: you walk up to the desk and either somebody else is
 * there or they are not. So open() scans first, joins whatever it finds,
 * and only creates a network when it finds nothing. Two consoles that both
 * walk up end with the earlier one hosting, and neither player is asked a
 * question the ROM never asked.
 *
 * Frames are handed over as bytes and come back as bytes; everything above
 * this file treats them as opaque. They are ASCII by construction on the
 * guest side (world/link.ts asciiJson), which is what lets voxel_shim.c
 * carry them as JS strings the way saveData already does.
 */

#include <3ds.h>
#include <stdlib.h>
#include <string.h>

/* 'PVox'. A wlancommID is per-application: this keeps the scan from finding
   retail networks, and keeps retail scans from finding this one. */
#define PV_WLANCOMMID   0x50566F78
#define PV_ID8          1
#define PV_CHANNEL      1
#define PV_MAXNODES     2
#define PV_PASSPHRASE   "pocket-voxel-cable-club-v1"

/* Bigger than any frame the guest builds: a party mon as ASCII JSON runs to
   a few hundred bytes and UDS_DATAFRAME_MAXSIZE is 0x5C6. */
#define PV_FRAME_MAX    1400

enum { PV_CLOSED = 0, PV_READY = 1, PV_HOSTING = 2 };

static int g_inited;
static int g_state;
static int g_is_host;
static udsBindContext g_bind;
static udsNetworkStruct g_net;

static void pv_teardown(void) {
    if (!g_inited) return;
    udsUnbind(&g_bind);
    if (g_is_host) udsDestroyNetwork(); else udsDisconnectNetwork();
    udsExit();
    g_inited = 0;
    g_state = PV_CLOSED;
    g_is_host = 0;
}

/* Scan, join what is there, host when nothing is. Returns the state. */
int pv_link_open(void) {
    if (g_inited) return g_state;

    /* 0x3000 of shared memory is the usual figure for a two-node session. */
    if (R_FAILED(udsInit(0x3000, NULL))) return PV_CLOSED;
    g_inited = 1;
    g_state = PV_CLOSED;

    size_t scan_size = 0x4000;
    u8 *scanbuf = (u8 *)malloc(scan_size);
    if (scanbuf) {
        udsNetworkScanInfo *nets = NULL;
        size_t total = 0;
        if (R_SUCCEEDED(udsScanBeacons(scanbuf, scan_size, &nets, &total,
                                       PV_WLANCOMMID, PV_ID8, NULL, false))
            && nets && total > 0) {
            if (R_SUCCEEDED(udsConnectNetwork(&nets[0].network,
                    PV_PASSPHRASE, strlen(PV_PASSPHRASE), &g_bind,
                    UDS_BROADCAST_NETWORKNODEID, UDSCONTYPE_Client,
                    PV_CHANNEL, UDS_DEFAULT_RECVBUFSIZE))) {
                g_is_host = 0;
                g_state = PV_READY;   /* joining means the host is already there */
            }
        }
        if (nets) free(nets);
        free(scanbuf);
    }

    if (g_state == PV_CLOSED) {
        udsGenerateDefaultNetworkStruct(&g_net, PV_WLANCOMMID, PV_ID8, PV_MAXNODES);
        if (R_SUCCEEDED(udsCreateNetwork(&g_net, PV_PASSPHRASE, strlen(PV_PASSPHRASE),
                                         &g_bind, PV_CHANNEL, UDS_DEFAULT_RECVBUFSIZE))) {
            g_is_host = 1;
            g_state = PV_HOSTING; /* up, but nobody has walked up yet */
        } else {
            udsExit();
            g_inited = 0;
        }
    }
    return g_state;
}

/* 1 once there is somebody on the other end, 0 otherwise. The host does not
   know that until a client joins, which is the receptionist's whole wait. */
int pv_link_state(void) {
    if (!g_inited) return 0;
    if (g_is_host && g_state == PV_HOSTING) {
        udsConnectionStatus st;
        if (R_SUCCEEDED(udsGetConnectionStatus(&st)) && st.total_nodes > 1) {
            g_state = PV_READY;
        }
    }
    return g_state == PV_READY ? 1 : 0;
}

int pv_link_send(const char *buf, int len) {
    if (!g_inited || len <= 0 || len > PV_FRAME_MAX) return 0;
    /* Broadcast: with two nodes there is exactly one other ear, and this
       works the same whether this console is the host or the client. */
    return R_SUCCEEDED(udsSendTo(UDS_BROADCAST_NETWORKNODEID, PV_CHANNEL,
                                 UDS_SENDFLAG_Default, buf, (size_t)len)) ? 1 : 0;
}

/* Copies one frame into `buf` and returns its length, or 0 when none is
   waiting. Never blocks: the guest polls this once a frame. */
int pv_link_recv(char *buf, int cap) {
    if (!g_inited || cap <= 0) return 0;
    size_t got = 0;
    u16 src = 0;
    if (R_FAILED(udsPullPacket(&g_bind, buf, (size_t)cap, &got, &src))) return 0;
    return (int)got;
}

void pv_link_close(void) {
    pv_teardown();
}
