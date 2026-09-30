// gen1recomp src/core/Input.lua (bdfac727): the Game Boy buttons as the
// engine reads them -- held state, press edges queued between steps, button
// aliases, the capture hook, and the four-button soft reset.
//
// The desktop's keyboard, gamepad, hat, stick and touch sources are gone:
// the 3DS pad arrives once per host tick as a VOX_BTN mask through
// `setButtons`, which presses and releases through the same source-counted
// press()/release() the Lua's devices use ("pad3ds:<button>"). Everything
// downstream -- step(), wasPressed(), isDown() -- is the Lua's.

import { VOX_BTN } from "../../../../../contracts/spec/voxel-spec.ts";

type Btn = string;

// Input.lua:548
const SOFT_RESET_FRAMES = 16;

const PAD_BITS: [Btn, number][] = [
  ["up", VOX_BTN.up],
  ["down", VOX_BTN.down],
  ["left", VOX_BTN.left],
  ["right", VOX_BTN.right],
  ["a", VOX_BTN.a],
  ["b", VOX_BTN.b],
  ["start", VOX_BTN.start],
  ["select", VOX_BTN.select],
];

function press(self: typeof Input, btn: Btn, source: string): void {
  let sources = self.sources[btn];
  if (!sources) self.sources[btn] = sources = new Set();
  if (!sources.has(source)) {
    sources.add(source);
    self.pressQueue.push(btn);
  }
  self.state[btn] = true;
}

function release(self: typeof Input, btn: Btn, source: string): void {
  const sources = self.sources[btn];
  if (sources) {
    sources.delete(source);
    if (sources.size === 0) self.state[btn] = false;
  } else {
    self.state[btn] = false;
  }
}

export const Input = {
  state: {} as Record<Btn, boolean>,
  pressQueue: [] as Btn[],
  pressed: {} as Record<Btn, boolean>,
  sources: {} as Record<Btn, Set<string>>,
  aliases: null as Record<Btn, Btn> | null,
  aliasHeld: null as Record<Btn, boolean> | null,
  captureArmed: false,
  captureEvents: null as { kind: string; phase: string; value: unknown }[] | null,
  softResetFrames: null as number | null,
  /** The last mask setButtons saw. */
  padMask: 0,

  init(): void {
    Input.reset();
  },
  applyBindings(_overlay?: unknown): void {},

  reset(): void {
    Input.state = {};
    Input.pressQueue = [];
    Input.pressed = {};
    Input.sources = {};
    Input.captureArmed = false;
    Input.captureEvents = null;
    Input.aliases = null;
    Input.aliasHeld = null;
    Input.padMask = 0;
  },

  /** The 3DS pad for this tick (VOX_BTN bits): presses and releases by edge. */
  setButtons(mask: number): void {
    for (const [btn, bit] of PAD_BITS) {
      const down = (mask & bit) !== 0;
      const was = (Input.padMask & bit) !== 0;
      if (down && !was) press(Input, btn, `pad3ds:${btn}`);
      else if (!down && was) release(Input, btn, `pad3ds:${btn}`);
    }
    Input.padMask = mask;
  },

  setButtonAlias(src: Btn, dst: Btn | null | undefined): void {
    if (dst == null) {
      if (Input.aliases) {
        delete Input.aliases[src];
        if (Object.keys(Input.aliases).length === 0) Input.aliases = null;
      }
      return;
    }
    (Input.aliases ??= {})[src] = dst;
  },

  armCapture(): void {
    Input.captureArmed = true;
    Input.captureEvents = [];
  },
  disarmCapture(): void {
    Input.captureArmed = false;
    Input.captureEvents = null;
  },
  takeCaptureEvents(): { kind: string; phase: string; value: unknown }[] | null {
    const ev = Input.captureEvents;
    Input.captureEvents = Input.captureArmed ? [] : null;
    return ev;
  },

  /** Input.lua:356 -- latch the presses queued since the last step. */
  step(): void {
    Input.pressed = {};
    for (const btn of Input.pressQueue) {
      Input.pressed[btn] = true;
      const sources = Input.sources[btn];
      if (sources === undefined || sources.size > 0) Input.state[btn] = true;
    }
    for (const [btn, sources] of Object.entries(Input.sources)) if (sources.size === 0) delete Input.sources[btn];
    Input.pressQueue = [];
    let held: Record<Btn, boolean> | null = null;
    if (Input.aliases) {
      for (const [src, dst] of Object.entries(Input.aliases)) {
        if (Input.pressed[src]) Input.pressed[dst] = true;
        if (Input.state[src]) (held ??= {})[dst] = true;
      }
    }
    Input.aliasHeld = held;
  },

  // the on-screen pad and scripted sources (AutoInput) press through these
  overlayPressed(btn: Btn): void {
    press(Input, btn, `touch:${btn}`);
  },
  overlayReleased(btn: Btn): void {
    release(Input, btn, `touch:${btn}`);
  },
  sourcePress(btn: Btn, source: string): void {
    press(Input, btn, source);
  },
  sourceRelease(btn: Btn, source: string): void {
    release(Input, btn, source);
  },

  /** Input.lua:475 -- re-press whatever the pad is still holding. */
  reconcile(): void {
    for (const [btn, bit] of PAD_BITS) if (Input.padMask & bit) press(Input, btn, `pad3ds:${btn}`);
  },

  isDown(btn: Btn): boolean {
    if (Input.state[btn]) return true;
    return Input.aliasHeld?.[btn] ?? false;
  },
  isTouchDown(btn: Btn): boolean {
    return Input.sources[btn]?.has(`touch:${btn}`) ?? false;
  },
  wasPressed(btn: Btn): boolean {
    return Input.pressed[btn] ?? false;
  },

  /** Input.lua:561 -- A+B+START+SELECT and no direction. */
  softResetHeld(): boolean {
    const s = Input.state;
    if (!(s.a && s.b && s.start && s.select)) return false;
    return !(s.up || s.down || s.left || s.right);
  },
  softResetStep(): boolean {
    if (!Input.softResetHeld()) {
      Input.softResetFrames = null;
      return false;
    }
    const left = (Input.softResetFrames ?? SOFT_RESET_FRAMES) - 1;
    Input.softResetFrames = left;
    if (left > 0) return false;
    Input.softResetFrames = null;
    return true;
  },

  // desktop device callbacks: nothing calls them here
  keypressed(_k: string): void {},
  keyreleased(_k: string): void {},
  gamepadpressed(..._a: unknown[]): void {},
  gamepadreleased(..._a: unknown[]): void {},
  gamepadaxis(..._a: unknown[]): void {},
  joystickpressed(..._a: unknown[]): void {},
  joystickreleased(..._a: unknown[]): void {},
  joystickaxis(..._a: unknown[]): void {},
  joystickhat(..._a: unknown[]): void {},
  triggerAxis(..._a: unknown[]): null {
    return null;
  },
  padAction(_b: string): null {
    return null;
  },
  joyAction(_i: number): null {
    return null;
  },
};

export default Input;
