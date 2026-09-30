// BAG: the bag in pockets (ITEMS, BALLS, KEY, TM/HM), what each thing does,
// and USE -- through the game's own item code, exactly as the top screen's
// bag would: a field item acts on the world, a medicine asks which mon.
import * as Bag from "../../../rules/bag.ts";
import * as Items from "../../../rules/items.ts";
import { COLS, center, fit, pressedId, region, right, text, wrap } from "../draw.ts";
import { moveEffectLines } from "../model.ts";
import { backRow, tabs, type GearCtx } from "../ui.ts";
import { drawPartyGrid } from "./party.ts";

const POCKETS = [
  { id: "items", label: "ITEM" },
  { id: "balls", label: "BALL" },
  { id: "key", label: "KEY" },
  { id: "tms", label: "TM" },
];

const FIELD_USE = new Set([
  "BICYCLE", "POKE_FLUTE", "OLD_ROD", "GOOD_ROD", "SUPER_ROD",
  "REPEL", "SUPER_REPEL", "MAX_REPEL", "ESCAPE_ROPE", "COIN_CASE", "TOWN_MAP", "ITEMFINDER",
]);

function pocketOf(data: any, id: string): string {
  const it = data.items?.[id] ?? {};
  if (it.machine || /^(TM|HM)\d/.test(id)) return "tms";
  if (Items.isBall(id)) return "balls";
  if (it.keyItem) return "key";
  return "items";
}

/** What an item does, worked out from the game's own tables. */
export function itemAbout(data: any, id: string): string[] {
  const it = data.items?.[id] ?? {};
  const heal = Items.HEAL_AMOUNT[id];
  if (heal) return [`RESTORES ${heal} HP.`];
  if (id === "MAX_POTION") return ["FULLY RESTORES HP."];
  if (id === "FULL_RESTORE") return ["FULLY RESTORES HP", "AND HEALS STATUS."];
  if (id === "REVIVE") return ["REVIVES A FAINTED", "POKéMON TO HALF HP."];
  if (id === "MAX_REVIVE") return ["REVIVES A FAINTED", "POKéMON TO FULL HP."];
  const cure = Items.STATUS_HEAL[id];
  if (cure) return cure.length > 1 ? ["HEALS ANY STATUS", "PROBLEM."] : [`HEALS ${cure[0]}.`];
  const vit = Items.VITAMINS[id];
  if (vit) return [`RAISES ${vit.toUpperCase()} (STAT EXP).`];
  const rep = Items.REPELS[id];
  if (rep) return [`KEEPS WEAK WILD POKéMON`, `AWAY FOR ${rep} STEPS.`];
  const x = Items.X_ITEMS[id];
  if (x) return [`RAISES ${x.toUpperCase()} IN BATTLE.`];
  if (Items.isStone(id)) return ["MAKES CERTAIN POKéMON", "EVOLVE."];
  if (Items.isBall(id)) {
    return {
      POKE_BALL: ["CATCHES WILD POKéMON."],
      GREAT_BALL: ["BETTER THAN A", "POKé BALL."],
      ULTRA_BALL: ["BETTER THAN A", "GREAT BALL."],
      MASTER_BALL: ["NEVER FAILS."],
      SAFARI_BALL: ["FOR THE SAFARI ZONE."],
    }[id] ?? ["CATCHES WILD POKéMON."];
  }
  const own: Record<string, string[]> = {
    RARE_CANDY: ["RAISES LEVEL BY ONE."],
    ESCAPE_ROPE: ["LEADS OUT OF CAVES", "AND BUILDINGS."],
    PP_UP: ["RAISES ONE MOVE'S", "MAX PP."],
    ETHER: ["RESTORES 10 PP TO", "ONE MOVE."],
    MAX_ETHER: ["RESTORES ALL PP TO", "ONE MOVE."],
    ELIXER: ["RESTORES 10 PP TO", "EVERY MOVE."],
    MAX_ELIXER: ["RESTORES ALL PP TO", "EVERY MOVE."],
    X_ACCURACY: ["NEVER MISS IN BATTLE."],
    DIRE_HIT: ["RAISES CRITICAL HITS."],
    GUARD_SPEC: ["BLOCKS STAT DROPS."],
    POKE_DOLL: ["ESCAPES A WILD BATTLE."],
    BICYCLE: ["RIDE FASTER THAN", "YOU CAN WALK."],
    OLD_ROD: ["FISH IN WATER", "YOU FACE."],
    GOOD_ROD: ["FISH IN WATER", "YOU FACE."],
    SUPER_ROD: ["FISH IN WATER", "YOU FACE."],
    ITEMFINDER: ["FINDS HIDDEN ITEMS", "NEARBY."],
    COIN_CASE: ["HOLDS YOUR COINS."],
    TOWN_MAP: ["SHOWS WHERE YOU ARE."],
  };
  if (own[id]) return own[id]!;
  const mv = it.machine?.move;
  if (mv) {
    const d = data.moves?.[mv] ?? {};
    return [`TEACHES ${d.name ?? mv}.`, `${d.type ?? ""} PWR ${d.power || "--"}`, ...moveEffectLines(mv, d)];
  }
  if (it.keyItem) return ["AN IMPORTANT ITEM."];
  return it.price ? [`SELLS FOR ¥${Math.floor(it.price / 2)}.`] : [];
}

