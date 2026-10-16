// Where the Gold party screen and battle screen spend their frame under the
// 3DS's QuickJS: gen2/main.ts's own frame() run as the 3DS runs it (the
// card's save continued, the speed bench's party of six), then the party
// screen held with the cursor cycling and a wild battle with FIGHT every
// turn. Per segment: the compose (game.draw + lcd.end), the scene and the
// bottom screen (view.emit + companion.frame) per composed frame, and with
// WRAP the screen, the drawing layer, the tile sheets and the bottom screen
// wrapped and timed inclusively. HASH=1 instead folds every composed frame
// (top screen cells/objects/palettes, and the bottom screen's ops) into one
// hash per segment, for checking a drawing change left both screens as
// they were. Bundle and run in tools/qjs_gold_harness.c with PROF=1.
// Never shipped.
import "./qjs_prof_gen2_bin.ts";
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import G from "../voxelmon/game/gen2/platform/screen.ts";
import { TileSheet } from "../voxelmon/game/gen2/ui/TileSheet.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { GbcPalette } from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import { Companion } from "../voxelmon/game/gen2/ui/Companion.ts";
import { BattleHud } from "../voxelmon/game/gen2/ui/BattleHud.ts";
import { BattleAnimView } from "../voxelmon/game/gen2/ui/BattleAnimView.ts";
import { AnimRunner, AnimRunnerInstance } from "../voxelmon/game/gen2/battle/AnimRunner.ts";
import { Strings } from "../voxelmon/game/gen2/shared/core/Strings.ts";
import { Sprites } from "../voxelmon/game/gen2/shared/pokemon/Sprites.ts";
import { WorldView } from "../voxelmon/game/gen2/platform/worldview.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const now = (): number => native.now?.() ?? 0;
const nat = native as any;

declare const WRAP: boolean;
declare const HASH: boolean;
declare const SEGS: string[];
const wrapping = typeof WRAP !== "undefined" && WRAP;
const hashing = typeof HASH !== "undefined" && HASH;
// a pinned clock while hashing: the bottom screen shows the time, and the
// daytime picks palettes
if (hashing) setClockSource({ now: () => 1790000000 });
const PHASES: readonly string[] = typeof SEGS !== "undefined" ? SEGS : ["menu", "battle"];
// NOCACHE=1: every cachedBlock drawn for real (screen.ts), the reference a
// HASH run with the cache is compared against
declare const BUSY: boolean;
const busyOnly = typeof BUSY !== "undefined" && BUSY;
declare const NOCACHE: boolean;
if (typeof NOCACHE !== "undefined" && NOCACHE) (globalThis as { noBlockCache?: boolean }).noBlockCache = true;

const stats: Record<string, { us: number; n: number }> = {};
/** This compose's share (SLOWONLY: kept only for a compose past SLOW). */
const frameStats: Record<string, { us: number; n: number }> = {};
let slowCount = 0;
declare const SLOWONLY: boolean;
const slowOnly = (typeof SLOWONLY !== "undefined" && SLOWONLY) || typeof LOGICSLOW !== "undefined";
let on = false;
const done = new Set<any>();
function wrap(owner: any, label: string): void {
  if (!owner || done.has(owner)) return;
  done.add(owner);
  for (const name of Object.getOwnPropertyNames(owner)) {
    if (name === "constructor" || /^[A-Z]/.test(name)) continue;
    const d = Object.getOwnPropertyDescriptor(owner, name);
    if (!d || typeof d.value !== "function" || d.get || d.set) continue;
    const orig = d.value;
    const key = `${label}.${name}`;
    try {
      owner[name] = function (this: unknown, ...args: unknown[]) {
        if (!on) return orig.apply(this, args);
        const a = now();
        try {
          return orig.apply(this, args);
        } finally {
          const s = ((slowOnly ? frameStats : stats)[key] ??= { us: 0, n: 0 });
          s.us += now() - a;
          s.n++;
        }
      };
    } catch { /* frozen */ }
  }
}
if (wrapping) {
  wrap(Lcd.prototype, "Lcd");
  wrap(G, "G");
  wrap(TileSheet.prototype, "TileSheet");
  wrap(Chrome, "Chrome");
  wrap(GbcPalette, "GbcPalette");
  wrap(Font, "Font");
  wrap(Companion.prototype, "Companion");
  wrap(BattleHud.prototype, "BattleHud");
  wrap(BattleAnimView.prototype, "AnimView");
  wrap(AnimRunnerInstance.prototype, "AnimRunner");
  wrap(AnimRunner, "AnimRunner.static");
  wrap(Strings, "Strings");
  wrap(Sprites, "Sprites");
  wrap(WorldView.prototype, "WorldView");
  wrap(Object.getPrototypeOf(game), "Game2");
}

