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
//
// What the carriers do NOT promise is delivery or order: the network one is
// UDP, and a frame the radio drops is a trade that waits twenty seconds and
// gives up. ReliableLink below sits between the session and the carrier and
// makes every frame arrive, once, in order, and lets a frame be bigger than
// a datagram -- a party of six is -- so the session above it can be written
// as if the cable were still there.

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
export const LINK_ROOM_MAP = ["TRADE_CENTER", "COLOSSEUM"] as const;

/**
 * Where the two of you stand.
 *
 * Both rooms are the same 10x8 shell with the link machine walled off at
 * (4,4)-(5,4), which is the table: the two seats are the cells either side
 * of it, each facing into it, so the players face each other across the
 * machine the way they do in the ROM. You walk in a step behind your seat
 * rather than onto it, because walking up to the table is the part that
 * makes it a room and not a menu.
 */
export const LINK_TABLE = [
  { x: 4, y: 4 },
  { x: 5, y: 4 },
] as const;

export const LINK_SEATS = [
  { enter: { x: 4, y: 2 }, seat: { x: 4, y: 3 }, facing: "down" },
  { enter: { x: 4, y: 6 }, seat: { x: 4, y: 5 }, facing: "up" },
] as const;

/**
 * Frames the receptionist holds the link open waiting for a peer, and the
 * most any step of a trade or battle waits on the other console. A minute:
 * the other player has to walk up to their own desk and answer the same
 * questions, and the cable never hurried anyone. A peer that has actually
 * gone is caught sooner by the link's own silence timer (LINK_DEAD_FRAMES).
 */
export const LINK_WAIT_FRAMES = 60 * 60;

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
  /** where this player is standing, so the other can see them move. */
  pos: 6,
  /** this side's whole party, so the trade screen can show both. */
  party: 7,
  /** half of the battle's shared random seed. */
  seed: 8,
  /** this side's choice for one turn of a link battle. */
  action: 9,
  /** this side pressed A at the machine: come to the table. */
  begin: 10,
  /** the proposer, on a yes: the swap happens now, on both sides. */
  commit: 11,
} as const;

/**
 * Frames the proposer waits for the other player's yes or no. Long,
 * because a person is reading the offer and deciding; the ROM never timed
 * this out at all. The link's own silence timer still catches a console
 * that has actually gone.
 */
export const LINK_ANSWER_FRAMES = 60 * 120;

/** Where the peer is, in world pixels, as they last told us. */
export interface LinkPos {
  x: number;
  y: number;
  facing: string;
}

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
/**
 * A proposal, in the PROPOSER's terms: give their party[give], take the
 * receiver's party[take]. Indices rather than a mon, because both parties
 * have already crossed and both sides can look the mon up -- which also
 * means neither side has to take the other's word for what it is sending.
 */
export interface TradeOffer {
  give: number;
  take: number;
}

