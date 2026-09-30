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
import { APPS, appOf, type GearViewId } from "./gear/model.ts";
import { ctxFor, go, header, type GearCtx } from "./gear/ui.ts";
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

/** Redraw the companion for this frame. */
export function drawKantoGear(host: VoxelHost, game: GearGame): void {
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
  if (!dragging) return;
  const d = dragById(dragging);
  if (!d) return;
  if (x < d.x || y < d.y || x >= d.x + d.w || y >= d.y + d.h) return;
  d.move(x, y, false);
  void game;
}

/** The finger lifting: fires what the down edge lit. */
export function gearTouchUp(game: GearGame): void {
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
