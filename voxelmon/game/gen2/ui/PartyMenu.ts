// gen1recomp src/ui/gen2/PartyMenu.lua (bdfac727, MIT): Gold's party list
// (engine/pokemon/party_menu.asm).
//
// Six rows plus CANCEL. Each row is two lines: an animated 16x16 menu icon
// with the nickname on the first, status, level and HP bar on the second --
// the layout Gold uses everywhere it asks "which #MON?", which is why the
// prompt text is a parameter (.Strings: "Choose a #MON.", "Use on which
// <PK><MN>?", "Teach which <PK><MN>?", ...).
//
// Icons come from icons.json: one 16x32 sheet per ICON_*, two 16x16 frames
// that alternate roughly twice a second, and MonMenuIcons maps species ->
// icon. On the Gold screen the icons are objects (an `icons/` image always
// is), which is what the cart's sprite-anim icons are too.
//
// Choosing a mon from the FIELD list opens the action submenu (MonSubmenu,
// engine/pokemon/mon_submenu.asm) rather than answering straight away; every
// other flavour of the list goes directly to its caller, which is why the
// submenu is opt-in through `opts.submenu`.

import G, { type LcdImage } from "../platform/screen.ts";
import { tostring } from "../platform/lua.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { HpBar, type HpBarPainter } from "../battle/HpBar.ts";
import { ItemEffects } from "../core/ItemEffects.ts";
import { Mail } from "../core/Mail.ts";
import { Mon } from "../battle/Mon.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Status } from "../shared/battle/Status.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { BattleHud } from "./BattleHud.ts";
import { Chrome } from "./Chrome.ts";
import { WaitPlaySFX, type PendingSfx } from "./WaitPlaySFX.ts";

// Lua: PartyMenu.lua:43 -- PartyMenuStrings, verbatim. <PK>/<MN> are single
// font glyphs, which keeps "Use on which <PK><MN>?" inside its text box.
const PROMPTS: Record<string, string> = {
  choose: Strings.source("Choose a POKéMON."),
  useItem: Strings.source("Use on which <PK><MN>?"),
  which: Strings.source("Which <PK><MN>?"),
  teach: Strings.source("Teach which <PK><MN>?"),
  moveTo: Strings.source("Move to where?"),
  toWhich: Strings.source("To which <PK><MN>?"),
  none: Strings.source("You have no <PK><MN>!"),
};

// Lua: PartyMenu.lua:53
const FAINTED_LABEL = Strings.source("FNT");
const EGG_LABEL = Strings.source("EGG");
const ABLE_LABEL = Strings.source("ABLE");
const NOT_ABLE_LABEL = Strings.source("NOT ABLE");

// Lua: PartyMenu.lua:60 -- the icon's two frames swap every 16 logic steps.
const ICON_FRAME_STEPS = 16;

// Lua: PartyMenu.lua:68 -- data/mon_menu.asm MonMenuOptions' MONMENU_FIELD_MOVE
// rows, in table order.
const FIELD_MOVES = [
  "CUT", "FLY", "SURF", "STRENGTH", "FLASH", "WATERFALL", "WHIRLPOOL", "DIG",
  "TELEPORT", "SOFTBOILED", "HEADBUTT", "ROCK_SMASH", "MILK_DRINK",
  "SWEET_SCENT",
];

// Lua: PartyMenu.lua:77
const NUM_MONMENU_ITEMS = 8;

// Lua: PartyMenu.lua:82 -- MonMenuOptionStrings.
const ACTION_LABELS: Record<string, string> = {
  STATS: Strings.source("STATS"),
  SWITCH: Strings.source("SWITCH"),
  MOVE: Strings.source("MOVE"),
  ITEM: Strings.source("ITEM"),
  MAIL: Strings.source("MAIL"),
  CANCEL: Strings.source("CANCEL"),
};

// Lua: PartyMenu.lua:91
function actionLabel(id: string): string {
  return Strings.get(ACTION_LABELS[id] ?? id);
}

// Lua: PartyMenu.lua:98 -- MonSubmenu's menu_coords 6, 0, 19, 17.
const SUBMENU_LEFT = 6;
const SUBMENU_RIGHT = 19;
const SUBMENU_BOTTOM = 17;

// Lua: PartyMenu.lua:104 -- BattleMonMenu's menu_coords 11, 11, 19, 17.
const BATTLE_SUBMENU_LEFT = 11;
const BATTLE_SUBMENU_TOP = 11;

export interface SubmenuItem {
  id: string;
  label: string;
  fieldMove?: boolean;
  onSelect?: (mon: any, game: any) => void;
  [k: string]: any;
}

interface Submenu {
  items: SubmenuItem[];
  index: number;
  mon: any;
  slot: number;
  battle?: boolean;
}

interface ItemResult {
  slot: number | null | undefined;
  shown?: number;
  target?: number;
  text?: string;
  delay: number;
  onDone?: () => void;
  auto?: boolean;
  holdSlot?: number;
  holdHp?: number;
}

export interface ItemResultOpts {
  fromHp?: number;
  toHp?: number;
  text?: string;
  delay?: number;
  onDone?: () => void;
  auto?: boolean;
  holdSlot?: number;
  holdHp?: number;
  sfx?: string;
}

export interface PartyRow {
  name: string;
  hp?: string;
  status?: string | null;
  level?: string;
}

