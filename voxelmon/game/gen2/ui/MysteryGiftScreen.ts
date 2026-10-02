// The main menu's MYSTERY GIFT (engine/menus/main_menu.asm MysteryGift:
// DoMysteryGiftIfDayHasPassed, then DoMysteryGift). The cart's "Press A to
// link IR-Device" screen, over the wireless link instead of infrared:
//
//   prompt   A opens a session in the "gift" mode (only another console at
//            its own MYSTERY GIFT screen answers it); B leaves
//   linking  both records cross (core/MysteryGift.ts stage); B cancels
//   message  the outcome (receive), the save written, then A or B leaves
//
// The cart beams the two records and keeps retrying until one side presses
// B; so does this.

import { Chrome } from "./Chrome.ts";
import { Strings } from "../shared/core/Strings.ts";
import { MysteryGift, type GiftRecord, type GiftResult } from "../core/MysteryGift.ts";
import { Decorations } from "../core/Decorations.ts";
import { Save } from "../core/Save.ts";
import { CableClub } from "../core/CableClub.ts";
import { hostTransport, LinkSession } from "../../world/link.ts";
import G from "../platform/screen.ts";

const TEXT = {
  prompt: Strings.source("Press A to\nlink by wireless\nPress B to\ncancel it."),
  linking: Strings.source("Linking…\nPress B to\ncancel it."),
  canceled: Strings.source("The link has been\ncancelled."),
  noCarrier: Strings.source("Communication\nerror."),
  fiveADay: Strings.source("Sorry--only five\nGIFTS a day."),
  oneADay: Strings.source("Sorry. One GIFT\na day per person."),
  giftWaiting: Strings.source("Must retrieve GIFT\nat #MON CENTER."),
  friendNotReady: Strings.source("Your friend isn't\nready."),
  sent: Strings.source("%s sent\n%s."),
  sentHome: Strings.source("%s sent\n%s"),
  home: Strings.source("%s\nto %s's home."),
};

export interface MysteryGiftOpts {
  save: any;
  onClose?: () => void;
}

export class MysteryGiftScreen {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;
  screenId = "Gen2MysteryGift";

  game: any;
  save: any;
  onClose?: () => void;
  phase: "prompt" | "linking" | "message" = "prompt";
  session: LinkSession | null = null;
  mine: GiftRecord | null = null;
  theirs: GiftRecord | null = null;
  sent = false;
  result: GiftResult | null = null;
  pages: string[] = [];
  page = 0;
  /** Frames to let the last record's acknowledgement settle before closing. */
  linger = 0;
  done = false;

  wantsFillScale(): boolean {
    return true;
  }

  static new(game: any, opts: MysteryGiftOpts): MysteryGiftScreen {
    const self = new MysteryGiftScreen();
    self.game = game;
    self.save = opts.save;
    self.onClose = opts.onClose;
    MysteryGift.dayPassed(self.save);
    return self;
  }

  private log(m: string): void {
    if ((globalThis as { voxel?: unknown }).voxel || (globalThis as { linkLog?: boolean }).linkLog) {
      console.log(`[pv] mystery gift: ${m}`);
    }
  }

  private show(pages: string[]): void {
    this.phase = "message";
    this.pages = pages;
    this.page = 0;
  }

  private open(): void {
    const t = CableClub.transport ? CableClub.transport() : hostTransport();
    if (!t) {
      this.log("no carrier");
      this.show([Strings.get(TEXT.noCarrier)]);
      return;
    }
    const name = String(this.save?.player?.name ?? "GOLD");
    this.session = new LinkSession(t, name, undefined, { game: "gold", gen: 2, mode: "gift" }, true);
    this.session.open();
    this.mine = MysteryGift.stage(this.save, this.game?.data);
    this.theirs = null;
    this.sent = false;
    this.phase = "linking";
    this.log(`open; staged item ${this.mine.whichItem} deco ${this.mine.whichDeco} (${this.mine.sentDeco ? "deco" : "item"})`);
  }

  private close(): void {
    if (this.session && this.session.state !== "closed") this.session.cancel();
    this.session = null;
  }

  private itemName(id: string): string {
    const def = this.game?.data?.items?.[id];
    return def?.name ?? id;
  }

  private decoName(flag: number): string {
    const pokemon = this.game?.data?.pokemon ?? {};
    return Decorations.name(Decorations.idForFlag(flag), (s: string) => pokemon[s]?.name ?? s);
  }

