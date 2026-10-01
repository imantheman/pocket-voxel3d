// gen1recomp src/ui/gen2/DayCareMenu.lua (bdfac727, MIT): the Day-Care
// conversation -- deposit, withdraw, and the egg handover outside
// (engine/events/daycare.asm DayCareMan / DayCareLady / DayCareManOutside).
//
// There is no menu of the Day-Care's own on the cart: all three routines are
// PrintDayCareText + YesNoBox + SelectTradeOrDayCareMon, so this screen is a
// speech box, a yes/no box and a push of the party list -- a phase machine.
//
// THIS SCREEN DRAWS OVER THE LIVE MAP AND MUST NEVER CLEAR THE FIELD: both
// NPC scripts are `faceplayer / opentext / special DayCareMan / waitbutton /
// closetext`, and nothing the special reaches blanks the screen. Hence
// isOpaque = false, no drawsWidescreen, and no Chrome.clear in drawPanel.
//
//   Textbox        `lb bc, 4, 18` at (0,12) -- a 20x6 box, lines at rows 14
//                  and 16, TWO apart.
//   YesNoBox       `lb bc, SCREEN_WIDTH - 6, 7` -- a 6x5 box at (14,7); YES at
//                  (16,8), NO at (16,10), cursor column 15.
//   LoadBlinkingCursor  the ▼ at (18,17) while a page waits for a button.
//
// The party list is Screens ("Gen2PartyMenu") with PARTYMENUACTION_GIVE_MON
// (ChooseAMonString, the plain "Choose a #MON." prompt).
//
// Strings are transcribed from data/text/common_1.asm's _DayCare* / _Breed*
// block, paired with their pokegold label in LABELS; the cache's own
// characters win when seeded. The MODEL is core/Breeding.ts.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Breeding } from "../core/Breeding.ts";
import { CommonText } from "../core/CommonText.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { Typer } from "./Typer.ts";
import type { TyperPage } from "./Typer.ts";

type Page = string[];
type Pages = Page[];

export interface DayCareMenuOpts {
  save?: any;
  side?: "man" | "lady" | "outside" | string;
  text?: any;
  rng?: any;
  onClose?: (scriptVar: number) => void;
}

// Lua: DayCareMenu.lua:63 -- charmap.asm's currency glyph and the
// text-advance arrow, matched by Font.split's charmap.
const YEN = "¥";
const DOWN_ARROW = "▼";

// Lua: DayCareMenu.lua:67 ------------------------------------------ layout
const TEXT_BOX_X = 0, TEXT_BOX_Y = 12, TEXT_BOX_W = 20, TEXT_BOX_H = 6;
const TEXT_X = 1, TEXT_Y = 14, TEXT_LINE = 2;
const ARROW_X = 18, ARROW_Y = 17;

const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;

// Lua: DayCareMenu.lua:79 -- SFX_TRANSACTION rings in RetrieveMonFromDayCareMan
// BEFORE the money is taken; SFX_GET_EGG right after the egg lands.
const SFX_TRANSACTION = "Sfx_Transaction";
const SFX_GET_EGG = "Sfx_GetEgg";

// Lua: DayCareMenu.lua:85 -- `ld c, 120 / call DelayFrames` between
// _ReceivedEggText and _TakeGoodCareOfEggText.
const GET_EGG_FRAMES = 120;

const page = (...lines: string[]): Page => lines;
const pages = (...ps: Page[]): Pages => ps;

export interface DayCareText {
  manIntro: Pages;
  manIntroEgg: Pages;
  ladyIntro: Pages;
  ladyIntroEgg: Pages;
  whichOne: Pages;
  lastMon: Pages;
  cantAcceptEgg: Pages;
  removeMail: Pages;
  lastAliveMon: Pages;
  partyFull: Pages;
  notEnoughMoney: Pages;
  ohFine: Pages;
  comeAgain: Pages;
  comeBackLater: Pages;
  deposit: (name: string) => Pages;
  geniuses: (name: string) => Pages;
  hasGrown: (name: string, grown: number, price: number) => Pages;
  backAlready: (name: string) => Pages;
  withdraw: Pages;
  gotBack: (player: string, name: string) => Pages;
  notYet: Pages;
  foundAnEgg: Pages;
  receivedEgg: (player: string) => Pages;
  takeGoodCare: Pages;
  illKeepIt: Pages;
  noRoomForEgg: Pages;
}

