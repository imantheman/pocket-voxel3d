// Micro-benchmark of the Gold screen's drawing layer under QuickJS (bundle
// this and run it in tools/qjs_gold_harness.c with PROF=1): a full-screen
// fill, a box, three lines of text, and the frame diff, timed per phase.
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import G, { putTile, resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
const host = {} as never; // every op optional: nothing is sent
const lcd = new Lcd(host);
lcd.shown = true;
setLcd(lcd);
const pal: [number, number, number][] = [[255, 255, 255], [160, 160, 160], [80, 80, 80], [0, 0, 0]];
const t = { begin: 0, fill: 0, tiles: 0, end: 0, n: 0 };
(globalThis as unknown as { frame: (b: number) => void }).frame = (): void => {
  const a = now();
  lcd.begin();
  resetDrawState();
  const b = now();
  G.setColor(1, 1, 1, 1);
  G.rectangle("fill", 0, 0, 160, 144);
  const c = now();
  G.palette = pal;
  for (let i = 0; i < 360; i++) putTile(0x80 + (i & 63), (i % 20) * 8, Math.floor(i / 20) * 8);
  const d = now();
  lcd.end();
  const e = now();
  t.begin += b - a;
  t.fill += c - b;
  t.tiles += d - c;
  t.end += e - d;
  if (++t.n === 300) {
    console.log(`[bench] us: begin ${(t.begin / 300).toFixed(1)} fill360 ${(t.fill / 300).toFixed(1)} tiles360 ${(t.tiles / 300).toFixed(1)} end ${(t.end / 300).toFixed(1)}`);
    t.begin = t.fill = t.tiles = t.end = t.n = 0;
  }
};
