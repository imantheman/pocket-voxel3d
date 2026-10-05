// Port of gen1recomp src/core/game3/battle/anim_callbacks.lua (GPLv3 + additional terms; see LICENSE.md).
// Sprite callbacks for createsprite templates (pret Anim* ports, pooled).

import { mod, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { random } from "../../platform/rng.ts";
import { pairs } from "../../platform/lt.ts";
import { gsub } from "../../platform/lpattern.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { AnimSprites, type AnimSprite } from "./anim_sprites.ts";

type S = AnimSprite;

// Lua: anim_callbacks.lua:7
function destroy(sprite: S): void {
  AnimSprites.release(sprite);
}

/** Frames in the sheet: image height / cell height (Brian's inline block). */
function sheetFrames(sprite: S, cellH: number, dflt: number): number {
  let totalFrames = dflt;
  if (sprite.image && sprite.image.getDimensions) {
    const ih = sprite.image.getDimensions()[1];
    totalFrames = Math.max(1, Math.floor(ih / cellH));
  }
  return totalFrames;
}

export const AnimCallbacks: Record<string, any> = {};
const CB = AnimCallbacks;

// Lua: anim_callbacks.lua:12 -- pret AnimHitSplatBasic — IMPACT mark at attacker/target, brief scale-in then destroy.
CB.HitSplatBasic = function (sprite: S): void {
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  const life = sprite.data[0];
  const u = Math.min(1, life / 8);
  let sc = 0.55 + 0.55 * u;
  if (life > 10) {
    sc = sc * (1 - (life - 10) / 6);
  }
  sprite.w = (sprite._baseW ?? 32) * sc;
  sprite.h = (sprite._baseH ?? 32) * sc;
  sprite.alpha = life <= 10 ? 1 : Math.max(0, 1 - (life - 10) / 6);
  if (life >= 16) {
    destroy(sprite);
  }
};
CB.CrossImpact = CB.HitSplatBasic;
CB.FlashingHitSplat = CB.HitSplatBasic;
CB.HitSplatPersistent = CB.HitSplatBasic;

// Lua: anim_callbacks.lua:33 -- pret AnimCuttingSlice + AnimSlice_Step (Cut, Fury Cutter, Air Cutter).
// args[1]=dx (40), args[2]=dy (-32), args[3]=dir (0=R to L, 1=L to R).
CB.CuttingSlice = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const dir = tonumber(sprite.data[2]) ?? 0;
    sprite.data[0] = 0; // frame step counter
    sprite.data[1] = -0x400; // vx_fp (-4.0 px/frame)
    sprite.data[2] = 0x400; // vy_fp (+4.0 px/frame)
    sprite.data[3] = 0; // x offset accumulator (fp)
    sprite.data[4] = 0; // y offset accumulator (fp)
    sprite.data[5] = dir;
    if (dir === 1) {
      sprite.data[1] = -sprite.data[1];
      sprite.hFlip = true;
    } else {
      sprite.hFlip = false;
    }
  }

  // AnimSlice_Step
  sprite.data[3] = (sprite.data[3] ?? 0) + (sprite.data[1] ?? 0);
  sprite.data[4] = (sprite.data[4] ?? 0) + (sprite.data[2] ?? 0);
  const dir = sprite.data[5] ?? 0;
  if (dir === 0) {
    sprite.data[1] = sprite.data[1] + 0x18;
  } else {
    sprite.data[1] = sprite.data[1] - 0x18;
  }
  sprite.data[2] = sprite.data[2] - 0x18;

  sprite.ox = Math.floor((sprite.data[3] ?? 0) / 256);
  sprite.oy = Math.floor((sprite.data[4] ?? 0) / 256);

  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;

  // AnimCmds: 4 frames, 5 ticks per frame (y cell 0, 32, 64, 96)
  const frame = Math.min(3, Math.floor((step - 1) / 5));
  sprite.quadY = frame * (sprite._baseH ?? 32);

  if (step >= 20) {
    destroy(sprite);
  }
};
CB.AirCutterSlice = CB.CuttingSlice;

// Lua: anim_callbacks.lua:79 -- pret AnimSlashSlice / AnimClawSlash / AnimFurySwipes (Slash, Scratch, Claw, False Swipe).
CB.SlashSlice = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
  }
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;
  const frame = Math.min(3, Math.floor((step - 1) / 4));
  sprite.quadY = frame * (sprite._baseH ?? 32);
  if (step >= 16) {
    destroy(sprite);
  }
};
CB.ClawSlash = CB.SlashSlice;
CB.FalseSwipeSlice = CB.SlashSlice;
CB.FalseSwipePositionedSlice = CB.SlashSlice;
CB.FurySwipes = CB.SlashSlice;
CB.RevengeScratch = CB.SlashSlice;

// Lua: anim_callbacks.lua:99 -- pret AnimBite / AnimFang / AnimSuperFang (Bite, Crunch, Super Fang).
CB.Bite = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
  }
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;
  const frame = Math.min(3, Math.floor((step - 1) / 4));
  sprite.quadY = frame * (sprite._baseH ?? 32);
  if (step >= 16) {
    destroy(sprite);
  }
};
CB.Fang = CB.Bite;
CB.SuperFang = CB.Bite;

// Lua: anim_callbacks.lua:119 -- pret AnimRoarNoiseLine — noise arcs from attacker (Growl/Roar).
// arg 0: initial x pixel offset; arg 1: initial y pixel offset;
// arg 2: direction (0 = upward, 1 = downward, 2 = horizontal)
CB.RoarNoiseLine = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const dir = tonumber(sprite.data[2]) ?? 0;
    const isOpponent = !!sprite._reversed;

    let vx = 0x280;
    let vy = 0;
    let animBank = 0;

    if (dir === 0) {
      vx = 0x280;
      vy = -0x280;
      sprite.vFlip = false;
    } else if (dir === 1) {
      vx = 0x280;
      vy = 0x280;
      sprite.vFlip = true;
    } else {
      animBank = 1;
      vx = 0x280;
      vy = 0;
      sprite.vFlip = false;
    }

    if (isOpponent) {
      vx = -vx;
      sprite.hFlip = true;
    } else {
      sprite.hFlip = false;
    }

    sprite.data[0] = vx;
    sprite.data[1] = vy;
    sprite.data[3] = animBank;
    sprite.data[5] = 0;
    sprite.data[6] = 0;
    sprite.data[7] = 0;
  }

  const step = (sprite.data[5] ?? 0) + 1;
  sprite.data[5] = step;

  sprite.data[6] = (sprite.data[6] ?? 0) + (sprite.data[0] ?? 0);
  sprite.data[7] = (sprite.data[7] ?? 0) + (sprite.data[1] ?? 0);
  sprite.ox = Math.floor((sprite.data[6] ?? 0) / 256);
  sprite.oy = Math.floor((sprite.data[7] ?? 0) / 256);

  const bank = sprite.data[3] ?? 0;
  const phase = Math.floor((step - 1) / 3) % 2;
  const cell = (bank === 0) ? phase : (2 + phase);
  sprite.quadY = cell * (sprite._baseH ?? 32);

  if (step >= 14) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:178 -- Projectile trajectory (BulletSeed, WaterBubbleProjectile, etc.).
