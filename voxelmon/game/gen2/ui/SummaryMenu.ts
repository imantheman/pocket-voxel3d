// gen1recomp src/ui/gen2/SummaryMenu.lua (bdfac727, MIT): Gold's mon
// SUMMARY, transcribed from engine/pokemon/stats_screen.asm.
//
// Three pages, named after the palette each one wears: PINK_PAGE (1),
// GREEN_PAGE (2), BLUE_PAGE (3).
//
//   PINK   HP bar, HP digits, STATUS/TYPE, and the EXP POINTS / LEVEL UP TO
//          block down the right of a vertical rule at column 9
//   GREEN  the held ITEM, then the four moves with their PP
//   BLUE   OT / <ID>№ down the left of a vertical rule at column 10, and the
//          five non-HP stats down its right
//
// None of the three is a text box: StatsScreenMain calls ClearTilemap and
// every routine writes tiles at its own hlcoord, so every coordinate here is
// that hlcoord. StatsScreen_InitUpperHalf draws rows 0-7 once, which is why
// `upperPlacements` is separate from the per-page ones and why switching
// pages does not replay the cry.
//
// Tiles that are not glyphs come from gfx/stats/stats_tiles.png at $31
// (menu_gfx.stats): $31 the vertical divider, $36-$39 the small page square,
// $3a-$3d the large one, $3f the shiny icon, $40/$41 the bar end caps.
//
// Move descriptions live on PlaceMoveData's screen (MoveScreenLoop,
// engine/pokemon/mon_menu.asm), transcribed as `moveDetailPlacements`.
// SELECT opens it from the green page (Brian's hook; SELECT is outside the
// stats screen's button mask). ManagePokemonMoves opens it on its own: that
// is `moveScreen`, where B exits instead of dropping onto a page.

import G, { type LcdImage, type Quad } from "../platform/screen.ts";
import { tonumber, tostring } from "../platform/lua.ts";
import { HpBar, type HpBarPainter } from "../battle/HpBar.ts";
import { Mon } from "../battle/Mon.ts";
import { ItemEffects } from "../core/ItemEffects.ts";
import { Pokerus } from "../core/Pokerus.ts";
import { Unown } from "../core/Unown.ts";
import { Palettes } from "../world/Palettes.ts";
import { Status } from "../shared/battle/Status.ts";
import { TypeChart } from "../shared/battle/TypeChart.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { MonAnimView } from "../shared/render/MonAnimView.ts";
import { BattleHud } from "./BattleHud.ts";
import { Chrome } from "./Chrome.ts";
import { WaitPlaySFX, type PendingSfx } from "./WaitPlaySFX.ts";

type Rgb = number[];
type Colors = Rgb[];

// Lua: SummaryMenu.lua:81 -- the *_PAGE constants at the top of stats_screen.asm.
const PINK_PAGE = 1;
const GREEN_PAGE = 2;
const BLUE_PAGE = 3;

// Lua: SummaryMenu.lua:92 -- StatsScreenPageTilesGFX tile ids.
const TILE_VERTICAL_DIVIDER = 0x31;
const TILE_SQUARE_SMALL = 0x36;
const TILE_SQUARE_LARGE = 0x3a;
const TILE_SHINY = 0x3f;
const TILE_BAR_CAP_LEFT = 0x40;
const TILE_BAR_CAP_RIGHT = 0x41;
// FontBattleExtra's empty HP/exp bar cell (StatsScreen_PlaceHorizontalDivider).
const TILE_HORIZONTAL_DIVIDER = 0x62;

// Lua: SummaryMenu.lua:104 -- gfx/stats/pages.pal (cgb_layouts.asm:199-212).
const PAGE_PALETTES: Colors[] = [
  [[255, 255, 255], [255, 156, 255], [255, 123, 255], [0, 0, 0]],
  [[255, 255, 255], [173, 255, 115], [140, 255, 0], [0, 0, 0]],
  [[255, 255, 255], [140, 255, 255], [140, 255, 255], [0, 0, 0]],
];

// Lua: SummaryMenu.lua:112 -- gfx/stats/stats.pal (color.asm:386-390).
const PAGE_TINTS: Rgb[] = [
  [255, 156, 255],
  [173, 255, 115],
  [140, 255, 255],
];

// Lua: SummaryMenu.lua:121 -- PrintTempMonStats' .StatNames and their fields.
const STAT_LABELS = [
  Strings.source("ATTACK"), Strings.source("DEFENSE"),
  Strings.source("SPCL.ATK"), Strings.source("SPCL.DEF"),
  Strings.source("SPEED"),
];
const STAT_KEYS = ["attack", "defense", "specialAttack", "specialDefense", "speed"];

// Lua: SummaryMenu.lua:130
const FAINTED_LABEL = Strings.source("FNT");
const OK_LABEL = Strings.source("OK");
const POKERUS_LABEL = Strings.source("POKéRUS");
const TO_LABEL = Strings.source("TO");
const PP_LABEL = Strings.source("PP");
const ATTACK_POWER_LABEL = Strings.source("ATTK/");
const OT_LABEL = Strings.source("OT/");
const ID_LABEL = Strings.source("<ID>№.");
const DEX_NUMBER_LABEL = Strings.source("№.");
const EGG_LABEL = Strings.source("EGG");

// Lua: SummaryMenu.lua:144 -- PadFrontpic centres 5x5/6x6 pics in the 7x7 block.
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

// Lua: SummaryMenu.lua:148
function isEggMon(mon: any): boolean {
  return mon != null && typeof mon === "object" && mon.isEgg === true;
}

// Lua: SummaryMenu.lua:157 -- EggStatsScreen's four flavour strings.
const EGG_FLAVOR: { below?: number; text: string }[] = [
  { below: 0x6, text: Strings.source("It's making sounds<NEXT>inside. It's going<NEXT>to hatch soon!") },
  { below: 0xb, text: Strings.source("It moves around<NEXT>inside sometimes.<NEXT>It must be close<NEXT>to hatching.") },
  { below: 0x29, text: Strings.source("Wonder what's<NEXT>inside? It needs<NEXT>more time, though.") },
  { text: Strings.source("This EGG needs a<NEXT>lot more time to<NEXT>hatch.") },
];