// Lua: DayCareMenu.lua:95 -- a page is one screenful of up to two lines; a
// `cont` shows as a page whose first line is the previous page's second.
const TEXT: DayCareText = {
  // _DayCareManIntroText / _DayCareManIntroEggText (the LONGER first-meeting
  // script, picked the one time DAYCARE_INTRO_SEEN_F is clear).
  manIntro: pages(
    page("I'm the DAY-CARE", "MAN. Want me to"),
    page("MAN. Want me to", "raise a #MON?")),
  manIntroEgg: pages(
    page("I'm the DAY-CARE", "MAN. Do you know"),
    page("MAN. Do you know", "about EGGS?"),
    page("I was raising", "#MON with my"),
    page("#MON with my", "wife, you see."),
    page("We were shocked to", "find an EGG!"),
    page("How incredible is", "that?"),
    page("So, want me to", "raise a #MON?")),
  ladyIntro: pages(
    page("I'm the DAY-CARE", "LADY."),
    page("Should I raise a", "#MON for you?")),
  ladyIntroEgg: pages(
    page("I'm the DAY-CARE", "LADY. Do you know"),
    page("LADY. Do you know", "about EGGS?"),
    page("My husband and I", "were raising some"),
    page("were raising some", "#MON, you see."),
    page("We were shocked to", "find an EGG!"),
    page("How incredible", "could that be?"),
    page("Should I raise a", "#MON for you?")),

  // DAYCARETEXT_WHICH_ONE, a `prompt`.
  whichOne: pages(page("What should I", "raise for you?")),

  // DayCareAskDepositPokemon's refusals, keyed by Breeding.REFUSE_*.
  lastMon: pages(page("Oh? But you have", "just one #MON.")),
  cantAcceptEgg: pages(page("Sorry, but I can't", "accept an EGG.")),
  removeMail: pages(page("Remove MAIL before", "you come see me.")),
  lastAliveMon: pages(
    page("If you give me", "that, what will"),
    page("that, what will", "you battle with?")),
  partyFull: pages(page("You have no room", "for it.")),
  notEnoughMoney: pages(page("You don't have", "enough money.")),
  ohFine: pages(page("Oh, fine then.")),
  comeAgain: pages(page("Come again.")),
  comeBackLater: pages(page("Come back for it", "later.")),

  // _IllRaiseYourMonText: the nickname is a text_ram field, spliced in.
  deposit: (name) => pages(page("OK. I'll raise", format("your %s.", name))),
  geniuses: (name) => pages(
    page("Are we geniuses or", "what? Want to see"),
    page("what? Want to see", format("your %s?", name))),
  // _YourMonHasGrownText: both decimals LEFTALIGN, so neither is padded.
  hasGrown: (name, grown, price) => pages(
    page(format("Your %s", name), "has grown a lot."),
    page("By level, it's", format("grown by %d.", grown)),
    page("If you want your", "#MON back, it"),
    page("#MON back, it", format("will cost %s%d.", YEN, price))),
  // _BackAlreadyText: its price is a LITERAL ¥100 in the string.
  backAlready: (name) => pages(
    page("Huh? Back already?", format("Your %s", name)),
    page("needs a little", "more time with us."),
    page("If you want your", "#MON back, it"),
    page("#MON back, it", format("will cost %s100.", YEN))),
  withdraw: pages(page("Perfect! Here's", "your #MON.")),
  gotBack: (player, name) => pages(page(format("%s got back", player), format("%s.", name))),

  // DayCareManOutside.
  notYet: pages(page("Not yet…")),
  foundAnEgg: pages(
    page("Ah, it's you!"),
    page("We were raising", "your #MON, and"),
    page("my goodness, were", "we surprised!"),
    page("Your #MON had", "an EGG!"),
    page("We don't know how", "it got there, but"),
    page("your #MON had", "it. You want it?")),
  receivedEgg: (player) => pages(page(format("%s received", player), "the EGG!")),
  takeGoodCare: pages(page("Take good care of", "it.")),
  illKeepIt: pages(page("Well then, I'll", "keep it. Thanks!")),
  noRoomForEgg: pages(
    page("You have no room", "in your party."),
    page("in your party.", "Come back later.")),
};