CB.ThrowProjectile = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[5] = 16;
  }
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;
  const dur = sprite.data[5] ?? 16;
  const u = Math.min(1, step / dur);
  const h = Math.sin(u * Math.PI) * 20;
  sprite.ox = Math.floor((sprite._dx ?? 0) * u);
  sprite.oy = Math.floor((sprite._dy ?? 0) * u - h);
  if (step >= dur) {
    destroy(sprite);
  }
};
CB.BulletSeed = CB.ThrowProjectile;
CB.WaterBubbleProjectile = CB.ThrowProjectile;
CB.SludgeProjectile = CB.ThrowProjectile;
CB.BoneHitProjectile = CB.ThrowProjectile;

// Lua: anim_callbacks.lua:201 -- pret AnimSpriteOnMonPos — plays sprite sheet frames centered on mon position
CB.SpriteOnMonPos = function (sprite: S): void {
  if (sprite.tag === "ECLIPSING_ORB") {
    return AnimCallbacks.EclipsingOrb(sprite);
  }
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
  }
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;
  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  const frame = Math.min(totalFrames - 1, Math.floor((step - 1) / 3));
  sprite.quadY = frame * cellH;
  if (step >= totalFrames * 3) {
    destroy(sprite);
  }
};

const ECLIPSING_ORB_SEQ = [null,
  { cell: 0, hFlip: false },
  { cell: 1, hFlip: false },
  { cell: 2, hFlip: false },
  { cell: 3, hFlip: false },
  { cell: 2, hFlip: true },
  { cell: 1, hFlip: true },
  { cell: 0, hFlip: true },
];

// Lua: anim_callbacks.lua:225 -- pret sEclipsingOrbAnimCmds (Defense Curl orb bubble expansion/contraction).
CB.EclipsingOrb = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
  }
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;

  // (Brian builds frameSeq per call; hoisted to ECLIPSING_ORB_SEQ, same values.)
  const frameSeq = ECLIPSING_ORB_SEQ;
  const cycleTick = (step - 1) % 21;
  const idx = Math.min(7, Math.floor(cycleTick / 3) + 1);
  const f = frameSeq[idx] ?? frameSeq[1]!;
  sprite.quadY = f.cell * (sprite._baseH ?? 32);
  sprite.hFlip = f.hFlip;

  if (step >= 42) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:254 -- pret AnimMovePowderParticle (PoisonPowder, StunSpore, SleepPowder, CottonSpore).
// Sprites fall downwards with sinusoidal sway onto the target Pokémon.
CB.MovePowderParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = tonumber(args[3]) ?? 80;
    sprite._vy = (tonumber(args[4]) ?? 80) / 256;
    let amp = tonumber(args[5]) ?? 5;
    if (sprite._reversed) amp = -amp;
    sprite._amp = amp;
    sprite._speed = tonumber(args[6]) ?? 1;
    sprite._phase = 0;
    sprite._yAccum = 0;
    sprite._step = 0;
  }

  sprite._step = sprite._step + 1;
  sprite._yAccum = sprite._yAccum + sprite._vy;
  sprite.oy = Math.floor(sprite._yAccum);
  sprite._phase = mod(sprite._phase + sprite._speed, 256);
  sprite.ox = Math.floor(Math.sin(sprite._phase * 2 * Math.PI / 256) * sprite._amp);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:282 -- pret AnimAbsorptionOrb (Absorb, Mega Drain, Giga Drain, Leech Life).
// Energy orbs travel from target to attacker in an arc.
CB.AbsorptionOrb = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(12, tonumber(args[4]) ?? 20);
    sprite._amp = tonumber(args[3]) ?? 16;
    sprite._step = 0;
    sprite._startX = sprite.x;
    sprite._startY = sprite.y;
    const ax = sprite._attackerX ?? sprite.x, ay = sprite._attackerY ?? sprite.y;
    sprite._dx = ax - sprite._startX;
    sprite._dy = ay - sprite._startY;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  const arc = Math.sin(u * Math.PI) * sprite._amp;
  sprite.ox = Math.floor(sprite._dx * u);
  sprite.oy = Math.floor(sprite._dy * u - arc);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.PowerAbsorptionOrb = CB.AbsorptionOrb;

// Lua: anim_callbacks.lua:318 -- Linear / projectile translation to target mon location (Ember, Water Gun, Heart, etc.).
// pokefirered/src/battle_anim_mons.c:1440 TranslateAnimSpriteToTargetMonLocation
CB.TranslateAnimSpriteToTargetMonLocation = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(1, tonumber(args[5]) ?? 20);
    sprite._step = 0;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.ox = Math.floor((sprite._dx ?? 0) * u);
  sprite.oy = Math.floor((sprite._dy ?? 0) * u);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.TranslateLinearSingleSineWave = CB.TranslateAnimSpriteToTargetMonLocation;
CB.PainSplitProjectile = CB.TranslateAnimSpriteToTargetMonLocation;
CB.RedHeartProjectile = CB.TranslateAnimSpriteToTargetMonLocation;

