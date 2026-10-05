// FireRed on the desktop, end to end: Game3.new():load() on the reference
// cache (DesktopHost), frames pumped at 60 Hz with scripted buttons, the
// screen saved as PNGs at chosen frames. The integration check the runtime
// port converges on; also how a boot problem is found before a 3DS build.
//   bun tools/gen3/boot_harness.ts [frames=900] [shotEvery=150] [script]
// script: comma list of frame:buttons, buttons from A B START SELECT UP
// DOWN LEFT RIGHT L R X Y joined with +, e.g. "300:START,420:A,600:A".
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const FRAMES = Number(process.argv[2] ?? 900);
const EVERY = Number(process.argv[3] ?? 150);
const SCRIPT = process.argv[4] ?? "240:START,330:A,420:A,520:A,620:A,720:A,820:A";
const OUT = "/tmp/g3boot";
mkdirSync(OUT, { recursive: true });

// Input.hostButtons' layout: bits 0-7 VOX_BTN (up down left right A B START SELECT), 8 L, 9 R, 10 X, 11 Y
const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7, L: 8, R: 9, X: 10, Y: 11 };
const presses = new Map<number, number>();
for (const part of SCRIPT.split(",").filter(Boolean)) {
  const [f, keys] = part.split(":");
  let m = 0;
  for (const k of keys!.split("+")) m |= 1 << BIT[k.toUpperCase()]!;
  presses.set(Number(f), m);
}

const host = new DesktopHost(join(homedir(), "gen3ref/frfull"));
setHost(host);
setSaveStore(memorySaveStore());
const audio = silentAudio();
setAudio(audio);

const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const game: any = Game3.new();
const t0 = performance.now();
game.load({});
console.log(`load: ${(performance.now() - t0).toFixed(0)} ms, phase=${game.phase}`);

let held = 0;
const tf = performance.now();
for (let f = 1; f <= FRAMES; f++) {
  const press = presses.get(f);
  if (press !== undefined) held = press;
  else if (presses.has(f - 6)) held = 0; // a press lasts 6 frames
  (Input as any).hostButtons(held);
  game.update(1 / 60);
  G.beginFrame();
  game.draw();
  G.endFrame();
  if (f % EVERY === 0 || press !== undefined) {
    const name = `${OUT}/f${String(f).padStart(5, "0")}.png`;
    writeFileSync(name, encodePng(240, 160, host.pixels()));
    console.log(`frame ${f}: phase=${game.phase} shot ${name}`);
  }
}
console.log(`${FRAMES} frames in ${((performance.now() - tf) / 1000).toFixed(1)} s; audio: ${audio.log.slice(-6).join(" | ")}`);
