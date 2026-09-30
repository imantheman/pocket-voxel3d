// NOTES: your own notes, kept in the save -- TEXT (typed on an on-screen
// keyboard, QWERTY or QWERTZ from OPTIONS), LIST (a checklist) and SKETCH
// (drawn with the stylus in three inks).
//
// The sketch pad is an 80x50 grid of 4px cells, stored run-length in the
// save, and drawn as one rect per run of ink along a row.
import {
  COLS, ROWS, TILE_H, center, dragPx, fit, pill, pressedId, rect, region, text, width, wrap,
} from "../draw.ts";
import type { GearNote } from "../model.ts";
import { backRow, type GearCtx } from "../ui.ts";

const MAX_NOTES = 12;
const LINE_W = 18;

export function drawNotes(ctx: GearCtx): void {
  const { ui, gear } = ctx;
  const note: GearNote | undefined = typeof ui.open === "number" ? gear.notes[ui.open] : undefined;
  if (!note) { ui.open = null; drawList(ctx); return; }
  if (note.kind === "text") drawText(ctx, note);
  else if (note.kind === "list") drawChecklist(ctx, note);
  else drawSketch(ctx, note);
}

function drawList(ctx: GearCtx): void {
  const { host, gear, ui } = ctx;
  if (gear.notes.length === 0) {
    center(host, 5, "NO NOTES YET.");
    center(host, 7, "START ONE BELOW.");
  }
  gear.notes.slice(0, MAX_NOTES).forEach((n, i) => {
    const y = 1 + i;
    const lit = pressedId() === `note:${i}`;
    const tag = { text: "TXT", list: "LST", sketch: "ART" }[n.kind];
    text(host, 0, y, tag, lit ? "fill" : "dark");
    text(host, 4, y, fit(n.title || "(EMPTY)", 16), lit ? "fill" : "dark");
    region(`note:${i}`, 0, y, COLS, 1, () => { ui.open = i; ui.sel = null; ui.typing = false; });
  });
  if (gear.notes.length < MAX_NOTES) {
    const add = (kind: GearNote["kind"]) => {
      gear.notes.push({ kind, title: kind === "sketch" ? "SKETCH" : "", lines: kind === "text" ? [""] : [] });
      ui.open = gear.notes.length - 1;
      ui.typing = kind !== "sketch";
      ui.sel = null;
    };
    text(host, 0, 15, "NEW NOTE:");
    pill(host, "notes:text", 0, 17, 6, "TEXT", () => add("text"));
    pill(host, "notes:list", 7, 17, 6, "LIST", () => add("list"));
    pill(host, "notes:sketch", 14, 17, 6, "SKETCH", () => add("sketch"));
  }
}

function deleteNote(ctx: GearCtx): void {
  ctx.gear.notes.splice(ctx.ui.open, 1);
  ctx.ui.open = null;
}

// ---------------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------------

function drawText(ctx: GearCtx, note: GearNote): void {
  const { host, ui } = ctx;
  // the note, word-wrapped, last lines showing if it runs long
  const lines = note.lines.flatMap((l) => wrap(l, LINE_W));
  const shown = ui.typing ? 7 : 15;
  lines.slice(-shown).forEach((l, i) => text(host, 1, 1 + i, l));
  if (ui.typing) {
    const last = lines[lines.length - 1] ?? "";
    const cy = 1 + Math.min(lines.length, shown) - 1;
    text(host, 1 + width(last), Math.max(1, cy), "_");
    keyboard(ctx, (k) => {
      if (k === "DEL") {
        const cur = note.lines[note.lines.length - 1] ?? "";
        if (cur.length > 0) note.lines[note.lines.length - 1] = cur.slice(0, -1);
        else if (note.lines.length > 1) note.lines.pop();
      } else if (k === "NL") {
        if (note.lines.length < 40) note.lines.push("");
      } else if (k === "OK") {
        ui.typing = false;
      } else {
        const cur = note.lines[note.lines.length - 1] ?? "";
        if (cur.length < 120) note.lines[note.lines.length - 1] = cur + k;
      }
      note.title = (note.lines.find((l) => l.trim()) ?? "").trim().slice(0, 16);
    });
    return;
  }
  backRow(ctx, () => { ctx.ui.open = null; }, { label: "EDIT", tap: () => { ui.typing = true; } });
  pill(host, "note:delete", 14, 16, 6, "DELETE", () => deleteNote(ctx));
}

// ---------------------------------------------------------------------------
// the keyboard (rows 10..16)
// ---------------------------------------------------------------------------

const ROWS_ABC = ["QWERTYUIOP", "ASDFGHJKL-", "ZXCVBNM,.?"];
const ROWS_123 = ["1234567890", "!?:;/()'-.", "é♂♀×&,.  "];

function keyboard(ctx: GearCtx, press: (k: string) => void): void {
  const { host, ui, gear } = ctx;
  let rows = ui.nums ? ROWS_123 : ROWS_ABC;
  if (!ui.nums && gear.qwertz) rows = rows.map((r) => r.replace("Y", "#").replace("Z", "Y").replace("#", "Z"));
  rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch === " ") return;
      pill(host, `key:${r}:${c}`, c * 2, 10 + r * 2, 2, ch, () => press(ch));
    });
  });
  pill(host, "key:mode", 0, 16, 4, ui.nums ? "ABC" : "123", () => { ui.nums = !ui.nums; });
  pill(host, "key:space", 4, 16, 6, "SPACE", () => press(" "));
  pill(host, "key:del", 10, 16, 3, "DEL", () => press("DEL"));
  pill(host, "key:nl", 13, 16, 3, "NL", () => press("NL"));
  pill(host, "key:ok", 16, 16, 4, "OK", () => press("OK"));
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

