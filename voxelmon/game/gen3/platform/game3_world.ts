// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The Game3 runtime's field as a WorldState for
// worldview.ts. Each shown frame, in this order:
//
//   begin(game)   -- before the draw: is the field the voxel world this
//                    frame? Sets Display.world3d (display.ts: FieldView.draw
//                    then keeps its bookkeeping and draws only what lies on
//                    the screen itself) and the frame's clear
//                    (G.setFrameClearAlpha: 0, so what the frame leaves
//                    undrawn shows the world round the text boxes and menus).
//   game.draw()   -- the 2D layer.
//   state(game)   -- after the draw: the camera and the actors FieldView
//                    collected for that frame (field_view.ts WorldFrame),
//                    each actor as its overworld sprite frame (ow_sprites.ts
//                    getDraw + pose, exactly what drawSingleActor draws) or,
//                    for one drawn by its own function (the field effects
//                    sorted among the actors), the quads that function
//                    draws; the doors and the other field effects FieldView
//                    captured (world_fx.ts); and the side strips for a fade,
//                    a battle transition or a dark cave.
//
// VIEW 2D (`game.options.view === "2d"`, or Game3World.force2d), a battle,
// and any frame off the field keep Brian's 2D field / screens and no world.

import { G, type CapturedQuad } from "./graphics.ts";
import { Display } from "../core/display.ts";
import { FieldView } from "../core/field_view.ts";
import { OwSprites } from "../core/ow_sprites.ts";
import { Runtime } from "../core/runtime.ts";
import { Battle } from "../core/battle.ts";
import { BattleTransition } from "../core/battle_transition.ts";
import { FieldEffects } from "../core/field_effects.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { Weather } from "../core/weather.ts";
import { Fade } from "../ui/fade.ts";
import {
  CELL, STRIPS_COLOUR, STRIPS_EDGE, STRIPS_OFF, type WorldEnt, type WorldState, type WorldStrips, type WorldView,
} from "./worldview.ts";
import { backedImage, cardEnt, feetOf, groundEnt, quadBox, wallEnt } from "./world_fx.ts";

/** The room behind an opening door (doors.ts draw's backing rectangle). */
const DOOR_DARK: [number, number, number] = [0.05, 0.07, 0.1];
/** WEATHER_SHADE's dimming (field_weather.ts draw), as the world's tint. */
const SHADE_TINT = 0xffbdadad; // ABGR of (0.68, 0.68, 0.74)

/** Extra pull toward the eye, px, for what the 2D draw lays over a person. */
const PULL_OVER = 4;
const PULL_FEET = 3;

/** The actors' kinds drawn by their own function that lie on the ground. */
const GROUND_KINDS: Record<string, true> = { field_effect_shadow: true };
/**
 * NOT FAITHFUL (the world's own picture): the grass drawn over the feet of
 * whoever stands in tall grass. The world's tall grass is a card leaned
 * back from each cell's south edge (voxelmon/cook/gen3terrain.ts, the
 * mod's prop cards), which already stands in front of the feet of a person
 * in the cell's middle; the 2D cover would hide them a second time.
 */
const SKIP_KINDS: Record<string, true> = { field_effect_grass: true, field_effect_npc_grass: true };
/** A prop card's foot: 1.5 px north of its cell's south edge, PROP_LIFT up (gen3terrain.ts). */
const PROP_FOOT = 1.5;
const PROP_LIFT = 0.2;

export class Game3World {
  /** Force VIEW 2D (a bench, or a card without the world paks). */
  static force2d = false;

  /** Whether this frame is drawn as the voxel world (begin's decision). */
  world3d = false;
  private ents: WorldEnt[] = [];
  private strips: WorldStrips = { mode: STRIPS_OFF, r: 0, g: 0, b: 0, a: 0 };
  private st: WorldState = { map: "", camX: 0, camY: 0, ents: this.ents, strips: this.strips };
  private cap: CapturedQuad[] = [];

  constructor(private readonly view: WorldView) {}

  /** The map the field is on, if the world has it. */
  private fieldMap(): string | null {
    if (!Runtime.isActive()) return null;
    const s = Runtime.getSession && Runtime.getSession();
    const id = s && s.map;
    return this.view.has(id) ? id : null;
  }

  /** Before the frame's draw. */
  begin(game: any): boolean {
    const view2d = Game3World.force2d || game?.options?.view === "2d";
    const want = !view2d && this.fieldMap() != null && !Battle.isActive();
    this.world3d = want;
    (Display as any).world3d = want;
    G.setFrameClearAlpha(want ? 0 : 1);
    Fade.shown = null;
    return want;
  }

  /** After the frame's draw: the frame's world, or null. */
  state(_game: any): WorldState | null {
    const map = this.world3d ? this.fieldMap() : null;
    const frame = FieldView._worldFrame;
    if (!map || !frame) return null;
    const st = this.st;
    st.map = map;
    st.camX = frame.camX;
    st.camY = frame.camY;
    st.tint = this.tint();
    this.stripsNow();
    const ents = this.ents;
    ents.length = 0;
    // the ground first, so the cards standing on it are drawn after it
    for (const q of frame.behind) ents.push(this.behindEnt(q, frame.px, frame.py));
    for (const q of frame.doors) {
      const b = quadBox(q);
      // the door's own cell is the frame's bottom row (doors.ts draw)
      ents.push(wallEnt(q, Math.floor((b.y1 - 1) / CELL) * CELL + CELL, undefined, backedImage(q.img, DOOR_DARK)));
    }
    if (OwSprites.ready()) {
      for (const a of frame.actors) {
        if (!a) continue;
        if (a.draw) this.drawnActor(a);
        else if (a.graphicsId != null) this.spriteActor(a, frame.py);
      }
    }
    for (const q of frame.heal) ents.push(cardEnt(q, feetOf(q), PULL_OVER));
    // particles and the bird fly round the player; the warp arrow lies on its cell
    for (const q of frame.front) {
      ents.push(this.isSheet(q, "arrow") ? groundEnt(q) : cardEnt(q, frame.py + CELL, PULL_OVER));
    }
    return st;
  }