/** A party as it crosses, with the trainer to stamp on anything traded. */
export interface PartyWire {
  mons: Record<string, unknown>[];
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
export const LINK_VERSION = 3;

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
function encodeHello(name: string, nonce: number): Uint8Array {
  const s = asciiJson({ n: [...name].slice(0, MAX_NAME).join(""), k: nonce });
  const out = new Uint8Array(2 + s.length);
  out[0] = LINK_MSG.hello;
  out[1] = LINK_VERSION;
  for (let i = 0; i < s.length; i++) out[2 + i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeHello(frame: Uint8Array): { name: string; nonce: number } {
  let s = "";
  for (let i = 2; i < frame.length; i++) s += String.fromCharCode(frame[i]!);
  try {
    const v = JSON.parse(s) as { n?: string; k?: number };
    return { name: typeof v?.n === "string" ? v.n : "", nonce: Number(v?.k ?? 0) };
  } catch {
    return { name: s, nonce: 0 };
  }
}

/** Frames between retransmissions of anything the peer has not acknowledged. */
export const RELIABLE_RESEND_FRAMES = 6;
/** Frames of silence after which an ack goes out on its own, so a quiet peer
 * can still tell we are here. */
export const RELIABLE_KEEPALIVE_FRAMES = 60;
/** Frames without a word from a connected peer before the link is judged
 * gone: a console switched off, or carried out of range. */
export const LINK_DEAD_FRAMES = 60 * 8;
/** Payload bytes per datagram. The carriers cap a frame at 1400 bytes and a
 * party of six as JSON runs past that, so bigger frames go in pieces. */
export const RELIABLE_MTU = 1000;
/** Unacknowledged frames allowed in the air before the sender holds. */
const RELIABLE_WINDOW = 32;
const SEQ_MOD = 0x1000;
/** Header bytes. ASCII, like everything on the wire (see encodeHello). */
const RL_DATA = 0x7e;  // '~'  one whole frame, or the last piece of one
const RL_MORE = 0x7c;  // '|'  a piece with more to follow
const RL_ACK = 0x7d;   // '}'  seq = the next frame this side wants

/** a strictly after b, on the 12-bit ring. */
function seqAfter(a: number, b: number): boolean {
  const d = (a - b) & (SEQ_MOD - 1);
  return d !== 0 && d < SEQ_MOD / 2;
}

/**
 * Delivery, order and size, on top of a carrier that promises none of them.
 *
 * Every frame out gets a sequence number and is resent every few frames
 * until the peer's ack covers it; every frame in is taken only when it is
 * the next one expected, so a repeat is dropped and a gap is filled by the
 * resend rather than skipped over. A frame bigger than a datagram goes as
 * pieces that the receiver joins back up, in order, which the sequence
 * numbers already guarantee. And a peer that has been silent for
 * LINK_DEAD_FRAMES is judged gone, which is the only way a switched-off
 * console can ever be noticed.
 *
 * `tick()` once a frame is what drives the resends and the keepalive; the
 * session calls it at the top of its own poll.
 */
export class ReliableLink implements LinkTransport {
  private txSeq = 0;
  private rxExpect = 0;
  private pending: { seq: number; kind: number; body: Uint8Array }[] = [];
  private pieces: Uint8Array[] = [];
  private ackDue = false;
  private sinceSend = 0;
  private sinceRecv = 0;
  private frame = 0;
  private gone = false;

  constructor(private inner: LinkTransport) {}

  private raw(kind: number, seq: number, body?: Uint8Array): void {
    const out = new Uint8Array(3 + (body?.length ?? 0));
    out[0] = kind;
    out[1] = 0x40 | (seq & 0x3f);
    out[2] = 0x40 | ((seq >> 6) & 0x3f);
    if (body) out.set(body, 3);
    this.inner.send(out);
    this.sinceSend = 0;
  }

  private queue(kind: number, body: Uint8Array): void {
    const seq = this.txSeq;
    this.txSeq = (seq + 1) % SEQ_MOD;
    this.pending.push({ seq, kind, body });
    if (this.pending.length <= RELIABLE_WINDOW) this.raw(kind, seq, body);
  }

  send(frame: Uint8Array): void {
    let at = 0;
    while (frame.length - at > RELIABLE_MTU) {
      this.queue(RL_MORE, frame.subarray(at, at + RELIABLE_MTU));
      at += RELIABLE_MTU;
    }
    this.queue(RL_DATA, frame.subarray(at));
  }

  recv(): Uint8Array | null {
    for (;;) {
      const f = this.inner.recv();
      if (!f) return null;
      if (f.length < 3) continue;
      const seq = (f[1]! & 0x3f) | ((f[2]! & 0x3f) << 6);
      this.sinceRecv = 0;
      if (f[0] === RL_ACK) {
        // seq is the next frame the peer wants: everything before it landed
        this.pending = this.pending.filter((p) => !seqAfter(seq, p.seq));
        continue;
      }
      if (f[0] !== RL_DATA && f[0] !== RL_MORE) continue;
      this.ackDue = true;
      // a repeat, or one from beyond a gap: the resend fills the gap
      if (seq !== this.rxExpect) continue;
      this.rxExpect = (seq + 1) % SEQ_MOD;
      const body = f.subarray(3);
      if (f[0] === RL_MORE) {
        this.pieces.push(body);
        continue;
      }
      if (this.pieces.length === 0) return body;
      const whole = new Uint8Array(this.pieces.reduce((n, p) => n + p.length, 0) + body.length);
      let at = 0;
      for (const piece of this.pieces) { whole.set(piece, at); at += piece.length; }
      whole.set(body, at);
      this.pieces = [];
      return whole;
    }
  }

  /** Once a frame: resends, the ack, the keepalive, the silence count. */
  tick(): void {
    this.frame += 1;
    this.sinceSend += 1;
    if (!this.inner.connected()) {
      this.sinceRecv = 0; // nobody to hear from yet
      return;
    }
    this.sinceRecv += 1;
    if (this.pending.length > 0 && this.frame % RELIABLE_RESEND_FRAMES === 0) {
      for (const p of this.pending.slice(0, RELIABLE_WINDOW)) this.raw(p.kind, p.seq, p.body);
    }
    if (this.ackDue || this.sinceSend >= RELIABLE_KEEPALIVE_FRAMES) {
      this.raw(RL_ACK, this.rxExpect);
      this.ackDue = false;
    }
    if (this.sinceRecv > LINK_DEAD_FRAMES) this.gone = true;
  }

  /** Frames sent and not yet acknowledged. */
  unacked(): number {
    return this.pending.length;
  }

  /** True once the peer has gone quiet for too long. */
  dead(): boolean {
    return this.gone;
  }

  connected(): boolean {
    return !this.gone && this.inner.connected();
  }

  close(): void {
    this.inner.close();
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
  /** The proposer's word that the swap is on. */
  peerCommit = false;
  /** Where the peer is standing, once they have said. */
  peerPos: LinkPos | null = null;
  /** Their whole party, for the trade screen to show. */
  peerParty: PartyWire | null = null;
  /** Their half of the battle seed, once sent. */
  peerSeed: number | null = null;
  /** Their turn choices, oldest first. A queue and not a slot: a console
   * that gets a frame ahead must not overwrite the turn not yet played. */
  private actions: unknown[] = [];
  /** They pressed A at the machine and are waiting for us at the table. */
  peerBegin = false;

  /**
   * Which side of the table this console takes, 0 or 1.
   *
   * Decided by the hello's nonce so both ends agree without either being
   * "the host": the larger nonce takes seat 0. A tie falls back to the
   * names, and a tie there to seat 0, which two consoles cannot both reach
   * because they would have had to roll the same number AND be called the
   * same thing -- and if they did, they would agree on it anyway.
   */
  seat(): 0 | 1 {
    if (this.peerNonce === null) return 0;
    if (this.myNonce !== this.peerNonce) return this.myNonce > this.peerNonce ? 0 : 1;
    return this.myName >= this.peerName ? 0 : 1;
  }

  private helloSent = false;
  private readonly myNonce: number;
  private peerNonce: number | null = null;
  private lastPos = "";
  private readonly transport: ReliableLink;

  constructor(
    carrier: LinkTransport,
    private myName: string,
    nonce?: number,
  ) {
    // Whatever the carrier is, the session talks over it reliably.
    this.transport = new ReliableLink(carrier);
    // Only has to differ from the other console's; the seat falls back to
    // the names if it somehow does not.
    this.myNonce = nonce ?? Math.floor(Math.random() * 0x7fffffff);
  }

  /** The link under the session, for tests that watch it work. */
  wire(): ReliableLink {
    return this.transport;
  }

  open(): void {
    if (this.state === "idle") this.state = "waiting";
  }

  /** Ask for a room. Both sides have to ask for the same one. */
  chooseRoom(room: LinkRoom): void {
    this.myRoom = room;
    const f = new Uint8Array([LINK_MSG.room, room]);
    this.transport.send(f);
  }

  /**
   * Say where this player is, so the other console can draw them walking.
   * Silent when nothing has moved: the room is still most of the time and
   * a packet a frame for a player standing still is a packet wasted.
   */
  sendPos(x: number, y: number, facing: string): void {
    const key = `${x},${y},${facing}`;
    if (key === this.lastPos) return;
    this.lastPos = key;
    this.transport.send(encodeJson(LINK_MSG.pos, { x, y, f: facing }));
  }

  /** Show the other side what you have. */
  sendParty(p: PartyWire): void {
    this.transport.send(encodeJson(LINK_MSG.party, p));
  }

  /**
   * Half the battle's seed.
   *
   * Both halves are XORed, so neither console decides the fight's luck on
   * its own and neither has to trust the other to have rolled fairly.
   */
  sendSeed(half: number): void {
    this.transport.send(encodeJson(LINK_MSG.seed, { s: half >>> 0 }));
  }

  /** The seed both sides will run the battle on, or null until they agree. */
  battleSeed(myHalf: number): number | null {
    if (this.peerSeed === null) return null;
    return ((myHalf ^ this.peerSeed) >>> 0) || 1;
  }

  /** This side's choice for one turn. */
  sendAction(a: unknown): void {
    this.transport.send(encodeJson(LINK_MSG.action, a));
  }

  /** The peer's next unplayed turn, or null while it has not arrived. */
  takeAction(): unknown | null {
    return this.actions.shift() ?? null;
  }

  /** The same, left in place: for a console that wants one kind and not
   * whatever is next. */
  peekAction(): unknown | null {
    return this.actions[0] ?? null;
  }

  /** True once the other console is gone: backed out, or fallen silent. */
  closed(): boolean {
    return this.state === "closed";
  }

  /**
   * Press A at the machine.
   *
   * Clears the table on this side and tells the peer to come to it; their
   * console starts the same flow as a responder (see takeBegin). Cleared
   * BEFORE anything is sent so that what arrives after is this trade's,
   * not the last one's: a party still held from an earlier trade would
   * satisfy the wait at once, with mons the peer no longer has.
   */
  begin(): void {
    this.clearTable();
    this.transport.send(new Uint8Array([LINK_MSG.begin]));
  }

  /**
   * Whether the peer pressed first, consumed. The flow that finds this
   * true is the responder and sends no begin of its own; one that finds it
   * false is the initiator and does.
   */
  takeBegin(): boolean {
    const b = this.peerBegin;
    this.peerBegin = false;
    return b;
  }

  private clearTable(): void {
    this.peerParty = null;
    this.peerSeed = null;
    this.peerOffer = null;
    this.peerAnswer = null;
    this.peerCommit = false;
    this.actions.length = 0;
  }

  /** Propose a swap: my `give` for your `take`. */
  offer(o: TradeOffer): void {
    this.transport.send(encodeJson(LINK_MSG.offer, o));
  }

  /** Yes or no to what is on the table. */
  answer(ok: boolean): void {
    this.transport.send(new Uint8Array([LINK_MSG.answer, ok ? 1 : 0]));
  }

  /**
   * The proposer's last word: swap now. Nothing changes hands on either
   * console before this crosses, so a proposer that gave up waiting for
   * an answer, or a link that dropped in between, leaves both parties as
   * they were rather than one of them short a mon.
   */
  commit(): void {
    this.transport.send(new Uint8Array([LINK_MSG.commit]));
  }

  /** Frames this side has sent that the peer has not yet acknowledged. */
  unacked(): number {
    return this.transport.unacked();
  }

  /** Clear the table, for the next trade in the same session. The parties
   * stay: they are resent each time the screen opens, so whatever changed
   * hands is already accounted for. */
  resetTrade(): void {
    this.peerOffer = null;
    this.peerAnswer = null;
    this.peerCommit = false;
  }

  /** Back out; the peer hears about it. */
  cancel(): void {
    if (this.state !== "closed") {
      // Said three times, because the link closes right after and nothing
      // will be around to resend it. A peer that misses all three finds
      // out from the silence (LINK_DEAD_FRAMES) instead.
      for (let i = 0; i < 3; i++) this.transport.send(new Uint8Array([LINK_MSG.cancel]));
    }
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

    this.transport.tick();
    if (this.transport.dead()) {
      // They stopped answering: a console off, or out of range.
      this.close();
      return this.state;
    }

    // Say hello as soon as there is someone to say it to, once.
    if (!this.helloSent && this.transport.connected()) {
      this.transport.send(encodeHello(this.myName, this.myNonce));
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
          {
            const h = decodeHello(f);
            this.peerName = h.name;
            this.peerNonce = h.nonce;
          }
          if (this.state === "waiting") this.state = "linked";
          break;
        case LINK_MSG.pos: {
          const p = decodeJson(f) as { x?: number; y?: number; f?: string } | null;
          if (p && typeof p.x === "number" && typeof p.y === "number") {
            this.peerPos = { x: p.x, y: p.y, facing: typeof p.f === "string" ? p.f : "down" };
          }
          break;
        }
        case LINK_MSG.room:
          this.peerRoom = (f[1] ?? 0) as LinkRoom;
          break;
        case LINK_MSG.party: {
          const p = decodeJson(f) as PartyWire | null;
          if (p && typeof p === "object" && Array.isArray(p.mons)) {
            this.peerParty = {
              mons: p.mons.slice(0, 6),
              otName: typeof p.otName === "string" ? p.otName : "",
              otId: Number(p.otId ?? 0),
            };
          }
          break;
        }
        case LINK_MSG.seed: {
          const v = decodeJson(f) as { s?: number } | null;
          if (v && typeof v.s === "number") this.peerSeed = v.s >>> 0;
          break;
        }
        case LINK_MSG.action: {
          const v = decodeJson(f);
          if (v && typeof v === "object") this.actions.push(v);
          break;
        }
        case LINK_MSG.offer: {
          const o = decodeJson(f) as TradeOffer | null;
          // Two indices into parties both sides already hold. Anything else
          // is dropped: the other end is a peer, not an authority.
          if (o && typeof o === "object" &&
              Number.isInteger(o.give) && Number.isInteger(o.take) &&
              o.give >= 0 && o.give < 6 && o.take >= 0 && o.take < 6) {
            this.peerOffer = { give: o.give, take: o.take };
          }
          break;
        }
        case LINK_MSG.answer:
          this.peerAnswer = f[1] === 1;
          break;
        case LINK_MSG.commit:
          this.peerCommit = true;
          break;
        case LINK_MSG.begin:
          // Their press clears our side of the table too, so what follows
          // it on the wire is read as this trade's (see begin()).
          this.clearTable();
          this.peerBegin = true;
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
 * A loopback that drops, repeats and reorders frames on purpose, the way a
 * radio does on a bad day. What the reliable layer is tested against.
 */
export class LossyLink {
  readonly a: LinkTransport;
  readonly b: LinkTransport;

  /** `drop` in [0,1) is the share of frames lost; `dup` the share repeated. */
  constructor(drop = 0.3, dup = 0.1, seed = 12345) {
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 0x100000000);
    const toA: Uint8Array[] = [];
    const toB: Uint8Array[] = [];
    let open = true;
    const make = (outbox: Uint8Array[], inbox: Uint8Array[]): LinkTransport => ({
      send: (f) => {
        if (!open) return;
        if (rnd() < drop) return;
        outbox.push(f);
        if (rnd() < dup) outbox.push(f);
        // a late arrival: swap with the one before it now and then
        if (outbox.length > 1 && rnd() < dup) {
          const n = outbox.length;
          [outbox[n - 1], outbox[n - 2]] = [outbox[n - 2]!, outbox[n - 1]!];
        }
      },
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
  // No wireless and no network is no carrier. Saying so here is what gets
  // the receptionist to her "reserved for 2 friends" line at once, instead
  // of holding the player still for twenty seconds while a session waits
  // on a peer with no way of arriving.
  const opened = call("linkOpen");
  if (typeof opened === "number" && opened <= 0) return null;
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
