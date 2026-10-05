// Port of gen1recomp src/core/game3/battle/anim_port/g4_templates.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered sprite templates for the g4 group: OAM anims and affine anims.
// Tables keyed [0] = ..., [1] = ... are plain JS arrays (keys 0..n); command
// lists are sequences (seq: slot 0 unused).

import { mod } from "../../../../../import/gen3/lua.ts";
import { ipairs, seq } from "../../../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const T: Record<string, any> = {};

// Lua: g4_templates.lua:4
function A(list: any): any { return list; }
void A;
const END = { e: true };
const AEND = { e: true };

// Lua: g4_templates.lua:8
function frames(...xs: any[]): any {
  const out: any = [null];
  for (const [i, f] of ipairs(seq(...xs))) out[i] = f;
  return out;
}
void frames;

// Lua: g4_templates.lua:14
function F(img: number, dur: number, h?: any, v?: any): any { return { f: img, d: dur, h: h, v: v }; }
// Lua: g4_templates.lua:15
function J(i: number): any { return { jump: i }; }
// Lua: g4_templates.lua:16
function L(n: number): any { return { loop: n }; }
// Lua: g4_templates.lua:17
function AF(xs: number, ys: number, r: number, d: number): any { return { xs: xs, ys: ys, r: r, d: mod(d, 256) }; }

const OFF = 0, NORMAL = 1, DOUBLE = 3;

// pokefirered/src/battle_anim_bug.c:20
const MEGAHORN_AFF = [
  seq(AF(0x100, 0x100, 30, 0), AEND),
  seq(AF(0x100, 0x100, -99, 0), AEND),
  seq(AF(0x100, 0x100, 94, 0), AEND),
];
// pokefirered/src/battle_anim_bug.c:56
const LEECH_AFF = [
  seq(AF(0, 0, -33, 1), AEND),
  seq(AF(0, 0, 96, 1), AEND),
  seq(AF(0, 0, -96, 1), AEND),
];
// pokefirered/src/battle_anim_bug.c:114
const SPIDER_WEB_AFF = [seq(AF(0x10, 0x10, 0, 0), AF(0x6, 0x6, 0, 1), J(1))];
// pokefirered/src/battle_anim_bug.c:170
const TAIL_GLOW_AFF = [seq(
  AF(0x10, 0x10, 0, 0), AF(0x8, 0x8, 0, 18), L(0), AF(-0x5, -0x5, 0, 8), AF(0x5, 0x5, 0, 8), L(5), AEND,
)];

T.gMegahornHornSpriteTemplate = { affineMode: DOUBLE, affine: MEGAHORN_AFF };
T.gLeechLifeNeedleSpriteTemplate = { affineMode: NORMAL, affine: LEECH_AFF };
T.gWebThreadSpriteTemplate = { affineMode: OFF };
T.gStringWrapSpriteTemplate = { affineMode: OFF };
T.gSpiderWebSpriteTemplate = { affineMode: DOUBLE, affine: SPIDER_WEB_AFF, objBlend: true };
T.gLinearStingerSpriteTemplate = { affineMode: NORMAL };
T.gPinMissileSpriteTemplate = { affineMode: NORMAL };
T.gIcicleSpearSpriteTemplate = { affineMode: NORMAL };
T.gTailGlowOrbSpriteTemplate = { affineMode: NORMAL, affine: TAIL_GLOW_AFF, objBlend: true };

// pokefirered/src/battle_anim_electric.c:37
const LIGHTNING_ANIMS = [seq(F(0, 5), F(16, 5), F(32, 8), F(48, 5), F(64, 5), END)];
const FLASHING_SPARK_AFF = [seq(AF(0, 0, 20, 1), J(0))];
const THUNDERBOLT_ORB_ANIMS = [seq(F(0, 6), F(16, 6), F(32, 6), J(0))];
const THUNDERBOLT_ORB_AFF = [seq(AF(0xE8, 0xE8, 0, 0), AF(-0x8, -0x8, 0, 10), AF(0x8, 0x8, 0, 10), J(1))];
const CHARGING_PARTICLE_ANIMS = [
  seq(F(3, 1), F(2, 1), F(1, 1), F(0, 1), END),
  seq(F(0, 5), F(1, 5), F(2, 5), F(3, 5), END),
];
// pokefirered/src/battle_anim_electric.c:294
const GROWING_ORB_AFF = [
  seq(AF(0x10, 0x10, 0, 0), AF(0x4, 0x4, 0, 60), AF(0x100, 0x100, 0, 0), L(0), AF(-0x4, -0x4, 0, 5), AF(0x4, 0x4, 0, 5), L(10), AEND),
  seq(AF(0x10, 0x10, 0, 0), AF(0x8, 0x8, 0, 30), AF(0x100, 0x100, 0, 0), AF(-0x4, -0x4, 0, 5), AF(0x4, 0x4, 0, 5), J(3)),
  seq(AF(0x10, 0x10, 0, 0), AF(0x8, 0x8, 0, 30), AF(-0x8, -0x8, 0, 30), AEND),
];
const ELECTRIC_PUFF_ANIMS = [seq(F(0, 3), F(16, 3), F(32, 3), F(48, 3), END)];
const VOLT_BOLT_ANIMS = [
  seq(F(0, 3), END), seq(F(2, 3), END), seq(F(4, 3), END), seq(F(6, 3), END),
];
const VOLT_BOLT_AFF = [seq(AF(0x100, 0x100, 64, 0), AEND)];

