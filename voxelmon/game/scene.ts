// The presentation frontend: reads the whole game state once per tick and
// emits voxel-surface ops as DELTAS against what the retained core already
// holds (docs/VOXEL.md §3: per-frame boundary traffic is ~10-40 ops —
// camera + moving entities + a reveal counter; map/ui bursts happen once).
//
// Camera rule ports gen1recomp src/render/Camera.lua: at the 160x144 view,
// camera.x = px - 64, camera.y = py - 64, so the view CENTRE is
// (px + 16, py + 8) — the player sprite at screen tile (8,8). cam() takes
// that centre in Q4.

import { ENT_FLAG, ENTS_MAX, Q4, Q8 } from "../../contracts/spec/voxel-spec.ts";
import type { WildBattle } from "./battle/battle.ts";
import { desiredCards, type BattleStaging } from "./battle/staging.ts";
import type { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { computeNeighbors, type Overworld } from "./world/overworld.ts";
import { NPC } from "./world/npc.ts";
import type { Textbox } from "./world/textbox.ts";
import {
  ARROW_CURSOR,
  ARROW_MORE,
  ARROW_X,
  ARROW_Y,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  BOX_TH,
  BOX_TW,
  BOX_TX,
  BOX_TY,
  encodeGlyphs,
  ARROW_CURSOR,
  LINE1_Y,
  LINE2_Y,
  MAX_COLS,
  SPACE,
  TEXT_X,
  toCells,
} from "./ui/tiles.ts";

// gen1recomp src/render/SpriteRenderer.lua:85 — the walk-sheet frame order
// (right = mirrored left, DIR order in the spec matches).
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };

export interface UiBoxSource {
  box: Textbox;
}

export interface ChoiceSource {
  yes: boolean;
}

/** The battle state the scene stages and draws (game.ts's battle state). */
export interface BattleSceneView {
  battle: WildBattle;
  staging: BattleStaging | null;
  ui: BattleUi;
}

/** Autopilot-only profiling hook (game.ts owns and reports it; `emit` adds
 * its section sums when present — see game.ts `prof`). */
export interface Prof {
  now(): number;
  line(s: string): void;
  upd: number;
  emit: number;
  aud: number;
  /** emit() section sums, µs: map-slot diff, ents+emote+cam, ui/battle tail. */
  maps: number;
  ents: number;
  ui: number;
}

/** What the scene reads each tick — game.ts satisfies this. */
export interface NamingSource {
  view(): {
    title: string;
    grid: string[][];
    row: number;
    col: number;
    name: string;
    maxLen: number;
  };
}

export interface SceneView {
  data: VoxelmonData;
  overworld: Overworld;
  /** Topmost dialogue box on the state stack, if any. */
  uiBox(): UiBoxSource | null;
  /** Topmost YES/NO choice, if any (drawn over its parent box). */
  uiChoice(): ChoiceSource | null;
  /** Topmost naming screen, if any (owns the whole tile layer). */
  naming(): NamingSource | null;
  /** The active battle, if any — the scene then stages the arena and hands
   * the GB tile layer to the battle ui. */
  battleView(): BattleSceneView | null;
  /** Autopilot-only profiling hook; undefined in production and in the sim. */
  prof?: Prof;
}

interface UiRowCache {
  /** The ShownLine this row was built from. Its identity pins its text —
   * textbox.ts assigns `text` once at construction and mutates only
   * `revealed` — so an identity hit skips the per-tick pad rebuild AND the
   * `encodeGlyphs` lookup that used to run every frame a box was open. */
  line: unknown;
  wasLast: boolean;
  text: string;
  revealed: number;
}

export class Scene {
  private host: VoxelHost;
  private started = false;
  // Delta-gate state. The GATES are numeric or identity-based on purpose:
  // this emit runs under QuickJS on a 333 MHz part, where the earlier
  // rebuild-a-string-key-per-tick gates measured 15+ ms a frame (2026-08-06
  // device profile). Every replacement below preserves the exact op-emit
  // condition — a key was always a pure injective function of the numbers
  // now compared directly.
  private lastCamX = Number.NaN;
  private lastCamY = Number.NaN;
  private lastPalette: number | null = null;
  /** The GameMap emitMaps last ran against: transitions replace the map
   * object (overworld.ts), so identity is the change signal, and the
   * neighbor BFS + slot keys — once ~7 ms EVERY tick — run only then. */
  private lastMap: unknown = null;
  private mapSlots: (string | null)[] = [null, null, null, null, null];
  /** Per-slot ent-op args (6 ints each) + shown flags: the numeric mirror
   * of the old per-tick `${...}` key strings. `entSeen` is the per-tick
   * mark for the hide sweep. */
  private entVals = new Int32Array(ENTS_MAX * 6);
  private entShown = new Uint8Array(ENTS_MAX);
  private entSeen = new Uint8Array(ENTS_MAX);
  /** spriteId -> atlas page: the answer is boot-static, the regex +
   * toLowerCase that computed it ran per entity per tick. */
  private sheetCache = new Map<string, number>();
  private lastEmote: { slot: number; kind: number } | null = null;
  private uiOwner: UiBoxSource | null = null;
  private namingSig: string | null = null;
  private picSig = "";
  private titleSig: string | null = null;
  private menuSig: string | null = null;
  private bagSig: string | null = null;
  private shopSig: string | null = null;
  private boxSig: string | null = null;
  private partySig: string | null = null;
  private dexSig: string | null = null;
  private summarySig: string | null = null;
  private uiRows: UiRowCache[] = [];
  private uiPage = -1;
  private uiArrow = false;
  private choiceDrawn = false;
  private choiceYes = true;
  // battle staging deltas (docs/VOXEL.md §4 battle ops)
  private battleActive = false;
  private arenaStaged = false;
  private cardShown = new Map<number, string>();

  constructor(host: VoxelHost) {
    this.host = host;
  }