// Lua: SummaryMenu.lua:164
function eggFlavor(cycles: number): string | undefined {
  for (const entry of EGG_FLAVOR) {
    if (entry.below === undefined || cycles < entry.below) return Strings.get(entry.text);
  }
  return undefined;
}

export interface Placement {
  text: string;
  x: number;
  y: number;
}

// Lua: SummaryMenu.lua:176
function put(list: Placement[], text: unknown, x: number, y: number): Placement[] {
  if (text == null) return list;
  list.push({ text: tostring(text), x, y });
  return list;
}

// Lua: SummaryMenu.lua:191 -- PrintNum.
function num(value: number | null | undefined, width: number, leadingZeros?: boolean): string {
  return Chrome.number(value, width, leadingZeros);
}

// Lua: SummaryMenu.lua:198 -- how many tiles a string occupies.
function tiles(text: unknown): number {
  return Font.split(tostring(text ?? "")).length;
}

// Lua: SummaryMenu.lua:204
function monName(mon: any): string {
  return mon.nickname || mon.name || mon.species || "?";
}

// Lua: SummaryMenu.lua:212 -- blank whole tile cells under a string placed on
// a box border row.
function clearCells(tx: number, ty: number, tw: number, th?: number): void {
  G.setColor(1, 1, 1, 1);
  G.rectangle("fill", tx * 8, ty * 8, tw * 8, (th ?? 1) * 8);
  G.setColor(0, 0, 0, 1);
}

// Lua: SummaryMenu.lua:222 -- PrintLevel: a three-digit level overwrites <LV>.
function levelText(level: unknown): string {
  const lv = Math.max(1, Math.floor(tonumber(level) ?? 1));
  if (lv >= 100) return tostring(lv);
  return "<LV>" + tostring(lv);
}

