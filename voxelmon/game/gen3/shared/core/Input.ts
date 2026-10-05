// Port of gen1recomp src/core/Input.lua (GPLv3 + additional terms; see LICENSE.md).
// Input abstraction: maps keyboard/gamepad to Game Boy buttons. `down` =
// held this frame; `pressed` = edge, consumed per fixed step.
//
// THE HOST SEAM. The 3DS pad is a gamepad, so it enters exactly where an
// SDL game controller enters Brian's engine: love.gamepadpressed /
// gamepadreleased. Once per host tick the entry calls
//
//     Input.hostButtons(mask)
//
// with the pad's held buttons in this layout (bits 0-7 are VOX_BTN's):
//
//     bit 0 up    1 down   2 left   3 right   4 A   5 B   6 START   7 SELECT
//     bit 8 L     9 R     10 X     11 Y
//
// Each bit that changed since the last call raises gamepadpressed /
// gamepadreleased(HOST_PAD, <SDL button name>) on the host sink -- Game3,
// which registers itself in Game3:load (Input.setHostSink), so its chord /
// fast-forward / mod-hook logic (Game3:gamepadpressed) runs as on the
// desktop; with no sink the events go to Input's own gamepadpressed. The
// names are SDL's: dpup dpdown dpleft dpright a b start back leftshoulder
// rightshoulder x y, so Brian's DEFAULT_GAMEPAD_BINDINGS map them (back =
// SELECT, shoulders = L/R, X/Y unbound). HOST_PAD is the joystick object
// those events carry: isGamepad() is true and isGamepadDown(name) reads the
// last mask, which is what Input:reconcile and Game3's SELECT-held test
// query.
//
// The desktop devices are absent: no love.keyboard (keypressed is still
// ported and still fed by Game3:keypressed), no love.joystick list for
// pollPads (it returns at once, as Brian's does without love.joystick).
//
// GamepadMap (src/core/GamepadMap.lua) is an inert module in this runtime;
// the tables and lookups Input uses from it are ported here, non-NX
// branch (the Switch tables apply only when love reports NX).

import { ipairs, isEmpty, len, pairs, sort } from "../../platform/lt.ts";
import { match } from "../../platform/lpattern.ts";
import { tonumber } from "../../../../import/gen3/lua.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- src/core/GamepadMap.lua (the parts Input uses)

// Lua: GamepadMap.lua:7
const DEFAULT_GAMEPAD_BINDINGS: Record<string, string> = {
  dpup: "up", dpdown: "down", dpleft: "left", dpright: "right",
  a: "a", b: "b",
  start: "start", back: "select",
};
// Lua: GamepadMap.lua:13
const TRIGGER_AXES: Record<string, string> = {
  triggerleft: "triggerleft", lefttrigger: "triggerleft",
  triggerright: "triggerright", righttrigger: "triggerright",
};
const TRIGGER_ON = 0.4;
const TRIGGER_OFF = 0.2;
// Lua: GamepadMap.lua:20
const DEFAULT_PAD_ACTIONS: Record<string, string> = {
  rightshoulder: "speedUp", triggerright: "speedUp",
  leftshoulder: "speedDown", triggerleft: "speedDown",
};
// Lua: GamepadMap.lua:41
const RAW_BUTTON_BINDINGS: Record<number, string> = {
  1: "a", 2: "b",
  7: "select", 8: "start", 9: "select", 10: "start",
};

