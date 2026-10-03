// Yellow's companion Pikachu: the follower that trails the player, its
// happiness and mood, and what it does when you talk to it. Ported from
// gen1recomp src/world/PikachuFollower.lua, which follows pokeyellow's
// engine/pikachu/pikachu_follow.asm, pikachu_emotions.asm and
// engine/events/pikachu_happiness.asm.
//
// The follower is an NPC in ow.npcs (so it is updated and drawn like one)
// that never blocks: it is `passable`, which collision already honours, so
// walking onto its cell just sends it round to the cell you left.

import { DELTA, type Dir } from "./collision.ts";
import { NPC } from "./npc.ts";
import type { ScriptRow } from "./script.ts";

export const PIKA_NAME = "PIKACHU_FOLLOWER";
const PIKA_INDEX = 99; // clear of every map's real object indices

// ---------------------------------------------------------------------------
// happiness and mood (wPikachuHappiness seeded 90, wPikachuMood neutral 128)
// ---------------------------------------------------------------------------

interface PikaSave {
  version?: string;
  flags?: Record<string, boolean>;
  party?: { species: string; hp: number; status?: string | null; otName?: string; otId?: number }[];
  pikachuHappiness?: number;
  pikachuMood?: number;
  pikachuWalkSteps?: number;
  pikachuEmotionModifier?: number;
  onBike?: boolean;
}

export function happiness(save: PikaSave): number {
  save.pikachuHappiness ??= 90;
  return save.pikachuHappiness;
}

/** HappinessChangeTable: the delta by band (<100, <200, the rest) and the
 * PikachuMoods byte ($80 leaves the mood alone). */
const HAPPINESS_CHANGES: Record<string, { d: [number, number, number]; mood: number }> = {
  LEVELUP: { d: [5, 3, 2], mood: 0x8a },
  USEDITEM: { d: [5, 3, 2], mood: 0x83 },
  USEDXITEM: { d: [1, 1, 0], mood: 0x80 },
  GYMLEADER: { d: [3, 2, 1], mood: 0x80 },
  USEDTMHM: { d: [1, 1, 0], mood: 0x94 },
  WALKING: { d: [2, 1, 1], mood: 0x80 },
  DEPOSITED: { d: [-3, -3, -5], mood: 0x62 },
  FAINTED: { d: [-1, -1, -1], mood: 0x6c },
  PSNFNT: { d: [-5, -5, -10], mood: 0x62 },
  CARELESSTRAINER: { d: [-5, -5, -10], mood: 0x6c },
  TRADE: { d: [-10, -10, -20], mood: 0x00 },
};

/** IsThisPartyMonStarterPikachu: Yellow, a Pikachu, and yours (the OT
 * name and id; a mon with neither is one this port gave you). */
export function isStarterPikachu(
  save: { version?: string; player?: { name?: string; id?: number } },
  mon: { species: string; otName?: string; otId?: number } | undefined,
): boolean {
  if (save.version !== "yellow" || mon?.species !== "PIKACHU") return false;
  if (mon.otName === undefined && mon.otId === undefined) return true;
  return mon.otName === save.player?.name && mon.otId === save.player?.id;
}

/** Your own Pikachu in the party (the starter's OT check), healthy if asked. */
export function starterInParty(save: PikaSave, needHealthy = false) {
  // gen1recomp's approximation of the OT check: any Pikachu stands in
  return (save.party ?? []).find((m) => m.species === "PIKACHU" && (!needHealthy || (m.hp ?? 0) > 0));
}

/** ModifyPikachuHappiness. `mon` is the party mon the event touched, for the
 * per-mon reasons; GYMLEADER and WALKING need any healthy Pikachu along. */
export function modifyHappiness(save: PikaSave, reason: keyof typeof HAPPINESS_CHANGES | string, mon?: { species: string }): void {
  if (save.version !== "yellow") return;
  const row = HAPPINESS_CHANGES[reason];
  if (!row) return;
  if (reason === "GYMLEADER" || reason === "WALKING") {
    if (!starterInParty(save, true)) return;
  } else if (mon?.species !== "PIKACHU") {
    return;
  }
  const h = happiness(save);
  const band = h < 100 ? 0 : h < 200 ? 1 : 2;
  save.pikachuHappiness = Math.max(0, Math.min(255, h + row.d[band]));
  // PikachuMoods: a byte over $80 only raises the mood, one under only lowers
  const b = row.mood;
  if (b !== 0x80) {
    const mood = save.pikachuMood ?? 128;
    if (b > 0x80) {
      if (mood < b && !save.pikachuEmotionModifier) save.pikachuMood = b;
    } else if (mood > b) {
      save.pikachuMood = b;
    }
  }
}