T.gLightningSpriteTemplate = { affineMode: OFF, anims: LIGHTNING_ANIMS };
T.gSparkElectricitySpriteTemplate = { affineMode: NORMAL };
T.gZapCannonSparkSpriteTemplate = { affineMode: NORMAL, affine: FLASHING_SPARK_AFF };
T.gThunderboltOrbSpriteTemplate = { affineMode: NORMAL, anims: THUNDERBOLT_ORB_ANIMS, affine: THUNDERBOLT_ORB_AFF };
T.gSparkElectricityFlashingSpriteTemplate = { affineMode: NORMAL, affine: FLASHING_SPARK_AFF };
T.gElectricitySpriteTemplate = { affineMode: OFF };
T.sElectricBoltSegmentSpriteTemplate = { affineMode: OFF, tag: "SPARK", w: 8, h: 8 };
T.gThunderWaveSpriteTemplate = { affineMode: OFF, tag: "SPARK_H", w: 32, h: 16 };
T.gElectricChargingParticlesSpriteTemplate = { affineMode: OFF, anims: CHARGING_PARTICLE_ANIMS, tag: "ELECTRIC_ORBS", w: 8, h: 8 };
T.gGrowingChargeOrbSpriteTemplate = { affineMode: NORMAL, affine: GROWING_ORB_AFF, objBlend: true };
T.gElectricPuffSpriteTemplate = { affineMode: OFF, anims: ELECTRIC_PUFF_ANIMS };
T.gVoltTackleOrbSlideSpriteTemplate = { affineMode: NORMAL, affine: GROWING_ORB_AFF, objBlend: true };
T.gVoltTackleBoltSpriteTemplate = { affineMode: DOUBLE, anims: VOLT_BOLT_ANIMS, affine: VOLT_BOLT_AFF, tag: "SPARK", w: 8, h: 16 };
T.gGrowingShockWaveOrbSpriteTemplate = { affineMode: NORMAL, affine: GROWING_ORB_AFF, objBlend: true };
T.sShockWaveProgressingBoltSpriteTemplate = { affineMode: OFF, tag: "SPARK", w: 8, h: 8 };

// pokefirered/src/battle_anim_ground.c:29
const BONEMERANG_AFF = [seq(AF(0, 0, 15, 1), J(0))];
const SPINNING_BONE_AFF = [seq(AF(0, 0, 20, 1), J(0))];
T.gBonemerangSpriteTemplate = { affineMode: NORMAL, affine: BONEMERANG_AFF };
T.gSpinningBoneSpriteTemplate = { affineMode: NORMAL, affine: SPINNING_BONE_AFF };
T.gSandAttackDirtSpriteTemplate = { affineMode: OFF };
T.gMudSlapMudSpriteTemplate = { affineMode: OFF, anims: [seq(F(1, 1), END)] };
T.gMudsportMudSpriteTemplate = { affineMode: OFF };
T.gDirtPlumeSpriteTemplate = { affineMode: OFF };
T.gDirtMoundSpriteTemplate = { affineMode: OFF };