/** src/core/GamepadMap.lua's lookups (non-NX), also used by Game3's pad handlers. */
export const GamepadMap = {
  TRIGGER_AXES,
  TRIGGER_ON,
  TRIGGER_OFF,
  DEFAULT_PAD_ACTIONS,
  // Lua: GamepadMap.lua:84 (non-NX)
  gamepadBindings(): Record<string, string> { return DEFAULT_GAMEPAD_BINDINGS; },
  // Lua: GamepadMap.lua:90 (non-NX)
  rawBindings(): Record<number, string> { return RAW_BUTTON_BINDINGS; },
  // Lua: GamepadMap.lua:95
  mapGamepadButton(button: string): string | undefined { return GamepadMap.gamepadBindings()[button]; },
  // Lua: GamepadMap.lua:119
  displayChordDigit(gamepadButton: string): string | undefined {
    if (gamepadButton === "y") return "5";
    if (gamepadButton === "x") return "6";
    if (gamepadButton === "leftshoulder") return "7";
    if (gamepadButton === "a" || gamepadButton === "b") {
      const gb = GamepadMap.mapGamepadButton(gamepadButton);
      if (gb === "a") return "2";
      if (gb === "b") return "3";
    }
    return undefined;
  },
  // Lua: GamepadMap.lua:133
  ignoreRawForJoystick(joystick: any): boolean {
    if (!joystick) return false;
    try {
      return !!(joystick.isGamepad && joystick.isGamepad() === true);
    } catch {
      return false;
    }
  },
  // Lua: GamepadMap.lua:147
  isAccelerometer(joystick: any): boolean {
    const name = joystick && joystick.getName ? joystick.getName() : undefined;
    return name != null && String(name).toLowerCase().includes("accelerometer");
  },
};

// ---- the host seam

/** Host button bits (see the header). */
export const HOST_BTN = {
  up: 1 << 0, down: 1 << 1, left: 1 << 2, right: 1 << 3,
  a: 1 << 4, b: 1 << 5, start: 1 << 6, select: 1 << 7,
  l: 1 << 8, r: 1 << 9, x: 1 << 10, y: 1 << 11,
} as const;

// host bit -> SDL game-controller button name
const HOST_PAD_BUTTONS: [string, number][] = [
  ["dpup", HOST_BTN.up], ["dpdown", HOST_BTN.down], ["dpleft", HOST_BTN.left], ["dpright", HOST_BTN.right],
  ["a", HOST_BTN.a], ["b", HOST_BTN.b], ["start", HOST_BTN.start], ["back", HOST_BTN.select],
  ["leftshoulder", HOST_BTN.l], ["rightshoulder", HOST_BTN.r], ["x", HOST_BTN.x], ["y", HOST_BTN.y],
];
const HOST_BIT: Record<string, number> = {};
for (const [name, bit] of HOST_PAD_BUTTONS) HOST_BIT[name] = bit;

/** What hostButtons raises events on (Game3, or Input itself). */
export interface HostPadSink {
  gamepadpressed(joystick: any, button: string): unknown;
  gamepadreleased(joystick: any, button: string): unknown;
}

// Lua: Input.lua:36
const STICK_ON = 0.5;
const STICK_OFF = 0.3;

// Lua: Input.lua:9
const DEFAULT_BINDINGS: Record<string, string> = {
  up: "up", w: "up",
  down: "down", s: "down",
  left: "left", a: "left",
  right: "right", d: "right",
  z: "a", ["return"]: "a", space: "a",
  x: "b", backspace: "b",
  kpenter: "start", escape: "start",
  tab: "select",
  rshift: "select",
  lshift: "select",
  q: "l",
  e: "r",
  lctrl: "l",
  rctrl: "r",
};

// Lua: Input.lua:63
const POLLABLE_PAD_BUTTONS: Record<string, boolean> = {
  a: true, b: true, x: true, y: true, back: true, guide: true, start: true,
  leftstick: true, rightstick: true, leftshoulder: true, rightshoulder: true,
  dpup: true, dpdown: true, dpleft: true, dpright: true,
};

// Lua: Input.lua:69
const HAT_DIRECTIONS: Record<string, (string | null)[]> = {
  u: [null, "up"], d: [null, "down"], l: [null, "left"], r: [null, "right"],
  lu: [null, "left", "up"], ru: [null, "right", "up"],
  ld: [null, "left", "down"], rd: [null, "right", "down"],
};

// Lua: Input.lua:727
const SOFT_RESET_FRAMES = 16;

type Sources = Record<string, boolean>;
interface PollEntry { button: string; btn: string; source: string; chord: boolean }