/** UpdatePikachuHappinessAndMood (poison.asm): every 256th step a coin flip
 * on the WALKING bump, and the mood drifts one toward 128 each step. */
export function pikachuStep(save: PikaSave, coin: () => boolean): void {
  if (save.version !== "yellow") return;
  save.pikachuWalkSteps = ((save.pikachuWalkSteps ?? 0) + 1) % 256;
  if (save.pikachuWalkSteps === 0 && coin()) modifyHappiness(save, "WALKING");
  const mood = save.pikachuMood ?? 128;
  if (mood < 128) save.pikachuMood = mood + 1;
  else if (mood > 128) save.pikachuMood = mood - 1;
}

// ---------------------------------------------------------------------------
// the follower
// ---------------------------------------------------------------------------

interface PikaWorld {
  save: PikaSave & Record<string, unknown>;
  data: any;
  map: any;
  player: any;
  npcs: NPC[];
  entities: unknown[];
  pikachuTrail?: { x: number; y: number; ledgeHop?: Dir };
  /** The counter hop in flight (hopToCounter). */
  pikaHop?: { frames: number; fromX: number; fromY: number; cx: number; cy: number; done: () => void };
  /** A scripted walk in flight (walkPikachu): steps left, then done. */
  pikaWalk?: { steps: [Dir, number][]; done: () => void };
  /** Bill's house: the confused walk is owed / has run / Bill is back. */
  pikaBillsPending?: boolean;
  pikaBillsScene?: boolean;
  pikaSceneOver?: boolean;
  setEmote?(entity: unknown, kind: number, frames: number, onDone: () => void): void;
}

/** The follower NPC: its own stepping (a ledge hop covers two cells in one
 * step; the fast follow halves a step when it has fallen behind). */
export class PikachuNPC extends NPC {
  readonly pikachuFollower = true;
  stepLen = 16;
  hop = false;
  goalX?: number;
  goalY?: number;
  idle?: { kind: "wait" | "look"; frames: number };
  idleClock = 0;
  /** Off the trail for a scene (DisablePikachuFollowingPlayer). */
  parked = false;
  /** Height off the ground in px, for the counter hop's arc. */
  lift = 0;

  override update(): void {
    if (!this.moving) return;
    this.progress += 1;
    const d = DELTA[this.facing];
    const cells = this.hop ? 2 : 1;
    const moved = Math.floor((this.progress * 16 * cells) / this.stepLen);
    this.px = this.cellX * 16 + d[0] * moved;
    this.py = this.cellY * 16 + d[1] * moved;
    if (this.progress >= this.stepLen) {
      this.cellX = this.targetX!;
      this.cellY = this.targetY!;
      this.targetX = undefined;
      this.targetY = undefined;
      this.px = this.cellX * 16;
      this.py = this.cellY * 16;
      this.moving = false;
      this.hop = false;
      this.stepFlip = !this.stepFlip;
    }
  }
}

/** ShouldPikachuSpawn, as gen1recomp approximates it: Yellow, the lab gift
 * made, a healthy Pikachu in the party, and not on the bike or the water. */
export function shouldSpawn(w: PikaWorld): boolean {
  const save = w.save;
  if (save.version !== "yellow" && w.data?.version !== "yellow") return false;
  if (!save.flags?.EVENT_GOT_STARTER) return false;
  if (save.onBike || w.player?.surfing) return false;
  if (typeof w.data?.atlas?.sprites?.pikachu !== "number" && !w.data?.sprites?.SPRITE_PIKACHU) return false;
  return !!starterInParty(save, true);
}

export function findFollower(w: PikaWorld): PikachuNPC | undefined {
  return w.npcs.find((n) => (n as PikachuNPC).pikachuFollower) as PikachuNPC | undefined;
}

function removeFollower(w: PikaWorld): void {
  const i = w.npcs.findIndex((n) => (n as PikachuNPC).pikachuFollower);
  if (i < 0) return;
  const npc = w.npcs[i];
  w.npcs.splice(i, 1);
  const j = w.entities.indexOf(npc);
  if (j >= 0) w.entities.splice(j, 1);
}