  /** The exchange is done: the cart's checks, the save, the words. */
  private finish(): void {
    const mine = this.mine!;
    const theirs = this.theirs!;
    const r = MysteryGift.receive(this.save, mine, theirs, this.game?.data);
    this.result = r;
    this.log(`from ${theirs.name} (${theirs.id}): ${r.kind}${r.kind === "item" ? ` ${r.item}` : r.kind === "deco" ? ` deco ${r.deco}` : ""}`);
    if (r.kind === "deco") MysteryGift.giveDecoration(this.save, r.deco);
    if (r.kind === "item" || r.kind === "deco") {
      const [ok] = Save.save(this.save);
      if (!ok) this.log("the save was refused");
    }
    const me = String(this.save?.player?.name ?? "?");
    switch (r.kind) {
      case "fiveADay": return this.show([Strings.get(TEXT.fiveADay)]);
      case "oneADay": return this.show([Strings.get(TEXT.oneADay)]);
      case "giftWaiting": return this.show([Strings.get(TEXT.giftWaiting)]);
      case "friendNotReady": return this.show([Strings.get(TEXT.friendNotReady)]);
      case "item": return this.show([Strings.get(TEXT.sent, r.partner, this.itemName(r.item))]);
      case "deco": {
        const name = this.decoName(r.deco);
        return this.show([Strings.get(TEXT.sentHome, r.partner, name), Strings.get(TEXT.home, name, me)]);
      }
    }
  }

  private leave(): void {
    if (this.done) return;
    this.done = true;
    this.close();
    this.onClose?.();
  }

  update(_dt?: number): void {
    const input = this.game?.input;
    if (!input || this.done) return;
    if (this.phase === "prompt") {
      if (input.wasPressed("a")) this.open();
      else if (input.wasPressed("b")) this.leave();
      return;
    }
    if (this.phase === "linking") {
      const s = this.session;
      if (!s) return;
      if (input.wasPressed("b")) {
        this.close();
        this.show([Strings.get(TEXT.canceled)]);
        return;
      }
      s.poll();
      if (s.state === "closed" && !this.theirs) {
        const a = s.takeAction() as { t?: string; d?: GiftRecord } | null;
        if (a && a.t === "gift" && a.d && typeof a.d.id === "number") this.theirs = a.d;
      }
      if (s.state === "closed" && this.theirs) {
        // they closed with both records across (a side closes only then)
        this.session = null;
        this.finish();
        return;
      }
      if (s.state === "closed") {
        // the other console left: the cart starts over (.CommunicationError
        // jumps back into DoMysteryGift); here the session is opened again
        this.log("the link closed; again");
        this.session = null;
        this.open();
        return;
      }
      if (s.peerIdent && !this.sent) {
        s.sendAction({ t: "gift", d: this.mine });
        this.sent = true;
      }
      if (!this.theirs) {
        const a = s.takeAction() as { t?: string; d?: GiftRecord } | null;
        if (a && a.t === "gift" && a.d && typeof a.d === "object" && typeof a.d.id === "number") {
          this.theirs = a.d;
          this.linger = 30;
        }
      }
      // both records across (theirs here, mine acknowledged), then a moment
      // for the acknowledgement of theirs to reach them
      if (this.theirs && this.sent && s.unacked() === 0 && --this.linger <= 0) {
        this.close();
        this.finish();
      }
      return;
    }
    if (input.wasPressed("a") || input.wasPressed("b")) {
      if (this.page < this.pages.length - 1) this.page++;
      else this.leave();
    }
  }

  drawPanel(): void {
    Chrome.clear();
    G.setColor(1, 1, 1, 1);
    Chrome.box(0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);
    Chrome.print(Strings.get("MYSTERY GIFT"), 4, 2);
    if (this.phase === "message") {
      Chrome.box(0, 12, 20, 6);
      const lines = (this.pages[this.page] ?? "").split("\n");
      lines.slice(0, 2).forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
      return;
    }
    // hlcoord 3, 8: .String_PressAToLink_BToCancel
    const text = Strings.get(this.phase === "linking" ? TEXT.linking : TEXT.prompt);
    text.split("\n").forEach((l, i) => Chrome.print(l, 3, 8 + i));
  }

  draw(): void {
    this.drawPanel();
  }

  drawsWidescreen(): boolean {
    return true;
  }

  drawWidescreen(_winW: number, _winH: number): void {
    G.setColor(1, 1, 1, 1);
    G.push();
    G.origin();
    this.drawPanel();
    G.pop();
  }
}