export interface PartyMenuOpts {
  save?: any;
  party?: any[];
  prompt?: string;
  onChoose?: (index: number, mon: any) => void;
  onCancel?: () => void;
  icons?: any;
  palettes?: any;
  pokemon?: any;
  tmhm?: any;
  moves?: any;
  items?: any;
  submenu?: boolean;
  battleSubmenu?: boolean;
  battle?: boolean;
}

// Lua: PartyMenu.lua:108
function gridIndex(index: number, count: number, direction: string | false | undefined): number | undefined {
  if (count < 1) return undefined;
  const row = Math.floor((index - 1) / 2);
  const col = (index - 1) % 2;
  if (direction === "left" || direction === "right") {
    const other = row * 2 + (1 - col) + 1;
    return other <= count ? other : index;
  }
  const step = direction === "up" ? -1 : direction === "down" ? 1 : undefined;
  if (step === undefined) return undefined;
  const rows = Math.ceil(count / 2);
  for (let offset = 1; offset <= rows; offset++) {
    const other = ((((row + step * offset) % rows) + rows) % rows) * 2 + col + 1;
    if (other <= count) return other;
  }
  return index;
}

// Lua: PartyMenu.lua:225 -- ui.party.submenu identity.
function sameItems(_game: any, items: SubmenuItem[]): SubmenuItem[] {
  return items;
}

// Lua: PartyMenu.lua:269 -- BattleMonMenu's .MenuData: SWITCH first.
function buildBattleSubmenuItems(): SubmenuItem[] {
  return [
    { id: "SWITCH", label: actionLabel("SWITCH") },
    { id: "STATS", label: actionLabel("STATS") },
    { id: "CANCEL", label: actionLabel("CANCEL") },
  ];
}

// Lua: PartyMenu.lua:564 -- the ids updateSubmenu dispatches itself.
const VANILLA_SUBMENU_IDS: Record<string, boolean> = {
  STATS: true, SWITCH: true, MAIL: true, ITEM: true, MOVE: true, CANCEL: true,
};

// Lua: PartyMenu.lua:934 -- PrintNum with `lb bc, 2, 3`: three columns,
// space-padded from the right.
function num3(value: number | null | undefined): string {
  let text = tostring(Math.max(0, Math.floor(value ?? 0)));
  if (text.length > 3) text = text.slice(-3);
  return " ".repeat(3 - text.length) + text;
}

// Lua: PartyMenu.lua:942 -- PlaceStatusString: a mon with no HP reads FNT.
function statusString(mon: any, hp: number | null | undefined, statuses: any): string | null {
  if (hp == null) hp = mon.hp;
  if ((hp ?? 0) <= 0) return Strings.get(FAINTED_LABEL);
  const status = mon.status;
  if (status == null || status === false) return null;
  const key = tostring(status).toLowerCase();
  if (statuses && statuses[key]) return Strings.get(Status.hudLabelFor(statuses, key));
  const cls = (ItemEffects.STATUS_CLASS as Record<string, string>)[key];
  if (!cls) return null;
  if (!statuses) return cls.toUpperCase();
  const id = (Status.GEN2_ID_ALIASES as Record<string, string>)[key] ?? key;
  return Strings.get(Status.hudLabelFor(statuses, id));
}

// HpBar's fallback painter: the Lua's setColor + rectangle pairs.
const gPainter: HpBarPainter = {
  rect(x, y, w, h, rgb) {
    if (rgb === "black") G.setColor(0, 0, 0, 1);
    else if (rgb === "white") G.setColor(1, 1, 1, 1);
    else G.setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
    G.rectangle("fill", x, y, w, h);
    G.setColor(0, 0, 0, 1);
  },
};

export class PartyMenu {
  [key: string]: any;
  // Lua: PartyMenu.lua:37
  static isOpaque = true;
  static PROMPTS = PROMPTS;
  // Lua: PartyMenu.lua:63 -- engine/items/item_effects.asm:1748
  static ACTION_TEXT_DELAY = 50;
  static FIELD_MOVES = FIELD_MOVES;

  isOpaque = true;
  game: any;
  save: any;
  party: any[];
  icons: any;
  palettes: any;
  pokemon: any;
  promptIsBuiltin: boolean;
  prompt: string;
  tmhm: any;
  onChoose?: (index: number, mon: any) => void;
  onCancel?: () => void;
  moves: any;
  items: any;
  wantsSubmenu: boolean;
  wantsBattleSubmenu: boolean;
  battle: boolean;
  submenu: Submenu | null = null;
  switchFrom: number | null = null;
  repeatSfx: PendingSfx | null = null;
  softboiledFrom: number | null = null;
  softboiledCost: number | null = null;
  itemResult: ItemResult | null = null;
  // Port fix: a GIVE/TAKE or MAIL menu is open over the list (see drawPanel).
  promptCleared = false;
  index: number;
  clock: number;
  iconCache: Record<string, LcdImage | false>;
  hud: BattleHud;

  /** Lua: PartyMenu.lua:125 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: PartyMenu.lua:126 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: PartyMenu.lua:131 -- opts: party, prompt (key or literal),
   * onChoose(index), onCancel(), icons, palettes, pokemon, submenu (the field
   * MonSubmenu), battleSubmenu (BattleMonMenu)
   */
  static new(game: any, opts?: PartyMenuOpts): PartyMenu {
    return new PartyMenu(game, opts ?? {});
  }