  /** A person as its overworld sprite frame, lifted by the 2D draw's raise. */
  private spriteActor(a: any, py: number): void {
    const spr = OwSprites.getDraw(a.graphicsId);
    if (!spr || !spr.image || !spr.quads) return;
    const [fi, flip] = OwSprites.pose(spr, a.facing, a.walkPhase, a.stepFlip, {
      bow: a.bow, fieldMove: a.fieldMove, fieldMoveFrame: a.fieldMoveFrame, fishing: a.fishing,
      fishFrame: a.fishFrame, frame: a.frame, running: a.running, alpha: a.alpha,
    });
    const q = spr.quads[fi];
    if (!q) return;
    spr.image.sync();
    const u0 = q.x / q.sw, v0 = q.y / q.sh, u1 = (q.x + q.w) / q.sw, v1 = (q.y + q.h) / q.sh;
    // The 2D draw adds a jump's arc, a surf bob, a fishing pose's shift
    // (the player: field_view.ts playerPixels / collectGame3Actors) or an
    // object's raise (Objects' raiseY: a hop, a shake) to the sprite's y. In
    // the world that is a lift off the floor, not a step north.
    let baseY = a.y;
    if (a.kind === "player") baseY = py;
    else if (a.eventObject) baseY = a.y - (Number(a.eventObject.raiseY) || 0);
    this.ents.push({
      tex: spr.image.id,
      // the 2D draw puts the feet on the cell's bottom edge (ow_sprites.ts
      // draw); in the world the person stands in the cell's middle
      x: a.x + CELL / 2,
      z: baseY + CELL / 2,
      lift: baseY - a.y,
      w: spr.width,
      h: spr.height,
      u0: flip ? u1 : u0,
      v0,
      u1: flip ? u0 : u1,
      v1,
      alpha: a.alpha != null ? Number(a.alpha) : 1,
    });
  }

  /**
   * An actor drawn by its own function (field_effects.ts collectActors: the
   * grass over the feet, splashes, dust, a cut tree, the balloons over a
   * head): what it draws, standing in the cell it sorts in (sortY: the cell
   * of the person it goes with) and lifted as far as the 2D draw raised it.
   */
  private drawnActor(a: any): void {
    if (SKIP_KINDS[a.kind]) return;
    const cap = this.cap;
    cap.length = 0;
    G.push();
    G.origin();
    G.captureBegin(cap);
    try {
      a.draw(a, 0, 0);
    } finally {
      G.captureEnd();
      G.pop();
    }
    const feetY = Math.floor(Number(a.sortY ?? a.y) || 0) + CELL;
    const pull = a.oamPriority != null && a.oamPriority < 2 ? PULL_OVER : PULL_FEET;
    for (const q of cap) this.ents.push(GROUND_KINDS[a.kind] ? groundEnt(q) : cardEnt(q, feetY, pull));
  }

  /**
   * What the 2D field draws under the actors: the surf blob stands under the
   * player (the player's card, lifted by the surf bob, sits on it); the tall
   * grass stirred by a step plays over the world's grass card of its cell
   * (a decal on that card's leaned plane); the rest -- tracks, ripples, the
   * boat's wake -- lies on the floor.
   */
  private behindEnt(q: CapturedQuad, _px: number, py: number): WorldEnt {
    if (this.isSheet(q, "surf_blob")) return cardEnt(q, py + CELL, -1);
    if (this.isSheet(q, "tall_grass") || this.isSheet(q, FieldEffects._fx?.sheet)) {
      const e = wallEnt(q, quadBox(q).y1 - PROP_FOOT);
      e.lift = PROP_LIFT;
      return e;
    }
    return groundEnt(q);
  }

  private isSheet(q: CapturedQuad, name: string | undefined): boolean {
    const s = name ? FieldEffects._sheets[name] : undefined;
    return !!s && s.image === q.img;
  }

  /** The world's tint: WEATHER_SHADE dims the field (its 2D multiply cannot reach the world). */
  private tint(): number {
    const FW: any = G3Lazy["src.core.game3.field_weather"];
    const w = FW && FW.getWeather ? FW.getWeather() : 0;
    return w === Weather.SHADE ? SHADE_TINT : 0xffffffff;
  }

  /**
   * The side strips: while a battle transition runs or a cave is dark
   * (FieldView's flash mask), the 2D layer's edge columns carry on to the
   * screen's edges; while a screen fade (ui/fade.ts) covers the 2D layer,
   * the colour and strength it was drawn with this frame.
   */
  private stripsNow(): void {
    const s = this.strips;
    s.mode = STRIPS_OFF;
    s.r = s.g = s.b = s.a = 0;
    if ((BattleTransition.isActive && BattleTransition.isActive()) || FieldView.flashRadius() != null) {
      s.mode = STRIPS_EDGE;
      return;
    }
    const f = Fade.shown;
    if (f) {
      s.mode = STRIPS_COLOUR;
      s.r = f[0]; s.g = f[1]; s.b = f[2]; s.a = f[3];
    }
  }
}
