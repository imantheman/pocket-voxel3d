// Port of gen1recomp src/ui/game3/release_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 3 Pokémon Release Sequence (emotional upward shrink & float animation).
// "Release this POKéMON?" -> [YES/NO] -> float/shrink animation -> "<MON> was released." -> "Bye-bye, <MON>!".

import { Window } from "./window.ts";
// The Lua requires frlg_font here without using it.
import "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Storage } from "../core/storage.ts";
import { RomText } from "../core/rom_text.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Message } from "./message.ts";
import { G } from "../platform/graphics.ts";
import { truthy } from "../../../import/gen3/lua.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: release_seq.lua:25
function se(id: unknown): void {
  // pcall(function() require("src.core.game3.audio").playSe(id) end)
  try { Audio.playSe(id); } catch { /* pcall */ }
}

interface Input { wasPressed(k: string): boolean }

// Lua: release_seq.lua:53
function anyKey(input: Input): boolean {
  return input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("up")
    || input.wasPressed("down") || input.wasPressed("left") || input.wasPressed("right");
}

export const ReleaseSeq = {
  active: false,
  state: "idle" as string, // idle | confirm | anim | bye | done
  mon: null as any,
  boxId: 1 as any,
  slotIdx: 1 as any,
  session: null as any,
  onComplete: null as ((released: boolean) => void) | null,
  yesNoCursor: 2, // default to NO
  animT: 0,
  startX: 0,
  startY: 0,

  // Lua: release_seq.lua:29
  start(opts?: any): void {
    opts = opts ?? {};
    {
      // NOT FAITHFUL (scope): the Lua closes the stay message only when
      // src.ui.game3.message is already loaded (package.loaded); here it is
      // always imported.
      const StayMessage = Message;
      if (StayMessage && StayMessage.closeStay) StayMessage.closeStay();
    }
    ReleaseSeq.active = true;
    ReleaseSeq.state = "confirm";
    ReleaseSeq.session = opts.session;
    ReleaseSeq.mon = opts.mon;
    ReleaseSeq.boxId = opts.boxId ?? 1;
    ReleaseSeq.slotIdx = opts.slotIdx ?? 1;
    ReleaseSeq.onComplete = opts.onComplete;
    ReleaseSeq.yesNoCursor = 2; // Default to NO
    ReleaseSeq.animT = 0;
    ReleaseSeq.startX = opts.startX ?? 80;
    ReleaseSeq.startY = opts.startY ?? 60;
    se(SE.SE_SELECT);
  },

  // Lua: release_seq.lua:49
  isActive(): boolean {
    return ReleaseSeq.active;
  },

  // Lua: release_seq.lua:58
  handleInput(input: Input): void {
    if (!ReleaseSeq.active) return;

    if (ReleaseSeq.state === "confirm") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        ReleaseSeq.yesNoCursor = (ReleaseSeq.yesNoCursor === 1) ? 2 : 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT); // pokefirered/src/menu.c:376
        if (ReleaseSeq.yesNoCursor === 1) {
          // Confirmed YES
          ReleaseSeq.state = "anim";
          ReleaseSeq.animT = 0;
        } else {
          // Chose NO
          ReleaseSeq.close(false);
        }
      } else if (input.wasPressed("b")) {
        ReleaseSeq.close(false);
      }
      return;
    }

    if (ReleaseSeq.state === "released") {
      // pokefirered/src/pokemon_storage_system_tasks.c:1308
      if (anyKey(input)) {
        ReleaseSeq.state = "bye";
      }
      return;
    }

    if (ReleaseSeq.state === "bye") {
      // pokefirered/src/pokemon_storage_system_tasks.c:1315
      if (anyKey(input)) {
        ReleaseSeq.close(true);
      }
      return;
    }
  },

  // Lua: release_seq.lua:98
  update(dt?: number): void {
    if (!ReleaseSeq.active) return;

    if (ReleaseSeq.state === "anim") {
      ReleaseSeq.animT = ReleaseSeq.animT + (dt ?? (1 / 60));
      if (ReleaseSeq.animT >= 0.8) {
        // Finalize data deletion in storage
        if (truthy(ReleaseSeq.session) && truthy(ReleaseSeq.boxId) && truthy(ReleaseSeq.slotIdx)) {
          Storage.releaseMon(ReleaseSeq.session, ReleaseSeq.boxId, ReleaseSeq.slotIdx);
        }
        // pokefirered/src/pokemon_storage_system_tasks.c:1304
        ReleaseSeq.state = "released";
        se(SE.SE_SELECT);
      }
    }
  },

  // Lua: release_seq.lua:115
  close(released: boolean): void {
    ReleaseSeq.active = false;
    ReleaseSeq.state = "idle";
    const cb = ReleaseSeq.onComplete;
    ReleaseSeq.onComplete = null;
    if (cb) cb(released);
  },

  // Lua: release_seq.lua:123
  draw(): void {
    if (!ReleaseSeq.active) return;
    // pokefirered/src/pokemon_storage_system_tasks.c:2570
    const dynamic = { 0: Pokemon.displayName(ReleaseSeq.mon) };

    if (ReleaseSeq.state === "confirm") {
      // Bottom dialogue box
      Window.dialogueFrame();
      Window.printPx(RomText.plain("gText_ReleaseThisPokemon"), 16, 120);

      // YES/NO Confirmation Box
      Window.stdFrame(Window.template(21, 8, 6, 4));
      Window.printPx(RomText.plain("gText_Yes"), 184, 68);
      Window.printPx(RomText.plain("gText_No"), 184, 84);
      Window.cursorPx(174, ReleaseSeq.yesNoCursor === 1 ? 68 : 84);
      return;
    }

    if (ReleaseSeq.state === "anim") {
      // Draw upward shrinking sprite
      const progress = Math.min(1.0, ReleaseSeq.animT / 0.8);
      const scale = Math.max(0.01, 1.0 - progress * 0.85);
      const alpha = Math.max(0.0, 1.0 - progress);
      const curX = ReleaseSeq.startX;
      const curY = ReleaseSeq.startY - (progress * 40); // float upward 40px

      const icon = ReleaseSeq.mon && Pokemon.monIcon(ReleaseSeq.mon);
      if (icon && icon.image) {
        const q = icon.quads && icon.quads[0];
        G.setColor(1, 1, 1, alpha);
        if (q) {
          G.draw(icon.image, q, curX, curY, 0, scale, scale, 16, 16);
        } else {
          G.draw(icon.image, curX, curY, 0, scale, scale, 16, 16);
        }
        G.setColor(1, 1, 1, 1);
      }
      return;
    }

    if (ReleaseSeq.state === "released") {
      Window.dialogueFrame();
      Window.printPx(RomText.plain("gText_PkmnWasReleased", { dynamic }), 16, 120);
      return;
    }

    if (ReleaseSeq.state === "bye") {
      Window.dialogueFrame();
      Window.printPx(RomText.plain("gText_ByeByePkmn", { dynamic }), 16, 120);
      return;
    }
  },
};

export default ReleaseSeq;