// pokefirered/src/battle_anim_poison.c:40
const POISON_PROJECTILE_ANIMS = [
  seq(F(0, 1), END),
  seq(F(4, 1), END),
  seq(F(8, 1), END),
];
const POISON_PROJECTILE_AFF = [seq(AF(0x160, 0x160, 0, 0), AF(-0xA, -0xA, 0, 10), AF(0xA, 0xA, 0, 10), J(0))];
const SLUDGE_HIT_AFF = [seq(AF(0xEC, 0xEC, 0, 0), AEND)];
const DROPLET_AFF = [seq(AF(-0x10, 0x10, 0, 6), AF(0x10, -0x10, 0, 6), J(0))];
const BUBBLE_AFF = [seq(AF(0x9C, 0x9C, 0, 0), AF(0x5, 0x5, 0, 20), AEND)];
T.gSludgeProjectileSpriteTemplate = { affineMode: DOUBLE, anims: POISON_PROJECTILE_ANIMS, affine: POISON_PROJECTILE_AFF };
T.gAcidPoisonBubbleSpriteTemplate = { affineMode: DOUBLE, anims: POISON_PROJECTILE_ANIMS, affine: POISON_PROJECTILE_AFF };
T.gSludgeBombHitParticleSpriteTemplate = { affineMode: NORMAL, anims: [seq(F(8, 1), END)], affine: SLUDGE_HIT_AFF };
T.gAcidPoisonDropletSpriteTemplate = { affineMode: DOUBLE, anims: [seq(F(4, 1), END), seq(F(8, 1), END)], affine: DROPLET_AFF };
T.gPoisonBubbleSpriteTemplate = { affineMode: NORMAL, anims: POISON_PROJECTILE_ANIMS, affine: BUBBLE_AFF };
T.gWaterBubbleSpriteTemplate = { affineMode: NORMAL, anims: [seq(F(0, 1), END)], affine: BUBBLE_AFF, objBlend: true };

// pokefirered/src/battle_anim_ice.c:70
const ICE_LARGE = [seq(F(4, 1), END)];
const ICE_SMALL = [seq(F(6, 1), END)];
const SNOWBALL = [seq(F(7, 1), END)];
const BLIZZARD_CRYSTAL = [seq(F(8, 1), END)];
const ICE_SPIRAL_AFF = [seq(AF(0, 0, 40, 1), J(0))];
const ICE_BEAM_INNER_AFF = [seq(AF(0, 0, 10, 1), J(0))];
const ICE_HIT_AFF = [seq(AF(0xCE, 0xCE, 0, 0), AF(0x5, 0x5, 0, 10), AF(0, 0, 0, 6), AEND)];
const CLOUD_ANIMS = [seq(F(0, 8), F(8, 8), J(0))];
const ICE_BALL_ANIMS = [seq(F(0, 1), END), seq(F(16, 4), F(32, 4), F(48, 4), F(64, 4), END)];
const ICE_BALL_AFF = [
  seq(AF(0xE0, 0xE0, 0, 0), AEND),
  seq(AF(0x118, 0x118, 0, 0), AEND),
  seq(AF(0x150, 0x150, 0, 0), AEND),
  seq(AF(0x180, 0x180, 0, 0), AEND),
  seq(AF(0x1C0, 0x1C0, 0, 0), AEND),
];
const ICE_GROUND_SPIKE = [seq(F(0, 5), F(2, 5), F(4, 5), F(6, 5), F(4, 5), F(2, 5), F(0, 5), END)];
const HAIL_AFF = [
  seq(AF(0x100, 0x100, 0, 0), AEND),
  seq(AF(0xF0, 0xF0, 0, 0), AEND),
  seq(AF(0xE0, 0xE0, 0, 0), AEND),
];
T.gIceCrystalSpiralInwardLarge = { affineMode: DOUBLE, anims: ICE_LARGE, affine: ICE_SPIRAL_AFF, objBlend: true };
T.gIceCrystalSpiralInwardSmall = { affineMode: OFF, anims: ICE_SMALL, objBlend: true };
T.gIceBeamInnerCrystalSpriteTemplate = { affineMode: NORMAL, anims: ICE_LARGE, affine: ICE_BEAM_INNER_AFF, objBlend: true };
T.gIceBeamOuterCrystalSpriteTemplate = { affineMode: OFF, anims: ICE_SMALL, objBlend: true };
T.gIceCrystalHitLargeSpriteTemplate = { affineMode: NORMAL, anims: ICE_LARGE, affine: ICE_HIT_AFF, objBlend: true, tag: "ICE_CRYSTALS", w: 8, h: 16 };
T.gIceCrystalHitSmallSpriteTemplate = { affineMode: NORMAL, anims: ICE_SMALL, affine: ICE_HIT_AFF, objBlend: true };
T.gSwirlingSnowballSpriteTemplate = { affineMode: OFF, anims: SNOWBALL };
T.gBlizzardIceCrystalSpriteTemplate = { affineMode: OFF, anims: BLIZZARD_CRYSTAL };
T.gPowderSnowSnowballSpriteTemplate = { affineMode: OFF, anims: SNOWBALL };
T.gIceGroundSpikeSpriteTemplate = { affineMode: OFF, anims: ICE_GROUND_SPIKE, objBlend: true };
T.gMistCloudSpriteTemplate = { affineMode: OFF, anims: CLOUD_ANIMS, objBlend: true };
T.gSmogCloudSpriteTemplate = { affineMode: OFF, anims: CLOUD_ANIMS, objBlend: true };
T.gMistBallSpriteTemplate = { affineMode: OFF };
T.gPoisonGasCloudSpriteTemplate = { affineMode: OFF, anims: CLOUD_ANIMS, objBlend: true };
T.sHailParticleSpriteTemplate = { affineMode: NORMAL, affine: HAIL_AFF, tag: "HAIL", w: 16, h: 16 };
T.gIceBallChunkSpriteTemplate = { affineMode: DOUBLE, anims: ICE_BALL_ANIMS, affine: ICE_BALL_AFF };
T.gIceBallImpactShardSpriteTemplate = { affineMode: OFF, anims: ICE_SMALL };