function makeFollower(w: PikaWorld, x: number, y: number, facing: Dir): PikachuNPC {
  const def = {
    index: PIKA_INDEX, name: PIKA_NAME, sprite: "SPRITE_PIKACHU", movement: "STAY",
    range: "NONE", x, y, text: "TEXT_PIKACHU_FOLLOWER",
  };
  const npc = new PikachuNPC(w.map.id, def as never, { int: () => 0, byte: () => 0 } as never);
  npc.passable = true;
  npc.facing = facing;
  return npc;
}

/**
 * A map just entered (warp, connection, boot): the follower is put back on
 * the player's own cell, hidden under them, and walks out behind as the
 * trail opens (SchedulePikachuSpawnForAfterText's full-spawn path).
 */
export function onMapEntered(w: PikaWorld): void {
  removeFollower(w);
  w.pikachuTrail = undefined;
  w.pikaHop = w.pikaWalk = undefined;
  w.pikaBillsPending = w.pikaBillsScene = w.pikaSceneOver = false;
  if (!shouldSpawn(w)) return;
  const p = w.player;
  const npc = makeFollower(w, p.cellX, p.cellY, p.facing);
  w.npcs.push(npc);
  w.entities.push(npc);
  w.pikachuTrail = { x: p.cellX, y: p.cellY };
}

/** The player just hopped the ledge ahead of (cx,cy) going `dir`? */
function ledgeAhead(w: PikaWorld, cx: number, cy: number, dir: Dir): boolean {
  const d = DELTA[dir];
  const fx = cx + d[0];
  const fy = cy + d[1];
  const m = w.map;
  if (!m.inBounds(fx, fy) || !m.inBounds(cx + d[0] * 2, cy + d[1] * 2)) return false;
  const standing = m.cellTile(cx, cy);
  const front = m.cellTile(fx, fy);
  const tileset = m.def.tileset;
  for (const l of (w.data.field?.ledges ?? []) as Record<string, unknown>[]) {
    if (((l.tileset as string | undefined) ?? "OVERWORLD") === tileset && l.facing === dir &&
        l.input === dir && l.standingTile === standing && l.ledgeTile === front) return true;
  }
  return false;
}

/**
 * One frame of following (pikachu_follow.asm, one walk step behind): the
 * trail is the cell the player last committed to leave; the follower walks
 * to where the trail was. A ledge the player hopped is hopped too, a step
 * late, as the original's hop command waits for the next step.
 */
