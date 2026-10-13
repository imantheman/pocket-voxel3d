// COPY SAVE: the title's transfer between the Lua save and the VC title's
// cartridge save (Red, Blue, Yellow). The flow, its strings and its steps
// live here in one place; game.ts only supplies the I/O (CopyIo) and
// ui/title.ts the menu entry. The Gen 2 games mirror the same flow and
// strings.
//
// The flow, from the title's main menu (shown only when the VC title is on
// the console and at least one of the two saves holds a game):
//
//   COPY SAVE
//     -> a choice: LUA TO VC / VC TO LUA / CANCEL (a direction whose source
//        has no save is left out; B is CANCEL)
//     -> the confirm screen: the source's info box (the one CONTINUE shows)
//        under "COPY: LUA SAVE", the destination's under "REPLACE: VC SAVE"
//        ("TO: VC SAVE" and "(EMPTY)" when it holds no game), above
//        "Copy the LUA save\nover the VC save?" with YES/NO, the cursor on NO
//     -> YES: "Copying..." while the destination is backed up (the VC save
//        to vc_backup by the host inside its write; the Lua file to
//        save_backup, timestamped, the last ten kept), the save converted
//        and written
//     -> "Copied the save!" or a text box saying what failed, then the
//        title's menu again with CONTINUE's boxes read afresh.
//
// Every step goes to pvlog as "[pv] vc: copy: ...". A failure before the
// write writes nothing; a VC write that fails leaves the title's save as it
// was (the host commits only a write that reads back); a Lua write that
// fails has the old file in save_backup.

import { summaryLines, type SaveSummary } from "../ui/title.ts";

export type CopyDir = "lua-vc" | "vc-lua";

/** Every string the flow shows, by step. Text boxes are 18 columns wide;
 *  the info boxes 17. */
export const COPY_SAVE_TEXT = {
  /** The title menu's entry. */
  menu: "COPY SAVE",
  /** The choice it opens (the menu box fits nine columns). */
  choices: { "lua-vc": "LUA TO VC", "vc-lua": "VC TO LUA" } as Record<CopyDir, string>,
  cancel: "CANCEL",
  /** The confirm screen's headings over each info box. */
  from: { "lua-vc": "COPY: LUA SAVE", "vc-lua": "COPY: VC SAVE" } as Record<CopyDir, string>,
  over: { "lua-vc": "REPLACE: VC SAVE", "vc-lua": "REPLACE: LUA SAVE" } as Record<CopyDir, string>,
  overEmpty: { "lua-vc": "TO: VC SAVE", "vc-lua": "TO: LUA SAVE" } as Record<CopyDir, string>,
  empty: "(EMPTY)",
  /** The question, YES/NO with the cursor on NO. */
  ask: {
    "lua-vc": "Copy the LUA save\nover the VC save?",
    "vc-lua": "Copy the VC save\nover the LUA save?",
  } as Record<CopyDir, string>,
  /** Shown while it works. */
  working: "Copying...",
  done: "Copied the save!",
  /** A failure's first page, by step and direction; the reason follows on
   *  its own page, then `kept`. */
  failed: {
    read: { "lua-vc": "The LUA save could\nnot be read.", "vc-lua": "The VC save could\nnot be read." },
    backup: { "lua-vc": "The VC save could\nnot be backed up.", "vc-lua": "The LUA save could\nnot be backed up." },
    convert: { "lua-vc": "The save could not\nbe converted.", "vc-lua": "The save could not\nbe converted." },
    write: { "lua-vc": "The VC save did\nnot take it.", "vc-lua": "The LUA save could\nnot be written." },
  } as Record<CopyStage, Record<CopyDir, string>>,
  /** The last page of a failure: what became of the destination. */
  kept: {
    nothing: "Nothing was\ncopied.",
    "lua-vc": "The VC save is\nleft as it was.",
    "vc-lua": "A copy of the old\nLUA save is kept.",
  },
} as const;

export type CopyStage = "read" | "backup" | "convert" | "write";

export type CopyResult =
  | { ok: true }
  | { ok: false; stage: CopyStage; why: string; backedUp?: boolean };

/** The confirm screen's two info boxes, one line a row (17 columns). */
export function copyPanel(dir: CopyDir, src: SaveSummary, dst: SaveSummary | null): string[] {
  const T = COPY_SAVE_TEXT;
  return [
    T.from[dir],
    ...summaryLines(src),
    dst ? T.over[dir] : T.overEmpty[dir],
    ...(dst ? summaryLines(dst) : [`   ${T.empty}`]),
  ];
}

/** A reason as at most three 18-column lines. */
export function wrapWhy(why: string): string[] {
  const words = why.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > 18 && line) {
      lines.push(line);
      line = w.slice(0, 18);
    } else line = next.slice(0, 18);
    if (lines.length >= 3) { line = ""; break; }
  }
  if (line && lines.length < 3) lines.push(line);
  return lines;
}

/** What the player is told when it is over. */
export function copyMessage(dir: CopyDir, r: CopyResult): string {
  const T = COPY_SAVE_TEXT;
  if (r.ok) return T.done;
  const why = wrapWhy(r.why);
  // a failed Lua write over no Lua save had nothing to back up
  const kept = r.stage !== "write" || (dir === "vc-lua" && !r.backedUp) ? T.kept.nothing : T.kept[dir];
  return `${T.failed[r.stage][dir]}\f${why.length ? `${why.join("\n")}\f` : ""}${kept}`;
}