export class InputModule {
  // Lua: Input.lua:61
  PAD_ACTIONS: Record<string, boolean> = { speedUp: true, speedDown: true };

  shoulderGameplay = true;
  keyBindings: Record<string, string> = {};
  padBindings: Record<string, string> = {};
  joyBindings: Record<number, string> = {};
  padActions: Record<string, string> = {};
  explicitPadActions: Record<string, boolean> = {};
  joyActions: Record<number, string> = {};
  padPoll: (PollEntry | null)[] = [null];

  state: Record<string, boolean> = {};
  pressQueue: (string | null)[] = [null];
  pressed: Record<string, boolean> = {};
  sources: Record<string, Sources> = {};
  stickAxis = { x: 0, y: 0 };
  stickDir: string | undefined = undefined;
  hatDirs: Record<string, (string | null)[]> = {};
  triggerHeld: Record<string, boolean> = {};
  captureArmed = false;
  captureEvents: ({ kind: string; phase: string; value: unknown } | null)[] | undefined = undefined;
  aliases: Record<string, string> | undefined = undefined;
  aliasHeld: Record<string, boolean> | undefined = undefined;
  padSuppress: Record<string, boolean> | undefined = undefined;
  softResetFrames: number | undefined = undefined;
  _pollPads: any[] | undefined = undefined;
  _pollPadCount: number | undefined = undefined;
  _ownPressed: Record<string, boolean> | undefined = undefined;
  _ownPressQueue: (string | null)[] | undefined = undefined;

  // the host seam's state
  private hostMask = 0;
  private hostSeen = false;
  private hostSink: HostPadSink | undefined = undefined;

  /** The 3DS pad as a LOVE joystick (an SDL game controller). */
  readonly HOST_PAD = {
    isGamepad: (): boolean => true,
    isConnected: (): boolean => true,
    getName: (): string => "3DS",
    isGamepadDown: (button: string): boolean => {
      const bit = HOST_BIT[button];
      return bit !== undefined && (this.hostMask & bit) !== 0;
    },
  };

  // Lua: Input.lua:146
  hotkeyKey = (key: unknown): unknown => {
    if (typeof key !== "string") return key;
    if (match(key, "^%d$")) return key;
    const bound = this.keyBindings;
    if (bound && bound[key]) return key;
    const digit = match(key, "^kp(%d)$");
    if (digit) return digit;
    // NOT FAITHFUL: love.keyboard.getScancodeFromKey (a layout's digit row) does not exist here
    return key;
  };

  /** Where hostButtons raises its events (Game3:load passes itself). */
  setHostSink(sink: HostPadSink | undefined): void {
    this.hostSink = sink;
  }

  /** The host seam: the pad's held buttons this tick (HOST_BTN bits). */
  hostButtons(mask: number): void {
    const prev = this.hostMask;
    this.hostMask = mask >>> 0;
    this.hostSeen = true;
    const sink: HostPadSink = this.hostSink ?? this;
    for (const [name, bit] of HOST_PAD_BUTTONS) {
      const down = (mask & bit) !== 0, was = (prev & bit) !== 0;
      if (down === was) continue;
      if (down) sink.gamepadpressed(this.HOST_PAD, name);
      else sink.gamepadreleased(this.HOST_PAD, name);
    }
  }

  // Lua: Input.lua:75
  init(shoulderGameplay?: boolean): void {
    this.shoulderGameplay = shoulderGameplay !== false;
    this.applyBindings(undefined);
    this.reset();
  }