  emit(view: SceneView): void {
    const host = this.host;
    if (!this.started) {
      this.started = true;
      // pitch rung 2 at boot (docs/VOXEL.md §10 scope; PITCH_RUNGS[2] = 35°)
      host.pitch(2);
    }
    const p = view.prof;
    const t0 = p ? p.now() : 0;
    this.emitMaps(view);
    const t1 = p ? p.now() : 0;
    // The overworld camera and its ents (the player, every NPC) are only
    // relevant when there's an overworld to look at. A battle stages its
    // own camera (battleCam/arena) and shows only the two Pokémon — the
    // trainers standing beside them in the reference game are never drawn
    // — so skip all three while bv is set; hideAllEnts (in emitBattle,
    // battle-start only) clears whatever was left showing from the moment
    // before the battle began.
    const bv = view.battleView();
    if (!bv) {
      this.emitCam(view);
      this.emitEnts(view);
      this.emitEmote(view);
    }
    const t2 = p ? p.now() : 0;
    if (p) {
      p.maps += t1 - t0;
      p.ents += t2 - t1;
    }
    if (bv) {
      this.emitBattle(view, bv);
      if (p) p.ui += p.now() - t2;
      return;
    }
    if (this.battleActive) {
      this.endBattle();
    }
    this.emitUi(view);
    if (p) p.ui += p.now() - t2;
  }

  // battle — arena/card/battleCam on entry, cardHide/arenaEnd on exit; the
  // GB tile layer is handed to the battle ui (battle/ui.ts) while a battle
  // is up. Nothing moves the player: the camera goes to the arena.
  private emitBattle(view: SceneView, bv: BattleSceneView): void {
    const host = this.host;
    if (!this.battleActive) {
      this.battleActive = true;
      this.hideAllEnts();
      // drop the overworld ui program; the battle ui repaints from uiClear
      this.uiOwner = null;
      this.uiRows = [];
      this.uiPage = -1;
      this.uiArrow = false;
      this.choiceDrawn = false;
      if (bv.staging) {
        const a = bv.staging.arena;
        host.arena(bv.staging.mapIndex, a.x, a.y, a.shape, bv.staging.rig);
        // battleCam defaults: orbit 0, pitch 0, zoom 1.0 (Q8); the solved
        // rig constants live core-side, keyed by the arena op's rig arg
        host.battleCam(0, 0, Q8);
        this.arenaStaged = true;
      }
    }
    const desired = bv.staging ? desiredCards(view.data, bv.battle, bv.staging) : [];
    const seen = new Set<number>();
    for (const c of desired) {
      seen.add(c.side);
      // The offset is part of the key: a lunging card changes only dx/dz,
      // and without them here the op would be suppressed as a no-op and the
      // animation would never leave the guest.
      const key = `${c.pic},${c.x},${c.y},${c.dx},${c.dy},${c.dz}`;
      if (this.cardShown.get(c.side) !== key) {
        host.card(c.side, c.pic, c.x, c.y, c.dx, c.dy, c.dz);
        this.cardShown.set(c.side, key);
      }
    }
    for (const side of [...this.cardShown.keys()]) {
      if (!seen.has(side)) {
        host.cardHide(side);
        this.cardShown.delete(side);
      }
    }
    bv.ui.emit(host, bv.battle);
  }

  private endBattle(): void {
    const host = this.host;
    for (const side of [...this.cardShown.keys()]) {
      host.cardHide(side);
    }
    this.cardShown.clear();
    if (this.arenaStaged) {
      host.arenaEnd();
      this.arenaStaged = false;
    }
    host.uiClear();
    this.battleActive = false;
  }