// Lua: anim_callbacks.lua:341 -- Diagonal travel with flame animation (Ember flare, Burn flame, TravelDiagonally).
// pokefirered/src/battle_anim_fire.c:603 & pokefirered/src/battle_anim_mons.c:1482
CB.AnimTravelDiagonally = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(1, tonumber(args[5]) ?? 20);
    sprite._step = 0;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.ox = Math.floor((sprite._dx ?? 0) * u);
  sprite.oy = Math.floor((sprite._dy ?? 0) * u);

  // sAnim_BasicFire: 5 frames (32x32 each), 4 ticks per frame (20 ticks full loop)
  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 5);
  sprite.quadY = (Math.floor((sprite._step - 1) / 4) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.TravelDiagonally = CB.AnimTravelDiagonally;
CB.AnimEmberFlare = CB.AnimTravelDiagonally;
CB.EmberFlare = CB.AnimTravelDiagonally;
CB.AnimBurnFlame = CB.AnimTravelDiagonally;
CB.BurnFlame = CB.AnimTravelDiagonally;

// Lua: anim_callbacks.lua:374 -- Floating / drifting particles (Petal Dance, Sweet Scent, Razor Leaf, Flying Particle).
CB.FlyingParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._dur = 32;
    sprite._step = 0;
    const args = sprite._args ?? {};
    sprite._vx = (tonumber(args[3]) ?? 1) * (sprite._reversed ? -1 : 1);
    sprite._vy = tonumber(args[4]) ?? 1;
  }

  sprite._step = sprite._step + 1;
  sprite.ox = (sprite.ox ?? 0) + sprite._vx;
  sprite.oy = (sprite.oy ?? 0) + sprite._vy;

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 4) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.PetalDanceSmallFlower = CB.FlyingParticle;
CB.PetalDanceBigFlower = CB.FlyingParticle;
CB.SweetScentPetal = CB.FlyingParticle;
CB.RazorLeafParticle = CB.FlyingParticle;
CB.FallingFeather = CB.FlyingParticle;

// Lua: anim_callbacks.lua:407 -- Falling rocks / projectiles (Rock Slide, Rock Tomb, Eruption).
CB.FallingRock = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 20;
    sprite.oy = -60;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.oy = Math.floor(-60 + 60 * (u * u));

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.EruptionFallingRock = CB.FallingRock;
CB.RockFragment = CB.FallingRock;
CB.RockTomb = CB.FallingRock;

// Lua: anim_callbacks.lua:436 -- Flames rising and expanding (Ember, Flamethrower, Fire Blast, Outrage).
CB.LargeFlame = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 24;
  }

  sprite._step = sprite._step + 1;
  sprite.oy = -(sprite._step * 0.75);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.OutrageFlame = CB.LargeFlame;
CB.OverheatFlame = CB.LargeFlame;
CB.DragonFireToTarget = CB.LargeFlame;
CB.DragonRageFirePlume = CB.LargeFlame;
CB.FireSpiralInward = CB.LargeFlame;

// Lua: anim_callbacks.lua:465 -- Sparkling stars & twinkle particles (Wish, Swift, Moonlight, Morning Sun).
CB.GrantingStars = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 20;
  }

  sprite._step = sprite._step + 1;
  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.SparklingStars = CB.GrantingStars;
CB.EyeSparkle = CB.GrantingStars;
CB.WallSparkle = CB.GrantingStars;
CB.MoonlightSparkle = CB.GrantingStars;

// Lua: anim_callbacks.lua:491 -- Status / Emote particles (Confuse Duck, Hearts, Tears, Alert, Anger).
CB.DizzyPunchDuck = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 36;
  }

  sprite._step = sprite._step + 1;
  const angle = (sprite._step / 36) * Math.PI * 4;
  sprite.ox = Math.floor(Math.cos(angle) * 16);
  sprite.oy = Math.floor(Math.sin(angle) * 6 - 8);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.AngerMark = CB.SpriteOnMonPos;
CB.TealAlert = CB.SpriteOnMonPos;
CB.TearDrop = CB.SpriteOnMonPos;
CB.PinkHeart = CB.SpriteOnMonPos;
CB.RedHeartRising = CB.SpriteOnMonPos;
CB.RedHeartProjectile = CB.TranslateAnimSpriteToTargetMonLocation;

// Lua: anim_callbacks.lua:515 -- Swirling vortex & orbiting debris (Twister, Whirlpool, Sandstorm, Fire Spin).
CB.ParticleInVortex = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 32;
    sprite._radius = 24;
    sprite._angle = (tonumber(sprite.data[1]) ?? 0) * (Math.PI / 4);
  }

  sprite._step = sprite._step + 1;
  sprite._angle = sprite._angle + 0.22;
  sprite.rotation = sprite._angle;

  const r = sprite._radius * (1.0 - (sprite._step / sprite._dur) * 0.4);
  sprite.ox = Math.floor(Math.cos(sprite._angle) * r + 0.5);
  sprite.oy = Math.floor(Math.sin(sprite._angle) * (r * 0.45) - (sprite._step * 0.6) + 0.5);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.MoveTwisterParticle = CB.ParticleInVortex;
CB.WhirlwindLine = CB.ParticleInVortex;
CB.FlyingSandCrescent = CB.ParticleInVortex;
CB.OrbitFast = CB.ParticleInVortex;
CB.OrbitScatter = CB.ParticleInVortex;

// Lua: anim_callbacks.lua:551 -- Energy orbs with pulsing affine scale and rotation (Dragon Dance, Meteor Mash, Power Orbs).
CB.DragonDanceOrb = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 28;
  }

  sprite._step = sprite._step + 1;
  sprite.rotation = sprite.rotation + 0.15;
  const pulse = 1.0 + Math.sin((sprite._step / 28) * Math.PI * 3) * 0.25;
  sprite.scaleX = pulse;
  sprite.scaleY = pulse;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.MeteorMashStar = CB.DragonDanceOrb;
CB.ReversalOrb = CB.DragonDanceOrb;
CB.SpitUpOrb = CB.DragonDanceOrb;
CB.SwallowBlueOrb = CB.DragonDanceOrb;
CB.SuperpowerOrb = CB.DragonDanceOrb;
CB.SuperpowerRock = CB.DragonDanceOrb;
CB.SuperpowerFireball = CB.DragonDanceOrb;
CB.EndureEnergy = CB.DragonDanceOrb;
CB.TailGlowOrb = CB.DragonDanceOrb;
CB.ThunderboltOrb = CB.DragonDanceOrb;
CB.GrowingChargeOrb = CB.DragonDanceOrb;
CB.GrowingShockWaveOrb = CB.DragonDanceOrb;
CB.SharpenSphere = CB.DragonDanceOrb;
CB.TriAttackTriangle = CB.DragonDanceOrb;

// Lua: anim_callbacks.lua:584 -- Projectiles & multi-hit stingers (Pin Missile, Twineedle, Spike Cannon, Poison Sting).
CB.TranslateStinger = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 16;
    const dx = sprite._dx ?? (sprite._reversed ? -80 : 80);
    const dy = sprite._dy ?? (sprite._reversed ? 40 : -40);
    sprite.rotation = Math.atan2(dy, dx);
  }

  sprite._step = sprite._step + 1;
  const progress = sprite._step / sprite._dur;
  sprite.ox = Math.floor((sprite._dx ?? 0) * progress + 0.5);
  sprite.oy = Math.floor((sprite._dy ?? 0) * progress + 0.5);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.BonemerangProjectile = CB.TranslateStinger;
