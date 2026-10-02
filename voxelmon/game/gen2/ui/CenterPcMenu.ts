// gen1recomp src/ui/gen2/CenterPcMenu.lua (bdfac727, MIT): the Pokemon
// Center PC's whose-PC menu (engine/events/pokecenter_pc.asm
// PokemonCenterPC).  Every Pokecenter reaches it the same way: the PC is a
// COLL_PC tile, the A press runs PCScript (engine/events/std_scripts.asm) and
// its `special PokemonCenterPC` opens this screen through World.openPc.
//
// .ChooseWhichPCListToUse picks the row list:
//
//   PCPC_BEFORE_POKEDEX  BILL's PC / <PLAYER>'s PC / TURN OFF
//   PCPC_BEFORE_HOF      + PROF.OAK's PC        (CheckReceivedDex)
//   PCPC_POSTGAME        + HALL OF FAME         (wHallOfFameCount > 0)
//
// BILL's PC opens the storage system (ui/PcMenu.ts, _BillsPC's own five
// rows), <PLAYER>'s PC the item PC (ui/ItemPcMenu.ts, PLAYERSPC_NORMAL),
// PROF.OAK's PC the #DEX rating (ProfOaksPC, engine/events/prof_oaks_pc.asm)
// and HALL OF FAME the roster viewer (ui/HallOfFame.ts "view" mode).

import G from "../platform/screen.ts";
import { tostring } from "../platform/lua.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Specials } from "../script/Specials.ts";
import { Chrome } from "./Chrome.ts";
import { Typer, type TyperRecord } from "./Typer.ts";

/** A page of at most two lines; `sfx` plays the moment it comes up. */
type Page = string[] & { sfx?: string; scrolled?: boolean };

interface Confirm {
  prompt: Page | undefined;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export interface CenterPcMenuOpts {
  save?: any;
  events?: any;
  items?: any;
  house?: any;
  onClose?: (changed?: any) => void;
}

// Lua: CenterPcMenu.lua:34 -- ENGINE_POKEDEX (constants/engine_flags.asm,
// index 11): the flag CheckReceivedDex reads.  The port lands plain ENGINE_*
// ids on save.engineFlags (World:setEngineFlag).
const ENGINE_POKEDEX = 11;

// Lua: CenterPcMenu.lua:39 -- text owned by PokemonCenterPC/ProfOaksPC.
const TEXT = {
  // data/text/common_2.asm:725 _PokecenterPCCantUseText ends in `cont`.
  noMon: Strings.source("Bzzzzt! You must\nhave a #MON to\vuse this!"),
  turnedOn: Strings.source("{PLAYER} turned on\nthe PC."),
  billsPc: Strings.source("BILL's PC"),
  playersPc: Strings.source("%s's PC"),
  oaksPc: Strings.source("PROF.OAK's PC"),
  hallOfFame: Strings.source("HALL OF FAME"),
  turnOff: Strings.source("TURN OFF"),
  oakClosed: Strings.source("The link to PROF.\nOAK's PC closed."),
  linkClosed: Strings.source("…\nLink closed…"),
  billsOpened: Strings.source("BILL's PC\naccessed.\n\n#MON Storage\nSystem opened."),
  ownOpened: Strings.source("Accessed own PC.\n\nItem Storage\nSystem opened."),
  oakOpened: Strings.source("PROF.OAK's PC\naccessed.\n\n#DEX Rating\nSystem opened."),
  rateDex: Strings.source("Want to get your\n#DEX rated?"),
  accessWhose: Strings.source("Access whose PC?"),
};

/**
 * Lua: CenterPcMenu.lua:67 -- `\f` = para (home/text.asm:403 Paragraph),
 * `\v` = cont (home/text.asm:442 _ContTextNoPause); two rows to a page
 * (constants/text_constants.asm:32).
 */
export function pagesOf(body: unknown): Page[] {
  const pages: Page[] = [];
  const chunks = (tostring(body) + "\f").split("\f");
  chunks.pop(); // gmatch("(.-)\f") never yields the tail after the last \f
  for (const chunk of chunks) {
    const flat: Array<[string, boolean]> = [];
    let pos = 0;
    let scrolled = false;
    for (;;) {
      const rel = chunk.slice(pos).search(/[\n\v]/);
      const brk = rel >= 0 ? pos + rel : -1;
      const line = brk >= 0 ? chunk.slice(pos, brk) : chunk.slice(pos);
      if (line !== "") flat.push([line, scrolled]);
      if (brk < 0) break;
      scrolled = chunk[brk] === "\v";
      pos = brk + 1;
    }
    let page: Page | undefined;
    for (const entry of flat) {
      if (!page) {
        page = [entry[0]];
        pages.push(page);
      } else if (entry[1]) {
        page = [page[page.length - 1]!, entry[0]];
        pages.push(page);
      } else if (page.length >= 2) {
        page = [entry[0]];
        pages.push(page);
      } else {
        page.push(entry[0]);
      }
    }
  }
  return pages;
}

/** Lua: CenterPcMenu.lua:98 */
function translatedPages(source: string, ...args: unknown[]): Page[] {
  return pagesOf(Strings.get(source, ...args));
}

export class CenterPcMenu {
  // Lua: CenterPcMenu.lua:28 -- ../pokecrystal/engine/events/pokecenter_pc.asm:15
  static isOpaque = false;
  isOpaque = false;
  // Lua: CenterPcMenu.lua:368
  static ENGINE_POKEDEX = ENGINE_POKEDEX;

