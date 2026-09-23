// The POKéMON screen. The party list (PartyMenu.lua DrawPartyMenu /
// ChooseNextMon :4097) plus a compact per-mon summary (StatusScreen /
// StatusScreen2). Reads save.party directly — the same party_struct the
// battle port already renders in battle/ui.ts.
import type { GameState } from "../game.ts";
import { expForLevel } from "../rules/growth.ts";
import type { PartyMon } from "../battle/mon.ts";
import { ESCAPE_ROPE_TILESETS } from "../rules/items.ts";
import { isOutside } from "../world/map.ts";

interface PartyGame {
  input: any;
  push(s: GameState): void;
  pop(): void;
  save: any;
  data: any;
  /** Closes every pushed menu down to the overworld — a field HM move
   * (CUT/FLASH) needs the menu gone before it runs. */
  closeToOverworld(): void;
  overworld: {
    runScript(rows: unknown[], onDone?: () => void): void;
    map?: { id: string; def: { tileset?: string } };
  };
  showText?(text: string, onDone?: () => void): void;
}

export interface PartyEntry {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  /** The species id, for the icon nook's pic. */
  species: string;
}

export interface PartyView {
  entries: PartyEntry[];
  index: number;
  mode: "list" | "submenu";
  submenuIndex: number;
  swapFrom: number | null;
  /** STATS, SWITCH, then CUT/FLASH if the selected mon knows them, then
   * CANCEL — the renderer (scene.ts) draws exactly this list, so the box
   * only needs to grow/shrink with it, never guess at its contents. */
  submenuItems: string[];
  /** The line in the bottom box: what this screen was opened FOR
   * (PartyMenuNormalText / PartyMenuSwapMonText / PartyMenuItemUseText). */
  prompt: string;
}

/** The status screen's pic: seven cells from (1,0) (status_screen.asm:170). */
export const SUMMARY_PIC_CELL = { x: 1, y: 0, w: 7, h: 7 } as const;

/** A party entry's icon nook: two cells at column 1 on the entry's rows. */
export function partyIconCell(i: number): { x: number; y: number; w: number; h: number } {
  return { x: 1, y: i * 2, w: 2, h: 2 };
}

/** The field moves offered outside battle (start_sub_menus.asm
 * .outOfBattleMovePointers, PartyMenu.lua's HM dispatch) — the HMs go to
 * world/script.ts's use_* verbs; SOFTBOILED is handled here. */
const FIELD_MOVES = ["CUT", "FLY", "SURF", "STRENGTH", "FLASH", "DIG", "TELEPORT", "SOFTBOILED"] as const;

export class PartyState implements GameState {
  readonly kind = "party";
  private index = 0;
  private mode: "list" | "submenu" = "list";
  private submenuIndex = 0;
  // PartyMenu.lua swapFrom: the first pick, held while choosing the partner.
  private swapFrom: number | null = null;

  /**
   * `opts.onPick` turns the screen into a chooser (PartyMenu.lua's
   * ChoosePokemon-for-an-item mode): picking a mon closes the screen and
   * hands its index back instead of opening the STATS/SWITCH submenu. The
   * bag uses it to pick who learns a TM/HM.
   *
   * `opts.onCancel` fires instead when the pick is backed out of. A caller
   * that yielded a script on the choice needs it -- without one, pressing B
   * would leave the runner waiting for a resume that never comes.
   */
  constructor(
    private game: PartyGame,
    private opts?: {
      onPick?: (index: number) => void;
      onCancel?: () => void;
      /** The bottom-box line for a chooser; PartyMenuItemUseText otherwise. */
      prompt?: string;
    },
  ) {}

  /** party_menu.asm PartyMenuMessage: the standard bottom text box's line. */
  private prompt(): string {
    const t = (this.game.data as { text?: Record<string, string> }).text ?? {};
    if (this.swapFrom !== null) return t._PartyMenuSwapMonText ?? "Move POKéMON\nwhere?";
    if (this.opts?.prompt) return this.opts.prompt;
    if (this.opts?.onPick) return t._PartyMenuItemUseText ?? "Use item on which\nPOKéMON?";
    return t._PartyMenuNormalText ?? "Choose a POKéMON.";
  }

