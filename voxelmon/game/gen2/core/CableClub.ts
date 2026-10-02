// Gold's CABLE CLUB: the link a Pokémon Center 2F receptionist opens, on the
// same session and wire as the Kanto games' (voxelmon/game/world/link.ts).
//
// The ROM's receptionist scripts run as they are (maps/PokeCenter2F.asm); the
// link specials they call are ported onto this (script/Specials.ts):
//
//   SetBitsFor{LinkTrade,Battle,TimeCapsule}Request  request()
//   WaitForLinkedFriend           open(), then wait for the peer's hello
//   CheckLinkTimeout_Receptionist say the room, wait for theirs
//   readmem wOtherPlayerLinkMode  otherPlayerLinkMode(): 0 for a Gen 1 game
//   CheckBothSelectedSameRoom     sameRoom()
//   CableClubCheckWhichChris      seat()
//   CloseLink, WaitForOtherPlayerToExit, FailedLinkToPast   close()
//
// The TRADE CENTER and the TIME CAPSULE speak the wire differently: Gold to
// Gold, party records cross as Gold's own (mode "gen2"); in the TIME CAPSULE
// they cross in the Kanto games' terms (mode "gen1", converted at this edge by
// TimeCapsule.ts), which is what lets a Red, Blue or Yellow console trade with
// it as with one of its own. The room numbers are the Kanto games' (0 trade,
// 1 battle), the TIME CAPSULE's trade being 0.
//
// `service()` once a frame (gen2/main.ts) drives the session, the waits the
// specials park on, the player's position in a link room (the Kanto games
// draw their partner from it), and a partner's press at the machine: their
// begin pulls this player to it, as the Kanto games' overworld does.

import { hostTransport, LINK_WAIT_FRAMES, LinkSession, type LinkTransport } from "../../world/link.ts";

export type LinkRequest = "trade" | "battle" | "capsule";

/** The link rooms, and the request each is entered for. */
export const LINK_ROOMS: Record<string, LinkRequest> = {
  TRADE_CENTER: "trade",
  COLOSSEUM: "battle",
  TIME_CAPSULE: "capsule",
};

/** wOtherPlayerLinkMode's address (pokegold wram.asm), read by `readmem`. */
export const W_OTHER_PLAYER_LINK_MODE = 0xce51;

interface Wait {
  until: (s: LinkSession) => boolean;
  frames: number;
  done: (ok: boolean) => void;
}

export class CableClub {
  session: LinkSession | null = null;
  requested: LinkRequest | null = null;
  private wait: Wait | null = null;
  private logged = "";
  /** A test's carrier in place of the host's. */
  static transport: (() => LinkTransport | null) | null = null;

  constructor(private readonly game: any) {}

  /** SetBitsFor*Request: what this visit to the desk is for. */
  request(r: LinkRequest): void {
    this.requested = r;
  }

  /** The wire's terms for the request (see the header). */
  private mode(): "gen1" | "gen2" {
    return this.requested === "capsule" ? "gen1" : "gen2";
  }

  /** The room number this side asks for (the Kanto games' numbering). */
  room(): 0 | 1 {
    return this.requested === "battle" ? 1 : 0;
  }

  /** Open a session for the request; false when the host has no carrier. */
  open(): boolean {
    if (this.session && this.session.state !== "closed") return true;
    const t = CableClub.transport ? CableClub.transport() : hostTransport();
    if (!t) {
      this.log("no carrier");
      return false;
    }
    const name = String(this.game?.save?.player?.name ?? "GOLD");
    this.session = new LinkSession(t, name, undefined, { game: "gold", gen: 2, mode: this.mode() }, false);
    this.session.open();
    this.logged = "";
    this.log(`open for ${this.requested ?? "?"}, waiting for a peer`);
    return true;
  }

  /** Back out: the peer hears it; the session goes. */
  close(): void {
    this.wait?.done(false);
    this.wait = null;
    if (this.session && this.session.state !== "closed") this.session.cancel();
    this.session = null;
  }

  /** Whether a peer answered (their hello arrived), even if they left since. */
  heardPeer(): boolean {
    return !!this.session?.peerIdent;
  }

  /** wOtherPlayerLinkMode: 0 when the other console is a Gen 1 game. */
  otherPlayerLinkMode(): number {
    return this.session?.peerIdent?.gen === 1 ? 0 : 1;
  }

  /** Whether the peer's wire speaks this side's terms (a Gold TRADE CENTER
   *  and a Kanto console do not). */
  sameMode(): boolean {
    return this.session?.peerIdent?.mode === this.mode();
  }

  /** CheckBothSelectedSameRoom: the same wire and the same room. */
  sameRoom(): boolean {
    const s = this.session;
    return !!s && this.sameMode() && s.peerRoom !== null && s.peerRoom === this.room();
  }

  /** CableClubCheckWhichChris: TRUE for the right-hand seat (the ROM's
   *  player 2), whose friend sits at the left. */
  seat(): 0 | 1 {
    return this.session?.seat() ?? 0;
  }

  /** Hold until `until`, `frames` pass, or the session closes. */
  waitFor(until: (s: LinkSession) => boolean, frames: number, done: (ok: boolean) => void): void {
    this.wait?.done(false);
    this.wait = { until, frames, done };
  }

  waiting(): boolean {
    return this.wait !== null;
  }

  log(m: string): void {
    if ((globalThis as { voxel?: unknown }).voxel || (globalThis as { linkLog?: boolean }).linkLog) {
      console.log(`[pv] link: gold ${m}`);
    }
  }

  /** Once a frame. */
  service(): void {
    const s = this.session;
    if (!s) return;
    s.poll();
    const now = `${s.state} peer=${s.peerName || "-"} ${s.peerIdent ? `${s.peerIdent.game}/${s.peerIdent.mode}` : ""} room=${s.peerRoom ?? "-"} seat=${s.seat()}`;
    if (now !== this.logged) {
      this.logged = now;
      this.log(now);
    }
    const w = this.wait;
    if (w) {
      if (w.until(s)) {
        this.wait = null;
        w.done(true);
      } else if (--w.frames <= 0 || s.state === "closed") {
        this.wait = null;
        this.log(s.state === "closed" ? "wait ended: link closed" : "wait ended: timed out");
        w.done(false);
      }
    }
    const world = this.game?.world;
    const map = world?.map;
    if (!map || !LINK_ROOMS[map.id] || s.state === "closed") return;
    const p = world.player;
    if (p) s.sendPos(Math.round(p.px ?? 0), Math.round(p.py ?? 0), String(p.facing ?? "down"));
    // the partner pressed A at the machine: to it, once this player is free
    if (s.peerBegin && this.free()) this.runConsole();
  }

  /** Standing in the room with nothing else going on. */
  private free(): boolean {
    const world = this.game?.world;
    if (!world || this.game.stack?.top?.()) return false;
    if (world.vm?.running?.() || world.busy?.()) return false;
    return !world.player?.moving;
  }

  /** The room's machine: its own script (the bg event at the table). */
  private runConsole(): void {
    const world = this.game.world;
    const bg = (world.map?.def?.bgEvents ?? world.map?.bgEvents ?? [])[0];
    const key = bg?.scriptKey;
    if (!key || !world.vm?.scripts?.[key]) return;
    this.log(`pulled to the machine (${key})`);
    world.vm.start(key);
  }
}

export { LINK_WAIT_FRAMES };
