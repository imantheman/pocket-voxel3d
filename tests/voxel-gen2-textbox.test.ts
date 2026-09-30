// The Gen 2 dialogue box (voxelmon/game/gen2/shared/render/TextBox.ts) on
// real Gold text, driven through Input and the StateStack.

import { describe, expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { Sound } from "../voxelmon/game/gen2/shared/core/Sound.ts";
import { StateStack } from "../voxelmon/game/gen2/shared/core/StateStack.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { TextBox } from "../voxelmon/game/gen2/shared/render/TextBox.ts";

const gold = haveGoldGen();

// the sound port lands separately; the box only needs its calls to exist
const S = Sound as unknown as Record<string, unknown>;
if (String(S.play).includes("notPorted")) {
  S.play = () => null;
  S.playPress = () => null;
  S.sfxBusy = () => false;
}

function game() {
  return {
    input: Input,
    stack: StateStack.init(),
    data: {},
    save: { generation: 2, player: { name: "GOLD", rival: "SILVER" }, options: { textSpeed: "FAST" } },
  };
}

/** One frame: pad in, step, update the top state. */
function frame(g: ReturnType<typeof game>, buttons = 0): void {
  Input.setButtons(buttons);
  Input.step();
  g.stack.update(1 / 60);
}

describe("gen2 input", () => {
  test("press edges, held state, soft reset", () => {
    Input.reset();
    Input.setButtons(VOX_BTN.a);
    Input.step();
    expect(Input.wasPressed("a")).toBe(true);
    expect(Input.isDown("a")).toBe(true);
    Input.setButtons(VOX_BTN.a);
    Input.step();
    expect(Input.wasPressed("a")).toBe(false);
    expect(Input.isDown("a")).toBe(true);
    Input.setButtons(0);
    Input.step();
    expect(Input.isDown("a")).toBe(false);
    const all = VOX_BTN.a | VOX_BTN.b | VOX_BTN.start | VOX_BTN.select;
    Input.setButtons(all);
    let fired = 0;
    for (let i = 0; i < 16; i++) if (Input.softResetStep()) fired++;
    expect(fired).toBe(1);
  });
});

describe("gen2 text box", () => {
  test("paginates on \\f, \\n and the \\v wait, and wraps at 18 columns", () => {
    const pages = TextBox.paginate("I'm the DAY-CARE\nMAN. Want me to\vraise a POKéMON?{DONE}");
    expect(pages.length).toBe(1);
    expect(pages[0]).toEqual(["I'm the DAY-CARE", "MAN. Want me to", "raise a POKéMON?"]);
    expect(pages.contBefore![0]).toEqual([false, false, true]);
    expect(TextBox.ending("x{DONE}")).toBe("done");
    expect(TextBox.ending("x{PROMPT}")).toBe("prompt");
  });

  test("tokens", () => {
    const g = game();
    expect(TextBox.substitute(g, "{PLAYER} and {RIVAL}")).toBe("GOLD and SILVER");
  });

  test.skipIf(!gold)("types a real Gold text to the end and closes on A", async () => {
    useGoldGen();
    const { useGoldTiles, shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    Font.load({ font: loadGenerated("font") });
    const text = (loadGenerated<Record<string, string>>("text")!)["64:55bd"]!;
    expect(text).toContain("DAY-CARE");
    const g = game();
    let closed = false;
    Input.reset();
    const box = TextBox.new(g, text, () => (closed = true));
    g.stack.push(box);
    const lcd = new Lcd(new RecorderHost());
    lcd.shown = true;
    setLcd(lcd);
    let frames = 0;
    let shot = false;
    while (!closed && frames < 5000) {
      // tap A whenever the box waits
      const press = box.waiting || box.done ? (frames % 2 === 0 ? VOX_BTN.a : 0) : 0;
      frame(g, press);
      frames++;
      if (!shot && box.waiting && process.env.GOLD_SHOTS) {
        lcd.begin();
        resetDrawState();
        g.stack.draw();
        shotLcd(lcd.s, `${process.env.GOLD_SHOTS}/textbox_daycare.png`);
        shot = true;
      }
    }
    expect(closed).toBe(true);
    expect(g.stack.states.length).toBe(0);
  });

  test.skipIf(!gold)("a YES/NO choice answered both ways", () => {
    useGoldGen();
    Font.load({ font: loadGenerated("font") });
    for (const [presses, want] of [[[VOX_BTN.a], true], [[VOX_BTN.down, VOX_BTN.a], false]] as const) {
      const g = game();
      Input.reset();
      let answer: boolean | null = null;
      g.stack.push(TextBox.new(g, "Save the game?", undefined, { choice: (yes) => (answer = yes) }));
      for (let i = 0; i < 60; i++) frame(g);
      expect(g.stack.states.length).toBe(2); // the box and its choice
      for (const b of presses) {
        frame(g, b);
        frame(g, 0);
      }
      for (let i = 0; i < 30; i++) frame(g);
      expect(answer).toBe(want);
      expect(g.stack.states.length).toBe(0);
    }
  });
});
