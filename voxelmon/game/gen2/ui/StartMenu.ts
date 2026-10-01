// Gold's START menu: a port of gen1recomp src/ui/gen2/StartMenu.lua
// (bdfac727, MIT) -- engine/menus/start_menu.asm StartMenu.
//
// The box is right-aligned -- menu_coords 10, 0, SCREEN_WIDTH - 1,
// SCREEN_HEIGHT - 1 -- and grows to fit however many entries are unlocked.
// #DEX and POKEGEAR only appear once the player owns them (.SetUpMenuItems).
// With MENU ACCOUNT on, a second box at the bottom-left describes the
// highlighted entry (.MenuDesc). The cursor position is remembered between
// openings (wBattleMenuCursorPosition).
//
// The assembled list runs through the ui.start_menu.items hook (the null mod
// bus here), so the call site survives.
//
// On the Gold screen the menu is an overlay: its boxes are cells, and every
// cell it leaves alone is a hole the voxel world shows through.

import { BugContest } from "../core/BugContest.ts";
import { Chrome, type List } from "./Chrome.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";

export interface StartMenuItem {
  id?: string;
  label: any;
  value?: any;
  need?: string;
  desc?: any;
  translateLabel?: boolean;
  translateDesc?: boolean;
  onSelect?: (game: any) => void;
  [k: string]: any;
}

export interface StartMenuOpts {
  save?: any;
  onChoose?: (id: string) => void;
  onClose?: () => void;
  unlocked?: Record<string, boolean>;
}

// Lua: StartMenu.lua:49 -- STARTMENUITEM_* in the order .SetUpMenuItems
// appends them. `need` is the save flag that unlocks the entry. "<PO><KE>GEAR"
// is two one-tile glyphs plus GEAR, six tiles wide.
const ITEMS: StartMenuItem[] = [
  {
    id: "pokedex", label: Strings.source("POKéDEX"), need: "pokedex",
    desc: Strings.source("POKéMON\ndatabase"),
  },
  {
    id: "pokemon", label: Strings.source("POKéMON"), need: "party",
    desc: Strings.source("Party <PK><MN>\nstatus"),
  },
  {
    id: "pack", label: Strings.source("PACK"), need: "pack",
    desc: Strings.source("Contains\nitems"),
  },
  {
    id: "pokegear", label: Strings.source("<PO><KE>GEAR"), need: "pokegear",
    desc: Strings.source("Trainer's\nkey device"),
  },
  {
    // The player's own name is the label (.StatusString is "<PLAYER>").
    id: "status", label: undefined,
    desc: Strings.source("Your own\nstatus"),
  },
  {
    id: "save", label: Strings.source("SAVE"),
    desc: Strings.source("Save your\nprogress"),
  },
  {
    id: "option", label: Strings.source("OPTION"),
    desc: Strings.source("Change\nsettings"),
  },
  {
    // Not the cart's: the Kanto games' DEV entry (ui/DevMenu.ts), there only
    // while the OPTION screen's DEV MENU is ON.
    id: "dev", label: Strings.source("DEV"), need: "dev",
    desc: Strings.source("Testing\ntools"),
  },
  {
    // Only once a mod has been discovered; never on the 3DS (no mods).
    id: "mods", label: Strings.source("MODS"), need: "mods",
    desc: Strings.source("Installed\nadd-ons"),
  },
  {
    // Brian's QUIT (the cart's EXIT just closed the menu): back to the title
    // after a confirmation that defaults to NO.
    id: "quit", label: Strings.source("QUIT"),
    desc: Strings.source("Return to\nthe title"),
  },
];

// Lua: StartMenu.lua:102 -- SaveTheGame_yesorno's `lb bc, 0, 7`, a 6x5 box
// at (0,7) clear of the menu.
const YESNO_X = 0;
const YESNO_Y = 7;
const YESNO_W = 6;
const YESNO_H = 5;

// Lua: StartMenu.lua:108 -- ui.start_menu.items identity.
function sameItems(_game: any, items: StartMenuItem[]): StartMenuItem[] {
  return items;
}

// Lua: StartMenu.lua:176 -- ENGINE_POKEGEAR = 4, ENGINE_POKEDEX = 11
// (constants/engine_flags.asm const order).
const ENGINE_POKEGEAR = 4;
const ENGINE_POKEDEX = 11;

export class StartMenu {
  [key: string]: any;
  // Lua: StartMenu.lua:33 -- not opaque: the overworld keeps drawing underneath.
  static isOpaque = false;
  // Lua: StartMenu.lua:105 -- persisted across openings.
  static lastIndex = 1;
  static ITEMS = ITEMS;