// Lua: DayCareMenu.lua:203 -- the data/text/common_1.asm label of each entry.
const LABELS: Record<keyof DayCareText, string> = {
  manIntro: "_DayCareManIntroText",
  manIntroEgg: "_DayCareManIntroEggText",
  ladyIntro: "_DayCareLadyIntroText",
  ladyIntroEgg: "_DayCareLadyIntroEggText",
  whichOne: "_WhatShouldIRaiseText",
  lastMon: "_OnlyOneMonText",
  cantAcceptEgg: "_CantAcceptEggText",
  removeMail: "_RemoveMailText",
  lastAliveMon: "_LastHealthyMonText",
  partyFull: "_HaveNoRoomText",
  notEnoughMoney: "_NotEnoughMoneyText",
  ohFine: "_OhFineThenText",
  comeAgain: "_ComeAgainText",
  comeBackLater: "_ComeBackLaterText",
  deposit: "_IllRaiseYourMonText",
  geniuses: "_AreWeGeniusesText",
  hasGrown: "_YourMonHasGrownText",
  backAlready: "_BackAlreadyText",
  withdraw: "_PerfectHeresYourMonText",
  gotBack: "_GotBackMonText",
  notYet: "_NotYetText",
  foundAnEgg: "_FoundAnEggText",
  receivedEgg: "_ReceivedEggText",
  takeGoodCare: "_TakeGoodCareOfEggText",
  illKeepIt: "_IllKeepItThanksText",
  noRoomForEgg: "_NoRoomForEggText",
};

// Lua: DayCareMenu.lua:238 -- the arguments in the order each string names
// its markers.
const FILL: Partial<Record<keyof DayCareText, (...a: any[]) => any>> = {
  deposit: (name: string) => [name],
  geniuses: (name: string) => [name],
  hasGrown: (name: string, grown: number, price: number) => [name, grown, price],
  backAlready: (name: string) => [name],
  gotBack: (player: string, name: string) => Object.assign([name], { player }),
  receivedEgg: (player: string) => ({ player }),
};

/** Lua: DayCareMenu.lua:250 -- TEXT with every seeded entry replaced. */
function extractedText(text: any): DayCareText {
  const out: any = { ...TEXT };
  for (const key of Object.keys(LABELS) as (keyof DayCareText)[]) {
    const list = CommonText.of(text, LABELS[key]);
    if (list) {
      const fill = FILL[key];
      if (fill) out[key] = (...a: any[]) => CommonText.fill(list, fill(...a));
      else out[key] = list;
    }
  }
  return out as DayCareText;
}

/** Lua: DayCareMenu.lua:270 -- the nickname the text_ram fields splice in. */
function monName(mon: any): string {
  if (!mon) return "#MON";
  return mon.nickname || mon.name || mon.species || "#MON";
}

interface Message {
  pages: TyperPage[];
  page: number;
  onDone?: () => void;
  [key: string]: unknown;
}

