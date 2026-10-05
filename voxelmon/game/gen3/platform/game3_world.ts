// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The Game3 runtime's field as a WorldState for
// worldview.ts. Each shown frame, in this order:
//
//   begin(game)   -- before the draw: is the field the voxel world this
//                    frame? Sets Display.world3d (display.ts: FieldView.draw
//                    then keeps its bookkeeping and draws nothing) and the
//                    frame's clear (G.setFrameClearAlpha: 0, so what the
//                    frame leaves undrawn shows the world round the text
//                    boxes and menus).
//   game.draw()   -- the 2D layer.
//   state(game)   -- after the draw: the camera and the actors FieldView
//                    collected for that frame (field_view.ts WorldFrame),
//                    each actor as its overworld sprite frame (ow_sprites.ts
//                    getDraw + pose, exactly what drawSingleActor draws).
//
// VIEW 2D (`game.options.view === "2d"`, or Game3World.force2d), a battle,
// and any frame off the field keep Brian's 2D field / screens and no world.

import { G } from "./graphics.ts";
import { Display } from "../core/display.ts";
import { FieldView } from "../core/field_view.ts";
import { OwSprites } from "../core/ow_sprites.ts";
import { Runtime } from "../core/runtime.ts";
import { Battle } from "../core/battle.ts";
import { CELL, type WorldEnt, type WorldState, type WorldView } from "./worldview.ts";

export class Game3World {
  /** Force VIEW 2D (a bench, or a card without the world paks). */
  static force2d = false;

  /** Whether this frame is drawn as the voxel world (begin's decision). */
  world3d = false;
  private ents: WorldEnt[] = [];
  private st: WorldState = { map: "", camX: 0, camY: 0, ents: this.ents };

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
    const ents = this.ents;
    ents.length = 0;
    if (!OwSprites.ready()) return st;
    for (const a of frame.actors) {
      // NOT FAITHFUL: actors drawn by their own function (a.draw: some field
      // effects, the follower) are not billboarded yet
      if (!a || a.graphicsId == null) continue;
      const spr = OwSprites.getDraw(a.graphicsId);
      if (!spr || !spr.image || !spr.quads) continue;
      const [fi, flip] = OwSprites.pose(spr, a.facing, a.walkPhase, a.stepFlip, {
        bow: a.bow, fieldMove: a.fieldMove, fieldMoveFrame: a.fieldMoveFrame, fishing: a.fishing,
        fishFrame: a.fishFrame, frame: a.frame, running: a.running, alpha: a.alpha,
      });
      const q = spr.quads[fi];
      if (!q) continue;
      spr.image.sync();
      const u0 = q.x / q.sw, v0 = q.y / q.sh, u1 = (q.x + q.w) / q.sw, v1 = (q.y + q.h) / q.sh;
      ents.push({
        tex: spr.image.id,
        // the 2D draw puts the feet on the cell's bottom edge (ow_sprites.ts
        // draw); in the world the person stands in the cell's middle
        x: a.x + CELL / 2,
        z: a.y + CELL / 2,
        lift: 0,
        w: spr.width,
        h: spr.height,
        u0: flip ? u1 : u0,
        v0,
        u1: flip ? u0 : u1,
        v1,
        alpha: a.alpha != null ? Number(a.alpha) : 1,
      });
    }
    return st;
  }
}