  constructor(game: any, opts: PartyMenuOpts) {
    this.game = game;
    const save = opts.save || (game && game.save);
    // The MAIL row writes to sPartyMail, which lives on the save.
    this.save = save;
    this.party = opts.party || (save && save.party) || [];
    const data = (game && game.data) || {};
    // engine/pokemon/move_mon.asm:1402
    for (const mon of this.party) Mon.refreshStats(mon, data);
    this.icons = opts.icons || data.gen2Icons;
    this.palettes = opts.palettes || data.gen2Palettes;
    this.pokemon = opts.pokemon || data.pokemon;
    const promptKey = opts.prompt ?? "choose";
    this.promptIsBuiltin = PROMPTS[promptKey] !== undefined;
    this.prompt = PROMPTS[promptKey] ?? opts.prompt ?? PROMPTS.choose!;
    // engine/pokemon/party_menu.asm:297
    this.tmhm = opts.tmhm;
    if (this.tmhm && (opts.prompt == null || opts.prompt === "teach")) {
      this.prompt = PROMPTS.teach!;
      this.promptIsBuiltin = true;
    }
    this.onChoose = opts.onChoose;
    this.onCancel = opts.onCancel;
    this.moves = opts.moves || data.moves;
    this.items = opts.items || data.items;
    this.wantsSubmenu = opts.submenu === true;
    // BattleMenu_PKMN's `callfar BattleMonMenu` (engine/battle/core.asm:4810).
    this.wantsBattleSubmenu = opts.battleSubmenu === true;
    this.battle = opts.battle === true;
    // wPartyMenuCursor lives across openings (engine/pokemon/party_menu.asm:546):
    // the list reopens on the mon last picked. A WRAM byte, so it hangs off
    // the game.
    const stored = (game && game.partyMenuCursor) || 0;
    this.index = stored >= 1 && stored <= this.party.length ? stored : 1;
    this.clock = 0;
    this.iconCache = {};
    // PlacePartyHPBar draws through DrawBattleHPBar, so the list uses the
    // battle HUD's tile sheet.
    this.hud = BattleHud.new(data.gen2MenuGfx, this.palettes);
  }

  /** Lua: PartyMenu.lua:192 -- CANCEL is one past the last mon. */
  count(): number {
    if (this.switchFrom || this.softboiledFrom) return this.party.length;
    return this.party.length + 1;
  }

  /** Lua: PartyMenu.lua:199 */
  isCancel(): boolean {
    return this.index > this.party.length;
  }

  /** Lua: PartyMenu.lua:203 */
  gridNavigation(): boolean {
    if (!this.battle || !Runtime.wantsHook("ui.party.grid_navigation")) return false;
    return Runtime.call("ui.party.grid_navigation", () => false, this) === true;
  }

  // ------------------------------------------------------------- mon submenu

  /**
   * Lua: PartyMenu.lua:227 -- GetMonSubmenuItems, in its own order: every
   * field move the mon knows first, then STATS, SWITCH, MOVE, and ITEM (MAIL
   * when the held item is mail). CANCEL only while the list is short of
   * NUM_MONMENU_ITEMS.
   */
  buildSubmenuItems(mon: any): SubmenuItem[] {
    // The .egg arm: STATS, SWITCH and CANCEL.
    if (mon && mon.isEgg) {
      return [
        { id: "STATS", label: actionLabel("STATS") },
        { id: "SWITCH", label: actionLabel("SWITCH") },
        { id: "CANCEL", label: actionLabel("CANCEL") },
      ];
    }
    const items: SubmenuItem[] = [];
    const known: Record<string, any> = {};
    for (const entry of (mon && mon.moves) || []) {
      if (entry && entry.id) known[entry.id] = entry;
    }
    for (const id of FIELD_MOVES) {
      if (known[id]) {
        const def = this.moves && this.moves[id];
        items.push({ id, label: (def && def.name) || id, fieldMove: true });
      }
    }
    items.push({ id: "STATS", label: actionLabel("STATS") });
    items.push({ id: "SWITCH", label: actionLabel("SWITCH") });
    items.push({ id: "MOVE", label: actionLabel("MOVE") });
    // ItemIsMail, not a pocket test.
    const isMail = Mail.monHoldsMail(mon);
    items.push(isMail ? { id: "MAIL", label: actionLabel("MAIL") } : { id: "ITEM", label: actionLabel("ITEM") });
    if (items.length < NUM_MONMENU_ITEMS) items.push({ id: "CANCEL", label: actionLabel("CANCEL") });
    return items;
  }

  /**
   * Lua: PartyMenu.lua:287 -- the assembled list runs through ui.party.submenu
   * (the null mod bus here). ctx.battle marks BattleMonMenu's list.
   */
  submenuItems(mon: any): SubmenuItem[] {
    const battle = this.wantsBattleSubmenu === true;
    const items = battle ? buildBattleSubmenuItems() : this.buildSubmenuItems(mon);
    const ctx = { battle, overworld: this.game && this.game.world };
    const hooked = Runtime.call("ui.party.submenu", sameItems, this.game, items, mon, ctx);
    if (Array.isArray(hooked)) return hooked;
    Logger.error("ui.party.submenu returned %s; keeping the vanilla list", typeof hooked);
    return items;
  }

  /** Lua: PartyMenu.lua:304 -- .GetTopCoord: top = 1 + bottom - 2 * (count + 1). */
  static submenuTop(count: number): number {
    return 1 + SUBMENU_BOTTOM - 2 * (count + 1);
  }

  /** Lua: PartyMenu.lua:308 -- PopulateMonMenu's label coordinate. */
  static submenuLabelCoord(count: number, row: number): [number, number] {
    return [SUBMENU_LEFT + 2, PartyMenu.submenuTop(count) + 2 + (row - 1) * 2];
  }

