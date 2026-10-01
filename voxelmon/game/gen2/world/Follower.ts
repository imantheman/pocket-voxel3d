// Gen 2 party follower: the entity and trail loop Gold's cart has no
// counterpart for, shaped like src/world/PikachuFollower.lua because that is
// the surface Gen 1 follower mods drive (docs/mod-api-gen2-compat.md).
// A port of gen1recomp src/world/gen2/Follower.lua at bdfac727 (MIT).
//
// `world` is the World (its npcs / entities / player / map / sprites fields),
// typed loosely because World is assembled from fragments.

import { Logger } from "../shared/core/Logger.ts";
import { Map } from "./Map.ts";
import { NPC } from "./Npc.ts";
import { truthy } from "../platform/lua.ts";

type ShouldSpawn = (game: any, world: any) => unknown;

// Lua: Follower.lua:11-13 -- above every extracted object_event index, so the
// `<map>_obj_<n>` id Npc seeds from can never collide with a map object.
const INDEX = 250;

// Lua: Follower.lua:19
let warnedSprite = false;

// Lua: Follower.lua:21-27 -- Gold has no companion, so vanilla answers no. A
// module VARIABLE, not a function: setShouldSpawn writes the same cell.
let shouldSpawn: ShouldSpawn = (_game: any, _world: any) => {
  return false;
};

// Lua: Follower.lua:35-47
function spriteDefFor(world: any): any {
  const sprites = world.sprites ?? {};
  const def = sprites[Follower.SPRITE];
  if (def) return def;
  // Loud, then the player's sheet: a mod overwrites npc.sprite the line after
  // NPC.new, so a missing record must not decide whether the entity exists.
  if (!warnedSprite) {
    warnedSprite = true;
    Logger.warn("gen2 follower: no %s sprite record; using the player sheet",
      Follower.SPRITE);
  }
  return world.player ? world.player.spriteDef : undefined;
}

// Lua: Follower.lua:49-65
function makeFollower(_game: any, world: any, x: number, y: number, facing: string | undefined): NPC | undefined {
  const def = spriteDefFor(world);
  if (!def) return undefined;
  const npc = NPC.new(world.map.id, {
    // STANDING_DOWN, not STILL: STILL carries FIXED_FACING and a follower has
    // to turn.
    index: INDEX, name: "FOLLOWER", sprite: Follower.SPRITE,
    movement: NPC.MOVE.STANDING_DOWN, x, y,
  }, def);
  npc.follower = true;
  // the Gen 1 name a mod tests when it hunts the stock companion
  // (src/world/PikachuFollower.lua:141)
  npc.pikachuFollower = true;
  npc.passable = true; // never blocks a step (Player's verdict)
  npc.facing = (facing ?? "down") as NPC["facing"];
  return npc;
}

// Lua: Follower.lua:67-72 -- the follower and its 1-based slot in world.npcs.
function findFollower(world: any): [NPC, number] | undefined {
  const npcs: any[] = world.npcs ?? [];
  for (let i = 0; i < npcs.length; i++) {
    if (npcs[i].pikachuFollower) return [npcs[i], i + 1];
  }
  return undefined;
}

// Lua: Follower.lua:74-82
function remove(world: any): void {
  const found = findFollower(world);
  if (!found) return;
  const [npc, i] = found;
  world.npcs.splice(i - 1, 1);
  const entities: any[] = world.entities ?? [];
  for (let j = 0; j < entities.length; j++) {
    if (entities[j] === npc) {
      entities.splice(j, 1);
      break;
    }
  }
  delete world.follower;
}

// Lua: Follower.lua:84-94 -- behind the player's facing when walkable, else
// his own cell: it trails out on the next step
// (src/world/PikachuFollower.lua:169). A TUPLE [x, y].
function spawnCell(world: any): [number, number] {
  const p = world.player;
  const d = Map.DELTA[p.facing] ?? Map.DELTA.down!;
  const bx = p.cellX - d[0];
  const by = p.cellY - d[1];
  if (world.map.inBounds(bx, by) && world.map.isWalkableCell(bx, by)) {
    return [bx, by];
  }
  return [p.cellX, p.cellY];
}

