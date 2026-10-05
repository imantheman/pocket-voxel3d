// Port of gen1recomp src/core/game3/battle/anim_templates.lua (GPLv3 + additional terms; see LICENSE.md).
// pret SpriteTemplate → tag + Lua callback id (named, no ROM pointers).
// Used by extract (tag rewrite) and runtime createsprite.

import { tostring } from "../../../../import/gen3/lua.ts";
import { gsub } from "../../platform/lpattern.ts";

export interface AnimTemplateInfo {
  tag: string | null;
  callback: string;
  w: number;
  h: number;
  noGfx: boolean | undefined;
  anchor: string | undefined;
}

// Lua: anim_templates.lua:7 -- Default sizes match common OAM shapes in battle_anim_*.c
function T(tag: string | null, cb: string, w?: number, h?: number, opts?: { noGfx?: boolean; anchor?: string }): AnimTemplateInfo {
  opts = opts || {};
  return {
    tag,
    callback: cb,
    w: w ?? 32,
    h: h ?? 32,
    noGfx: opts.noGfx,
    anchor: opts.anchor, // "attacker"|"target"|nil (infer from args)
  };
}

// Lua: anim_templates.lua:20 -- Keyed by full pret symbol and short name
const MAP: Record<string, AnimTemplateInfo> = {
  // Invisible helpers (move battler via task)
  gHorizontalLungeSpriteTemplate: T(null, "HorizontalLunge", 0, 0, { noGfx: true }),
  gVerticalDipSpriteTemplate: T(null, "VerticalDip", 0, 0, { noGfx: true }),
  gSlideMonToOffsetSpriteTemplate: T(null, "SlideMonToOffset", 0, 0, { noGfx: true }),
  gSlideMonToOriginalPosSpriteTemplate: T(null, "SlideMonToOriginalPos", 0, 0, { noGfx: true }),

  // IMPACT family
  gBasicHitSplatSpriteTemplate: T("IMPACT", "HitSplatBasic", 32, 32, { anchor: "fromArgs" }),
  gHandleInvertHitSplatSpriteTemplate: T("IMPACT", "HitSplatBasic", 32, 32, { anchor: "fromArgs" }),
  gRandomPosHitSplatSpriteTemplate: T("IMPACT", "HitSplatBasic", 32, 32, { anchor: "target" }),
  gMonEdgeHitSplatSpriteTemplate: T("IMPACT", "HitSplatBasic", 32, 32, { anchor: "target" }),
  gWaterHitSplatSpriteTemplate: T("WATER_IMPACT", "HitSplatBasic", 32, 32, { anchor: "fromArgs" }),
  gCrossImpactSpriteTemplate: T("CROSS_IMPACT", "HitSplatBasic", 32, 32),

  // Growl / Roar
  gRoarNoiseLineSpriteTemplate: T("NOISE_LINE", "RoarNoiseLine", 32, 32, { anchor: "attacker" }),

  // Fire family (pokefirered/src/battle_anim_fire.c)
  gEmberSpriteTemplate: T("SMALL_EMBER", "TranslateAnimSpriteToTargetMonLocation", 32, 32, { anchor: "attacker" }),
  gEmberFlareSpriteTemplate: T("SMALL_EMBER", "AnimEmberFlare", 32, 32, { anchor: "target" }),
  gBurnFlameSpriteTemplate: T("SMALL_EMBER", "AnimBurnFlame", 32, 32, { anchor: "target" }),
  gFireSpiralInwardSpriteTemplate: T("SMALL_EMBER", "AnimFireSpiralInward", 32, 32, { anchor: "target" }),
  gFireSpreadSpriteTemplate: T("SMALL_EMBER", "AnimFireSpread", 32, 32, { anchor: "target" }),
  gLargeFlameSpriteTemplate: T("FIRE", "AnimLargeFlame", 32, 32, { anchor: "attacker" }),
  gLargeFlameScatterSpriteTemplate: T("FIRE", "AnimLargeFlame", 32, 32, { anchor: "attacker" }),
  gFirePlumeSpriteTemplate: T("FIRE_PLUME", "AnimFirePlume", 32, 32, { anchor: "attacker" }),
  gSunlightRaySpriteTemplate: T("SUNLIGHT", "AnimSunlight", 32, 32, { anchor: "target" }),
  gFireBlastRingSpriteTemplate: T("SMALL_EMBER", "AnimFireRing", 32, 32, { anchor: "attacker" }),
  gFireBlastCrossSpriteTemplate: T("SMALL_EMBER", "AnimFireCross", 32, 32, { anchor: "target" }),
  gFireSpiralOutwardSpriteTemplate: T("SMALL_EMBER", "AnimFireSpiralOutward", 32, 32, { anchor: "attacker" }),
  gWeatherBallFireDownSpriteTemplate: T("SMALL_EMBER", "AnimWeatherBallDown", 32, 32, { anchor: "target" }),
  gEruptionLaunchRockSpriteTemplate: T("WARM_ROCK", "AnimEruptionLaunchRock", 32, 32, { anchor: "attacker" }),
  gEruptionFallingRockSpriteTemplate: T("WARM_ROCK", "AnimEruptionFallingRock", 32, 32, { anchor: "target" }),
  gWillOWispOrbSpriteTemplate: T("WISP_ORB", "AnimWillOWispOrb", 32, 32, { anchor: "attacker" }),
  gWillOWispFireSpriteTemplate: T("WISP_FIRE", "AnimWillOWispFire", 32, 32, { anchor: "target" }),

  // Common
  gLeerSpriteTemplate: T("LEER", "SimpleFadeOut", 32, 32, { anchor: "attacker" }),
  gMusicNotesSpriteTemplate: T("MUSIC_NOTES", "SimpleFadeOut", 16, 16),
  gConfusionDuckSpriteTemplate: T("DUCK", "SimpleFadeOut", 32, 32),
};

// Lua: anim_templates.lua:64 -- Alias without leading g.
// (Brian aliases at require time; here on first use, so module scope never
// calls an import -- the gen3 modules form one import cycle.)
let aliased = false;
function ensure_aliases(): void {
  if (aliased) return;
  aliased = true;
  for (const k of Object.keys(MAP)) {
    const v = MAP[k]!;
    const short = gsub(k, "^g", "")[0];
    if (!MAP[short]) MAP[short] = v;
  }
}

const stripG = (s: string): string => gsub(s, "^g", "")[0];
const stripTag = (s: string): string => gsub(s.toUpperCase(), "^ANIM_TAG_", "")[0];

export const AnimTemplates: Record<string, any> = {
  // Lua: anim_templates.lua:69
  get(nameIn: unknown): AnimTemplateInfo | null {
    if (nameIn == null || nameIn === false) return null;
    ensure_aliases();
    const name = tostring(nameIn);
    return MAP[name] ?? MAP[stripG(name)] ?? MAP["g" + name] ?? null;
  },

  // Lua: anim_templates.lua:76 -- Infer ANIM_TAG file stem from tag id (IMPACT → impact, NOISE_LINE → noise_line).
  tagToFileStem(tag: unknown): string {
    return stripTag(tostring(tag ?? "")).toLowerCase();
  },

  // Lua: anim_templates.lua:81
  tagFromLoadOrTemplate(loadTag: unknown, templateName: unknown): string {
    const t = AnimTemplates.get(templateName);
    if (t && t.tag != null) return t.tag;
    if (loadTag != null && loadTag !== false && loadTag !== "") return stripTag(tostring(loadTag));
    return "IMPACT";
  },

  get MAP() { ensure_aliases(); return MAP; },
};

export default AnimTemplates;
