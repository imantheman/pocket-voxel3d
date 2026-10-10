// pocket-voxel's bottom screen for the gen3 (FireRed/LeafGreen) port (GPLv3 +
// additional terms; see LICENSE.md). Not a port: the game had one screen.
//
// The 3DS's lower screen as a companion in the game's own look -- the Red
// and Blue builds have the Kanto Gear there, Gold its white panel; this is
// FireRed's and LeafGreen's, made of the ROM's own art at 1:1 (the cache's
// party menu, bag, Town Map and trainer card pictures, the game's font and
// window frames, the mon and item icons):
//
//   y   0..15   the header: where you are (the map's Town Map name, as the
//               map's name popup gives it) and the play time
//   y  16..199  the page, the game's own 240x160 screen centred at (40, 28)
//               and carried out to the page's edges:
//                 POKéMON  the party as the party menu lays it out: icons,
//                          names, levels or status, HP bars and held items
//                          (in a battle the HP is the battle's, live, and the
//                          mons in battle are the highlighted slots)
//                 BAG      a pocket as the bag shows it, the item touched
//                          described below; touch the bag or the arrows for
//                          another pocket, the list's arrows to scroll
//                 TOWN MAP the region you are in, your head where you are
//                 <name>   the trainer card's front: money, POKéDEX, time,
//                          badges (the START menu's label for it is the
//                          player's name, and so is this tab's)
//   y 200..239  the tabs, in the window frame the options chose
//
// Controls: touch a tab (a tap fires as the finger lifts, on the tab it went
// down on), or press Y for the next tab. Y is the one button the game leaves
// free: L and R belong to FRLG (the help system, L=A, page turns in the bag,
// the POKéDEX, the PC and lists), X is START, SELECT the registered item.
// It only shows: nothing here presses a button for the game or changes it.
//
// Cost: the screen is drawn into a 320x240 canvas (512x256 RGBA8, VRAM) and
// the host lays that canvas on the bottom screen each frame as one quad
// (gen3/g3_render.c g3_bottom_draw). Only what changed is drawn again, in
// its own box under a scissor: the header when the place or the time does,
// the tabs when the tab does, the page when what it shows does (looked at
// every CHECK_EVERY shown frames, by a signature of it) -- on the POKéMON
// page a slot at a time (one slot looked at a frame), its plate alone unless
// its icon or ball changed, and on the TOWN MAP the head's old and new
// squares when only the head moved. A still screen costs a look a frame.
// The art comes from the chrome modules the game itself uses (PartyChrome,
// BagChrome, Gpu, the font, the frames), so it is the same textures the
// game's screens load, not copies, and what a page alone keeps up is given
// back when it is not needed: the textures of the BAG's, the Town Map's and
// the card's pictures as soon as the page is drawn, the party menu's panel
// and plates when the POKéMON page closes; the bag's and the Town Map's
// images themselves when their pages close (releaseArt).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { RegionMapExtract as RegionExtract } from "../../../import/gen3/region_map_extract.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { G } from "../platform/graphics.ts";
import { Canvas, newImageData, type Image, type Quad } from "../platform/image.ts";
import { ipairs, len, seq } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Runtime } from "../core/runtime.ts";
import { Battle } from "../core/battle.ts";
import { Pokemon } from "../core/pokemon.ts";
import { SummaryData } from "../core/summary_data.ts";
import { RomText } from "../core/rom_text.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag } from "../core/bag.ts";
import { Dataset } from "../core/dataset.ts";
import { CachePaths } from "../core/cache_paths.ts";
import { Strings } from "../shared/core/Strings.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { PartyChrome } from "./party_chrome.ts";
import { PartyMenu } from "./party_menu.ts";
import { BagChrome } from "./bag_chrome.ts";
import { TrainerCard } from "./trainer_card.ts";
import { Gpu } from "./region_map_gpu.ts";
import { Position } from "./region_map_position.ts";

// ------------------------------------------------------------ layout

const SW = 320, SH = 240;
const HEAD_H = 16;
const PAGE_Y = HEAD_H, PAGE_H = 184;
const TAB_Y = PAGE_Y + PAGE_H;
/** Where a page's 240x160 GBA screen sits. */
const OX = 40, OY = PAGE_Y + 12;
/** Shown frames between looks for a change (~8 a second at 60 fps). */
const CHECK_EVERY = 8;

type TabId = "party" | "bag" | "map" | "card";
const TAB_IDS: TabId[] = ["party", "bag", "map", "card"];
/** The tabs' width (four across the screen). */
const TAB_W = SW / TAB_IDS.length;

// The bag's description bar (items/bag/bg.rgba rows 112..159): the header's
// and the tab bar's colours.
const BAR = [0 / 255, 123 / 255, 197 / 255];
const BAR_DARK = [0 / 255, 82 / 255, 115 / 255];

// A selected tab's ground: the selected party slot's warm orange.
const SELECT_ORANGE = [1, 213 / 255, 156 / 255];

// The party menu's panel (pokemon/party/bg.rgba): its stripes, two rows.
const PARTY_STRIPE_A = [74 / 255, 173 / 255, 165 / 255];
const PARTY_STRIPE_B = [58 / 255, 140 / 255, 140 / 255];

// The tabs' item icons (items/bag/icons/<id>.rgba): POKé BALL, POTION, TOWN MAP.
const ICON_BALL = 4, ICON_POTION = 13, ICON_TOWN_MAP = 361;

// ------------------------------------------------------------ host

/** The 3DS host's natives (g3_shim.c); none on the desktop. */
function nat(): { g3Bottom?(id: number): void; g3BottomKeys?(): number; g3ListsRun?(): number } {
  return (globalThis as { voxel?: object }).voxel ?? {};
}

/** The page's text colours (built on first use: FrlgFont is in the import cycle). */
let colors: { white: Colors; dark: Colors; blue: Colors } | undefined;
function C(): { white: Colors; dark: Colors; blue: Colors } {
  return (colors ??= {
    // the bag's white on blue (src/bag.c:13)
    white: { fg: FrlgFont.STDPAL[1], shadow: FrlgFont.STDPAL[2], bg: FrlgFont.STDPAL[0] },
    dark: FrlgFont.COLOR.NORMAL!,
    blue: FrlgFont.COLOR.BLUE!,
  });
}

/**
 * A filled box in colour `c` (alpha `a`): a white pixel's quad stretched over
 * it, not G.rectangle's flat triangles -- on the console those drawn into
 * this canvas while the game was at its title and intro never showed (the
 * same box as a textured quad does), so every box here is a quad.
 */
let white: Image | undefined;
function rect(c: number[], x: number, y: number, w: number, h: number, a = 1): void {
  if (!white) {
    const d = newImageData(1, 1);
    d.setPixel(0, 0, 1, 1, 1, 1);
    white = G.newImage(d);
  }
  G.setColor(c[0]!, c[1]!, c[2]!, a);
  G.draw(white, x, y, 0, w, h);
  G.setColor(1, 1, 1, 1);
}

// ------------------------------------------------------------ art