  // Lua: Input.lua:88
  applyBindings(overlay: any): void {
    const keys: Record<string, string> = {}, pads: Record<string, string> = {}, joys: Record<number, string> = {};
    const acts: Record<string, string> = {}, explicit: Record<string, boolean> = {};
    for (const [key, action] of pairs(DEFAULT_BINDINGS)) keys[key as string] = action;
    for (const [button, action] of pairs(GamepadMap.gamepadBindings())) pads[button as string] = action;
    pads.leftshoulder = "l";
    pads.rightshoulder = "r";
    for (const [index, action] of pairs(GamepadMap.rawBindings())) joys[index as number] = action;
    for (const [button, action] of pairs(GamepadMap.DEFAULT_PAD_ACTIONS)) acts[button as string] = action;
    const ids: (string | null)[] = [null];
    for (const [id] of pairs(overlay || {})) ids[len(ids) + 1] = id as string;
    sort(ids);
    for (const [, id] of ipairs<string>(ids)) {
      const binding = overlay[id];
      if (!this.PAD_ACTIONS[id]) {
        if (binding != null && typeof binding === "object") {
          if (binding.key) keys[binding.key] = id;
          if (binding.pad) {
            const button = GamepadMap.TRIGGER_AXES[binding.pad] || binding.pad;
            pads[button] = id;
            delete acts[button];
          }
        } else if (typeof binding === "string") keys[binding] = id;
      }
    }
    for (const [, id] of ipairs<string>(ids)) {
      if (this.PAD_ACTIONS[id]) {
        for (const [button, action] of pairs(acts)) {
          if (action === id) delete acts[button as string];
        }
      }
    }
    for (const [, id] of ipairs<string>(ids)) {
      const binding = overlay[id];
      if (this.PAD_ACTIONS[id] && binding != null && typeof binding === "object" && binding.pad) {
        const button = GamepadMap.TRIGGER_AXES[binding.pad] || binding.pad;
        acts[button] = id;
        explicit[button] = true;
        delete pads[button];
      }
    }
    for (const [button, action] of pairs(pads)) {
      const n = tonumber(match(button as string, "^joy(%d+)$"));
      if (n !== undefined) joys[n] = action;
    }
    const joyActs: Record<number, string> = {};
    for (const [button, action] of pairs(acts)) {
      const n = tonumber(match(button as string, "^joy(%d+)$"));
      if (n !== undefined) { joyActs[n] = action; delete joys[n]; }
    }
    const poll: (PollEntry | null)[] = [null];
    const canPoll = true; // gamepadBindings() is never the NX table here
    for (const [button, action] of pairs(pads)) {
      if (canPoll && POLLABLE_PAD_BUTTONS[button as string]) {
        poll[len(poll) + 1] = {
          button: button as string, btn: action, source: "pad:" + button,
          chord: GamepadMap.displayChordDigit(button as string) !== undefined,
        };
      }
    }
    this.keyBindings = keys; this.padBindings = pads; this.joyBindings = joys;
    this.padActions = acts; this.explicitPadActions = explicit; this.joyActions = joyActs;
    this.padPoll = poll;
  }

  // Lua: Input.lua:163
  padAction(buttonIn: string, shoulderGameplay?: boolean): string | undefined {
    const button = GamepadMap.TRIGGER_AXES[buttonIn] || buttonIn;
    if (shoulderGameplay && (button === "leftshoulder" || button === "rightshoulder")
      && !(this.explicitPadActions && this.explicitPadActions[button])) return undefined;
    return (this.padActions && this.padActions[button]) || undefined;
  }

  // Lua: Input.lua:170
  joyAction(index: number): string | undefined {
    return (this.joyActions && this.joyActions[index]) || undefined;
  }

  // Lua: Input.lua:179
  reset(): void {
    this.state = {};
    this.pressQueue = [null];
    this.pressed = {};
    this.sources = {};
    this.stickAxis = { x: 0, y: 0 };
    this.stickDir = undefined;
    this.hatDirs = {};
    this.triggerHeld = {};
    this.captureArmed = false;
    this.captureEvents = undefined;
    this.aliases = undefined;
    this.aliasHeld = undefined;
    this._pollPads = undefined;
    this._pollPadCount = undefined;
    const suppress: Record<string, boolean> = {};
    const poll = this.padPoll;
    if (poll) {
      for (let i = 1; i <= len(poll); i++) suppress[poll[i]!.button] = true;
    }
    this.padSuppress = suppress;
  }

