// CHEATS: the gear app OPTION's CHEATS row turns on (ui/extras_layout.ts has
// the words, ../../../extras.ts what each one does).
//
//   the list      WILD ENCOUNTERS cycles NONE / LESS / NORMAL / MORE; the
//                 three toggles are ON/OFF pills; DEX FULL and GIVE ITEMS
//                 are buttons. The box at the foot says what the last row
//                 tapped does, or what an action just did.
//   DEX FULL      asks YES / NO, then fills the dex.
//   GIVE ITEMS    the item list in the bag's pockets, a page at a time; an
//                 item's page sets the quantity (key items and HMs: one),
//                 GIVE asks YES / NO, and the items go to the bag, or the PC
//                 when the bag has no room.
//
// Laid out on the gear's rules: labels at the left edge, values ending at
// the right one, a clear column between, pills the OPTIONS app's sizes.
import { UI_TILE } from "../../../../../contracts/spec/voxel-spec.ts";
import { ARROW_CURSOR } from "../../tiles.ts";
import { COLS, FILL_BIT, box, center, fill, fit, pill, pressedId, region, right, row, text, wrap } from "../draw.ts";
import { backRow, tabs, type GearCtx } from "../ui.ts";
import { POCKETS, fieldIdle, itemAbout, pocketOf } from "./bag.ts";
import { fillDex, giveItem, giveItemList, oneOnly, WILD_MODES, wildMode } from "../../../extras.ts";
import { CHEAT_ROWS, CHEAT_TEXT, WILD_LABELS, type CheatRowDef } from "../../extras_layout.ts";

/** ON/OFF pills: OFF with a clear column each side, ending at the right
 *  edge; the longest toggle label (INFINITE MONEY) keeps a column clear. */
const TOGGLE_X = 15;
const TOGGLE_W = 5;
/** DEX FULL's SET and GIVE ITEMS' OPEN: a column clear round OPEN. */
const ACTION_X = 14;
const ACTION_W = 6;
/** WILD ENCOUNTERS' value: the OPTIONS app's pill, under its label. */
const VALUE_X = 12;
const VALUE_W = 8;
/** Items a page of the GIVE ITEMS list holds (rows 1-12). */
export const GIVE_PAGE = 12;

function opts(ctx: GearCtx): Record<string, unknown> {
  return (ctx.save.options ??= {});
}

function aboutOf(ctx: GearCtx, r: CheatRowDef): string {
  if (typeof r.about === "string") return r.about;
  return r.about[wildMode(ctx.save)] ?? "";
}

export function drawCheats(ctx: GearCtx): void {
  const { ui } = ctx;
  if (ui.confirm) { drawConfirm(ctx); return; }
  if (ui.give) { drawGive(ctx); return; }
  drawList(ctx);
}

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

function drawList(ctx: GearCtx): void {
  const { host, ui } = ctx;
  const o = opts(ctx);
  let y = 1;
  CHEAT_ROWS.forEach((r, i) => {
    const pick = () => { ui.sel = i; ui.msg = null; };
    if (r.kind === "cycle") {
      // the label has the row to itself; its value sits under it, right
      text(host, 0, y, r.label);
      const cur = wildMode(ctx.save);
      pill(host, `cheat:${r.key}`, VALUE_X, y + 1, VALUE_W, WILD_LABELS[cur] ?? cur, () => {
        pick();
        o.wildEncounters = WILD_MODES[(WILD_MODES.indexOf(cur) + 1) % WILD_MODES.length];
      });
      y += 3;
      return;
    }
    text(host, 0, y, r.label);
    if (r.kind === "toggle") {
      const on = o[r.key] === true;
      pill(host, `cheat:${r.key}`, TOGGLE_X, y, TOGGLE_W, on ? "ON" : "OFF", () => {
        pick();
        o[r.key] = !on;
      }, on);
    } else {
      pill(host, `cheat:${r.key}`, ACTION_X, y, ACTION_W, r.button ?? "", () => {
        pick();
        if (r.key === "dexFull") ui.confirm = { kind: "dex" };
        else { ui.give = { pocket: "items", page: 0 }; }
      });
    }
    y += 2;
  });
  // what the last row tapped does, or what was just done
  box(host, 0, 14, COLS, 4);
  const said = ui.msg ?? aboutOf(ctx, CHEAT_ROWS[ui.sel ?? 0] ?? CHEAT_ROWS[0]!);
  wrap(said, 18).slice(0, 2).forEach((line, i) => text(host, 1, 15 + i, line));
}

// ---------------------------------------------------------------------------
// YES / NO
// ---------------------------------------------------------------------------

interface Confirm {
  kind: "dex" | "give";
  id?: string;
  qty?: number;
}

