// TOOLS: the bike, the rods and the team's field moves, one tap each. A
// tool shows once it could work (the item in the bag; the move in the party
// with the badge that allows it outside battle -- the mod's unlock rule) and
// runs through the same code the menus would, so it says and does what the
// game says and does.
import { center, fit, pill, text } from "../draw.ts";
import { TOOLS, knowerOf, toolUnlocked } from "../model.ts";
import { backRow, type GearCtx } from "../ui.ts";
import { fieldIdle } from "./bag.ts";
import { drawPartyGrid, monName } from "./party.ts";

const VERB: Record<string, string> = {
  CUT: "use_cut", FLY: "use_fly", SURF: "use_surf", STRENGTH: "use_strength",
  FLASH: "use_flash", DIG: "use_dig", TELEPORT: "use_teleport",
};

export function drawTools(ctx: GearCtx): void {
  const { host, save, ui } = ctx;
  if (typeof ui.softFrom === "number") { drawSoftboiled(ctx, ui.softFrom); return; }
  const open = TOOLS.filter((t) => toolUnlocked(t, save));
  if (open.length === 0) {
    center(host, 7, "NO TOOLS YET.");
    center(host, 9, "A BIKE, A ROD OR A");
    center(host, 10, "FIELD MOVE WILL SHOW");
    center(host, 11, "UP HERE.");
    return;
  }
  open.forEach((t, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const y = 2 + row * 2;
    const x = col * 10;
    let label = t.label;
    if (t.key === "bicycle" && save?.onBike) label = "GET OFF";
    pill(host, `tool:${t.key}`, x, y, 10, label, () => useTool(ctx, t.key));
  });
  if (ui.msg) center(host, 15, fit(ui.msg, 20));
}

function useTool(ctx: GearCtx, key: string): void {
  const { game, save, ui, data } = ctx;
  const t = TOOLS.find((x) => x.key === key)!;
  if (!fieldIdle(game)) { ui.msg = "NOT NOW!"; return; }
  ui.msg = null;
  if (t.item) {
    game.useKeyItem?.(t.item);
    return;
  }
  const who = knowerOf(save, t.move!);
  if (who < 0) return;
  if (t.move === "SOFTBOILED") { ui.softFrom = who; return; }
  const name = monName(data, save.party[who]);
  game.overworld?.runScript?.([[VERB[t.move!], name]]);
}

/**
 * Field SOFTBOILED (start_sub_menus.asm .softboiled): a fifth of the user's
 * max HP to a teammate, who must be someone else, standing and hurt.
 */
function drawSoftboiled(ctx: GearCtx, from: number): void {
  const { host, save, ui, game, data } = ctx;
  const user = save.party[from];
  text(host, 0, 1, fit(`${monName(data, user)}: HEAL WHO?`, 20));
  drawPartyGrid(ctx, from, (i) => {
    const share = Math.floor((user.stats?.hp ?? user.hp) / 5);
    const target = save.party[i];
    const max = target?.stats?.hp ?? target?.hp ?? 0;
    ui.softFrom = null;
    if (user.hp < share || share <= 0) { game.showText?.("Not enough HP!"); return; }
    if (!target || i === from || target.hp <= 0 || target.hp >= max) {
      game.showText?.("It won't have any\neffect.");
      return;
    }
    user.hp -= share;
    target.hp = Math.min(max, target.hp + share);
  });
  backRow(ctx, () => { ui.softFrom = null; });
}