  // Lua: Input.lua:202
  padEventSeen(button: unknown): void {
    if (typeof button !== "string") return;
    let suppress = this.padSuppress;
    if (!suppress) {
      suppress = {};
      this.padSuppress = suppress;
    }
    suppress[button] = true;
  }

  // Lua: Input.lua:213
  setButtonAlias(src: string, dst: string | undefined): void {
    let aliases = this.aliases;
    if (dst == null) {
      if (aliases) {
        delete aliases[src];
        if (isEmpty(aliases)) this.aliases = undefined;
      }
      return;
    }
    if (!aliases) {
      aliases = {};
      this.aliases = aliases;
    }
    aliases[src] = dst;
  }

  // Lua: Input.lua:229
  armCapture(): void {
    this.captureArmed = true;
    this.captureEvents = [null];
  }

  // Lua: Input.lua:234
  disarmCapture(): void {
    this.captureArmed = false;
    this.captureEvents = undefined;
  }

  // Lua: Input.lua:239
  takeCaptureEvents(): ({ kind: string; phase: string; value: unknown } | null)[] | undefined {
    const ev = this.captureEvents;
    this.captureEvents = this.captureArmed ? [null] : undefined;
    return ev;
  }

  // Lua: Input.lua:245
  private noteCapture(kind: string, phase: string, value: unknown): void {
    if (!this.captureArmed) return;
    let ev = this.captureEvents;
    if (!ev) {
      ev = [null];
      this.captureEvents = ev;
    }
    ev[len(ev) + 1] = { kind, phase, value };
  }

  // Lua: Input.lua:259
  private press(btn: string, source: string): void {
    let sources = this.sources[btn];
    if (!sources) {
      sources = {};
      this.sources[btn] = sources;
    }
    if (!sources[source]) {
      sources[source] = true;
      this.pressQueue[len(this.pressQueue) + 1] = btn;
    }
    this.state[btn] = true;
  }

  // Lua: Input.lua:272
  private release(btn: string, source: string): void {
    const sources = this.sources[btn];
    if (sources) {
      delete sources[source];
      if (isEmpty(sources)) {
        this.state[btn] = false;
      }
    } else {
      this.state[btn] = false;
    }
  }

  // Lua: Input.lua:287
  keypressed(key: string): void {
    this.noteCapture("key", "pressed", key);
    const btn = this.keyBindings[key];
    if (btn) {
      this.press(btn, "key:" + key);
    }
  }

  // Lua: Input.lua:295
  keyreleased(key: string): void {
    this.noteCapture("key", "released", key);
    const btn = this.keyBindings[key];
    if (btn) {
      this.release(btn, "key:" + key);
    }
  }

  // Lua: Input.lua:332
  joysticksChanged(): void {
    this._pollPads = undefined;
  }

  // Lua: Input.lua:337 -- love.joystick does not exist on the 3DS (the pad arrives as
  // events through hostButtons), so this returns at its first test, as Brian's does
  // without love.joystick; its helpers (modOwnsPad, notePadRepair, anyPadDown) are
  // therefore not ported.
  pollPads(): void {
    return;
  }

  // Lua: Input.lua:416
  private ownedCleared(field: "pressed" | "pressQueue", ownKey: "_ownPressed" | "_ownPressQueue"): void {
    let own: any = this[ownKey];
    if (own != null && this[field] === own) {
      if (Array.isArray(own)) own.length = 1;
      else for (const k of Object.keys(own)) delete own[k];
    } else {
      own = field === "pressQueue" ? [null] : {};
      (this as any)[ownKey] = own;
    }
    (this as any)[field] = own;
  }

