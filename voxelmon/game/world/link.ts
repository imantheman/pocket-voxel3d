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
  /** the mon this side is putting on the table (JSON payload). */
  offer: 4,
  /** yes or no to what is on the table. */
  answer: 5,
} as const;

/**
 * What crosses the wire for one mon.
 *
 * JSON, not the ROM's 44-byte party struct. Both ends are the same build --
 * the hello's version byte has already refused anything else -- so the wire
 * only has to be understood by us, and a shape that can be read in a log
 * beats one that cannot. A binary Gen 1 struct is what a bridge to the
 * Virtual Console would need, and that is a converter at the edge rather
 * than a different wire in the middle.
 */
export interface TradeOffer {
  /** A PartyMon, as sent. Structurally checked on arrival, not trusted. */
  mon: Record<string, unknown>;
  /** Who is sending it, so the receiver can stamp the OT. */
  otName: string;
  otId: number;
}

/** JSON as plain ASCII, so the byte loop below is the whole encoder. */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function encodeJson(kind: number, v: unknown): Uint8Array {
  const s = asciiJson(v);
  const out = new Uint8Array(1 + s.length);
  out[0] = kind;
  for (let i = 0; i < s.length; i++) out[1 + i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeJson(frame: Uint8Array): unknown {
  let s = "";
  for (let i = 1; i < frame.length; i++) s += String.fromCharCode(frame[i]!);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

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

/**
 * hello is [kind][version][name as ASCII JSON].
 *
 * JSON for the name and not the raw characters, because a name can hold
 * glyphs the naming screen offers that are not ASCII, and every frame has
 * to stay ASCII: the 3DS carrier hands frames over as JS strings (the way
 * saveData already does), and a byte over 127 would not survive the trip.
 */
function encodeHello(name: string): Uint8Array {
  const s = asciiJson([...name].slice(0, MAX_NAME).join(""));
  const out = new Uint8Array(2 + s.length);
  out[0] = LINK_MSG.hello;
  out[1] = LINK_VERSION;
  for (let i = 0; i < s.length; i++) out[2 + i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeName(frame: Uint8Array): string {
  let s = "";
  for (let i = 2; i < frame.length; i++) s += String.fromCharCode(frame[i]!);
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "string" ? v : "";
  } catch {
    return s; // a build that sent the name raw
  }
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
  /** What the peer has put on the table, and what they said to ours. */
  peerOffer: TradeOffer | null = null;
  peerAnswer: boolean | null = null;

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

  /** Put a mon on the table. */
  offer(o: TradeOffer): void {
    this.transport.send(encodeJson(LINK_MSG.offer, o));
  }

  /** Yes or no to what is on the table. */
  answer(ok: boolean): void {
    this.transport.send(new Uint8Array([LINK_MSG.answer, ok ? 1 : 0]));
  }

  /** Clear the table, for the next trade in the same session. */
  resetTrade(): void {
    this.peerOffer = null;
    this.peerAnswer = null;
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
        case LINK_MSG.offer: {
          const o = decodeJson(f) as TradeOffer | null;
          // A frame that did not parse, or carries no mon, is dropped rather
          // than put on the table: the other end is a peer, not an authority.
          if (o && typeof o === "object" && o.mon && typeof o.mon === "object") {
            this.peerOffer = o;
          }
          break;
        }
        case LINK_MSG.answer:
          this.peerAnswer = f[1] === 1;
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
  // Frames cross as strings, one character per byte. Every frame this
  // module builds is ASCII on purpose, so the round trip is exact.
  const toStr = (f: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < f.length; i++) s += String.fromCharCode(f[i]!);
    return s;
  };
  const toBytes = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };
  return {
    send: (f) => { call("linkSend", toStr(f)); },
    recv: () => {
      const r = call("linkRecv");
      if (typeof r === "string" && r.length > 0) return toBytes(r);
      return r instanceof Uint8Array && r.length > 0 ? r : null;
    },
    connected: () => call("linkState") === 1,
    close: () => { call("linkClose"); },
  };
}