CB.SonicBoomProjectile = CB.TranslateStinger;
CB.RockBlastRock = CB.TranslateStinger;
CB.LeechLifeNeedle = CB.TranslateStinger;
CB.ThrowMistBall = CB.TranslateStinger;

// Lua: anim_callbacks.lua:610 -- Ice Beam / Blizzard crystal streams.
CB.IceBeamParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 18;
  }

  sprite._step = sprite._step + 1;
  sprite.rotation = sprite.rotation + 0.2;
  const progress = sprite._step / sprite._dur;
  sprite.ox = Math.floor((sprite._dx ?? 0) * progress + 0.5);
  sprite.oy = Math.floor((sprite._dy ?? 0) * progress + 0.5);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.IcePunchSwirlingParticle = CB.ParticleInVortex;

// Lua: anim_callbacks.lua:630 -- Sludge Bomb / Acid / Poison Gas particles.
CB.SludgeBombHitParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 20;
    sprite._vx = (random() - 0.5) * 2.5;
    sprite._vy = -random() * 2.0;
  }

  sprite._step = sprite._step + 1;
  sprite._vy = sprite._vy + 0.18; // gravity
  sprite.ox = Math.floor((sprite.ox ?? 0) + sprite._vx + 0.5);
  sprite.oy = Math.floor((sprite.oy ?? 0) + sprite._vy + 0.5);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.AcidPoisonDroplet = CB.SludgeBombHitParticle;
CB.AcidPoisonBubble = CB.SludgeBombHitParticle;
CB.InitPoisonGasCloudAnim = CB.SludgeBombHitParticle;

// Lua: anim_callbacks.lua:661 -- Radial particle explosion (Explosion, Self-Destruct, Swift burst).
CB.ParticleBurst = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 24;
    const angle = random() * Math.PI * 2;
    const speed = 1.5 + random() * 2.0;
    sprite._vx = Math.cos(angle) * speed;
    sprite._vy = Math.sin(angle) * speed;
  }

  sprite._step = sprite._step + 1;
  sprite.ox = Math.floor((sprite.ox ?? 0) + sprite._vx + 0.5);
  sprite.oy = Math.floor((sprite.oy ?? 0) + sprite._vy + 0.5);
  sprite.alpha = Math.max(0, 1.0 - (sprite._step / sprite._dur));

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:683 -- Additive energy shields & barriers (Reflect, Light Screen, Barrier, Protect).
CB.DefensiveWall = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 36;
    sprite.blendMode = "add";
  }

  sprite._step = sprite._step + 1;
  const pulse = 0.6 + Math.sin((sprite._step / 36) * Math.PI * 4) * 0.35;
  sprite.alpha = pulse;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.GuardRing = CB.DefensiveWall;
CB.BlendThinRing = CB.DefensiveWall;
CB.Protect = CB.DefensiveWall;
CB.WhiteHalo = CB.DefensiveWall;

// Lua: anim_callbacks.lua:705 -- Barrier overlays & entanglements (Block, Disable, Spikes, Web).
CB.BlockX = CB.SpriteOnMonPos;
CB.RedX = CB.SpriteOnMonPos;
CB.SpiderWeb = CB.SpriteOnMonPos;
CB.Spikes = CB.SpriteOnMonPos;
CB.StringWrap = CB.SpriteOnMonPos;

// Lua: anim_callbacks.lua:712 -- Musical notes & sound waves (Sing, Heal Bell, Perish Song, Growl, Roar, Screech, Snore).
CB.HealBellMusicNote = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 32;
    sprite._freq = 0.15 + (tonumber(sprite.data[1]) ?? 0) * 0.05;
  }

  sprite._step = sprite._step + 1;
  sprite.oy = -(sprite._step * 0.9);
  sprite.ox = Math.floor(Math.sin(sprite._step * sprite._freq) * 8 + 0.5);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.PerishSongMusicNote = CB.HealBellMusicNote;
CB.PerishSongMusicNote2 = CB.HealBellMusicNote;
CB.FlyingMusicNotes = CB.HealBellMusicNote;
CB.SlowFlyingMusicNotes = CB.HealBellMusicNote;
CB.JaggedMusicNote = CB.HealBellMusicNote;
CB.UproarRing = CB.DefensiveWall;

// Lua: anim_callbacks.lua:736 -- Snooze Z's and smoke puffs (Rest, Yawn, Smokescreen).
CB.SleepLetterZ = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 28;
  }

  sprite._step = sprite._step + 1;
  sprite.oy = -(sprite._step * 0.7);
  sprite.ox = Math.floor(Math.sin(sprite._step * 0.2) * 6 + 0.5);
  sprite.alpha = Math.max(0, 1.0 - (sprite._step / sprite._dur) * 0.7);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.LetterZ = CB.SleepLetterZ;
CB.YawnCloud = CB.SleepLetterZ;
CB.BlackSmoke = CB.SleepLetterZ;
CB.BreathPuff = CB.SleepLetterZ;
CB.MovementWaves = CB.SpriteOnMonPos;

// Lua: anim_callbacks.lua:759 -- Combat emotes and props (Metronome, Clapping, Fingers, Spoons, Eyes).
CB.MetronomeFinger = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 36;
  }

  sprite._step = sprite._step + 1;
  sprite.rotation = Math.sin((sprite._step / 36) * Math.PI * 6) * 0.35;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.FollowMeFinger = CB.MetronomeFinger;
