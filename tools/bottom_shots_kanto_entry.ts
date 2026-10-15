// A Citra tour of the Kanto games' bottom screen for screenshots (bundled in
// place of game.js; see tools/bottom_shots_gold_entry.ts for Gold's): the
// title's menu, then the card's save continued with a full party, a long
// nickname, six-figure money and a long play time; then every gear page in
// turn -- HOME, each app and its tabs, the summaries, the text-box, menu and
// YES/NO mirrors, and a wild battle's panels -- each one shot to the card
// (shot_N_b.ppm) with a "[pv] bpshot N name" line in pvlog.txt to say which.
// Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { gearSave, spoilers, stampAreas } from "../voxelmon/game/ui/gear/model.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const A = 1 << 4;
const B = 1 << 5;
const START = 1 << 6;
/** A held touch at bottom-screen pixel (x, y), as main.rs packs it. */
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);

let i = 0;
let phase: "title" | "menu" | "load" | "tour" | "done" = "title";
let wait = 0;
let shots = 0;
let step = 0;
let stepAt = 0;
/** Frames of touch still to send (a tap at the header's clock: no target
 *  there, it only makes the gear draw again). */
let tapLeft = 0;

const top = (): any => game.stack?.[game.stack.length - 1];
const ui = (app: string): Record<string, any> => ((game.gearUi ??= {})[app] ??= {});
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};
const toOverworld = (): void => {
  while (game.stack.length > 1 && top()?.kind !== "overworld") game.pop();
};
const view = (v: string): void => game.setGearView(v);

/** The save made a busy mid-game one (only in this run's copy). */
function dressSave(): void {
  const s = game.save;
  s.options = { ...(s.options ?? {}), view: "3d", battleView: "3d" };
  s.money = 148250;
  s.playTime = 103 * 3600 + 7 * 60;
  s.inventory ??= {};
  if (!(s.inventory.TOWN_MAP > 0)) s.inventory.TOWN_MAP = 1;
  for (const [id, n] of [["POTION", 12], ["SUPER_POTION", 7], ["HYPER_POTION", 4], ["FULL_RESTORE", 2], ["REVIVE", 5],
    ["ANTIDOTE", 3], ["PARLYZ_HEAL", 2], ["ESCAPE_ROPE", 4], ["REPEL", 6], ["MAX_REPEL", 2], ["RARE_CANDY", 1],
    ["POKE_BALL", 15], ["GREAT_BALL", 8], ["ULTRA_BALL", 3], ["NUGGET", 1], ["CARBOS", 1], ["MOON_STONE", 1]] as [string, number][]) {
    if (!(s.inventory[id] > 0)) s.inventory[id] = n;
    if (Array.isArray(s.bagOrder) && !s.bagOrder.includes(id)) s.bagOrder.push(id);
  }
  s.flags ??= {};
  s.flags.EVENT_GOT_POKEDEX = true;
  // six in the party, from the boxes if it is short, one with a ten-letter name
  const party: any[] = s.party ?? [];
  for (const box of s.boxes ?? []) for (const m of box ?? []) if (m && party.length < 6) party.push(m);
  s.party = party;
  if (party[1]) party[1].nickname = "THUNDERBOL";
  if (party[2]) party[2].status = "PSN";
  if (party[3]) party[3].hp = Math.max(1, Math.floor((party[3].stats?.hp ?? party[3].hp) / 5));
  const gear = gearSave(s);
  gear.steps = 23817;
  gear.trip = 1204;
  // (a save's empty notes come back from the Lua file as {})
  if (!Array.isArray(gear.notes)) gear.notes = [];
  if (gear.notes.length === 0) {
    gear.notes.push({ kind: "text", title: "BUY ULTRA BALLS", lines: ["BUY ULTRA BALLS AT THE", "CELADON DEPT STORE BEFORE", "THE SAFARI ZONE."] });
    gear.notes.push({ kind: "list", title: "GYM PLAN", lines: ["TEACH SURF", "LEVEL UP TO 40", "STOCK FULL HEALS"], done: [true, false, false] });
    gear.notes.push({ kind: "sketch", title: "SKETCH", lines: [] });
  }
  // the dex: whatever the save has, the party at least
  s.pokedex ??= { seen: {}, owned: {} };
  for (const m of party) { s.pokedex.seen[m.species] = true; s.pokedex.owned[m.species] = true; }
}

