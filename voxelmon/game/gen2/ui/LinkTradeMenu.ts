// The link trade (engine/link/link.asm's trade screen), at the TRADE CENTER's
// machine and the TIME CAPSULE's: both parties at once, yours above theirs,
// a cursor that crosses between them -- the same flow and the same wire as
// the Kanto games' (voxelmon/game/game.ts linkTrade), so a Red, Blue or
// Yellow console on the other end of the TIME CAPSULE cannot tell.
//
// A round:
//   - whoever reaches the machine first says begin (link.ts); both parties
//     cross -- converted to the Kanto games' terms in the TIME CAPSULE
//   - pick one of yours, the cursor goes to theirs, pick one of theirs: that
//     is an offer. Whoever offers first proposes; the other console's screen
//     sees it land and steps aside to answer it (YES/NO)
//   - a yes: the proposer commits, and only then does anything change hands,
//     on both consoles at once; the game is saved; the trade animation;
//     a trade evolution if the arrival has one
//   - a no, a dropped link, a partner gone quiet: nothing moves
// and then the next round, as the cart stays on its trade screen, until
// CANCEL (or B on your own side) leaves it -- and the room.

import { Strings } from "../shared/core/Strings.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Evolution } from "../core/Evolution.ts";
import { TimeCapsule } from "../core/TimeCapsule.ts";
import { LINK_ANSWER_FRAMES, LINK_WAIT_FRAMES, type LinkSession, type PartyWire } from "../../world/link.ts";
import type { CableClub } from "../core/CableClub.ts";
import G from "../platform/screen.ts";
import { Chrome } from "./Chrome.ts";

const TEXT_WAIT = Strings.source("Waiting…");
const TEXT_CANCELED = Strings.source("Too bad! The trade\nwas canceled!");
const TEXT_COMPLETE = Strings.source("Trade completed!");
const TEXT_ASK = Strings.source("{FRIEND} will trade\n{THEIRS} for\v{MINE}. OK?");
const TEXT_OFFER = Strings.source("Trade {MINE}\nfor {THEIRS}?");
const TEXT_PICK_MINE = Strings.source("Choose a #MON.");
const TEXT_PICK_THEIRS = Strings.source("For which of theirs?");
const TEXT_NONE = Strings.source("{MON} can't\nbe traded.");

/** The lists: yours from row 1, theirs from row 9, CANCEL on row 16 and
 *  the picking prompt under it; a message or the offer takes rows 12-17. */
const MINE_ROW = 1;
const THEIRS_ROW = 9;
const CANCEL_ROW = 16;
const PROMPT_ROW = 17;

type Phase = "exchange" | "pick" | "await-answer" | "await-commit" | "message" | "confirm" | "busy" | "done";

interface Message {
  pages: string[][];
  page: number;
  then: () => void;
}

export interface LinkTradeOpts {
  club: CableClub;
  /** The TIME CAPSULE: the wire in the Kanto games' terms. */
  capsule: boolean;
  /** When the player leaves the screen (CANCEL, or the link gone). */
  onDone: () => void;
}

export class LinkTradeMenu {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;
  screenId = "Gen2LinkTradeMenu";

  game: any;
  opts!: LinkTradeOpts;
  phase: Phase = "exchange";
  /** Their party as Gold records (null: a slot this game cannot take). */
  theirs: (any | null)[] = [];
  peerOtName = "";
  peerOtId = 0;
  side: 0 | 1 = 0;
  index = 0;
  chosenMine: number | null = null;
  message: Message | null = null;
  confirm: { lines: string[]; yes: boolean; then: (yes: boolean) => void } | null = null;
  private waitFrames = 0;

  static new(game: any, opts: LinkTradeOpts): LinkTradeMenu {
    const self = new LinkTradeMenu();
    self.game = game;
    self.opts = opts;
    self.startRound();
    return self;
  }

  private get s(): LinkSession | null {
    return this.opts.club.session;
  }

  private get data(): any {
    return this.game?.data;
  }

  private get party(): any[] {
    return this.game?.save?.party ?? [];
  }

  private log(m: string): void {
    this.opts.club.log(`trade ${m}`);
  }

  private nameOf(m: any): string {
    if (!m) return "-";
    if (m.isEgg || m.egg) return "EGG";
    return String(m.nickname || this.data?.pokemon?.[m.species]?.name || m.name || m.species);
  }

  // ------------------------------------------------------------------ rounds