CB.TauntFinger = CB.MetronomeFinger;
CB.BellyDrumHand = CB.SpriteOnMonPos;
CB.HelpingHandClap = CB.SpriteOnMonPos;
CB.SmellingSaltsHand = CB.SpriteOnMonPos;
CB.ClappingHand = CB.SpriteOnMonPos;
CB.ClappingHand2 = CB.SpriteOnMonPos;
CB.ForesightMagnifyingGlass = CB.SpriteOnMonPos;
CB.MeanLookEye = CB.SpriteOnMonPos;
CB.BentSpoon = CB.SpriteOnMonPos;
CB.Pencil = CB.SpriteOnMonPos;
CB.ThoughtBubble = CB.SpriteOnMonPos;
CB.TrickBag = CB.SpriteOnMonPos;
CB.BatonPassPokeball = CB.SpriteOnMonPos;
CB.Present = CB.SpriteOnMonPos;
CB.Moon = CB.SpriteOnMonPos;
CB.Angel = CB.SpriteOnMonPos;
CB.Devil = CB.SpriteOnMonPos;
CB.QuestionMark = CB.SpriteOnMonPos;
CB.SmellingSaltExclamation = CB.SpriteOnMonPos;
CB.GreenStar = CB.GrantingStars;
CB.WeakFrustrationAngerMark = CB.SpriteOnMonPos;
CB.KnockOffStrike = CB.SpriteOnMonPos;
CB.LockOnTarget = CB.SpriteOnMonPos;
CB.LockOnMoveTarget = CB.SpriteOnMonPos;
CB.MilkBottle = CB.SpriteOnMonPos;
CB.Leer = CB.SpriteOnMonPos;
CB.FallingCoin = CB.FallingRock;
CB.CoinThrow = CB.ThrowProjectile;
CB.FlatterSpotlight = CB.SpriteOnMonPos;
CB.FlatterConfetti = CB.FlyingParticle;
CB.PsychoBoost = CB.ParticleInVortex;
CB.Spotlight = CB.SpriteOnMonPos;
CB.Recycle = CB.ParticleInVortex;
CB.SlideHandOrFootToTarget = CB.TranslateStinger;
CB.GustToTarget = CB.TranslateStinger;
CB.EllipticalGust = CB.ParticleInVortex;
CB.FistOrFootRandomPos = CB.SpriteOnMonPos;
CB.SporeParticle = CB.MovePowderParticle;
CB.TravelDiagonally = CB.TranslateStinger;
CB.RapidSpin = CB.ParticleInVortex;
CB.Lick = CB.SpriteOnMonPos;
CB.Conversion = CB.SpriteOnMonPos;
CB.Conversion2 = CB.SpriteOnMonPos;
CB.RaiseSprite = CB.SpriteOnMonPos;
CB.ComplexPaletteBlend = CB.SpriteOnMonPos;

// Lua: anim_callbacks.lua:821 -- pret AnimLightning — 5-frame lightning bolt strike downward on target (Thunderbolt, Thunder, Spark).
CB.Lightning = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite.z = AnimSprites.Z.GLOBAL_FRONT;
  }
  sprite._step = sprite._step + 1;
  const cellH = sprite._baseH ?? 32;
  const totalFrames = 5;
  const frame = Math.min(totalFrames - 1, Math.floor((sprite._step - 1) / 4));
  sprite.quadY = frame * cellH;
  if (sprite._step >= totalFrames * 4) {
    destroy(sprite);
  }
};
CB.ElectricPuff = CB.Lightning;
CB.ElectricBoltSegment = CB.Lightning;
CB.ShockWaveLightning = CB.Lightning;

// Lua: anim_callbacks.lua:841 -- pret AnimSparkElectricityFlashing — multi-spark rotating flash around battler (Thunder Punch, Zap Cannon).
CB.SparkElectricityFlashing = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(12, tonumber(args[4]) ?? 24);
    sprite._radius = tonumber(args[3]) ?? 20;
    sprite._speed = tonumber(args[6]) ?? 8;
    sprite._angle = (tonumber(args[5]) ?? 0) * (Math.PI / 128);
    sprite.z = AnimSprites.Z.GLOBAL_FRONT;
  }
  sprite._step = sprite._step + 1;
  sprite._angle = sprite._angle + (sprite._speed * 0.05);
  sprite.ox = Math.floor(Math.cos(sprite._angle) * sprite._radius);
  sprite.oy = Math.floor(Math.sin(sprite._angle) * (sprite._radius * 0.6));
  sprite.alpha = (sprite._step % 3 === 0) ? 0.4 : 1.0;
  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.ZapCannonSpark = CB.SparkElectricityFlashing;
CB.SparkElectricity = CB.SparkElectricityFlashing;
CB.VoltTackleOrbSlide = CB.SparkElectricityFlashing;

// Lua: anim_callbacks.lua:866 -- pret AnimBasicFistOrFoot — physical punch/kick strike on attacker/target.
CB.BasicFistOrFoot = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    const args = sprite._args ?? {};
    const animNum = tonumber(args[5]) ?? 0;
    const dur = Math.max(12, tonumber(args[3]) ?? 18);
    sprite._dur = dur;
    const cellH = sprite._baseH ?? 32;
    sprite.quadY = mod(animNum, 4) * cellH;
    sprite.z = AnimSprites.Z.GLOBAL_FRONT;
  }
  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / (sprite._dur ?? 18));
  const sc = (u < 0.3) ? (0.7 + u * 1.5) : 1.0;
  sprite.w = Math.floor((sprite._baseW ?? 32) * sc);
  sprite.h = Math.floor((sprite._baseH ?? 32) * sc);
  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.SpinningKickOrPunch = CB.BasicFistOrFoot;
CB.SlidingKick = CB.BasicFistOrFoot;
CB.JumpKick = CB.BasicFistOrFoot;
CB.StompFoot = CB.BasicFistOrFoot;
CB.CrossChopHand = CB.BasicFistOrFoot;

// Lua: anim_callbacks.lua:894 -- pret AnimNeedleArmSpike — projectile spikes flying in linear trajectory.
CB.NeedleArmSpike = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    const args = sprite._args ?? {};
    const dur = Math.max(8, tonumber(args[5]) ?? 16);
    sprite._dur = dur;
    const targetX = tonumber(args[3]) ?? 0;
    const targetY = tonumber(args[4]) ?? 0;
    sprite._dx = targetX;
    sprite._dy = targetY;
    sprite.rotation = Math.atan2(targetY, targetX);
    sprite.z = AnimSprites.Z.MID_FIELD;
  }
  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.ox = Math.floor((sprite._dx ?? 0) * u);
  sprite.oy = Math.floor((sprite._dy ?? 0) * u);
  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.Spikes = CB.NeedleArmSpike;
CB.PoisonSting = CB.NeedleArmSpike;
CB.PinMissile = CB.NeedleArmSpike;

// Lua: anim_callbacks.lua:921 -- pret AnimHitSplatRandom / AnimHitSplatHandleInvert — scattered multi-hit splats.
CB.HitSplatRandom = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite.ox = random(-16, 16);
    sprite.oy = random(-16, 16);
    sprite.z = AnimSprites.Z.GLOBAL_FRONT;
  }
  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / 8);
  const sc = 0.6 + 0.5 * u;
  sprite.w = Math.floor((sprite._baseW ?? 32) * sc);
  sprite.h = Math.floor((sprite._baseH ?? 32) * sc);
  sprite.alpha = (sprite._step <= 8) ? 1.0 : Math.max(0, 1 - (sprite._step - 8) / 6);
  if (sprite._step >= 14) {
    destroy(sprite);
  }
};
CB.HitSplatHandleInvert = CB.HitSplatRandom;

