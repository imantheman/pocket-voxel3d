// SYNC: the title-screen screen that moves a save between this port and
// the PC/phone games on the same wifi (the PVS1 protocol; the PC side is
// the "pvsync" mod). Not a port of anything.
//
// The networking is the host's (crates/pocketvoxel-sync, reached through
// the `voxel.sync*` natives); this is the screen's state, shared by the
// Gen 1 and Gen 2 front ends, which only draw it:
//
//   rows    per same-game peer: ACCEPT <NAME> (when it offered), GET <NAME>,
//           SEND <NAME> (when we have a save); a peer on another game is
//           listed with its game and cannot be picked; then BACK
//   status  SEARCHING... / RECEIVING FROM X... / GOT X'S SAVE! /
//           REFUSED: <why> / ERROR: <why>
//
// GET and ACCEPT write over the save, so they take two A presses within
// three seconds. B (or BACK) closes every socket.

/** The host's half (voxel_shim.c / crates/pocketvoxel-3ds/src/sync.rs). */
export interface SyncNative {
  /** 1 open; 0 no wifi; below 0 another failure (poll says why). */
  open(): number;
  /** One frame of networking, then the state as text records. */
  poll(): string;
  /** OFFER our save to a peer; 1 when sent. */
  offer(id: string): number;
  /** Start pulling a peer's save; 1 when started. */
  pull(id: string): number;
  /** The save a finished pull brought, as text (undefined: none). */
  received(): string | undefined;
  /** Install the received save: "" done, "R:<why>" refused, "E:<why>" failed. */
  install(): string;
  /** Drop the received save unwritten. */
  discard(): void;
  close(): void;
  /** Microseconds on a steady clock (optional). */
  now?(): number;
}

/** The natives, when this host has them (the 3DS); null elsewhere. */
export function hostSync(): SyncNative | null {
  const v = (globalThis as { voxel?: Record<string, unknown> }).voxel;
  if (!v || typeof v.syncOpen !== "function") return null;
  const f = (name: string) => v[name] as (...a: unknown[]) => unknown;
  return {
    open: () => Number(f("syncOpen")()),
    poll: () => String(f("syncPoll")() ?? ""),
    offer: (id) => Number(f("syncOffer")(id)),
    pull: (id) => Number(f("syncPull")(id)),
    received: () => {
      const r = f("syncReceived")();
      return typeof r === "string" ? r : undefined;
    },
    install: () => String(f("syncInstall")() ?? "E:no install"),
    discard: () => { f("syncDiscard")(); },
    close: () => { f("syncClose")(); },
    now: typeof v.now === "function" ? () => Number(f("now")()) : undefined,
  };
}

/** A save tagged `version` belongs on `game`: the same game; Blue also
 *  takes "red", which this port's Blue wrote into its saves before it
 *  wrote "blue" (the host's install has the same rule). */
export function syncAccepts(game: string, version: unknown): boolean {
  return version === game || (game === "blue" && version === "red");
}

/** The status line for a save of the wrong game. */
export function wrongGame(version: unknown): string {
  return typeof version === "string" && version !== "" ? `SAVE IS ${version.toUpperCase()}` : "SAVE HAS NO GAME";
}

export interface SyncPeer {
  id: string;
  platform: string;
  game: string;
  offered: boolean;
  name: string;
}

export type SyncRowKind = "accept" | "get" | "send" | "other" | "back";

export interface SyncRow {
  kind: SyncRowKind;
  /** The peer's id (not on BACK). */
  peer?: string;
  /** Left text. */
  label: string;
  /** Right-aligned text: the other game, on an `other` row. */
  right?: string;
}

/** The PC mod's platform words, as the list shows them. */
const PLATFORM_TAG: Record<string, string> = { "3ds": "3DS", pc: "PC", android: "PHONE", ios: "PHONE", switch: "SWITCH" };
export function platformTag(p: string): string {
  return PLATFORM_TAG[p] ?? p.toUpperCase().slice(0, 6);
}

/** Two A presses within this many seconds confirm a GET or ACCEPT. */
export const CONFIRM_SECS = 3;

export const SEARCHING = "SEARCHING...";
export const CONFIRM = "A AGAIN: OVERWRITE YOUR SAVE";

export interface SyncOpts {
  /** The running game's token: red blue yellow gold silver crystal. */
  game: string;
  native: SyncNative | null;
  /**
   * The received save's text, read with the game's own save reader (data
   * only): null when it is this game's save, else the refusal shown after
   * "REFUSED: ".
   */
  validate(text: string): string | null;
  /** A save was installed: the title's CONTINUE must be read again. */
  onInstalled?(): void;
  /** Seconds, for the confirm window (default: the native's clock, else frames/60). */
  now?(): number;
}