/** The cache's root (data/generated/gba). */
function root(): string {
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

/** A raw RGBA8 picture of the cache, w x h, or null. */
function rgbaImage(rel: string, w: number, h: number): Image | null {
  let raw: string | undefined;
  try {
    raw = Dataset.cache().read(root() + "/" + rel) as string | undefined;
  } catch {
    raw = undefined;
  }
  if (!raw || raw.length < w * h * 4) return null;
  const img = G.newImage(newImageData(w, h, "rgba8", raw));
  img.setFilter("nearest", "nearest");
  return img;
}

/** One way of carrying a picture out along an axis: the source line `at`
 *  (or `period` lines from it) repeated over `add` more destination pixels. */
interface Stretch { at: number; add: number; period?: number }
/** A piece of an axis: source start and length, destination start, repeats. */
type Piece = [number, number, number, number];

function pieces(size: number, st: Stretch[]): Piece[] {
  const out: Piece[] = [];
  let src = 0, dst = 0;
  for (const s of st) {
    if (s.at > src) { out.push([src, s.at - src, dst, 1]); dst += s.at - src; src = s.at; }
    const p = s.period ?? 1;
    if (p === 1) out.push([s.at, 1, dst, -s.add]); // one line, scaled over add
    else out.push([s.at, p, dst, s.add / p]);
    dst += s.add;
  }
  if (size > src) out.push([src, size - src, dst, 1]);
  return out;
}

/**
 * `img` (w x h) drawn at (x, y), carried out by the stretches -- each a line
 * (or a band of `period` lines, for striped art) of the picture repeated --
 * so a GBA screen fills a bigger box with nothing scaled but runs of
 * identical pixels: pixel-exact. The draws (quad, place, scale, size) are
 * worked out once per picture and layout (`plan`, the caller's name for the
 * layout) and kept; with `clip` (canvas pixels) only those reaching into it.
 */
type Draw = [Quad, number, number, number, number, number, number];
const plans = new WeakMap<Image, Map<string, Draw[]>>();
function drawStretched(img: Image, plan: string, x: number, y: number, sx: Stretch[], sy: Stretch[], clip?: number[] | null): void {
  let byImg = plans.get(img);
  if (!byImg) { byImg = new Map(); plans.set(img, byImg); }
  let draws = byImg.get(plan);
  if (!draws) {
    draws = [];
    for (const [ys, yl, yd, yr] of pieces(img.h, sy)) {
      for (const [xs, xl, xd, xr] of pieces(img.w, sx)) {
        const q = G.newQuad(xs, ys, xl, yl, img.w, img.h);
        const xn = xr < 0 ? 1 : xr, yn = yr < 0 ? 1 : yr;
        const kx = xr < 0 ? -xr : 1, ky = yr < 0 ? -yr : 1;
        for (let j = 0; j < yn; j++) {
          for (let i = 0; i < xn; i++) draws.push([q, x + xd + i * xl, y + yd + j * yl, kx, ky, xl * kx, yl * ky]);
        }
      }
    }
    byImg.set(plan, draws);
  }
  G.setColor(1, 1, 1, 1);
  for (let k = 0; k < draws.length; k++) {
    const d = draws[k]!;
    if (clip && (d[1] >= clip[2]! || d[1] + d[5] <= clip[0]! || d[2] >= clip[3]! || d[2] + d[6] <= clip[1]!)) continue;
    G.draw(img, d[0], d[1], d[2], 0, d[3], d[4]);
  }
}

/** A quad of `img`, made once. */
const quadMemo = new Map<string, Quad>();
function quadOf(img: Image, x: number, y: number, w: number, h: number): Quad {
  const k = `${img.w}x${img.h}:${x},${y},${w},${h}`;
  let q = quadMemo.get(k);
  if (!q) { q = G.newQuad(x, y, w, h, img.w, img.h); quadMemo.set(k, q); }
  return q;
}

// ------------------------------------------------------------ game state

function session(): any {
  try { return Runtime.getSession(); } catch { return undefined; }
}

function mapDef(mapId: string): any {
  const game = Runtime._game;
  const maps = game && game.data && game.data.maps;
  return maps ? maps[mapId] : undefined;
}

function isFemale(s: any): boolean {
  return !!s && (s.gender === 1 || s.gender === "female" || s.gender === "F" || s.playerGender === 1);
}

/** The Town Map's name for map `mapId` (its section's, as region_map.lua mapName). */
// Lua: region_map.lua:373 (mapName)
function sectionName(mapId: string): string {
  const def = mapDef(mapId);
  const mapsec = def ? def.regionMapSectionId : undefined;
  if (mapsec == null) return "";
  RegionExtract.ensureGenerated();
  const info = MapSectionsExtract.SECTIONS[mapsec];
  const name = info ? RegionExtract.SECTION_NAMES[info.id] : undefined;
  return name == null ? "" : Strings(name);
}

/** The party, and for a battle the battle's live view of the mons in it. */
interface PartyView { mons: any[]; active: boolean[] }
function partyView(s: any): PartyView {
  const out: PartyView = { mons: [], active: [] };
  let party: any = s && s.party;
  let st: any;
  try { st = Battle.isActive() ? Battle.getState() : undefined; } catch { st = undefined; }
  if (st && st.playerParty && len(st.playerParty) > 0) party = st.playerParty;
  if (!party) return out;
  for (let i = 1; i <= 6; i++) {
    const m = party[i];
    if (!m) break;
    out.mons.push(m);
    out.active.push(false);
  }
  if (st) {
    // the battlers on the player's side (1 and 3), whose mon is the battle's copy
    const battlers: any[] = [st.player];
    if (st.double && st.battlers) battlers.push(st.battlers[3]);
    for (const b of battlers) {
      if (!b || b.zeroed || !b.mon) continue;
      const i = (tonumber(b.partyIndex) ?? 1) - 1;
      if (i < 0 || i >= out.mons.length) continue;
      const live = Object.create(out.mons[i]);
      live.hp = b.mon.hp;
      live.maxHp = b.mon.maxHp ?? out.mons[i].maxHp;
      live.status = truthy(b.status) ? b.status : b.mon.status;
      live.level = b.mon.level ?? out.mons[i].level;
      out.mons[i] = live;
      out.active[i] = true;
    }
  }
  return out;
}

/** What a slot's plate shows (its words, HP bar, status and held item), and
 *  what its sprites outside the plate show (the icon and the ball). */
function plateKey(m: any): string {
  return `${m.nickname ?? ""}:${m.level}:${m.hp}/${m.maxHp}:${SummaryData.statusAilment(m)}:${m.item ?? m.heldItem ?? 0}:${m.gender ?? ""}`;
}
function spriteKey(m: any, active: boolean): string {
  return `${m.species}:${m.isEgg ? 1 : 0}:${m.personality ?? ""}:${active ? 1 : 0}`;
}

// ------------------------------------------------------------ the companion

/** [x0, y0, x1, y1]: a box, in the party page's GBA-screen pixels or the canvas's. */
type Box = [number, number, number, number];
const hit = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

class Bottom {
  tab: TabId = "party";
  private canvas: Canvas | null = null;
  /** What each part of the screen was last drawn from ("" draws it again). */
  private headSig = "";
  private tabSig = "";
  private pageSig = "";
  /** Everything drawn again at the next look (a new or remade canvas). */
  private full = true;
  private wait = 0;
  /** Shown frames since the game was last under way (frame1). */
  private inGameFrames = 0;
  /** The frame a new canvas is drawn whole again (frame1). */
  private settleAt = -1;
  /** The host's lists drawn when this frame began (g3ListsRun), and when a
   *  paint last went into a list (-1: none since the last check); paints
   *  found lost (frame1). */
  private listsRun = 0;
  private paintedAt = -1;
  lost = 0;
  private dead = false;
  private named = 0;
  /** The finger: where it went down (null while up). */
  private down: [number, number] | null = null;
  /** The bag page: the pocket shown (BAG_POCKET_ORDER index), its scroll, the row touched. */
  bagPocket = 1;
  bagScroll = 0;
  bagRow = 1;
  /** The location name, worked out again only when the map changes. */
  private locMap = "";
  private locName = "";
  /** The Town Map's player cell, by map and cell. */
  private cellKey = "";
  private cell: [number, number, number] = [0, 0, 0];
  /** The POKéMON page as drawn: each slot's plate and sprite keys. */
  private plateKeys: string[] = [];
  private spriteKeys: string[] = [];
  /** The TOWN MAP page as drawn: its region, the head's cell, the name. */
  private mapDrawn: [number, number, number, string] | null = null;
  /** The trainer card's data (TrainerCard.cardData counts the POKéDEX: gathered
   *  again only when the map, a battle or the name change, and when the tab
   *  opens; the money and the time are read fresh each look). */
  private cardKey = "";
  private cardC: any = null;
  private ticks = 0;
  /** The trainer card's pictures (this page's alone: let go when it closes). */
  private card: { key: string; img: Image | null; badges: Image | null; pic: Image | null; star: Image | null } | null = null;
  /** Counted for the perf line: pages (or parts of them) drawn. */
  redraws = 0;

  /** Once a game tick, before the game's update: the touch (main.ts). */
  input(buttons: number): void {
    if (this.dead) return;
    const touching = (buttons & 0x100) !== 0;
    if (touching) {
      if (!this.down) this.down = [((buttons >>> 9) & 0xff) * 2, ((buttons >>> 17) & 0x7f) * 2];
      return;
    }
    const at = this.down;
    this.down = null;
    if (at) this.tap(at[0], at[1]);
  }

  /** A tap (the finger lifted) that went down at (x, y). */
  private tap(x: number, y: number): void {
    if (y >= TAB_Y) {
      const t = TAB_IDS[Math.min(TAB_IDS.length - 1, Math.floor(x / TAB_W))]!;
      this.setTab(t);
      return;
    }
    if (this.tab === "bag") this.bagTap(x - OX, y - OY);
  }

  /** The page's canvas (0 before the first frame): tools/gen3/bottom_preview.ts reads it. */
  canvasId(): number {
    return this.canvas ? this.canvas.id : 0;
  }

  setTab(t: TabId): void {
    if (t === this.tab) return;
    releaseArt(this.tab, true);
    this.tab = t;
    if (t !== "card") this.card = null; // its pictures go with it
    this.cardC = null;
    console.log(`[pv] g3 bottom: ${t}`);
    this.pageSig = "";
    this.tabSig = "";
    this.wait = CHECK_EVERY;
  }

  /** The bag page's touches, in its GBA screen's pixels: the arrows either
   *  side of the bag turn the pocket that way, the bag itself to the next
   *  (round to the first); the list's arrows scroll it; a row is described. */
  private bagTap(x: number, y: number): void {
    const pockets = len(ItemsData.BAG_POCKET_ORDER);
    const total = len(this.bagRows()) + 1; // the rows and CANCEL
    if (y >= 0 && y < 112 && x < 88) {
      const p = this.bagPocket;
      if (x < 20) this.bagPocket = Math.max(1, p - 1);
      else if (x >= 68) this.bagPocket = Math.min(pockets, p + 1);
      else this.bagPocket = p % pockets + 1;
      if (this.bagPocket === p) return;
      this.bagScroll = 0;
      this.bagRow = 1;
    } else if (x >= 88 && y >= 0 && y < 112) {
      const shown = Math.min(BAG_ROWS, total);
      if (y < 8 && this.bagScroll > 0) this.bagScroll--;
      else if (y >= 104 && this.bagScroll + shown < total) this.bagScroll++;
      else {
        const i = this.bagScroll + Math.floor((y - 8) / 16) + 1;
        if (i < 1 || i > total || i === this.bagRow) return;
        this.bagRow = i;
      }
    } else return;
    this.pageSig = "";
    this.wait = CHECK_EVERY;
  }

  private bagRows(): (any | null)[] {
    const s = session();
    const pocket = ItemsData.BAG_POCKET_ORDER[this.bagPocket] || "ITEMS";
    try { return s && s.bag ? Bag.listPocket(s.bag, pocket) : seq(); } catch { return seq(); }
  }

  /** Once a shown frame, after the game's draw (main.ts). */
  frame(game: any): void {
    if (this.dead) return;
    try {
      this.frame1(game);
    } catch (e) {
      this.dead = true;
      console.log(`[pv] g3 bottom: stopped: ${String((e as Error)?.stack ?? e)}`);
      nat().g3Bottom?.(0);
    }
  }

  private frame1(game: any): void {
    this.ticks++;
    if ((nat().g3BottomKeys?.() ?? 0) & 1) {
      this.setTab(TAB_IDS[(TAB_IDS.indexOf(this.tab) + 1) % TAB_IDS.length]!);
    }
    // A new canvas (or one whose texture went, made again) is drawn into from
    // the next frame on, and drawn whole again half a second later: drawing
    // in a new canvas's first frames did not always reach it on the console
    // (Citra too) -- the title's screen came out black, a first page without
    // its tab frames -- while the same drawing a few frames on always did.
    if (!this.canvas) {
      this.canvas = G.newCanvas(SW, SH);
      this.full = true;
      this.settleAt = this.ticks + 30;
      return;
    }
    const c = this.canvas;
    if ((c as any).freed) {
      c.sync();
      this.full = true;
      this.settleAt = this.ticks + 30;
      return;
    }
    // The host draws only the newest draw list it was handed: if no frame
    // was drawn since the last paint (the list it went in has not been
    // drawn, and this frame's replaces it), all of it is drawn again now.
    const ran = nat().g3ListsRun?.();
    if (ran !== undefined) {
      if (this.paintedAt >= 0 && ran <= this.paintedAt) {
        this.full = true;
        this.lost++;
        if (this.lost <= 3) console.log(`[pv] g3 bottom: a paint's list was not drawn (lists ${ran}); all again`);
      }
      this.paintedAt = -1;
      this.listsRun = ran;
    }
    const s = session();
    const inGame = !!(game && game.phase === "field" && s);
    // a game just under way: everything drawn again a second in, too (the
    // first page can come before the game has its window frames and fonts)
    if (inGame && ++this.inGameFrames === 60) this.full = true;
    if (!inGame) this.inGameFrames = 0;
    if (this.ticks === this.settleAt) this.full = true;
    if (!this.full && ++this.wait < CHECK_EVERY) {
      // between looks, one party slot a frame (a battle's HP shows within
      // six frames, and a look's cost is spread rather than paid at once)
      if (inGame && this.tab === "party" && this.pageSig === "party") this.slotLook(s, this.ticks % 6 + 1);
      return;
    }
    this.wait = 0;
    if (!inGame) {
      if (this.full || this.pageSig !== "idle") {
        this.paint(() => this.drawIdle(), [0, 0, SW, SH]);
        this.pageSig = "idle";
        this.headSig = this.tabSig = "";
        this.redraws++;
      }
    } else {
      if (this.full) this.paint(() => G.clear(0, 0, 0, 1), [0, 0, SW, SH]);
      const hs = `${this.location(s)}|${this.playTime(s)}`;
      if (this.full || hs !== this.headSig) {
        this.headSig = hs;
        this.paint(() => this.drawHeader(s), [0, 0, SW, HEAD_H]);
        this.redraws++;
      }
      const ts = `${this.tab}|${s.name}|${isFemale(s) ? 1 : 0}`;
      if (this.full || ts !== this.tabSig) {
        this.tabSig = ts;
        this.paint(() => this.drawTabs(s), [0, TAB_Y, SW, SH - TAB_Y]);
        this.redraws++;
      }
      this.page(s);
    }
    this.full = false;
    if (this.named !== c.id) {
      this.named = c.id;
      nat().g3Bottom?.(c.id);
    }
  }

  /** The page: drawn again when what it shows has changed (the POKéMON
   *  page's slots are looked at one a frame: slotLook), on the TOWN MAP only
   *  where the head was and is when only the head moved. */
  private page(s: any): void {
    const pageBox: [number, number, number, number] = [0, PAGE_Y, SW, PAGE_H];
    if (this.tab === "party") {
      const v = partyView(s);
      if (this.full || this.pageSig !== "party" || v.mons.length !== this.plateKeys.length) {
        this.pageSig = "party";
        this.plateKeys = v.mons.map((m) => plateKey(m));
        this.spriteKeys = v.mons.map((m, i) => spriteKey(m, v.active[i]!));
        this.paint(() => this.drawPartyPage(v, null), pageBox);
        this.redraws++;
      }
      return;
    }
    if (this.tab === "map") {
      const [region, x, y] = this.playerCell(s);
      const name = this.location(s);
      const d = this.mapDrawn;
      if (!this.full && this.pageSig === "map" && d && d[0] === region && d[3] === name) {
        if (d[1] === x && d[2] === y) return;
        // the head moved: drawn again where it was and where it is
        for (const [hx, hy] of [[d[1], d[2]], [x, y]]) {
          if (hx! < 0) continue;
          const bx = OX + 8 * hx! + 28, by = OY + 8 * hy! + 28;
          this.paint(() => this.drawMap(s, [bx, by, bx + 16, by + 16]), [bx, by, 16, 16]);
        }
        this.mapDrawn = [region, x, y, name];
        this.redraws++;
        releaseArt("map", false);
        return;
      }
      this.pageSig = "map";
      this.mapDrawn = [region, x, y, name];
      this.paint(() => this.drawMap(s, null), pageBox);
      this.redraws++;
      // the Town Map's pictures go back at once (the head's moves make the
      // map's texture again for their two squares)
      releaseArt("map", false);
      return;
    }
    const ps = this.pageSignature(s);
    if (!this.full && ps === this.pageSig) return;
    this.pageSig = ps;
    this.paint(() => {
      if (this.tab === "bag") this.drawBag(s);
      else this.drawCard(s);
    }, pageBox);
    this.redraws++;
    // nothing redraws a part of these pages: their pictures go back at once
    // (made again, from the pixels their images keep, at the next draw)
    if (this.tab === "bag") releaseArt("bag", false);
    else if (this.card) for (const img of [this.card.img, this.card.pic, this.card.badges, this.card.star]) release(img);
  }

  /** The POKéMON page's slot i looked at: drawn again if it changed (its
   *  plate alone, unless its icon or ball changed too); the whole page if
   *  the party's size did. */
  private slotLook(s: any, i: number): void {
    const v = partyView(s);
    if (v.mons.length !== this.plateKeys.length) {
      this.pageSig = "";
      this.wait = CHECK_EVERY;
      return;
    }
    const m = v.mons[i - 1];
    if (!m) return;
    const pk = plateKey(m), sk = spriteKey(m, v.active[i - 1]!);
    const spr = sk !== this.spriteKeys[i - 1];
    if (!spr && pk === this.plateKeys[i - 1]) return;
    this.plateKeys[i - 1] = pk;
    this.spriteKeys[i - 1] = sk;
    this.partyBox(v, spr ? union(plateBox(i), spriteBox(i)) : plateBox(i));
    this.redraws++;
  }

  /** Draw into the canvas inside `scissor` (x, y, w, h), the game's graphics state kept aside. */
  private paint(fn: () => void, scissor: [number, number, number, number]): void {
    const c = this.canvas!;
    c.sync();
    this.paintedAt = this.listsRun;
    G.push("all");
    G.setCanvas(c);
    G.origin();
    G.setShader();
    G.setBlendMode("alpha");
    G.setColor(1, 1, 1, 1);
    G.setScissor(scissor[0], scissor[1], scissor[2], scissor[3]);
    try {
      fn();
    } finally {
      G.pop();
    }
  }

  /** What the BAG, TOWN MAP or card page shows, as text. */
  private pageSignature(s: any): string {
    if (this.tab === "bag") {
      let k = `bag|${this.bagPocket}:${this.bagScroll}:${this.bagRow}:${isFemale(s) ? 1 : 0}:${s.registeredItem ?? ""}`;
      for (const [, r] of ipairs<any>(this.bagRows())) k += `|${r.id}:${r.qty}`;
      return k;
    }
    const c = this.cardData(s);
    let k = `card|${c.money}|${c.caughtMonsCount}|${c.hasPokedex ? 1 : 0}|${c.stars}|${c.playerName}|${c.trainerId}|${c.playTimeHours}:${c.playTimeMinutes}|${c.female ? 1 : 0}`;
    for (let i = 1; i <= 8; i++) k += c.badges[i] ? "1" : "0";
    return k;
  }

  /** The trainer card's data, its POKéDEX count kept (see cardKey). */
  private cardData(s: any): any {
    const k = `${s.map}|${Battle.isActive() ? 1 : 0}|${s.name}|${s.gender}`;
    if (k !== this.cardKey || !this.cardC) {
      this.cardKey = k;
      this.cardC = TrainerCard.cardData(s);
    }
    const c = this.cardC;
    // trainer_card.lua:422 gather's money and time, fresh
    c.money = Math.max(0, Math.floor(tonumber(s.money) ?? 0));
    const pt = s.playtime || s.playTime;
    c.playTimeHours = Math.min(999, Math.max(0, Math.floor(tonumber(pt ? pt.hours : undefined) ?? 0)));
    c.playTimeMinutes = Math.min(59, Math.max(0, Math.floor(tonumber(pt ? pt.minutes : undefined) ?? 0)));
    return c;
  }

  private location(s: any): string {
    const m = tostring(s.map ?? "");
    if (m !== this.locMap) {
      this.locMap = m;
      try { this.locName = sectionName(m); } catch { this.locName = ""; }
    }
    return this.locName;
  }

  private playTime(s: any): string {
    const pt = s.playTime || s.playtime || {};
    const h = Math.min(999, Math.max(0, Math.floor(tonumber(pt.hours) ?? 0)));
    const m = Math.min(59, Math.max(0, Math.floor(tonumber(pt.minutes) ?? 0)));
    return format("%d:%02d", h, m);
  }

  /** [region, x, y]: the map the player is on and their head's cell there. */
  // Lua: region_map.lua:614 (createMapCursor), region_map.lua:1500 (newState's region)
  private playerCell(s: any): [number, number, number] {
    const key = `${s.map}:${s.x}:${s.y}`;
    if (key === this.cellKey) return this.cell;
    this.cellKey = key;
    try {
      RegionExtract.ensureGenerated();
      const def = mapDef(s.map);
      const region = Position.regionFor(def.regionMapSectionId, RegionExtract.LAYOUTS);
      const [x, y] = Position.playerCell({
        map: s.map, x: s.x, y: s.y, escapeWarp: s.escapeWarp, dynamicWarp: s.dynamicWarp,
        def: (id: string) => { const d = mapDef(id); if (d == null) throw new Error("no map header for " + id); return d; },
      }, RegionExtract.GEOMETRY);
      this.cell = [region, x, y];
    } catch {
      this.cell = [0, -1, -1];
    }
    return this.cell;
  }

  // ---------------------------------------------------------- drawing

  /** Before a game is under way (the title, the intro): the party panel's stripes. */
  private drawIdle(): void {
    rect(PARTY_STRIPE_A, 0, 0, SW, SH);
    for (let y = 1; y < SH; y += 2) rect(PARTY_STRIPE_B, 0, y, SW, 1);
  }

  /** The header: the location, the play time. */
  private drawHeader(s: any): void {
    rect(BAR, 0, 0, SW, HEAD_H);
    rect(BAR_DARK, 0, HEAD_H - 2, SW, 2);
    FrlgFont.draw(this.location(s), 6, 0, { colors: C().white, maxWidth: 220 });
    const t = this.playTime(s);
    FrlgFont.draw(t, SW - 6 - FrlgFont.measure(t), 0, { colors: C().white });
  }

  /** The tabs: a window each in the options' frame (at whole tiles, so each
   *  frame's tiles are kept and replayed: Chrome's MemoSet), its icon and the
   *  START menu's word for it. */
  private drawTabs(s: any): void {
    rect(BAR, 0, TAB_Y, SW, SH - TAB_Y);
    for (let i = 0; i < TAB_IDS.length; i++) {
      const id = TAB_IDS[i]!;
      const on = id === this.tab;
      // content 8x3 tiles, its frame the tab's 80x40
      const tx = i * (TAB_W / 8) + 1, ty = TAB_Y / 8 + 1;
      Chrome.stdFrame(tx, ty, 8, 3);
      const cx = tx * 8, cy = ty * 8;
      if (on) {
        // the selection: the selected party slot's warm orange under the words
        rect(SELECT_ORANGE, cx, cy, 64, 24);
      }
      this.drawTabIcon(id, s, cx + 1, cy);
      // the words in the small face (the party menu's), centred right of the icon
      const label = this.tabLabel(id, s);
      const lw = FrlgFont.measure(label, { small: true });
      const room = 64 - 25;
      FrlgFont.draw(label, cx + 25 + Math.max(0, Math.floor((room - lw) / 2)), cy + 6,
        { colors: on ? C().blue : C().dark, maxWidth: room + 1, small: true });
    }
  }

  private drawTabIcon(id: TabId, s: any, x: number, y: number): void {
    if (id === "card") {
      // the Town Map's head of the player
      const img = Gpu.image(isFemale(s) ? "player_leaf" : "player_red");
      G.setColor(1, 1, 1, 1);
      G.draw(img, x + 4, y + 4);
      return;
    }
    BagChrome.drawItemIcon(id === "party" ? ICON_BALL : id === "bag" ? ICON_POTION : ICON_TOWN_MAP, x, y);
  }

  /** The START menu's words for the tabs (the trainer card's is the player's name). */
  private tabLabel(id: TabId, s: any): string {
    try {
      if (id === "party") return RomText.at("sStartMenuActionTable", 1);
      if (id === "bag") return RomText.at("sStartMenuActionTable", 2);
      if (id === "map") return ItemsData.displayName(ICON_TOWN_MAP);
      return tostring(s.name || "RED");
    } catch {
      return id.toUpperCase();
    }
  }

  // ---------------------------------------------------------- POKéMON

  /** The POKéMON page as the party menu draws it: the panel, every slot's
   *  plate and words (its BG), then every slot's sprites over them (its OAM).
   *  With `box` (GBA-screen pixels; the scissor is the caller's) only what
   *  reaches into it: a slot's words only if they do. */
  // Lua: party_menu.lua:2605 (PartyMenu.draw)
  private drawPartyPage(v: PartyView, box: Box | null): void {
    this.drawPartyBg(box ? [box[0] + OX, box[1] + OY, box[2] + OX, box[3] + OY] : null);
    G.translate(OX, OY);
    for (let i = 1; i <= 6; i++) {
      if (box && !hit(box, plateBox(i))) continue;
      const mon = v.mons[i - 1];
      const win = SLOT_WIN[i]!;
      if (mon) {
        if (!box || hit(box, textBox(i))) this.drawSlot(i, mon, v.active[i - 1]!);
        else PartyChrome.drawSlot(win.kind, win.left, win.top, v.active[i - 1], Pokemon.isEgg(mon), false);
      } else if (i > 1) PartyChrome.drawSlot("empty", win.left, win.top, false);
    }
    for (let i = 1; i <= v.mons.length; i++) {
      if (box && !hit(box, spriteBox(i))) continue;
      this.drawSlotSprites(i, v.mons[i - 1], v.active[i - 1]!);
    }
  }

  /** The POKéMON page drawn again inside `box` (GBA-screen pixels) alone. */
  private partyBox(v: PartyView, box: Box): void {
    this.paint(() => this.drawPartyPage(v, box), [box[0] + OX, box[1] + OY, box[2] - box[0], box[3] - box[1]]);
  }

  /** The party menu's panel carried out over the page, its CANCEL button
   *  covered; with `clip` (canvas pixels) only the pieces reaching into it. */
  private drawPartyBg(clip: Box | null): void {
    const bg = partyBg();
    if (!bg) {
      rect(PARTY_STRIPE_A, 0, PAGE_Y, SW, PAGE_H);
      return;
    }
    drawStretched(bg, "party", 0, PAGE_Y, [{ at: 120, add: SW - 240 }], [{ at: 80, add: PAGE_H - 160, period: 2 }], clip);
    // pokemon/party/bg.rgba's CANCEL plate (184..238, 136..152 of the 240x160), now at the panel's bottom right
    const x0 = 184 + (SW - 240), y0 = PAGE_Y + 136 + (PAGE_H - 160);
    if (clip && !hit(clip, [x0, y0, x0 + 55, y0 + 17])) return;
    for (let y = y0; y < y0 + 17; y++) rect((y - PAGE_Y) % 2 === 0 ? PARTY_STRIPE_A : PARTY_STRIPE_B, x0, y, 55, 1);
  }

  /** A filled slot: its plate, name, level or status, gender, HP. */
  // Lua: party_menu.lua:2548 (draw_filled_slot)
  private drawSlot(i: number, mon: any, selected: boolean): void {
    const win = SLOT_WIN[i]!;
    const T = 8;
    const baseX = win.left * T, baseY = win.top * T;
    const info = i === 1 ? INFO_LEFT : INFO_RIGHT;
    const isEgg = Pokemon.isEgg(mon);
    PartyChrome.drawSlot(win.kind, win.left, win.top, selected, isEgg, false);
    partyPrint(Pokemon.displayName(mon), baseX + info.nick[0]!, baseY + info.nick[1]!, 56);
    if (isEgg) return;
    const ailment = SummaryData.statusAilment(mon);
    if (ailment === 0 || ailment === 6) {
      partyPrint(RomText.plain("gText_Lv") + tostring(mon.level ?? 0), baseX + info.level[0]!, baseY + info.level[1]!, 32);
    }
    const gender = mon.gender ?? (Pokemon.gender ? Pokemon.gender(mon.species, mon.personality) : null);
    const isNidoran = (mon.species === 29 || mon.species === 32);
    if (truthy(gender) && !isNidoran) {
      if (gender === "M") {
        FrlgFont.draw("\xE2\x99\x82", baseX + info.gender[0]!, baseY + info.gender[1]!, { colors: FrlgFont.COLOR.PARTY_MALE, small: true });
      } else if (gender === "F") {
        FrlgFont.draw("\xE2\x99\x80", baseX + info.gender[0]!, baseY + info.gender[1]!, { colors: FrlgFont.COLOR.PARTY_FEMALE, small: true });
      }
    }
    const hp = tonumber(mon.hp) ?? 0;
    const maxHp = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 0;
    partyPrint(format("%3d", Math.max(0, Math.min(999, Math.floor(hp)))) + "/", baseX + info.hp[0]!, baseY + info.hp[1]!, 24);
    partyPrint("/" + format("%3d", Math.max(0, Math.min(999, Math.floor(maxHp)))), baseX + info.hpMax[0]!, baseY + info.hpMax[1]!, 24);
    hpBar(hp, maxHp, baseX + info.hpBar[0]!, baseY + info.hpBar[1]!, 48);
  }

  /** Slot i's sprites, as the party menu's OAM puts them (centre coordinates). */
  // Lua: party_menu.lua:580 (ensure_slot_sprites)
  private drawSlotSprites(i: number, mon: any, selected: boolean): void {
    const spr = SLOT_SPRITES[i]!;
    const [mx, my, ix, iy, sx, sy, bx, by] = spr;
    // under to over as the party menu shows them: the ball, the mon over it,
    // the status and the held item over the mon
    PartyChrome.drawBall(bx! - 16, by! - 16, selected ? 1 : 0);
    // NOT FAITHFUL (performance): the icons stand still, in their first frame
    // -- the party menu turns each between two (party_menu.lua:523), but a
    // redraw that often costs this screen more than the 60 fps pace allows
    const icon = Pokemon.monIcon(mon);
    const q = icon && icon.quads ? icon.quads[0] : null;
    if (icon && icon.image && q) {
      // the idle offset (party_menu.lua:515), or the selected icon at the top of its hop (:554)
      let ox = 0, oy = 0;
      if (selected) oy = hpLevel(mon) === 4 ? 0 : -3;
      else if (mx === 16) oy = -4;
      else ox = -4;
      G.setColor(1, 1, 1, 1);
      G.draw(icon.image, q, mx! - 16 + ox, my! - 16 + oy);
    }
    const ailment = SummaryData.statusAilment(mon);
    if (ailment > 0 && ailment !== 6) PartyChrome.drawStatus(sx! - 16, sy! - 4, ailment);
    let hold: any = null;
    try {
      const hf = PartyMenu.heldItemFrame(mon);
      hold = hf != null ? [PartyMenu.heldItemSheet(), hf] : null;
    } catch { hold = null; }
    if (hold && hold[0] && hold[0].quads[hold[1]]) {
      G.setColor(1, 1, 1, 1);
      G.draw(hold[0].image, hold[0].quads[hold[1]], ix! - 4, iy! - 4);
    }
  }

  // ---------------------------------------------------------- BAG

  // Lua: bag_menu.lua:1328 (BagMenu.draw, the list and the description)
  private drawBag(s: any): void {
    const female = isFemale(s);
    const order = ItemsData.BAG_POCKET_ORDER;
    if (this.bagPocket < 1 || this.bagPocket > len(order)) this.bagPocket = 1;
    const pocket = order[this.bagPocket] || "ITEMS";
    const bg = bagBg(female);
    if (bg) {
      // carried out at its left and right edges and its top and bottom rows
      drawStretched(bg, "bag", 0, PAGE_Y, [{ at: 0, add: OX }, { at: 239, add: OX }],
        [{ at: 0, add: OY - PAGE_Y, period: 2 }, { at: 158, add: PAGE_Y + PAGE_H - OY - 160 }]);
    } else rect(BAR, 0, PAGE_Y, SW, PAGE_H);
    G.translate(OX, OY);
    BagChrome.drawBag(8, 36, { female, pocketIdx: this.bagPocket });
    const pLabel = ItemsData.POCKET_LABEL[pocket];
    FrlgFont.draw(pLabel, 8 + Math.floor((72 - FrlgFont.measure(pLabel)) / 2), 9, { colors: C().white });
    // the list: the pocket's rows and CANCEL after them, six at a time (item_menu.c)
    const rows = this.bagRows();
    const total = len(rows) + 1;
    if (this.bagRow > total) this.bagRow = total;
    if (this.bagScroll > total - Math.min(BAG_ROWS, total)) this.bagScroll = total - Math.min(BAG_ROWS, total);
    for (let i = 1; i <= Math.min(BAG_ROWS, total); i++) {
      const idx = this.bagScroll + i;
      const y = 10 + (i - 1) * 16;
      if (idx === this.bagRow) FrlgFont.drawGlyph(FrlgFont.CHAR_SELECTOR_ARROW, 89, y, { colors: C().dark });
      const r = rows[idx];
      if (!r) {
        // src/item_menu.c:645
        FrlgFont.draw(RomText.plain("gFameCheckerText_Cancel"), 97, y, { colors: C().dark });
        continue;
      }
      const num = ItemsData.toNumericId(r.id);
      const col = (num === ItemsData.ITEM_TM_CASE || num === ItemsData.ITEM_BERRY_POUCH) ? C().blue : C().dark;
      let label = r.name;
      if (truthy(s.registeredItem) && ItemsData.toNumericId(s.registeredItem) === num) label = "\xE2\x96\xBA" + label; // the SELECT item's mark
      FrlgFont.draw(label, 97, y, { maxWidth: 96, colors: col });
      const info = r.info || ItemsData.info(r.id);
      const important = info && (tonumber(info.importance) ?? 0) !== 0;
      if (pocket !== "KEY_ITEMS" && pocket !== "TM_CASE" && !important) {
        // src/item_menu.c:716
        FrlgFont.draw(format("\xC3\x97%3d", r.qty || 1), 198, y, { small: true, colors: C().dark });
      }
    }
    // the pockets either side, the list's scroll (src/item_menu.c:287, 759)
    if (this.bagPocket > 1) BagChrome.drawArrow("left", 0, 64);
    if (this.bagPocket < len(order)) BagChrome.drawArrow("right", 64, 64);
    if (this.bagScroll > 0) BagChrome.drawArrow("up", 152, 0);
    if (this.bagScroll + BAG_ROWS < total) BagChrome.drawArrow("down", 152, 96);
    // the row's icon and words below (src/item_menu.c:754: CANCEL's are the bag's closing words)
    const sel = rows[this.bagRow];
    BagChrome.drawItemIcon(sel ? sel.id : ((ItemsData as any).ITEMS_COUNT || 375), 8, 124);
    const desc = sel ? sel.description : RomText.plain("gText_CloseBag");
    if (truthy(desc)) FrlgFont.draw(desc, 40, 115, { colors: C().white, maxWidth: 200, linePitch: 14 });
  }

  // ---------------------------------------------------------- TOWN MAP

  // Lua: region_map.lua:1679 (drawBg0), region_map.lua:1600s (the player icon at 8x+28, 8y+28)
  /** The TOWN MAP page; with `clip` (canvas pixels; the scissor is the
   *  caller's) only the pieces reaching into it. */
  private drawMap(s: any, clip: Box | null): void {
    const [region, px, py] = this.playerCell(s);
    // the Town Map's blue backdrop (region_map.lua:1728), under the frame
    const back = Gpu.rgb(Gpu.manifest().backdrop);
    rect([back[1], back[2], back[3]], 0, PAGE_Y, SW, PAGE_H);
    const frame = Gpu.image("frame_normal");
    drawStretched(frame, "map", 0, PAGE_Y, [{ at: 0, add: OX }, { at: 239, add: OX }],
      [{ at: 0, add: OY - PAGE_Y }, { at: 159, add: PAGE_Y + PAGE_H - OY - 160 }], clip);
    G.translate(OX, OY);
    G.draw(Gpu.image(REGION_IMAGES[region] ?? "kanto_map"), 0, 0);
    if (px >= 0) G.draw(Gpu.image(isFemale(s) ? "player_leaf" : "player_red"), 8 * px + 28, 8 * py + 28);
    // the name box: the map under it darkened by BLDY 6 in the window
    // (24, 16)-(144, 32), the name over it at (26, 18)
    const name = this.location(s);
    if (name && (!clip || hit(clip, [OX + 24, OY + 16, OX + 144, OY + 32]))) {
      // Lua: region_map.lua:524 (updateMapsecNameBox), region_map.lua:1701 (drawBg3)
      rect([0, 0, 0], 24, 16, 120, 16, 6 / 16);
      FrlgFont.draw(name, 26, 18, { colors: { fg: Gpu.topBarColor(1), shadow: Gpu.topBarColor(2), bg: seq(0, 0, 0, 0) as number[] } });
    }
  }

  // ---------------------------------------------------------- the trainer card

  // Lua: trainer_card.lua:777 (draw_front), trainer_card.lua:1050 (draw)
  private drawCard(s: any): void {
    const c = this.cardData(s);
    const female = !!c.female;
    const stars = Math.max(0, Math.min(4, tonumber(c.stars) ?? 0));
    const key = `${stars}${female ? "f" : "m"}`;
    if (!this.card || this.card.key !== key) {
      const suffix = female ? "_female" : "";
      const man = cardManifest();
      const picId = man && man.pics ? (female ? man.pics.female : man.pics.male) : undefined;
      this.card = {
        key,
        img: rgbaImage(`trainer_card/front_${stars}${suffix}.rgba`, 240, 160) ?? rgbaImage(`trainer_card/front_${stars}.rgba`, 240, 160)
          ?? rgbaImage("trainer_card/bg.rgba", 240, 160),
        badges: rgbaImage("trainer_card/badges.rgba", 128, 16),
        pic: picId != null ? rgbaImage(format("trainers/front/%d.rgba", picId), 64, 64) : null,
        star: rgbaImage("trainer_card/star.rgba", 8, 8),
      };
    }
    const k = this.card;
    if (k.img) {
      // the card's striped surround carried out (its first and last four rows, its edge columns)
      drawStretched(k.img, "card", 0, PAGE_Y, [{ at: 0, add: OX }, { at: 239, add: OX }],
        [{ at: 0, add: OY - PAGE_Y, period: 4 }, { at: 156, add: PAGE_Y + PAGE_H - OY - 160, period: 4 }]);
    } else rect(BAR, 0, PAGE_Y, SW, PAGE_H);
    G.translate(OX, OY);
    if (k.pic) G.draw(k.pic, 8 + 144 + 13, 8 + 32 + 4);
    for (const t of TrainerCard.frontTexts(c, false)) {
      FrlgFont.draw(t.text, t.x, t.y, { colors: t.stat ? FrlgFont.COLOR.STAT : FrlgFont.COLOR.NORMAL });
    }
    if (k.star) for (let i = 0; i <= stars - 1; i++) G.draw(k.star, 120 + i * 8, 56);
    if (k.badges) {
      for (let i = 1; i <= 8; i++) {
        if (c.badges[i]) G.draw(k.badges, quadOf(k.badges, (i - 1) * 16, 0, 16, 16), 32 + (i - 1) * 24, 128);
      }
    }
  }
}

// ------------------------------------------------------------ the party menu's layout

interface SlotWin { left: number; top: number; kind: string }
// pret sSinglePartyMenuWindowTemplate (party_menu.lua SLOT_WIN)
const SLOT_WIN: (SlotWin | null)[] = [
  null,
  { left: 1, top: 3, kind: "main" },
  { left: 12, top: 1, kind: "wide" },
  { left: 12, top: 4, kind: "wide" },
  { left: 12, top: 7, kind: "wide" },
  { left: 12, top: 10, kind: "wide" },
  { left: 12, top: 13, kind: "wide" },
];
// pret sPartyMenuSpriteCoords[PARTY_LAYOUT_SINGLE] (party_menu.lua SLOT_SPRITES):
// monX, monY, itemX, itemY, statusX, statusY, ballX, ballY (centre coordinates)
const SLOT_SPRITES: (number[] | null)[] = [
  null,
  [16, 40, 20, 50, 56, 52, 16, 34],
  [104, 18, 108, 28, 144, 27, 102, 25],
  [104, 42, 108, 52, 144, 51, 102, 49],
  [104, 66, 108, 76, 144, 75, 102, 73],
  [104, 90, 108, 100, 144, 99, 102, 97],
  [104, 114, 108, 124, 144, 123, 102, 121],
];
// pret sPartyBoxInfoRects (party_menu.lua INFO_LEFT / INFO_RIGHT), 0-based pairs
type Info = Record<"nick" | "level" | "gender" | "hp" | "hpMax" | "hpBar", number[]>;
const INFO_LEFT: Info = { nick: [24, 11], level: [32, 20], gender: [64, 20], hp: [38, 36], hpMax: [53, 36], hpBar: [24, 35] };
const INFO_RIGHT: Info = { nick: [22, 3], level: [32, 12], gender: [64, 12], hp: [102, 12], hpMax: [117, 12], hpBar: [88, 10] };

/** Slot i's plate, its words and all its sprites, in the party page's
 *  GBA-screen pixels: worked out once from the tables above. */
interface SlotBoxes { plate: Box; text: Box; sprites: Box }
let slotBoxes: (SlotBoxes | null)[] | undefined;
function boxes(i: number): SlotBoxes {
  if (!slotBoxes) {
    slotBoxes = [null];
    for (let k = 1; k <= 6; k++) {
      const w = SLOT_WIN[k]!, sp = SLOT_SPRITES[k]!;
      const mx = sp[0]!, my = sp[1]!;
      const plate: Box = w.kind === "main" ? [8, 24, 88, 80] : [w.left * 8, w.top * 8, 240, w.top * 8 + 24];
      const text: Box = w.kind === "main" ? [32, 24, 88, 80] : [w.left * 8 + 22, w.top * 8, 240, w.top * 8 + 24];
      // the icon selected (3 up) or at rest (4 up in the big slot, 4 left in
      // the others), the ball, the status, the held item
      const iconSel: Box = [mx - 16, my - 19, mx + 16, my + 17];
      const iconRest: Box = k === 1 ? [mx - 16, my - 20, mx + 16, my + 12] : [mx - 20, my - 16, mx + 12, my + 16];
      let spr = union(union(iconSel, iconRest), [sp[6]! - 16, sp[7]! - 16, sp[6]! + 16, sp[7]! + 16]);
      spr = union(spr, [sp[4]! - 16, sp[5]! - 4, sp[4]! + 16, sp[5]! + 4]);
      spr = union(spr, [sp[2]! - 4, sp[3]! - 4, sp[2]! + 4, sp[3]! + 4]);
      slotBoxes.push({ plate, text, sprites: spr });
    }
  }
  return slotBoxes[i]!;
}
const plateBox = (i: number): Box => boxes(i).plate;
const textBox = (i: number): Box => boxes(i).text;
const spriteBox = (i: number): Box => boxes(i).sprites;

/** The bag list's rows shown (src/item_menu.c:1005 MAX_SHOWED). */
const BAG_ROWS = 6;

const REGION_IMAGES: Record<number, string> = { 0: "kanto_map", 1: "sevii123_map", 2: "sevii45_map", 3: "sevii67_map" };

// Lua: party_menu.lua:393 (party_print)
function partyPrint(text: unknown, px: number, py: number, maxW: number): void {
  FrlgFont.draw(tostring(text ?? ""), px, py, { maxWidth: maxW, colors: FrlgFont.COLOR.PARTY, small: true });
}

// Lua: party_menu.lua:503 (get_hp_bar_level)
function hpLevel(mon: any): number {
  if (truthy(mon.isEgg)) return 4;
  const hp = tonumber(mon.hp) ?? 0;
  let maxHp = tonumber(mon.maxHp) ?? 1;
  if (maxHp < 1) maxHp = 1;
  if (hp >= maxHp) return 0;
  if (hp > maxHp * 0.5) return 1;
  if (hp > maxHp * 0.2) return 2;
  if (hp > 0) return 3;
  return 4;
}

// party_menu.lua hp_bar's colours
const HP_GREEN = [0.25, 0.85, 0.25], HP_YELLOW = [0.95, 0.85, 0.15], HP_RED = [0.95, 0.2, 0.15];

// Lua: party_menu.lua:2481 (hp_bar)
function hpBar(hpIn: number, maxHpIn: number, px: number, py: number, width: number): void {
  let maxHp = maxHpIn;
  if (maxHp < 1) maxHp = 1;
  const ratio = Math.max(0, Math.min(1, hpIn / maxHp));
  const w = Math.floor(width * ratio);
  if (w <= 0) return;
  rect(ratio > 0.5 ? HP_GREEN : ratio > 0.2 ? HP_YELLOW : HP_RED, px, py, w, 3);
}

/** An image's host texture given back (the image keeps its pixels: drawn
 *  again, it is made again). */
function release(img: Image | null | undefined | false): void {
  if (img && !(img as any).freed) img.release();
}

/**
 * Memory: what a page alone keeps up, given back when it is not needed --
 * the party menu's plates and panel, the bag's, the Town Map's. They are the
 * game's own chrome modules' images (shared with its screens), so this gives
 * back what the game would have kept too. `release` gives their textures back
 * (linear memory; whichever draws one next makes it again from the pixels
 * the image keeps); `drop` also lets the module forget the bag's and the
 * Town Map's images (their pixels, on the app heap: read from the cache
 * again by whichever draws them next), as the page closes.
 */
function releaseArt(tab: TabId, drop: boolean): void {
  if (tab === "party") {
    const pc = PartyChrome;
    for (const e of [pc._bg, pc._slotMain, pc._slotWide, pc._slotMainSel, pc._slotWideSel, pc._slotEmpty]) release(e ? e.image : null);
    release(pc._balls ? pc._balls.image : null);
    release(pc._status ? pc._status.image : null);
  } else if (tab === "bag") {
    const bc = BagChrome;
    release(bc._bg);
    release(bc._images["bg_female"] || null);
    release(bc._bagMale);
    release(bc._bagFemale);
    if (drop) {
      bc._bg = undefined;
      delete bc._images["bg_female"];
      bc._bagMale = undefined;
      bc._bagFemale = undefined;
      bc._bagQuads = {};
    }
  } else if (tab === "map") {
    for (const n of ["frame_normal", ...Object.values(REGION_IMAGES)]) {
      release(Gpu.images[n]);
      if (drop) delete Gpu.images[n];
    }
  }
}

/**
 * A chrome module's own picture, the one its screen draws: loaded (if it is
 * not yet) by the module's own draw call under an empty scissor, so nothing
 * reaches the canvas, then read from the module's cache -- one texture for
 * the game's screen and this page, not a copy.
 */
function borrow(load: () => void): void {
  G.push("all");
  G.setScissor(0, 0, 0, 0);
  try { load(); } finally { G.pop(); }
}

/** The party menu's background (PartyChrome's). */
function partyBg(): Image | null {
  if (!PartyChrome._bg) borrow(() => PartyChrome.drawBg());
  return PartyChrome._bg ? PartyChrome._bg.image : null;
}

/** The bag's background, his or hers (BagChrome's). */
function bagBg(female: boolean): Image | null {
  if (female) {
    if (BagChrome._images["bg_female"] == null) borrow(() => { BagChrome.drawBg(0, 0, { female: true }); });
    const f = BagChrome._images["bg_female"];
    if (f) return f;
  }
  if (!BagChrome._bg) borrow(() => { BagChrome.drawBg(0, 0, {}); });
  return BagChrome._bg ?? null;
}

/** trainer_card/manifest.lua (the trainer pictures' ids), as trainer_card.lua card_manifest reads it. */
let cardMan: any;
function cardManifest(): any {
  if (cardMan === undefined) {
    cardMan = null;
    try {
      const src = Dataset.cache().read(root() + "/trainer_card/manifest.lua") as string | undefined;
      const chunk = src ? luaLoad(src, "@trainer_card/manifest.lua")[0] : undefined;
      if (chunk) cardMan = chunk();
    } catch {
      cardMan = null;
    }
  }
  return cardMan;
}

export const BottomScreen = new Bottom();
export default BottomScreen;