// pokefirered/src/battle_anim_rock.c:27
const FLYING_ROCK = [seq(F(32, 1), END), seq(F(48, 1), END), seq(F(64, 1), END)];
const BASIC_ROCK = [
  seq(F(0, 1), END), seq(F(16, 1), END), seq(F(32, 1), END),
  seq(F(48, 1), END), seq(F(64, 1), END), seq(F(80, 1), END),
];
const BASIC_ROCK_AFF = [seq(AF(0, 0, -5, 5), J(0)), seq(AF(0, 0, 5, 5), J(0))];
const WATER_MUD_ORB = [seq(F(0, 1), F(4, 1), F(8, 1), F(12, 1), J(0))];
const WHIRLPOOL_AFF = [seq(AF(0xC0, 0xC0, 0, 0), AF(0x2, -0x3, 0, 5), AF(-0x2, 0x3, 0, 5), J(1))];
const BASIC_FIRE = [seq(F(16, 4), F(32, 4), F(48, 4), F(64, 4), J(0))];
T.gFallingRockSpriteTemplate = { affineMode: OFF, anims: FLYING_ROCK };
T.gRockFragmentSpriteTemplate = { affineMode: OFF, anims: FLYING_ROCK };
T.gSwirlingDirtSpriteTemplate = { affineMode: OFF };
T.gWhirlpoolSpriteTemplate = { affineMode: NORMAL, anims: WATER_MUD_ORB, affine: WHIRLPOOL_AFF, objBlend: true };
T.gFireSpinSpriteTemplate = { affineMode: OFF, anims: BASIC_FIRE };
T.gFlyingSandCrescentSpriteTemplate = { affineMode: OFF, priority: 1 };
T.gAncientPowerRockSpriteTemplate = { affineMode: OFF, anims: BASIC_ROCK };
T.gRolloutMudSpriteTemplate = { affineMode: OFF, tag: "MUD_SAND", w: 8, h: 8 };
T.gRolloutRockSpriteTemplate = { affineMode: OFF, tag: "ROCKS", w: 32, h: 32 };
T.gRockTombRockSpriteTemplate = { affineMode: OFF, anims: BASIC_ROCK };
T.gRockBlastRockSpriteTemplate = { affineMode: NORMAL, anims: BASIC_ROCK, affine: BASIC_ROCK_AFF };
T.gRockScatterSpriteTemplate = { affineMode: NORMAL, anims: BASIC_ROCK, affine: BASIC_ROCK_AFF };
T.gSafariRockTemplate = { affineMode: OFF, anims: [seq(F(64, 1), END)] };
T.gSafariBaitSpriteTemplate = { affineMode: OFF };

