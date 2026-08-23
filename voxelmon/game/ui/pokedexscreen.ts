// The POKéDEX. Ported from gen1recomp src/ui/PokedexMenu.lua (the dex-ordered
// contents list with seen/owned markers + SEEN/OWN counts) and
// src/ui/DexEntryMenu.lua (the DATA page: sprite, name, kind, height/weight and
// the flavor description, all gated on the mon being owned). The reference
// nests ListMenu > Menu(DATA/CRY/AREA/QUIT) > DexEntryMenu; the port folds that
// into one State with three modes, the same way boxscreen.ts collapses the
// reference's PC menu stack.
//
// Deviations from the reference, all dependency-driven:
//   * AREA is dropped — it opens the Town Map (Screens.push "TownMap"), which
//     the port has no screen for yet. DATA/CRY/QUIT are faithful.
//   * PRNT is Yellow-only (Game Boy Printer) and out of scope on Red/Blue.
//   * The owned marker is a text glyph, not the GB pokéball tile (the UI atlas
//     has no pokéball); swap OWNED_MARK for a real tile id if one is cooked.
import { picPageFor } from "../battle/staging.ts";
import type { GameState } from "../game.ts";
import type { SpeciesDef, VoxelmonData } from "../data.ts";

interface DexGame {
  input: { pressed: Partial<Record<string, boolean>> };
  push(s: GameState): void;
  pop(): void;
  playCry?(species: string): void;
  save: any;
  data: VoxelmonData;
}

// PokedexMenu.lua ROWS budget (ListMenu ROWS = 7) and the owned marker.
const ROWS = 7;
const OWNED_MARK = "*";

export interface DexRow {
  n: number;
  label: string; // "### NAME" (seen/owned) or "### -----" (unseen)
  owned: boolean;
  value: string | null; // species id when seen/owned, else null (unselectable)
}

export interface DexView {
  mode: "list" | "submenu" | "entry";
  // list
  rows: number;
  top: number;
  index: number;
  entries: DexRow[];
  footer: string; // "SEEN nnn  OWN nnn"
  // submenu
  submenuIndex: number;
  submenu: string[];
  // entry
  entry: DexEntryView | null;
}

export interface DexEntryView {
  name: string;
  no: string; // "No.###"
  kind: string; // species category, e.g. "SEED"
  owned: boolean;
  height: string | null; // "HT n'nn\"" when owned
  weight: string | null; // "WT n.nlb" when owned
  lines: string[]; // flavor text lines, or ["Data unknown."]
  spritePage: number; // picPageFor(...) or -1
}

export class PokedexState implements GameState {
  readonly kind = "pokedex";
  private mode: "list" | "submenu" | "entry" = "list";
  private index = 0; // into entries
  private top = 0; // scroll window start
  private submenuIndex = 0;
  private entrySpecies: string | null = null;

  private entries: DexRow[] = [];
  private seen = 0;
  private owned = 0;
  private digits: number;
  // PokedexMenu.lua side menu: DATA / CRY / QUIT (AREA dropped, see header).
  private static SUBMENU = ["DATA", "CRY", "QUIT"];