function drawConfirm(ctx: GearCtx): void {
  const { host, ui, data, save } = ctx;
  const c = ui.confirm as Confirm;
  const name = c.id ? (data.items?.[c.id]?.name ?? c.id) : "";
  const ask = c.kind === "dex" ? CHEAT_TEXT.dexAsk : CHEAT_TEXT.giveAsk(c.qty ?? 1, name);
  // the question over the mirror's own YES / NO box (gear/mirrors.ts)
  wrap(ask, 18).slice(0, 2).forEach((line, i) => center(host, 2 + i, line));
  box(host, 2, 5, 16, 10);
  pill(host, "cheat:yes", 4, 7, 12, CHEAT_TEXT.yes, () => {
    ui.confirm = null;
    if (c.kind === "dex") {
      fillDex(save, data);
      ui.msg = CHEAT_TEXT.dexDone;
      return;
    }
    const got = giveItem(save, data, c.id!, c.qty ?? 1);
    ui.giveMsg = got.refused === "have" ? CHEAT_TEXT.have
      : got.refused ? CHEAT_TEXT.full
      : got.pc === 0 ? CHEAT_TEXT.gaveBag(got.bag, name)
      : got.bag === 0 ? CHEAT_TEXT.gavePc(got.pc, name)
      : CHEAT_TEXT.gaveSplit(got.bag, got.pc);
  });
  pill(host, "cheat:no", 4, 11, 12, CHEAT_TEXT.no, () => { ui.confirm = null; });
}

// ---------------------------------------------------------------------------
// GIVE ITEMS
// ---------------------------------------------------------------------------

interface GiveUi {
  pocket: string;
  page: number;
  /** The item whose page is open, and the quantity set there. */
  item?: string;
  qty?: number;
}

/** The items GIVE ITEMS lists in one of the bag's pockets. */
export function givePocket(data: any, pocket: string): string[] {
  return giveItemList(data).filter((id) => pocketOf(data, id) === pocket);
}

function drawGive(ctx: GearCtx): void {
  const g = ctx.ui.give as GiveUi;
  if (g.item) { drawGiveItem(ctx, g); return; }
  const { host, data, save, ui } = ctx;
  const ids = givePocket(data, g.pocket);
  const pages = Math.max(1, Math.ceil(ids.length / GIVE_PAGE));
  g.page = Math.min(Math.max(0, g.page), pages - 1);
  ids.slice(g.page * GIVE_PAGE, (g.page + 1) * GIVE_PAGE).forEach((id, k) => {
    const y = 1 + k;
    const lit = pressedId() === `give:${id}`;
    if (lit) fill(host, 0, y, COLS, 1);
    const ink = lit ? "fill" : "dark";
    text(host, 1, y, fit(data.items?.[id]?.name ?? id, 13), ink);
    // what is held already, bag and PC together, at the right
    const have = (save.inventory?.[id] ?? 0) + (save.pcItems?.[id] ?? 0);
    if (have > 0) right(host, y, `x${have}`, ink);
    region(`give:${id}`, 0, y, COLS, 1, () => {
      g.item = id;
      g.qty = 1;
      ui.giveMsg = null;
    });
  });
  if (pages > 1) {
    pager(ctx, CHEAT_TEXT.page(g.page + 1, pages),
      () => { g.page = (g.page + pages - 1) % pages; },
      () => { g.page = (g.page + 1) % pages; }, 14);
  }
  tabs(ctx, POCKETS, g.pocket, (p) => { g.pocket = p; g.page = 0; }, 16);
  backRow(ctx, () => { ui.give = null; });
}

/** ◀ PAGE 1/5 ▶ on one row: the arrows as their own pills, the label
 *  between them in a bar of its own, a clear column either side. */
function pager(ctx: GearCtx, label: string, prev: () => void, next: () => void, y: number): void {
  const { host } = ctx;
  pill(host, "give:prev", 0, y, 3, "", prev);
  host.uiTileBottom(1, y, UI_TILE.arrowLeft | FILL_BIT);
  pill(host, "give:next", COLS - 3, y, 3, "", next);
  host.uiTileBottom(COLS - 2, y, ARROW_CURSOR | FILL_BIT);
  center(host, y, label, "dark", 4, COLS - 8);
}

function drawGiveItem(ctx: GearCtx, g: GiveUi): void {
  const { host, data, save, ui, game } = ctx;
  const id = g.item!;
  const one = oneOnly(data, id);
  const qty = one ? 1 : Math.max(1, Math.min(99, g.qty ?? 1));
  g.qty = qty;
  text(host, 1, 1, fit(data.items?.[id]?.name ?? id, 18));
  row(host, 3, "IN BAG", `x${save.inventory?.[id] ?? 0}`);
  row(host, 4, "IN PC", `x${save.pcItems?.[id] ?? 0}`);
  itemAbout(data, id).flatMap((l) => wrap(l, 18)).slice(0, 3).forEach((l, i) => text(host, 1, 6 + i, l));
  row(host, 10, CHEAT_TEXT.quantity, one ? CHEAT_TEXT.oneOnly : `x${qty}`);
  if (!one) {
    pager(ctx, `x${qty}`, () => { g.qty = qty <= 1 ? 99 : qty - 1; }, () => { g.qty = qty >= 99 ? 1 : qty + 1; }, 12);
    // the usual amounts, a segmented row like the pockets' tabs
    const w = Math.floor(COLS / CHEAT_TEXT.presets.length);
    CHEAT_TEXT.presets.forEach((n, i) => {
      pill(host, `give:q${n}`, i * w, 14, w, String(n), () => { g.qty = n; }, qty === n);
    });
  }
  if (ui.giveMsg) center(host, 16, fit(ui.giveMsg, 20));
  backRow(ctx, () => { g.item = undefined; ui.giveMsg = null; }, {
    label: CHEAT_TEXT.give,
    tap: () => {
      if (!fieldIdle(game)) { ui.giveMsg = CHEAT_TEXT.notNow; return; }
      ui.giveMsg = null;
      ui.confirm = { kind: "give", id, qty } satisfies Confirm;
    },
  });
}