// pokefirered/src/battle_anim_water.c:59
const RAIN_DROP = [seq(F(0, 2), F(8, 2), F(16, 2), F(24, 6), F(32, 2), F(40, 2), F(48, 2), END)];
const BUBBLE_PROJ_ANIMS = [seq(F(0, 1), F(4, 5), F(8, 5), END)];
const BUBBLE_PROJ_AFF = [seq(AF(-0x5, -0x5, 0, 10), AF(0x5, 0x5, 0, 10), J(0))];
const AURORA_RING_ANIMS = [seq(F(0, 1), END), seq(F(4, 1), END)];
const AURORA_RING_AFF = [seq(AF(0, 0, 0, 1), AF(0x60, 0x60, 0, 1), AEND)];
const FLAMETHROWER = [seq(F(16, 2), F(32, 2), F(48, 2), J(0))];
// pokefirered/src/battle_anim_effects_2.c:275
const GROWING_RING_AFF = [seq(AF(32, 32, 0, 0), AF(7, 7, 0, -56), AEND)];
const HYDRO_CHARGE_AFF = [seq(AF(0x3, 0x3, 10, 50), AF(0, 0, 0, 10), AF(-0x14, -0x14, -10, 20), AEND)];
const HYDRO_BEAM_AFF = [seq(AF(0x150, 0x150, 0, 0), AEND)];
const WATER_PULSE_BUBBLE = [seq(F(8, 1), END), seq(F(9, 1), END)];
const WATER_PULSE_RING_BUBBLE_AFF = [
  seq(AF(0x100, 0x100, 0, 0), AF(-0xA, -0xA, 0, 15), AEND),
  seq(AF(0xE0, 0xE0, 0, 0), AF(-0x8, -0x8, 0, 15), AEND),
];
// pokefirered/src/battle_anim_effects_2.c:282
const WATER_PULSE_RING_AFF = [seq(
  AF(5, 5, 0, 10), AF(-10, -10, 0, 10), AF(10, 10, 0, 10), AF(-10, -10, 0, 10),
  AF(10, 10, 0, 10), AF(-10, -10, 0, 10), AF(10, 10, 0, 10), AEND,
)];
T.gRainDropSpriteTemplate = { affineMode: OFF, anims: RAIN_DROP, tag: "RAIN_DROPS", w: 16, h: 32 };
T.gWaterBubbleProjectileSpriteTemplate = { affineMode: NORMAL, anims: BUBBLE_PROJ_ANIMS, affine: BUBBLE_PROJ_AFF, objBlend: true };
T.gAuroraBeamRingSpriteTemplate = { affineMode: DOUBLE, anims: AURORA_RING_ANIMS, affine: AURORA_RING_AFF };
T.gHydroPumpOrbSpriteTemplate = { affineMode: OFF, anims: WATER_MUD_ORB, objBlend: true };
T.gMudShotOrbSpriteTemplate = { affineMode: OFF, anims: WATER_MUD_ORB, objBlend: true };
T.gSignalBeamRedOrbSpriteTemplate = { affineMode: OFF };
T.gSignalBeamGreenOrbSpriteTemplate = { affineMode: OFF };
T.gFlamethrowerFlameSpriteTemplate = { affineMode: OFF, anims: FLAMETHROWER };
T.gPsywaveRingSpriteTemplate = { affineMode: DOUBLE, affine: GROWING_RING_AFF };
T.gHydroCannonChargeSpriteTemplate = { affineMode: DOUBLE, anims: WATER_MUD_ORB, affine: HYDRO_CHARGE_AFF, objBlend: true };
T.gHydroCannonBeamSpriteTemplate = { affineMode: DOUBLE, anims: WATER_MUD_ORB, affine: HYDRO_BEAM_AFF, objBlend: true };
T.gWaterGunDropletSpriteTemplate = { affineMode: DOUBLE, anims: [seq(F(4, 1), END)], affine: DROPLET_AFF, objBlend: true };
T.gSmallBubblePairSpriteTemplate = { affineMode: OFF, anims: [seq(F(12, 6), F(13, 6), J(0))] };
T.gSmallDriftingBubblesSpriteTemplate = { affineMode: OFF };
T.gWaterPulseBubbleSpriteTemplate = { affineMode: OFF, anims: WATER_PULSE_BUBBLE };
T.gWaterPulseRingBubbleSpriteTemplate = { affineMode: NORMAL, anims: WATER_PULSE_BUBBLE, affine: WATER_PULSE_RING_BUBBLE_AFF, tag: "SMALL_BUBBLES", w: 8, h: 8 };
T.gWaterPulseRingSpriteTemplate = { affineMode: DOUBLE, affine: WATER_PULSE_RING_AFF };

T.gSmallWaterOrbSpriteTemplate = { affineMode: OFF, tag: "GLOWY_BLUE_ORB", w: 8, h: 8 };
// pokefirered/src/battle_anim_normal.c:133
T.gWaterHitSplatSpriteTemplate = {
  affineMode: NORMAL, objBlend: true, tag: "WATER_IMPACT", w: 32, h: 32, affine: [
    seq(AF(0, 0, 0, 8), AEND),
    seq(AF(0xD8, 0xD8, 0, 0), AF(0, 0, 0, 8), AEND),
    seq(AF(0xB0, 0xB0, 0, 0), AF(0, 0, 0, 8), AEND),
    seq(AF(0x80, 0x80, 0, 0), AF(0, 0, 0, 8), AEND),
  ],
};

T.EMPTY = { affineMode: OFF };

export default T;