export function updateFollower(w: PikaWorld, rand: (n: number) => number): void {
  let npc = findFollower(w);
  if (!npc) {
    if (shouldSpawn(w)) onMapEntered(w);
    return;
  }
  if (!shouldSpawn(w)) {
    removeFollower(w);
    return;
  }
  const p = w.player;
  if (w.pikaHop) { stepHop(w, npc); return; }
  if (w.pikaWalk) { stepWalk(w, npc); return; }
  if (w.pikaBillsPending && !npc.moving) {
    w.pikaBillsPending = false;
    billsHouseConfused(w, npc);
    return;
  }
  const trail: { x: number; y: number; ledgeHop?: Dir } = (w.pikachuTrail ??= { x: p.cellX, y: p.cellY });
  const destX: number = p.targetX ?? p.cellX;
  const destY: number = p.targetY ?? p.cellY;
  if (npc.parked) {
    // Parked for a scene: the trail keeps up with the player, and the
    // first step taken once the scene is over sends it after them.
    if (destX !== trail.x || destY !== trail.y) {
      const before = { x: trail.x, y: trail.y };
      trail.x = destX;
      trail.y = destY;
      if (w.pikaSceneOver) {
        npc.parked = false;
        npc.goalX = before.x;
        npc.goalY = before.y;
      }
    }
    (npc as { hidden?: boolean }).hidden = false;
    if (npc.parked) return;
  }
  if (destX !== trail.x || destY !== trail.y) {
    const stepDir: Dir = destY > trail.y ? "down" : destY < trail.y ? "up" : destX > trail.x ? "right" : "left";
    if (trail.ledgeHop === stepDir) {
      trail.ledgeHop = undefined;
    } else {
      trail.ledgeHop = ledgeAhead(w, trail.x, trail.y, stepDir) ? stepDir : undefined;
      npc.goalX = trail.x;
      npc.goalY = trail.y;
    }
    trail.x = destX;
    trail.y = destY;
    npc.idle = undefined;
  }
  // hidden while it stands on the player's own cell (after a warp)
  (npc as { hidden?: boolean }).hidden = !npc.moving && npc.cellX === p.cellX && npc.cellY === p.cellY;
  if (npc.moving) return;
  if (npc.goalX === undefined || npc.goalY === undefined) { idleTick(w, npc, rand); return; }
  const gx = npc.goalX;
  const gy = npc.goalY;
  if (npc.cellX === gx && npc.cellY === gy) {
    npc.goalX = npc.goalY = undefined;
    idleTick(w, npc, rand);
    return;
  }
  const far = Math.abs(npc.cellX - gx) + Math.abs(npc.cellY - gy);
  if (far > 6) {
    // fell a screen behind (forced movement, a warp's arithmetic): snap
    npc.cellX = gx;
    npc.cellY = gy;
    npc.px = gx * 16;
    npc.py = gy * 16;
    npc.goalX = npc.goalY = undefined;
    return;
  }
  const dir: Dir = npc.cellX < gx ? "right" : npc.cellX > gx ? "left" : npc.cellY < gy ? "down" : "up";
  npc.facing = dir;
  const d = DELTA[dir];
  npc.targetX = npc.cellX + d[0];
  npc.targetY = npc.cellY + d[1];
  if (ledgeAhead(w, npc.cellX, npc.cellY, dir)) {
    npc.targetX = npc.cellX + d[0] * 2;
    npc.targetY = npc.cellY + d[1] * 2;
    npc.goalX = npc.targetX;
    npc.goalY = npc.targetY;
    npc.hop = true;
  }
  // the player's step, halved while two or more behind (FastPikachuFollow)
  // (the step the player actually committed: RUNNING SHOES can change the
  // speed the moment B is let go, mid-step)
  const committed = (p as { moving?: boolean; stepFramesCur?: number }).moving
    ? (p as { stepFramesCur?: number }).stepFramesCur
    : undefined;
  const stepLen = committed ?? p.stepSpeed?.() ?? p.stepFrames ?? 16;
  npc.stepLen = far > 1 && !npc.hop ? Math.max(1, Math.floor(stepLen / 2)) : stepLen;
  npc.moving = true;
  npc.progress = 0;
  // the npc loop already ran this frame: take the step's first frame now,
  // or it trails a pixel further every cell
  npc.update();
}

// ---------------------------------------------------------------------------
// scripted beats
// ---------------------------------------------------------------------------

/** The counter hop's length and height: the ledge hop's arc (Player
 * hopLift, a 10 px sine over 32 frames). */
const HOP_FRAMES = 32;

/**
 * PikachuWalksToNurseJoy (engine/pikachu/pikachu_emotions.asm, called from
 * engine/events/pokecenter.asm once the heal is accepted): it looks up and
 * hops onto the counter in front of the player. The original has three
 * movement scripts by where it stands -- below the player, left of it, or
 * right of it -- and all three land on that tile, so this animates the one
 * hop; standing above the player it has none, and nothing happens.
 */
export function hopToCounter(w: PikaWorld, done: () => void): void {
  const npc = findFollower(w);
  const p = w.player;
  if (!npc || (npc as { hidden?: boolean }).hidden || p.facing !== "up" || npc.cellY < p.cellY) {
    done();
    return;
  }
  settle(npc);
  npc.facing = "up";
  w.pikaHop = { frames: 0, fromX: npc.px, fromY: npc.py, cx: p.cellX, cy: p.cellY - 1, done };
}

function settle(npc: PikachuNPC): void {
  npc.moving = false;
  npc.progress = 0;
  npc.hop = false;
  npc.targetX = npc.targetY = undefined;
  npc.goalX = npc.goalY = undefined;
  npc.idle = undefined;
  npc.px = npc.cellX * 16;
  npc.py = npc.cellY * 16;
}

