// POKéDEX: every species with what you know of it (seen, caught), and a tap
// on one you have seen opens its page -- INFO (kind, types, size), STATS
// (base stats), AREA (where it lives, with levels) and MOVES (what it
// learns and when). Stats, habitats and moves are assists: VANILLA keeps to
// the game's own dex page.
import { picPageFor } from "../../../battle/staging.ts";
import {
  COLS, TILE_H, TILE_W, center, fit, pressedId, region, right, rule, sprite, text,
} from "../draw.ts";
import { assists, spoilers, wildRows } from "../model.ts";
import { stepper, tabs, type GearCtx } from "../ui.ts";

const ROWS_SHOWN = 14;

/** Every species in dex order. */
function dexOrder(data: any): string[] {
  return Object.keys(data.pokemon ?? {})
    .filter((id) => (data.pokemon[id]?.dex ?? 0) > 0)
    .sort((a, b) => data.pokemon[a].dex - data.pokemon[b].dex);
}

export function drawPokedex(ctx: GearCtx): void {
  const { ui } = ctx;
  if (ui.species) { drawEntry(ctx, ui.species); return; }
  drawList(ctx);
}

function drawList(ctx: GearCtx): void {
  const { host, data, save, ui } = ctx;
  const all = dexOrder(data);
  const seen = save?.pokedex?.seen ?? {};
  const owned = save?.pokedex?.owned ?? {};
  const pages = Math.ceil(all.length / ROWS_SHOWN);
  ui.top = Math.min(ui.top ?? 0, (pages - 1) * ROWS_SHOWN);
  const top = ui.top;
  all.slice(top, top + ROWS_SHOWN).forEach((id, k) => {
    const y = 1 + k;
    const d = data.pokemon[id];
    const know = seen[id] || owned[id];
    const lit = pressedId() === `dex:${id}`;
    const ink = lit ? "fill" : "dark";
    text(host, 0, y, String(d.dex).padStart(3, "0"), ink);
    text(host, 4, y, know ? fit(d.name, 10) : "----------", ink);
    right(host, y, owned[id] ? "OWN" : know ? "SEEN" : "", ink);
    if (know) region(`dex:${id}`, 0, y, COLS, 1, () => { ui.species = id; ui.page = "info"; });
  });
  const nOwn = Object.values(owned).filter(Boolean).length;
  const nSeen = Object.values(seen).filter(Boolean).length;
  text(host, 0, 15, `SEEN ${nSeen}  OWN ${nOwn}`);
  const at = Math.floor(top / ROWS_SHOWN);
  stepper(ctx, `${at + 1}/${pages}`,
    () => { ui.top = ((at + pages - 1) % pages) * ROWS_SHOWN; },
    () => { ui.top = ((at + 1) % pages) * ROWS_SHOWN; }, 17);
}

const PAGES = [
  { id: "info", label: "INFO" },
  { id: "stats", label: "STAT" },
  { id: "area", label: "AREA" },
  { id: "moves", label: "MOVE" },
];

/** Every map a species lives on: method and levels (the mod's habitats). */
function habitats(data: any, species: string): { map: string; method: string; lv: string; pct: number }[] {
  const out: { map: string; method: string; lv: string; pct: number }[] = [];
  const all = { OLD_ROD: true, GOOD_ROD: true, SUPER_ROD: true };
  for (const mapId of Object.keys(data.encounters ?? {})) {
    for (const r of wildRows(data, mapId, all)) {
      if (r.species !== species || r.method === "OLD ROD" || r.method === "GOOD ROD") continue;
      const place = data.field?.townMap?.locations?.[mapId]?.name ?? mapId.replace(/_/g, " ");
      out.push({ map: place, method: r.method, lv: r.minLv === r.maxLv ? `${r.minLv}` : `${r.minLv}-${r.maxLv}`, pct: r.pct });
    }
  }
  if (species === "MAGIKARP") out.push({ map: "ANY WATER", method: "OLD ROD", lv: "5", pct: 100 });
  if (species === "GOLDEEN" || species === "POLIWAG") out.push({ map: "ANY WATER", method: "GOOD ROD", lv: "10", pct: 50 });
  return out;
}