  /** Lua: PartyMenu.lua:312 */
  openSubmenu(): void {
    const mon = this.party[this.index - 1];
    if (!mon) return;
    this.submenu = {
      items: this.submenuItems(mon),
      index: 1,
      mon,
      slot: this.index,
      battle: this.wantsBattleSubmenu || undefined,
    };
  }

  /** Lua: PartyMenu.lua:319 */
  closeSubmenu(): void {
    this.submenu = null;
  }

  /**
   * Lua: PartyMenu.lua:328 -- SwitchPartyMons (engine/pokemon/mon_menu.asm):
   * `cp 2 / jr c, .DontSwitch`, otherwise the list reopens in
   * PARTYMENUACTION_MOVE dress.
   */
  beginSwitch(slot: number): void {
    if (this.party.length < 2) return;
    this.switchFrom = slot;
  }

  /**
   * Lua: PartyMenu.lua:338 -- _SwitchPartyMons
   * (engine/pokemon/switchpartymons.asm): the structs swap whole and the
   * sPartyMail structs go with them. The held slot again is `.skip`.
   */
  finishSwitch(): void {
    const from = this.switchFrom;
    const to = this.index;
    this.switchFrom = null;
    if (!(from && to) || from === to) return;
    const party = this.party;
    const a = party[from - 1];
    party[from - 1] = party[to - 1];
    party[to - 1] = a;
    // sPartyMail is keyed by party slot on the save.
    if (this.save && this.save.party === party) Mail.swapSlots(this.save, from, to);
    // engine/pokemon/switchpartymons.asm:13
    this.playSfxTwice("Sfx_SwitchPokemon");
  }