function stepHop(w: PikaWorld, npc: PikachuNPC): void {
  const h = w.pikaHop!;
  h.frames += 1;
  const t = Math.min(1, h.frames / HOP_FRAMES);
  npc.px = Math.round(h.fromX + (h.cx * 16 - h.fromX) * t);
  npc.py = Math.round(h.fromY + (h.cy * 16 - h.fromY) * t);
  npc.lift = Math.floor(10 * Math.sin(t * Math.PI) + 0.5);
  (npc as { hidden?: boolean }).hidden = false;
  if (h.frames < HOP_FRAMES) return;
  npc.cellX = h.cx;
  npc.cellY = h.cy;
  npc.px = h.cx * 16;
  npc.py = h.cy * 16;
  npc.lift = 0;
  w.pikaHop = undefined;
  // the player has not moved: the trail starts again under them, and it
  // steps back off the counter once they walk away
  w.pikachuTrail = { x: w.player.cellX, y: w.player.cellY };
  h.done();
}

/** After the machine: it stands on the counter facing the player
 * (EnablePikachuOverworldSpriteDrawing's `lb bc, 15, 0`). */
export function faceDown(w: PikaWorld): void {
  const npc = findFollower(w);
  if (npc && !npc.moving) npc.facing = "down";
}

/** ApplyPikachuMovementData: walk these steps, one cell a step, then done. */
export function walkPikachu(w: PikaWorld, steps: [Dir, number][], done: () => void): void {
  const npc = findFollower(w);
  if (!npc) { done(); return; }
  settle(npc);
  w.pikaWalk = { steps: steps.map(([d, n]) => [d, n] as [Dir, number]), done };
}

function stepWalk(w: PikaWorld, npc: PikachuNPC): void {
  const walk = w.pikaWalk!;
  (npc as { hidden?: boolean }).hidden = false;
  if (npc.moving) return;
  const step = walk.steps[0];
  if (!step) {
    w.pikaWalk = undefined;
    walk.done();
    return;
  }
  const [dir] = step;
  step[1] -= 1;
  if (step[1] <= 0) walk.steps.shift();
  const d = DELTA[dir];
  npc.facing = dir;
  npc.targetX = npc.cellX + d[0];
  npc.targetY = npc.cellY + d[1];
  npc.stepLen = 16;
  npc.moving = true;
  npc.progress = 0;
  npc.update();
}

/**
 * TryApplyPikachuMovementData: walk `steps` and face `face`, but only when
 * the follower stands on the `where` side of the player
 * (GetPikachuFacingDirectionAndReturnToE: above/below by row first, then
 * left/right on a shared row) and is still following. Done either way.
 */
export function stepAsideIf(w: PikaWorld, where: Dir, steps: Dir[], face: Dir, done: () => void): void {
  const npc = findFollower(w);
  const p = w.player;
  if (!npc || npc.parked || (npc as { hidden?: boolean }).hidden) { done(); return; }
  const side: Dir | null = npc.cellY > p.cellY ? "down" : npc.cellY < p.cellY ? "up"
    : npc.cellX < p.cellX ? "left" : npc.cellX > p.cellX ? "right" : null;
  if (side !== where) { done(); return; }
  walkPikachu(w, steps.map((d) => [d, 1] as [Dir, number]), () => {
    npc.facing = face;
    done();
  });
}

/** A bubble over the follower for 50 frames (Bill's house beats). */
function billsEmotion(w: PikaWorld, npc: PikachuNPC, bubble: number): void {
  w.setEmote?.(npc, bubble, 50, () => {});
}
const QUESTION = 2;
const EXCLAIM = 1;

/**
 * BillsHouseScript0 -> BillsHousePikachuConfused: on the way in, before
 * Bill is met and while the starter has no status, Pikachu wanders right
 * three and up one and wonders at the machine. It stops following for the
 * scene (DisablePikachuFollowingPlayer).
 */
export function enterBillsHouse(w: PikaWorld): void {
  const f = w.save.flags ?? {};
  if (w.save.version !== "yellow" || f.EVENT_MET_BILL_2 || f.EVENT_GOT_SS_TICKET) return;
  if (starterInParty(w.save)?.status) return;
  w.pikaBillsPending = true;
}

function billsHouseConfused(w: PikaWorld, npc: PikachuNPC): void {
  w.pikaBillsScene = true;
  npc.parked = true;
  walkPikachu(w, [["right", 3], ["up", 1]], () => billsEmotion(w, npc, QUESTION));
}

/**
 * The rest of Bill's scene, by stage (scripts/BillsHouse.asm, _2.asm):
 *  watch -- Bill walks round a player facing down while Pikachu is still
 *           following (the confused beat was skipped): it steps aside to
 *           watch, by where it stands (PikachuMovement_WatchPlayer1/2)
 *  enter -- Bill is in the machine: it walks up to look (facing down takes
 *           the long way round -- the cartridge's two tables are named the
 *           wrong way about, and it is the branch that counts)
 *  exit  -- Bill is out: it turns to him, startled; the next step the
 *           player takes, it follows again
 */
