// The SYNC screen for Red, Blue and Yellow (sync/model.ts holds the logic;
// scene.ts draws `view()`): pushed over the title from its SYNC row, popped
// by B or BACK, after which the title reads the save again.
import type { GameState } from "../game.ts";
import { decodeSave } from "../save-read.ts";
import { hostSync, SyncModel, syncAccepts, wrongGame, type SyncNative } from "../sync/model.ts";

export interface SyncView {
  title: string;
  /** The host's counters, right of the title (`S2 O0`), or "". */
  diag: string;
  /** The rows shown (already scrolled), the cursor's index among them,
   *  and which can be picked. */
  rows: string[];
  cursor: number;
  pickable: boolean[];
  more: { up: boolean; down: boolean };
  status: string[];
}

/** Rows the list shows at once. */
export const SYNC_ROWS = 5;
/** Characters a row has (the frame, the cursor column and a margin aside). */
export const SYNC_COLS = 16;

/** A received Gen 1 save, read with CONTINUE's own reader. */
export function validateGen1(game: string, text: string): string | null {
  let s: unknown;
  try {
    s = decodeSave(text);
  } catch {
    return "NOT A SAVE";
  }
  if (!s || typeof s !== "object" || Array.isArray(s)) return "NOT A SAVE";
  const v = (s as { version?: unknown }).version;
  if (!syncAccepts(game, v)) return wrongGame(v);
  const p = (s as { player?: unknown }).player;
  if (!p || typeof p !== "object") return "NOT A SAVE";
  return null;
}

export class SyncState implements GameState {
  readonly kind = "sync";
  readonly model: SyncModel;

  constructor(
    private game: { input: any; pop(): void },
    gameToken: string,
    private onClose: (installed: boolean) => void,
    native: SyncNative | null = hostSync(),
  ) {
    this.model = new SyncModel({ game: gameToken, native, validate: (t) => validateGen1(gameToken, t) });
    this.model.open();
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.model.update({ up: p.up, down: p.down, a: p.a, b: p.b }) === "close") {
      this.game.pop();
      this.onClose(this.model.installed);
    }
  }

  view(): SyncView {
    const m = this.model;
    const all = m.rowText(SYNC_COLS);
    const top = m.scrollTop(SYNC_ROWS);
    const rows = all.slice(top, top + SYNC_ROWS);
    return {
      title: m.title,
      diag: m.diag(),
      rows,
      cursor: m.index - top,
      pickable: m.rows.slice(top, top + SYNC_ROWS).map((r) => r.kind !== "other"),
      more: { up: top > 0, down: top + SYNC_ROWS < all.length },
      status: m.statusLines(18, 2),
    };
  }
}