  /** Begin (or answer a begin), clear the table, send the party, wait for theirs. */
  startRound(): void {
    const s = this.s;
    if (!s || s.state === "closed") return this.end(TEXT_CANCELED);
    if (!s.takeBegin()) s.begin();
    s.resetTrade();
    const player = this.game?.save?.player ?? {};
    const mons = this.opts.capsule
      ? this.party.map((m) => TimeCapsule.toGen1(this.data, m))
      : JSON.parse(JSON.stringify(this.party));
    s.sendParty({ mons, otName: String(player.name ?? "GOLD"), otId: Number(player.id ?? 0) });
    this.phase = "exchange";
    this.side = 0;
    this.index = 0;
    this.chosenMine = null;
    this.waitFrames = LINK_WAIT_FRAMES;
    this.log("round: party sent");
  }

  /** Their party has crossed: as Gold records, slot for slot. */
  private takeParty(p: PartyWire): void {
    this.peerOtName = p.otName;
    this.peerOtId = p.otId;
    this.theirs = p.mons.slice(0, 6).map((m) => this.arrival(m));
    this.log(`screen: ${this.party.length} of mine, ${this.theirs.filter(Boolean).length} of theirs`);
    this.phase = "pick";
  }

  /** One of theirs as a Gold record, or null when it cannot be taken. */
  private arrival(m: any): any | null {
    if (!m || typeof m !== "object") return null;
    if (this.opts.capsule) return TimeCapsule.toGen2(this.data, m);
    const ok = typeof m.species === "string" && !!this.data?.pokemon?.[m.species] &&
      typeof m.level === "number" && m.level >= 1 && m.level <= 100 &&
      typeof m.hp === "number" && Array.isArray(m.moves);
    return ok ? m : null;
  }

  /** Back to the room; the special's caller warps out (newloadmap). */
  private leave(): void {
    if (this.phase === "done") return;
    this.phase = "done";
    this.log("left the screen");
    this.opts.onDone();
  }

  /** Say `text` and leave. */
  private end(text: string): void {
    this.say(text, () => this.leave());
  }

  /** Say `text`, then the next round (the link still up), else leave. */
  private nextRound(text: string): void {
    this.say(text, () => {
      if (this.s && this.s.state !== "closed") this.startRound();
      else this.leave();
    });
  }

  // ---------------------------------------------------------------- the deal

  private propose(give: number, take: number): void {
    const s = this.s;
    if (!s) return this.end(TEXT_CANCELED);
    const mine = this.party[give];
    const theirs = this.theirs[take];
    this.confirm = {
      lines: this.fill(TEXT_OFFER, { MINE: this.nameOf(mine), THEIRS: this.nameOf(theirs) }).split("\n"),
      yes: true,
      then: (yes) => {
        if (!yes) {
          this.phase = "pick";
          return;
        }
        this.log(`proposed: my ${give} for their ${take}`);
        s.offer({ give, take });
        this.phase = "await-answer";
        this.opts.club.waitFor((x) => x.peerAnswer !== null, LINK_ANSWER_FRAMES, (answered) => {
          if (!answered || s.peerAnswer !== true) {
            s.answer(false);
            s.resetTrade();
            this.log(!answered ? "no answer came" : "they said no");
            return this.nextRound(TEXT_CANCELED);
          }
          this.log("they said yes; committing");
          s.commit();
          this.opts.club.waitFor((x) => x.unacked() === 0, LINK_WAIT_FRAMES, (heard) => {
            if (!heard) {
              s.resetTrade();
              return this.nextRound(TEXT_CANCELED);
            }
            this.swap(give, take);
          });
        });
      },
    };
    this.phase = "confirm";
  }

  /** Their offer landed first: answer it. */
  private answerOffer(): void {
    const s = this.s;
    const o = s?.peerOffer;
    if (!s || !o) return this.nextRound(TEXT_CANCELED);
    const incoming = this.theirs[o.give];
    const outgoing = this.party[o.take];
    if (!incoming || !outgoing) {
      s.answer(false);
      s.resetTrade();
      return this.nextRound(TEXT_CANCELED);
    }
    this.log(`offered: their ${incoming.species} for my ${outgoing.species}`);
    this.confirm = {
      lines: this.fill(TEXT_ASK, { FRIEND: s.peerName, THEIRS: this.nameOf(incoming), MINE: this.nameOf(outgoing) })
        .replace(/\v/g, "\n").split("\n"),
      yes: true,
      then: (yes) => {
        this.log(yes ? "said yes; waiting for their commit" : "said no");
        s.answer(yes);
        if (!yes) {
          s.resetTrade();
          return this.nextRound(TEXT_CANCELED);
        }
        this.phase = "await-commit";
        this.opts.club.waitFor((x) => x.peerCommit || x.peerAnswer === false, LINK_WAIT_FRAMES, (spoke) => {
          if (!spoke || !s.peerCommit) {
            s.resetTrade();
            return this.nextRound(TEXT_CANCELED);
          }
          this.swap(o.take, o.give);
        });
      },
    };
    this.phase = "confirm";
  }

