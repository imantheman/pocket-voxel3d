// HOME (the launcher), STORE (add/remove apps), OPTIONS and STEPS.
//
// The mod's Silph Link home puts two widgets over a grid of app buttons; on
// the 20x18 grid that is an EXPLORER card (where you are, what lives there,
// your steps) and a PARTY card (the lead mon), then the apps as pills.
import { hpBarTiles } from "../../../battle/ui.ts";
import { picPageFor } from "../../../battle/staging.ts";
import {
  COLS, TILE_H, TILE_W, box, button, center, cursor, fit, pill, pressedId, region, sprite, text,
  tiles, wrap, type Ink,
} from "../draw.ts";
import { APPS, appOf, gearSave, wildRows, type GearViewId } from "../model.ts";
import { go, header, type GearCtx } from "../ui.ts";

/** The apps a player can open right now, in home order (HOME itself first). */
export function availableApps(game: any): GearViewId[] {
  const g = gearSave(game.save);
  const inv = game.save?.inventory ?? {};
  const atlas = game.data?.atlas;
  const out: GearViewId[] = [];
  for (const a of APPS) {
    if (!a.fixed && g.removed[a.id]) continue;
    // the TOWN MAP is Blue's sister's gift: no map app without it, and none
    // on a pak cooked before the map pages existed
    if (a.id === "map" && !((inv.TOWN_MAP ?? 0) > 0 && typeof atlas?.townMapPage === "number" && atlas.townMapPage >= 0)) continue;
    // the POKéDEX is Oak's to give, as on the START menu
    if (a.id === "pokedex" && !game.save?.flags?.EVENT_GOT_POKEDEX) continue;
    out.push(a.id);
  }
  return out;
}

function mapName(ctx: GearCtx): string {
  const id = ctx.game.overworld?.map?.id ?? ctx.game.overworld?.mapId;
  const loc = ctx.data.field?.townMap?.locations?.[id];
  return loc?.name ?? String(id ?? "").replace(/_/g, " ");
}

export function drawHome(ctx: GearCtx): void {
  const { host, game, save } = ctx;
  header(ctx, "KANTO GEAR");

  // EXPLORER card: the place, its wild count, the step counter
  button(host, "home:explorer", 0, 2, 10, 6, "", () => go(ctx, "explorer"));
  const ie: Ink = pressedId() === "home:explorer" ? "fill" : "dark";
  const id = game.overworld?.map?.id ?? "";
  const name = mapName(ctx);
  text(host, 1, 3, fit(name, 8), ie);
  const wild = new Set(wildRows(ctx.data, id).map((r) => r.species)).size;
  text(host, 1, 5, `WILD ${wild}`, ie);
  if (!ctx.gear.removed.steps) text(host, 1, 6, fit(`${ctx.gear.steps} STEPS`, 8), ie);

  // PARTY card: the lead
  button(host, "home:party", 10, 2, 10, 6, "", () => go(ctx, "party"));
  const ip: Ink = pressedId() === "home:party" ? "fill" : "dark";
  const lead = save?.party?.[0];
  if (lead) {
    sprite(host, picPageFor(ctx.data, lead.species), 11 * TILE_W, 3 * TILE_H, 2 * TILE_W, 2 * TILE_H);
    const nm = lead.nickname ?? ctx.data.pokemon[lead.species]?.name ?? lead.species;
    text(host, 13, 3, fit(nm, 6), ip);
    text(host, 13, 4, `L${lead.level}`, ip);
    tiles(host, 11, 6, hpBarTiles(lead.hp, lead.stats?.hp ?? lead.hp, true).slice(1), 0x2000);
  } else {
    center(host, 4, "NO POKéMON", ip, 11, 8);
  }

  // the apps: three to a row, one row of pills with a row between
  const apps = availableApps(game).filter((a) => a !== "home");
  apps.forEach((a, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = [0, 7, 14][col]!;
    const w = 6;
    const y = 9 + row * 2;
    if (y > 16) return;
    pill(host, `home:${a}`, x, y, w, appOf(a)!.short, () => go(ctx, a));
  });
}

// ---------------------------------------------------------------------------
// STEPS
// ---------------------------------------------------------------------------

export function drawSteps(ctx: GearCtx): void {
  const { host, gear } = ctx;
  box(host, 1, 3, 18, 5);
  center(host, 4, "TOTAL STEPS");
  center(host, 6, String(gear.steps));
  box(host, 1, 9, 18, 5);
  center(host, 10, "TRIP");
  center(host, 12, String(gear.trip));
  pill(host, "steps:reset", 5, 15, 10, "RESET TRIP", () => { gear.trip = 0; });
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

export function drawStore(ctx: GearCtx): void {
  const { host, gear, ui } = ctx;
  const optional = APPS.filter((a) => !a.fixed);
  if (ui.sel === undefined) ui.sel = 0;
  optional.forEach((a, i) => {
    const y = 2 + i * 2;
    const on = !gear.removed[a.id];
    if (ui.sel === i) cursor(host, 0, y);
    text(host, 1, y, a.title);
    region(`store:${a.id}`, 0, y, 13, 1, () => { ui.sel = i; });
    pill(host, `store:t:${a.id}`, 14, y, 6, on ? "ON" : "OFF", () => {
      ui.sel = i;
      gear.removed[a.id] = on;
    }, !on);
  });
  const a = optional[ui.sel] ?? optional[0]!;
  box(host, 0, 14, COLS, 4);
  wrap(a.about.join(" "), 18).slice(0, 2).forEach((line, i) => text(host, 1, 15 + i, line));
}

// ---------------------------------------------------------------------------
// OPTIONS
// ---------------------------------------------------------------------------

interface OptionRow {
  label: string;
  value: () => string;
  step: () => void;
}

export function drawOptions(ctx: GearCtx): void {
  const { host, gear } = ctx;
  const levels = ["vanilla", "enhanced", "spoiler"] as const;
  const rows: OptionRow[] = [
    {
      label: "INFO",
      value: () => ({ vanilla: "VANILLA", enhanced: "ENHANCED", spoiler: "SPOILERS" })[gear.info],
      step: () => { gear.info = levels[(levels.indexOf(gear.info) + 1) % 3]!; },
    },
    { label: "CAUGHT ICON", value: () => (gear.caughtIcon ? "ON" : "OFF"), step: () => { gear.caughtIcon = !gear.caughtIcon; } },
    { label: "CLOCK", value: () => (gear.clock24 ? "24 HOUR" : "12 HOUR"), step: () => { gear.clock24 = !gear.clock24; } },
    { label: "KEYBOARD", value: () => (gear.qwertz ? "QWERTZ" : "QWERTY"), step: () => { gear.qwertz = !gear.qwertz; } },
  ];
  rows.forEach((r, i) => {
    const y = 2 + i * 2;
    text(host, 1, y, r.label);
    pill(host, `opt:${i}`, 12, y, 8, r.value(), r.step);
  });
  // what INFO means, since it is the one that changes the most
  const say = {
    vanilla: ["ONLY WHAT THE GAME", "ITSELF TELLS YOU."],
    enhanced: ["ENCOUNTERS, TRAINERS,", "ITEMS AND MATCHUPS."],
    spoiler: ["ALSO HIDDEN ITEMS AND", "POKéMON YOU HAVEN'T SEEN."],
  }[gear.info];
  box(host, 0, 11, COLS, 6);
  text(host, 1, 12, "INFO:");
  wrap(say.join(" "), 18).slice(0, 3).forEach((line, i) => text(host, 1, 13 + i, line));
}