export class SyncModel {
  status = SEARCHING;
  rows: SyncRow[] = [{ kind: "back", label: "BACK" }];
  index = 0;
  peers: SyncPeer[] = [];
  /** We have a save to serve (SEND rows). */
  hasSave = false;
  /** A note from the host under SEARCHING... (a port it fell back to). */
  note: string | undefined;
  /** A save was installed this visit. */
  installed = false;
  /** open / nowifi / error / closed. */
  state: "open" | "nowifi" | "error" | "closed" = "closed";
  private armed: { peer: string; at: number } | null = null;
  private frames = 0;
  /** A pull under way: the peer's name. */
  private receiving: string | null = null;
  /** The player has moved the cursor (until then it stays on the first row
   *  as peers come and go, rather than riding BACK down the list). */
  private moved = false;

  constructor(private opts: SyncOpts) {}

  get title(): string {
    return `SYNC ${this.opts.game.toUpperCase()}`;
  }

  private now(): number {
    if (this.opts.now) return this.opts.now();
    const n = this.opts.native?.now?.();
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n / 1e6;
    return this.frames / 60;
  }

  open(): void {
    const n = this.opts.native;
    if (!n) {
      this.state = "nowifi";
      this.status = "ERROR: NO WIFI";
      return;
    }
    let r = 0;
    try {
      r = n.open();
    } catch {
      r = 0;
    }
    if (r === 1) {
      this.state = "open";
      this.status = SEARCHING;
      this.poll();
    } else if (r === 0) {
      this.state = "nowifi";
      this.status = "ERROR: NO WIFI";
    } else {
      this.state = "error";
      this.poll(); // says why
      if (!this.status.startsWith("ERROR")) this.status = "ERROR: NETWORK";
    }
    this.rebuild();
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    try {
      this.opts.native?.close();
    } catch { /* closing is best effort */ }
  }

  /** One frame. Returns "close" when the screen should go. */
  update(p: { up?: boolean; down?: boolean; a?: boolean; b?: boolean }): "close" | null {
    this.frames += 1;
    if (this.state === "open" || this.state === "error") this.poll();
    if (this.armed && this.now() - this.armed.at > CONFIRM_SECS) {
      this.armed = null;
      if (this.status === CONFIRM) this.status = this.idle();
    }
    if (p.b) {
      this.close();
      return "close";
    }
    if (p.up) this.move(-1);
    if (p.down) this.move(1);
    if (p.a) return this.choose();
    return null;
  }

  private idle(): string {
    if (this.state === "nowifi") return "ERROR: NO WIFI";
    if (this.receiving) return `RECEIVING FROM ${this.receiving}...`;
    return SEARCHING;
  }

  private selectable(i: number): boolean {
    const r = this.rows[i];
    return !!r && r.kind !== "other";
  }

  private move(d: number): void {
    const n = this.rows.length;
    for (let k = 1; k <= n; k++) {
      const j = (((this.index + d * k) % n) + n) % n;
      if (this.selectable(j)) {
        if (j !== this.index) this.moved = true;
        if (j !== this.index && this.armed) {
          this.armed = null;
          if (this.status === CONFIRM) this.status = this.idle();
        }
        this.index = j;
        return;
      }
    }
  }

  private choose(): "close" | null {
    const row = this.rows[this.index];
    if (!row || row.kind === "back") {
      this.close();
      return "close";
    }
    const peer = this.peers.find((x) => x.id === row.peer);
    if (!peer || !this.opts.native) return null;
    if (row.kind === "send") {
      this.status = this.opts.native.offer(peer.id) === 1 ? `OFFERED TO ${peer.name}` : "ERROR: OFFER NOT SENT";
      return null;
    }
    if (row.kind !== "get" && row.kind !== "accept") return null;
    if (this.receiving) {
      this.status = "ERROR: ALREADY RECEIVING";
      return null;
    }
    const t = this.now();
    if (!this.armed || this.armed.peer !== peer.id || t - this.armed.at > CONFIRM_SECS) {
      this.armed = { peer: peer.id, at: t };
      this.status = CONFIRM;
      return null;
    }
    this.armed = null;
    if (this.opts.native.pull(peer.id) === 1) {
      this.receiving = peer.name;
      this.status = `RECEIVING FROM ${peer.name}...`;
    } else {
      this.status = "ERROR: COULD NOT CONNECT";
    }
    return null;
  }