export function billsBeat(w: PikaWorld, stage: string): void {
  const npc = findFollower(w);
  if (!npc || w.save.version !== "yellow") return;
  const p = w.player;
  if (stage === "watch") {
    if (w.pikaBillsScene || p.facing !== "down") return;
    let steps: [Dir, number][] | null = null;
    if (npc.cellY < p.cellY) steps = [["left", 1], ["down", 1]];
    else if (npc.cellY === p.cellY && npc.cellX > p.cellX) steps = [["up", 1], ["left", 2], ["down", 1]];
    if (!steps) return;
    npc.parked = true;
    w.pikaSceneOver = true;
    walkPikachu(w, steps, () => { npc.facing = "right"; });
  } else if (stage === "enter") {
    if (!w.pikaBillsScene) return;
    const steps: [Dir, number][] = p.facing === "down"
      ? [["up", 1], ["left", 1], ["up", 2], ["right", 1]]
      : [["up", 3]];
    walkPikachu(w, steps, () => {
      npc.facing = "up";
      billsEmotion(w, npc, QUESTION);
    });
  } else if (stage === "park") {
    // PewterJigglypuff's end: the song sends a healthy Pikachu to sleep
    // where it stands (DisablePikachuFollowingPlayer) for the rest of the
    // visit
    if (starterInParty(w.save)?.status) return;
    npc.parked = true;
    w.pikaSceneOver = false;
  } else if (stage === "exit") {
    if (!w.pikaBillsScene) return;
    npc.facing = "left";
    billsEmotion(w, npc, EXCLAIM);
    w.pikaSceneOver = true;
  }
}

/** Standing still: now and then a glance round (Func_fc803's idle looks). */
function idleTick(_w: PikaWorld, npc: PikachuNPC, rand: (n: number) => number): void {
  npc.idleClock = (npc.idleClock + 1) % 2;
  if (npc.idleClock !== 0) return;
  npc.idle ??= { kind: "wait", frames: 0x20 };
  npc.idle.frames -= 1;
  if (npc.idle.frames > 0) return;
  npc.facing = (["down", "up", "left", "right"] as Dir[])[rand(4)]!;
  npc.idle.frames = 0x20;
}

// ---------------------------------------------------------------------------
// talking to it (TalkToPikachu)
// ---------------------------------------------------------------------------

/** PikachuEmotionTable, each entry's bubble (index into the Yellow sheet,
 * 1-based as the emote verb takes it: 1 ! 2 ? 3 smile 4 skull 5 heart
 * 6 bolt 7 zzz 8 fish), whether it turns its back, and its pikaemotion_pcm
 * clip (none = it says nothing). */
const EMOTIONS: Record<number, { bubble?: number; turnAway?: boolean; clip?: number }> = {
  2: { bubble: 3, clip: 35 }, 3: { clip: 40 }, 4: { clip: 29 }, 5: { clip: 31 }, 6: { bubble: 4 },
  7: { clip: 1 }, 8: { clip: 39 }, 9: { bubble: 4, clip: 6 }, 10: { bubble: 5, clip: 5 },
  11: { bubble: 7, clip: 37 }, 14: { bubble: 6, clip: 10 }, 15: { clip: 34 }, 16: { clip: 33 },
  17: { clip: 13 }, 19: { bubble: 5, clip: 33 }, 20: { bubble: 5, clip: 5 }, 21: { bubble: 8 },
  22: { clip: 4 }, 23: { clip: 19 }, 24: { bubble: 1 }, 25: { bubble: 6, clip: 35 },
  26: { bubble: 7, clip: 37 }, 27: { clip: 9 }, 28: { clip: 15 }, 29: { clip: 5 },
  30: { bubble: 5, turnAway: true, clip: 5 }, 31: { clip: 19 }, 32: { clip: 26 },
};

/** GetPikaPicAnimationScriptIndex: mood picks the column, happiness the row. */
const MOOD_THRESHOLDS = [40, 127, 128, 210, 255];
const MOOD_MATRIX: [number, number[]][] = [
  [50, [14, 14, 6, 13, 13]],
  [100, [9, 9, 5, 12, 12]],
  [130, [3, 3, 1, 8, 8]],
  [160, [3, 3, 4, 15, 15]],
  [200, [17, 17, 7, 2, 2]],
  [250, [17, 17, 16, 10, 10]],
  [255, [17, 17, 19, 20, 20]],
];