  private party(): PartyMon[] {
    return (this.game.save.party ?? []) as PartyMon[];
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.mode === "submenu") return this.updateSubmenu(p);
    // No CANCEL row: the GB party menu has none, B is the way out.
    const n = Math.max(1, this.party().length);
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (p.b) {
      if (this.swapFrom !== null) { this.swapFrom = null; return; } // cancel the swap
      this.game.pop();
      this.opts?.onCancel?.();
      return;
    }
    if (p.a && this.index < this.party().length) {
      const pick = this.opts?.onPick;
      if (pick) {
        this.game.pop();
        pick(this.index);
        return;
      }
      if (this.swapFrom !== null) {
        // second pick: swap the two slots (PartyMenu.lua:563-566)
        if (this.swapFrom !== this.index) {
          const party = this.party();
          const tmp = party[this.swapFrom]!;
          party[this.swapFrom] = party[this.index]!;
          party[this.index] = tmp;
        }
        this.swapFrom = null;
      } else {
        this.mode = "submenu";
        this.submenuIndex = 0;
      }
    }
  }

  // PartyMenu.lua's HM submenu: STATS/SWITCH are always offered; CUT/FLASH
  // only appear when the mon the submenu was opened on actually knows them
  // (mon.moves, battle/mon.ts's MoveSlot.id — the same id space
  // constants.hmMoves would use if the cook ever populated it).
  private submenuItems(): string[] {
    const mon = this.party()[this.index];
    const knows = (id: string) => mon?.moves?.some((m) => m.id === id) ?? false;
    const items = ["STATS", "SWITCH"];
    for (const id of FIELD_MOVES) if (knows(id) && this.fieldMoveOffered(id)) items.push(id);
    items.push("CANCEL");
    return items;
  }

  /**
   * Where a move is even listed (start_sub_menus.asm): TELEPORT outdoors
   * only (CheckIfInOutsideMap), DIG in the ESCAPE ROPE's dungeon tilesets
   * minus Agatha's room -- .dig IS ItemUseEscapeRope -- and the rest
   * anywhere; their own verbs refuse on the tile.
   */
  private fieldMoveOffered(id: string): boolean {
    const map = this.game.overworld?.map;
    if (id === "TELEPORT") return !!map && isOutside(map.def as never);
    if (id === "DIG") {
      return !!map && ESCAPE_ROPE_TILESETS.has(map.def?.tileset ?? "") && map.id !== "AGATHAS_ROOM";
    }
    return true;
  }

  /**
   * Field SOFTBOILED (start_sub_menus.asm .softboiled): a fifth of the
   * user's max HP goes to a chosen teammate. The user needs that much to
   * give -- "Not enough HP!" -- and the taker must be someone else, standing,
   * and short of full, or "It won't have any effect."
   */
  private softboiled(): void {
    const party = this.party();
    const from = this.index;
    const user = party[from];
    if (!user) return;
    const share = Math.floor((user.stats?.hp ?? user.hp) / 5);
    if (user.hp < share || share <= 0) {
      this.game.showText?.("Not enough HP!");
      return;
    }
    this.game.push(new PartyState(this.game, {
      onPick: (i: number) => {
        const target = party[i];
        const max = target?.stats?.hp ?? target?.hp ?? 0;
        if (!target || i === from || target.hp <= 0 || target.hp >= max) {
          this.game.showText?.("It won't have any\neffect.");
          return;
        }
        user.hp -= share;
        target.hp = Math.min(max, target.hp + share);
      },
      onCancel: () => {},
    }));
  }

  private updateSubmenu(p: any): void {
    const items = this.submenuItems();
    const n = items.length;
    if (p.up) this.submenuIndex = (this.submenuIndex + n - 1) % n;
    if (p.down) this.submenuIndex = (this.submenuIndex + 1) % n;
    if (p.b) { this.mode = "list"; return; }
    if (!p.a) return;
    const label = items[this.submenuIndex];
    this.mode = "list";
    if (label === "STATS") this.game.push(new SummaryState(this.game, this.index));
    else if (label === "SWITCH") this.swapFrom = this.index;
    else if ((FIELD_MOVES as readonly string[]).includes(label!)) this.useFieldMove(label as (typeof FIELD_MOVES)[number]);
    // else CANCEL: already back to list
  }

  // PartyMenu.lua's HM dispatch: closes every menu on top of the overworld
  // (pokered backs all the way out too) and lets the move's own verb
  // (world/script.ts use_cut/use_flash) decide the effect and the text —
  // CUT checks the tile the player faces, FLASH just needs to run.
  private useFieldMove(moveId: (typeof FIELD_MOVES)[number]): void {
    const mon = this.party()[this.index];
    const name = mon?.nickname ?? this.game.data.pokemon?.[mon?.species]?.name ?? mon?.species ?? "";
    if (moveId === "SOFTBOILED") {
      this.softboiled();
      return;
    }
    this.game.closeToOverworld();
    const verb = {
      CUT: "use_cut", FLY: "use_fly", SURF: "use_surf",
      STRENGTH: "use_strength", FLASH: "use_flash",
      DIG: "use_dig", TELEPORT: "use_teleport",
    }[moveId];
    this.game.overworld.runScript([[verb, name]]);
  }

  view(): PartyView {
    const entries = this.party().map((m) => ({
      name: m.nickname ?? this.game.data.pokemon?.[m.species]?.name ?? m.species,
      species: m.species,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null,
    }));
    return {
      entries,
      index: this.index,
      mode: this.mode,
      submenuIndex: this.submenuIndex,
      swapFrom: this.swapFrom,
      submenuItems: this.submenuItems(),
      prompt: this.prompt(),
    };
  }
}

