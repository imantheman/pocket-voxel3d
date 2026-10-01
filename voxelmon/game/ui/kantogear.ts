// Kanto Gear companion (3DS bottom screen). A native take on the gen1recomp
// mod (github.com/AverageConsumer/kanto-gear, MIT; see THIRD_PARTY_NOTICES)
// drawn in the GB's own tiles: instead of a second LÖVE window it writes the
// core's `ui_b` surface through the host's bottom-screen ops.
//
// A HOME screen launches the apps (ui/gear/apps): PARTY, MAP, EXPLORER,
// TRAINER, POKéDEX, BAG, TOOLS, STEPS, STAMPS, NOTES, STORE and OPTIONS. L/R
// and the header's arrows step through them; tapping an app's title goes
// HOME. A battle takes the whole screen (ui/gear/battle.ts); the game's own
// menus get touch mirrors (ui/gear/mirrors.ts) while their words stay on the
// top screen.
import {
  beginDrags, beginTargets, currentTargets, dragAt, dragById, pressedId, setPressed, targetAt,
} from "./gear/draw.ts";
import { APPS, appOf, gearSave, type GearViewId } from "./gear/model.ts";
import { clockStr, ctxFor, go, header, type GearCtx } from "./gear/ui.ts";
import { battleTouchDown, battleTouchUp, drawBattleGear, type GearBattle } from "./gear/battle.ts";
import { drawMirror, drawTextHint, mirrorTapThrough } from "./gear/mirrors.ts";
import { availableApps, drawHome, drawOptions, drawSteps, drawStore } from "./gear/apps/home.ts";
import { drawParty } from "./gear/apps/party.ts";
import { drawMap, mapTouch } from "./gear/apps/map.ts";
import { drawExplorer } from "./gear/apps/explorer.ts";
import { drawTrainer } from "./gear/apps/trainer.ts";
import { drawPokedex } from "./gear/apps/pokedex.ts";
import { drawBag } from "./gear/apps/bag.ts";
import { drawTools } from "./gear/apps/tools.ts";
import { drawStamps } from "./gear/apps/stamps.ts";
import { drawNotes } from "./gear/apps/notes.ts";
import type { VoxelHost } from "../host.ts";
import type { GearHost } from "./gear/draw.ts";
import { UI_COLS, UI_ROWS } from "../../../contracts/spec/voxel-spec.ts";

export { gearMapPoint } from "./gear/apps/map.ts";
export type { GearViewId } from "./gear/model.ts";

type GearGame = any;

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

export interface GearTab {
  id: GearViewId;
  label: string;
}

/** The views on offer now, in L/R order: HOME, then the available apps. */
export function gearTabs(game: GearGame): GearTab[] {
  return availableApps(game).map((id) => ({ id, label: appOf(id)!.title }));
}

/** The view shown, clamped to one that is on offer. */
function activeView(game: GearGame): GearViewId {
  const want = (game.gearView ?? "home") as GearViewId;
  return availableApps(game).includes(want) ? want : "home";
}

/** The view `dir` steps from the current one. Wraps. */
export function gearViewStep(game: GearGame, dir: 1 | -1): GearViewId {
  const list = availableApps(game);
  const at = Math.max(0, list.indexOf(activeView(game)));
  return list[(at + dir + list.length) % list.length]!;
}

const DRAW: Partial<Record<GearViewId, (ctx: GearCtx) => void>> = {
  home: drawHome,
  party: drawParty,
  map: drawMap,
  explorer: drawExplorer,
  trainer: drawTrainer,
  pokedex: drawPokedex,
  bag: drawBag,
  tools: drawTools,
  steps: drawSteps,
  stamps: drawStamps,
  notes: drawNotes,
  store: drawStore,
  options: drawOptions,
};

/**
 * No touch guard is needed: a tap fires on release, and only if the button
 * it went down on is still on screen -- a screen that changes under the
 * finger (a battle starting, an app opening) drops the tap rather than
 * pressing whatever took its place.
 */
