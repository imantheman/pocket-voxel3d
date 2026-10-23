// SYNC for Gold, Silver and Crystal (not on the cart): the main menu's row
// that moves a save to or from the PC/phone games on the same wifi. The
// logic is shared with the Gen 1 games (../../sync/model.ts); this draws it
// on the Gold screen: the list in a box over the top, the status line in
// the text box under it. B or BACK closes every socket and returns to a
// main menu that reads the save again.

import { Chrome } from "./Chrome.ts";
import G from "../platform/screen.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { SaveSerializer } from "../shared/core/SaveSerializer.ts";
import { hostSync, SyncModel, syncAccepts, wrongGame, type SyncNative } from "../../sync/model.ts";

/** Rows the list shows at once, and the characters each has. */
const ROWS = 5;
const COLS = 16;

export interface SyncScreenOpts {
  onClose?: (installed: boolean) => void;
  /** Tests: a stand-in for the host's natives. */
  native?: SyncNative | null;
}

/** A received Gen 2 save, read with CONTINUE's own reader. */
export function validateGen2(game: string, text: string): string | null {
  const [save] = SaveSerializer.decodeWithError(text);
  if (!save || typeof save !== "object" || Array.isArray(save)) return "NOT A SAVE";
  const v = (save as { version?: unknown }).version;
  if (!syncAccepts(game, v)) return wrongGame(v);
  return null;
}

export class SyncScreen {
  static isOpaque = true;
  isOpaque = true;
  screenId = "Gen2Sync";
  game: any;
  model!: SyncModel;
  onClose?: (installed: boolean) => void;
  done = false;

  wantsFillScale(): boolean {
    return true;
  }

  static new(game: any, opts: SyncScreenOpts = {}): SyncScreen {
    const self = new SyncScreen();
    self.game = game;
    self.onClose = opts.onClose;
    const token = String(GameVersion.get());
    self.model = new SyncModel({
      game: token,
      native: opts.native !== undefined ? opts.native : hostSync(),
      validate: (t) => validateGen2(token, t),
    });
    self.model.open();
    return self;
  }

  update(_dt?: number): void {
    const input = this.game?.input;
    if (!input || this.done) return;
    const r = this.model.update({
      up: input.wasPressed("up"),
      down: input.wasPressed("down"),
      a: input.wasPressed("a"),
      b: input.wasPressed("b"),
    });
    if (r === "close") {
      this.done = true;
      this.onClose?.(this.model.installed);
    }
  }

  drawPanel(): void {
    const m = this.model;
    Chrome.clear();
    G.setColor(1, 1, 1, 1);
    Chrome.box(0, 0, Chrome.SCREEN_W, 13);
    Chrome.print(m.title, 2, 1);
    const diag = m.diag();
    if (diag) Chrome.print(diag, Chrome.SCREEN_W - 1 - diag.length, 1);
    const all = m.rowText(COLS);
    const top = m.scrollTop(ROWS);
    all.slice(top, top + ROWS).forEach((text, i) => {
      Chrome.print(text, 3, 3 + i * 2);
      if (top + i === m.index && m.rows[top + i]?.kind !== "other") Chrome.cursor(2, 3 + i * 2);
    });
    Chrome.box(0, 13, Chrome.SCREEN_W, 5);
    m.statusLines(18, 2).forEach((l, i) => Chrome.print(l, 1, 14 + i * 2));
  }

  draw(): void {
    this.drawPanel();
  }

  drawsWidescreen(): boolean {
    return true;
  }

  drawWidescreen(_winW: number, _winH: number): void {
    G.setColor(1, 1, 1, 1);
    G.push();
    G.origin();
    this.drawPanel();
    G.pop();
  }
}

export default SyncScreen;
