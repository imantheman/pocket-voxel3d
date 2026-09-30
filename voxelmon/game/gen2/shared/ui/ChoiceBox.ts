// gen1recomp src/ui/ChoiceBox.lua (bdfac727): the YES/NO box.

import G from "../../platform/screen.ts";
import { Font } from "../render/Font.ts";
import { Sound } from "../core/Sound.ts";
import { Strings } from "../core/Strings.ts";
import { Timing } from "../core/Timing.ts";
import { UIVisibility } from "../battle/UIVisibility.ts";
import { Theme } from "./Theme.ts";

export interface ChoiceOpts {
  defaultNo?: boolean;
  noSound?: boolean;
  anchor?: unknown;
  box?: { tx: number; ty: number; tw: number; th: number; firstItem?: number };
  tx?: number;
  ty?: number;
  tw?: number;
  th?: number;
  labels?: [string, string];
  firstItem?: number;
}

export class ChoiceBox {
  game: any;
  onChoose: (yes: boolean) => void;
  /** 1 YES, 2 NO (the Lua's). */
  index: number;
  noSound: boolean;
  anchor: unknown;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  labels: [string, string];
  firstItem: number;
  pending: boolean | null = null;
  holdFrames = 0;

  constructor(game: any, onChoose: (yes: boolean) => void, opts: ChoiceOpts = {}) {
    this.game = game;
    this.onChoose = onChoose;
    this.index = opts.defaultNo ? 2 : 1;
    this.noSound = opts.noSound ?? false;
    this.anchor = opts.anchor ?? null;
    const box = opts.box ?? Theme.choiceBox;
    this.tx = opts.tx ?? box.tx;
    this.ty = opts.ty ?? box.ty;
    this.tw = opts.tw ?? box.tw;
    this.th = opts.th ?? box.th;
    this.labels = opts.labels ?? ["YES", "NO"];
    this.firstItem = opts.firstItem ?? box.firstItem ?? 1;
  }

  static new(game: any, onChoose: (yes: boolean) => void, opts?: ChoiceOpts): ChoiceBox {
    return new ChoiceBox(game, onChoose, opts);
  }

  update(_dt?: number): void {
    const input = this.game.input;
    if (this.pending !== null) {
      this.holdFrames -= 1;
      if (this.holdFrames <= 0) {
        const yes = this.pending;
        this.pending = null;
        this.game.stack.pop();
        this.onChoose(yes);
      }
      return;
    }
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.index = this.index === 1 ? 2 : 1;
    } else if (input.wasPressed("a")) {
      if (!this.noSound) Sound.play(this.game.data, "Press_AB");
      this.pending = this.index === 1;
      this.holdFrames = Timing.YES_NO_ANSWER;
    } else if (input.wasPressed("b")) {
      if (!this.noSound) Sound.play(this.game.data, "Press_AB");
      this.index = 2;
      this.pending = false;
      this.holdFrames = Timing.YES_NO_ANSWER;
    }
  }

  draw(): void {
    if (!UIVisibility.bottomVisible(this, false)) return;
    const { tx, ty, tw, th } = this;
    const paper = this.game?.textboxPaper?.();
    Font.drawBox(tx, ty, tw, th, paper);
    G.setColor(0, 0, 0, 1);
    const row = this.firstItem;
    Font.draw(Strings.get(this.labels[0]), (tx + 2) * 8, (ty + row) * 8);
    Font.draw(Strings.get(this.labels[1]), (tx + 2) * 8, (ty + row + 2) * 8);
    Font.drawCode(Theme.cursor, (tx + 1) * 8, (ty + row + (this.index === 1 ? 0 : 2)) * 8);
    G.setColor(1, 1, 1, 1);
  }
}

export default ChoiceBox;