/** Each emotion's picture script length in ticks (pikapic_setduration),
 * three frames a tick (PikaPicAnimTimerAndJoypad's Delay3). */
const PIKAPIC_DUR: Record<number, number> = {
  1: 40, 2: 44, 3: 80, 4: 70, 5: 32, 6: 50, 7: 58, 8: 44, 9: 56, 10: 56, 11: 100, 12: 50, 13: 50,
  14: 40, 15: 50, 16: 32, 17: 100, 18: 32, 19: 44, 20: 50, 21: 40, 22: 40, 23: 70, 24: 60,
  25: 50, 26: 100, 27: 30, 28: 64,
};
const PIKAPIC_SCRIPT: Record<number, number> = { 29: 10, 30: 20, 31: 23, 32: 23 };
const MODIFIER_EMOTIONS = [18, 21, 23, 24, 25];

function moodEmotion(save: PikaSave): number {
  const mood = save.pikachuMood ?? 128;
  let col = MOOD_THRESHOLDS.findIndex((t) => mood <= t);
  if (col < 0) col = 4;
  const h = happiness(save);
  const row = MOOD_MATRIX.find(([limit]) => h <= limit) ?? MOOD_MATRIX[MOOD_MATRIX.length - 1]!;
  return row[1][col]!;
}

/** TalkToPikachu's choice: the map beats, its status, the Tower, a pending
 * scripted modifier, then mood and happiness. */
export function selectEmotion(save: PikaSave, mapId: string): number {
  if (mapId === "POKEMON_FAN_CLUB") return 30;
  if (mapId === "PEWTER_POKECENTER") return 26;
  const starter = starterInParty(save);
  if (starter?.status === "SLP") return 11;
  if (starter?.status) return 28;
  if (mapId.startsWith("POKEMON_TOWER_")) return 22;
  const m = save.pikachuEmotionModifier;
  if (m && MODIFIER_EMOTIONS[m - 1] !== undefined) {
    save.pikachuEmotionModifier = undefined;
    return MODIFIER_EMOTIONS[m - 1]!;
  }
  return moodEmotion(save);
}

/**
 * The rows a talk to the follower runs: it faces you (or turns away), its
 * cry, and its framed picture over the map with the bubble for as long as
 * the emotion's own picture script lasts.
 */
export function talkRows(w: PikaWorld, picPage: number, faces = false): ScriptRow[] {
  const save = w.save;
  const emotion = selectEmotion(save, w.map.id);
  const e = EMOTIONS[emotion] ?? {};
  const script = PIKAPIC_SCRIPT[emotion] ?? emotion;
  const hold = (PIKAPIC_DUR[script] ?? 40) * 3;
  const rows: ScriptRow[] = [];
  if (faces) {
    // A dataset with the cart's faces (import stages/pikapic.ts) runs the
    // emotion the cart's way: the bubble over the follower (EmotionBubble's
    // beat), its clip, then the framed face playing its own script.
    if (e.turnAway) rows.push(["face_object", PIKA_NAME, w.player.facing] as unknown as ScriptRow);
    if (e.bubble) rows.push(["emote", PIKA_NAME, e.bubble, 60] as unknown as ScriptRow);
    if (e.clip) rows.push(["pika_clip", e.clip] as unknown as ScriptRow);
    rows.push(["pikapic", script] as unknown as ScriptRow);
    return rows;
  }
  if (e.turnAway) rows.push(["face_object", PIKA_NAME, w.player.facing] as unknown as ScriptRow);
  if (e.clip) rows.push(["pika_clip", e.clip] as unknown as ScriptRow);
  // the pikapic box: the front pic over the map (PlacePikapicTextBoxBorder)
  if (picPage >= 0) rows.push(["pic", picPage, 56, 40, 48, 48] as unknown as ScriptRow);
  rows.push(
    e.bubble
      ? (["emote", PIKA_NAME, e.bubble, hold] as unknown as ScriptRow)
      : (["wait", hold] as unknown as ScriptRow),
  );
  if (picPage >= 0) rows.push(["pic_hide"] as unknown as ScriptRow);
  return rows;
}
