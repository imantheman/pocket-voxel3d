// Port of gen1recomp src/core/game3/special_field_anim.lua (GPLv3 + additional terms; see LICENSE.md).
// ROM-derived Special Field Animations matching pret pokefirered (special_field_anim.c).
// Handles escalator metatile cycling and teleporter animations.
//
// Port notes: the metatile id tables keep the Lua keys 0..2 as array indices;
// package.loaded["src.core.game3.field_view"] is a static import.

import { pairs } from "../platform/lt.ts";
import FieldViewMod from "./field_view.ts";

/** The layout object the escalator edits (field_view / layout_native). */
export interface EscalatorLayout {
  midAt(x: number, y: number): any;
  collAt(x: number, y: number): any;
  elevAt(x: number, y: number): any;
  applyOverride(x: number, y: number, mid: any, coll: any, elev: any): void;
}

const ESCALATOR_STAGES = 3;
const LAST_ESCALATOR_STAGE = ESCALATOR_STAGES - 1;

// Metatile IDs from constants/metatile_labels.h matching pokefirered/src/special_field_anim.c:
// Standard ordering: [0] = Normal, [1] = Transition1, [2] = Transition2
const sEscalatorMetatiles_BottomNextRail = [0x2D0, 0x30A, 0x308];
const sEscalatorMetatiles_BottomRail = [0x2D1, 0x30B, 0x309];
const sEscalatorMetatiles_BottomNext = [0x2D8, 0x312, 0x310];
const sEscalatorMetatiles_Bottom = [0x2D9, 0x313, 0x311];

const sEscalatorMetatiles_TopNext = [0x2E3, 0x316, 0x314];
const sEscalatorMetatiles_Top = [0x2E4, 0x317, 0x315];
const sEscalatorMetatiles_TopNextRail = [0x2EB, 0x31E, 0x31C];