export interface SummaryView {
  name: string;
  species: string;
  /** The species id, for the pic. */
  speciesId: string;
  /** Pokedex number, three digits on the screen. */
  dex: number;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  types: string[];
  stats: { atk: number; def: number; spd: number; spc: number };
  moves: { name: string; pp: number; maxPp: number }[];
  /** StatusScreen (1) or StatusScreen2 (2): stats, then EXP and moves. */
  page: 1 | 2;
  exp: number;
  /** EXP to the next level, and that level; 0 / the cap at the cap. */
  expToNext: number;
  nextLevel: number;
  otName: string;
  otId: number;
}

/**
 * The two status pages (engine/menus/status_screen.asm StatusScreen and
 * StatusScreen2): A turns the page, A or B on the second closes, B on the
 * first closes too. The renderer (scene.ts) lays each page out on the GB's
 * own cells.
 */
export class SummaryState implements GameState {
  readonly kind = "summary";
  private page: 1 | 2 = 1;

  constructor(private game: PartyGame, private slot: number, private mon?: PartyMon) {}

  update(): void {
    const p = this.game.input.pressed;
    if (p.b) { this.game.pop(); return; }
    if (p.a) {
      if (this.page === 1) this.page = 2;
      else this.game.pop();
    }
  }

  view(): SummaryView {
    const m = this.mon ?? ((this.game.save.party ?? []) as PartyMon[])[this.slot];
    const def = this.game.data.pokemon?.[m.species];
    const moves = (m.moves ?? []).map((ms) => {
      const base = this.game.data.moves?.[ms.id]?.pp;
      const maxPp = typeof base === "number"
        ? base + ((ms as { ppUps?: number }).ppUps ?? 0) * Math.floor(base / 5)
        : ms.pp;
      return { name: this.game.data.moves?.[ms.id]?.name ?? ms.id, pp: ms.pp, maxPp };
    });
    const cap = (this.game.data as { constants?: { levelCap?: number } }).constants?.levelCap ?? 100;
    const nextLevel = Math.min(cap, m.level + 1);
    const expToNext = m.level < cap && def
      ? Math.max(0, expForLevel(def.growthRate, nextLevel) - (m.exp ?? 0))
      : 0;
    const player = (this.game.save as { player?: { name?: string; id?: number } }).player;
    return {
      name: m.nickname ?? def?.name ?? m.species,
      species: def?.name ?? m.species,
      speciesId: m.species,
      dex: def?.dex ?? 0,
      level: m.level,
      hp: m.hp,
      maxHp: m.stats?.hp ?? m.hp,
      status: m.status ?? null,
      types: def?.types ?? [],
      stats: {
        atk: m.stats?.attack ?? 0,
        def: m.stats?.defense ?? 0,
        spd: m.stats?.speed ?? 0,
        spc: m.stats?.special ?? 0,
      },
      moves,
      page: this.page,
      exp: m.exp ?? 0,
      expToNext,
      nextLevel,
      otName: player?.name ?? "RED",
      otId: player?.id ?? 0,
    };
  }
}