  // Lua: Input.lua:427
  step(): void {
    this.pollPads();
    this.ownedCleared("pressed", "_ownPressed");
    for (const [, btn] of ipairs<string>(this.pressQueue)) {
      this.pressed[btn] = true;
      const sources = this.sources[btn];
      if (sources == null) {
        this.state[btn] = true;
      } else if (!isEmpty(sources)) {
        this.state[btn] = true;
      }
    }
    for (const [btn, sources] of pairs<Sources>(this.sources)) {
      if (isEmpty(sources)) {
        delete this.sources[btn as string];
      }
    }
    this.ownedCleared("pressQueue", "_ownPressQueue");
    const aliases = this.aliases;
    let held: Record<string, boolean> | undefined;
    if (aliases) {
      for (const [src, dst] of pairs<string>(aliases)) {
        if (this.pressed[src as string]) this.pressed[dst] = true;
        if (this.state[src as string]) {
          held = held || {};
          held[dst] = true;
        }
      }
    }
    this.aliasHeld = held;
  }

  // Lua: Input.lua:465
  overlayPressed(btn: string): void {
    this.noteCapture("touch", "pressed", btn);
    this.press(btn, "touch:" + btn);
  }

  // Lua: Input.lua:470
  overlayReleased(btn: string): void {
    this.noteCapture("touch", "released", btn);
    this.release(btn, "touch:" + btn);
  }

  // Lua: Input.lua:482
  sourcePress(btn: string, source: string): void {
    this.press(btn, source);
  }

  // Lua: Input.lua:486
  sourceRelease(btn: string, source: string): void {
    this.release(btn, source);
  }

  // Lua: Input.lua:490
  gamepadpressed(_joystick: any, buttonIn: string): void {
    const button = GamepadMap.TRIGGER_AXES[buttonIn] || buttonIn;
    if (this.padSuppress) delete this.padSuppress[button];
    this.noteCapture("pad", "pressed", button);
    const btn = this.padBindings[button];
    if (btn && !this.padAction(button, this.shoulderGameplay)) {
      this.press(btn, "pad:" + button);
    }
  }

  // Lua: Input.lua:500
  gamepadreleased(_joystick: any, buttonIn: string): void {
    const button = GamepadMap.TRIGGER_AXES[buttonIn] || buttonIn;
    this.noteCapture("pad", "released", button);
    const source = "pad:" + button;
    for (const [btn, sources] of pairs<Sources>(this.sources)) {
      if (sources[source]) this.release(btn as string, source);
    }
  }

  // Lua: Input.lua:522
  joystickpressed(joystick: any, button: number): void {
    if (GamepadMap.ignoreRawForJoystick(joystick)) return;
    if (GamepadMap.isAccelerometer(joystick)) return;
    this.noteCapture("joy", "pressed", button);
    const btn = this.joyBindings[button];
    if (btn) this.press(btn, "joy:" + button);
  }

  // Lua: Input.lua:530
  joystickreleased(joystick: any, button: number): void {
    if (GamepadMap.ignoreRawForJoystick(joystick)) return;
    if (GamepadMap.isAccelerometer(joystick)) return;
    this.noteCapture("joy", "released", button);
    const btn = this.joyBindings[button];
    if (btn) this.release(btn, "joy:" + button);
  }

  // Lua: Input.lua:538 -- [triggerName, phase] or [undefined]
  triggerAxis(axis: string, value: number): [string | undefined, string?] {
    const name = GamepadMap.TRIGGER_AXES[axis];
    if (!name) return [undefined];
    this.triggerHeld = this.triggerHeld || {};
    const was = this.triggerHeld[name];
    if (!was && value >= GamepadMap.TRIGGER_ON) {
      this.triggerHeld[name] = true;
      return [name, "pressed"];
    } else if (was && value <= GamepadMap.TRIGGER_OFF) {
      delete this.triggerHeld[name];
      return [name, "released"];
    }
    return [name];
  }