  isOpaque = false;
  game: any;
  save: any;
  onChoose?: (id: string) => void;
  onClose?: () => void;
  onQuit?: () => void;
  unlocked?: Record<string, boolean>;
  items: StartMenuItem[] = [];
  showDescription = true;
  list!: List;
  contest = false;
  phase: "confirm" | "confirmContest" | undefined;
  confirmChoice = 2;

  // Lua: StartMenu.lua:111
  static new(game: any, opts?: StartMenuOpts): StartMenu {
    const o = opts ?? {};
    const self = new StartMenu();
    self.game = game;
    self.save = o.save ?? (game ? game.save : undefined);
    self.onChoose = o.onChoose;
    self.onClose = o.onClose;
    self.unlocked = o.unlocked;
    let items = self.visibleItems();
    const hooked = Runtime.call("ui.start_menu.items", sameItems, game, items);
    if (hooked !== null && typeof hooked === "object") {
      items = hooked;
    } else {
      Logger.error("ui.start_menu.items returned %s; keeping the vanilla items", typeof hooked);
    }
    // Lua: StartMenu.lua:133 -- translate the built-in rows.
    for (const item of items) {
      if (item.translateLabel) item.label = Strings.get(item.label);
      if (item.translateDesc) {
        const translated = Strings.get(item.desc);
        item.desc = translated.split("\n");
      }
    }
    self.items = items;
    const options = (self.save && self.save.options) || {};
    self.showDescription = options.menuAccount !== false;

    self.list = Chrome.List.new({
      items: self.items as any,
      // GetMenuTextStartCoord: (10,0) becomes (12,2), the cursor at x - 1.
      // pokecrystal engine/menus/start_menu.asm:164
      x: 12,
      y: self.contest ? 4 : 2,
      spacing: 2,
      rows: Math.min(self.items.length, 8),
      wrap: true,
      startAccepts: true,
      index: Math.min(StartMenu.lastIndex, Math.max(1, self.items.length)),
      onChoose: (value, index) => self.choose(value as string, index),
      onCancel: () => self.close(),
    });
    return self;
  }

  // Lua: StartMenu.lua:178 -- which entries the player has unlocked.
  availability(): Record<string, boolean> {
    if (this.unlocked) return this.unlocked;
    const save = this.save ?? {};
    const inventory = save.inventory ?? {};
    const engine = save.engineFlags ?? {};
    const status = this.game ? this.game.modStatus : undefined;
    return {
      mods: status != null && (status.available ?? []).length > 0,
      pokedex: engine[ENGINE_POKEDEX] === true || save.pokedexReceived === true,
      party: (save.party ?? []).length > 0,
      pack: true,
      pokegear: engine[ENGINE_POKEGEAR] === true || (inventory.POKEGEAR ?? 0) > 0 || save.pokegearReceived === true,
      dev: ((this.game && this.game.options) || save.options || {}).devMenu === true,
    };
  }

  // Lua: StartMenu.lua:196
  visibleItems(): StartMenuItem[] {
    const available = this.availability();
    const contest = BugContest.isActive(this.save);
    this.contest = contest;
    const playerName = (this.save && this.save.player && this.save.player.name) || "GOLD";
    const out: StartMenuItem[] = [];
    for (const item of ITEMS) {
      const id = item.id!;
      // pokecrystal engine/menus/start_menu.asm:309
      const hidden = contest && (id === "pack" || id === "quit");
      if (!hidden && (!item.need || available[item.need])) {
        if (contest && id === "save") {
          // pokecrystal engine/menus/start_menu.asm:330
          out.push({
            label: Strings.source("QUIT"),
            value: "quitContest",
            // pokecrystal engine/menus/start_menu.asm:231
            desc: Strings.source("Quit and\nbe judged."),
            translateLabel: true,
            translateDesc: true,
          });
        } else {
          out.push({
            label: item.label ?? playerName,
            value: id,
            desc: item.desc,
            translateLabel: item.label != null,
            translateDesc: item.desc != null,
          });
        }
      }
    }
    return out;
  }

  // Lua: StartMenu.lua:231
  playSfx(name: string): void {
    const data = this.game ? this.game.data : undefined;
    const audio = data ? data.audio : undefined;
    if (!audio) return;
    if (audio.sfx && audio.sfx[name]) Sound.play(data, name);
  }

  // Lua: StartMenu.lua:238
  enter(): void {
    this.playSfx("Sfx_Menu");
  }