// SIGLOG=1: each change of the bottom screen's battle signature (a redraw)
declare const SIGLOG: boolean;
if (typeof SIGLOG !== "undefined" && SIGLOG) {
  const proto = Companion.prototype as any;
  const orig = proto.battleSignature;
  let last = "";
  proto.battleSignature = function (this: unknown, ...a: unknown[]) {
    const s = orig.apply(this, a);
    if (s !== last && on) console.log(`[fps] sig ${JSON.stringify(s).slice(0, 160)}`);
    last = s;
    return s;
  };
}


// LOGICSLOW=<us>: the wrapped split of each logic tick past that (with
// SLOWONLY's per-compose bookkeeping turned onto game.logicFrame instead)
declare const LOGICSLOW: number;
if (typeof LOGICSLOW !== "undefined") {
  const lf = game.logicFrame.bind(game);
  game.logicFrame = (b: number): void => {
    for (const key of Object.keys(frameStats)) delete frameStats[key];
    const a = now();
    lf(b);
    const spent = now() - a;
    if (on && spent > LOGICSLOW) {
      slowCount++;
      const st = game.stack.top();
      console.log(`[fps] slow tick ${spent.toFixed(0)} us: ${st?.screenId} ${st?.phase ?? ""} msg=${JSON.stringify(st?.message ?? "").slice(0, 40)}`);
      for (const [key, s] of Object.entries(frameStats)) {
        const t = (stats[key] ??= { us: 0, n: 0 });
        t.us += s.us;
        t.n += s.n;
      }
    }
    for (const key of Object.keys(frameStats)) delete frameStats[key];
  };
}
// ---- the bottom screen's ops, hashed (HASH) -----------------------------------
let h = 0x811c9dc5 | 0;
const mix = (v: number): void => {
  h = Math.imul(h ^ (v | 0), 16777619);
};
const mixStr = (s: string): void => {
  for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i));
};
const mixArg = (v: unknown): void => {
  if (typeof v === "number") mix(v * 4096);
  else if (typeof v === "string") mixStr(v);
  else if (typeof v === "boolean") mix(v ? 1 : 2);
  else if (v instanceof Uint8Array || v instanceof Uint16Array || v instanceof Int16Array || v instanceof Int32Array || v instanceof Uint32Array || v instanceof Float32Array) {
    mix(v.length);
    for (let i = 0; i < v.length; i++) mix(v[i]! * 7);
  } else if (Array.isArray(v)) {
    mix(v.length);
    for (const x of v) mixArg(x);
  } else mix(3);
};
if (hashing) {
  // every bottom-screen op (and every other op the host takes) mixed in order,
  // with a frame marker: two runs whose op streams match drew the same
  for (const name of Object.keys(nat)) {
    // (and the 3D battle's stage: where the arena stands, the camera, the cards)
    if (!/Bottom|uiPanel|^ui[A-Z]|^lcd|^arena|^battleCam|^card/.test(name)) continue;
    const orig = nat[name];
    if (typeof orig !== "function") continue;
    nat[name] = (...args: unknown[]) => {
      if (on) {
        mixStr(name);
        for (const a of args) mixArg(a);
      }
      return orig(...args);
    };
  }
}

// ---- the segments ----------------------------------------------------------------
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
function party(): any[] {
  return ["MEW", "ARCANINE", "LAPRAS", "SNORLAX", "JOLTEON", "DRAGONITE"].map((sp) =>
    Mon.new(game.data, sp, 70, { dvs: perfect(), moves: [{ id: "SWIFT", pp: 63, maxPp: 63 }] }));
}