  constructor(
    private game: DexGame,
    private onCancel?: () => void,
  ) {
    const data = game.data;
    const dex = game.save?.pokedex ?? { seen: {}, owned: {} };
    const constants = (data as VoxelmonData & { constants?: any }).constants ?? {};
    this.digits = constants.dexDigits ?? 3;
    const size = constants.dexSize ?? 151;

    // PokedexMenu.lua: index species by dex number, then walk 1..size in order.
    const byDex: Record<number, SpeciesDef> = {};
    const mons = data.pokemon as Record<string, SpeciesDef>;
    for (const id in mons) {
      const def = mons[id];
      if (def?.dex) byDex[def.dex] = def;
    }
    for (let n = 1; n <= size; n++) {
      const def = byDex[n];
      if (!def) continue;
      const isOwned = !!dex.owned?.[def.id];
      const isSeen = isOwned || !!dex.seen?.[def.id];
      if (isOwned) this.owned += 1;
      if (isSeen) this.seen += 1;
      const num = String(n).padStart(this.digits, "0");
      this.entries.push({
        n,
        label: isSeen ? `${num} ${def.name}` : `${num} -----`,
        owned: isOwned,
        value: isSeen ? def.id : null,
      });
    }
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "entry") {
      // DexEntryMenu.lua:update — A or B pops the page back to the side menu.
      if (p.a || p.b) this.mode = "submenu";
      return;
    }
    if (this.mode === "submenu") return this.updateSubmenu(p);
    this.updateList(p);
  }

  private updateList(p: Partial<Record<string, boolean>>): void {
    const n = this.entries.length;
    if (n === 0) {
      if (p.a || p.b) this.close();
      return;
    }
    if (p.up) this.index = Math.max(0, this.index - 1);
    else if (p.down) this.index = Math.min(n - 1, this.index + 1);
    // pageJump: Left/Right move a page at a time (PokedexMenu.lua pageJump).
    else if (p.left) this.index = Math.max(0, this.index - ROWS);
    else if (p.right) this.index = Math.min(n - 1, this.index + ROWS);
    this.syncScroll();
    if (p.b) {
      this.close();
      return;
    }
    if (p.a) {
      // Only seen/owned entries open the side menu (item.value gate).
      if (this.entries[this.index]?.value) {
        this.submenuIndex = 0;
        this.mode = "submenu";
      }
    }
  }

  private updateSubmenu(p: Partial<Record<string, boolean>>): void {
    const items = PokedexState.SUBMENU;
    if (p.up) this.submenuIndex = (this.submenuIndex + items.length - 1) % items.length;
    if (p.down) this.submenuIndex = (this.submenuIndex + 1) % items.length;
    if (p.b) {
      this.mode = "list";
      return;
    }
    if (!p.a) return;
    const value = this.entries[this.index]?.value;
    if (!value) {
      this.mode = "list";
      return;
    }
    switch (items[this.submenuIndex]) {
      case "DATA":
        this.entrySpecies = value;
        this.mode = "entry";
        break;
      case "CRY":
        // PokedexMenu.lua CRY keepOpen: play the cry, stay on the side menu.
        this.game.playCry?.(value);
        break;
      case "QUIT":
        // .exitPokedex: drop the whole dex back to whoever opened it.
        this.close();
        break;
    }
  }

  private close(): void {
    this.game.pop();
    if (this.onCancel) this.onCancel();
  }

  private syncScroll(): void {
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
  }

  private buildEntry(): DexEntryView | null {
    const id = this.entrySpecies;
    if (!id) return null;
    const def = this.game.data.pokemon[id] as SpeciesDef | undefined;
    if (!def) return null;
    const e = def.dexEntry ?? ({} as NonNullable<SpeciesDef["dexEntry"]>);
    const owned = !!this.game.save?.pokedex?.owned?.[id];
    const num = String(def.dex ?? 0).padStart(this.digits, "0");
    // DexEntryMenu.lua: height/weight/description print only once owned.
    let height: string | null = null;
    let weight: string | null = null;
    if (owned && e.heightFt !== undefined) {
      height = `HT ${e.heightFt}'${String(e.heightIn ?? 0).padStart(2, "0")}"`;
      weight = `WT ${((e.weight ?? 0) / 10).toFixed(1)}lb`;
    }
    let lines: string[] = ["Data unknown."];
    const textStore = (this.game.data as VoxelmonData & { text?: Record<string, unknown> }).text;
    // e.text is a key into data.text (mirrors Bryan); fall back to a raw string.
    const raw = owned && e.text ? ((textStore?.[e.text] as string) ?? e.text) : null;
    if (raw) {
      lines = String(raw)
        .replace(/[\f\v]/g, "\n")
        .split("\n")
        .filter((l) => l.length > 0);
    }
    return {
      name: def.name,
      no: `No.${num}`,
      kind: e.kind ?? "?",
      owned,
      height,
      weight,
      lines,
      spritePage: picPageFor(this.game.data, id),
    };
  }

  view(): DexView {
    return {
      mode: this.mode,
      rows: ROWS,
      top: this.top,
      index: this.index,
      entries: this.entries,
      footer: `SEEN ${String(this.seen).padStart(3)}  OWN ${String(this.owned).padStart(3)}`,
      submenuIndex: this.submenuIndex,
      submenu: PokedexState.SUBMENU,
      entry: this.mode === "entry" ? this.buildEntry() : null,
    };
  }
}
