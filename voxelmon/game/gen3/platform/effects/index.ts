// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). Every effect, registered in this (fixed) order: the ids
// the draw list carries come from it, so the 3DS host's table follows it too.

import "./affine_color.ts";
import "./anim_pal.ts";
import "./blend5.ts";
import "./blend5_pre.ts";
import "./g1_remap.ts";
import "./gba_fx.ts";
import "./gray5.ts";
import "./gray5_pre.ts";
import "./gray_luma.ts";
import "./level_flash.ts";
import "./mask_overlay.ts";
import "./mask_write.ts";
import "./mix_target.ts";
import "./mosaic.ts";
import "./palrot.ts";
import "./region_map.ts";
import "./remap_nearest.ts";
import "./screen_fx.ts";
import "./silhouette.ts";
import "./solid_mask.ts";
import "./stat_mask.ts";
import "./tint_alpha.ts";

export const EFFECT_NAMES = ["affine_color", "anim_pal", "blend5", "blend5_pre", "g1_remap", "gba_fx", "gray5", "gray5_pre", "gray_luma", "level_flash", "mask_overlay", "mask_write", "mix_target", "mosaic", "palrot", "region_map", "remap_nearest", "screen_fx", "silhouette", "solid_mask", "stat_mask", "tint_alpha"];
