// Ports gen1recomp src/core/gen2/AutoInput.lua at bdfac727 (MIT).
//
// Gen 2 automated joypad input: home/joypad.asm (GetJoypad's .auto arm,
// StartAutoInput, StopAutoInput). While a stream is armed the cart ignores
// the joypad entirely, so a player mashing A cannot steer the DUDE.
//
// Stream format: [input][duration] pairs; an input of $ff ends the stream.
// A duration is the number of EXTRA frames held (0 = one frame). A duration
// of $ff forces NO_INPUT and leaves the address on the same pair: "hold
// nothing forever", which is how every ROM stream parks at its end.
//
// The decoded frame is fed through the host Input object under its own
// source names ("auto:a" ...), so Input's edge detection sees real presses
// and releases. Game2 steps this BEFORE Input.step.
//
// Indexing: `pos` is kept as the Lua's 1-based index into `bytes` (storage
// access is `bytes[pos - 1]`). `advance()` returns only the mask (the Lua's
// second value, "the stream ended this frame", is `restorePending === true`;
// no caller reads it).

// constants/hardware.inc PAD_*. Same bit order as hJoypadDown.
const PAD_A = 0x01;
const PAD_B = 0x02;
const PAD_SELECT = 0x04;
const PAD_START = 0x08;
const PAD_RIGHT = 0x10;
const PAD_LEFT = 0x20;
const PAD_UP = 0x40;
const PAD_DOWN = 0x80;
const NO_INPUT = 0x00;

// Bit -> GB button name, ordered so a decoded frame always presses in the
// same sequence (Input.step's queue stays deterministic).
const BITS: [number, string][] = [
  [PAD_A, "a"],
  [PAD_B, "b"],
  [PAD_SELECT, "select"],
  [PAD_START, "start"],
  [PAD_RIGHT, "right"],
  [PAD_LEFT, "left"],
  [PAD_UP, "up"],
  [PAD_DOWN, "down"],
];

// Lua: AutoInput.lua:65 -- the mask test (arithmetic in Lua 5.1).
function held(mask: number, bit: number): boolean {
  return (mask & bit) !== 0;
}

/** The subset of the host Input object this module calls. */
export interface AutoInputTarget {
  reset?(): void;
  reconcile?(): void;
  sourcePress(button: string, source: string): void;
  [key: string]: any;
}

export class AutoInput {
  static PAD_A = PAD_A;
  static PAD_B = PAD_B;
  static PAD_RIGHT = PAD_RIGHT;
  static PAD_DOWN = PAD_DOWN;
  static NO_INPUT = NO_INPUT;

  // Lua: AutoInput.lua:73 -- the four ROM streams, transcribed (the extractor
  // only emits the bank:pointer an `autoinput` command carries).
  static STREAMS: Record<string, number[]> = {
    // engine/events/catch_tutorial.asm CatchTutorial.AutoInput: holds the
    // player's hands off the controller around StartBattle.
    CATCH_TUTORIAL: [NO_INPUT, 0xff],
    // engine/events/catch_tutorial_input.asm: re-armed by PromptButton, the
    // battle menu and the pack each time the DUDE answers.
    DUDE_A: [
      NO_INPUT, 0x50,
      PAD_A, 0x00,
      NO_INPUT, 0xff,
    ],
    DUDE_RIGHT_A: [
      NO_INPUT, 0x08,
      PAD_RIGHT, 0x00,
      NO_INPUT, 0x08,
      PAD_A, 0x00,
      NO_INPUT, 0xff,
    ],
    DUDE_DOWN_A: [
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      PAD_DOWN, 0x00,
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      NO_INPUT, 0xfe,
      PAD_A, 0x00,
      NO_INPUT, 0xff,
    ],
  };

  // Lua: AutoInput.lua:112 -- bank:address -> stream name (pokegold.sym);
  // StartAutoInput has exactly these four call sites.
  static POINTERS: Record<string, string> = {
    "08:79fc": "CATCH_TUTORIAL",
    "70:4dfe": "DUDE_A",
    "70:4e04": "DUDE_RIGHT_A",
    "70:4e0e": "DUDE_DOWN_A",
  };

  /** wAutoInputAddress, as a 1-based index into `bytes`. */
  pos = 1;
  /** wAutoInputLength */
  length = 0;
  bytes: number[] | undefined = undefined;
  active = false;
  /** hJoyDown's current value, held through a duration. */
  current = NO_INPUT;
  pollPaced: boolean | undefined = undefined;
  restorePending: boolean | undefined = undefined;
  unknownPointer: string | undefined = undefined;

  // Lua: AutoInput.lua:119
  static new(): AutoInput {
    return new AutoInput();
  }

  // Lua: AutoInput.lua:133
  isActive(): boolean {
    return this.active;
  }