interface Confirm {
  pages: TyperPage[];
  page: number;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export class DayCareMenu {
  // Lua: DayCareMenu.lua:58
  static isOpaque = false;
  isOpaque = false;

  static TEXT = TEXT;
  static LABELS = LABELS;

  game: any;
  save: any;
  data: any;
  textData: any;
  TEXT: DayCareText;
  side: string;
  onClose?: (scriptVar: number) => void;
  rng: any;
  scriptVar: number;
  delay: number;
  message: Message | null = null;
  confirm: Confirm | null = null;
  typer: Typer | undefined;
  picking?: boolean;
  grown?: number;
  price?: number;
  [key: string]: any;

  /** Lua: DayCareMenu.lua:266 */
  wantsFillScale(): boolean {
    return true;
  }

  /**
   * Lua: DayCareMenu.lua:277 -- opts: save, side ("man" | "lady" |
   * "outside"), text (text.lua), onClose(scriptVar)
   */
  static new(game: any, opts?: DayCareMenuOpts): DayCareMenu {
    return new DayCareMenu(game, opts ?? {});
  }

  constructor(game: any, opts: DayCareMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.data = (game && game.data) || {};
    // text.lua rides on the world: this screen is pushed over the overworld.
    this.textData = opts.text || (game && game.world && game.world.text);
    this.TEXT = extractedText(this.textData);
    this.side = opts.side || "man";
    this.onClose = opts.onClose;
    this.rng = opts.rng;
    // wScriptVar: only DayCareManOutside writes one; TRUE = "no room, ask again".
    this.scriptVar = 0;
    this.delay = 0;

    if (this.side === "outside") this.startOutside();
    else if ((Breeding.side(this.save, this.side) || ({} as any)).mon) this.startWithdraw();
    else this.startIntro();
  }

  // -------------------------------------------------------------- overlays

  /**
   * Lua: DayCareMenu.lua:310 -- PrintText plus the button wait every string
   * ends on (pokecrystal daycare.asm:262 PrintDayCareText).
   */
  say(list: Pages | undefined, onDone?: () => void): void {
    Typer.say(this, list, onDone);
  }

  /** Lua: DayCareMenu.lua:315 */
  ask(list: Pages | undefined, onYes?: () => void, onNo?: () => void): void {
    this.confirm = { pages: list || [], page: 1, choice: 1, onYes, onNo };
    Typer.begin(this, this.confirm);
  }

  /** Lua: DayCareMenu.lua:321 */
  close(): void {
    if (this.onClose) this.onClose(this.scriptVar);
  }

  /** Lua: DayCareMenu.lua:326 -- `.print_text` then `.cancel`. */
  refuse(key: string | undefined): void {
    const list = ((key != null && (this.TEXT as any)[key]) || this.TEXT.ohFine) as Pages;
    this.say(list, () => this.comeAgain());
  }

  /** Lua: DayCareMenu.lua:331 */
  comeAgain(): void {
    this.say(this.TEXT.comeAgain, () => this.close());
  }

  /** Lua: DayCareMenu.lua:335 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: DayCareMenu.lua:344 -- PlayMonCry, silent without an extracted cry. */
  playCry(species: string | undefined): void {
    if (!species) return;
    const cries = this.data.audio && this.data.audio.cries;
    if (cries && cries[species]) Sound.playCry(this.data, species);
  }

  // ----------------------------------------------------------------- intro

  /**
   * Lua: DayCareMenu.lua:356 -- DayCareIntroText. Declining goes straight to
   * `.cancel`: COME_AGAIN with no "Oh, fine then." in front of it.
   */
  startIntro(): void {
    const first = Breeding.takeIntro(this.save, this.side);
    const lady = this.side === "lady";
    let list: Pages;
    if (lady) list = first ? this.TEXT.ladyIntroEgg : this.TEXT.ladyIntro;
    else list = first ? this.TEXT.manIntroEgg : this.TEXT.manIntro;
    this.ask(list, () => this.askDeposit(), () => this.comeAgain());
  }

  /** Lua: DayCareMenu.lua:369 */
  askDeposit(): void {
    const [ok, reason] = Breeding.canOpenDeposit(this.save);
    if (!ok) return this.refuse(reason);
    this.say(this.TEXT.whichOne, () => this.openParty());
  }

  /** Lua: DayCareMenu.lua:375 */
  openParty(): void {
    const game = this.game;
    // No stack means no party list; back out the way cancelling it does.
    if (!(game && game.stack)) return this.comeAgain();
    this.picking = true;
    Screens.push(game, "Gen2PartyMenu", {
      party: this.save.party,
      // PARTYMENUACTION_GIVE_MON's PartyMenuStrings row is ChooseAMonString.
      prompt: "choose",
      onChoose: (index: number) => {
        game.stack.pop();
        this.picking = false;
        this.chose(index);
      },
      onCancel: () => {
        game.stack.pop();
        this.picking = false;
        // .Declined
        this.refuse("ohFine");
      },
    });
  }

  /** Lua: DayCareMenu.lua:399 -- index is the 1-based party slot. */
  chose(index: number): void {
    const [ok, reason] = Breeding.canDeposit(this.data, this.save, this.side, index);
    if (!ok) return this.refuse(reason);
    const [, mon] = Breeding.deposit(this.data, this.save, this.side, index, { rng: this.rng } as any);
    const m: any = mon;
    // DayCare_DepositPokemonText: the line, the cry, then COME_BACK_LATER.
    // The deposit path `ret`s: deliberately no COME_AGAIN after it.
    this.say(this.TEXT.deposit(monName(m)), () => {
      this.playCry(m && m.species);
      this.say(this.TEXT.comeBackLater, () => this.close());
    });
  }

  // -------------------------------------------------------------- withdraw

  /**
   * Lua: DayCareMenu.lua:417 -- DayCare_AskWithdrawBreedMon: no growth is ONE
   * yes/no over _BackAlreadyText; any growth is TWO.
   */
  startWithdraw(): void {
    const slot = Breeding.side(this.save, this.side);
    const [, , grown] = Breeding.levelGrowth(this.data, slot);
    const price = Breeding.retrievePrice(grown);
    const name = monName(slot && slot.mon);
    this.grown = grown;
    this.price = price;
    const decline = () => this.refuse("ohFine");
    if (grown === 0) {
      this.ask(this.TEXT.backAlready(name), () => this.takeMon(), decline);
      return;
    }
    this.ask(this.TEXT.geniuses(name), () => {
      this.ask(this.TEXT.hasGrown(name, grown, price), () => this.takeMon(), decline);
    }, decline);
  }

  /** Lua: DayCareMenu.lua:434 */
  takeMon(): void {
    const [ok, reason] = Breeding.canWithdraw(this.data, this.save, this.side);
    if (!ok) return this.refuse(reason);
    // RetrieveMonFromDayCareMan rings the till BEFORE the money changes hands.
    this.playSfx(SFX_TRANSACTION);
    const [, mon] = Breeding.withdraw(this.data, this.save, this.side);
    const m: any = mon;
    const player = (this.save.player && this.save.player.name) || "<PLAYER>";
    this.say(this.TEXT.withdraw, () => {
      this.playCry(m && m.species);
      this.say(this.TEXT.gotBack(player, monName(m)), () => this.comeAgain());
    });
  }

  // --------------------------------------------------------------- outside

  /**
   * Lua: DayCareMenu.lua:456 -- DayCareManOutside. The party-space check
   * happens AFTER the yes.
   */
  startOutside(): void {
    const dc = Breeding.dayCare(this.save);
    if (!(dc && dc.hasEgg)) return this.say(this.TEXT.notYet, () => this.close());
    this.ask(this.TEXT.foundAnEgg, () => this.takeEgg(), () => {
      // .Declined -> .Load0: wScriptVar stays FALSE and he keeps the egg.
      this.say(this.TEXT.illKeepIt, () => this.close());
    });
  }

  /** Lua: DayCareMenu.lua:467 */
  takeEgg(): void {
    const [ok, reason] = Breeding.collectEgg(this.data, this.save, { rng: this.rng } as any);
    if (!ok) {
      // .PartyFull is the ONE branch that sets wScriptVar to TRUE.
      if (reason === Breeding.REFUSE_PARTY_FULL) this.scriptVar = 1;
      return this.say(this.TEXT.noRoomForEgg, () => this.close());
    }
    const player = (this.save.player && this.save.player.name) || "<PLAYER>";
    this.say(this.TEXT.receivedEgg(player), () => {
      this.playSfx(SFX_GET_EGG);
      this.delay = GET_EGG_FRAMES;
      this.say(this.TEXT.takeGoodCare, () => this.close());
    });
  }

  // ---------------------------------------------------------------- update

  /** Lua: DayCareMenu.lua:485 */
  updateMessage(input: any): void {
    Typer.step(this);
    if (Typer.typing(this)) return;
    if (!(input.wasPressed("a") || input.wasPressed("b"))) return;
    const message = this.message!;
    if (message.page < message.pages.length) {
      Typer.turn(this, message);
      return;
    }
    this.message = null;
    if (message.onDone) message.onDone();
  }

  /** Lua: DayCareMenu.lua:498 */
  updateConfirm(input: any): void {
    const confirm = this.confirm!;
    Typer.step(this);
    if (Typer.typing(this)) return;
    // The yes/no box only comes up on the string's LAST page.
    if (confirm.page < confirm.pages.length) {
      if (input.wasPressed("a") || input.wasPressed("b")) Typer.turn(this, confirm);
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      confirm.choice = confirm.choice === 1 ? 2 : 1;
      return;
    }
    // YesNoMenuHeader has no STATICMENU_DISABLE_B, so B is NO.
    if (input.wasPressed("b")) {
      this.confirm = null;
      if (confirm.onNo) confirm.onNo();
      return;
    }
    if (input.wasPressed("a")) {
      const yes = confirm.choice === 1;
      this.confirm = null;
      if (yes) {
        if (confirm.onYes) confirm.onYes();
      } else if (confirm.onNo) {
        confirm.onNo();
      }
    }
  }

  /** Lua: DayCareMenu.lua:530 */
  update(_dt?: number): void {
    // The party list is on top of the stack; it owns input until it pops.
    if (this.picking) return;
    if (this.delay > 0) {
      this.delay = this.delay - 1;
      return;
    }
    const input = this.game && this.game.input;
    if (!input) return;
    if (this.message) return this.updateMessage(input);
    if (this.confirm) return this.updateConfirm(input);
  }

  // ------------------------------------------------------------------ draw

  /** Lua: DayCareMenu.lua:545 */
  drawTextBox(lines: TyperPage | string[] | null | undefined): void {
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    const list: string[] = lines == null ? [] : typeof lines === "string" ? lines.split("\n") : lines;
    list.forEach((line, i) => {
      Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
    });
  }

  /** Lua: DayCareMenu.lua:552 */
  drawYesNo(choice: number): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (choice === 1 ? 1 : 3));
  }

  /** Lua: DayCareMenu.lua:560 -- pokecrystal engine/events/daycare.asm:107 */
  yesNoVisible(): boolean {
    const confirm = this.confirm;
    if (!confirm || confirm.page < confirm.pages.length) return false;
    return !Typer.typing(this);
  }

  /** Lua: DayCareMenu.lua:566 */
  drawPanel(): void {
    const typed = this.typer == null || this.typer.done();
    if (this.message) {
      this.drawTextBox(Typer.text(this, this.message.pages[this.message.page - 1]) as any);
      if (typed && this.message.page < this.message.pages.length && Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
      }
    } else if (this.confirm) {
      this.drawTextBox(Typer.text(this, this.confirm.pages[this.confirm.page - 1]) as any);
      if (this.yesNoVisible()) {
        this.drawYesNo(this.confirm.choice);
      } else if (typed && Typer.arrowOn(this)) {
        Chrome.print(DOWN_ARROW, ARROW_X, ARROW_Y);
      }
    } else {
      this.drawTextBox(null);
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: DayCareMenu.lua:587 */
  draw(): void {
    this.drawPanel();
  }
}

export default DayCareMenu;