let state: any = null;
let battleDone = true;
function battlePad(t: number): number {
  if (battleDone) {
    if (t < 30) return 0;
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    const wild: any = Mon.new(game.data, "CHANSEY", 60, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    battleDone = false;
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { battleDone = true; game.stack.pop(); } });
    state = game.stack.top();
  }
  const ph: string = state.phase;
  if (n % 2 !== 0) return 0;
  if (ph === "menu") return state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0 ? VOX_BTN.a : state.menuIndex !== 1 ? VOX_BTN.up : 0;
  if (ph === "moves") return state.moveIndex > 1 ? VOX_BTN.up : VOX_BTN.a;
  return VOX_BTN.a;
}
// A fixed walk over the buttons (every 8th step), for the mixed segments:
// whatever screens it opens, it opens the same way every run, so a run with
// the block cache and one without (NOCACHE) must draw the same frames.
const WALK = [VOX_BTN.a, VOX_BTN.down, VOX_BTN.down, VOX_BTN.a, VOX_BTN.down, VOX_BTN.up, VOX_BTN.a, VOX_BTN.b,
  VOX_BTN.down, VOX_BTN.a, VOX_BTN.down, VOX_BTN.a, VOX_BTN.b, VOX_BTN.b, VOX_BTN.up, VOX_BTN.a, VOX_BTN.right,
  VOX_BTN.a, VOX_BTN.left, VOX_BTN.down, VOX_BTN.a, VOX_BTN.a, VOX_BTN.b, VOX_BTN.down];
function walkPad(t: number): number {
  return t % 8 === 0 ? WALK[(t >> 3) % WALK.length]! : 0;
}
function menuSubPad(t: number): number {
  if (t === 1) {
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    game.save.party[2].hp = 9;
    game.save.party[3].status = "psn";
    game.save.party[4].hp = 0;
    game.save.party[1].item = "BERRY";
    Screens.push(game, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: () => game.stack.pop() });
  }
  // back to the party screen whenever the walk has left it
  if (t % 240 === 120 && game.stack.top()?.screenId !== "Gen2PartyMenu") {
    while (game.stack.top()) game.stack.pop();
    Screens.push(game, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: () => game.stack.pop() });
  }
  return walkPad(t);
}
let mixDone = true;
function battleMixPad(t: number): number {
  if (mixDone && t >= 30) {
    while (game.stack.top()) game.stack.pop();
    const mons: any[] = ["CYNDAQUIL", "TOTODILE", "PIDGEY"].map((sp, i) =>
      Mon.new(game.data, sp, 5 + i * 3, { dvs: perfect() }));
    mons[1].hp = 3;
    game.save.party = mons;
    const wild: any = Mon.new(game.data, ["SENTRET", "RATTATA", "HOOTHOOT"][t % 3]!, 3, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    mixDone = false;
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { mixDone = true; game.stack.pop(); } });
  }
  return walkPad(t);
}
// The "anims" segment: a battle held at its menu and the animations below
// played over it one after another (BattleState.startAnim, stepped by its
// update as a turn's would be), each one's composes timed apart.
const ANIMS: [string, number][] = [
  ["DOUBLE_EDGE", 1], ["ANIM_PLAYER_DAMAGE", 1], ["ANIM_ENEMY_DAMAGE", 0], ["SWIFT", 0], ["DEFENSE_CURL", 1],
  ["LIGHT_SCREEN", 1], ["EGG_BOMB", 1], ["ANIM_SEND_OUT_MON", 0], ["DOUBLE_EDGE", 0],
];
let animAt = -1;
declare const STARTPROF: boolean;
const startProf = typeof STARTPROF !== "undefined" && STARTPROF;
let starts = 0;
let animState: any = null;
let animStats: { name: string; frames: number; us: number; max: number; startUs: number } | null = null;
function animsPad(t: number): number {
  if (!animState || game.stack.top() !== animState) {
    if (t < 30) return 0;
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    const wild: any = Mon.new(game.data, "CHANSEY", 60, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => game.stack.pop() });
    animState = game.stack.top();
    animAt = -1;
    return 0;
  }
  const st = animState;
  if (st.phase !== "menu") return n % 2 === 0 ? VOX_BTN.a : 0;
  if (st.anim || st.hpAnim) return 0;
  if (animStats) {
    const s = animStats;
    console.log(`[fps] anim ${s.name}: ${s.frames} composes, draw avg ${(s.us / Math.max(1, s.frames)).toFixed(0)} us max ${s.max.toFixed(0)} us; start ${s.startUs.toFixed(0)} us`);
    animStats = null;
  }
  animAt = (animAt + 1) % ANIMS.length;
  const [name, turn] = ANIMS[animAt]!;
  const key = st.anims?.moves?.[name] ?? st.anims?.ids?.[name];
  const a = now();
  // STARTPROF: the wrapped methods timed only inside startAnim
  const wasOn = on;
  if (startProf) { on = true; starts++; }
  const ok = st.startAnim(key, { turn, isMove: !name.startsWith("ANIM_") });
  if (startProf) on = wasOn;
  animStats = { name: `${name}/${turn}${ok ? "" : " (none)"}`, frames: 0, us: 0, max: 0, startUs: now() - a };
  return 0;
}
function menuPad(t: number): number {
  if (t === 1) {
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    Screens.push(game, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: () => game.stack.pop() });
  }
  return t % 6 === 0 ? VOX_BTN.down : 0;
}