  // Lua: AutoInput.lua:141 -- StartAutoInput. `stream` is a STREAMS name or a
  // raw byte array; the input's mirrors are cleared the way StartAutoInput
  // clears hJoyPressed / hJoyReleased / hJoyDown.
  start(stream: string | number[], input?: AutoInputTarget): boolean {
    let bytes: any = stream;
    if (typeof stream === "string") bytes = AutoInput.STREAMS[stream];
    if (!Array.isArray(bytes) || bytes[0] == null) return false;
    this.bytes = bytes;
    this.pos = 1;
    // "Start reading the stream immediately": zero length -> .updateauto next step.
    this.length = 0;
    this.current = NO_INPUT;
    this.active = true;
    // Frame pace unless the caller asks for poll pace; see skipIdle.
    this.pollPaced = undefined;
    if (input && input.reset) input.reset();
    return true;
  }

  // Lua: AutoInput.lua:175 -- a PORT correction: play the stream at POLL pace
  // (skip blank pairs). For menu-consumed streams only: the cart's menu loops
  // call GetJoypad with no frame delay, so DUDE_DOWN_A's `NO_INPUT, $fe` runs
  // vanish there but would be 1020 steps here. Presses and their order are
  // untouched. DUDE_A stays frame-paced (PromptButton delays a frame per
  // loop). A `$ff` duration is never skipped.
  skipIdle(): boolean {
    this.pollPaced = true;
    if (!this.active) return false;
    const skipped = this.dropIdlePairs();
    // A zero length is what makes the next step re-read the stream.
    this.length = 0;
    this.current = NO_INPUT;
    return skipped;
  }

  // Lua: AutoInput.lua:185
  dropIdlePairs(): boolean {
    const bytes = this.bytes ?? [];
    let skipped = false;
    while (true) {
      const value = bytes[this.pos - 1];
      const duration = bytes[this.pos];
      if (value !== NO_INPUT || duration == null || duration === 0xff) break;
      this.pos = this.pos + 2;
      skipped = true;
    }
    return skipped;
  }

  // Lua: AutoInput.lua:199 -- Script_autoinput's `dba`: bank, then the address.
  startPointer(bank: number | undefined, address: number | undefined, input?: AutoInputTarget): boolean {
    const b = bank ?? 0;
    const a = address ?? 0;
    const key = `${b.toString(16).padStart(2, "0")}:${a.toString(16).padStart(4, "0")}`;
    const name = AutoInput.POINTERS[key];
    if (!name) {
      // Not one of the ROM's own streams: recorded rather than guessed, since
      // arming an invented stream would take the controller away for good.
      this.unknownPointer = key;
      return false;
    }
    return this.start(name, input);
  }

  // Lua: AutoInput.lua:217 -- StopAutoInput. Input.reconcile is GetJoypad
  // going back to hJoypadDown: a key still held is down again next step.
  stop(input?: AutoInputTarget): boolean {
    this.bytes = undefined;
    this.pos = 1;
    this.length = 0;
    this.current = NO_INPUT;
    const wasActive = this.active;
    this.active = false;
    this.restorePending = undefined;
    if (wasActive && input) {
      if (input.reset) input.reset();
      if (input.reconcile) input.reconcile();
    }
    return wasActive;
  }

  // Lua: AutoInput.lua:236 -- one GetJoypad .auto pass: the pad mask for this
  // frame. On the frame the stream ends (.stopauto) the ring is disarmed here
  // and `restorePending` set; the handback is left for the next step.
  advance(): number {
    if (!this.active) return NO_INPUT;
    // "We only update when the input duration has expired."
    if (this.length !== 0) {
      this.length = this.length - 1;
      return this.current;
    }
    // A poll-paced stream drops the blank pairs BETWEEN presses too.
    if (this.pollPaced) this.dropIdlePairs();
    const bytes = this.bytes ?? [];
    let value = bytes[this.pos - 1];
    // "An input of $ff will end the stream." Running off the end is treated
    // as the terminator so control still comes back.
    if (value == null || value === 0xff) {
      this.stop();
      this.restorePending = true;
      return NO_INPUT;
    }
    const duration = bytes[this.pos];
    if (duration == null) {
      this.stop();
      this.restorePending = true;
      return NO_INPUT;
    }
    this.length = duration;
    if (duration === 0xff) {
      // "A duration of $ff will end the stream indefinitely": input
      // overwritten, address left on this same pair.
      value = NO_INPUT;
    } else {
      this.pos = this.pos + 2;
    }
    this.current = value;
    return value;
  }

  // Lua: AutoInput.lua:278 -- once per fixed step, before Input.step. Returns
  // true while the stream owns the controller.
  step(input?: AutoInputTarget): boolean {
    if (!this.active) {
      // The handback lands one step after the terminator frame: the frame
      // GetJoypad would first read hJoypadDown again.
      if (this.restorePending) {
        this.restorePending = undefined;
        if (input) {
          if (input.reset) input.reset();
          if (input.reconcile) input.reconcile();
        }
      }
      return false;
    }
    const mask = this.advance();
    if (input) {
      // GetJoypad overwrites the mirrors outright; hJoyPressed stays latched
      // for the whole duration, so held buttons are re-pressed every step.
      if (input.reset) input.reset();
      for (const entry of BITS) {
        if (held(mask, entry[0])) {
          input.sourcePress(entry[1], "auto:" + entry[1]);
        }
      }
    }
    // .stopauto already disarmed the ring inside advance; this frame is still
    // an auto frame, and the next one is the player's.
    return true;
  }
}

export default AutoInput;
