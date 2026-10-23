// The save's `version` on Blue (voxelmon/game/saveversion.ts): Blue writes
// "blue", as gen1recomp's Blue does, so a Blue save moves to the PC game's
// SYNC (which refuses a save of another game) and back. Blue's older saves
// say "red": they still load, and the next SAVE writes "blue". Red is as it
// was. Every path a save is made by: a new game, CONTINUE, the VC save's
// conversion.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { loadRuntimeData, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import { toDisk } from "../voxelmon/game/savecompat.ts";
import { adoptSaveVersion, newSaveVersion } from "../voxelmon/game/saveversion.ts";
import { cartToSave, saveToCart } from "../voxelmon/game/vc/cartsave.ts";
import { validateGen1 } from "../voxelmon/game/ui/syncscreen.ts";

const root = join(import.meta.dir, "..");
async function load(dir: string, v: string): Promise<VoxelmonData | null> {
  const d = join(root, dir);
  if (!existsSync(join(d, "pokemon.json"))) return null;
  const data = await loadRuntimeData(d);
  (data as { version?: string }).version ??= v;
  return data;
}
const red = await load("dist/voxelmon/gen", "red");
const blue = await load("dist/voxelmon/blue/gen", "blue");

class Card extends RecorderHost {
  saveText: string | undefined;
  writes: string[] = [];
  constructor(text?: string) {
    super();
    this.saveText = text;
  }
  saveData(): string | undefined { return this.saveText; }
  saveWrite(t: string): boolean { this.saveText = t; this.writes.push(t); return true; }
}

/** A game's new-game save, as the card would hold it, with `version` set. */
function saveText(data: VoxelmonData, version: string | undefined, name = "OLDBLUE"): string {
  const g = new VoxelmonGame(data, new RecorderHost(), 1);
  g.newGame();
  const s: any = JSON.parse(JSON.stringify(g.save));
  s.player.name = name;
  s.player.map = "PALLET_TOWN"; s.player.x = 5; s.player.y = 6;
  if (version === undefined) delete s.version; else s.version = version;
  return encodeSave(toDisk(s));
}

/** Boot to the title's menu, then CONTINUE. */
function continueFrom(data: VoxelmonData, host: Card): VoxelmonGame {
  const g = new VoxelmonGame(data, host, 1);
  g.newGame();
  for (let k = 0; k < 400 && (g as any).title()?.phase !== "menu"; k++) g.tick(k % 8 === 0 ? VOX_BTN.start : 0);
  g.tick(0);
  expect((g as any).title().menu[0]).toBe("CONTINUE");
  g.tick(VOX_BTN.a);
  g.tick(0);
  expect(g.stackKinds()).not.toContain("title");
  return g;
}

describe("the rules", () => {
  test("new saves: Blue says blue, Yellow yellow, Red red", () => {
    expect(newSaveVersion("blue")).toBe("blue");
    expect(newSaveVersion("yellow")).toBe("yellow");
    expect(newSaveVersion("red")).toBe("red");
    expect(newSaveVersion("anything")).toBe("red");
  });

  test("loading: Blue adopts red-tagged and untagged saves; nothing else changes", () => {
    const a: any = { version: "red" };
    expect(adoptSaveVersion(a, "blue")).toBe(true);
    expect(a.version).toBe("blue");
    const b: any = {};
    expect(adoptSaveVersion(b, "blue")).toBe(true);
    expect(b.version).toBe("blue");
    const c: any = { version: "blue" };
    expect(adoptSaveVersion(c, "blue")).toBe(false);
    const d: any = { version: "red" };
    expect(adoptSaveVersion(d, "red")).toBe(false);
    expect(d.version).toBe("red");
    const e: any = { version: "blue" };
    expect(adoptSaveVersion(e, "red")).toBe(false);
    expect(e.version).toBe("blue");
    const f: any = { version: "yellow" };
    expect(adoptSaveVersion(f, "blue")).toBe(false);
  });

  test("SYNC: Blue takes blue and its old red saves; Red takes only red", () => {
    const save = (v: string) => `return {\n  player = {\n    name = "X",\n  },\n  version = "${v}",\n}\n`;
    expect(validateGen1("blue", save("blue"))).toBe(null);
    expect(validateGen1("blue", save("red"))).toBe(null);
    expect(validateGen1("red", save("red"))).toBe(null);
    expect(validateGen1("red", save("blue"))).toBe("SAVE IS BLUE");
  });
});

describe("Blue", () => {
  test.skipIf(!blue)("a new game's save says blue", () => {
    const g = new VoxelmonGame(blue!, new RecorderHost(), 1);
    g.newGame();
    expect((g.save as any).version).toBe("blue");
    expect(decodeSave(encodeSave(toDisk(g.save as any))).version).toBe("blue");
  });

  test.skipIf(!blue)("an old red-tagged Blue save still continues, and the next SAVE writes blue", () => {
    const host = new Card(saveText(blue!, "red"));
    const g = continueFrom(blue!, host);
    expect((g.save as any).player.name).toBe("OLDBLUE");
    expect((g.save as any).version).toBe("blue");
    g.writeSave();
    expect(host.writes.length).toBe(1);
    const written: any = decodeSave(host.writes[0]!);
    expect(written.version).toBe("blue");
    expect(written.player.name).toBe("OLDBLUE");
    // which the PC game's SYNC check (version == its game) now passes
    expect(written.version === "blue").toBe(true);
  });

  test.skipIf(!blue)("an untagged save continues on Blue as blue", () => {
    const host = new Card(saveText(blue!, undefined));
    const g = continueFrom(blue!, host);
    expect((g.save as any).version).toBe("blue");
  });

  test.skipIf(!blue)("a save from the PC's Blue (version blue) continues and stays blue", () => {
    const host = new Card(saveText(blue!, "blue", "PCBLUE"));
    const g = continueFrom(blue!, host);
    expect((g.save as any).player.name).toBe("PCBLUE");
    g.writeSave();
    expect(decodeSave(host.writes[0]!).version).toBe("blue");
  });

  test.skipIf(!blue || !(blue as any)?.vcsave)("the VC save's conversion says blue", () => {
    const s: any = decodeSave(saveText(blue!, "blue", "VCBLUE"));
    const cart = saveToCart(s, blue as never).bytes;
    const { save } = cartToSave(cart, blue as never);
    expect(save.version).toBe("blue");
    expect(save.player.name).toBe("VCBLUE");
  });
});

describe("Red is as it was", () => {
  test.skipIf(!red)("a new game's save says red", () => {
    const g = new VoxelmonGame(red!, new RecorderHost(), 1);
    g.newGame();
    expect((g.save as any).version).toBe("red");
  });

  test.skipIf(!red)("a red save continues as red and saves as red", () => {
    const host = new Card(saveText(red!, "red", "REDONE"));
    const g = continueFrom(red!, host);
    expect((g.save as any).version).toBe("red");
    g.writeSave();
    expect(decodeSave(host.writes[0]!).version).toBe("red");
  });

  test.skipIf(!red || !(red as any)?.vcsave)("the VC save's conversion says red", () => {
    const s: any = decodeSave(saveText(red!, "red", "VCRED"));
    const { save } = cartToSave(saveToCart(s, red as never).bytes, red as never);
    expect(save.version).toBe("red");
  });
});