/** Which screen the current targets were drawn for: a tap is only tested
 * against targets of the screen it lands on. */
let drawnFor = "";

/**
 * What the gear draws, caught before it reaches the host: the tile grid in a
 * mirror of the core's own (`ui_b`, retained there until uiClearBottom),
 * sprites and rects as a list. Most frames redraw exactly what is already up
 * -- the home screen alone is 211 tiles -- so the flush sends only the cells
 * that changed, and clears and resends the lot only when the sprites or
 * rects moved (they have no way to be taken back one at a time).
 */
class GearSink implements GearHost {
  readonly next = new Uint16Array(UI_COLS * UI_ROWS);
  private readonly shown = new Uint16Array(UI_COLS * UI_ROWS);
  private extra: number[] = [];
  private shownExtra: number[] = [];
  /** Frames since everything was last sent (a full resend now and then
   *  keeps the mirror honest whatever happened to the core's copy). */
  private age = 0;

  /** Send everything next flush (a different host, whose grid is unknown). */
  forget(): void {
    this.age = 1 << 30;
  }

  uiClearBottom(): void {
    this.next.fill(0);
    this.extra.length = 0;
  }
  uiTileBottom(x: number, y: number, tile: number): void {
    if (x >= 0 && y >= 0 && x < UI_COLS && y < UI_ROWS) this.next[y * UI_COLS + x] = tile;
  }
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void {
    this.extra.push(0, page, x, y, w, h);
  }
  uiSpriteRectBottom(page: number, x: number, y: number, w: number, h: number, sx: number, sy: number, sw: number, sh: number, flags = 0): void {
    this.extra.push(1, page, x, y, w, h, sx, sy, sw, sh, flags);
  }
  uiRectBottom(x: number, y: number, w: number, h: number, shade: number): void {
    this.extra.push(2, x, y, w, h, shade);
  }

  flush(host: VoxelHost): void {
    const next = this.next;
    const shown = this.shown;
    const extra = this.extra;
    const was = this.shownExtra;
    let same = extra.length === was.length && ++this.age < 300;
    for (let i = 0; same && i < extra.length; i++) if (extra[i] !== was[i]) same = false;
    if (same) {
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== shown[i]) host.uiTileBottom(i % UI_COLS, (i / UI_COLS) | 0, next[i]!);
      }
    } else {
      this.age = 0;
      host.uiClearBottom();
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== 0) host.uiTileBottom(i % UI_COLS, (i / UI_COLS) | 0, next[i]!);
      }
      for (let i = 0; i < extra.length; ) {
        const op = extra[i]!;
        if (op === 0) {
          host.uiSpriteBottom(extra[i + 1]!, extra[i + 2]!, extra[i + 3]!, extra[i + 4]!, extra[i + 5]!);
          i += 6;
        } else if (op === 1) {
          host.uiSpriteRectBottom?.(extra[i + 1]!, extra[i + 2]!, extra[i + 3]!, extra[i + 4]!, extra[i + 5]!,
            extra[i + 6]!, extra[i + 7]!, extra[i + 8]!, extra[i + 9]!, extra[i + 10]!);
          i += 11;
        } else {
          host.uiRectBottom?.(extra[i + 1]!, extra[i + 2]!, extra[i + 3]!, extra[i + 4]!, extra[i + 5]!);
          i += 6;
        }
      }
      this.shownExtra = extra.slice();
    }
    shown.set(next);
  }
}
const sink = new GearSink();

/** Touches so far: anything a finger does can change any app. */
let touchSerial = 0;
/** What the last still frame was drawn from ("" = draw regardless). */
let stillKey = "";
let lastHost: VoxelHost | null = null;
let lastGame: GearGame = null;

/**
 * Walking about with an app up, the gear shows the same thing frame after
 * frame -- it changes on a touch, a step, the clock, the party, a screen
 * coming or going -- and drawing it was a fifth of the 3DS's frame. So on
 * the plain overworld (no menu, no battle) the frame is skipped while those
 * stand still, and what is up stays up (the core keeps the bottom grid
 * until it is cleared). EXPLORER and MAP follow people about, menus have
 * their mirrors, a battle its own screen: those draw every frame.
 */
