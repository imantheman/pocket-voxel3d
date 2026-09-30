// gen1recomp src/core/RomText.lua at bdfac727 (MIT): the line the game
// itself prints (data.text[label], the importer's rom_text table), with the
// engine's wording as backup. The extracted text's slots ({USER}, {TARGET},
// the {RAM:...} buffers) are filled here in argument order; {PLAYER} and
// {RIVAL} only when the caller clearly supplies them (an argument count that
// matches every slot), and anything else falls back to the literal.
//
// The Lua module IS the function (`return function(data, label, fallback,
// ...)`), so this module exports the function under the same name.

import { Strings } from "./Strings.ts";
import { tostring } from "../../platform/lua.ts";

// Lua `%b{}`: a balanced {...} run (the extracted text never nests them).
const TOKEN = /\{[^{}]*\}/g;

// Lua: RomText.lua:30-72
export function RomText(data: any, label: string, fallback: string, ...args: unknown[]): string {
  const text: unknown = data && data.text && data.text[label];
  if (typeof text !== "string") return Strings.get(fallback, ...args);
  if (args.length === 0) return text;

  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === "object") {
    const values = first as Record<string, unknown>;
    return text.replace(TOKEN, (token) => {
      const value = values[token] ?? values[token.slice(1, -1)];
      return value == null ? token : tostring(value);
    });
  }

  const ENDINGS: Record<string, boolean> = { "{DONE}": true, "{PROMPT}": true };
  let slots = 0;
  let named = 0;
  for (const token of text.match(TOKEN) ?? []) {
    if (!ENDINGS[token]) {
      slots += 1;
      if (token === "{PLAYER}" || token === "{RIVAL}") named += 1;
    }
  }
  let fillNamed: boolean;
  if (args.length === slots) fillNamed = true;
  else if (args.length === slots - named) fillNamed = false;
  else return Strings.get(fallback, ...args);

  let index = 0;
  return text.replace(TOKEN, (token) => {
    if (ENDINGS[token]) return token;
    if (!fillNamed && (token === "{PLAYER}" || token === "{RIVAL}")) return token;
    index += 1;
    const value = args[index - 1];
    if (value == null) return token;
    return tostring(value);
  });
}

export default RomText;