  // Lua: Input.lua:555
  gamepadaxis(joystick: any, axis: string, value: number): void {
    const [trigger, phase] = this.triggerAxis(axis, value);
    if (trigger) {
      if (phase === "pressed") {
        this.gamepadpressed(joystick, trigger);
      } else if (phase === "released") {
        this.gamepadreleased(joystick, trigger);
      }
      return;
    }
    if (axis === "leftx") {
      this.stickAxis.x = value;
    } else if (axis === "lefty") {
      this.stickAxis.y = value;
    } else {
      return;
    }

    const x = this.stickAxis.x, y = this.stickAxis.y;
    const ax = Math.abs(x), ay = Math.abs(y);
    let newDir = this.stickDir;
    if (ax > STICK_ON || ay > STICK_ON) {
      if (ax >= ay) {
        newDir = x > 0 ? "right" : "left";
      } else {
        newDir = y > 0 ? "down" : "up";
      }
    } else if (ax < STICK_OFF && ay < STICK_OFF) {
      newDir = undefined;
    }

    if (newDir !== this.stickDir) {
      if (this.stickDir) {
        this.release(this.stickDir, "stick");
      }
      if (newDir) {
        this.press(newDir, "stick");
      }
      this.stickDir = newDir;
    }
  }

  // Lua: Input.lua:597
  joystickaxis(joystick: any, axis: number, value: number): void {
    if (GamepadMap.ignoreRawForJoystick(joystick)) return;
    if (GamepadMap.isAccelerometer(joystick)) return;
    if (axis === 1) {
      this.gamepadaxis(joystick, "leftx", value);
    } else if (axis === 2) {
      this.gamepadaxis(joystick, "lefty", value);
    }
  }

  // Lua: Input.lua:611
  joystickhat(joystick: any, hat: number | string, direction: string): void {
    if (GamepadMap.ignoreRawForJoystick(joystick)) return;
    if (GamepadMap.isAccelerometer(joystick)) return;
    const source = "hat:" + hat;
    for (const [, btn] of ipairs<string>(this.hatDirs[hat] || [null])) {
      this.release(btn, source);
    }
    const dirs = HAT_DIRECTIONS[direction] || [null];
    for (const [, btn] of ipairs<string>(dirs)) {
      this.press(btn, source);
    }
    this.hatDirs[hat] = dirs;
  }

  // Lua: Input.lua:638
  // The keyboard branch has no device here; the joystick list is the host pad
  // (once the host has reported it), taken down the SDL game-controller branch.
  reconcile(): void {
    if (!this.hostSeen) return;
    const joysticks = [null, this.HOST_PAD];
    for (const [, j] of ipairs<any>(joysticks)) {
      if (GamepadMap.isAccelerometer(j)) {
        // skip
      } else if (GamepadMap.ignoreRawForJoystick(j)) {
        if (j.isGamepadDown) {
          for (const [button, btn] of pairs<string>(this.padBindings)) {
            let down = false;
            try { down = j.isGamepadDown(button); } catch { down = false; }
            if (down && !this.padAction(button as string, this.shoulderGameplay)) {
              this.press(btn, "pad:" + button);
            }
          }
        }
        // the host pad has no analog axes (j.getGamepadAxis is absent)
      }
    }
  }

  // Lua: Input.lua:697
  isDown(btn: string): boolean {
    if (this.state[btn]) return true;
    const held = this.aliasHeld;
    return (held && held[btn]) || false;
  }

  // Lua: Input.lua:707
  isTouchDown(btn: string): boolean {
    const sources = this.sources[btn];
    return (sources && sources["touch:" + btn]) ? true : false;
  }

  // Lua: Input.lua:712
  wasPressed(btn: string): boolean {
    return this.pressed[btn] || false;
  }

  // Lua: Input.lua:729
  softResetHeld(): boolean {
    if (!(this.state.a && this.state.b
      && this.state.start && this.state.select)) {
      return false;
    }
    return !(this.state.up || this.state.down
      || this.state.left || this.state.right);
  }

  // Lua: Input.lua:743
  softResetStep(): boolean {
    if (!this.softResetHeld()) {
      this.softResetFrames = undefined;
      return false;
    }
    const left = (this.softResetFrames ?? SOFT_RESET_FRAMES) - 1;
    this.softResetFrames = left;
    if (left > 0) return false;
    this.softResetFrames = undefined;
    return true;
  }
}

/** The process-wide Input module (Brian's `Input` table; Game3.input). */
export const Input = new InputModule();
export default Input;
