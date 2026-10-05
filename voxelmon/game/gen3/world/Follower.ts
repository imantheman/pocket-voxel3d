// Port of gen1recomp src/world/game3/Follower.lua (GPLv3 + additional terms; see LICENSE.md).
// Optional mod companion, independent of FireRed event-object IDs and scripts.
//
// Port notes:
// - lazyReq("src.core.game3.field") / ("src.core.game3.player"): in the
//   bundle, static imports used inside the functions (field.ts imports this
//   module, so nothing is read at module top level).
// - ModRuntime is the null bus: call() runs the vanilla shouldSpawn, which
//   returns false until a mod sets one, so update() resets every frame.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Field } from "../core/field.ts";
import { Player } from "../core/player.ts";

export interface FollowerNpc {
  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: string;
  passable: boolean;
  pikachuFollower: boolean;
  moving: boolean;
  hidden?: boolean;
  sprite?: any;
  goalX?: number;
  goalY?: number;
  fromX?: number;
  fromY?: number;
  targetX?: number;
  targetY?: number;
  progress?: number;
  stepFrames?: number;
  elevation?: any;
}

let shouldSpawn: (...a: any[]) => any = () => false;
let npc: FollowerNpc | undefined;
let lastMap: any;
let trailX: number | undefined;
let trailY: number | undefined;

export const Follower = {
  // Lua: Follower.lua:13
  setShouldSpawn(fn?: (...a: any[]) => any): (...a: any[]) => any {
    const previous = shouldSpawn;
    shouldSpawn = fn || previous;
    return previous;
  },

  // Lua: Follower.lua:19
  reset(): void {
    npc = undefined;
    lastMap = undefined;
    trailX = undefined;
    trailY = undefined;
  },

  // Lua: Follower.lua:23
  current(): FollowerNpc | undefined { return npc; },
  // Lua: Follower.lua:24
  talk(): boolean { return false; },
  // Lua: Follower.lua:25
  starterInParty(): any { return undefined; },
  // Lua: Follower.lua:26
  setVisible(_: any, visible: boolean): void { if (npc) npc.hidden = !visible; },
  // Lua: Follower.lua:27
  at(_: any, x: number, y: number): FollowerNpc | undefined {
    if (npc && !npc.moving && npc.cellX === x && npc.cellY === y) return npc;
    return undefined;
  },

  // Lua: Follower.lua:31
  update(game: any): void {
    const F: any = Field;
    const player: any = Player;
    const session = F.getSession();
    const world = { player, map: { id: session && session.map } };
    if (!F.running || !session
        || !ModRuntime.call("world.follower.spawn", shouldSpawn, game, world)) {
      Follower.reset();
      return;
    }
    const teleported = trailX != null && (Math.abs(player.cellX - trailX) + Math.abs(player.cellY - trailY!) > 6);
    if (!npc || lastMap !== session.map || teleported) {
      npc = {
        cellX: player.cellX, cellY: player.cellY, px: player.px, py: player.py,
        facing: player.facing, passable: true, pikachuFollower: true, moving: false,
      };
      lastMap = session.map;
      trailX = player.cellX;
      trailY = player.cellY;
    }
    const tx = player.moving ? player.targetX : player.cellX;
    const ty = player.moving ? player.targetY : player.cellY;
    if (tx !== trailX || ty !== trailY) {
      npc.goalX = trailX;
      npc.goalY = trailY;
      trailX = tx;
      trailY = ty;
    }
    if (!npc.moving && npc.goalX != null) {
      const gx = npc.goalX, gy = npc.goalY!;
      const dx = gx - npc.cellX, dy = gy - npc.cellY;
      const distance = Math.abs(dx) + Math.abs(dy);
      npc.goalX = undefined;
      npc.goalY = undefined;
      if (distance > 6) {
        npc.cellX = gx; npc.cellY = gy; npc.px = gx * 16; npc.py = gy * 16;
      } else if (distance > 0) {
        npc.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left")
          : (dy > 0 ? "down" : "up");
        npc.fromX = npc.px;
        npc.fromY = npc.py;
        npc.targetX = gx;
        npc.targetY = gy;
        npc.progress = 0;
        npc.stepFrames = Math.max(1, Math.floor((player.stepFrames || 16) / (distance > 1 ? 2 : 1)));
        npc.moving = true;
      }
    }
    if (npc.moving) {
      npc.progress = npc.progress! + 1;
      const t = Math.min(1, npc.progress / npc.stepFrames!);
      npc.px = npc.fromX! + (npc.targetX! * 16 - npc.fromX!) * t;
      npc.py = npc.fromY! + (npc.targetY! * 16 - npc.fromY!) * t;
      if (t === 1) {
        npc.cellX = npc.targetX!;
        npc.cellY = npc.targetY!;
        npc.moving = false;
      }
    }
    npc.elevation = player.elevation;
  },

  // Lua: Follower.lua:81
  onMapEntered(): void { Follower.reset(); },

  // Lua: Follower.lua:83
  actor(): any {
    if (!npc || !npc.sprite || npc.hidden) return undefined;
    return {
      kind: "follower", i: -1, x: npc.px, y: npc.py,
      sortY: npc.py, elevation: npc.elevation, facing: npc.facing,
      walkPhase: npc.moving ? 1 : 0, renderer: npc.sprite,
    };
  },
};

export default Follower;