/** Somewhere with grass, trainers and items for EXPLORER. */
function place(): void {
  const want: [string, number, number][] = [["ROUTE_24", 11, 28], ["ROUTE_3", 20, 10], ["ROUTE_1", 9, 20]];
  for (const [m, x, y] of want) {
    try {
      game.overworld.enter(m, x, y, "up");
      const map = game.overworld.map;
      for (let r = 0; r < 8; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const cx = x + dx;
            const cy = y + dy;
            if (map.isWalkableCell(cx, cy) && !map.warpAtCell?.(cx, cy)) {
              if (dx || dy) game.overworld.enter(m, cx, cy, "up");
              toOverworld();
              console.log(`[pv] bpshot placed ${m} ${cx},${cy}`);
              return;
            }
          }
        }
      }
    } catch (e) {
      console.log(`[pv] bpshot place ${m} failed ${e}`);
    }
  }
  toOverworld();
}

type Step = { name: string; set?: () => void; frames?: number; pad?: () => number; shoot?: boolean };

const party0 = (): number => Math.max(0, (game.save?.party ?? []).findIndex((m: any) => m?.nickname === "THUNDERBOL"));
const dexMon = (): string => game.save?.party?.[0]?.species ?? "PIKACHU";
let battle: any = null;
const bstate = (): any => top()?.battle ?? battle;

