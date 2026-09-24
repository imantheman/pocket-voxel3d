// The CABLE CLUB link: two players, one session, whatever carries the bytes.
//
// The ROM does this over a cable at 8192 Hz with one side clocking the other.
// Nothing here cares: a session is a byte-frame pipe plus a state machine, and
// what the pipe IS gets handed in. That is what lets the whole protocol be
// driven by two VoxelmonGames in one test process (LoopbackLink below) before
// a radio exists, and lets the radio slot underneath later without the
// protocol noticing (world/script.ts link_* verbs -> game.ts -> voxel.link*).
//
// Framing is one byte of kind and then the payload, because the transport is
// message-oriented on every carrier this will have: UDS hands over datagrams,
// and the loopback is a queue of them. The ROM's byte-at-a-time handshake is
// a property of a wire we do not have.

/** What a carrier has to do. Datagrams, not a stream: no partial frames. */
export interface LinkTransport {
  /** Hand one frame to the peer. */
  send(frame: Uint8Array): void;
  /** The next frame from the peer, or null when there is none waiting. */
  recv(): Uint8Array | null;
  /** True once the other end is actually there. */
  connected(): boolean;
  close(): void;
}

/**
 * The two rooms, and where the local player stands in each.
 *
 * Neither map has a warp of its own -- the ROM walks you in from the
 * receptionist's desk and walks you back out -- so the entry is scripted.
 * The opponent object the maps already carry sits at cell (2,2), so the
 * player goes in below it, facing across.
 */
export const LINK_ROOM_ENTRY = [
  { map: "TRADE_CENTER", x: 2, y: 4, facing: "up" },
  { map: "COLOSSEUM", x: 2, y: 4, facing: "up" },
] as const;

/** Frames the receptionist will hold the link open waiting for a peer. */
export const LINK_WAIT_FRAMES = 60 * 20;

/** Frame kinds. The wire is ours, so these are ours. */
export const LINK_MSG = {
  /** version + player name: the first thing either side says. */
  hello: 1,
  /** which room this side wants (LINK_ROOM). */
  room: 2,
  /** back out before the room opens. */
  cancel: 3,
} as const;

export const LINK_ROOM = { trade: 0, colosseum: 1 } as const;
export type LinkRoom = (typeof LINK_ROOM)[keyof typeof LINK_ROOM];

/** Bumped when a frame's meaning changes; a mismatch refuses the link. */
export const LINK_VERSION = 1;

export type LinkState =
  /** No session. */
  | "idle"
  /** Open, nobody on the other end yet. */
  | "waiting"
  /** Both sides said hello: names known, room not agreed. */
  | "linked"
  /** Both sides asked for the same room. */
  | "ready"
  /** Someone backed out, or the carrier dropped. */
  | "closed";

const MAX_NAME = 10;

function encodeHello(name: string): Uint8Array {
  const n = [...name].slice(0, MAX_NAME);
  const out = new Uint8Array(2 + n.length);
  out[0] = LINK_MSG.hello;
  out[1] = LINK_VERSION;
  // The ROM's name charset is its own; these are the guest's own bytes going
  // to another copy of the guest, so the code unit's low byte is enough.
  for (let i = 0; i < n.length; i++) out[2 + i] = n[i]!.charCodeAt(0) & 0xff;
  return out;
}

function decodeName(frame: Uint8Array): string {
  let s = "";
  for (let i = 2; i < frame.length; i++) s += String.fromCharCode(frame[i]!);
  return s;
}

/**
 * One side of a link.
 *
 * `poll()` is the whole engine: it is called once a frame, drains whatever
 * arrived and moves the state on. Nothing here blocks, because the overworld
 * cannot block -- the receptionist's script waits by polling too.
 */
export class LinkSession {
  state: LinkState = "idle";
  /** The other player's name, once they have said hello. */
  peerName = "";
  /** The room this side asked for, and the one the peer asked for. */
  myRoom: LinkRoom | null = null;
  peerRoom: LinkRoom | null = null;

  private helloSent = false;

  constructor(
    private transport: LinkTransport,
    private myName: string,
  ) {}

  open(): void {
    if (this.state === "idle") this.state = "waiting";
  }

  /** Ask for a room. Both sides have to ask for the same one. */
  chooseRoom(room: LinkRoom): void {
    this.myRoom = room;
    const f = new Uint8Array([LINK_MSG.room, room]);
    this.transport.send(f);
  }

  /** Back out; the peer hears about it. */
  cancel(): void {
    if (this.state !== "closed") this.transport.send(new Uint8Array([LINK_MSG.cancel]));
    this.close();
  }

  close(): void {
    this.state = "closed";
    this.transport.close();
  }

  /** The room both sides agreed on, or null while they have not. */
  agreedRoom(): LinkRoom | null {
    if (this.myRoom === null || this.peerRoom === null) return null;
    return this.myRoom === this.peerRoom ? this.myRoom : null;
  }

  poll(): LinkState {
    if (this.state === "idle" || this.state === "closed") return this.state;

    // Say hello as soon as there is someone to say it to, once.
    if (!this.helloSent && this.transport.connected()) {
      this.transport.send(encodeHello(this.myName));
      this.helloSent = true;
    }

    for (;;) {
      const f = this.transport.recv();
      if (!f || f.length === 0) break;
      switch (f[0]) {
        case LINK_MSG.hello:
          // A peer on a different build is refused rather than half-understood.
          if (f[1] !== LINK_VERSION) {
            this.close();
            return this.state;
          }
          this.peerName = decodeName(f);
          if (this.state === "waiting") this.state = "linked";
          break;
        case LINK_MSG.room:
          this.peerRoom = (f[1] ?? 0) as LinkRoom;
          break;
        case LINK_MSG.cancel:
          this.close();
          return this.state;
        default:
          break; // a kind this build does not know: ignore it, do not die
      }
    }

    if (this.state === "linked" && this.agreedRoom() !== null) this.state = "ready";
    return this.state;
  }
}

/**
 * Two transports wired to each other in one process.
 *
 * This is how the protocol is tested -- two whole VoxelmonGames trading with
 * each other inside `bun test` -- and it is also a real carrier for any host
 * that can run both sides, so it is not test-only scaffolding.
 */
export class LoopbackLink {
  readonly a: LinkTransport;
  readonly b: LinkTransport;

  constructor() {
    const toA: Uint8Array[] = [];
    const toB: Uint8Array[] = [];
    let open = true;
    const make = (outbox: Uint8Array[], inbox: Uint8Array[]): LinkTransport => ({
      send: (f) => { if (open) outbox.push(f); },
      recv: () => inbox.shift() ?? null,
      connected: () => open,
      close: () => { open = false; },
    });
    this.a = make(toB, toA);
    this.b = make(toA, toB);
  }
}

/**
 * The carrier the 3DS host provides (world/link UDS shim), reached through
 * the same `voxel.*` natives the save and the gamedata come through.
 *
 * Absent on a host without a radio -- `available()` is false there, and the
 * receptionist says what the ROM says when nobody is on the other end.
 */
export function hostTransport(): LinkTransport | null {
  const v = (globalThis as { voxel?: Record<string, unknown> }).voxel;
  if (!v || typeof v.linkOpen !== "function") return null;
  const call = (name: string, arg?: unknown): unknown =>
    (v[name] as (a?: unknown) => unknown)(arg);
  call("linkOpen");
  return {
    send: (f) => { call("linkSend", f); },
    recv: () => {
      const r = call("linkRecv");
      return r instanceof Uint8Array && r.length > 0 ? r : null;
    },
    connected: () => call("linkState") === 1,
    close: () => { call("linkClose"); },
  };
}