  game: any;
  save: any;
  items: any;
  data: any;
  events: any;
  onClose?: (changed?: any) => void;
  index: number;
  message: TyperRecord | undefined;
  confirm: Confirm | undefined;
  closed: boolean;
  booted: boolean;
  entries: Array<{ id: string; label: string }> = [];
  [key: string]: any;

  /** Lua: CenterPcMenu.lua:63 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: CenterPcMenu.lua:103 -- opts: save, events, items (items.lua), onClose() */
  static new(game: any, opts?: CenterPcMenuOpts): CenterPcMenu {
    return new CenterPcMenu(game, opts ?? {});
  }

  constructor(game: any, opts: CenterPcMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.items = opts.items || (game && game.data && game.data.items);
    this.data = game && game.data;
    this.events = opts.events;
    this.onClose = opts.onClose;
    this.index = 1;
    this.message = undefined;
    this.confirm = undefined;
    this.closed = false;
    this.booted = false;
    this.buildEntries();
    const party = this.save && this.save.party;
    if (!(party && party.length > 0)) {
      // PC_CheckPartyForPokemon: SFX_CHOOSE_PC_OPTION, the refusal, and the
      // PC never boots (`ret c` before PC_PlayBootSound).
      this.playSfx("Sfx_ChoosePcOption");
      this.say(translatedPages(TEXT.noMon), () => this.close());
    } else {
      // PC_PlayBootSound + _PokecenterPCTurnOnText.
      this.playSfx("Sfx_BootPc");
      // ../pokecrystal/engine/events/pokecenter_pc.asm:22
      this.say(translatedPages(TEXT.turnedOn), () => {
        this.booted = true;
      });
    }
  }