function drawEntry(ctx: GearCtx, id: string): void {
  const { host, data, save, ui } = ctx;
  const d = data.pokemon[id] ?? {};
  const owned = !!save?.pokedex?.owned?.[id];
  const page = ui.page ?? "info";
  sprite(host, picPageFor(data, id), 0, TILE_H + 2, 4 * TILE_W, 4 * TILE_H);
  text(host, 5, 2, fit(d.name ?? id, 10));
  right(host, 2, owned ? "OWN" : "SEEN", "dark", 20);
  text(host, 5, 3, `No.${String(d.dex ?? 0).padStart(3, "0")}`);
  if (d.dexEntry?.kind) text(host, 5, 4, fit(`${d.dexEntry.kind} POKéMON`, 15));
  rule(host, 6);
  const locked = page !== "info" && !assists(save);
  if (locked) {
    center(host, 9, "SET INFO TO ENHANCED");
    center(host, 11, "IN OPTIONS");
  } else if (page === "info") {
    text(host, 1, 7, "TYPE");
    text(host, 7, 7, (d.types ?? []).join("/"));
    if (owned && d.dexEntry) {
      text(host, 1, 9, "HT");
      text(host, 7, 9, `${d.dexEntry.heightFt}'${String(d.dexEntry.heightIn).padStart(2, "0")}"`);
      text(host, 1, 10, "WT");
      text(host, 7, 10, `${(d.dexEntry.weight / 10).toFixed(1)}lb`);
      const entry = data.text?.[d.dexEntry.text];
      if (typeof entry === "string") {
        entry.replace(/[\f\v]/g, "\n").split("\n").filter(Boolean).slice(0, 4)
          .forEach((l: string, i: number) => text(host, 1, 12 + i, fit(l, 18)));
      }
    } else {
      text(host, 1, 9, "CATCH ONE TO LEARN");
      text(host, 1, 10, "MORE.");
    }
  } else if (page === "stats") {
    const b = d.baseStats ?? {};
    ([["HP", b.hp], ["ATTACK", b.attack], ["DEFENSE", b.defense], ["SPEED", b.speed], ["SPECIAL", b.special]] as const)
      .forEach(([label, v], k) => {
        text(host, 1, 7 + k * 2, label);
        text(host, 10, 7 + k * 2, String(v ?? "-").padStart(3, " "));
      });
    text(host, 1, 15, `CATCH RATE ${d.catchRate ?? "-"}`);
  } else if (page === "area") {
    const all = habitats(data, id);
    if (all.length === 0) text(host, 1, 8, "NOT FOUND IN THE WILD");
    // ENHANCED hides where a mon you have not caught lives
    else if (!owned && !spoilers(save)) text(host, 1, 8, fit(`${all.length} PLACES. CATCH ONE`, 18));
    else {
      const short: Record<string, string> = {
        GRASS: "GRS", WATER: "SURF", "OLD ROD": "ROD1", "GOOD ROD": "ROD2", "SUPER ROD": "ROD3",
      };
      all.slice(0, 9).forEach((h, k) => {
        text(host, 0, 7 + k, fit(h.map, 10));
        right(host, 7 + k, `${short[h.method] ?? h.method} L${h.lv}`, "dark", 20);
      });
    }
  } else {
    const learn: { level: number; move: string }[] = [
      ...(d.level1Moves ?? []).map((m: string) => ({ level: 1, move: m })),
      ...(d.learnset ?? []),
    ];
    learn.slice(0, 9).forEach((l, k) => {
      text(host, 0, 7 + k, `L${String(l.level).padStart(2, " ")}`);
      text(host, 4, 7 + k, fit(data.moves?.[l.move]?.name ?? l.move, 14));
    });
  }
  tabs(ctx, PAGES, page, (p) => { ui.page = p; }, 16);
  const order = dexOrder(data).filter((s) => save?.pokedex?.seen?.[s] || save?.pokedex?.owned?.[s]);
  const at = Math.max(0, order.indexOf(id));
  stepper(ctx, "BACK",
    () => { ui.species = order[(at + order.length - 1) % order.length]; },
    () => { ui.species = order[(at + 1) % order.length]; });
  region("dex:back", 3, 17, COLS - 6, 1, () => { ui.species = null; });
}