  /** My slot `mySlot` for their `theirSlot`: on both consoles at once. */
  private swap(mySlot: number, theirSlot: number): void {
    const save = this.game.save;
    const mine = this.party[mySlot];
    const got = this.theirs[theirSlot];
    if (!mine || !got) return this.nextRound(TEXT_CANCELED);
    const arrival = { ...JSON.parse(JSON.stringify(got)), traded: true,
      ot: this.peerOtName, otName: this.peerOtName, otId: this.peerOtId };
    this.log(`swap: my ${mine.species} for their ${arrival.species}`);
    save.party[mySlot] = arrival;
    save.pokedex = save.pokedex ?? {};
    (save.pokedex.seen ??= {})[arrival.species] = true;
    (save.pokedex.caught ??= {})[arrival.species] = true;
    // saved as it changes hands, on both consoles (the cart saved before the
    // link opened, so a trade cannot be undone by a reset after it)
    try {
      this.game.writeSave?.();
    } catch {
      // a failed write is the save screen's to report
    }
    this.s?.resetTrade();
    this.phase = "busy";
    const afterAnim = (): void => {
      this.say(TEXT_COMPLETE, () => this.evolve(arrival, mySlot));
    };
    if (!this.game?.stack) return afterAnim();
    Screens.push(this.game, "Gen2TradeAnim", {
      row: { otName: this.peerOtName, otId: this.peerOtId },
      given: mine,
      received: arrival,
      save,
      onDone: () => {
        this.game.stack.pop();
        afterAnim();
      },
    });
  }

  /** The arrival's trade evolution (Evolution TRADE; held-item ones not
   *  through the TIME CAPSULE), then the next round. */
  private evolve(mon: any, slot: number): void {
    const [entry] = Evolution.checkMon(this.data, mon, { link: true, timeCapsule: this.opts.capsule } as never);
    const next = (): void => {
      if (this.s && this.s.state !== "closed") this.startRound();
      else this.leave();
    };
    if (!entry || !this.game?.stack) return next();
    this.phase = "busy";
    Screens.push(this.game, "Gen2EvolutionAnim", {
      mon,
      entry,
      index: slot + 1,
      party: this.party,
      save: this.game.save,
      onDone: () => {
        this.game.stack.pop();
        try {
          this.game.writeSave?.();
        } catch {
          // as above
        }
        next();
      },
    });
  }

  // ------------------------------------------------------------- the screen

  private fill(text: string, subs: Record<string, string>): string {
    return Strings.get(text).replace(/\{(\w+)\}/g, (m, k: string) => subs[k] ?? m);
  }