  /** Lua: CenterPcMenu.lua:136 */
  playSfx(name: string): void {
    const data = this.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: CenterPcMenu.lua:144 */
  playerName(): string {
    const player = this.save && this.save.player;
    return (player && player.name) || "GOLD";
  }

  /**
   * Lua: CenterPcMenu.lua:151 -- .WhichPC, gated the way
   * .ChooseWhichPCListToUse gates it.  TURN OFF is always last.
   */
  buildEntries(): void {
    const save = this.save;
    const hasDex = save && save.engineFlags && save.engineFlags[ENGINE_POKEDEX] === true;
    const hofCount = (save && save.hallOfFame && save.hallOfFame.count) || 0;
    const entries = [
      { id: "bills", label: Strings.get(TEXT.billsPc) },
      { id: "players", label: Strings.get(TEXT.playersPc, this.playerName()) },
    ];
    if (hasDex) {
      entries.push({ id: "oaks", label: Strings.get(TEXT.oaksPc) });
      if (hofCount > 0) entries.push({ id: "hof", label: Strings.get(TEXT.hallOfFame) });
    }
    entries.push({ id: "turnoff", label: Strings.get(TEXT.turnOff) });
    this.entries = entries;
  }

  /**
   * Lua: CenterPcMenu.lua:173 -- a page may carry `sfx`, played the moment it
   * comes up (FindOakRating hands PlaySFX its fanfare right before the
   * rating text prints).
   */
  say(pages: Page[], onDone?: () => void): void {
    Typer.say(this, pages, onDone, {
      expand: (line: string) => line.split("{PLAYER}").join(this.playerName()),
    });
    const first = pages[0];
    if (first && first.sfx) this.playSfx(first.sfx);
  }

  /** Lua: CenterPcMenu.lua:181 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  /** Lua: CenterPcMenu.lua:189 -- .shutdown: PC_PlayShutdownSound. */
  shutdown(): void {
    this.playSfx("Sfx_ShutDownPc");
    this.close();
  }

  /** Lua: CenterPcMenu.lua:196 -- ProfOaksPC's `.shutdown`: _OakPCText4. */
  oakClosed(): void {
    this.say(translatedPages(TEXT.oakClosed));
  }

  /** Lua: CenterPcMenu.lua:203 -- ProfOaksPCBoot, inside a screen. */
  oakRate(): void {
    const [seen, caught] = Specials.dexCounts(this.save);
    const rating = Specials.findOakRating(caught);
    const pages = pagesOf(Strings.get(Specials.OAK_PC_TEXT.completion));
    for (const page of pagesOf(Strings.get(Specials.OAK_PC_TEXT.counts, seen, caught))) {
      pages.push(page);
    }
    const ratingPages = pagesOf(Strings.get(rating.text));
    if (ratingPages[0]) ratingPages[0].sfx = rating.sfx;
    for (const page of ratingPages) pages.push(page);
    this.say(pages, () => this.oakClosed());
  }

  /** Lua: CenterPcMenu.lua:217 */
  choose(): void {
    const entry = this.entries[this.index - 1];
    if (!entry) return;
    const game = this.game;
    if (entry.id === "turnoff") {
      // TurnOffPC: PokecenterPCOaksClosedText, then carry into .shutdown.
      this.say(translatedPages(TEXT.linkClosed), () => this.shutdown());
      return;
    }
    // PC_PlayChoosePCSound opens all four of the other rows.
    this.playSfx("Sfx_ChoosePcOption");
    if (entry.id === "bills") {
      this.say(translatedPages(TEXT.billsOpened), () => {
        if (!(game && game.stack)) return;
        Screens.push(game, "Gen2PcMenu", {
          save: this.save,
          bills: true,
          onClose: () => game.stack.pop(),
        });
      });
    } else if (entry.id === "players") {
      this.say(translatedPages(TEXT.ownOpened), () => {
        if (!(game && game.stack)) return;
        Screens.push(game, "Gen2ItemPcMenu", {
          save: this.save,
          items: this.items,
          onClose: () => game.stack.pop(),
        });
      });
    } else if (entry.id === "oaks") {
      this.say(translatedPages(TEXT.oakOpened), () => {
        // _OakPCText1's yes/no; NO is the same `.shutdown` as a finished rating.
        this.confirm = {
          prompt: translatedPages(TEXT.rateDex)[0],
          choice: 1,
          onYes: () => this.oakRate(),
          onNo: () => this.oakClosed(),
        };
      });
    } else if (entry.id === "hof") {
      if (!(game && game.stack)) return;
      // HallOfFamePC: FadeToMenu, _HallOfFamePC, CloseSubmenu.
      Screens.push(game, "Gen2HallOfFame", {
        save: this.save,
        mode: "view",
        onDone: () => game.stack.pop(),
      });
    }
  }

  /** Lua: CenterPcMenu.lua:268 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;

    if (this.message) {
      Typer.step(this);
      if (Typer.typing(this)) return;
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const m = this.message;
        if (m.page < m.pages.length) {
          Typer.turn(this, m);
          const page = m.pages[m.page - 1] as Page | undefined;
          if (page && typeof page !== "string" && page.sfx) this.playSfx(page.sfx);
          return;
        }
        this.message = undefined;
        if (m.onDone) m.onDone();
      }
      return;
    }

    if (this.confirm) {
      const c = this.confirm;
      if (input.wasPressed("up") || input.wasPressed("down")) {
        c.choice = c.choice === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        // home/menu.asm:345
        this.playSfx("Sfx_ReadText2");
        this.confirm = undefined;
        if (c.onNo) c.onNo();
      } else if (input.wasPressed("a")) {
        this.playSfx("Sfx_ReadText2");
        this.confirm = undefined;
        if (c.choice === 1) {
          if (c.onYes) c.onYes();
        } else if (c.onNo) {
          c.onNo();
        }
      }
      return;
    }

    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : this.entries.length;
    } else if (input.wasPressed("down")) {
      this.index = this.index < this.entries.length ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      this.choose();
    } else if (input.wasPressed("b")) {
      // DoNthMenu's carry lands straight in .shutdown, no text.
      this.shutdown();
    }
  }

  /** Lua: CenterPcMenu.lua:322 */
  drawBottomLines(lines: string[] | undefined): void {
    Chrome.box(0, 12, 20, 6);
    if (!lines) return;
    const name = this.playerName();
    // constants/text_constants.asm:32 TEXTBOX_INNERY: rows 14 and 16 only.
    for (let i = 1; i <= Math.min(lines.length, 2); i++) {
      Chrome.print(lines[i - 1]!.split("{PLAYER}").join(name), 1, 14 + (i - 1) * 2);
    }
  }

  /** Lua: CenterPcMenu.lua:332 */
  drawPanel(): void {
    if (this.booted) {
      // _PokecenterPCWhoseText stays up under the menu (PC_DisplayTextWaitMenu
      // leaves it there); the menu window is drawn on top of it.
      this.drawBottomLines(translatedPages(TEXT.accessWhose)[0]);
      // .TopMenu is menu_coords 0, 0, 15, 12.
      Chrome.box(0, 0, 16, Math.max(12, this.entries.length * 2 + 2));
      this.entries.forEach((entry, k) => {
        const i = k + 1;
        const ty = i * 2;
        if (i === this.index) Chrome.cursor(1, ty);
        Chrome.print(entry.label, 2, ty);
      });
    }

    if (this.message) {
      // ../pokecrystal/engine/events/pokecenter_pc.asm:652
      const page = this.message.pages[this.message.page - 1];
      const fallback = typeof page === "string" ? page.split("\n") : page;
      this.drawBottomLines(Typer.text(this, fallback));
    } else if (this.confirm) {
      this.drawBottomLines(this.confirm.prompt);
      Chrome.box(14, 7, 6, 5);
      Chrome.print(Strings.get("YES"), 16, 8);
      Chrome.print(Strings.get("NO"), 16, 10);
      Chrome.cursor(15, this.confirm.choice === 1 ? 8 : 10);
    } else if (!this.booted) {
      this.drawBottomLines(undefined);
    }

    G.setColor(1, 1, 1, 1);
  }

  /** Lua: CenterPcMenu.lua:364 */
  draw(): void {
    this.drawPanel();
  }
}

export default CenterPcMenu;