const SEG = 1200;
let n = 0;
let started = false;
let ready = -1;
let k = -1;
let composed = 0;
let segUs = 0;
let segMax = 0;
let acc = 0;

// the compose split: wrap game.draw and companion.frame's caller from outside
const drawOrig = game.draw.bind(game);
let drawUs = 0;
game.draw = (lcd: any): void => {
  (globalThis as any).__gen2Lcd = lcd;
  const a = now();
  drawOrig(lcd);
  const spent = now() - a;
  if (on) drawUs += spent;
  if (animStats && on && animState?.anim) {
    animStats.frames++;
    animStats.us += spent;
    if (spent > animStats.max) animStats.max = spent;
  }
  if (slowOnly && typeof LOGICSLOW === "undefined") {
    if (on && spent > SLOW) {
      slowCount++;
      for (const [key, s] of Object.entries(frameStats)) {
        const t = (stats[key] ??= { us: 0, n: 0 });
        t.us += s.us;
        t.n += s.n;
      }
    }
    for (const key of Object.keys(frameStats)) delete frameStats[key];
  }
  // SLOW=<us>: each compose past that, with what was up
  if (typeof SLOW !== "undefined" && on && spent > SLOW) {
    const st = game.stack.top();
    console.log(`[fps] slow draw ${spent.toFixed(0)} us: ${st?.screenId} ${st?.phase ?? ""} anim=${st?.anim ? 1 : 0} hpAnim=${st?.hpAnim ? st.hpAnim.side : "-"} msg=${JSON.stringify(st?.message ?? "").slice(0, 40)}`);
  }
};
declare const SLOW: number;
/** SETTLE=<steps>: how long a segment settles before it counts (default 120). */
declare const SETTLE: number;
/** SPEED=2: GAME SPEED 2X throughout. */
declare const SPEED: number;
/** ANIMONLY=<name>: in the anims segment, count only that animation's frames. */
declare const ANIMONLY: string;

function report(): void {
  const name = PHASES[k];
  if (!name) return;
  if (hashing) {
    console.log(`[fps] hash ${name} ${composed} ${(h >>> 0).toString(16)}  seen: ${[...seen].join(" ")}`);
    seen.clear();
    h = 0x811c9dc5 | 0;
    return;
  }
  const c = Math.max(1, startProf ? starts : slowOnly ? slowCount : composed);
  if (slowOnly) console.log(`[fps] ${slowCount} composes/ticks past ${typeof SLOW !== "undefined" ? SLOW : LOGICSLOW} us; the split below is per slow compose`);
  slowCount = 0;
  console.log(`[fps] ${name}: ${composed} composed; guest per composed frame avg ${(segUs / c / 1000).toFixed(2)} ms max ${(segMax / 1000).toFixed(1)}; game.draw ${(drawUs / c / 1000).toFixed(2)} ms`);
  if (wrapping) {
    const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 40);
    for (const [key, s] of rows) console.log(`[fps]   ${(s.us / c).toFixed(1).padStart(8)} us  ${(s.n / c).toFixed(1).padStart(7)} calls  ${key}`);
  }
  for (const key of Object.keys(stats)) delete stats[key];
}

