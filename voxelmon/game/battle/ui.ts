// The classic 160x144 battle screen as a retained tile-layer program:
// gen1recomp src/battle/BattleState.lua drawClassic (:5631) / drawHUDs
// (:5368) / drawTextArea (:5497) re-expressed as voxel ui ops (uiTile /
// uiFill / uiText / uiReveal), delta-emitted against what the core retains.
// A layout-mode change repaints from a uiClear (menu opens burst a few
// hundred ops once — docs/VOXEL.md §3); within a mode only the moving parts
// (bar cells, digits, reveal counter, cursors, the blinking ▼) cross.
//
// HUD tile codes are the GB battle overlay's OWN codes (src/render/
// HudTiles.lua + pokered's charmap space $62-$7F): in battle the HP-bar and
// HUD-line sheets overlay the font_extra page (font_battle_extra -> $62,
// battle_hud_1 -> $6D, battle_hud_2 -> $73, battle_hud_3 -> $76 —
// HudTiles.lua:20-29), so uiTile ids stay the GB VRAM convention
// (SCHEMA.md) and the cooker must satisfy this mapping for the battle
// overlay exactly as it does for the borders.

import type { VoxelHost } from "../host.ts";
import {
  ARROW_CURSOR,
  ARROW_HOLLOW,
  ARROW_MORE,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  MAX_COLS,
  SPACE,
  encodeGlyphs,
  toCells,
} from "../ui/tiles.ts";
import { HP_BAR_PIXELS, hpBarPixels } from "../rules/timing.ts";
import type { WildBattle } from "./battle.ts";
import type { WildBattler } from "./battler.ts";

// ---------------------------------------------------------------------------
// The battle overlay's tile codes (HudTiles.lua drawHPBar :144-174,
// capTile :119-121; BattleState.lua drawHUDs hudTile sites :5401-5493).
// ---------------------------------------------------------------------------

/**
 * The cells each HUD panel covers: the enemy's name/level/bar/underline in
 * the top-left block, the player's in the bottom-right one. Declared to the
 * core (uiPanel) so it can slide the whole block sideways when a sprite
 * would end up under it.
 */
const ENEMY_HUD_W = 10;
const ENEMY_HUD_H = 4;
const PLAYER_HUD_W = 10;
const PLAYER_HUD_H = 5;

export const HUD_HP_LABEL = 0x71; // "HP" pair-glyph (drawHPBar :147)
export const HUD_BAR_LEFT = 0x62; // ":[" bar opener (:148)
export const HUD_BAR_EMPTY = 0x63; // +n = n-pixel partial fill (:171)
export const HUD_BAR_FULL = 0x6b; // full 8px segment (:171)
export const HUD_CAP_NUB = 0x6c; // enemy/party right cap (capTile)
export const HUD_CAP_DOUBLE = 0x6d; // player's in-battle right cap (type 1)
export const HUD_LV = 0x6e; // <LV> glyph (drawHUDs :5401)
export const HUD_TICK = 0x73; // vertical tick (PlaceEnemyHUDTiles $73)
export const HUD_EDGE_L = 0x74; // enemy underline left ($74)
export const HUD_LINE = 0x76; // underline run ($76)
export const HUD_EDGE_DOWN = 0x77; // player underline right ($77)
export const HUD_EDGE_R = 0x78; // enemy underline right ($78)
export const HUD_HALF_ARROW = 0x6f; // player underline left ($6F)
export const GLYPH_PK = 0xe1; // <PK> (charmap.asm $E1)
export const GLYPH_MN = 0xe2; // <MN> ($E2)

/** HP bar segments (the bar is 6 tiles = 48 px, HP_BAR_PIXELS). */
export const HP_BAR_SEGMENTS = HP_BAR_PIXELS / 8;

/**
 * The 9 tile codes of one HP bar row: "HP" + ":[" + six segment tiles +
 * the barType cap (HudTiles.drawHPBar; pixel math = Timing.hpBarPixels —
 * a nonzero HP always shows at least a one-pixel sliver).
 */
export function hpBarTiles(hp: number, maxHP: number, playerSide: boolean): number[] {
  const px = hpBarPixels(hp, maxHP);
  const out = [HUD_HP_LABEL, HUD_BAR_LEFT];
  for (let i = 0; i < HP_BAR_SEGMENTS; i++) {
    const seg = Math.min(8, Math.max(0, px - i * 8));
    out.push(seg >= 8 ? HUD_BAR_FULL : HUD_BAR_EMPTY + seg);
  }
  out.push(playerSide ? HUD_CAP_DOUBLE : HUD_CAP_NUB);
  return out;
}

