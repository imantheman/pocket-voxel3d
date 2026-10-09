// Port tooling: pixel checks on a battle frame (240x160 RGBA): the player's
// health box EXP bar is drawn (its dark top line -- the bar tiles' row 1,
// 0x213a00 -- along all 64 px once the box stands at rest). Used by
// tools/gen3/load_shots.ts on every desktop frame and by
// tools/gen3/battle_ppm_check.ts on the device's own 2D-layer shots
// (g3shot_N.ppm). Isaac's report: the EXP bar showed the box's cream
// (healthbox.ts took Anim.displayExpRatio's whole [ratio, level] for the
// ratio, so no bar tile was drawn). Never shipped.

/** The box at rest: healthbox.ts PLAYER_CENTER (158, 88) less (32, 16). */
const BOX_X = 126, BOX_Y = 72;
/** The EXP bar: (tlX + 32, tlY + 32), 8 tiles of 8 px; its row 1 is the dark line. */
const EXP_X = BOX_X + 32, EXP_Y = BOX_Y + 33, EXP_W = 64;
const DARK = [0x21, 0x3a, 0x00];
/** The box's top outline row at rest. */
const TOP_Y = 75;

function near(px: Uint8Array, o: number, c: number[], tol = 10): boolean {
  return Math.abs(px[o]! - c[0]!) <= tol && Math.abs(px[o + 1]! - c[1]!) <= tol && Math.abs(px[o + 2]! - c[2]!) <= tol;
}

/**
 * Null when the player's box is not at rest in this frame (its top outline,
 * row 75 from x 140, dark for 84 px), else the problems found. (`box`, the
 * box picture, is not needed; kept for callers.)
 */
export function checkBattlePixels(px: Uint8Array, _box?: Uint8Array): { problems: string[]; summary: string } | null {
  let top = 0;
  for (let x = 136; x < 236; x++) if (near(px, (TOP_Y * 240 + x) * 4, DARK, 2)) top++;
  if (top < 80) return null;
  const problems: string[] = [];
  let dark = 0;
  for (let x = 0; x < EXP_W; x++) if (near(px, ((EXP_Y * 240) + EXP_X + x) * 4, DARK)) dark++;
  if (dark < EXP_W) problems.push(`EXP bar's top line drawn on ${dark} of ${EXP_W} px`);
  return { problems, summary: `box at rest; EXP line ${dark}/${EXP_W}` };
}