// HUDBENCH=1: once the battle stands at its menu, each side's HUD cells drawn
// 200 times over (G.push/pop round each, into the Lcd as it stands), timed
// (with WRAP, split), then the segment goes on
declare const HUDBENCH: boolean;
let hudBenched = false;
function hudBench(st: any): void {
  if (hudBenched || typeof HUDBENCH === "undefined" || !HUDBENCH) return;
  if (st?.screenId !== "Gen2BattleState" || st.phase !== "menu" || !st.staged3d) return;
  hudBenched = true;
  for (const key of Object.keys(stats)) delete stats[key];
  const was = on;
  on = true;
  const lcd = (globalThis as any).__gen2Lcd;
  const enemy = st.activeMon("enemy");
  const player = st.activeMon("player");
  for (const [side, fn] of [["enemy", () => st.drawEnemyHudCells(enemy)], ["player", () => st.drawPlayerHudCells(player)]] as [string, () => void][]) {
    const a = now();
    for (let i = 0; i < 200; i++) {
      lcd.begin();
      G.push();
      try { fn(); } finally { G.pop(); }
    }
    console.log(`[fps] hudbench ${side}: ${((now() - a) / 200).toFixed(1)} us a draw`);
  }
  on = was;
  const rows = Object.entries(stats).sort((x, y) => y[1].us - x[1].us).slice(0, 25);
  for (const [key, s] of rows) console.log(`[fps]   ${(s.us / 400).toFixed(1).padStart(8)} us  ${(s.n / 400).toFixed(1).padStart(7)} calls  ${key}`);
  for (const key of Object.keys(stats)) delete stats[key];
}
let lastTop = "";
const seen = new Set<string>();
g.frame = (b: number): void => {
  n++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  let pad = 0;
  if (ready < 0 && game.world?.map && game.phase === "play") {
    game.options.view = "3d";
    game.options.battleView = "3d";
    game.options.movement = "grid";
    game.options.battleScene = true;
    game.save.party = party();
    game.save.repelSteps = 60000;
    if (game.world) game.world.trainerBeaten = () => true;
    game.setGameSpeed(typeof SPEED !== "undefined" ? SPEED : 1);
    ready = n + 60;
  }
  if (ready >= 0 && n >= ready) {
    const seg = Math.floor((n - ready) / SEG);
    const t = (n - ready) % SEG;
    if (seg !== k) {
      report();
      k = seg;
      composed = segUs = segMax = acc = drawUs = 0;
      if (!PHASES[k]) {
        console.log("[fps] done");
        ready = Number.MAX_SAFE_INTEGER;
      } else {
        battleDone = true;
        mixDone = true;
        animState = null;
        animStats = null;
        while (game.stack.top()) game.stack.pop();
        if (PHASES[k] === "battle" || PHASES[k] === "battlemix" || PHASES[k] === "anims") game.world.setMap("ROUTE_29", 20, 8, "down");
      }
    }
    const phase = PHASES[k];
    if (phase === "battle") pad = battlePad(t);
    else if (phase === "menu") pad = menuPad(t);
    else if (phase === "menusub") pad = menuSubPad(t);
    else if (phase === "battlemix") pad = battleMixPad(t);
    else if (phase === "anims") pad = animsPad(t);
    // the first 120 steps settle (the screen's fade in, the battle's intro);
    // BUSY=1 counts only the battle's frames off its menus (the turns)
    const st = game.stack.top();
    on = (typeof ANIMONLY === "undefined" || !!(animStats && animStats.name.startsWith(ANIMONLY))) && !startProf && t > (typeof SETTLE !== "undefined" ? SETTLE : 120) && !!phase && (!busyOnly || (st?.screenId === "Gen2BattleState" && st.phase !== "menu" && st.phase !== "moves"));
  }
  const topObj = game.stack.top();
  hudBench(topObj);
  const top = topObj?.screenId ?? "-";
  if (top !== lastTop) lastTop = top;
  if (topObj && wrapping) wrap(Object.getPrototypeOf(topObj), `top:${top}`);
  if (topObj?.battle && wrapping) wrap(Object.getPrototypeOf(topObj.battle), "Battle");
  if (game.world && wrapping) wrap(Object.getPrototypeOf(game.world), "World");
  if (hashing && on) {
    for (const s of game.stack.screens ?? game.stack.items ?? []) seen.add(s?.screenId ?? "?");
    seen.add(top);
    const st = game.stack.top();
    if (st?.phase) seen.add(`${top}:${st.phase}`);
  }
  const a = now();
  mainFrame((b & ~0xff) | pad);
  const spent = now() - a;
  // the harness has no lastStep: main.ts composes every other step
  acc += spent;
  if ((n & 1) === 0) {
    if (on) {
      composed++;
      segUs += acc;
      if (acc > segMax) segMax = acc;
      if (hashing) hashTop();
    }
    acc = 0;
  }
};

// the top screen's state after a composed frame (the Lcd main.ts drew into)
function hashTop(): void {
  const lcd = (G as any) && (globalThis as any).__gen2Lcd;
  if (!lcd) return;
  const st = lcd.s;
  for (let i = 0; i < 2048; i++) mix((st.cells[i]! << 8) | st.attrs[i]!);
  mix(st.objs.length);
  for (const o of st.objs) {
    mix(o.x);
    mix(o.y);
    mix(o.tile);
    mix(o.attr);
  }
  for (let i = 0; i < 128; i++) mix(st.colours[i]!);
  mix(st.scx);
  mix(st.scy);
  mix(st.wx);
  mix(st.wy);
  mix(st.flags);
  mix(st.lineTarget);
}