/** CenterMonName (:4677-4683): 1-2 glyph names sit two tiles right, 3-4 one. */
export function nameTileX(tx: number, name: string): number {
  const n = encodeGlyphs(name).length;
  return tx + (n <= 2 ? 2 : n <= 4 ? 1 : 0);
}

// battle message rows: hlcoord *,14 / *,16 (drawTextArea :5515), col 1
const MSG_X = 1;
const MSG_ROWS = [14, 16] as const;
// the blinking ▼ cell — home/text.asm PromptText writes (18,16)
const ARROW_X = 18;
const ARROW_Y = 16;

interface MsgRowCache {
  text: string;
  revealed: number;
  /** true once the row was stamped into the grid (it stopped being live). */
  stamped: boolean;
}

export class BattleUi {
  private mode: string | null = null;
  private msgRows: MsgRowCache[] = [];
  private msgVisible = false;
  private arrowShown = false;
  private enemyBar: number[] | null = null;
  private playerBar: number[] | null = null;
  private playerDigits: string | null = null;
  private enemyLevel: string | null = null;
  private playerLevel: string | null = null;
  private cursorCell: [number, number] | null = null;
  private swapCell: [number, number] | null = null;
  private chromeTextDirty = false;

  /** Full repaint + delta emit for this tick. Call once per tick while the
   * battle is the visible screen. */
  emit(host: VoxelHost, battle: WildBattle): void {
    const enemyHud = this.enemyHudVisible(battle);
    const playerHud = this.playerHudVisible(battle);
    const mode = [
      battle.phase,
      enemyHud ? 1 : 0,
      playerHud ? 1 : 0,
      battle.statBoxMon ? 1 : 0,
      battle.phase === "party" ? battle.save.party.length : 0,
      battle.phase === "item" ? battle.itemList.length : 0,
    ].join("|");
    this.chromeTextDirty = false;
    if (mode !== this.mode) {
      this.mode = mode;
      this.repaint(host, battle, enemyHud, playerHud);
    } else {
      this.deltas(host, battle, enemyHud, playerHud);
    }
    this.emitMessage(host, battle);
  }

  /** Reset so the next emit repaints from scratch (battle start/end). */
  reset(): void {
    this.mode = null;
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;
  }

  // -----------------------------------------------------------------
  // visibility windows (drawHUDs :5386-5390, :5472-5474)
  // -----------------------------------------------------------------

  private enemyHudVisible(battle: WildBattle): boolean {
    // wild intro: DrawEnemyHUDAndHPBar runs only after the intro text is
    // dismissed (#317); the HUD clears again when the mon faints
    return !!battle.enemy && !battle.introBalls && !battle.enemy.fainted;
  }

  private playerHudVisible(battle: WildBattle): boolean {
    return !!battle.player && !battle.showPlayerBack && !battle.sendingOut;
  }

  // -----------------------------------------------------------------
  // chrome painters
  // -----------------------------------------------------------------

  /** Font.drawBox as tiles (the DEFAULT_BORDER family, ui/tiles.ts). */
  private box(host: VoxelHost, x: number, y: number, w: number, h: number): void {
    host.uiTile(x, y, BORDER_TL);
    host.uiFill(x + 1, y, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y, BORDER_TR);
    host.uiFill(x, y + 1, 1, h - 2, BORDER_V);
    host.uiFill(x + w - 1, y + 1, 1, h - 2, BORDER_V);
    host.uiTile(x, y + h - 1, BORDER_BL);
    host.uiFill(x + 1, y + h - 1, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y + h - 1, BORDER_BR);
    host.uiFill(x + 1, y + 1, w - 2, h - 2, SPACE);
  }

  private text(host: VoxelHost, x: number, y: number, s: string): void {
    // Static chrome goes into the tile grid glyph-by-glyph: uiText is the
    // ONE live typewriter run (the core retains only the last, gated by
    // uiReveal), so labels routed through it vanish when the next message
    // arrives — glyph codes ARE ui tile ids under the GB convention.
    const glyphs = encodeGlyphs(s);
    for (let i = 0; i < glyphs.length; i++) host.uiTile(x + i, y, glyphs[i]);
    this.chromeTextDirty = true;
  }

