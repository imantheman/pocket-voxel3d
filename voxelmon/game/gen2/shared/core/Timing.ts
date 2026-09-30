// gen1recomp src/core/Timing.lua (bdfac727): frame counts from the ROM's
// delays, shared by text, fades, battles and menus.

export const Timing = {
  DELAY3: 3,
  FADE_IN_FROM_BLACK: 32, // fade.asm:21, b = 4
  FADE_OUT_TO_BLACK: 32, // fade.asm:43, b = 4
  FADE_OUT_TO_WHITE: 24, // fade.asm:26, b = 3
  FADE_IN_FROM_WHITE: 24, // fade.asm:48, b = 3
  WARP_FADE_OUT: 32,
  WARP_FADE_IN: 0,
  POST_BATTLE_RETURN: 10,
  SPECIAL_WARP_ENTRY: 3 + 24,
  DUNGEON_WARP_ARRIVAL: 50,
  TEXT_SCROLL_LINE: 5,
  TEXT_SCROLL_PAIR: 10,
  TEXT_PRE_ADVANCE: 3,
  TEXT_PAGE_CLEAR: 20,
  TEXT_CONT: 3 + 10,
  TEXT_PARAGRAPH: 3 + 20,
  TEXT_PAGE: 3 + 20,
  TEXT_PAUSE: 30, // home/text.asm:500 TextCommand_PAUSE
  TEXT_DOT: 10, // home/text.asm:576 TextCommand_DOTS, per dot
  YES_NO_ANSWER: 15,
  LIST_MENU_OPEN: 10, // home/list_menu.asm:55-56
  LIST_MENU_REDRAW: 3, // home/list_menu.asm:64
  FIELD_TELEPORT: 60 + 3,
  BATTLE_SLIDE_IN_FRAMES: 72,
  BATTLE_SLIDE_PX_PER_FRAME: 2,
  TRAINER_INTRO_SFX_GAP: 20,
  BATTLE_START_SENDOUT: 40, // engine/battle/core.asm:155-156
  MOVE_ANIM_PRE: 3, // core.asm:6638 PlayMoveAnimation
  MOVE_ANIM_OFF: 30,
  MOVE_STATUS_OR_MISS: 30,
  SUBSTITUTE_ENTRY: 50,
  SHAKE_VERTICAL: 48,
  SHAKE_HORIZ_HEAVY: 72,
  SHAKE_HORIZ_SLOW: 48,
  SHAKE_HORIZ_LIGHT: 18,
  SHAKE_HORIZ_SLOW2: 24,
  BLINK_MON: 60,
  FAINT_SLIDE: 14,
  RESIDUAL_TICK: 20, // core.asm:529-530
  CRIT_OHKO_TEXT: 20, // core.asm:3813-3814
  SWITCH_PLAYER_MON: 50, // core.asm:2421-2422
  NO_MOVES_LEFT: 60, // core.asm:2753-2754
  TRAINER_VICTORY: 40, // core.asm:940-941
  PLAYER_BLACKOUT: 40, // core.asm:1143-1144
  FAINT_SLIDE_ROW: 2, // core.asm:1216-1217
  FAINT_SLIDE_STEP: 8 / 2,
  TRAINER_SLIDE_COL: 2, // core.asm:1267-1268
  HP_BAR_PIXELS: 48,
  HP_BAR_PIXEL_STEP: 2,
  HP_BAR_HP_STEP: 1,

  hpBarPixels(hp: number, maxHP: number): number {
    if (!maxHP || maxHP <= 0) return 0;
    if (hp <= 0) return 0;
    return Math.max(1, Math.floor((hp * Timing.HP_BAR_PIXELS) / maxHP));
  },
  hpDrainStepFrames(fromHP: number, toHP: number, maxHP: number, playerSide?: boolean): number {
    const pixels = Math.abs(Timing.hpBarPixels(toHP, maxHP) - Timing.hpBarPixels(fromHP, maxHP));
    return pixels * Timing.HP_BAR_PIXEL_STEP + (playerSide ? Timing.HP_BAR_HP_STEP : 0);
  },
  hpDrainClosingFrames(playerSide?: boolean): number {
    return Timing.HP_BAR_PIXEL_STEP + Timing.DELAY3 + (playerSide ? Timing.HP_BAR_HP_STEP : 0);
  },
  hpDrainFrames(fromHP: number, toHP: number, maxHP: number, playerSide?: boolean): number {
    let total = 0;
    let hp = fromHP;
    const dir = toHP < fromHP ? -1 : 1;
    while (hp !== toHP) {
      total += Timing.hpDrainStepFrames(hp, hp + dir, maxHP, playerSide);
      hp += dir;
    }
    return total + Timing.hpDrainClosingFrames(playerSide);
  },
};

export default Timing;
