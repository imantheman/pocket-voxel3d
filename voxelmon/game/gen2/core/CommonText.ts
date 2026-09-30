// gen1recomp src/core/gen2/CommonText.lua at bdfac727 (MIT): the strings an
// ENGINE routine prints (`ld hl, .SomeText / call PrintText`), looked up by
// their pokegold label through text.labels[label] -> "bank:addr" key.
//
// `pages` puts a decoded stream into the speech box's shape (home/text.asm):
//   \n  `line` / `next`: the box's second row.
//   \f  `para`: the box clears; the next screenful starts empty.
//   \v  `cont`: the box scrolls one row, so the new page's first line repeats
//       the previous page's second.
// `fill` substitutes {STRBUF} / {NUM} in order of appearance, plus {PLAYER}
// and {RIVAL}.

import { tostring } from "../platform/lua.ts";

/** One page: one or two lines. */
export type TextPage = string[];

/**
 * fill's values: consumed in order by {STRBUF}/{NUM} (values[0] first, the
 * Lua's values[1]); `player` / `rival` for the named markers.
 */
export interface FillValues {
  [i: number]: unknown;
  player?: unknown;
  rival?: unknown;
}

export const CommonText = {
  /**
   * Lua: CommonText.lua:31 -- the decoded string for a pokegold label, or
   * undefined (no seed in this cache, or an empty string).
   */
  get(text: any, label: string | null | undefined): string | undefined {
    if (text === null || typeof text !== "object" || label == null) return undefined;
    const labels = text.labels;
    const key = labels !== null && typeof labels === "object" ? labels[label] : undefined;
    const body = key != null ? text[key] : undefined;
    if (typeof body !== "string" || body === "") return undefined;
    return body;
  },

  /** Lua: CommonText.lua:41 -- ../pokecrystal/home/text.asm:548 PromptText, :566 DoneText. */
  plain<T>(body: T): T {
    if (typeof body !== "string") return body;
    return body.split("{DONE}").join("").split("{PROMPT}").join("") as unknown as T;
  },

  /** Lua: CommonText.lua:47 -- pages of one or two lines, or undefined for no text. */
  pages(body: string | null | undefined): TextPage[] | undefined {
    body = CommonText.plain(body);
    if (typeof body !== "string" || body === "") return undefined;
    const text: string = body;
    const out: TextPage[] = [];
    let top = "";
    let bottom: string | undefined;
    const flush = () => {
      if (bottom !== undefined) {
        out.push([top, bottom]);
      } else {
        out.push([top]);
      }
    };
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i).search(/[\n\f\v]/);
      const marker = rest < 0 ? undefined : i + rest;
      const chunk = text.slice(i, marker ?? text.length);
      if (bottom !== undefined) {
        bottom = bottom + chunk;
      } else {
        top = top + chunk;
      }
      if (marker === undefined) break;
      const m = text[marker];
      if (m === "\n") {
        bottom = bottom ?? "";
      } else if (m === "\f") {
        flush();
        top = "";
        bottom = undefined;
      } else { // "\v"
        flush();
        top = bottom ?? "";
        bottom = "";
      }
      i = marker + 1;
    }
    flush();
    return out;
  },

  /** Lua: CommonText.lua:87 -- fill the markers, one pass in order of appearance. */
  fill(pages: TextPage[] | null | undefined, values?: FillValues | null): TextPage[] | undefined {
    if (!pages) return undefined;
    const vals: FillValues = values || {};
    let next = 1;
    const marker = (name: string): string => {
      if (name === "PLAYER" || name === "RIVAL") {
        const v = name === "PLAYER" ? vals.player : vals.rival;
        return v != null && v !== false ? tostring(v) : "{" + name + "}";
      }
      if (name !== "STRBUF" && name !== "NUM") return "{" + name + "}";
      const v = vals[next - 1];
      next = next + 1;
      return v != null ? tostring(v) : "";
    };
    const out: TextPage[] = [];
    for (const page of pages) {
      if (page == null) break; // ipairs
      const lines: string[] = [];
      for (const line of page) {
        if (line == null) break; // ipairs
        lines.push(line.replace(/\{([A-Z]+)\}/g, (_m, name: string) => marker(name)));
      }
      out.push(lines);
    }
    return out;
  },

  /** Lua: CommonText.lua:117 -- the whole lookup; undefined means "use your own transcription". */
  of(text: any, label: string, values?: FillValues | null): TextPage[] | undefined {
    const pages = CommonText.pages(CommonText.get(text, label));
    if (!pages) return undefined;
    if (values) return CommonText.fill(pages, values);
    return pages;
  },
};

export default CommonText;