  private repaint(host: VoxelHost, battle: WildBattle, enemyHud: boolean, playerHud: boolean): void {
    host.uiClear();
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;

    // The battle message box now lives on the Kanto Gear bottom screen
    // (kantogear.ts drawBattleMessage); the top screen keeps only the HUDs and
    // the level-up stat window so the scene fills the space the box used to take.

    // The two HUD rects, so the core can slide them clear of the sprites
    // (voxel-spec uiPanel). They go out AFTER uiClear, which drops them.
    //
    // The level-up stat window overlaps both rects; while it is up nothing
    // slides, so the window and the HUD under it stay lined up with each
    // other the way the GB drew them.
    const slide = !battle.statBoxMon;
    host.uiPanel(1, 0, 0, enemyHud && slide ? ENEMY_HUD_W : 0, ENEMY_HUD_H);
    host.uiPanel(0, 10, 7, playerHud && slide ? PLAYER_HUD_W : 0, PLAYER_HUD_H);

    if (enemyHud) this.paintEnemyHud(host, battle);
    // The player HUD stays up in every phase now — the move box that used to
    // cover it (moveSelect) is gone; the action/move/party/item menus live on
    // the Kanto Gear bottom screen, so the top screen keeps only the HUDs, the
    // message box and the stat window. Text-box choice prompts (choiceOpen)
    // still draw below in deltas().
    if (playerHud) this.paintPlayerHud(host, battle);

    // the level-up stat window (PrintStatsBox: box (9,2) 11x10, :400-431)
    if (battle.statBoxMon) {
      this.box(host, 9, 2, 11, 10);
      const s = battle.statBoxMon.stats;
      const rows: [string, number][] = [
        ["ATTACK", s.attack],
        ["DEFENSE", s.defense],
        ["SPEED", s.speed],
        ["SPECIAL", s.special],
      ];
      rows.forEach(([label, v], i) => {
        this.text(host, 11, 3 + i * 2, label);
        this.text(host, 16, 4 + i * 2, String(v).padStart(3));
      });
    }

    // YES/NO (sayChoice) now draws on the Kanto Gear bottom screen, over the
    // battle dialog it belongs to (kantogear.ts drawBattleMessage) — see
    // that file for the ChoiceBox.lua-ported box/cursor placement.
  }

  /** DrawEnemyHUDAndHPBar (:5391-5413): name row 0, <LV>/status row 1, tick
   * + bar row 2, underline row 3. */
  private paintEnemyHud(host: VoxelHost, battle: WildBattle): void {
    const e = battle.enemy;
    // Shifted 1 col left of the ported DrawEnemyHUDAndHPBar position (was
    // name/1,0; <LV>/4,1; tick/1,2; bar/2,2; underline 1-10,3) — a deliberate
    // 3DS-remake deviation (Isaac), not a Lua port: push the enemy panel to
    // the last column of slack before column 0, and the player panel
    // (paintPlayerHud) the same amount toward column 19, so the two read as
    // clearly left/right instead of meeting near screen centre.
    this.text(host, nameTileX(0, e.name), 0, e.name);
    this.paintLevelOrStatus(host, battle, e, 3, 1, false);
    host.uiTile(0, 2, HUD_TICK);
    this.paintBar(host, battle, e, 1, 2, false);
    host.uiTile(0, 3, HUD_EDGE_L);
    host.uiFill(1, 3, 8, 1, HUD_LINE);
    host.uiTile(9, 3, HUD_EDGE_R);
  }

  /** DrawPlayerHUDAndHPBar (:5473-5493): name (10,7), <LV> (14,8), bar
   * (10,9), digits row 10, underline row 11 — shifted 1 col right, see
   * paintEnemyHud. */
  private paintPlayerHud(host: VoxelHost, battle: WildBattle): void {
    const p = battle.player;
    this.text(host, nameTileX(11, p.name), 7, p.name);
    this.paintLevelOrStatus(host, battle, p, 15, 8, true);
    this.paintBar(host, battle, p, 11, 9, true);
    this.paintPlayerDigits(host, battle);
    host.uiTile(19, 10, HUD_TICK);
    host.uiTile(10, 11, HUD_HALF_ARROW);
    host.uiFill(11, 11, 8, 1, HUD_LINE);
    host.uiTile(19, 11, HUD_EDGE_DOWN);
  }