/** What a copy needs from the game and the host. */
export interface CopyIo {
  /** One pvlog line (the "[pv] vc: copy: " prefix is added here). */
  log(line: string): void;
  /** The Lua save's text on the card, or undefined. */
  luaText(): string | undefined;
  /** The VC title's cartridge save as it is now (null: no title). */
  vcBytes(): Uint8Array | null;
  /** Whether those bytes hold a game (a good main checksum). */
  vcHasGame(): boolean;
  /** The Lua text as this game's save table, made ready the way CONTINUE
   *  makes a loaded save ready. Throws on a save it cannot read. */
  readLua(text: string): Record<string, any>;
  /** The save table as a cartridge save over `template` (null: a fresh
   *  one), with the converter's notes. */
  toCart(save: Record<string, any>, template: Uint8Array | null): { bytes: Uint8Array; notes: string[] };
  /** Whether bytes are a cartridge save (main checksum right). */
  isCart(bytes: Uint8Array): boolean;
  /** The cartridge save as this game's save table, this game's own options
   *  kept from the Lua save. Throws on bytes it cannot read. */
  readCart(bytes: Uint8Array): { save: Record<string, any>; notes: string[] };
  /** The save table as Lua save text (and read back, to be sure). */
  toLua(save: Record<string, any>): string;
  /** Keep a copy of the Lua file as it is on the card now. */
  keepLua(): { ok: boolean; why?: string };
  writeLua(text: string): { ok: boolean; why?: string };
  /** The host backs the VC save up, writes, reads back and commits. */
  writeVc(bytes: Uint8Array): { ok: boolean; why?: string };
}

const msg = (e: unknown): string => String((e as Error)?.message ?? e ?? "").replace(/\s+/g, " ").trim() || "?";

/** One copy, start to end. Nothing is written unless every step before the
 *  write went through. */
export function runCopy(dir: CopyDir, io: CopyIo): CopyResult {
  const log = (s: string): void => io.log(`[pv] vc: copy: ${s}`);
  const fail = (stage: CopyStage, why: string, backedUp?: boolean): CopyResult => {
    log(`FAILED at ${stage}: ${why}; ${stage === "write" ? "the write did not take" : "nothing written"}`);
    return backedUp ? { ok: false, stage, why, backedUp } : { ok: false, stage, why };
  };
  const label = COPY_SAVE_TEXT.choices[dir];
  log(`${label}: start`);
  if (dir === "lua-vc") {
    const text = io.luaText();
    if (!text) return fail("read", "there is no LUA save");
    log(`reading the LUA save (${text.length} bytes)`);
    let save: Record<string, any>;
    try {
      save = io.readLua(text);
    } catch (e) {
      return fail("read", msg(e));
    }
    const p = save.player ?? {};
    log(`LUA save: ${p.name} at ${p.map} ${p.x},${p.y}; party ${save.party?.length ?? 0}`);
    const current = io.vcBytes();
    if (!current) return fail("write", "no VC title");
    const template = io.vcHasGame() ? current : null;
    log(`converting (${template ? "over the VC save's bytes" : "into a fresh cartridge save"})`);
    let bytes: Uint8Array;
    try {
      const w = io.toCart(save, template);
      for (const n of w.notes) log(`note: ${n}`);
      bytes = w.bytes;
    } catch (e) {
      return fail("convert", msg(e));
    }
    if (!io.isCart(bytes)) return fail("convert", "the new save fails its checksum");
    log(`converted: ${bytes.length} bytes, checksum ok`);
    log("writing the VC save (the host backs it up to vc_backup first)");
    const w = io.writeVc(bytes);
    if (!w.ok) return fail("write", w.why || "the VC save did not take it");
    log("done: the VC save is the LUA save's game");
    return { ok: true };
  }
  const bytes = io.vcBytes();
  if (!bytes || !io.vcHasGame()) return fail("read", "the VC save holds no game");
  log(`reading the VC save (${bytes.length} bytes)`);
  let save: Record<string, any>;
  try {
    const r = io.readCart(bytes);
    for (const n of r.notes) log(`note: ${n}`);
    save = r.save;
  } catch (e) {
    return fail("read", msg(e));
  }
  const p = save.player ?? {};
  log(`VC save: ${p.name} at ${p.map} ${p.x},${p.y}; party ${save.party?.length ?? 0}`);
  let text: string;
  try {
    text = io.toLua(save);
  } catch (e) {
    return fail("convert", msg(e));
  }
  log(`converted: ${text.length} bytes of LUA save`);
  const had = !!io.luaText();
  if (had) {
    log("backing up the LUA save to save_backup");
    const k = io.keepLua();
    if (!k.ok) return fail("backup", k.why || "the copy did not take");
    log("backed up");
  } else log("no LUA save to back up");
  log("writing the LUA save");
  const w = io.writeLua(text);
  if (!w.ok) return fail("write", w.why || "the SD card did not take it", had);
  log("done: the LUA save is the VC save's game");
  return { ok: true };
}
