// A Citra check of COPY SAVE (Red, Blue or Yellow; bundled in place of
// game.js with tools/vc_bench_fake.ts's stand-in VC title): through the boot
// movie to the title, then COPY SAVE -> LUA TO VC -> YES and COPY SAVE ->
// VC TO LUA -> YES, a top-screen shot of each choice and confirm screen,
// every step on pvlog as "[pv] vcbench: ..." beside the game's own
// "[pv] vc: copy: ..." lines. The Lua side is the real one (the save file
// on the emulator's card, its copy in save_backup/). Never shipped.
//
//   --define VC_COPY='"lua-vc"' / '"vc-lua"': that direction only
//   --define VC_COPY_NO=true: answer NO instead (nothing may be written)
import "./vc_bench_fake.ts";
import "../voxelmon/game/psp-main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { COPY_SAVE_TEXT } from "../voxelmon/game/vc/copysave.ts";

declare const VC_COPY: string;
declare const VC_COPY_NO: boolean;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void; voxel: Record<string, any> };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const log = (s: string): void => console.log(`[pv] vcbench: ${s}`);

// The stand-in title keeps what it was given, as a real title's save does
// (vc.rs keeps the written bytes as the save vcData hands back).
{
  const v = g.voxel;
  const write = v.vcWrite as ((b: Uint8Array) => boolean) | undefined;
  const read = v.vcData as (() => ArrayBuffer | undefined) | undefined;
  let kept: Uint8Array | null = null;
  if (write && read) {
    v.vcWrite = (b: Uint8Array): boolean => {
      const ok = write(b);
      if (ok) kept = new Uint8Array(b);
      return ok;
    };
    v.vcData = (): ArrayBuffer | undefined => (kept ? kept.slice().buffer : read());
  }
}

const dirs: ("lua-vc" | "vc-lua")[] = typeof VC_COPY !== "undefined" ? [VC_COPY as "lua-vc" | "vc-lua"] : ["lua-vc", "vc-lua"];
const yes = !(typeof VC_COPY_NO !== "undefined" && VC_COPY_NO);
let n = 0;
let phase = 0;
let at = 0;
let k = 0;

const boxText = (): string => {
  const st = game.stack?.at(-1);
  return (st?.box?.pages ?? []).map((p: { lines: string[] }) => p.lines.join("/")).join(" | ");
};
const saves = (): string => {
  const c = game.saveChoices;
  const s = (x: any): string => (x ? `${x.name} ${x.badges}b ${x.owned}dex ${x.seconds}s` : "none");
  return `lua ${s(c?.lua)}; vc ${s(c?.vc)}; copy ${JSON.stringify(game.copyChoice ?? null)}`;
};

function step(): number {
  const top = game.stackKinds().at(-1);
  const t = top === "title" ? game.title() : null;
  const since = n - at;
  const next = (p: number): void => { phase = p; at = n; };
  switch (phase) {
    case 0: // the boot movie, then PRESS START
      if (t?.phase === "menu") { log(`title menu: ${t.menu.join(" / ")}; ${saves()}`); next(1); return 0; }
      return n % 30 === 0 ? VOX_BTN.start : 0;
    case 1: { // to COPY SAVE, then A
      if (since < 20) return 0;
      if (k >= dirs.length) { log(`done; ${saves()}`); native.screenshot?.(); next(99); return 0; }
      const want = t?.menu?.indexOf(COPY_SAVE_TEXT.menu) ?? -1;
      if (want < 0) { log(`no ${COPY_SAVE_TEXT.menu} in the menu (${t?.menu?.join(" / ")}); stopping`); next(99); return 0; }
      if (t.index !== want) return n % 10 === 0 ? VOX_BTN.down : 0;
      next(2);
      return VOX_BTN.a;
    }
    case 2: { // the direction
      if (since < 20) return 0;
      if (t?.phase !== "pick") { log(`no choice (${top} ${t?.phase})`); next(99); return 0; }
      const label = COPY_SAVE_TEXT.choices[dirs[k]!];
      const want = t.menu.indexOf(label);
      if (since === 20) { log(`copy choice: ${t.menu.join(" / ")}`); native.screenshot?.(); }
      if (want < 0) { log(`${label} not offered; back`); next(1); k++; return VOX_BTN.b; }
      if (t.index !== want) return n % 10 === 0 ? VOX_BTN.down : 0;
      if (since < 40) return 0;
      log(`picked ${label}`);
      next(3);
      return VOX_BTN.a;
    }
    case 3: // the question types out; the confirm screen
      if (top === "choice") {
        log(`confirm: "${boxText()}"; panel ${(game.savePanel() ?? []).join(" | ")}`);
        native.screenshot?.();
        next(4);
        return 0;
      }
      if (since > 600) { log(`no question (${top})`); next(99); return 0; }
      return 0;
    case 4: // YES (up from NO) or NO, then A
      if (since === 30) return yes ? VOX_BTN.up : 0;
      if (since === 50) { log(`answer ${yes ? "YES" : "NO"}`); next(5); return VOX_BTN.a; }
      return 0;
    case 5: // through "Copying..." and the message, back to the title
      if (top === "title") {
        log(`back at the title: menu ${t.menu.join(" / ")} at ${t.menu[t.index]}; ${saves()}`);
        k++;
        next(1);
        return 0;
      }
      if (top === "textbox" && since % 40 === 39) {
        log(`message: "${boxText()}"`);
        if (since > 80) return VOX_BTN.a;
      }
      if (since > 3000) { log(`stuck at ${top}`); next(99); }
      return 0;
    default:
      return 0;
  }
}

g.frame = (b: number): void => {
  n++;
  const pad = step();
  if (n % 600 === 0) log(`tick ${n}: ${game.stackKinds().join(",")} phase ${phase}`);
  mainFrame((b & ~0xff) | pad);
};