/** The overworld is idle: nothing on the stack above it, no script going. */
export function fieldIdle(game: any): boolean {
  const top = game.stack?.[game.stack.length - 1];
  return top?.kind === "overworld" && !game.overworld?.runner?.isRunning?.() && !game.battleView?.();
}

export function drawBag(ctx: GearCtx): void {
  const { host, data, save, ui, game } = ctx;
  const pocket = ui.pocket ?? "items";
  if (ui.pickFor) {
    // which mon to use it on
    const id = ui.pickFor as string;
    text(host, 0, 1, fit(`USE ${data.items?.[id]?.name ?? id} ON?`, 20));
    drawPartyGrid(ctx, -1, (i) => {
      ui.pickFor = null;
      if (data.items?.[id]?.machine) game.teachMachine?.(i, id);
      else game.useItem?.(i, id);
    });
    backRow(ctx, () => { ui.pickFor = null; });
    return;
  }
  const ids = Bag.order(save).filter((id) => pocketOf(data, id) === pocket && (save.inventory?.[id] ?? 0) > 0);
  if (ui.item && !ids.includes(ui.item)) ui.item = null;
  if (ui.item) {
    const id = ui.item as string;
    text(host, 1, 2, fit(data.items?.[id]?.name ?? id, 13));
    right(host, 2, `x${save.inventory?.[id] ?? 0}`);
    itemAbout(data, id).flatMap((l) => wrap(l, 18)).slice(0, 6).forEach((l, i) => text(host, 1, 4 + i, l));
    const usable = FIELD_USE.has(id) || Items.needsTarget(data, id);
    if (ui.msg) center(host, 12, ui.msg);
    backRow(ctx, () => { ui.item = null; ui.msg = null; }, usable ? {
      label: "USE",
      tap: () => {
        if (!fieldIdle(game)) { ui.msg = "NOT NOW!"; return; }
        ui.msg = null;
        if (FIELD_USE.has(id)) { game.closeToOverworld?.(); game.useKeyItem?.(id); ui.item = null; }
        else ui.pickFor = id;
      },
    } : undefined);
    return;
  }
  if (ids.length === 0) center(host, 8, "NOTHING IN HERE");
  const top = Math.min(ui.top ?? 0, Math.max(0, ids.length - 14));
  ids.slice(top, top + 14).forEach((id, k) => {
    const y = 1 + k;
    const lit = pressedId() === `bag:${id}`;
    text(host, 1, y, fit(data.items?.[id]?.name ?? id, 13), lit ? "fill" : "dark");
    if (pocket !== "key") right(host, y, `x${save.inventory?.[id] ?? 0}`, lit ? "fill" : "dark");
    region(`bag:${id}`, 0, y, COLS, 1, () => { ui.item = id; });
  });
  if (ids.length > 14) {
    region("bag:more", 0, 15, COLS, 1, () => { ui.top = top + 14 >= ids.length ? 0 : top + 14; });
    center(host, 15, top + 14 >= ids.length ? "BACK TO TOP" : "MORE...");
  }
  tabs(ctx, POCKETS, pocket, (p) => { ui.pocket = p; ui.top = 0; });
}