  /** A message in the box, two rows a page, A or B to go on. */
  private say(text: string, then: () => void): void {
    const lines: string[] = [];
    for (const para of Strings.get(text).split("\v")) lines.push(...Chrome.wrap(para.replace(/\n/g, " "), 18));
    const pages: string[][] = [];
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2));
    this.message = { pages: pages.length ? pages : [[""]], page: 0, then };
    this.phase = "message";
  }

  update(_dt?: number): void {
    const input = this.game?.input;
    const s = this.s;
    if (this.phase === "done" || this.phase === "busy") return;
    if (this.phase === "message") {
      if (input?.wasPressed("a") || input?.wasPressed("b")) {
        const m = this.message!;
        if (++m.page >= m.pages.length) {
          this.message = null;
          m.then();
        }
      }
      return;
    }
    if (this.phase === "confirm") {
      const c = this.confirm!;
      if (input?.wasPressed("up") || input?.wasPressed("down")) c.yes = !c.yes;
      else if (input?.wasPressed("a")) {
        this.confirm = null;
        c.then(c.yes);
      } else if (input?.wasPressed("b")) {
        this.confirm = null;
        c.then(false);
      }
      return;
    }
    if (!s || s.state === "closed") return this.end(TEXT_CANCELED);
    if (this.phase === "exchange") {
      if (s.peerParty) return this.takeParty(s.peerParty);
      if (--this.waitFrames <= 0) {
        this.log("their party never came");
        return this.end(TEXT_CANCELED);
      }
      return;
    }
    if (this.phase === "await-answer" || this.phase === "await-commit") return;
    // pick: their offer first, if it came
    if (s.peerOffer) return this.answerOffer();
    const list = this.side === 0 ? this.party.length + 1 : this.theirs.length;
    const n = Math.max(1, list);
    if (input?.wasPressed("up")) this.index = (this.index + n - 1) % n;
    else if (input?.wasPressed("down")) this.index = (this.index + 1) % n;
    else if (input?.wasPressed("b")) {
      if (this.side === 1) {
        this.side = 0;
        this.index = this.chosenMine ?? 0;
        this.chosenMine = null;
      } else {
        s.answer(false);
        this.leave();
      }
    } else if (input?.wasPressed("a")) {
      if (this.side === 0) {
        if (this.index >= this.party.length) {
          s.answer(false);
          return this.leave();
        }
        const m = this.party[this.index];
        // the TIME CAPSULE took no party it cannot carry, but a Gen 2 mon met
        // since (none can be) would stop here
        if (this.opts.capsule && !TimeCapsule.isGen1Species(this.data, m?.species)) {
          return this.say(this.fill(TEXT_NONE, { MON: this.nameOf(m) }), () => {
            this.phase = "pick";
          });
        }
        this.chosenMine = this.index;
        this.side = 1;
        this.index = 0;
      } else {
        const theirs = this.theirs[this.index];
        if (!theirs) {
          return this.say(this.fill(TEXT_NONE, { MON: "That #MON" }), () => {
            this.phase = "pick";
          });
        }
        this.propose(this.chosenMine ?? 0, this.index);
      }
    }
  }

  private drawList(title: string, mons: any[], row: number, side: 0 | 1): void {
    Chrome.box(0, row - 1, 20, 8);
    Chrome.print(title.slice(0, 10), 1, row - 1);
    mons.slice(0, 6).forEach((m, i) => {
      const y = row + i;
      Chrome.print(m ? this.nameOf(m).slice(0, 10) : "-", 2, y);
      if (m) Chrome.printRight(`<LV>${m.level ?? 1}`, 19, y);
      if (this.phase === "pick" || this.phase === "confirm") {
        if (this.side === side && this.index === i) Chrome.cursor(1, y);
        else if (side === 0 && this.chosenMine === i) Chrome.cursor(1, y, true);
      }
    });
  }

  draw(): void {
    Chrome.clear();
    const s = this.s;
    const player = this.game?.save?.player ?? {};
    this.drawList(String(player.name ?? "GOLD"), this.party, MINE_ROW, 0);
    this.drawList(s?.peerName || "", this.theirs, THEIRS_ROW, 1);
    Chrome.print(Strings.get("CANCEL"), 2, CANCEL_ROW);
    if (this.phase === "pick" && this.side === 0 && this.index >= this.party.length) Chrome.cursor(1, CANCEL_ROW);
    // the box over the bottom: a message, the offer, or what is awaited
    let lines: string[] | null = null;
    if (this.phase === "message" && this.message) lines = this.message.pages[this.message.page] ?? [];
    else if (this.phase === "confirm" && this.confirm) lines = this.confirm.lines;
    else if (this.phase === "exchange" || this.phase === "await-answer" || this.phase === "await-commit") lines = [Strings.get(TEXT_WAIT)];
    else if (this.phase === "pick") Chrome.print(Strings.get(this.side === 0 ? TEXT_PICK_MINE : TEXT_PICK_THEIRS), 1, PROMPT_ROW);
    if (lines) {
      Chrome.box(0, 12, 20, 6);
      lines.slice(0, 2).forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
      if (this.phase === "message") Chrome.print("▼", 18, 17);
    }
    if (this.phase === "confirm" && this.confirm) {
      Chrome.box(14, 7, 6, 5);
      Chrome.print(Strings.get("YES"), 16, 8);
      Chrome.print(Strings.get("NO"), 16, 10);
      Chrome.cursor(15, this.confirm.yes ? 8 : 10);
    }
    G.setColor(1, 1, 1, 1);
  }
}

export default LinkTradeMenu;