  /** Read the host's records: peers, progress, events. */
  private poll(): void {
    let text = "";
    try {
      text = this.opts.native?.poll() ?? "";
    } catch (e) {
      this.status = `ERROR: ${String((e as Error)?.message ?? e).toUpperCase().slice(0, 40)}`;
      return;
    }
    const peers: SyncPeer[] = [];
    this.note = undefined;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const f = line.split("\t");
      switch (f[0]) {
        case "S":
          if (f[1] === "error") {
            this.state = "error";
            this.status = `ERROR: ${(f[2] ?? "NETWORK").toUpperCase()}`;
          } else if (f[1] === "nowifi") {
            this.state = "nowifi";
            this.status = "ERROR: NO WIFI";
          }
          break;
        case "H":
          this.hasSave = f[1] === "1";
          break;
        case "N":
          this.note = f[1] || undefined;
          break;
        case "P":
          peers.push({ id: f[1] ?? "", platform: f[2] ?? "", game: f[3] ?? "", offered: f[4] === "1", name: f[5] || platformTag(f[2] ?? "") });
          break;
        case "O":
          this.status = `${f[1] ?? "?"} OFFERS A SAVE`;
          break;
        case "F":
          this.receiving = null;
          this.status = `ERROR: ${(f[2] ?? "FAILED").toUpperCase()}`;
          break;
        case "R":
          this.receiving = null;
          this.received(f[1] ?? "?");
          break;
        default:
          break; // G (progress) and anything newer: nothing to do
      }
    }
    this.peers = peers;
    this.rebuild();
  }

  /** A pull landed: the game's own reader, then the host's install. */
  private received(name: string): void {
    const n = this.opts.native!;
    const text = n.received();
    if (text === undefined) {
      this.status = "ERROR: NOTHING RECEIVED";
      return;
    }
    let why: string | null;
    try {
      why = this.opts.validate(text);
    } catch {
      why = "NOT A SAVE";
    }
    if (why) {
      n.discard();
      this.status = `REFUSED: ${why}`;
      return;
    }
    const r = n.install();
    if (r === "") {
      this.installed = true;
      this.status = `GOT ${name}'S SAVE!`;
      try {
        this.opts.onInstalled?.();
      } catch { /* the title rereads on close anyway */ }
    } else if (r.startsWith("R:")) {
      this.status = `REFUSED: ${r.slice(2)}`;
    } else {
      this.status = `ERROR: ${r.replace(/^E:/, "")}`;
    }
  }

  private rebuild(): void {
    const cur = this.rows[this.index];
    const key = cur ? `${cur.kind}:${cur.peer ?? ""}` : "";
    const rows: SyncRow[] = [];
    if (this.state === "open" || this.state === "error") {
      for (const p of this.peers) {
        if (p.game !== this.opts.game) {
          rows.push({ kind: "other", peer: p.id, label: p.name, right: p.game.toUpperCase() });
          continue;
        }
        if (p.offered) rows.push({ kind: "accept", peer: p.id, label: `ACCEPT ${p.name}` });
        rows.push({ kind: "get", peer: p.id, label: `GET ${p.name}` });
        if (this.hasSave) rows.push({ kind: "send", peer: p.id, label: `SEND ${p.name}` });
      }
    }
    rows.push({ kind: "back", label: "BACK" });
    this.rows = rows;
    const again = this.moved ? rows.findIndex((r) => `${r.kind}:${r.peer ?? ""}` === key) : 0;
    this.index = again >= 0 ? again : Math.min(this.index, rows.length - 1);
    if (!this.selectable(this.index)) {
      const moved = this.moved;
      this.move(1);
      this.moved = moved;
    }
    if (this.armed && !rows.some((r) => r.peer === this.armed!.peer && (r.kind === "get" || r.kind === "accept"))) {
      this.armed = null;
      if (this.status === CONFIRM) this.status = this.idle();
    }
  }

  /** The rows as text for a list `width` characters wide. */
  rowText(width: number): string[] {
    return this.rows.map((r) => {
      if (r.kind === "other" && r.right) {
        const room = Math.max(1, width - r.right.length - 1);
        const left = r.label.slice(0, room);
        return left + " ".repeat(Math.max(1, width - left.length - r.right.length)) + r.right;
      }
      return r.label.slice(0, width);
    });
  }

  /** The first row shown when `n` fit, keeping the cursor in view. */
  scrollTop(n: number): number {
    if (this.rows.length <= n) return 0;
    return Math.max(0, Math.min(this.index - Math.floor(n / 2), this.rows.length - n));
  }

  /** The status line wrapped to `width`, at most `lines` lines. */
  statusLines(width: number, lines = 2): string[] {
    // the host's note (not an error) on the line under SEARCHING...
    if (this.status === SEARCHING && this.note && lines >= 2) return [SEARCHING, this.note.slice(0, width)];
    const out: string[] = [];
    let line = "";
    for (const word of this.status.split(" ")) {
      const w = word.slice(0, width);
      if (line && line.length + 1 + w.length > width) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(line);
    return out.slice(0, lines);
  }
}