const STEPS: Step[] = [
  { name: "home", set: () => view("home") },
  { name: "party", set: () => { view("party"); ui("party").summary = null; } },
  { name: "party_info", set: () => { const u = ui("party"); u.summary = party0(); u.page = "info"; u.move = null; } },
  { name: "party_stats", set: () => { ui("party").page = "stats"; } },
  { name: "party_moves", set: () => { ui("party").page = "moves"; } },
  { name: "party_moveinfo", set: () => { ui("party").move = 0; } },
  { name: "map", set: () => { ui("party").summary = null; ui("party").move = null; view("map"); } },
  { name: "explorer_area", set: () => { view("explorer"); ui("explorer").page = "area"; ui("explorer").top = 0; } },
  { name: "explorer_wild", set: () => { ui("explorer").page = "wild"; } },
  { name: "explorer_trainers", set: () => { ui("explorer").page = "trainers"; } },
  { name: "explorer_items", set: () => { ui("explorer").page = "items"; } },
  { name: "trainer", set: () => view("trainer") },
  { name: "pokedex", set: () => { view("pokedex"); ui("pokedex").species = null; ui("pokedex").top = 0; } },
  { name: "dex_info", set: () => { ui("pokedex").species = dexMon(); ui("pokedex").page = "info"; } },
  { name: "dex_stats", set: () => { ui("pokedex").page = "stats"; } },
  { name: "dex_area", set: () => { ui("pokedex").page = "area"; } },
  { name: "dex_moves", set: () => { ui("pokedex").page = "moves"; } },
  { name: "bag_items", set: () => { ui("pokedex").species = null; view("bag"); Object.assign(ui("bag"), { pocket: "items", item: null, top: 0 }); } },
  { name: "bag_item", set: () => { const ids = Object.keys(game.save.inventory).filter((k) => /POTION/.test(k)); ui("bag").item = ids[0] ?? null; } },
  { name: "bag_balls", set: () => { Object.assign(ui("bag"), { pocket: "balls", item: null }); } },
  { name: "bag_key", set: () => { ui("bag").pocket = "key"; } },
  { name: "bag_tms", set: () => { ui("bag").pocket = "tms"; } },
  { name: "tools", set: () => view("tools") },
  { name: "steps", set: () => view("steps") },
  { name: "stamps", set: () => { view("stamps"); ui("stamps").area = null; ui("stamps").top = 0; } },
  { name: "stamps_area", set: () => {
    // the first area on the list
    const areas = stampAreas(game.data, game.save, spoilers(game.save)).filter((a) => a.visited);
    ui("stamps").area = areas[0]?.name ?? null;
  } },
  { name: "notes", set: () => { ui("stamps").area = null; view("notes"); ui("notes").open = null; } },
  { name: "notes_text", set: () => { Object.assign(ui("notes"), { open: 0, typing: false }); } },
  { name: "notes_typing", set: () => { Object.assign(ui("notes"), { open: 0, typing: true }); } },
  { name: "notes_list", set: () => { Object.assign(ui("notes"), { open: 1, typing: false, sel: 0 }); } },
  { name: "notes_sketch", set: () => { Object.assign(ui("notes"), { open: 2, typing: false }); } },
  { name: "store", set: () => { ui("notes").open = null; view("store"); } },
  { name: "options", set: () => view("options") },
  // the mirrors: a text box (the hint strip), the START menu, YES/NO
  { name: "mirror_text", set: () => { view("party"); game.showText("This is a test of\nthe text box."); }, frames: 90 },
  { name: "mirror_menu", set: () => { toOverworld(); game.openStartMenu(); } },
  { name: "mirror_choice", set: () => { toOverworld(); game.showChoice("Is this OK?", () => {}); }, frames: 90 },
  // a wild battle's panels
  { name: "battle_text", set: () => { toOverworld(); game.pushStubBattle("PIDGEOTTO", 30); battle = top()?.battle; }, frames: 50 },
  { name: "battle_menu", pad: () => (bstate()?.phase === "menu" ? 0 : i % 20 === 0 ? A : 0), frames: 400 },
  { name: "battle_moves", pad: () => (bstate()?.phase === "menu" && i % 20 === 0 ? A : 0), frames: 60 },
  { name: "battle_moveinfo", set: () => { ui("battle").moveInfo = 0; }, frames: 30 },
  { name: "battle_back", set: () => { ui("battle").moveInfo = null; }, pad: () => (bstate()?.phase === "moveSelect" && i % 20 === 0 ? B : 0), frames: 60, shoot: false },
  { name: "battle_party", set: () => { if (bstate()) bstate().menuIndex = 2; }, pad: () => (bstate()?.phase === "menu" && i % 20 === 0 ? A : 0), frames: 60 },
  { name: "battle_back2", pad: () => (bstate()?.phase === "party" && i % 20 === 0 ? B : 0), frames: 60, shoot: false },
  { name: "battle_items", set: () => { if (bstate()) bstate().menuIndex = 3; }, pad: () => (bstate()?.phase === "menu" && i % 20 === 0 ? A : 0), frames: 60 },
  { name: "battle_back3", pad: () => (bstate()?.phase === "item" && i % 20 === 0 ? B : 0), frames: 60, shoot: false },
  { name: "battle_info", set: () => { ui("battle").info = true; }, frames: 40 },
];

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const t = top();
  if (phase === "title") {
    if (t?.kind === "title") {
      if (t.phase === "menu") { phase = "menu"; wait = 40; }
      else if (i % 30 === 0) pad = START;
    } else if (i % 30 === 0) pad = START;
  } else if (phase === "menu") {
    if (--wait === 0) {
      shot("title_menu");
      game.pop();
      t.onChoose?.("continue");
      phase = "load";
      wait = 0;
    }
  } else if (phase === "load") {
    if (game.save && t?.kind === "overworld") {
      if (++wait === 30) {
        dressSave();
        place();
        phase = "tour";
        step = 0;
        stepAt = i + 60;
        STEPS[0]!.set?.();
        tapLeft = 2;
      }
    } else if (t?.kind === "textbox" && i % 30 === 0) pad = A;
  } else if (phase === "tour") {
    const s = STEPS[step];
    if (!s) {
      phase = "done";
      console.log("[pv] bpshot done");
    } else {
      if (s.pad) pad |= s.pad();
      if (tapLeft > 0) {
        tapLeft--;
        // (not over a battle or a mirror: those draw every frame, and the
        // battle's header has INFO where the clock would be)
        if (tapLeft === 1 && top()?.kind === "overworld" && !game.battleView?.()) pad |= touch(316, 4);
      }
      if (i >= stepAt) {
        if (s.shoot !== false) shot(s.name);
        step++;
        const n = STEPS[step];
        if (n) {
          n.set?.();
          stepAt = i + (n.frames ?? 45);
          tapLeft = 2;
        }
      }
    }
  }
  mainFrame((b & ~0xffffff) | pad);
};