// Lua: anim_callbacks.lua:942 -- pret AnimMudSportDirt — mud splatter arching and dripping.
CB.MudSportDirt = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(10, tonumber(args[3]) ?? 20);
    sprite._vx = random(-12, 12);
    sprite._vy = -random(15, 30);
    sprite.z = AnimSprites.Z.GLOBAL_BEHIND;
  }
  sprite._step = sprite._step + 1;
  const t = sprite._step;
  sprite.ox = Math.floor(sprite._vx * (t / 10));
  sprite.oy = Math.floor(sprite._vy * (t / 10) + (0.5 * 3.8 * (t / 10) ** 2));
  sprite.alpha = Math.max(0, 1 - sprite._step / sprite._dur);
  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.MudSlap = CB.MudSportDirt;
CB.MudShot = CB.MudSportDirt;

// Lua: anim_callbacks.lua:966 -- pret AnimSmallDriftingBubbles (pokefirered/src/battle_anim_water.c:1011)
CB.SmallDriftingBubbles = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const r1 = random(0, 255) + 256;
    let r2 = random(0, 511);
    if (r2 > 255) r2 = 256 - r2;
    sprite.data[0] = 0; // step counter
    sprite.data[1] = r1; // Q8.8 vx
    sprite.data[2] = r2; // Q8.8 vy
    sprite.data[3] = 0; // Q8.8 x accumulator
    sprite.data[4] = 0; // Q8.8 y accumulator
    sprite.z = AnimSprites.Z.FRONT;
  }

  sprite.data[3] = (sprite.data[3] ?? 0) + (sprite.data[1] ?? 256);
  sprite.data[4] = (sprite.data[4] ?? 0) + (sprite.data[2] ?? 128);

  if (mod(sprite.data[1], 2) === 1) {
    sprite.ox = -Math.floor((sprite.data[3] ?? 0) / 256);
  } else {
    sprite.ox = Math.floor((sprite.data[3] ?? 0) / 256);
  }
  sprite.oy = Math.floor((sprite.data[4] ?? 0) / 256);

  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  if (sprite.data[0] >= 21) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:998 -- pret AnimBubbleEffect (pokefirered/src/battle_anim_water.c:286)
CB.BubbleEffect = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0; // step
    sprite.data[1] = 0; // sine phase
    sprite.data[2] = random(18, 28); // duration
    sprite.z = AnimSprites.Z.FRONT;
  }

  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  sprite.data[1] = ((sprite.data[1] ?? 0) + 12) % 256;
  sprite.ox = Math.floor(Math.sin((sprite.data[1] / 256) * 2 * Math.PI) * 6);
  sprite.oy = -(sprite.data[0] * 1.2);

  const u = sprite.data[0] / sprite.data[2];
  const sc = 0.6 + 0.5 * u;
  sprite.w = Math.floor((sprite._baseW ?? 16) * sc);
  sprite.h = Math.floor((sprite._baseH ?? 16) * sc);
  sprite.alpha = Math.max(0, 1.0 - u * 0.3);

  if (sprite.data[0] >= sprite.data[2]) {
    destroy(sprite);
  }
};
CB.SmallBubblePair = CB.BubbleEffect;
CB.WaterPulseBubble = CB.BubbleEffect;
CB.WaterGunDroplet = CB.BubbleEffect;
CB.WaterPulseRing = CB.BubbleEffect;

// Lua: anim_callbacks.lua:1029 -- pret AnimFirePlume (pokefirered/src/battle_anim_fire.c:486)
// arg 0: dx, arg 1: dy, arg 2: duration, arg 3: dy_step, arg 4: dx_step, arg 5: unused
CB.FirePlume = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    const dur = tonumber(args[3]) ?? 20;
    const dyStep = tonumber(args[4]) ?? -2;
    let dxStep = tonumber(args[5]) ?? 0;
    if (sprite._reversed) {
      dxStep = -dxStep;
    }
    sprite.data[0] = 0; // step
    sprite.data[1] = dur; // lifetime
    sprite.data[2] = dxStep; // x velocity
    sprite.data[3] = dyStep; // y velocity
    sprite.data[4] = dur; // move duration
    sprite.z = AnimSprites.Z.FRONT;
  }

  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  if (sprite.data[0] < (sprite.data[4] ?? 20)) {
    sprite.ox = (sprite.ox ?? 0) + (sprite.data[2] ?? 0);
    sprite.oy = (sprite.oy ?? 0) + (sprite.data[3] ?? -2);
  }

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite.data[0] - 1) / 3) % totalFrames) * cellH;
  sprite.alpha = Math.max(0, 1.0 - (sprite.data[0] / (sprite.data[1] ?? 20)) * 0.4);

  if (sprite.data[0] >= (sprite.data[1] ?? 20)) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:1071 -- pret AnimFireSpiralOutward (pokefirered/src/battle_anim_fire.c:703)
// arg 0: unused, arg 1: unused, arg 2: duration, arg 3: startDelay
CB.FireSpiralOutward = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite.data[0] = tonumber(args[4]) ?? 0; // delay
    sprite.data[1] = tonumber(args[3]) ?? 24; // duration
    sprite.data[2] = 0; // radius Q8.8
    sprite.data[3] = (tonumber(args[5]) ?? 0) * 32; // angle
    sprite.z = AnimSprites.Z.FRONT;
  }

  if ((sprite.data[0] ?? 0) > 0) {
    sprite.data[0] = sprite.data[0] - 1;
    sprite.alpha = 0;
    return;
  }
  sprite.alpha = 1;

  const angle = sprite.data[3] ?? 0;
  const radius = Math.floor((sprite.data[2] ?? 0) / 256);
  sprite.ox = Math.floor(Math.sin((angle / 256) * 2 * Math.PI) * radius);
  sprite.oy = Math.floor(Math.cos((angle / 256) * 2 * Math.PI) * (radius * 0.6));
  sprite.data[3] = mod(angle + 10, 256);
  sprite.data[2] = (sprite.data[2] ?? 0) + 0xD0;

  const cellH = sprite._baseH ?? 16;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = mod(Math.floor(angle / 32), totalFrames) * cellH;

  sprite.data[1] = (sprite.data[1] ?? 24) - 1;
  if (sprite.data[1] <= 0) {
    destroy(sprite);
  }
};

// Lua: anim_callbacks.lua:1111 -- pret AnimElectricity / AnimSparkElectricity (pokefirered/src/battle_anim_electric.c:85, 140)
CB.Electricity = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 16; // duration
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  sprite.ox = random(-8, 8);
  sprite.oy = random(-8, 8);
  sprite.hFlip = (random() > 0.5);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 1);
  sprite.quadY = (Math.floor((sprite.data[0] - 1) / 2) % totalFrames) * cellH;

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.SparkElectricity = CB.Electricity;
CB.ThunderboltSegment = CB.Electricity;