// Lua: special_field_anim.lua:31
/** SetEscalatorMetatile (pokefirered special_field_anim.c) */
function setEscalatorMetatile(layout: EscalatorLayout | undefined, px: number, py: number, _stage: number,
  goingUp: boolean, ids: number[]): void {
  if (!layout) return;
  const x = px - 1;
  const y = py - 1;
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      const cellX = x + j;
      const cellY = y + i;
      const curMid = layout.midAt(cellX, cellY);
      if (goingUp) {
        // Moving UP: 0 (Normal) -> 1 (T1) -> 2 (T2) -> 0 (Normal)
        if (curMid === ids[0]) {
          layout.applyOverride(cellX, cellY, ids[1], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        } else if (curMid === ids[1]) {
          layout.applyOverride(cellX, cellY, ids[2], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        } else if (curMid === ids[2]) {
          layout.applyOverride(cellX, cellY, ids[0], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        }
      } else {
        // Moving DOWN: 0 (Normal) -> 2 (T2) -> 1 (T1) -> 0 (Normal)
        if (curMid === ids[0]) {
          layout.applyOverride(cellX, cellY, ids[2], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        } else if (curMid === ids[2]) {
          layout.applyOverride(cellX, cellY, ids[1], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        } else if (curMid === ids[1]) {
          layout.applyOverride(cellX, cellY, ids[0], layout.collAt(cellX, cellY), layout.elevAt(cellX, cellY));
        }
      }
    }
  }
}

export const SpecialFieldAnim = {
  _active: false,
  _layout: undefined as EscalatorLayout | undefined,
  _playerX: 0,
  _playerY: 0,
  _goingUp: false,
  _state: 0,
  _transitionStage: 0,
  _drawingEscalator: false,
  _originalMids: {} as Record<number, any>,

  // Lua: special_field_anim.lua:63
  startEscalator(layout: EscalatorLayout | undefined, playerX?: number, playerY?: number, goingUp?: unknown): void {
    SpecialFieldAnim._active = true;
    SpecialFieldAnim._layout = layout;
    SpecialFieldAnim._playerX = playerX ?? 0;
    SpecialFieldAnim._playerY = playerY ?? 0;
    SpecialFieldAnim._goingUp = goingUp != null && goingUp !== false;
    SpecialFieldAnim._state = 0;
    SpecialFieldAnim._transitionStage = 0;
    SpecialFieldAnim._drawingEscalator = true;

    // Store original metatiles to restore when stopped
    SpecialFieldAnim._originalMids = {};
    if (layout) {
      const x = SpecialFieldAnim._playerX - 1;
      const y = SpecialFieldAnim._playerY - 1;
      for (let i = 0; i <= 2; i++) {
        for (let j = 0; j <= 2; j++) {
          const cellX = x + j;
          const cellY = y + i;
          const mid = layout.midAt(cellX, cellY);
          SpecialFieldAnim._originalMids[cellY * 1024 + cellX] = mid;
        }
      }
    }

    // Initial tick (pokefirered CreateEscalatorTask calls Task_DrawEscalator once)
    SpecialFieldAnim.update();
  },

  // Lua: special_field_anim.lua:92
  stopEscalator(): void {
    if (!SpecialFieldAnim._active) return;
    SpecialFieldAnim._active = false;
    SpecialFieldAnim._drawingEscalator = false;
    // Restore original metatiles
    const layout = SpecialFieldAnim._layout;
    if (layout && SpecialFieldAnim._originalMids) {
      for (const [key, origMid] of pairs(SpecialFieldAnim._originalMids)) {
        const k = key as number;
        // Lua: key % 1024 (floored modulo; cell keys can be negative at the map edge)
        const cellX = ((k % 1024) + 1024) % 1024;
        const cellY = Math.floor(k / 1024);
        layout.applyOverride(cellX, cellY, origMid,
          layout.collAt(cellX, cellY),
          layout.elevAt(cellX, cellY));
      }
    }
    SpecialFieldAnim._originalMids = {};

    // package.loaded["src.core.game3.field_view"]
    const FieldView: any = FieldViewMod;
    if (FieldView) FieldView._nativeDirty = true;
  },

  // Lua: special_field_anim.lua:112
  isActive(): boolean {
    return SpecialFieldAnim._active;
  },

  // Lua: special_field_anim.lua:116
  isEscalatorMoving(): boolean {
    if (!SpecialFieldAnim._active) return false;
    if (!SpecialFieldAnim._drawingEscalator) {
      return SpecialFieldAnim._transitionStage !== LAST_ESCALATOR_STAGE;
    }
    return true;
  },

  // Lua: special_field_anim.lua:125
  /** Task_DrawEscalator (pokefirered special_field_anim.c) */
  update(): void {
    if (!SpecialFieldAnim._active || !SpecialFieldAnim._layout) return;

    SpecialFieldAnim._drawingEscalator = true;
    const layout = SpecialFieldAnim._layout;
    const px = SpecialFieldAnim._playerX;
    const py = SpecialFieldAnim._playerY;
    const stage = SpecialFieldAnim._transitionStage;
    const goingUp = SpecialFieldAnim._goingUp;

    // Pret Task_DrawEscalator: cycle through sections on each state (0..6)
    const state = SpecialFieldAnim._state;
    if (state === 0) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_BottomNextRail);
    } else if (state === 1) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_BottomRail);
    } else if (state === 2) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_BottomNext);
    } else if (state === 3) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_Bottom);
    } else if (state === 4) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_TopNext);
    } else if (state === 5) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_Top);
    } else if (state === 6) {
      setEscalatorMetatile(layout, px, py, stage, goingUp, sEscalatorMetatiles_TopNextRail);
    }

    SpecialFieldAnim._state = (SpecialFieldAnim._state + 1) % 8;
    if (SpecialFieldAnim._state === 0) {
      // Reached end of state cycle (DrawWholeMapView)
      SpecialFieldAnim._transitionStage = (SpecialFieldAnim._transitionStage + 1) % ESCALATOR_STAGES;
      SpecialFieldAnim._drawingEscalator = false;
      // package.loaded["src.core.game3.field_view"]
      const FieldView: any = FieldViewMod;
      if (FieldView) FieldView._nativeDirty = true;
    }
  },
};

export default SpecialFieldAnim;