// Lua: SummaryMenu.lua:231 -- PlaceStatusString.
function statusText(mon: any, statuses: any): string | null {
  if ((mon.hp ?? 0) <= 0) return Strings.get(FAINTED_LABEL);
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

// Lua: SummaryMenu.lua:250 -- wTempMonPokerusStatus: infected, then immune.
function pokerusState(mon: any): "infected" | "immune" | null {
  if (Pokerus.isInfected(mon)) return "infected";
  if (Pokerus.isImmune(mon)) return "immune";
  return null;
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
  text(s, x, y) {
    Font.draw(s, x, y);
  },
};

export interface SummaryMenuOpts {
  mon?: any;
  party?: any[];
  index?: number;
  page?: number;
  moveScreen?: boolean;
  onClose?: () => void;
  save?: any;
  pokemon?: any;
  moves?: any;
  items?: any;
  palettes?: any;
  menuGfx?: any;
  icons?: any;
}

interface StatsSheet {
  image: LcdImage;
  quads: Record<number, Quad>;
}

export class SummaryMenu {
  [key: string]: any;
  // Lua: SummaryMenu.lua:78
  static isOpaque = true;
  static PINK_PAGE = PINK_PAGE;
  static GREEN_PAGE = GREEN_PAGE;
  static BLUE_PAGE = BLUE_PAGE;
  static NUM_STAT_PAGES = 3;
  // Lua: SummaryMenu.lua:1335
  static STAT_LABELS = STAT_LABELS;
  static STAT_KEYS = STAT_KEYS;
  static PAGE_PALETTES = PAGE_PALETTES;
  static PAGE_TINTS = PAGE_TINTS;
  static levelText = levelText;

  isOpaque = true;
  game: any;
  save: any;
  pokemon: any;
  moves: any;
  items: any;
  palettes: any;
  menuGfx: any;
  icons: any;
  onClose?: () => void;
  party: any[];
  index: number;
  mon: any;
  page: number;
  moveScreen: boolean;
  moveDetail: boolean;
  moveIndex: number;
  swapFrom: number | null;
  picCache: Record<string, LcdImage | false>;
  picAnim: MonAnimView | null = null;
  repeatSfx: PendingSfx | null = null;
  statsSheet: StatsSheet | false | undefined = undefined;
  hud: BattleHud;

  /** Lua: SummaryMenu.lua:183 -- the text a placement list writes at a coordinate. */
  static at(placements: Placement[] | null | undefined, x: number, y: number): string | undefined {
    for (const entry of placements || []) {
      if (entry.x === x && entry.y === y) return entry.text;
    }
    return undefined;
  }

  /** Lua: SummaryMenu.lua:258 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: SummaryMenu.lua:259 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: SummaryMenu.lua:263 -- opts: mon, party, index, page, moveScreen,
   * onClose(), save, pokemon, moves, items, palettes, menuGfx
   */
  static new(game: any, opts?: SummaryMenuOpts): SummaryMenu {
    return new SummaryMenu(game, opts ?? {});
  }

  constructor(game: any, opts: SummaryMenuOpts) {
    this.game = game;
    const data = (game && game.data) || {};
    this.save = opts.save || (game && game.save);
    this.pokemon = opts.pokemon || data.pokemon;
    this.moves = opts.moves || data.moves;
    this.items = opts.items || data.items;
    this.palettes = opts.palettes || data.gen2Palettes;
    // The egg page's pic comes off menu_gfx.eggHatch.
    this.menuGfx = opts.menuGfx || data.gen2MenuGfx;
    this.icons = opts.icons || data.gen2Icons;
    this.onClose = opts.onClose;
    if (opts.mon && !opts.party) {
      // One mon on its own: the TEMPMON / BOXMON path.
      this.party = [opts.mon];
      this.index = 1;
      this.mon = opts.mon;
    } else {
      this.party = opts.party || (this.save && this.save.party) || [];
      this.index = Math.max(1, Math.min(opts.index || 1, Math.max(1, this.party.length)));
      this.mon = this.party[this.index - 1];
    }
    // engine/pokemon/move_mon.asm:1402
    Mon.refreshStats(this.mon, data);
    this.page = opts.page || PINK_PAGE;
    this.moveScreen = opts.moveScreen === true;
    this.moveDetail = this.moveScreen;
    this.moveIndex = 1;
    // wSwappingMove: the row A picked a move up from.
    this.swapFrom = null;
    this.picCache = {};
    // DrawPlayerHP is DrawBattleHPBar and the exp bar is FillInExpBar.
    this.hud = BattleHud.new(data.gen2MenuGfx, this.palettes);
    this.playCry();
  }

  /**
   * Lua: SummaryMenu.lua:316 -- StatsScreen_PlaceFrontpic ends in PlayMonCry:
   * on open and on a mon switch, never on a page switch. MoveScreenLoop has
   * none; an egg plays SFX_2_BOOPS only when nearly ready
   * (stats_screen.asm:788).
   */
  playCry(): void {
    const mon = this.mon;
    if (this.moveScreen) return;
    if (isEggMon(mon)) {
      if ((mon.eggSteps || 0) >= 0x6) return;
      if (!(this.game && this.game.data)) return;
      try {
        Sound.play(this.game.data, "Sfx_2Boops");
      } catch {
        // pcall(Sound.play, ...)
      }
      return;
    }
    if (!(mon && mon.species && this.game && this.game.data)) return;
    try {
      Sound.playCry(this.game.data, mon.species);
    } catch {
      // pcall(Sound.playCry, ...)
    }
    this.startPicAnim();
  }

  /** Lua: SummaryMenu.lua:348 -- ANIM_MON_MENU (stats_screen.asm:889-901). */
  startPicAnim(): void {
    const mon = this.mon;
    const [path, , vanilla] = this.picPath(mon);
    this.picAnim = MonAnimView.start(
      mon && this.pokemon && this.pokemon[mon.species],
      mon,
      "menu",
      (p) => this.picImage(p),
      undefined,
      {
        resolve: (sheet) => Sprites.pic(sheet, this.picCtx(mon, "summary_anim")),
        staticReplaced: MonAnimView.replaced(vanilla, path),
      },
    );
  }

  /** Lua: SummaryMenu.lua:363 -- AnimateFrontpic's .loop (pic_animation.asm:79-89). */
  stepPicAnim(): void {
    const anim = this.picAnim;
    if (!anim) return;
    if (anim.step()) this.picAnim = null;
  }

  /** Lua: SummaryMenu.lua:370 */
  picAnimFrame(): [LcdImage, Quad, number] | null {
    const anim = this.picAnim;
    if (!anim) return null;
    return anim.frame();
  }

  /** Lua: SummaryMenu.lua:376 */
  speciesDef(): any {
    const mon = this.mon;
    return (mon && this.pokemon && this.pokemon[mon.species]) || undefined;
  }

  /** Lua: SummaryMenu.lua:381 */
  moveDef(id: any): any {
    return (id && this.moves && this.moves[id]) || undefined;
  }

  /** Lua: SummaryMenu.lua:387 */
  moveList(): any[] {
    return (this.mon && this.mon.moves) || [];
  }

  /** Lua: SummaryMenu.lua:391 */
  moveName(entry: any): string | undefined {
    if (!entry) return undefined;
    const def = this.moveDef(entry.id);
    return (def && def.name) || entry.id;
  }

  /** Lua: SummaryMenu.lua:400 */
  growth(): any {
    const def = this.speciesDef();
    if (!(this.pokemon && def)) return undefined;
    const data = (this.game && this.game.data) || { pokemon: this.pokemon };
    return Mon.growthFor(data, def.growthRate);
  }

  /** Lua: SummaryMenu.lua:409 -- .CalcExpToNextLevel */
  expToNext(): number {
    const mon = this.mon || {};
    const level = mon.level || 1;
    if (level >= Mon.MAX_LEVEL) return 0;
    return Math.max(0, Mon.experienceForLevel(this.growth(), level + 1) - (mon.experience || 0));
  }

  /** Lua: SummaryMenu.lua:417 */
  otName(): string {
    const mon = this.mon || {};
    if (mon.otName) return mon.otName;
    const player = (this.save && this.save.player) || {};
    return player.name || "GOLD";
  }

  /** Lua: SummaryMenu.lua:424 */
  otId(): number {
    const mon = this.mon || {};
    if (mon.otId) return mon.otId;
    const player = (this.save && this.save.player) || {};
    return player.id || 0;
  }

  /**
   * Lua: SummaryMenu.lua:436 -- .PlaceOTInfo's padding: an ordinary name gets
   * two columns, only a 9 or 10 character one is pulled left.
   */
  static otColumn(name: string): number {
    let pad = 10 - tiles(name);
    if (pad >= 3 || pad < 0) pad = 2;
    return pad;
  }

  /** Lua: SummaryMenu.lua:442 */
  itemName(): string | undefined {
    const mon = this.mon || {};
    if (!mon.item) return undefined;
    const def = this.items && this.items[mon.item];
    return (def && def.name) || mon.item;
  }

  /** Lua: SummaryMenu.lua:449 -- PrintMonTypes' .hide_type_2. */
  typeNames(): [string | undefined, string | undefined] {
    const def = this.speciesDef();
    const types = (this.mon && this.mon.types) || (def && def.types) || [];
    const first = types[0];
    const second = types[1] ?? first;
    const name = (id: any): string | undefined => {
      if (!id) return undefined;
      return TypeChart.displayName(id, this.game && this.game.data);
    };
    if (first && second && first === second) return [name(first), undefined];
    return [name(first), name(second)];
  }

  // ------------------------------------------------------------ upper half

  /** Lua: SummaryMenu.lua:467 -- StatsScreen_InitUpperHalf. */
  upperPlacements(): Placement[] {
    const mon = this.mon || {};
    const def = this.speciesDef();
    const out: Placement[] = [];
    // (8,0) '№' and (9,0) '.', then the dex number at (10,0).
    put(out, Strings.get(DEX_NUMBER_LABEL), 8, 0);
    put(out, num((def && def.dex) || 0, 3, true), 10, 0);
    put(out, levelText(mon.level), 14, 0);
    put(out, mon.nickname || mon.name || mon.species, 8, 2);
    // GetGender: a genderless species writes nothing.
    if (mon.gender === "male") put(out, "♂", 18, 0);
    else if (mon.gender === "female") put(out, "♀", 18, 0);
    // (9,4) is a bare '/', the species name follows at (10,4).
    put(out, "/", 9, 4);
    put(out, (def && def.name) || mon.species, 10, 4);
    return out;
  }

  // ------------------------------------------------------------- pink page

  /** Lua: SummaryMenu.lua:492 */
  pinkPlacements(): Placement[] {
    const mon = this.mon || {};
    const maxHp = mon.maxHp || (mon.stats && mon.stats.hp) || 0;
    const out: Placement[] = [];
    // DrawPlayerHP's digits at (1,10).
    put(out, num(mon.hp, 3), 1, 10);
    put(out, "/", 4, 10);
    put(out, num(maxHp, 3), 5, 10);
    // "STATUS/" <NEXT> "TYPE/": the second label is two rows down.
    put(out, Strings.get("STATUS/"), 0, 12);
    put(out, Strings.get("TYPE/"), 0, 14);

    const pokerus = pokerusState(mon);
    if (pokerus === "infected") {
      put(out, Strings.get(POKERUS_LABEL), 1, 13);
    } else {
      if (pokerus === "immune") put(out, ".", 8, 8);
      put(out, statusText(mon, this.game && this.game.data && this.game.data.gen2Statuses) || Strings.get(OK_LABEL), 6, 13);
    }

    // PrintMonTypes then LoadPinkPage's row-17-to-16 copy.
    const [type1, type2] = this.typeNames();
    put(out, type1, 1, 15);
    put(out, type2, 1, 16);

    put(out, Strings.get("EXP POINTS"), 10, 9);
    // `lb bc, 3, 7`: seven columns from (13,10).
    put(out, num(mon.experience, 7), 13, 10);
    put(out, Strings.get("LEVEL UP"), 10, 12);
    put(out, num(this.expToNext(), 7), 13, 13);
    put(out, Strings.get(TO_LABEL), 14, 14);
    // The NEXT level at (17,14); MAX_LEVEL stays put.
    const level = mon.level || 1;
    put(out, levelText(Math.min(Mon.MAX_LEVEL, level + 1)), 17, 14);
    return out;
  }

  // ------------------------------------------------------------ green page

  /** Lua: SummaryMenu.lua:542 */
  greenPlacements(): Placement[] {
    const out: Placement[] = [];
    put(out, Strings.get("ITEM"), 0, 8);
    put(out, this.itemName() || "---", 6, 8);
    put(out, Strings.get("MOVE"), 0, 10);
    // ListMoves from (8,10), ListMovePP from (12,11), two rows apart.
    const moves = this.moveList();
    for (let slot = 1; slot <= 4; slot++) {
      const nameY = 10 + (slot - 1) * 2;
      const ppY = nameY + 1;
      const entry = moves[slot - 1];
      if (entry) {
        put(out, this.moveName(entry), 8, nameY);
        put(out, Strings.get(PP_LABEL), 12, ppY);
        put(out, num(entry.pp, 2), 15, ppY);
        put(out, "/", 17, ppY);
        put(out, num(entry.maxPp ?? entry.pp, 2), 18, ppY);
      } else {
        put(out, "-", 8, nameY);
        put(out, "--", 12, ppY);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- blue page

  /** Lua: SummaryMenu.lua:577 */
  bluePlacements(): Placement[] {
    const mon = this.mon || {};
    const out: Placement[] = [];
    put(out, Strings.get(ID_LABEL), 0, 9);
    put(out, num(this.otId(), 5, true), 2, 10);
    put(out, Strings.get(OT_LABEL), 0, 12);
    const ot = this.otName();
    put(out, ot, SummaryMenu.otColumn(ot), 13);
    // PrintTempMonStats at (11,8); values from (17,9), three wide.
    STAT_LABELS.forEach((label, i) => {
      put(out, Strings.get(label), 11, 8 + i * 2);
      const value = (mon.stats || {})[STAT_KEYS[i]!];
      put(out, num(value, 3), 17, 9 + i * 2);
    });
    return out;
  }

  // ------------------------------------------------------- move detail view

  /**
   * Lua: SummaryMenu.lua:606 -- SetUpMoveScreenBG + SetUpMoveList +
   * PlaceMoveData (engine/pokemon/mon_menu.asm).
   */
  moveDetailPlacements(): Placement[] {
    const mon = this.mon || {};
    const out: Placement[] = [];
    const name = monName(mon);
    put(out, name, 5, 1);
    // The level butts up against the nickname.
    put(out, levelText(mon.level), 5 + tiles(name), 1);

    const moves = this.moveList();
    for (let slot = 1; slot <= 4; slot++) {
      const nameY = 3 + (slot - 1) * 2;
      const ppY = nameY + 1;
      const entry = moves[slot - 1];
      if (entry) {
        put(out, this.moveName(entry), 2, nameY);
        put(out, Strings.get(PP_LABEL), 10, ppY);
        put(out, num(entry.pp, 2), 13, ppY);
        put(out, "/", 15, ppY);
        put(out, num(entry.maxPp ?? entry.pp, 2), 16, ppY);
      } else {
        put(out, "-", 2, nameY);
        put(out, "--", 10, ppY);
      }
    }

    // .moving_move: the data half reads "Where?" alone.
    if (this.swapFrom) {
      put(out, "┌─────┐", 0, 10);
      put(out, "│", 0, 11);
      put(out, "└", 6, 11);
      put(out, Strings.get("Where?"), 1, 12);
      return out;
    }

    // String_MoveType_Top / _Bottom.
    put(out, "┌─────┐", 0, 10);
    put(out, "│" + Strings.get("TYPE/") + "└", 0, 11);
    put(out, Strings.get(ATTACK_POWER_LABEL), 11, 12);

    const entry = moves[this.moveIndex - 1];
    const def = entry && this.moveDef(entry.id);
    const moveType = def && def.type;
    put(out, moveType ? TypeChart.displayName(moveType, this.game && this.game.data) : "---", 2, 12);
    // `cp 2; jr c, .no_power`
    const power = (def && def.power) || 0;
    if (power >= 2) put(out, num(power, 3), 16, 12);
    else put(out, "---", 16, 12);

    // PrintMoveDescription at (1,14); <NEXT> is two rows down.
    const description = (def && def.description) || "";
    let ty = 14;
    const lines = (tostring(description) + "<NEXT>").split("<NEXT>");
    lines.pop();
    for (const line of lines) {
      if (ty > 16) break;
      if (line !== "") put(out, line, 1, ty);
      ty = ty + 2;
    }
    return out;
  }

  // --------------------------------------------------------------- egg page

  /** Lua: SummaryMenu.lua:684 -- EggStatsScreen. */
  eggPlacements(): Placement[] {
    const mon = this.mon || {};
    const out: Placement[] = [];
    put(out, Strings.get(EGG_LABEL), 8, 1);
    put(out, Strings.get(ID_LABEL), 8, 3);
    put(out, "?????", 11, 3);
    put(out, Strings.get(OT_LABEL), 8, 5);
    put(out, "?????", 11, 5);
    let ty = 9;
    const lines = ((eggFlavor(mon.eggSteps || 0) || "") + "<NEXT>").split("<NEXT>");
    lines.pop();
    for (const line of lines) {
      if (line !== "") put(out, line, 1, ty);
      ty = ty + 2;
    }
    return out;
  }

  /** Lua: SummaryMenu.lua:705 */
  placements(): Placement[] {
    if (isEggMon(this.mon)) return this.eggPlacements();
    if (this.moveDetail) return this.moveDetailPlacements();
    const out = this.upperPlacements();
    let page: Placement[];
    if (this.page === GREEN_PAGE) page = this.greenPlacements();
    else if (this.page === BLUE_PAGE) page = this.bluePlacements();
    else page = this.pinkPlacements();
    for (const entry of page) out.push(entry);
    return out;
  }

  // ------------------------------------------------------------------- input

  /** Lua: SummaryMenu.lua:723 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: SummaryMenu.lua:729 -- .d_right / .d_left, wrapping. */
  turnPage(delta: number): void {
    let page = this.page + delta;
    if (page > BLUE_PAGE) page = PINK_PAGE;
    if (page < PINK_PAGE) page = BLUE_PAGE;
    this.page = page;
  }

  /** Lua: SummaryMenu.lua:740 -- `down` / `.d_up`: no wrap, the page survives. */
  switchMon(delta: number): boolean {
    const next = this.index + delta;
    if (next < 1 || next > this.party.length) return false;
    this.index = next;
    this.mon = this.party[next - 1];
    // engine/pokemon/move_mon.asm:1402
    Mon.refreshStats(this.mon, this.game && this.game.data);
    this.moveIndex = 1;
    this.playCry();
    return true;
  }

  /** Lua: SummaryMenu.lua:755 -- MoveScreenLoop's cycle loops step over EGGs. */
  switchMonPastEggs(delta: number): boolean {
    let next = this.index + delta;
    while (this.party[next - 1] && isEggMon(this.party[next - 1])) next = next + delta;
    if (next < 1 || next > this.party.length) return false;
    this.index = next;
    this.mon = this.party[next - 1];
    // engine/pokemon/move_mon.asm:1402
    Mon.refreshStats(this.mon, this.game && this.game.data);
    this.moveIndex = 1;
    this.playCry();
    return true;
  }

  /** Lua: SummaryMenu.lua:772 -- .place_move's `.copy_move` pair: a slot travels whole. */
  swapMoves(from: number | null, to: number | null): boolean {
    const moves = this.mon && this.mon.moves;
    if (!(moves && from && to) || from === to) return false;
    if (!(moves[from - 1] && moves[to - 1])) return false;
    const a = moves[from - 1];
    moves[from - 1] = moves[to - 1];
    moves[to - 1] = a;
    return true;
  }

  /** Lua: SummaryMenu.lua:782 -- .swap_moves' SFX_SWITCH_POKEMON (mon_menu.asm:1036-1041). */
  playSwapSfx(): void {
    const data = this.game && this.game.data;
    if (!(data && Sound && Sound.play)) return;
    const sfx = data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, "Sfx_SwitchPokemon")]) {
      try {
        Sound.play(data, "Sfx_SwitchPokemon");
      } catch {
        // pcall(Sound.play, ...)
      }
    }
  }

  /** Lua: SummaryMenu.lua:798 -- mon_menu.asm:1040 */
  playSwapSfxTwice(): void {
    this.playSwapSfx();
    this.repeatSfx = WaitPlaySFX.arm("Sfx_SwitchPokemon");
  }

  /** Lua: SummaryMenu.lua:806 */
  tickRepeatSfx(): boolean {
    const pending = this.repeatSfx;
    if (!pending) return false;
    if (WaitPlaySFX.waiting(pending)) return true;
    this.repeatSfx = null;
    this.playSwapSfx();
    return false;
  }

  /**
   * Lua: SummaryMenu.lua:819 -- MoveScreenLoop's .joy_loop: A picks a move up
   * and puts it down; B drops it back and only then exits.
   */
  updateMoveDetail(input: any): void {
    const moves = this.moveList();
    const count = Math.max(1, moves.length);
    if (input.wasPressed("up")) {
      this.moveIndex = this.moveIndex > 1 ? this.moveIndex - 1 : count;
    } else if (input.wasPressed("down")) {
      this.moveIndex = this.moveIndex < count ? this.moveIndex + 1 : 1;
    } else if (input.wasPressed("a")) {
      if (this.swapFrom) {
        if (this.swapMoves(this.swapFrom, this.moveIndex)) this.playSwapSfxTwice();
        this.swapFrom = null;
      } else if (moves[this.moveIndex - 1]) {
        this.swapFrom = this.moveIndex;
      }
    } else if (input.wasPressed("right")) {
      // .d_right / .d_left walk the party, not while a move is held.
      if (!this.swapFrom) this.switchMonPastEggs(1);
    } else if (input.wasPressed("left")) {
      if (!this.swapFrom) this.switchMonPastEggs(-1);
    } else if (input.wasPressed("b") || input.wasPressed("select")) {
      if (this.swapFrom) {
        this.moveIndex = this.swapFrom;
        this.swapFrom = null;
      } else if (this.moveScreen) {
        // .exit: back to the party list.
        this.close();
      } else {
        this.moveDetail = false;
      }
    }
  }

  /** Lua: SummaryMenu.lua:854 */
  update(_dt?: number): void {
    this.stepPicAnim();
    const input = this.game && this.game.input;
    if (!input) return;
    // mon_menu.asm:1040
    if (this.tickRepeatSfx()) return;
    if (this.moveDetail) {
      this.updateMoveDetail(input);
      return;
    }

    // EggStats_JoypadLoop: A and B exit, up and down walk the party.
    if (isEggMon(this.mon)) {
      if (input.wasPressed("a") || input.wasPressed("b")) this.close();
      else if (input.wasPressed("up")) this.switchMon(-1);
      else if (input.wasPressed("down")) this.switchMon(1);
      return;
    }

    // .joypad_action tests B first.
    if (input.wasPressed("b")) {
      this.close();
      return;
    }
    if (input.wasPressed("left")) {
      this.turnPage(-1);
      return;
    }
    if (input.wasPressed("right")) {
      this.turnPage(1);
      return;
    }
    if (input.wasPressed("a")) {
      // .a_button quits on the last page and otherwise falls into .d_right.
      if (this.page === BLUE_PAGE) this.close();
      else this.turnPage(1);
      return;
    }
    if (input.wasPressed("up")) {
      this.switchMon(-1);
      return;
    }
    if (input.wasPressed("down")) {
      this.switchMon(1);
      return;
    }
    // The port's own hook onto MoveScreenLoop; see the header.
    if (input.wasPressed("select") && this.page === GREEN_PAGE) {
      this.moveDetail = true;
      this.moveIndex = 1;
    }
  }

  // ----------------------------------------------------------------- drawing

  /** Lua: SummaryMenu.lua:921 -- menu_gfx.stats at $31 (load_font.asm:90-95). */
  statsTiles(): StatsSheet | undefined {
    if (this.statsSheet !== undefined) return this.statsSheet || undefined;
    const gfx = (this.menuGfx || {}).stats;
    const image = gfx && this.picImage(gfx.sheet);
    if (!image) {
      this.statsSheet = false;
      return undefined;
    }
    const [w, h] = image.getDimensions();
    const quads: Record<number, Quad> = {};
    for (let index = 0; index < (gfx.tiles || 17); index++) {
      quads[(gfx.firstTile || 0x31) + index] = G.newQuad(index * 8, 0, 8, 8, w, h);
    }
    this.statsSheet = { image, quads };
    return this.statsSheet;
  }

  /** Lua: SummaryMenu.lua:941 -- a tile out of StatsScreenPageTilesGFX. */
  pageTile(id: number, tx: number, ty: number, colors?: Colors | null): void {
    const px = tx * 8;
    const py = ty * 8;
    const sheet = this.statsTiles();
    if (sheet && sheet.quads[id]) {
      G.setColor(1, 1, 1, 1);
      const body = (): void => G.draw(sheet.image, sheet.quads[id]!, px, py);
      if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
      else body();
      return;
    }
    G.setColor(0, 0, 0, 1);
    if (id === TILE_VERTICAL_DIVIDER) {
      G.rectangle("fill", px + 3, py, 2, 8);
    } else if (id === TILE_BAR_CAP_LEFT) {
      G.rectangle("fill", px + 6, py + 1, 2, 6);
    } else if (id === TILE_BAR_CAP_RIGHT) {
      G.rectangle("fill", px, py + 1, 2, 6);
    } else if (id === TILE_SHINY) {
      G.rectangle("fill", px + 2, py + 1, 2, 2);
      G.rectangle("fill", px, py + 4, 2, 2);
      G.rectangle("fill", px + 4, py + 4, 2, 2);
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: SummaryMenu.lua:977 -- StatsScreen_LoadPageIndicators' 2x2 squares. */
  drawPageSquare(tx: number, ty: number, large: boolean, colors?: Colors | null): void {
    const px = tx * 8;
    const py = ty * 8;
    const first = large ? TILE_SQUARE_LARGE : TILE_SQUARE_SMALL;
    const sheet = this.statsTiles();
    if (sheet && sheet.quads[first]) {
      // [hli] / [hld], a row down, [hli] / [hl] (stats_screen.asm:841-853).
      const body = (): void => {
        G.setColor(1, 1, 1, 1);
        G.draw(sheet.image, sheet.quads[first]!, px, py);
        G.draw(sheet.image, sheet.quads[first + 1]!, px + 8, py);
        G.draw(sheet.image, sheet.quads[first + 2]!, px, py + 8);
        G.draw(sheet.image, sheet.quads[first + 3]!, px + 8, py + 8);
      };
      if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
      else body();
      G.setColor(1, 1, 1, 1);
      return;
    }
    const inset = first === TILE_SQUARE_LARGE ? 2 : 5;
    const size = 16 - inset * 2;
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", px + inset, py + inset, size, size);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: SummaryMenu.lua:1008 */
  drawPageIndicators(): void {
    [13, 15, 17].forEach((tx, i) => {
      this.drawPageSquare(tx, 5, i + 1 === this.page, PAGE_PALETTES[i]);
    });
  }

  /** Lua: SummaryMenu.lua:1015 */
  picImage(path: string | null | undefined): LcdImage | undefined {
    if (!path) return undefined;
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return cached || undefined;
  }

  /** Lua: SummaryMenu.lua:1027 */
  picCtx(mon: any, kind: string): any {
    return {
      species: mon && mon.species,
      side: "front",
      kind,
      mon,
      data: this.game && this.game.data,
      letter: Unown.monLetter(mon),
      shiny: !!(mon && mon.shiny),
    };
  }

  /**
   * Lua: SummaryMenu.lua:1039 -- StatsScreen_PlaceFrontpic
   * (stats_screen.asm:722): a party Unown shows its own form.
   */
  picPath(mon: any): [string | undefined, boolean, string | undefined] {
    const def = mon && this.pokemon && this.pokemon[mon.species];
    let vanilla: string | undefined = def && def.spriteFront;
    if (mon && mon.species === Unown.SPECIES) {
      vanilla = Unown.formSprite(this.pokemon, Unown.monLetter(mon)) || vanilla;
    }
    const [path, trueColor] = Sprites.pic(vanilla, this.picCtx(mon, "summary"));
    return [path, trueColor, vanilla];
  }

  /** Lua: SummaryMenu.lua:1053 */
  picFor(mon: any): [LcdImage | undefined, boolean] {
    const [path, trueColor] = this.picPath(mon);
    return [this.picImage(path), trueColor];
  }

  /** Lua: SummaryMenu.lua:1060 -- PrepMonFrontpic at hlcoord 0, 0. */
  drawPicBlock(image: LcdImage | undefined, colors?: Colors | null, quad?: Quad | null, size?: number | null, trueColor?: boolean): void {
    if (!image) return;
    const paletted = colors && !(trueColor && GbcPalette.mode === "gbc");
    const blank = colors ? GbcPalette.color(colors, 1) : [255, 255, 255];
    G.setColor(blank[0]! / 255, blank[1]! / 255, blank[2]! / 255, 1);
    G.rectangle("fill", 0, 0, 7 * 8, 7 * 8);

    const wide = Math.floor((size || image.getWidth()) / 8);
    const pad = PIC_PAD[wide] || PIC_PAD[7]!;
    G.setColor(1, 1, 1, 1);
    const body = (): void => {
      if (quad) G.draw(image, quad, pad[0] * 8, pad[1] * 8);
      else G.draw(image, pad[0] * 8, pad[1] * 8);
    };
    if (paletted && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: SummaryMenu.lua:1088 */
  drawPic(): void {
    const mon = this.mon;
    if (!mon) return;
    const [image, trueColor] = this.picFor(mon);
    if (!image) return;
    const colors = (this.palettes && mon.species && Palettes.monColors(this.palettes, mon.species, mon.shiny)) || undefined;
    const frame = this.picAnimFrame();
    if (frame) {
      const [sheet, quad, size] = frame;
      return this.drawPicBlock(sheet, colors, quad, size, this.picAnim!.trueColor);
    }
    this.drawPicBlock(image, colors, null, null, trueColor);
  }

  /**
   * Lua: SummaryMenu.lua:1120 -- EggStatsScreen's PrepMonFrontpic over EggPic
   * (stats_screen.asm:786), coloured off the EGG palette row.
   */
  drawEggPic(): void {
    const gfx = (this.menuGfx || {}).eggHatch;
    const colors = Palettes.monColors(this.palettes, "EGG", this.mon && this.mon.shiny);
    const image = this.picImage(gfx && gfx.egg);
    if (image) return this.drawPicBlock(image, colors);
    this.drawEggIconFallback(colors);
  }

  /** Lua: SummaryMenu.lua:1132 -- ICON_EGG at 2x for a cache without EggPic. */
  drawEggIconFallback(colors?: Colors | null): void {
    const icons = this.icons || {};
    const entry = icons.icons && icons.icons.ICON_EGG;
    const image = this.picImage(entry && entry.image);
    if (!image) return;
    const blank = colors ? GbcPalette.color(colors, 1) : [255, 255, 255];
    G.setColor(blank[0]! / 255, blank[1]! / 255, blank[2]! / 255, 1);
    G.rectangle("fill", 0, 0, 7 * 8, 7 * 8);
    const w = entry.width || 16;
    let h = Math.min(entry.height || 16, image.getHeight());
    if ((entry.frames || 1) > 1) h = Math.floor(h / entry.frames);
    let quad: Quad;
    try {
      quad = G.newQuad(0, 0, w, h, image.getWidth(), image.getHeight());
    } catch {
      return;
    }
    const x = Math.floor((7 * 8 - w * 2) / 2);
    const y = Math.floor((7 * 8 - h * 2) / 2);
    G.setColor(1, 1, 1, 1);
    // NOT FAITHFUL: G.draw ignores scales other than +-1, so the 2x egg icon
    // draws at 1x (offset as the Lua's 2x centring puts it). Only reached on a
    // cook without menu_gfx.eggHatch.egg, which ours always has.
    const body = (): void => G.draw(image, quad, x, y, 0, 2, 2);
    if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: SummaryMenu.lua:1161 -- engine/gfx/color.asm:342-359 */
  drawPlacements(list: Placement[], palette?: Colors | null): void {
    for (const entry of list) {
      if (palette) Chrome.printThrough(entry.text, entry.x, entry.y, palette);
      else Chrome.print(entry.text, entry.x, entry.y);
    }
  }

  /** Lua: SummaryMenu.lua:1174 -- twenty $62 cells across row 7. */
  drawHorizontalDivider(): void {
    G.setColor(0, 0, 0, 1);
    for (let x = 0; x < Chrome.SCREEN_W; x++) Font.drawCode(TILE_HORIZONTAL_DIVIDER, x * 8, 7 * 8);
  }

  /** Lua: SummaryMenu.lua:1183 -- BG palette 0 as the stats screen leaves it. */
  lowerColors(): Colors {
    const tint = PAGE_TINTS[this.page - 1] || PAGE_TINTS[PINK_PAGE - 1]!;
    return [tint, tint, tint, [0, 0, 0]];
  }

  /** Lua: SummaryMenu.lua:1190 -- StatsScreen_LoadGFX's .ClearBox (stats_screen.asm:549-557). */
  drawPageBackground(): void {
    const tint = GbcPalette.color(this.lowerColors(), 1) || [255, 255, 255];
    G.setColor(tint[0]! / 255, tint[1]! / 255, tint[2]! / 255, 1);
    G.rectangle("fill", 0, 8 * 8, Chrome.SCREEN_W * 8, 10 * 8);
    G.setColor(0, 0, 0, 1);
  }

  /** Lua: SummaryMenu.lua:1198 */
  drawVerticalDivider(tx: number): void {
    const colors = this.lowerColors();
    for (let y = 8; y <= 17; y++) this.pageTile(TILE_VERTICAL_DIVIDER, tx, y, colors);
  }

  /** Lua: SummaryMenu.lua:1203 */
  drawUpperHalf(): void {
    const mon = this.mon || {};
    this.drawPic();
    this.drawPlacements(this.upperPlacements());
    this.drawHorizontalDivider();
    // StatsScreen_PlacePageSwitchArrows, then StatsScreen_PlaceShinyIcon.
    Chrome.print("◀", 12, 6);
    Chrome.print("▶", 19, 6);
    if (mon.shiny) this.pageTile(TILE_SHINY, 19, 0);
    this.drawPageIndicators();
  }

  /** Lua: SummaryMenu.lua:1215 */
  drawPinkPage(): void {
    const mon = this.mon || {};
    const maxHp = mon.maxHp || (mon.stats && mon.stats.hp) || 0;
    const tint = PAGE_TINTS[this.page - 1] || PAGE_TINTS[PINK_PAGE - 1]!;
    // DrawPlayerHP: "HP:" at (0,9), six cells, the cap at (8,9).
    if (this.hud && this.hud.available()) {
      this.hud.drawHpBar(mon.hp, maxHp, 0, 9, tint as any);
    } else {
      HpBar.drawWithLabel(gPainter, this.palettes, mon.hp, maxHp, 0, 9, Font);
    }
    this.drawVerticalDivider(9);
    this.drawPlacements(this.pinkPlacements(), this.lowerColors());

    // FillInExpBar at (11,16), caps at (10,16) and (19,16).
    const fraction = HpBar.expFraction(mon, this.growth(), Mon.experienceForLevel);
    if (this.hud && this.hud.available()) {
      this.hud.drawExpBar(fraction, 11, 16, tint as any);
    } else {
      HpBar.drawExp(gPainter, this.palettes, fraction, 11 * 8, 16 * 8 + 3);
    }
    const colors = this.lowerColors();
    this.pageTile(TILE_BAR_CAP_LEFT, 10, 16, colors);
    this.pageTile(TILE_BAR_CAP_RIGHT, 19, 16, colors);
  }

  /** Lua: SummaryMenu.lua:1247 */
  drawGreenPage(): void {
    this.drawPlacements(this.greenPlacements(), this.lowerColors());
  }

  /** Lua: SummaryMenu.lua:1251 */
  drawBluePage(): void {
    this.drawVerticalDivider(10);
    this.drawPlacements(this.bluePlacements(), this.lowerColors());
  }

  /** Lua: SummaryMenu.lua:1256 */
  drawMoveDetail(): void {
    const mon = this.mon || {};
    Chrome.clear();
    // Textbox (0,1) 9x18 interior and Textbox (0,11) 5x18.
    Chrome.textbox(0, 1, 18, 9);
    Chrome.textbox(0, 11, 18, 5);
    // The nickname and the TYPE plaque own their border-row cells.
    clearCells(5, 1, tiles(monName(mon)) + tiles(levelText(mon.level)), 1);
    clearCells(0, 10, 7, 2);
    // PlaceMoveScreenLeftArrow / RightArrow on row 0.
    if (this.index > 1) Chrome.print("◀", 16, 0);
    if (this.index < this.party.length) Chrome.print("▶", 18, 0);
    this.drawPlacements(this.moveDetailPlacements());
    // MoveScreen2DMenuData: cursor column 1, first row 3, two rows per step.
    const moves = this.moveList();
    if (moves.length > 0) {
      // .a_button's PlaceHollowCursor on the held row.
      if (this.swapFrom) Chrome.cursor(1, 3 + (Math.min(this.swapFrom, moves.length) - 1) * 2, true);
      Chrome.cursor(1, 3 + (Math.min(this.moveIndex, moves.length) - 1) * 2);
    }
  }

  /** Lua: SummaryMenu.lua:1288 -- EggStatsScreen's draw. */
  drawEggPage(): void {
    Chrome.clear();
    this.drawEggPic();
    this.drawHorizontalDivider();
    this.drawPlacements(this.eggPlacements());
  }

  /** Lua: SummaryMenu.lua:1295 -- StatsScreen_LoadFont is _LoadFontsBattleExtra. */
  drawPanel(): void {
    const wasBattle = Font.useBattleExtra(true);
    if (isEggMon(this.mon)) {
      this.drawEggPage();
    } else if (this.moveDetail) {
      this.drawMoveDetail();
    } else {
      Chrome.clear();
      this.drawPageBackground();
      this.drawUpperHalf();
      if (this.page === GREEN_PAGE) this.drawGreenPage();
      else if (this.page === BLUE_PAGE) this.drawBluePage();
      else this.drawPinkPage();
    }
    Font.useBattleExtra(wasBattle);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: SummaryMenu.lua:1320 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: SummaryMenu.lua:1324 */
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

export default SummaryMenu;