// Lua: anim_callbacks.lua:1139 -- pret AnimSolarBeamBigOrb / AnimSolarBeamSmallOrb (pokefirered/src/battle_anim_effects_2.c:400)
CB.SolarBeamBigOrb = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 24;
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  const progress = sprite.data[0] / sprite.data[1];
  const sc = 0.5 + 0.7 * Math.min(1.0, progress * 1.5);
  sprite.w = Math.floor((sprite._baseW ?? 32) * sc);
  sprite.h = Math.floor((sprite._baseH ?? 32) * sc);
  sprite.rotation = (sprite.rotation ?? 0) + 0.15;

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.SolarBeamSmallOrb = CB.SolarBeamBigOrb;
CB.GrowingChargeOrb = CB.SolarBeamBigOrb;

// Lua: anim_callbacks.lua:1161 -- pret AnimWeatherBallDown / AnimWeatherBallUp (pokefirered/src/battle_anim_effects_2.c:650)
CB.WeatherBallDown = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 20;
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  const progress = sprite.data[0] / sprite.data[1];
  sprite.oy = Math.floor(progress * 48);
  sprite.rotation = (sprite.rotation ?? 0) + 0.1;

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.WeatherBallUp = CB.WeatherBallDown;
CB.ZapCannonBall = CB.WeatherBallDown;

// Lua: anim_callbacks.lua:1181 -- pret AnimIceEffectParticle / AnimSwirlingSnowball (pokefirered/src/battle_anim_ice.c:95, 180)
CB.IceEffectParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 20;
    sprite.data[2] = (random() - 0.5) * 1.5; // vx
    sprite.data[3] = 1.2 + random() * 0.8; // vy
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  sprite.ox = Math.floor((sprite.ox ?? 0) + sprite.data[2]);
  sprite.oy = Math.floor((sprite.oy ?? 0) + sprite.data[3]);
  sprite.rotation = (sprite.rotation ?? 0) + 0.12;

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.SwirlingSnowball = CB.IceEffectParticle;
CB.IceBallChunk = CB.IceEffectParticle;

// Lua: anim_callbacks.lua:1203 -- pret AnimDirtPlumeParticle / AnimRockScatter / AnimDirtScatter (pokefirered/src/battle_anim_ground.c:110, 210)
CB.DirtPlumeParticle = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 22;
    sprite.data[2] = (random() - 0.5) * 2.0; // vx
    sprite.data[3] = -2.5 - random() * 1.5; // vy initial upward
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  sprite.data[3] = sprite.data[3] + 0.25; // gravity
  sprite.ox = Math.floor((sprite.ox ?? 0) + sprite.data[2]);
  sprite.oy = Math.floor((sprite.oy ?? 0) + sprite.data[3]);

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.RockScatter = CB.DirtPlumeParticle;
CB.DirtScatter = CB.DirtPlumeParticle;
CB.MudSportDirt = CB.DirtPlumeParticle;
CB.SandAttackMud = CB.DirtPlumeParticle;
CB.MudSand = CB.DirtPlumeParticle;

// Lua: anim_callbacks.lua:1228 -- pret AnimWaveFromCenterOfTarget / AnimAirWaveCrescent / AnimSoundWave
CB.WaveFromCenterOfTarget = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite.data[0] = 0;
    sprite.data[1] = 20;
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  const progress = sprite.data[0] / sprite.data[1];
  const sc = 0.4 + 1.2 * progress;
  sprite.w = Math.floor((sprite._baseW ?? 32) * sc);
  sprite.h = Math.floor((sprite._baseH ?? 32) * sc);
  sprite.alpha = Math.max(0, 1.0 - progress);

  if (sprite.data[0] >= sprite.data[1]) {
    destroy(sprite);
  }
};
CB.AirWaveCrescent = CB.WaveFromCenterOfTarget;
CB.SoundWave = CB.WaveFromCenterOfTarget;

// Lua: anim_callbacks.lua:1250 -- pret AnimWillOWispFire / AnimWillOWispOrb — orbiting ghostly flames.
CB.WillOWispFire = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 32;
    sprite._angle = (sprite.data[0] ?? 0) * (Math.PI / 4);
    sprite._radius = 28;
    sprite.z = AnimSprites.Z.FRONT;
  }
  sprite._step = sprite._step + 1;
  sprite._angle = sprite._angle + 0.15;
  sprite._radius = Math.max(4, sprite._radius - 0.7);
  sprite.ox = Math.floor(Math.cos(sprite._angle) * sprite._radius);
  sprite.oy = Math.floor(Math.sin(sprite._angle) * (sprite._radius * 0.6));
  sprite.alpha = Math.max(0, 1.0 - sprite._step / sprite._dur);
  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.WillOWispOrb = CB.WillOWispFire;
CB.IngrainOrb = CB.WillOWispFire;
CB.IngrainRoot = CB.SpriteOnMonPos;
CB.FrenzyPlantRoot = CB.SpriteOnMonPos;
CB.ConstrictBinding = CB.SpriteOnMonPos;
CB.LeechSeed = CB.ThrowProjectile;
CB.ThunderWave = CB.SpriteOnMonPos;
CB.AssistPawprint = CB.SpriteOnMonPos;

// Lua: anim_callbacks.lua:1280 -- Orbit attacker, translate to target, orbit target (Fire Blast Ring).
// pokefirered/src/battle_anim_fire.c:628
CB.AnimFireRing = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._angle = tonumber(args[3]) ?? 0;
    sprite._phase = 1;
    sprite._phaseTimer = 0;
    sprite._step = 0;
  }

  sprite._phaseTimer = sprite._phaseTimer + 1;
  const rad = (sprite._angle / 256) * 2 * Math.PI;
  const orbitX = Math.floor(Math.sin(rad) * 28);
  const orbitY = Math.floor(Math.cos(rad) * 28);
  sprite._angle = mod(sprite._angle + 20, 256);

  if (sprite._phase === 1) {
    sprite.ox = orbitX;
    sprite.oy = orbitY;
    if (sprite._phaseTimer >= 18) {
      sprite._phase = 2;
      sprite._phaseTimer = 0;
    }
  } else if (sprite._phase === 2) {
    const u = Math.min(1, sprite._phaseTimer / 25);
    const tx = Math.floor((sprite._dx ?? 0) * u);
    const ty = Math.floor((sprite._dy ?? 0) * u);
    sprite.ox = tx + orbitX;
    sprite.oy = ty + orbitY;
    if (sprite._phaseTimer >= 25) {
      sprite._phase = 3;
      sprite._phaseTimer = 0;
    }
  } else if (sprite._phase === 3) {
    sprite.ox = (sprite._dx ?? 0) + orbitX;
    sprite.oy = (sprite._dy ?? 0) + orbitY;
    if (sprite._phaseTimer >= 31) {
      destroy(sprite);
      return;
    }
  }

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 5);
  sprite._step = (sprite._step ?? 0) + 1;
  sprite.quadY = (Math.floor((sprite._step - 1) / 4) % totalFrames) * cellH;
};
CB.FireRing = CB.AnimFireRing;