  // world — slot 0 current, 1..4 the directly connected neighbours at their
  // seam offsets (computeNeighbors hops=1; offsets in world px).
  private emitMaps(view: SceneView): void {
    const ow = view.overworld;
    // Everything below is a pure function of the current GameMap, and a
    // transition replaces that object — so an identity hit means the exact
    // keys the body would rebuild are the ones it built last time, and the
    // slot diff would emit nothing. Re-entering the same map id makes a new
    // object; the body re-runs and the slot keys still gate the ops.
    if (ow.map === this.lastMap) return;
    this.lastMap = ow.map;
    const maps = view.data.maps!;
    const desired: ({ id: string; index: number; ox: number; oy: number } | null)[] = [
      { id: ow.map.id, index: ow.map.def.index, ox: 0, oy: 0 },
    ];
    for (const n of computeNeighbors(maps, ow.map.id, 1).slice(0, 4)) {
      // Un-cooked neighbours stay unseen: the pak has nothing to draw for
      // them, and the crossing guard (overworld.ts) already walls them off.
      if ((n as any).hidden) continue;
      if (view.data.cookedMaps && !view.data.cookedMaps.includes(n.id)) continue;
      desired.push({ id: n.id, index: maps[n.id].index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0; slot < 5; slot++) {
      const want = desired[slot] ?? null;
      const key = want ? `${want.id}@${want.ox},${want.oy}` : null;
      if (key === this.mapSlots[slot]) continue;
      if (want) {
        this.host.mapShow(slot, want.index, want.ox, want.oy);
      } else {
        this.host.mapHide(slot);
      }
      this.mapSlots[slot] = key;
    }
    // The current map's SGB palette (gamedata mapPalette — the cooker's
    // port of SetPal_Overworld), delta-emitted like the slots above: one
    // palette op whenever the slot-0 map changes it. -1 = grayscale ramp.
    const want = view.data.mapPalette?.[ow.map.id] ?? -1;
    if (want !== this.lastPalette) {
      this.host.palette(want);
      this.lastPalette = want;
    }
  }

  private emitCam(view: SceneView): void {
    const p = view.overworld.player;
    // Camera.lua follow at the 160x144 view: centre = (px + 16, py + 8)
    const cx = (p.px + 16) * Q4;
    const cy = (p.py + 8) * Q4;
    if (cx !== this.lastCamX || cy !== this.lastCamY) {
      this.host.cam(cx, cy);
      this.lastCamX = cx;
      this.lastCamY = cy;
    }
  }

  private sheetIndex(view: SceneView, spriteId: string): number {
    const hit = this.sheetCache.get(spriteId);
    if (hit !== undefined) return hit;
    // The ent op carries the pak's ABSOLUTE atlas page (core page_at):
    // resolve SPRITE_RED -> atlas.sprites["red"] through the cooked page
    // map. The ROM spriteOrder index is NOT a page index — sending it bound
    // the player to page 0 (the terrain atlas: a card wearing tree art).
    const atlas = (view.data as { atlas?: { sprites?: Record<string, number> } }).atlas;
    const name = spriteId.replace(/^SPRITE_/, "").toLowerCase();
    const page = atlas?.sprites?.[name];
    const index = typeof page === "number" ? page : -1; // -1: core skips the card
    this.sheetCache.set(spriteId, index);
    return index;
  }

  /** Emit one ent op iff any of its six (integer) args changed — the exact
   * condition the old per-tick `${...}` key string tested, minus the six
   * int→string coercions and the allocation. */
  private emitSlot(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void {
    const b = slot * 6;
    const v = this.entVals;
    this.entSeen[slot] = 1;
    if (
      this.entShown[slot] !== 0 &&
      v[b] === sheet &&
      v[b + 1] === frame &&
      v[b + 2] === x &&
      v[b + 3] === y &&
      v[b + 4] === lift &&
      v[b + 5] === flags
    ) {
      return;
    }
    this.host.ent(slot, sheet, frame, x, y, lift, flags);
    v[b] = sheet;
    v[b + 1] = frame;
    v[b + 2] = x;
    v[b + 3] = y;
    v[b + 4] = lift;
    v[b + 5] = flags;
    this.entShown[slot] = 1;
  }

  private emitEnts(view: SceneView): void {
    const ow = view.overworld;
    this.entSeen.fill(0);
    // player: slot 0, ghost silhouette + grass-occluded walker
    const p = ow.player;
    {
      const phase = p.walkPhase();
      const frame = phase === 1 ? WALK[p.facing] : STAND[p.facing];
      // SpriteRenderer.lua:189-193 flip: right-facing mirrors; alternate
      // up/down walk cycles mirror via the fixed-rate animClock
      const mirror =
        p.facing === "right" ||
        ((p.facing === "down" || p.facing === "up") && phase === 1 && p.animFlip());
      let flags = ENT_FLAG.ghost | ENT_FLAG.walker;
      if (mirror) flags |= ENT_FLAG.mirror;
      this.emitSlot(
        0,
        this.sheetIndex(view, "SPRITE_RED"),
        frame,
        p.px * Q4,
        p.py * Q4,
        p.hopLift(),
        flags,
      );
    }
    const npcs = ow.npcs;
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i]!;
      const slot = i + 1;
      if (slot >= ENTS_MAX) break;
      // hide_object sets npc.hidden; skip emitting so the end-of-frame
      // entSeen cleanup hides the slot. Without this an object picked up or
      // hidden by a script (item balls, a departed rival) keeps drawing until
      // the map reloads and objectVisible filters it at spawn.
      if ((npc as { hidden?: boolean }).hidden) continue;
      const def = view.data.sprites?.[npc.def.sprite];
      const frames = def?.frames ?? 6;
      const phase = npc.walkPhase();
      // single-frame sprites (item balls) have one fixed pose
      // (SpriteRenderer.lua:183)
      const frame =
        frames <= 1 ? 0 : phase === 1 && def?.walker ? WALK[npc.facing] : STAND[npc.facing];
      const mirror =
        frames > 1 &&
        (npc.facing === "right" ||
          ((npc.facing === "down" || npc.facing === "up") && phase === 1 && npc.stepFlip));
      let flags = def?.walker ? ENT_FLAG.walker : 0;
      if (mirror) flags |= ENT_FLAG.mirror;
      this.emitSlot(
        slot,
        this.sheetIndex(view, npc.def.sprite),
        frame,
        npc.px * Q4,
        npc.py * Q4,
        0,
        flags,
      );
    }
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (this.entSeen[slot] === 0 && this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
  }

  /** Hide every ent slot still showing from the moment before a battle
   * started — emitEnts (and its own end-of-call hide sweep) is skipped for
   * the whole battle, so nothing else clears the player/NPCs left over
   * from the last overworld frame. */
  private hideAllEnts(): void {
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
    this.entSeen.fill(0);
  }

  private emitEmote(view: SceneView): void {
    const ow = view.overworld;
    const e = ow.emote;
    if (e) {
      const slot = e.entity === ow.player ? 0 : ow.npcs.indexOf(e.entity as NPC) + 1;
      if (!this.lastEmote || this.lastEmote.slot !== slot || this.lastEmote.kind !== e.kind) {
        this.host.emote(slot, e.kind);
        this.lastEmote = { slot, kind: e.kind };
      }
    } else if (this.lastEmote) {
      this.host.emote(this.lastEmote.slot, 0);
      this.lastEmote = null;
    }
  }

  /** Static label into the retained grid, glyph by glyph (tile id == code). */
  private stamp(host: VoxelHost, x: number, y: number, s: string): void {
    const codes = encodeGlyphs(s);
    for (let i = 0; i < codes.length; i++) host.uiTile(x + i, y, codes[i]!);
  }

  // ui — the dialogue box as a retained tile-layer program: border once on
  // open, uiText for the row that is typing, uiReveal as the typewriter
  // advances (the reveal counter applies to the LAST uiText — voxel-spec),
  // and every finished row stamped into the grid.
  private emitUi(view: SceneView): void {
    const host = this.host;
    const rawPic = (view as unknown as { pic?: () => unknown }).pic?.();
    const picList = Array.isArray(rawPic) ? rawPic : rawPic ? [rawPic] : [];
    const psig = picList
      .map((q: any, i: number) => `${i}:${q.page},${q.x},${q.y},${q.w},${q.h}`)
      .join("|");
    if (psig !== this.picSig) {
      this.picSig = psig;
      for (let i = 0; i < 4; i++) {
        const q: any = picList[i];
        if (q) host.pic(i, q.page, q.x, q.y, q.w, q.h);
        else host.picHide(i);
      }
    }

    const bx = (view as unknown as { box?: () => any }).box?.();
    if (bx) {
      const sig = [
        bx.mode, bx.currentBox, bx.menuIndex, bx.listIndex, bx.listTop,
        bx.submenuIndex, bx.confirmYes, bx.footer ?? "",
        bx.list.map((e: any) => `${e.label}${e.right}`).join(","),
      ].join("|");
      if (sig !== this.boxSig) {
        this.boxSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box = (x: number, y: number, w: number, h: number) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        const footerBox = () => {
          if (!bx.footer) return;
          box(0, 12, 19, 4);
          String(bx.footer).split("\n").forEach((ln: string, i: number) => {
            this.stamp(host, 1, 13 + i, ln);
          });
        };
        // BOX No. indicator, top-right.
        box(12, 0, 7, 1);
        this.stamp(host, 14, 1, `BOX No.${bx.currentBox}`);

        if (bx.mode === "menu") {
          const items = ["WITHDRAW", "DEPOSIT", "RELEASE", "CHANGE BOX", "SEE YA!"];
          box(0, 3, 13, items.length * 2);
          items.forEach((label, i) => {
            this.stamp(host, 2, 5 + i * 2, label);
            if (i === bx.menuIndex) host.uiTile(1, 5 + i * 2, ARROW_CURSOR);
          });
        } else if (bx.mode === "list") {
          const total = bx.list.length + 1; // + CANCEL
          const X = 0, Y = 3, W = 15, H = bx.rows * 2;
          box(X, Y, W, H);
          for (let r = 0; r < bx.rows; r++) {
            const li = bx.listTop + r;
            if (li >= total) break;
            const rowY = Y + 2 + r * 2;
            if (li < bx.list.length) {
              const e = bx.list[li];
              this.stamp(host, X + 2, rowY, e.label);
              if (e.right) this.stamp(host, X + W - e.right.length, rowY, e.right);
            } else {
              this.stamp(host, X + 2, rowY, "CANCEL");
            }
            if (li === bx.listIndex) host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (bx.listTop + bx.rows < total) host.uiTile(X + W - 1, Y + H, ARROW_MORE);
        } else if (bx.mode === "submenu") {
          const items = [bx.submenuLabel, "STATS", "CANCEL"];
          box(9, 9, 9, 6);
          items.forEach((label, i) => {
            this.stamp(host, 12, 11 + i * 2, label);
            if (i === bx.submenuIndex) host.uiTile(11, 11 + i * 2, ARROW_CURSOR);
          });
        } else if (bx.mode === "confirm") {
          box(14, 8, 4, 2);
          this.stamp(host, 16, 9, "YES");
          this.stamp(host, 16, 10, "NO");
          host.uiTile(15, bx.confirmYes ? 9 : 10, ARROW_CURSOR);
          footerBox();
        }
        if (bx.mode === "list" || bx.mode === "message") footerBox();
      }
      return;
    }
    if (this.boxSig !== null) {
      this.boxSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.shopSig = this.summarySig = this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }

    const sh = (view as unknown as { shop?: () => any }).shop?.();
    if (sh) {
      const sig = [
        sh.mode, sh.money, sh.menuIndex, sh.buying, sh.listIndex, sh.listTop,
        sh.qty, sh.total, sh.confirmYes, sh.footer ?? "",
        sh.list.map((e: any) => `${e.label}${e.right}`).join(","),
      ].join("|");
      if (sig !== this.shopSig) {
        this.shopSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const box = (x: number, y: number, w: number, h: number) => {
          host.uiTile(x, y, BORDER_TL);
          host.uiFill(x + 1, y, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y, BORDER_TR);
          host.uiFill(x, y + 1, 1, h, BORDER_V);
          host.uiFill(x + w, y + 1, 1, h, BORDER_V);
          host.uiFill(x + 1, y + 1, w - 1, h, SPACE);
          host.uiTile(x, y + 1 + h, BORDER_BL);
          host.uiFill(x + 1, y + 1 + h, w - 1, 1, BORDER_H);
          host.uiTile(x + w, y + 1 + h, BORDER_BR);
        };
        const footer = () => {
          if (!sh.footer) return;
          box(0, 13, 19, 3);
          String(sh.footer).split("\n").forEach((ln: string, i: number) => {
            this.stamp(host, 1, 14 + i, ln);
          });
        };
        // Money box, top-right (¥ = 0xf0), in every mode.
        box(11, 0, 8, 1);
        const money = `\u00a5${sh.money}`;
        this.stamp(host, 19 - money.length, 1, money);

        if (sh.mode === "menu") {
          box(0, 3, 8, 6);
          ["BUY", "SELL", "QUIT"].forEach((label, i) => {
            this.stamp(host, 3, 5 + i * 2, label);
            if (i === sh.menuIndex) host.uiTile(2, 5 + i * 2, ARROW_CURSOR);
          });
        } else if (sh.mode === "list") {
          const total = sh.list.length + 1; // + CANCEL
          const X = 0, Y = 3, W = 19, H = sh.rows * 2;
          box(X, Y, W, H);
          for (let r = 0; r < sh.rows; r++) {
            const li = sh.listTop + r;
            if (li >= total) break;
            const rowY = Y + 2 + r * 2;
            if (li < sh.list.length) {
              const e = sh.list[li];
              this.stamp(host, X + 2, rowY, e.label);
              this.stamp(host, X + W - e.right.length, rowY, e.right);
            } else {
              this.stamp(host, X + 2, rowY, "CANCEL");
            }
            if (li === sh.listIndex) host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (sh.listTop + sh.rows < total) host.uiTile(X + W - 1, Y + H, ARROW_MORE);
          footer();
        } else if (sh.mode === "quantity") {
          box(3, 6, 13, 2);
          this.stamp(host, 5, 7, sh.selName);
          this.stamp(host, 5, 8, `\u00d7${sh.qty}`);
          const t = `\u00a5${sh.total}`;
          this.stamp(host, 15 - t.length, 8, t);
          footer();
        } else if (sh.mode === "confirm") {
          box(14, 9, 4, 2);
          this.stamp(host, 16, 10, "YES");
          this.stamp(host, 16, 11, "NO");
          host.uiTile(15, sh.confirmYes ? 10 : 11, ARROW_CURSOR);
          footer();
        }
      }
      return;
    }
    if (this.shopSig !== null) {
      this.shopSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.summarySig = this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }

    const sv = (view as unknown as { summary?: () => any }).summary?.();
    if (sv) {
      const sig = `${sv.name},${sv.hp}/${sv.maxHp},${sv.status},${sv.level}`;
      if (sig !== this.summarySig) {
        this.summarySig = sig;
        this.uiOwner = null;
        host.uiClear();
        // Full-screen frame (StatusScreen owns the tile layer).
        host.uiTile(0, 0, BORDER_TL);
        host.uiFill(1, 0, 18, 1, BORDER_H);
        host.uiTile(19, 0, BORDER_TR);
        host.uiFill(0, 1, 1, 16, BORDER_V);
        host.uiFill(19, 1, 1, 16, BORDER_V);
        host.uiTile(0, 17, BORDER_BL);
        host.uiFill(1, 17, 18, 1, BORDER_H);
        host.uiTile(19, 17, BORDER_BR);
        host.uiFill(1, 1, 18, 16, SPACE);
        let y = 2;
        this.stamp(host, 2, y, sv.name);
        this.stamp(host, 14, y, `<LV>${sv.level}`);
        y += 2;
        this.stamp(host, 2, y, `HP ${sv.hp}/${sv.maxHp}`);
        y += 1;
        this.stamp(host, 2, y, `STATUS ${sv.status ?? "OK"}`);
        y += 1;
        this.stamp(host, 2, y, `TYPE ${sv.types.join("/")}`);
        y += 2;
        this.stamp(host, 2, y, `ATK ${sv.stats.atk}`);
        this.stamp(host, 11, y, `DEF ${sv.stats.def}`);
        y += 1;
        this.stamp(host, 2, y, `SPD ${sv.stats.spd}`);
        this.stamp(host, 11, y, `SPC ${sv.stats.spc}`);
        y += 2;
        this.stamp(host, 2, y, "MOVES");
        y += 1;
        for (const mv of sv.moves as { name: string; pp: number }[]) {
          this.stamp(host, 3, y, mv.name);
          this.stamp(host, 15, y, `PP${mv.pp}`);
          y += 1;
        }
      }
      return;
    }
    if (this.summarySig !== null) {
      this.summarySig = null;
      host.uiClear();
      this.uiOwner = null;
      this.partySig = this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }

    const pv = (view as unknown as { party?: () => any }).party?.();
    if (pv) {
      const total = pv.entries.length + 1; // + CANCEL
      const sig = pv.entries
        .map((e: any) => `${e.name}${e.level}:${e.hp}/${e.maxHp}:${e.status ?? ""}`)
        .join(";") + `#${pv.index}|${pv.mode}|${pv.submenuIndex}|${pv.swapFrom}`;
      if (sig !== this.partySig) {
        this.partySig = sig;
        this.uiOwner = null;
        host.uiClear();
        // Two tile-rows per mon (name, then <LV>/HP), CANCEL last.
        const X = 0, Y = 0, W = 19, H = pv.entries.length * 2 + 1;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        const IY = Y + 1;
        pv.entries.forEach((e: any, i: number) => {
          const nameRow = IY + i * 2;
          const statRow = nameRow + 1;
          this.stamp(host, X + 2, nameRow, e.name);
          if (e.status) this.stamp(host, X + 14, nameRow, e.status);
          this.stamp(host, X + 3, statRow, `<LV>${e.level}`);
          const hp = `${e.hp}/${e.maxHp}`;
          this.stamp(host, X + W - hp.length, statRow, hp);
          if (i === pv.index) host.uiTile(X + 1, nameRow, ARROW_CURSOR);
        });
        const cancelRow = IY + pv.entries.length * 2;
        this.stamp(host, X + 2, cancelRow, "CANCEL");
        if (pv.index === pv.entries.length) {
          host.uiTile(X + 1, cancelRow, ARROW_CURSOR);
        }
        // the held mon during a SWITCH keeps a cursor so both slots are visible
        if (pv.swapFrom !== null && pv.swapFrom !== pv.index) {
          host.uiTile(X + 1, IY + pv.swapFrom * 2, ARROW_CURSOR);
        }
        // per-mon submenu: STATS / SWITCH / [CUT] / [FLASH] / CANCEL — see
        // partyscreen.ts's submenuItems() for which of CUT/FLASH show.
        // Height grows with the item count, anchored so it never runs off
        // the 18-row grid (UI_ROWS, spec.rs) even at the max 5 items.
        if (pv.mode === "submenu") {
          const items: string[] = pv.submenuItems;
          const sx = 10, sw = 9;
          const innerH = items.length * 2;
          const sy = Math.min(9, 16 - innerH);
          host.uiTile(sx, sy, BORDER_TL);
          host.uiFill(sx + 1, sy, sw - 1, 1, BORDER_H);
          host.uiTile(sx + sw, sy, BORDER_TR);
          host.uiFill(sx, sy + 1, 1, innerH, BORDER_V);
          host.uiFill(sx + sw, sy + 1, 1, innerH, BORDER_V);
          host.uiFill(sx + 1, sy + 1, sw - 1, innerH, SPACE);
          host.uiTile(sx, sy + 1 + innerH, BORDER_BL);
          host.uiFill(sx + 1, sy + 1 + innerH, sw - 1, 1, BORDER_H);
          host.uiTile(sx + sw, sy + 1 + innerH, BORDER_BR);
          items.forEach((label, i) => {
            this.stamp(host, sx + 3, sy + 2 + i * 2, label);
            if (i === pv.submenuIndex) host.uiTile(sx + 2, sy + 2 + i * 2, ARROW_CURSOR);
          });
        }
      }
      return;
    }
    if (this.partySig !== null) {
      this.partySig = null;
      host.uiClear();
      this.uiOwner = null;
      this.bagSig = this.menuSig = this.titleSig = this.namingSig = null;
    }

    const bg = (view as unknown as { bag?: () => any }).bag?.();
    if (bg) {
      // entries carry names+qty; CANCEL is the implicit last row (bagscreen.ts
      // counts it in its index range), and top/rows are the scroll window.
      const total = bg.entries.length + 1;
      const sig = `${bg.index},${bg.top},` +
        bg.entries.map((e: any) => `${e.name}\u00d7${e.qty}`).join(";");
      if (sig !== this.bagSig) {
        this.bagSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 2, Y = 2, W = 16, H = bg.rows * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        for (let r = 0; r < bg.rows; r++) {
          const li = bg.top + r;
          if (li >= total) break;
          const rowY = Y + 2 + r * 2;
          if (li < bg.entries.length) {
            const e = bg.entries[li];
            this.stamp(host, X + 2, rowY, e.name);
            const qs = `\u00d7${e.qty}`; // × + count, right-aligned
            this.stamp(host, X + W - qs.length, rowY, qs);
          } else {
            this.stamp(host, X + 2, rowY, "CANCEL");
          }
          if (li === bg.index) host.uiTile(X + 1, rowY, ARROW_CURSOR);
        }
        // more-arrow when there are rows below the window.
        if (bg.top + bg.rows < total) host.uiTile(X + W - 1, Y + H, ARROW_MORE);
      }
      return;
    }
    if (this.bagSig !== null) {
      // The bag owned the whole UI layer; clearing it leaves the layer blank,
      // so force whatever is under it (the start menu) to redraw — its own sig
      // is unchanged from before the bag opened and would otherwise no-op.
      this.bagSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.menuSig = this.titleSig = this.namingSig = null;
    }
    // POKéDEX (pokedexscreen.ts): list / side-menu / entry, all on the tile
    // layer; the DATA-page sprite rides the pic() layer under these tiles.
    const dx = (view as unknown as { pokedexScreen?: () => any }).pokedexScreen?.();
    if (dx) {
      let sig: string;
      if (dx.mode === "list") {
        sig = `L,${dx.index},${dx.top},${dx.entries.length}`;
      } else if (dx.mode === "submenu") {
        sig = `S,${dx.index},${dx.submenuIndex}`;
      } else {
        const e = dx.entry;
        sig = `E,${e ? e.name + "," + e.owned + "," + e.lines.length : "?"}`;
      }
      if (sig !== this.dexSig) {
        this.dexSig = sig;
        this.uiOwner = null;
        host.uiClear();
        if (dx.mode === "entry" && dx.entry) {
          const e = dx.entry;
          // right column beside the pic; flavor text fills the lower rows
          this.stamp(host, 9, 1, e.name);
          this.stamp(host, 9, 3, e.no);
          this.stamp(host, 9, 4, e.kind);
          if (e.height) this.stamp(host, 9, 6, e.height);
          if (e.weight) this.stamp(host, 9, 7, e.weight);
          e.lines.forEach((ln: string, i: number) => {
            if (i < 7) this.stamp(host, 1, 10 + i, ln);
          });
        } else {
          // list box (like the bag): a scroll window of dex rows + counts
          const X = 1, Y = 1, W = 17, H = dx.rows * 2;
          host.uiTile(X, Y, BORDER_TL);
          host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
          host.uiTile(X + W, Y, BORDER_TR);
          host.uiFill(X, Y + 1, 1, H, BORDER_V);
          host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
          host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
          host.uiTile(X, Y + 1 + H, BORDER_BL);
          host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
          host.uiTile(X + W, Y + 1 + H, BORDER_BR);
          this.stamp(host, 2, 0, "POKéDEX");
          for (let r = 0; r < dx.rows; r++) {
            const li = dx.top + r;
            if (li >= dx.entries.length) break;
            const row = dx.entries[li];
            const rowY = Y + 2 + r * 2;
            if (row.owned) this.stamp(host, X + 2, rowY, "*"); // owned marker
            this.stamp(host, X + 3, rowY, row.label);
            if (li === dx.index) host.uiTile(X + 1, rowY, ARROW_CURSOR);
          }
          if (dx.top + dx.rows < dx.entries.length) {
            host.uiTile(X + W - 1, Y + H, ARROW_MORE);
          }
          this.stamp(host, 2, Y + 2 + H, dx.footer);
          if (dx.mode === "submenu") {
            // DATA / CRY / QUIT popup, bottom-right (Menu tx=12,ty=8)
            const MX = 11, MY = 8, MW = 7, MH = dx.submenu.length * 2;
            host.uiTile(MX, MY, BORDER_TL);
            host.uiFill(MX + 1, MY, MW - 1, 1, BORDER_H);
            host.uiTile(MX + MW, MY, BORDER_TR);
            host.uiFill(MX, MY + 1, 1, MH, BORDER_V);
            host.uiFill(MX + MW, MY + 1, 1, MH, BORDER_V);
            host.uiFill(MX + 1, MY + 1, MW - 1, MH, SPACE);
            host.uiTile(MX, MY + 1 + MH, BORDER_BL);
            host.uiFill(MX + 1, MY + 1 + MH, MW - 1, 1, BORDER_H);
            host.uiTile(MX + MW, MY + 1 + MH, BORDER_BR);
            dx.submenu.forEach((s: string, i: number) => {
              this.stamp(host, MX + 2, MY + 2 + i * 2, s);
              if (i === dx.submenuIndex) host.uiTile(MX + 1, MY + 2 + i * 2, ARROW_CURSOR);
            });
          }
        }
      }
      return;
    }
    if (this.dexSig !== null) {
      this.dexSig = null;
      host.uiClear();
      this.uiOwner = null;
      this.menuSig = this.titleSig = this.namingSig = null;
    }
    // The out-of-battle replace-move list (ui/moveforget.ts): four moves and
    // a "DON'T LEARN" row.
    const mf = (view as unknown as { moveForget?: () => any }).moveForget?.();
    if (mf) {
      const rows: string[] = [...mf.moves, "DON'T LEARN"];
      const sig = `f${mf.index},${rows.length}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 6, W = 15, H = rows.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        rows.forEach((e: string, i: number) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e.slice(0, W - 2));
          if (i === mf.index) host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    // Debug map picker (ui/warppicker.ts). Full-width list, since map names
    // run long (ROCKET_HIDEOUT_ELEVATOR is 23 characters) and the start
    // menu's 10-wide box would truncate most of them.
    const wp = (view as unknown as { warpPicker?: () => any }).warpPicker?.();
    if (wp) {
      const sig = `w${wp.index},${wp.top},${wp.total}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const X = 0, Y = 0, W = 19, H = wp.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        wp.entries.forEach((e: string, i: number) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e.slice(0, W - 2));
          if (i === wp.index) host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    // The TRAINER CARD (ui/trainercard.ts, DrawTrainerInfo): the NAME/MONEY/
    // TIME card, the BADGES banner, then the eight numbered badge slots. The
    // original puts the player's front pic in the top card's right half; a
    // ScreenPic draws UNDER the ui layer (draw.rs rank 8 vs 9), so showing one
    // would mean leaving those cells unfilled and letting the overworld show
    // through behind him. The card is text-only instead.
    const tc = (view as unknown as { trainerCard?: () => any }).trainerCard?.();
    if (tc) {
      const owned = tc.badges.map((b: any) => (b.owned ? "1" : "0")).join("");
      const sig = `c${tc.name},${tc.money},${tc.time},${owned}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const W = 19;
        const box = (y: number, h: number): void => {
          host.uiTile(0, y, BORDER_TL);
          host.uiFill(1, y, W - 1, 1, BORDER_H);
          host.uiTile(W, y, BORDER_TR);
          host.uiFill(0, y + 1, 1, h, BORDER_V);
          host.uiFill(W, y + 1, 1, h, BORDER_V);
          host.uiFill(1, y + 1, W - 1, h, SPACE);
          host.uiTile(0, y + 1 + h, BORDER_BL);
          host.uiFill(1, y + 1 + h, W - 1, 1, BORDER_H);
          host.uiTile(W, y + 1 + h, BORDER_BR);
        };
        box(0, 3);
        this.stamp(host, 2, 1, `NAME/${tc.name}`);
        this.stamp(host, 2, 2, `MONEY/¥${tc.money}`);
        this.stamp(host, 2, 3, `TIME/${tc.time}`);
        box(5, 1);
        this.stamp(host, 7, 6, "BADGES");
        // One slot per row: eight rows is exactly what the screen has left,
        // and a two-column grid would run the 7-letter names together.
        box(8, 8);
        tc.badges.forEach((b: any, i: number) => {
          // An unearned badge keeps its number and hides its name, the way
          // the original's grid shows a blank numbered face.
          const label = b.owned ? b.name : ".".repeat(b.name.length);
          this.stamp(host, 2, 9 + i, `${b.n} ${label}`);
        });
      }
      return;
    }
    // The DEV submenu (ui/devmenu.ts). Same right-hand column as the start
    // menu it opens from, two tiles wider to fit RARE CANDY.
    const dv = (view as unknown as { devMenu?: () => any }).devMenu?.();
    if (dv) {
      const sig = `d${dv.index},${dv.entries.length}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const W = 12, X = 20 - W - 1, Y = 0, H = dv.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        dv.entries.forEach((e: string, i: number) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e);
          if (i === dv.index) host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    const sm = (view as unknown as { startMenu?: () => any }).startMenu?.();
    if (sm) {
      const sig = `${sm.index},${sm.entries.length}`;
      if (sig !== this.menuSig) {
        this.menuSig = sig;
        this.uiOwner = null;
        host.uiClear();
        const W = 10, X = 20 - W - 1, Y = 0, H = sm.entries.length * 2;
        host.uiTile(X, Y, BORDER_TL);
        host.uiFill(X + 1, Y, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y, BORDER_TR);
        host.uiFill(X, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + W, Y + 1, 1, H, BORDER_V);
        host.uiFill(X + 1, Y + 1, W - 1, H, SPACE);
        host.uiTile(X, Y + 1 + H, BORDER_BL);
        host.uiFill(X + 1, Y + 1 + H, W - 1, 1, BORDER_H);
        host.uiTile(X + W, Y + 1 + H, BORDER_BR);
        sm.entries.forEach((e: string, i: number) => {
          this.stamp(host, X + 2, Y + 2 + i * 2, e);
          if (i === sm.index) host.uiTile(X + 1, Y + 2 + i * 2, ARROW_CURSOR);
        });
      }
      return;
    }
    if (this.menuSig !== null) { this.menuSig = null; host.uiClear(); this.uiOwner = null; }
    const ttl = (view as unknown as { title?: () => any }).title?.();
    if (ttl) {
      const sig = `${ttl.phase},${ttl.index},${ttl.monPage}`;
      if (sig !== this.titleSig) {
        this.titleSig = sig;
        this.uiOwner = null;
        host.uiClear();
        if (ttl.phase === "press") {
          this.stamp(host, 5, 15, "PRESS START");
        } else {
          // Top-left, like the original's main menu box.
          const MX = 0, MY = 0, MW = 12;
          const MH = ttl.menu.length * 2;
          host.uiTile(MX, MY, BORDER_TL);
          host.uiFill(MX + 1, MY, MW - 1, 1, BORDER_H);
          host.uiTile(MX + MW, MY, BORDER_TR);
          host.uiFill(MX, MY + 1, 1, MH, BORDER_V);
          host.uiFill(MX + MW, MY + 1, 1, MH, BORDER_V);
          host.uiFill(MX + 1, MY + 1, MW - 1, MH, SPACE);
          host.uiTile(MX, MY + 1 + MH, BORDER_BL);
          host.uiFill(MX + 1, MY + 1 + MH, MW - 1, 1, BORDER_H);
          host.uiTile(MX + MW, MY + 1 + MH, BORDER_BR);
          ttl.menu.forEach((m: string, i: number) => {
            this.stamp(host, MX + 3, MY + 2 + i * 2, m);
            if (i === ttl.index) host.uiTile(MX + 2, MY + 2 + i * 2, ARROW_CURSOR);
          });
        }
      }
      return;
    }
    if (this.titleSig !== null) { this.titleSig = null; host.uiClear(); this.uiOwner = null; }
    const nam = view.naming();
    if (nam) {
      const v = nam.view();
      const sig = `${v.row},${v.col},${v.name},${v.grid[0]![0]}`;
      if (sig !== this.namingSig) {
        this.namingSig = sig;
        this.uiOwner = null;
        host.uiClear();
        // full-screen frame
        host.uiTile(0, 0, BORDER_TL);
        host.uiFill(1, 0, 18, 1, BORDER_H);
        host.uiTile(19, 0, BORDER_TR);
        host.uiFill(0, 1, 1, 16, BORDER_V);
        host.uiFill(19, 1, 1, 16, BORDER_V);
        host.uiTile(0, 17, BORDER_BL);
        host.uiFill(1, 17, 18, 1, BORDER_H);
        host.uiTile(19, 17, BORDER_BR);
        host.uiFill(1, 1, 18, 16, SPACE);
        this.stamp(host, 2, 1, v.title);
        this.stamp(host, 3, 3, v.name);
        host.uiFill(3 + v.name.length, 3, v.maxLen - v.name.length, 1, 0x76);
        for (let r = 0; r < v.grid.length; r++) {
          const row = v.grid[r]!;
          for (let c = 0; c < row.length; c++) {
            this.stamp(host, 2 + c * 2, 6 + r * 2, row[c]!);
          }
        }
        host.uiTile(1 + v.col * 2, 6 + v.row * 2, ARROW_CURSOR);
      }
      return;
    }
    if (this.namingSig !== null) {
      this.namingSig = null;
      host.uiClear();
      this.uiOwner = null;
    }
    const owner = view.uiBox();
    const choice = view.uiChoice();
    if (!owner) {
      if (this.uiOwner) {
        host.uiClear();
        this.uiOwner = null;
        this.uiRows = [];
        this.uiPage = -1;
        this.uiArrow = false;
        this.choiceDrawn = false;
      }
      return;
    }
    const box = owner.box;
    let textsEmitted = false;
    if (owner !== this.uiOwner) {
      // fresh box: border + white interior (Font.lua:407 drawBox as tiles)
      if (this.uiOwner) host.uiClear();
      this.uiOwner = owner;
      this.uiRows = [];
      this.uiPage = box.pageIndex;
      this.uiArrow = false;
      this.choiceDrawn = false;
      host.uiTile(BOX_TX, BOX_TY, BORDER_TL);
      host.uiFill(BOX_TX + 1, BOX_TY, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY, BORDER_TR);
      host.uiFill(BOX_TX, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiFill(BOX_TX + BOX_TW - 1, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiTile(BOX_TX, BOX_TY + BOX_TH - 1, BORDER_BL);
      host.uiFill(BOX_TX + 1, BOX_TY + BOX_TH - 1, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY + BOX_TH - 1, BORDER_BR);
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
    } else if (box.pageIndex !== this.uiPage) {
      // page advance: ClearScreenArea (TextBox.lua:295-301) as one fill
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
      this.uiRows = [];
      this.uiPage = box.pageIndex;
    }
    // rows: shown[0] at LINE1_Y, shown[1] at LINE2_Y. TextBox.lua:370 draws
    // EVERY retained line every frame, but `uiText` is the ONE live
    // typewriter run and the core keeps only the last (voxel-spec §ui), so a
    // finished row has to be stamped into the retained tile grid or it
    // disappears the moment the next line begins typing. Glyph codes ARE ui
    // tile ids under the GB convention, so the stamp is the encode.
    for (let i = 0; i < box.shown.length; i++) {
      const line = box.shown[i]!;
      const isLast = i === box.shown.length - 1;
      const y = i === 0 ? LINE1_Y : LINE2_Y;
      const cached = this.uiRows[i];
      // Identity hit: same ShownLine in the same role emits the same ops by
      // construction, so the encode + full-string compare (once EVERY tick a
      // box was open) both skip.
      if (cached && cached.line === line && cached.wasLast === isLast) {
        continue;
      }
      if (!isLast) {
        const codes = encodeGlyphs(line.text);
        for (let c = 0; c < codes.length; c++) host.uiTile(TEXT_X + c, y, codes[c]!);
        // a scroll must clear whatever the row above used to carry
        if (codes.length < MAX_COLS) {
          host.uiFill(TEXT_X + codes.length, y, MAX_COLS - codes.length, 1, SPACE);
        }
        this.uiRows[i] = { line, wasLast: isLast, text: line.text, revealed: -1 };
        continue;
      }
      const text = toCells(line.text);
      if (!cached || cached.text !== text) {
        host.uiText(TEXT_X, y, text);
        this.uiRows[i] = { line, wasLast: isLast, text, revealed: -1 };
        textsEmitted = true;
      } else {
        // Same text as the row already typing (a scrolled-in twin): the op
        // stream stays silent exactly as before — only the identity re-pins.
        cached.line = line;
        cached.wasLast = isLast;
      }
    }
    this.uiRows.length = box.shown.length;
    // reveal counter for the last row (fresh uiTexts re-target it)
    const last = box.shown[box.shown.length - 1];
    if (last) {
      const cached = this.uiRows[box.shown.length - 1];
      if (textsEmitted || cached.revealed !== last.revealed) {
        host.uiReveal(last.revealed);
        cached.revealed = last.revealed;
      }
    }
    // blinking ▼ (TextBox.lua:381; pokered prints at hlcoord 18,16)
    const arrow = box.arrowVisible() && !choice;
    if (arrow !== this.uiArrow) {
      if (arrow) {
        host.uiTile(ARROW_X, ARROW_Y, ARROW_MORE);
      } else {
        // restore what the second text row has under the arrow cell
        const under = box.shown[1];
        const codes = under ? encodeGlyphs(under.text) : [];
        const idx = ARROW_X - TEXT_X;
        const glyph = under && codes.length > idx && under.revealed > idx ? codes[idx] : SPACE;
        host.uiTile(ARROW_X, ARROW_Y, glyph);
      }
      this.uiArrow = arrow;
    }
    // YES/NO window over the still-visible text (Commands.lua ask ->
    // TextBox opts.choice). Placement approximates the reference ChoiceBox
    // (anchored above the dialogue box, right side).
    if (choice) {
      if (!this.choiceDrawn) {
        this.choiceDrawn = true;
        this.choiceYes = choice.yes;
        const cx = 14;
        const cy = 7;
        host.uiTile(cx, cy, BORDER_TL);
        host.uiFill(cx + 1, cy, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy, BORDER_TR);
        host.uiFill(cx, cy + 1, 1, 3, BORDER_V);
        host.uiFill(cx + 5, cy + 1, 1, 3, BORDER_V);
        host.uiTile(cx, cy + 4, BORDER_BL);
        host.uiFill(cx + 1, cy + 4, 4, 1, BORDER_H);
        host.uiTile(cx + 5, cy + 4, BORDER_BR);
        host.uiFill(cx + 1, cy + 1, 4, 3, SPACE);
        // static labels go into the grid, never through uiText (voxel-spec
        // §ui): a uiText here would take the live run away from the dialogue
        // row typing underneath it
        this.stamp(host, cx + 2, cy + 1, "YES");
        this.stamp(host, cx + 2, cy + 3, "NO");
        host.uiTile(cx + 1, choice.yes ? cy + 1 : cy + 3, ARROW_CURSOR);
      } else if (choice.yes !== this.choiceYes) {
        this.choiceYes = choice.yes;
        host.uiTile(15, choice.yes ? 10 : 8, SPACE);
        host.uiTile(15, choice.yes ? 8 : 10, ARROW_CURSOR);
      }
    } else if (this.choiceDrawn) {
      // the parent box usually pops with the choice; clear just the window
      // in case it lingers (tile 0 = unset)
      host.uiFill(14, 7, 6, 5, 0);
      this.choiceDrawn = false;
    }
  }
}
