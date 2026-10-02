// The link battle record on the Pokecenter 2F's sign: `special
// DisplayLinkRecord` -> _DisplayLinkRecord (engine/link/link.asm,
// ReadAndPrintLinkBattleRecord), then WaitPressAorB_BlinkCursor.
//
//   hlcoord 1, 0    "<PLAYER>'s RECORD"
//   hlcoord 0, 2    "TOTAL  WIN LOSE DRAW"
//   hlcoord 6, 4    the totals, four digits each at columns 6 / 11 / 16
//   hlcoord 0, 6    "RESULT WIN LOSE DRAW"
//   hlcoord 0, 8    five rows of two lines: the opponent's name, then their
//                   counts on the next line at columns 6 / 11 / 16; an empty
//                   row prints "  ---" over "-    -    -"
//
// SCGB_DIPLOMA colours it (the diploma's palette set 0, attrmap zeroed).

import { Chrome } from "./Chrome.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Strings } from "../shared/core/Strings.ts";
import { LinkRecords, NUM_LINK_BATTLE_RECORDS, type LinkRecordTable } from "../core/LinkRecords.ts";
import G from "../platform/screen.ts";

const TEXT_RECORD = Strings.source("%s's RECORD");
const TEXT_TOTAL = Strings.source("TOTAL  WIN LOSE DRAW");
const TEXT_RESULT = Strings.source("RESULT WIN LOSE DRAW");

export interface LinkRecordOpts {
  onClose?: () => void;
}

export class LinkRecord {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;
  screenId = "Gen2LinkRecord";

  game: any;
  table: LinkRecordTable = { win: 0, lose: 0, draw: 0, rows: [] };
  playerName = "?";
  onClose?: () => void;
  done = false;

  wantsFillScale(): boolean {
    return true;
  }

  static new(game: any, opts?: LinkRecordOpts): LinkRecord {
    const self = new LinkRecord();
    self.game = game;
    self.table = LinkRecords.of(game?.save);
    self.playerName = game?.save?.player?.name ?? "?";
    self.onClose = opts?.onClose;
    return self;
  }

  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (input.wasPressed("a") || input.wasPressed("b")) {
      this.done = true;
      if (this.onClose) this.onClose();
    }
  }

  palette(): any {
    const gfx = this.game?.data?.gen2Diploma;
    return (gfx && gfx.palettes && gfx.palettes[0]) || Chrome.DEFAULT_BOX_PALETTE;
  }

  /** The text lines, by row and column (the tests read these). */
  lines(): [number, number, string][] {
    const t = this.table;
    const n = (v: number): string => Chrome.number(v, 4);
    const out: [number, number, string][] = [
      [1, 0, Strings.get(TEXT_RECORD, this.playerName)],
      [0, 2, Strings.get(TEXT_TOTAL)],
      [6, 4, n(t.win)], [11, 4, n(t.lose)], [16, 4, n(t.draw)],
      [0, 6, Strings.get(TEXT_RESULT)],
    ];
    for (let i = 0; i < NUM_LINK_BATTLE_RECORDS; i++) {
      const y = 8 + i * 2;
      const r = t.rows[i];
      if (r) {
        out.push([0, y, r.name], [6, y + 1, n(r.win)], [11, y + 1, n(r.lose)], [16, y + 1, n(r.draw)]);
      } else {
        out.push([0, y, "  ---"], [9, y + 1, "-"], [14, y + 1, "-"], [19, y + 1, "-"]);
      }
    }
    return out;
  }

  drawPanel(): void {
    const palette = this.palette();
    const paper = GbcPalette.color(palette, 1);
    G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    G.setColor(1, 1, 1, 1);
    for (const [x, y, s] of this.lines()) Chrome.printThrough(s, x, y, palette);
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