// Lua: anim_callbacks.lua:1334 -- Fire Blast Cross impact blast (pokefirered/src/battle_anim_fire.c:692).
CB.AnimFireCross = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(1, tonumber(args[3]) ?? 13);
    sprite._step = 0;
    let dxStep = tonumber(args[4]) ?? 0;
    const dyStep = tonumber(args[5]) ?? 0;
    if (sprite._reversed) dxStep = -dxStep;
    sprite._vx = dxStep;
    sprite._vy = dyStep;
  }

  sprite._step = sprite._step + 1;
  sprite.ox = (sprite.ox ?? 0) + sprite._vx;
  sprite.oy = (sprite.oy ?? 0) + sprite._vy;

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 5);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.FireCross = CB.AnimFireCross;

// Lua: anim_callbacks.lua:1366 -- Fire spread blast for Blaze Kick / Fire Punch (pokefirered/src/battle_anim_fire.c:475).
CB.AnimFireSpread = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    const args = sprite._args ?? {};
    sprite._dur = Math.max(1, tonumber(args[5]) ?? 16);
    sprite._step = 0;
    let txStep = tonumber(args[3]) ?? 0;
    const tyStep = tonumber(args[4]) ?? 0;
    if (sprite._reversed) txStep = -txStep;
    sprite._vx = txStep;
    sprite._vy = tyStep;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.ox = Math.floor(sprite._vx * u);
  sprite.oy = Math.floor(sprite._vy * u);

  const cellH = sprite._baseH ?? 32;
  const totalFrames = sheetFrames(sprite, cellH, 5);
  sprite.quadY = (Math.floor((sprite._step - 1) / 3) % totalFrames) * cellH;

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.FireSpread = CB.AnimFireSpread;

// Lua: anim_callbacks.lua:1399 -- Sunlight ray beam from Sunny Day (pokefirered/src/battle_anim_fire.c:583).
CB.AnimSunlight = function (sprite: S): void {
  if (!sprite._inited) {
    sprite._inited = true;
    sprite._step = 0;
    sprite._dur = 30;
  }

  sprite._step = sprite._step + 1;
  const u = Math.min(1, sprite._step / sprite._dur);
  sprite.alpha = Math.sin(u * Math.PI);

  if (sprite._step >= sprite._dur) {
    destroy(sprite);
  }
};
CB.Sunlight = CB.AnimSunlight;

// Lua: anim_callbacks.lua:1416
CB.SimpleFadeOut = function (sprite: S): void {
  sprite.data[0] = (sprite.data[0] ?? 0) + 1;
  const life = sprite.data[0];
  sprite.alpha = 1 - life / 20;
  if (life >= 20) destroy(sprite);
};

// Lua: anim_callbacks.lua:1424 -- pokefirered/src/battle_anim_special.c:2166-2177,
CB.ShinySparkleOrbit = function (sprite: S): void {
  sprite.imageValue = sprite.data[2] ?? 0;
  const angle = sprite.data[1] ?? 0;
  const radians = mod(angle, 256) * 2 * Math.PI / 256;
  sprite.ox = Math.floor(Math.sin(radians) * 24);
  sprite.oy = Math.floor(Math.cos(radians) * 24);
  sprite.data[1] = angle + 12;
  if (sprite.data[1] > 255) destroy(sprite);
};

// Lua: anim_callbacks.lua:1435 -- pokefirered/src/battle_anim_special.c:2120-2139,
CB.ShinySparkle = function (sprite: S): void {
  sprite.imageValue = sprite.data[2] ?? 0;
  const step = (sprite.data[0] ?? 0) + 1;
  sprite.data[0] = step;
  if (step <= 4) {
    sprite.visible = false;
    return;
  }
  sprite.visible = true;
  const n = step - 4;
  sprite.ox = -32 + n * 5;
  sprite.oy = 32 - n * 5;
  if (sprite.ox > 32) destroy(sprite);
};

// Lua: anim_callbacks.lua:1451 -- noGfx helpers are handled as visual tasks, not sprites.
delete CB.HorizontalLunge;
delete CB.VerticalDip;
delete CB.SlideMonToOriginalPos;
delete CB.SlideMonToOffset;

CB._destroy = destroy;

// Lua: anim_callbacks.lua:1457 -- merge the anim_port groups.
// NOT FAITHFUL: the anim_port groups merge on first use (AnimCallbacks.get /
// _loadGroups), not at require time (ES module order: they register in G3Lazy
// after this module has evaluated).
let groupsLoaded = false;
function load_groups(): void {
  if (groupsLoaded) return;
  groupsLoaded = true;
  for (const group of ["g1", "g2", "g3", "g4"]) {
    let mod: any = G3Lazy["src.core.game3.battle.anim_port." + group + "_callbacks"];
    if (mod == null) continue; // Brian's "module not found" path (silent)
    try {
      if (typeof mod === "function") mod = mod(AnimCallbacks);
      if (mod != null && typeof mod === "object") {
        for (const [k, fn] of pairs(mod)) AnimCallbacks[k as string] = fn;
      }
    } catch (err) {
      console.log("[battle.anim] " + group + "_callbacks: " + tostring(err));
    }
  }
}
CB._loadGroups = load_groups;

// Lua: anim_callbacks.lua:1467
CB.get = function (name: unknown): ((s: S) => void) {
  load_groups();
  if (name == null || name === false) return AnimCallbacks.HitSplatBasic;
  const n = name as string;
  if (AnimCallbacks[n]) return AnimCallbacks[n];
  const clean = gsub(tostring(n), "^Anim", "")[0];
  if (AnimCallbacks[clean]) return AnimCallbacks[clean];
  if (AnimCallbacks["Anim" + clean]) return AnimCallbacks["Anim" + clean];
  return AnimCallbacks.SimpleFadeOut;
};

export default AnimCallbacks;