  // Lua: StartMenu.lua:246
  choose(id: string, index?: number): void {
    StartMenu.lastIndex = this.list.index;
    const item = index != null ? this.items[index - 1] : undefined;
    if (item && item.onSelect && item.value == null) {
      this.playSfx("Sfx_ReadText2");
      item.onSelect(this.game);
      return;
    }
    this.playSfx("Sfx_ReadText2");
    if (id === "quit") {
      // NO is the default.
      this.phase = "confirm";
      this.confirmChoice = 2;
      return;
    }
    if (id === "quitContest") {
      // pokecrystal engine/menus/start_menu.asm:411
      this.phase = "confirmContest";
      this.confirmChoice = 1;
      return;
    }
    if (this.onChoose) this.onChoose(id);
  }

  // Lua: StartMenu.lua:271
  confirmQuit(): void {
    this.phase = undefined;
    if (this.onQuit) {
      this.onQuit();
    } else if (this.game && this.game.returnToTitle) {
      this.game.returnToTitle();
    }
  }

  // Lua: StartMenu.lua:281 -- pokecrystal engine/events/bug_contest/contest.asm:31
  confirmQuitContest(): void {
    this.phase = undefined;
    this.close();
    const world = this.game ? this.game.world : undefined;
    if (world && world.bugContestResults) world.bugContestResults();
  }

  // Lua: StartMenu.lua:288
  close(): void {
    StartMenu.lastIndex = this.list.index;
    if (this.onClose) this.onClose();
  }

  // Lua: StartMenu.lua:293
  update(_dt?: number): void {
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (this.phase === "confirm" || this.phase === "confirmContest") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.confirmChoice = this.confirmChoice === 1 ? 2 : 1;
      } else if (input.wasPressed("a")) {
        if (this.confirmChoice !== 1) {
          this.phase = undefined;
        } else if (this.phase === "confirmContest") {
          this.confirmQuitContest();
        } else {
          this.confirmQuit();
        }
      } else if (input.wasPressed("b") || input.wasPressed("start")) {
        this.phase = undefined;
      }
      return;
    }
    // START closes the menu as well as opening it.
    if (input.wasPressed("start")) {
      this.close();
      return;
    }
    this.list.update(input);
  }

  // Lua: StartMenu.lua:321 -- pokecrystal engine/menus/menu_2.asm:145
  drawContestStatus(): void {
    Chrome.textbox(0, 0, 17, 5);
    Chrome.print("CAUGHT", 1, 1);
    const mon = BugContest.caughtMon(this.save);
    Chrome.print(mon ? mon.nickname || mon.name || mon.species : "None", 8, 1);
    if (mon) {
      Chrome.print("LEVEL", 1, 3);
      Chrome.print(String(mon.level || 1), 7, 3);
    }
    Chrome.print("BALLS:", 1, 5);
    Chrome.print(String(BugContest.ballsLeft(this.save)), 8, 5);
  }

  // Lua: StartMenu.lua:335
  draw(): void {
    // AutomaticGetMenuBottomCoord: two rows per entry plus two border rows.
    const top = this.contest ? 2 : 0;
    const height = Math.min(this.items.length * 2 + 2, Chrome.SCREEN_H - top);
    if (this.contest) this.drawContestStatus();
    Chrome.box(10, top, 10, height);
    this.list.draw();

    if (this.phase === "confirmContest") {
      // pokecrystal data/text/common_2.asm:1381
      Chrome.textbox(0, 12, 18, 4);
      Chrome.print("Would you like to", 1, 14);
      Chrome.print("end the Contest?", 1, 16);
      // pokecrystal home/menu.asm:418
      Chrome.box(14, 7, 6, 5);
      Chrome.print("YES", 16, 8);
      Chrome.print("NO", 16, 10);
      Chrome.cursor(15, this.confirmChoice === 1 ? 8 : 10);
      return;
    }

    if (this.phase === "confirm") {
      Chrome.textbox(0, 12, 18, 4);
      const prompt = Strings.get(Strings.source("Return to the\ntitle screen?"));
      const m = /^([^\n]*)\n?([\s\S]*)$/.exec(prompt);
      Chrome.print(m ? m[1]! : "", 1, 14);
      Chrome.print(m ? m[2]! : "", 1, 16);
      Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
      Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
      Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
      Chrome.cursor(YESNO_X + 1, YESNO_Y + (this.confirmChoice === 1 ? 1 : 3));
      return;
    }

    if (!this.showDescription) return;
    const item = this.list.current() as StartMenuItem | undefined;
    const desc = item ? item.desc : undefined;
    if (!desc) return;
    // ._DrawMenuAccount ClearBox (0,13) 5 rows by 10, .PrintMenuAccount
    // decoord 0, 14 (start_menu.asm:366-382).
    Chrome.paletteFill(0, 13 * 8, 10 * 8, 5 * 8);
    Chrome.print(desc[0] ?? "", 0, 14);
    Chrome.print(desc[1] ?? "", 0, 16);
  }
}

export default StartMenu;