export const Follower = {
  // Lua: Follower.lua:15-17 -- Gold ships no such record: a mod patches the
  // `sprites` registry before shouldSpawn says yes.
  SPRITE: "SPRITE_PIKACHU",

  // Lua: Follower.lua:29-33
  setShouldSpawn(fn: ShouldSpawn | undefined): ShouldSpawn {
    const previous = shouldSpawn;
    shouldSpawn = fn ?? previous;
    return previous;
  },

  // Lua: Follower.lua:96-98 -- `(findFollower(world))`: the npc alone.
  current(world: any): NPC | undefined {
    const found = findFollower(world);
    return found ? found[0] : undefined;
  },

  // Lua: Follower.lua:100-126
  onMapEntered(game: any, world: any, opts?: any, viaMapLoad?: unknown): void {
    if (!(world && world.map && world.player)) return;
    remove(world);
    if (!truthy(shouldSpawn(game, world))) return;
    // keepPikachu is Gen 1's spelling of the same opt
    // (src/world/PikachuFollower.lua:191); a mod passing it must not get a
    // fresh spawn at every seam.
    const keep = opts ? (opts.keepFollower || opts.keepPikachu) : undefined;
    if (keep) {
      world.npcs.push(keep);
      world.entities.push(keep);
      world.follower = keep;
      return;
    }
    let [x, y] = spawnCell(world);
    // a fresh load parks it under the player and it walks out as the trail
    // opens; a mid-map respawn keeps the behind-the-facing cell (#863)
    if (truthy(viaMapLoad)) {
      x = world.player.cellX;
      y = world.player.cellY;
    }
    const npc = makeFollower(game, world, x, y, world.player.facing);
    if (!npc) return;
    world.npcs.push(npc);
    world.entities.push(npc);
    world.follower = npc;
    world.followerTrail = { x: world.player.cellX, y: world.player.cellY };
    // Gen 1's name for the same table, by reference: rebase mutates it in
    // place, so a mod that resets ow.pikachuTrail still moves the live trail.
    world.pikachuTrail = world.followerTrail;
  },

  // Lua: Follower.lua:128-191 -- one follow step per logic frame, called from
  // World:step after World:updatePeople.
  update(game: any, world: any): void {
    if (!(world && world.map && world.player)) return;
    const found = findFollower(world);
    if (!found) {
      if (truthy(shouldSpawn(game, world))) Follower.onMapEntered(game, world);
      return;
    }
    const npc = found[0];
    if (!truthy(shouldSpawn(game, world))) {
      remove(world);
      return;
    }
    world.follower = npc;
    const p = world.player;
    let trail = world.followerTrail;
    if (!trail) {
      trail = { x: p.cellX, y: p.cellY };
      world.followerTrail = trail;
      world.pikachuTrail = trail;
    }
    // the commit, not the landing: targetX/Y is the live destination, which is
    // what keeps the gap at one cell (src/world/PikachuFollower.lua:429, #410)
    const destX = p.targetX ?? p.cellX;
    const destY = p.targetY ?? p.cellY;
    if (destX !== trail.x || destY !== trail.y) {
      npc.goalX = trail.x;
      npc.goalY = trail.y;
      trail.x = destX;
      trail.y = destY;
    }
    if (npc.moving) return;
    if (npc.goalX == null) return;
    const gx: number = npc.goalX;
    const gy: number = npc.goalY;
    if (npc.cellX === gx && npc.cellY === gy) {
      delete npc.goalX;
      delete npc.goalY;
      return;
    }
    // more than a screen behind (a warp, a scripted move): snap, do not walk
    const far = Math.abs(npc.cellX - gx) + Math.abs(npc.cellY - gy);
    if (far > 6) {
      npc.cellX = gx;
      npc.cellY = gy;
      npc.px = gx * 16;
      npc.py = gy * 16;
      delete npc.goalX;
      delete npc.goalY;
      return;
    }
    let dir: NPC["facing"];
    if (npc.cellX < gx) dir = "right";
    else if (npc.cellX > gx) dir = "left";
    else if (npc.cellY < gy) dir = "down";
    else dir = "up";
    npc.facing = dir;
    npc.stepDir = dir;
    const d = Map.DELTA[dir]!;
    npc.targetX = npc.cellX + d[0];
    npc.targetY = npc.cellY + d[1];
    // the player's own step length, halved while more than a cell behind:
    // FastPikachuFollow (src/world/PikachuFollower.lua:509)
    let stepLen = p.stepFrames ?? 16;
    if (far > 1) stepLen = Math.max(1, Math.floor(stepLen / 2));
    npc.stepFrames = stepLen;
    npc.moving = true;
    npc.progress = 0;
    // World:updatePeople already ran, so burn the first frame here or the
    // follower loses a pixel a tile (src/world/PikachuFollower.lua:520)
    npc.update(world.map, world.entities);
  },

  // Lua: Follower.lua:193-197 -- the two Gen 1 members a follower mod replaces
  // outright. Gold has neither a companion to talk to nor a walking starter.
  talk(_game?: any, _world?: any, _npc?: any, _done?: any): boolean {
    return false;
  },

  // Lua: Follower.lua:199-201
  starterInParty(_save?: any, _needHealthy?: any): undefined {
    return undefined;
  },

  // Lua: Follower.lua:203-220 -- drop the follower from the DRAW list while
  // leaving it in the UPDATE list, so it hides in place and keeps trailing
  // (src/world/PikachuFollower.lua:952). Re-adding faces it down.
  setVisible(world: any, visible: unknown): void {
    const found = findFollower(world);
    if (!found) return;
    const npc = found[0];
    const entities: any[] = world.entities ?? [];
    for (let i = 0; i < entities.length; i++) {
      if (entities[i] === npc) {
        if (truthy(visible)) return;
        entities.splice(i, 1);
        return;
      }
    }
    if (!truthy(visible)) return;
    npc.facing = "down";
    entities.push(npc);
  },

  // Lua: Follower.lua:222-230 -- the follower when it is STANDING on that
  // cell, the test an interact hook wants: mid-step it is between two.
  at(world: any, cx: number, cy: number): NPC | undefined {
    const found = findFollower(world);
    if (!found || found[0].moving) return undefined;
    const npc = found[0];
    if (npc.cellX === cx && npc.cellY === cy) return npc;
    return undefined;
  },

  // Lua: Follower.lua:232-246 -- slide into a connected map's frame by the
  // seam's delta (src/world/PikachuFollower.lua:386).
  rebase(world: any, dx: number, dy: number): void {
    const found = findFollower(world);
    if (found) {
      const npc = found[0];
      npc.cellX = npc.cellX + dx;
      npc.cellY = npc.cellY + dy;
      npc.px = npc.px + dx * 16;
      npc.py = npc.py + dy * 16;
      if (npc.targetX != null) npc.targetX = npc.targetX + dx;
      if (npc.targetY != null) npc.targetY = npc.targetY + dy;
      if (npc.goalX != null) npc.goalX = npc.goalX + dx;
      if (npc.goalY != null) npc.goalY = npc.goalY + dy;
    }
    const trail = world.followerTrail;
    if (trail) {
      trail.x = trail.x + dx;
      trail.y = trail.y + dy;
    }
  },
};

export default Follower;