  /** the HUD status label replaces <LV>+level (statusLabel :2201-2207). */
  private paintLevelOrStatus(
    host: VoxelHost,
    battle: WildBattle,
    b: WildBattler,
    lvX: number,
    y: number,
    player: boolean,
  ): void {
    const label = b.shownStatus ? b.shownStatus : String(b.mon.level);
    if (b.shownStatus) {
      this.text(host, lvX + 1, y, label);
    } else {
      host.uiTile(lvX, y, HUD_LV);
      this.text(host, lvX + 1, y, label);
    }
    if (player) this.playerLevel = label;
    else this.enemyLevel = label;
  }

  private paintBar(
    host: VoxelHost,
    battle: WildBattle,
    b: WildBattler,
    tx: number,
    ty: number,
    player: boolean,
  ): void {
    const tiles = hpBarTiles(battle.shownHPInt(b), b.mon.stats.hp, player);
    tiles.forEach((t, i) => host.uiTile(tx + i, ty, t));
    if (player) this.playerBar = tiles;
    else this.enemyBar = tiles;
  }

  private paintPlayerDigits(host: VoxelHost, battle: WildBattle): void {
    const p = battle.player;
    const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
    this.text(host, 12, 10, digits);
    this.playerDigits = digits;
  }

  private paintMenuCursor(host: VoxelHost, battle: WildBattle): void {
    const col = (battle.menuIndex - 1) % 2;
    const row = Math.floor((battle.menuIndex - 1) / 2);
    const cell: [number, number] = [col === 0 ? 9 : 15, 14 + row * 2];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }

  private paintMoveCursor(host: VoxelHost, battle: WildBattle): void {
    const cell: [number, number] = [5, 12 + battle.moveIndex];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
    if (battle.moveSwapIndex !== null && battle.moveSwapIndex !== battle.moveIndex) {
      const swap: [number, number] = [5, 12 + battle.moveSwapIndex];
      host.uiTile(swap[0], swap[1], ARROW_HOLLOW);
      this.swapCell = swap;
    } else {
      this.swapCell = null;
    }
  }

  // -----------------------------------------------------------------
  // within-mode deltas
  // -----------------------------------------------------------------

  private deltas(host: VoxelHost, battle: WildBattle, enemyHud: boolean, playerHud: boolean): void {
    if (enemyHud) {
      const e = battle.enemy;
      const bar = hpBarTiles(battle.shownHPInt(e), e.mon.stats.hp, false);
      if (this.enemyBar) {
        bar.forEach((t, i) => {
          if (this.enemyBar![i] !== t) host.uiTile(1 + i, 2, t);
        });
      }
      this.enemyBar = bar;
      const label = e.shownStatus ?? String(e.mon.level);
      if (label !== this.enemyLevel) this.paintLevelOrStatus(host, battle, e, 3, 1, false);
    }
    if (playerHud) {
      const p = battle.player;
      const bar = hpBarTiles(battle.shownHPInt(p), p.mon.stats.hp, true);
      if (this.playerBar) {
        bar.forEach((t, i) => {
          if (this.playerBar![i] !== t) host.uiTile(11 + i, 9, t);
        });
      }
      this.playerBar = bar;
      const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
      if (digits !== this.playerDigits) this.paintPlayerDigits(host, battle);
      const label = p.shownStatus ?? String(p.mon.level);
      if (label !== this.playerLevel) this.paintLevelOrStatus(host, battle, p, 15, 8, true);
    }
    // The menu / move / party / item cursors and the yes/no choice prompt
    // all live on the Kanto Gear bottom screen now; nothing left to move
    // on the top screen between repaints.
  }

  private moveCursor(host: VoxelHost, cell: [number, number]): void {
    const old = this.cursorCell;
    if (old && old[0] === cell[0] && old[1] === cell[1]) return;
    if (old) host.uiTile(old[0], old[1], SPACE);
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }

  // -----------------------------------------------------------------
  // the message window (drawTextArea :5500-5525): the rolling two-line
  // window at rows 14/16, uiText + uiReveal typewriter, blinking ▼
  // -----------------------------------------------------------------

  private emitMessage(host: VoxelHost, battle: WildBattle): void {
    // Battle dialog moved to the Kanto Gear bottom screen (kantogear.ts
    // drawBattleMessage reads battle.shown / msgWaiting each frame). The top
    // screen no longer draws the message window, so this is intentionally inert
    // — battle.ts still advances the reveal/queue timers that the bottom reads.
    void host;
    void battle;
    return;
  }
}