  /** Lua: PartyMenu.lua:356 -- PartyMenuSelect reads only A and B. */
  updateSwitch(input: any): void {
    const total = this.party.length;
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
    } else if (input.wasPressed("b")) {
      this.switchFrom = null;
    } else if (input.wasPressed("a")) {
      this.finishSwitch();
    }
  }

  /** Lua: PartyMenu.lua:370 -- item_effects.asm:2016 .SelectMilkDrinkRecipient */
  beginSoftboiled(slot: number, cost: number): void {
    this.softboiledFrom = slot;
    this.softboiledCost = cost;
  }

  /** Lua: PartyMenu.lua:376 -- item_effects.asm:2020 */
  updateSoftboiled(input: any): void {
    const total = this.party.length;
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
    } else if (input.wasPressed("b")) {
      this.softboiledFrom = null;
      this.softboiledCost = null;
    } else if (input.wasPressed("a")) {
      this.finishSoftboiled();
    }
  }

  /** Lua: PartyMenu.lua:390 -- item_effects.asm:1986 Softboiled_MilkDrinkFunction */
  finishSoftboiled(): void {
    const slot = this.index;
    const userSlot = this.softboiledFrom!;
    const user = this.party[userSlot - 1];
    const target = this.party[slot - 1];
    const userBefore = (user && user.hp) || 0;
    const r = FieldMoves.softboiledTransfer(user, target, this.softboiledCost || 0);
    if (!r) {
      this.showItemResult(slot, { text: Strings.get(ItemEffects.TEXT_CANT_USE_ON_MON) });
      return;
    }
    const [before, after] = r;
    this.softboiledFrom = null;
    this.softboiledCost = null;
    // data/text/common_1.asm:40 _RecoveredSomeHPText
    const climb: ItemResultOpts = {
      fromHp: before,
      toHp: after,
      sfx: "Sfx_Potion",
      text: Strings.get("%s\nrecovered %dHP!", target.nickname || target.name || target.species || "?", after - before),
    };
    // item_effects.asm:1999 HealHP_SFX_GFX
    this.showItemResult(userSlot, {
      fromHp: userBefore,
      toHp: user.hp,
      sfx: "Sfx_Potion",
      auto: true,
      holdSlot: slot,
      holdHp: before,
      onDone: () => this.showItemResult(slot, climb),
    });
  }

  /**
   * Lua: PartyMenu.lua:422 -- OpenPartyStats: the summary is pushed on top,
   * and closing it lands back on the same row.
   */
  openStats(): void {
    const stack = this.game && this.game.stack;
    if (!stack) return;
    Screens.push(this.game, "Gen2SummaryMenu", {
      party: this.party,
      index: this.index,
      onClose: () => stack.pop(),
    });
  }

  /**
   * Lua: PartyMenu.lua:447 -- MonMenu_Cut and its siblings: the world runs
   * the move; success ($2) closes the menus so the queued script can run,
   * anything else ($3) leaves the list where it was.
   */
  useFieldMove(moveId: string, mon: any): void {
    const world = this.game && this.game.world;
    if (!(world && world.useFieldMove)) return;
    const result = world.useFieldMove(moveId, mon);
    if (!(result && result.ok)) return;
    if (result.inMenu) {
      this.beginSoftboiled(this.index, result.cost);
      return;
    }
    // overworld.asm:1357 RockSmashFromMenuScript
    if (result.action === "rocksmash") {
      world.queuedFieldMove = null;
      const script = FieldMoves.rockSmashFromMenuScript(
        world.stdScripts,
        world.vm && world.vm.scripts,
        (name: string) => world.specialIdNamed(name),
      );
      if (!script) return;
      // overworld.asm:1341 GetFacingObject
      if (world.vm) world.vm.lastTalked = result.lastTalked;
      world.queuedScript = script;
      this.exitToField();
      return;
    }
    if (result.action === "fly" && world.openFlyMap) {
      world.queuedFieldMove = null;
      const opened = world.openFlyMap(mon, {
        onChosen: (spawnId: any) => {
          result.flySpawn = spawnId;
          world.queuedFieldMove = result;
          // engine/pokegear/pokegear.asm:2078, home/map.asm:1927
          if (world.exitMenusFadeForFly) world.exitMenusFadeForFly();
          else if (world.exitMenusFade) world.exitMenusFade();
          this.exitToField();
        },
        onCancel: () => {},
      });
      if (opened) return;
      world.queuedFieldMove = result;
    }
    this.exitToField();
  }

  /**
   * Lua: PartyMenu.lua:500 -- ManagePokemonMoves (mon_menu.asm:858-873): an
   * EGG returns at once, every other mon gets MoveScreenLoop; the slot it was
   * last showing is the row this list comes back on.
   */
  openMoveManager(slot: number, mon: any): void {
    const game = this.game;
    if (!(game && game.stack)) return;
    if (mon && mon.isEgg) return;
    let screen: any;
    screen = Screens.push(game, "Gen2SummaryMenu", {
      party: this.party,
      index: slot,
      moveScreen: true,
      onClose: () => {
        game.stack.pop();
        const landed = (screen && screen.index) || slot;
        this.index = Math.max(1, Math.min(landed, this.party.length));
        this.storeCursor();
      },
    });
  }

  /** Lua: PartyMenu.lua:521 -- GiveTakePartyMonItem, the ITEM row. */
  openHeldItemMenu(slot: number, mon: any): void {
    const game = this.game;
    if (!(game && game.stack && this.save)) return;
    if (mon && mon.isEgg) return;
    // Port fix: the prompt stays cleared under it (see drawPanel).
    this.promptCleared = true;
    Screens.push(game, "Gen2HeldItemMenu", {
      save: this.save,
      slot,
      items: this.items,
      onClose: () => {
        this.promptCleared = false;
        game.stack.pop();
      },
    });
  }

  /** Lua: PartyMenu.lua:537 -- MonMailAction, the MAIL row. */
  openMailMenu(slot: number): void {
    const game = this.game;
    if (!(game && game.stack && this.save)) return;
    // Port fix: the prompt stays cleared under it (see drawPanel).
    this.promptCleared = true;
    Screens.push(game, "Gen2MailMenu", {
      save: this.save,
      slot,
      onClose: () => {
        this.promptCleared = false;
        game.stack.pop();
      },
    });
  }

  /** Lua: PartyMenu.lua:549 -- the $2 return: only an empty stack runs the script. */
  exitToField(): void {
    const stack = this.game && this.game.stack;
    if (stack && stack.clear) {
      stack.clear();
      // home/map.asm:1927-1940
      const world = this.game.world;
      if (world && world.exitMenusFade && !world.mapSetup) world.exitMenusFade();
    } else if (this.onCancel) {
      this.onCancel();
    }
  }

  /** Lua: PartyMenu.lua:570 -- MonMenuLoop: A selects, B cancels. */
  updateSubmenu(input: any): void {
    const menu = this.submenu!;
    const total = menu.items.length;
    if (input.wasPressed("up")) {
      menu.index = menu.index > 1 ? menu.index - 1 : total;
    } else if (input.wasPressed("down")) {
      menu.index = menu.index < total ? menu.index + 1 : 1;
    } else if (input.wasPressed("b")) {
      // engine/pokemon/mon_submenu.asm:50
      this.playSfx("Sfx_ReadText2");
      this.closeSubmenu();
    } else if (input.wasPressed("a")) {
      // engine/pokemon/mon_submenu.asm:50
      this.playSfx("Sfx_ReadText2");
      const item = menu.items[menu.index - 1];
      const mon = menu.mon;
      const slot = menu.slot || this.index;
      const battle = menu.battle;
      this.closeSubmenu();
      if (!item) return;
      // engine/battle/core.asm:4811-4816
      if (battle && item.id === "SWITCH") {
        if (this.onChoose) this.onChoose(slot, mon);
        return;
      } else if (battle && item.id === "CANCEL") {
        if (this.onCancel) this.onCancel();
        return;
      }
      // A hook-injected entry carries a callback instead of a known id.
      if (item.onSelect && !VANILLA_SUBMENU_IDS[item.id] && !item.fieldMove) {
        item.onSelect(mon, this.game);
      } else if (item.id === "STATS") {
        this.openStats();
      } else if (item.id === "SWITCH") {
        this.beginSwitch(slot);
      } else if (item.id === "MAIL") {
        this.openMailMenu(slot);
      } else if (item.id === "ITEM") {
        this.openHeldItemMenu(slot, mon);
      } else if (item.id === "MOVE") {
        this.openMoveManager(slot, mon);
      } else if (item.fieldMove) {
        this.useFieldMove(item.id, mon);
      }
    }
  }

  /** Lua: PartyMenu.lua:621 */
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: PartyMenu.lua:628 -- engine/pokemon/switchpartymons.asm:13 */
  playSfxTwice(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    // (the Lua's `Sound.resolve and Sound.play` guard is always true here)
    if (!sfx) return;
    if (!sfx[Sound.resolve(data, name)]) return;
    this.playSfx(name);
    this.repeatSfx = WaitPlaySFX.arm(name);
  }

  /** Lua: PartyMenu.lua:638 -- home/audio.asm:225 */
  tickRepeatSfx(): boolean {
    const pending = this.repeatSfx;
    if (!pending) return false;
    if (WaitPlaySFX.waiting(pending)) return true;
    this.repeatSfx = null;
    this.playSfx(pending.name);
    return false;
  }

  /** Lua: PartyMenu.lua:648 -- engine/items/item_effects.asm:1671 */
  showItemResult(slot: number | null | undefined, opts?: ItemResultOpts): void {
    const o = opts ?? {};
    this.itemResult = {
      slot,
      shown: o.fromHp,
      target: o.toHp,
      text: o.text,
      delay: o.delay ?? PartyMenu.ACTION_TEXT_DELAY,
      onDone: o.onDone,
      auto: o.auto,
      holdSlot: o.holdSlot,
      holdHp: o.holdHp,
    };
    if (o.sfx) this.playSfx(o.sfx);
  }

  /** Lua: PartyMenu.lua:666 -- battle/core.asm:5156, home/text.asm:124 */
  refuse(text: string): void {
    this.closeSubmenu();
    const lines = Chrome.wrap(text, 18);
    lines.length = Math.min(lines.length, 2);
    this.showItemResult(null, { text: lines.join("\n"), delay: 0 });
  }

  /** Lua: PartyMenu.lua:673 */
  itemResultClimbing(): boolean {
    const r = this.itemResult;
    return r != null && r.shown != null && r.target != null && r.shown !== r.target;
  }

  /** Lua: PartyMenu.lua:679 -- engine/battle/anim_hp_bar.asm:246 */
  shownHpFor(slot: number, mon: any): number | undefined {
    const r = this.itemResult;
    if (r) {
      if (r.slot === slot && r.shown != null) return r.shown;
      if (r.holdSlot === slot && r.holdHp != null) return r.holdHp;
    }
    return mon && mon.hp;
  }

  /** Lua: PartyMenu.lua:688 */
  updateItemResult(input: any): void {
    const r = this.itemResult!;
    if (this.itemResultClimbing()) {
      const mon = this.party[(r.slot ?? 0) - 1];
      const maxHp = mon ? mon.maxHp || (mon.stats && mon.stats.hp) : 0;
      r.shown = HpBar.stepToward(r.shown, r.target, maxHp || 0);
      return;
    }
    if (r.auto) {
      this.itemResult = null;
      if (r.onDone) r.onDone();
      return;
    }
    if (r.delay > 0) {
      r.delay = r.delay - 1;
      return;
    }
    if (input.wasPressed("a") || input.wasPressed("b")) {
      this.itemResult = null;
      if (r.onDone) r.onDone();
    }
  }

  /** Lua: PartyMenu.lua:711 */
  update(_dt?: number): void {
    this.clock = this.clock + 1;
    const input = this.game && this.game.input;
    if (!input) return;
    // home/audio.asm:225
    if (this.tickRepeatSfx()) return;
    if (this.itemResult) {
      this.updateItemResult(input);
      return;
    }
    if (this.submenu) {
      this.updateSubmenu(input);
      return;
    }
    if (this.switchFrom) {
      this.updateSwitch(input);
      return;
    }
    if (this.softboiledFrom) {
      this.updateSoftboiled(input);
      return;
    }
    const total = this.count();
    let grid: number | undefined;
    if (this.gridNavigation()) {
      const direction =
        (input.wasPressed("left") && "left") ||
        (input.wasPressed("right") && "right") ||
        (input.wasPressed("up") && "up") ||
        (input.wasPressed("down") && "down");
      grid = gridIndex(this.index, this.party.length, direction);
    }
    if (grid) {
      this.index = grid;
      this.storeCursor();
    } else if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      // engine/pokemon/party_menu.asm:694
      this.playSfx("Sfx_ReadText2");
      this.storeCursor();
      if (this.isCancel()) {
        if (this.onCancel) this.onCancel();
      } else if (this.wantsSubmenu || this.wantsBattleSubmenu) {
        this.openSubmenu();
      } else if (this.onChoose) {
        const mon = this.party[this.index - 1];
        if (this.tmhm && mon && mon.isEgg) {
          // engine/items/tmhm.asm:104
          const world = this.game && this.game.world;
          if (world && world.playSfxNamed) world.playSfxNamed("Sfx_Wrong");
          return;
        }
        this.onChoose(this.index, mon);
      }
    } else if (input.wasPressed("b")) {
      // engine/pokemon/party_menu.asm:701
      this.playSfx("Sfx_ReadText2");
      this.storeCursor();
      if (this.onCancel) this.onCancel();
    }
  }

  /**
   * Lua: PartyMenu.lua:779 -- PartyMenuSelect's `ld [wPartyMenuCursor], a`
   * (party_menu.asm:600): only the CANCEL row leaves the byte alone.
   */
  storeCursor(): void {
    const game = this.game;
    if (!game || this.isCancel()) return;
    game.partyMenuCursor = this.index;
  }

  /** Lua: PartyMenu.lua:787 -- ReadMonMenuIcon (engine/gfx/mon_icons.asm) */
  iconIdFor(mon: any): string | undefined {
    if (!mon) return undefined;
    if (mon.isEgg) return "ICON_EGG";
    return (this.icons && this.icons.species && mon.species && this.icons.species[mon.species]) || undefined;
  }

  /**
   * Lua: PartyMenu.lua:804 -- the icon image for a mon plus which 16x16 frame
   * to show; the path goes out through pokemon.icon (Sprites.iconPath).
   */
  iconFor(mon: any): [LcdImage, number] | [] {
    const iconId = this.iconIdFor(mon);
    const entry = iconId && this.icons && this.icons.icons && this.icons.icons[iconId];
    const vanilla = entry && entry.image;
    const [path] = Sprites.iconPath(this.game && this.game.data, mon, vanilla, { name: iconId });
    if (!path) return [];
    let cached = this.iconCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.iconCache[path] = cached;
    }
    if (!cached) return [];
    const frame = Math.floor(this.clock / ICON_FRAME_STEPS) % 2;
    return [cached, frame];
  }

  /**
   * Lua: PartyMenu.lua:831 -- .SpawnItemIcon: a mon carrying something gets
   * its icon's bottom-left tile swapped. 0 is mail, 1 is item, nil for empty.
   */
  static heldMarkerRow(mon: any): number | undefined {
    if (mon == null || typeof mon !== "object") return undefined;
    const item = mon.item;
    if (item == null || item === 0 || item === "") return undefined;
    return Mail.monHoldsMail(mon) ? 0 : 1;
  }

  /** Lua: PartyMenu.lua:843 -- the HeldItemIcons sheet. */
  heldMarkerImage(): LcdImage | undefined {
    const entry = this.icons && this.icons.heldItem;
    if (!(entry && entry.image)) return undefined;
    let cached = this.iconCache[entry.image];
    if (cached === undefined) {
      try {
        cached = Assets.image(entry.image);
      } catch {
        cached = false;
      }
      this.iconCache[entry.image] = cached;
    }
    return cached || undefined;
  }

  /** Lua: PartyMenu.lua:860 -- AnimSeq_PartyMon: the selected icon slides a tile right. */
  iconX(index: number): number {
    return index === this.index ? 8 : 0;
  }

  /** Lua: PartyMenu.lua:867 -- AnimSeq_PartyMonSwitch: two pixels high half the time. */
  iconBob(index: number): number {
    if (index !== this.index) return 0;
    return Math.floor(this.clock / 16) % 2 === 1 ? -2 : 0;
  }

  /** Lua: PartyMenu.lua:872 */
  drawIcon(mon: any, px: number, py: number): void {
    const [image, frame] = this.iconFor(mon);
    if (!image) return;
    const f = frame ?? 0;
    const [iw, ih] = image.getDimensions();
    const markerRow = PartyMenu.heldMarkerRow(mon);
    const marker = markerRow !== undefined ? this.heldMarkerImage() : undefined;
    let paint: () => void;
    if (marker) {
      // The _WITH_ITEM / _WITH_MAIL OAM sets replace the bottom-left tile; the
      // marker does not bob with the frame.
      const [mw, mh] = marker.getDimensions();
      const topLeft = G.newQuad(0, f * 16, 8, 8, iw, ih);
      const topRight = G.newQuad(8, f * 16, 8, 8, iw, ih);
      const bottomRight = G.newQuad(8, f * 16 + 8, 8, 8, iw, ih);
      const held = G.newQuad(0, markerRow! * 8, 8, 8, mw, mh);
      paint = () => {
        G.draw(image, topLeft, px, py);
        G.draw(image, topRight, px + 8, py);
        G.draw(image, bottomRight, px + 8, py + 8);
        G.draw(marker, held, px, py + 8);
      };
    } else {
      const quad = G.newQuad(0, f * 16, 16, 16, iw, ih);
      paint = () => G.draw(image, quad, px, py);
    }
    G.setColor(1, 1, 1, 1);
    // Every party icon is PAL_OW_RED and InitPartyMenuOBPals loads
    // PartyMenuOBPals into OBJ 0 (engine/gfx/color.asm:593-598).
    const pals = this.palettes && this.palettes.partyMenu;
    const colors = pals ? pals[0] : undefined;
    if (colors && GbcPalette.available()) GbcPalette.with(colors, paint);
    else paint();
  }

  /**
   * Lua: PartyMenu.lua:921 -- PlacePartyHPBar calls DrawBattleHPBar: "HP:",
   * six bar cells and the end cap, the battle HUD's bar tile for tile.
   */
  drawHpBar(mon: any, tx: number, ty: number, hp?: number): number {
    const maxHp = mon.maxHp || (mon.stats && mon.stats.hp);
    if (hp == null) hp = mon.hp;
    if (this.hud && this.hud.available()) return this.hud.drawHpBar(hp ?? 0, maxHp, tx, ty);
    // No battle-HUD sheet: the plain bar, two tiles in.
    HpBar.draw(gPainter, this.palettes, hp, maxHp, (tx + 2) * 8, ty * 8 + 2);
    return tx + 2 + HpBar.LENGTH_TILES;
  }

  /**
   * Lua: PartyMenu.lua:966 -- one row's strings, what WritePartyMenuTilemap's
   * routines write. An egg is a name and an icon alone.
   */
  static rowFor(mon: any, hp?: number, statuses?: any): PartyRow {
    if (mon.isEgg) return { name: Strings.get(EGG_LABEL) };
    const maxHp = mon.maxHp || (mon.stats && mon.stats.hp) || 0;
    if (hp == null) hp = mon.hp;
    return {
      name: mon.nickname || mon.name || mon.species || "?",
      hp: num3(hp) + "/" + num3(maxHp),
      status: statusString(mon, hp, statuses),
      // <LV> is one font glyph ($6e).
      level: "<LV>" + tostring(mon.level || 1),
    };
  }

  /** Lua: PartyMenu.lua:980 -- engine/pokemon/party_menu.asm:331 */
  tmhmAble(mon: any): string | undefined {
    if (!mon || mon.isEgg) return undefined;
    const move = this.tmhm && this.tmhm.move;
    if (!move) return undefined;
    const species = this.pokemon && this.pokemon[mon.species];
    for (const id of (species && species.tmhm) || []) {
      if (id === move) return Strings.get(ABLE_LABEL);
    }
    return Strings.get(NOT_ABLE_LABEL);
  }

  /**
   * Lua: PartyMenu.lua:1009 -- WritePartyMenuTilemap, entry by entry:
   *   PlacePartyNicknames (3,1), PlacePartyMenuHPDigits (13,1),
   *   PlacePartyMonStatus (5,2), PlacePartyMonLevel (8,2),
   *   PlacePartyHPBar (11,2), icons at pixel (x, 4 + 16 * i),
   *   cursor at column 0, PlacePartyMenuText box at (0,14).
   */
  drawPanel(): void {
    // LoadPartyMenuGFX starts with LoadFontsBattleExtra.
    const wasBattle = Font.useBattleExtra(true);
    Chrome.clear();

    this.party.forEach((mon, idx) => {
      const i = idx + 1;
      const nameY = 1 + (i - 1) * 2;
      const dataY = nameY + 1;
      if (i === this.index) {
        Chrome.cursor(0, nameY);
      } else if (this.switchFrom === i) {
        // SwitchPartyMons parks '▷' on the held row.
        Chrome.cursor(0, nameY, true);
      }
      this.drawIcon(mon, this.iconX(i), 4 + (i - 1) * 16 + this.iconBob(i));
      const hp = this.shownHpFor(i, mon);
      const row = PartyMenu.rowFor(mon, hp, this.game && this.game.data && this.game.data.gen2Statuses);
      Chrome.print(row.name, 3, nameY);
      if (this.tmhm) {
        const able = this.tmhmAble(mon);
        if (able) Chrome.print(able, 12, dataY);
      } else {
        if (row.hp) Chrome.print(row.hp, 13, nameY);
        if (row.hp) this.drawHpBar(mon, 11, dataY, hp);
      }
      if (row.status) Chrome.print(row.status, 5, dataY);
      if (row.level) Chrome.print(row.level, 8, dataY);
    });

    // .end does `dec hl` twice: CANCEL starts two columns left of the names.
    const cancelY = 1 + this.party.length * 2;
    if (this.isCancel()) Chrome.cursor(0, cancelY);
    Chrome.print(actionLabel("CANCEL"), 1, cancelY);

    // The prompt is ordinary text.
    Font.useBattleExtra(wasBattle);
    // engine/pokemon/party_menu.asm:698
    if (this.itemResult && this.itemResult.text && !this.itemResultClimbing()) {
      Chrome.textbox(0, 12, 18, 4);
      let line = 14;
      for (const part of tostring(this.itemResult.text).split("\n").filter((s) => s !== "")) {
        if (line <= 16) Chrome.print(part, 1, line);
        line = line + 2;
      }
    } else {
      Chrome.box(0, 14, 20, 4);
      // Port fix (not in the Lua): PokemonActionSubmenu's `hlcoord 1, 15 /
      // lb bc, 2, 18 / call ClearBox` (engine/pokemon/mon_menu.asm) runs
      // before MonSubmenu's LoadMenuHeader, so the cleared box is what the
      // submenu -- and the GIVE/TAKE or MAIL menu it opens, drawn over this
      // list -- leaves behind. The Lua's comment intends exactly this, but its
      // box starts at column 6 and the prompt showed through to its left.
      if (this.submenu || this.promptCleared) {
        if (this.submenu) this.drawSubmenu();
        G.setColor(1, 1, 1, 1);
        return;
      }
      // item_effects.asm:2016
      const prompt = this.switchFrom
        ? Strings.get(PROMPTS.moveTo!)
        : this.softboiledFrom
          ? Strings.get(PROMPTS.useItem!)
          : this.promptIsBuiltin
            ? Strings.get(this.prompt)
            : this.prompt;
      Chrome.print(this.party.length === 0 ? Strings.get(PROMPTS.none!) : prompt, 1, 16);
    }
    // PokemonActionSubmenu clears the prompt before MonSubmenu draws.
    if (this.submenu) this.drawSubmenu();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: PartyMenu.lua:1077 -- MenuBox over the bottom right of the list. */
  drawSubmenu(): void {
    const menu = this.submenu!;
    // GetMenuTextStartCoord (home/menu.asm:199-226).
    if (menu.battle) {
      Chrome.box(BATTLE_SUBMENU_LEFT, BATTLE_SUBMENU_TOP, 9, 7);
      menu.items.forEach((item, i) => {
        const row = i + 1;
        const ty = BATTLE_SUBMENU_TOP + 1 + (row - 1) * 2;
        if (row === menu.index) Chrome.cursor(BATTLE_SUBMENU_LEFT + 1, ty);
        Chrome.print(item.label, BATTLE_SUBMENU_LEFT + 2, ty);
      });
      return;
    }
    const count = menu.items.length;
    const top = PartyMenu.submenuTop(count);
    Chrome.box(SUBMENU_LEFT, top, SUBMENU_RIGHT - SUBMENU_LEFT + 1, SUBMENU_BOTTOM - top + 1);
    menu.items.forEach((item, i) => {
      const row = i + 1;
      const [tx, ty] = PartyMenu.submenuLabelCoord(count, row);
      if (row === menu.index) Chrome.cursor(tx - 1, ty);
      Chrome.print(item.label, tx, ty);
    });
  }

  /** Lua: PartyMenu.lua:1101 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: PartyMenu.lua:1105 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default PartyMenu;
