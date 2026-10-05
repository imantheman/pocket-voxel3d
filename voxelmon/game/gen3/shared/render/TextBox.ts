// Port of gen1recomp src/render/TextBox.lua (GPLv3 + additional terms; see LICENSE.md).
// SURFACE ONLY: TextBox is the Gen 1 / Gen 2 host's dialogue box (drawn with
// src.render.Font, timed by src.core.Timing, voiced by src.core.Sound, with
// src.ui.ChoiceBox and src.script.Tokens). FireRed draws its text with
// ui/message and ui/frlg_font instead. The game3 runtime reaches TextBox in
// one place:
// - scripting/adapters.lua:562 askYesNo's last host fallback,
//   `g.stack:push(TextBox.new(g, question, nil, { instant, choice,
//   choiceLabels, choiceBox = Theme.healCancelBox }))`, taken only when the
//   game3 Runtime is not active and the world has no askYesNo (never, on the
//   3DS: Game3 runs standalone and answers yes/no with ui/choice).
// NOT FAITHFUL: TextBox.new is that host box and stops with NotPortedError if
// ever reached (porting it means porting the Gen 1 render stack).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { notPorted } from "../../notported.ts";

export class TextBox {
  [key: string]: any;
  static [key: string]: any;

  // Lua: TextBox.lua:129
  static new(_game: any, _text: any, _onDone?: any, _opts?: any): TextBox {
    return notPorted("TextBox.new (NOT FAITHFUL: Gen 1/2 host text box)");
  }
}

export default TextBox;