function drawChecklist(ctx: GearCtx, note: GearNote): void {
  const { host, ui } = ctx;
  note.done ??= [];
  if (ui.typing) {
    const draft: string = ui.draft ?? "";
    text(host, 0, 1, "NEW ITEM:");
    text(host, 1, 3, fit(draft, LINE_W) + "_");
    keyboard(ctx, (k) => {
      if (k === "DEL") ui.draft = draft.slice(0, -1);
      else if (k === "NL" || k === "OK") {
        if (draft.trim()) { note.lines.push(draft.trim()); note.done!.push(false); }
        ui.draft = "";
        ui.typing = k === "NL";
      } else if (draft.length < 30) ui.draft = draft + k;
      if (!note.title && note.lines[0]) note.title = note.lines[0].slice(0, 16);
    });
    return;
  }
  note.lines.slice(0, 13).forEach((item, i) => {
    const y = 1 + i;
    const sel = ui.sel === i;
    text(host, 0, y, note.done![i] ? "[×]" : "[ ]");
    region(`chk:${i}`, 0, y, 3, 1, () => { note.done![i] = !note.done![i]; });
    text(host, 4, y, fit(item, 16), sel ? "fill" : "dark");
    region(`chkline:${i}`, 3, y, COLS - 3, 1, () => { ui.sel = sel ? null : i; });
  });
  if (note.lines.length === 0) center(host, 6, "ADD SOMETHING TO DO");
  pill(host, "chk:add", 0, 16, 6, "ADD", () => { ui.typing = true; ui.draft = ""; });
  if (typeof ui.sel === "number") {
    pill(host, "chk:remove", 7, 16, 6, "REMOVE", () => {
      note.lines.splice(ui.sel, 1);
      note.done!.splice(ui.sel, 1);
      ui.sel = null;
    });
  }
  pill(host, "note:delete", 14, 16, 6, "DELETE", () => deleteNote(ctx));
  backRow(ctx, () => { ctx.ui.open = null; });
}

// ---------------------------------------------------------------------------
// SKETCH
// ---------------------------------------------------------------------------

export const PAD_W = 80;
export const PAD_H = 50;
const CELL = 4;
const PAD_X = 0;
const PAD_Y = Math.ceil(TILE_H) + 2;

/** Run-length ink: "<shade><count>" pairs, shade 0..3 as one digit. */
export function encodeInk(cells: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < cells.length) {
    const v = cells[i]!;
    let n = 1;
    while (i + n < cells.length && cells[i + n] === v && n < 9999) n++;
    out += `${v}${n.toString(36)}.`;
    i += n;
  }
  return out;
}

export function decodeInk(s: string | undefined): Uint8Array {
  const cells = new Uint8Array(PAD_W * PAD_H);
  if (!s) return cells;
  let at = 0;
  for (const run of s.split(".")) {
    if (!run) continue;
    const v = Number(run[0]);
    const n = parseInt(run.slice(1), 36);
    for (let k = 0; k < n && at < cells.length; k++) cells[at++] = v;
  }
  return cells;
}

/** The pad being drawn on, decoded once and written back as it changes. */
const pads = new WeakMap<GearNote, Uint8Array>();

function padOf(note: GearNote): Uint8Array {
  let p = pads.get(note);
  if (!p) { p = decodeInk(note.ink); pads.set(note, p); }
  return p;
}

function drawSketch(ctx: GearCtx, note: GearNote): void {
  const { host, ui } = ctx;
  const pad = padOf(note);
  const ink: number = ui.ink ?? 3;
  // the paper's edge, then the ink, a rect per run along each row
  rect(host, PAD_X, PAD_Y - 1, PAD_W * CELL, 1, 2);
  rect(host, PAD_X, PAD_Y + PAD_H * CELL, PAD_W * CELL, 1, 2);
  let rects = 0;
  for (let y = 0; y < PAD_H && rects < 700; y++) {
    let x = 0;
    while (x < PAD_W) {
      const v = pad[y * PAD_W + x]!;
      if (v === 0) { x++; continue; }
      let n = 1;
      while (x + n < PAD_W && pad[y * PAD_W + x + n] === v) n++;
      rect(host, PAD_X + x * CELL, PAD_Y + y * CELL, n * CELL, CELL, v);
      rects++;
      x += n;
    }
  }
  // the stylus: a line from where it was to where it is, two cells thick
  dragPx("sketch:pad", PAD_X, PAD_Y, PAD_W * CELL, PAD_H * CELL, (px, py, start) => {
    const cx = Math.floor((px - PAD_X) / CELL);
    const cy = Math.floor((py - PAD_Y) / CELL);
    const from: [number, number] = start || !ui.last ? [cx, cy] : ui.last;
    stroke(pad, from[0], from[1], cx, cy, ink === 0 ? 0 : ink);
    ui.last = [cx, cy];
    note.ink = encodeInk(pad);
  });
  const y = ROWS - 1;
  pill(host, "ink:dark", 0, y, 4, "INK", () => { ui.ink = 3; }, ink === 3);
  pill(host, "ink:grey", 4, y, 4, "GREY", () => { ui.ink = 2; }, ink === 2);
  pill(host, "ink:erase", 8, y, 4, "RUB", () => { ui.ink = 0; }, ink === 0);
  pill(host, "ink:clear", 12, y, 4, "WIPE", () => { pad.fill(0); note.ink = encodeInk(pad); });
  pill(host, "ink:back", 16, y, 4, "BACK", () => { ui.open = null; });
}

function stroke(pad: Uint8Array, x0: number, y0: number, x1: number, y1: number, v: number): void {
  const dot = (x: number, y: number) => {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < PAD_W && py < PAD_H) pad[py * PAD_W + px] = v;
      }
    }
  };
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (let guard = 0; guard < 400; guard++) {
    dot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