function stillFrame(game: GearGame): string {
  const top = game.stack?.[game.stack.length - 1];
  if (top?.kind !== "overworld" || game.battleView?.()) return "";
  const view = activeView(game);
  if (view === "explorer" || view === "map") return "";
  const gear = gearSave(game.save);
  let party = "";
  for (const m of game.save?.party ?? []) party += `${m.species}/${m.nickname ?? ""}/${m.level}/${m.hp}/${m.stats?.hp ?? 0};`;
  return `${view}|${pressedId() ?? ""}|${touchSerial}|${game.stack.length}|${game.overworld?.map?.id ?? ""}|` +
    `${gear.steps}|${gear.trip}|${clockStr(gear.clock24)}|${party}`;
}

/** Redraw the companion for this frame. */
export function drawKantoGear(realHost: VoxelHost, game: GearGame): void {
  if (realHost !== lastHost || game !== lastGame) {
    lastHost = realHost;
    lastGame = game;
    stillKey = "";
    sink.forget();
  }
  const key = stillFrame(game);
  if (key !== "" && key === stillKey) return;
  stillKey = key;
  drawGear(sink as unknown as VoxelHost, game);
  sink.flush(realHost);
}

function drawGear(host: VoxelHost, game: GearGame): void {
  beginTargets();
  beginDrags();
  host.uiClearBottom();
  const b: GearBattle | undefined = game.battleView?.()?.battle;
  if (b) {
    drawnFor = "battle";
    drawBattleGear(ctxFor(host, game, "battle"), b);
    return;
  }
  drawnFor = "field";
  const view = activeView(game);
  if (drawMirror(ctxFor(host, game, "mirror"))) {
    return;
  }
  const ctx = ctxFor(host, game, view);
  if (view === "home") {
    drawHome(ctx);
  } else {
    header(ctx, appOf(view)!.title, {
      arrows: true,
      onLeft: () => go(ctx, gearViewStep(game, -1)),
      onRight: () => go(ctx, gearViewStep(game, 1)),
      onTitle: () => go(ctx, "home"),
    });
    DRAW[view]?.(ctx);
  }
  drawTextHint(ctx);
}

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

let dragging: string | null = null;

/** A bottom-screen touch-down, in bottom-target px (0..319, 0..239). */
export function gearTouchDown(game: GearGame, x: number, y: number): void {
  touchSerial++;
  setPressed(null);
  dragging = null;
  const b: GearBattle | undefined = game.battleView?.()?.battle;
  const t = drawnFor === (b ? "battle" : "field") ? targetAt(x, y) : undefined;
  if (b) {
    if (t) { setPressed(t.id); return; }
    battleTouchDown(ctxFor(null as never, game, "battle"), b, x, y);
    return;
  }
  // a text box takes the tap whatever is under it: the page first
  if (mirrorTapThrough(game)) return;
  const d = dragAt(x, y);
  if (d) {
    dragging = d.id;
    d.move(x, y, true);
    return;
  }
  if (t?.id === "map:area") { mapTouch(game, x, y); return; }
  if (t) setPressed(t.id);
}

/** The finger moving while down (the sketch pad follows it). */
export function gearTouchMove(game: GearGame, x: number, y: number): void {
  touchSerial++;
  if (!dragging) return;
  const d = dragById(dragging);
  if (!d) return;
  if (x < d.x || y < d.y || x >= d.x + d.w || y >= d.y + d.h) return;
  d.move(x, y, false);
  void game;
}

/** The finger lifting: fires what the down edge lit. */
export function gearTouchUp(game: GearGame): void {
  touchSerial++;
  dragging = null;
  const id = pressedId();
  setPressed(null);
  if (id) {
    const t = currentTargets().find((c) => c.id === id);
    t?.tap();
    return;
  }
  battleTouchUp(game.battleView?.()?.battle);
}

/** The app list, for tests and the host's own use. */
export const GEAR_APPS = APPS;
