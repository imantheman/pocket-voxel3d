// A small headless emulator of the cartridges' handheld (the color model), for
// driving the real Gen 2 cartridges in
// tests and benches (VC save round trips): SM83 CPU, MBC3 with its clock,
// timer, LCD timing and interrupts, CGB double speed, WRAM/VRAM banks, HDMA,
// and a plain CGB renderer for screenshots. No sound (the registers only
// hold what is written), no link cable (the serial port never answers).
//
// Written for this project; deterministic (the cartridge clock runs on
// emulated time), so a scripted run is the same run every time.
//
//   const gb = new Gbc(romBytes, sramBytes?);
//   gb.frame(buttons)            one video frame (70224 dots)
//   gb.sram                      the 32 KB battery RAM
//   gb.wram(addr)                read $C000-$DFFF through the WRAM bank
//   gb.screen()                  160x144 RGBA (when rendering is on)

export const BTN = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128 } as const;

const FZ = 0x80, FN = 0x40, FH = 0x20, FC = 0x10;

export interface Rtc {
  s: number; m: number; h: number; d: number; halt: boolean; carry: boolean;
}

export class Gbc {
  // ---- cartridge
  readonly rom: Uint8Array;
  sram: Uint8Array;
  romBank = 1;
  ramBank = 0; // 0-3 RAM, 8-12 RTC register
  ramEnable = false;
  rtc: Rtc = { s: 0, m: 0, h: 0, d: 0, halt: false, carry: false };
  rtcLatched: Rtc = { s: 0, m: 0, h: 0, d: 0, halt: false, carry: false };
  private latchPrev = 0xff;
  private rtcDots = 0;
  /** True once the game has written its battery RAM since the last clear. */
  sramDirty = false;

  // ---- memory
  vram = new Uint8Array(0x4000);
  wramMem = new Uint8Array(0x8000);
  oam = new Uint8Array(0xa0);
  hram = new Uint8Array(0x80);
  io = new Uint8Array(0x80);
  ie = 0;
  vbank = 0;
  wbank = 1;
  bgPal = new Uint8Array(64);
  obPal = new Uint8Array(64);

  // ---- cpu
  a = 0x11; f = 0x80; b = 0; c = 0; d = 0xff; e = 0x56; h = 0; l = 0x0d;
  sp = 0xfffe; pc = 0x100;
  ime = false;
  private imeNext = false;
  halted = false;
  stopped = false;
  doubleSpeed = false;

  // ---- timing
  private dot = 0; // dots into the current line
  ly = 0;
  private mode = 2;
  private divCycles = 0;
  private timaCycles = 0;
  frames = 0;
  private frameDone = false;
  private hdmaActive = false;
  private hdmaSrc = 0;
  private hdmaDst = 0;
  private hdmaLeft = 0;
  private statLine = false;

  // ---- pad
  buttons = 0;
  /** Set when a frame never came (the game crashed or hung). */
  stuck: string | null = null;

  // ---- video
  render = false;
  private fb = new Uint8Array(160 * 144 * 4);
  private bgPrio = new Uint8Array(160);

  /** Instruction hook for tracing (pc before each instruction). */
  trace?: (gb: Gbc) => void;
  /** Called on every write to $C000-$DFFF (addr, value, wram bank). */
  onWramWrite?: (addr: number, v: number, bank: number) => void;
  /** Called on every write to battery RAM (offset into the 32 KB). */
  onSramWrite?: (off: number, v: number) => void;

  constructor(rom: Uint8Array, sram?: Uint8Array) {
    this.rom = rom;
    this.sram = new Uint8Array(0x8000);
    if (sram) this.sram.set(sram.subarray(0, 0x8000));
    // the CGB boot ROM's hand-off state
    this.io[0x40] = 0x91;
    this.io[0x47] = 0xfc;
    this.io[0x00] = 0xcf;
    this.io[0x70] = 0xf9;
    this.io[0x4d] = 0x7e;
    for (let i = 0; i < 64; i++) this.bgPal[i] = 0xff;
  }

  // ------------------------------------------------------------------ memory
  wram(addr: number, bank = this.wbank): number {
    if (addr < 0xd000) return this.wramMem[addr - 0xc000]!;
    return this.wramMem[(bank || 1) * 0x1000 + addr - 0xd000]!;
  }
  wramSet(addr: number, v: number, bank = this.wbank): void {
    if (addr < 0xd000) this.wramMem[addr - 0xc000] = v & 0xff;
    else this.wramMem[(bank || 1) * 0x1000 + addr - 0xd000] = v & 0xff;
  }

  read(a: number): number {
    if (a < 0x4000) return this.rom[a]!;
    if (a < 0x8000) return this.rom[(this.romBank * 0x4000 + a - 0x4000) % this.rom.length]!;
    if (a < 0xa000) return this.vram[this.vbank * 0x2000 + a - 0x8000]!;
    if (a < 0xc000) {
      if (!this.ramEnable) return 0xff;
      if (this.ramBank <= 3) return this.sram[this.ramBank * 0x2000 + a - 0xa000]!;
      const r = this.rtcLatched;
      switch (this.ramBank) {
        case 8: return r.s;
        case 9: return r.m;
        case 10: return r.h;
        case 11: return r.d & 0xff;
        case 12: return ((r.d >> 8) & 1) | (r.halt ? 0x40 : 0) | (r.carry ? 0x80 : 0);
      }
      return 0xff;
    }
    if (a < 0xd000) return this.wramMem[a - 0xc000]!;
    if (a < 0xe000) return this.wramMem[this.wbank * 0x1000 + a - 0xd000]!;
    if (a < 0xfe00) return this.read(a - 0x2000);
    if (a < 0xfea0) return this.oam[a - 0xfe00]!;
    if (a < 0xff00) return 0;
    if (a < 0xff80) return this.readIo(a & 0x7f);
    if (a < 0xffff) return this.hram[a - 0xff80]!;
    return this.ie;
  }

  private readIo(r: number): number {
    switch (r) {
      case 0x00: {
        const sel = this.io[0];
        let v = 0x0f;
        if (!(sel & 0x10)) v &= ~((this.buttons >> 4) & 0x0f); // d-pad: R L U D
        if (!(sel & 0x20)) v &= ~(this.buttons & 0x0f); // A B SELECT START
        return 0xc0 | (sel & 0x30) | v;
      }
      case 0x04: return (this.divCycles >> 8) & 0xff;
      case 0x0f: return this.io[0x0f]! | 0xe0;
      case 0x41: return 0x80 | (this.io[0x41]! & 0x78) | (this.ly === this.io[0x45] ? 4 : 0) | (this.io[0x40]! & 0x80 ? this.mode : 0);
      case 0x44: return this.ly;
      case 0x4d: return (this.doubleSpeed ? 0x80 : 0) | 0x7e | (this.io[0x4d]! & 1);
      case 0x4f: return 0xfe | this.vbank;
      case 0x55: return this.hdmaActive ? ((this.hdmaLeft - 1) & 0x7f) : 0xff;
      case 0x69: return this.bgPal[this.io[0x68]! & 0x3f]!;
      case 0x6b: return this.obPal[this.io[0x6a]! & 0x3f]!;
      case 0x70: return 0xf8 | this.wbank;
    }
    return this.io[r]!;
  }

  write(a: number, v: number): void {
    v &= 0xff;
    if (a < 0x2000) { this.ramEnable = (v & 0x0f) === 0x0a; return; }
    if (a < 0x4000) { this.romBank = (v & 0x7f) || 1; return; }
    if (a < 0x6000) { this.ramBank = v; return; }
    if (a < 0x8000) {
      if (this.latchPrev === 0 && v === 1) this.rtcLatched = { ...this.rtc };
      this.latchPrev = v;
      return;
    }
    if (a < 0xa000) { this.vram[this.vbank * 0x2000 + a - 0x8000] = v; return; }
    if (a < 0xc000) {
      if (!this.ramEnable) return;
      if (this.ramBank <= 3) {
        const off = this.ramBank * 0x2000 + a - 0xa000;
        this.sram[off] = v;
        this.sramDirty = true;
        this.onSramWrite?.(off, v);
        return;
      }
      const r = this.rtc;
      switch (this.ramBank) {
        case 8: r.s = v % 60; this.rtcDots = 0; break;
        case 9: r.m = v % 60; break;
        case 10: r.h = v % 24; break;
        case 11: r.d = (r.d & 0x100) | v; break;
        case 12: r.d = (r.d & 0xff) | ((v & 1) << 8); r.halt = (v & 0x40) !== 0; r.carry = (v & 0x80) !== 0; break;
      }
      return;
    }
    if (a < 0xd000) { this.wramMem[a - 0xc000] = v; this.onWramWrite?.(a, v, 0); return; }
    if (a < 0xe000) { this.wramMem[this.wbank * 0x1000 + a - 0xd000] = v; this.onWramWrite?.(a, v, this.wbank); return; }
    if (a < 0xfe00) { this.write(a - 0x2000, v); return; }
    if (a < 0xfea0) { this.oam[a - 0xfe00] = v; return; }
    if (a < 0xff00) return;
    if (a < 0xff80) { this.writeIo(a & 0x7f, v); return; }
    if (a < 0xffff) { this.hram[a - 0xff80] = v; return; }
    this.ie = v;
  }

  private writeIo(r: number, v: number): void {
    switch (r) {
      case 0x00: this.io[0] = v & 0x30; return;
      case 0x02: this.io[2] = v; return; // serial: never completes
      case 0x04: this.divCycles = 0; return;
      case 0x41: this.io[0x41] = v & 0x78; return;
      case 0x44: return;
      case 0x46: { // OAM DMA
        const src = v << 8;
        for (let i = 0; i < 0xa0; i++) this.oam[i] = this.read(src + i);
        this.io[0x46] = v;
        return;
      }
      case 0x40: {
        const was = this.io[0x40]! & 0x80;
        this.io[0x40] = v;
        if (was && !(v & 0x80)) { this.ly = 0; this.dot = 0; this.mode = 0; }
        if (!was && (v & 0x80)) { this.ly = 0; this.dot = 0; this.mode = 2; }
        return;
      }
      case 0x4d: this.io[0x4d] = v & 1; return;
      case 0x4f: this.vbank = v & 1; return;
      case 0x55: this.startHdma(v); return;
      case 0x69: {
        const i = this.io[0x68]!;
        this.bgPal[i & 0x3f] = v;
        if (i & 0x80) this.io[0x68] = 0x80 | ((i + 1) & 0x3f);
        return;
      }
      case 0x6b: {
        const i = this.io[0x6a]!;
        this.obPal[i & 0x3f] = v;
        if (i & 0x80) this.io[0x6a] = 0x80 | ((i + 1) & 0x3f);
        return;
      }
      case 0x70: this.wbank = (v & 7) || 1; return;
    }
    this.io[r] = v;
  }

  private startHdma(v: number): void {
    if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; return; }
    this.hdmaSrc = ((this.io[0x51]! << 8) | this.io[0x52]!) & 0xfff0;
    this.hdmaDst = 0x8000 | ((((this.io[0x53]! << 8) | this.io[0x54]!) & 0x1ff0));
    const blocks = (v & 0x7f) + 1;
    if (v & 0x80) {
      this.hdmaActive = true;
      this.hdmaLeft = blocks;
      // with the LCD off, one block goes at once (as the hardware does)
      if (!(this.io[0x40]! & 0x80)) this.hdmaBlock();
    } else {
      for (let i = 0; i < blocks; i++) this.copyBlock();
    }
  }
  private copyBlock(): void {
    for (let i = 0; i < 16; i++) {
      const v = this.read(this.hdmaSrc++);
      this.vram[this.vbank * 0x2000 + ((this.hdmaDst++) & 0x1fff)] = v;
    }
    this.hdmaSrc &= 0xffff;
  }
  private hdmaBlock(): void {
    if (!this.hdmaActive) return;
    this.copyBlock();
    if (--this.hdmaLeft <= 0) this.hdmaActive = false;
  }

  // -------------------------------------------------------------------- clock
  /** Advance the cartridge clock by `dots` (4.19 MHz units). */
  private rtcTick(dots: number): void {
    if (this.rtc.halt) return;
    this.rtcDots += dots;
    while (this.rtcDots >= 4194304) {
      this.rtcDots -= 4194304;
      this.rtcSecond();
    }
  }
  rtcSecond(): void {
    const r = this.rtc;
    if (++r.s < 60) return;
    r.s = 0;
    if (++r.m < 60) return;
    r.m = 0;
    if (++r.h < 24) return;
    r.h = 0;
    if (++r.d > 511) { r.d = 0; r.carry = true; }
  }

  // ------------------------------------------------------------------ frame
  /** Run one video frame with these buttons held (BTN bits). */
  frame(buttons = 0): void {
    this.buttons = buttons;
    this.frameDone = false;
    let guard = 0;
    while (!this.frameDone) {
      this.step();
      if (++guard > 2_000_000) {
        // no frame in two million steps: the game has stopped (halted with
        // nothing to wake it, or spinning with the LCD off)
        this.frames++;
        this.stuck = `stuck at ${this.pc.toString(16)} (bank ${this.romBank}, halted ${this.halted}, ime ${this.ime}, ie ${this.ie.toString(16)}, lcdc ${this.io[0x40]!.toString(16)})`;
        break;
      }
    }
  }

  /** One instruction (or interrupt / halted tick) and the hardware after it. */
  step(): void {
    let cyc: number;
    // interrupts
    const pending = this.ie & this.io[0x0f]! & 0x1f;
    if (pending && this.halted) this.halted = false;
    if (this.ime && pending) {
      this.ime = false;
      this.imeNext = false;
      let n = 0;
      while (!((pending >> n) & 1)) n++;
      this.io[0x0f] =this.io[0x0f]! & ~(1 << n);
      this.push(this.pc);
      this.pc = 0x40 + n * 8;
      cyc = 20;
    } else if (this.halted || this.stopped) {
      cyc = 4;
    } else {
      if (this.imeNext) { this.ime = true; this.imeNext = false; }
      if (this.trace) this.trace(this);
      cyc = this.exec();
    }
    this.tick(cyc);
  }

  private tick(cyc: number): void {
    // timers run at the CPU's speed
    this.divCycles = (this.divCycles + cyc) & 0xffff;
    const tac = this.io[0x07]!;
    if (tac & 4) {
      const period = [1024, 16, 64, 256][tac & 3]!;
      this.timaCycles += cyc;
      while (this.timaCycles >= period) {
        this.timaCycles -= period;
        let t = this.io[0x05]! + 1;
        if (t > 0xff) { t = this.io[0x06]!; this.io[0x0f] |= 4; }
        this.io[0x05] = t;
      }
    }
    // the LCD and the clock run at the dot rate
    const dots = this.doubleSpeed ? cyc >> 1 : cyc;
    this.rtcTick(dots);
    this.lcd(dots);
  }

  private setStatLine(): void {
    const stat = this.io[0x41]!;
    const on =
      ((stat & 0x40) !== 0 && this.ly === this.io[0x45]) ||
      ((stat & 0x08) !== 0 && this.mode === 0) ||
      ((stat & 0x10) !== 0 && this.mode === 1) ||
      ((stat & 0x20) !== 0 && this.mode === 2);
    if (on && !this.statLine) this.io[0x0f] |= 2;
    this.statLine = on;
  }

  private lcd(dots: number): void {
    if (!(this.io[0x40]! & 0x80)) {
      // LCD off: frames still pass for the frame loop
      this.dot += dots;
      if (this.dot >= 70224) { this.dot -= 70224; this.frames++; this.frameDone = true; }
      return;
    }
    this.dot += dots;
    for (;;) {
      if (this.ly < 144) {
        if (this.mode === 2 && this.dot >= 80) { this.mode = 3; this.setStatLine(); continue; }
        if (this.mode === 3 && this.dot >= 252) {
          this.mode = 0;
          if (this.render) this.drawLine(this.ly);
          this.hdmaBlock();
          this.setStatLine();
          continue;
        }
      }
      if (this.dot < 456) break;
      this.dot -= 456;
      this.ly++;
      if (this.ly === 144) {
        this.mode = 1;
        this.io[0x0f] |= 1;
        this.frames++;
        this.frameDone = true;
      } else if (this.ly > 153) {
        this.ly = 0;
        this.mode = 2;
      } else if (this.ly < 144) {
        this.mode = 2;
      }
      this.setStatLine();
    }
  }

  // -------------------------------------------------------------------- cpu
  private push(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.write(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.write(this.sp, v & 0xff);
  }
  private pop(): number {
    const lo = this.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }
  private imm8(): number {
    const v = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private imm16(): number {
    const lo = this.read(this.pc);
    const hi = this.read((this.pc + 1) & 0xffff);
    this.pc = (this.pc + 2) & 0xffff;
    return (hi << 8) | lo;
  }
  private get hl(): number { return (this.h << 8) | this.l; }
  private set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  private get bc(): number { return (this.b << 8) | this.c; }
  private set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  private get de(): number { return (this.d << 8) | this.e; }
  private set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }

  private getR(i: number): number {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return this.h; case 5: return this.l; case 6: return this.read(this.hl); default: return this.a;
    }
  }
  private setR(i: number, v: number): void {
    v &= 0xff;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.write(this.hl, v); break; default: this.a = v;
    }
  }

  private alu(op: number, v: number): void {
    const a = this.a;
    let r: number;
    switch (op) {
      case 0: r = a + v; this.f = ((r & 0xff) ? 0 : FZ) | (((a & 15) + (v & 15)) > 15 ? FH : 0) | (r > 0xff ? FC : 0); this.a = r & 0xff; break;
      case 1: { const c = this.f & FC ? 1 : 0; r = a + v + c; this.f = ((r & 0xff) ? 0 : FZ) | (((a & 15) + (v & 15) + c) > 15 ? FH : 0) | (r > 0xff ? FC : 0); this.a = r & 0xff; break; }
      case 2: r = a - v; this.f = FN | ((r & 0xff) ? 0 : FZ) | ((a & 15) < (v & 15) ? FH : 0) | (r < 0 ? FC : 0); this.a = r & 0xff; break;
      case 3: { const c = this.f & FC ? 1 : 0; r = a - v - c; this.f = FN | ((r & 0xff) ? 0 : FZ) | ((a & 15) - (v & 15) - c < 0 ? FH : 0) | (r < 0 ? FC : 0); this.a = r & 0xff; break; }
      case 4: this.a = a & v; this.f = (this.a ? 0 : FZ) | FH; break;
      case 5: this.a = a ^ v; this.f = this.a ? 0 : FZ; break;
      case 6: this.a = a | v; this.f = this.a ? 0 : FZ; break;
      default: r = a - v; this.f = FN | ((r & 0xff) ? 0 : FZ) | ((a & 15) < (v & 15) ? FH : 0) | (r < 0 ? FC : 0); break;
    }
  }

  private cond(i: number): boolean {
    switch (i) {
      case 0: return !(this.f & FZ); case 1: return (this.f & FZ) !== 0;
      case 2: return !(this.f & FC); default: return (this.f & FC) !== 0;
    }
  }

  private add16(v: number): void {
    const hl = this.hl;
    const r = hl + v;
    this.f = (this.f & FZ) | (((hl & 0xfff) + (v & 0xfff)) > 0xfff ? FH : 0) | (r > 0xffff ? FC : 0);
    this.hl = r & 0xffff;
  }

  private spOff(): number {
    const o = this.imm8();
    const s = (o << 24) >> 24;
    const sp = this.sp;
    this.f = (((sp & 15) + (o & 15)) > 15 ? FH : 0) | (((sp & 0xff) + o) > 0xff ? FC : 0);
    return (sp + s) & 0xffff;
  }

  private exec(): number {
    const op = this.imm8();
    // 8-bit loads ld r,r'
    if (op >= 0x40 && op < 0x80) {
      if (op === 0x76) { this.halted = true; return 4; }
      this.setR((op >> 3) & 7, this.getR(op & 7));
      return (op & 7) === 6 || ((op >> 3) & 7) === 6 ? 8 : 4;
    }
    if (op >= 0x80 && op < 0xc0) {
      this.alu((op >> 3) & 7, this.getR(op & 7));
      return (op & 7) === 6 ? 8 : 4;
    }
    switch (op) {
      case 0x00: return 4;
      case 0x01: this.bc = this.imm16(); return 12;
      case 0x11: this.de = this.imm16(); return 12;
      case 0x21: this.hl = this.imm16(); return 12;
      case 0x31: this.sp = this.imm16(); return 12;
      case 0x02: this.write(this.bc, this.a); return 8;
      case 0x12: this.write(this.de, this.a); return 8;
      case 0x22: { const hl = this.hl; this.write(hl, this.a); this.hl = (hl + 1) & 0xffff; return 8; }
      case 0x32: { const hl = this.hl; this.write(hl, this.a); this.hl = (hl - 1) & 0xffff; return 8; }
      case 0x0a: this.a = this.read(this.bc); return 8;
      case 0x1a: this.a = this.read(this.de); return 8;
      case 0x2a: { const hl = this.hl; this.a = this.read(hl); this.hl = (hl + 1) & 0xffff; return 8; }
      case 0x3a: { const hl = this.hl; this.a = this.read(hl); this.hl = (hl - 1) & 0xffff; return 8; }
      case 0x03: this.bc = (this.bc + 1) & 0xffff; return 8;
      case 0x13: this.de = (this.de + 1) & 0xffff; return 8;
      case 0x23: this.hl = (this.hl + 1) & 0xffff; return 8;
      case 0x33: this.sp = (this.sp + 1) & 0xffff; return 8;
      case 0x0b: this.bc = (this.bc - 1) & 0xffff; return 8;
      case 0x1b: this.de = (this.de - 1) & 0xffff; return 8;
      case 0x2b: this.hl = (this.hl - 1) & 0xffff; return 8;
      case 0x3b: this.sp = (this.sp - 1) & 0xffff; return 8;
      case 0x09: this.add16(this.bc); return 8;
      case 0x19: this.add16(this.de); return 8;
      case 0x29: this.add16(this.hl); return 8;
      case 0x39: this.add16(this.sp); return 8;
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const r = (op >> 3) & 7;
        const v = (this.getR(r) + 1) & 0xff;
        this.setR(r, v);
        this.f = (this.f & FC) | (v ? 0 : FZ) | ((v & 15) === 0 ? FH : 0);
        return r === 6 ? 12 : 4;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const r = (op >> 3) & 7;
        const v = (this.getR(r) - 1) & 0xff;
        this.setR(r, v);
        this.f = (this.f & FC) | FN | (v ? 0 : FZ) | ((v & 15) === 15 ? FH : 0);
        return r === 6 ? 12 : 4;
      }
      case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x36: case 0x3e: {
        const r = (op >> 3) & 7;
        this.setR(r, this.imm8());
        return r === 6 ? 12 : 8;
      }
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = c ? FC : 0; return 4; }
      case 0x0f: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = c ? FC : 0; return 4; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & FC ? 1 : 0)) & 0xff; this.f = c ? FC : 0; return 4; }
      case 0x1f: { const c = this.a & 1; this.a = (this.a >> 1) | (this.f & FC ? 0x80 : 0); this.f = c ? FC : 0; return 4; }
      case 0x08: { const a = this.imm16(); this.write(a, this.sp & 0xff); this.write((a + 1) & 0xffff, this.sp >> 8); return 20; }
      case 0x10: {
        this.imm8();
        if (this.io[0x4d]! & 1) { this.doubleSpeed = !this.doubleSpeed; this.io[0x4d] = 0; this.divCycles = 0; }
        else this.stopped = false;
        return 4;
      }
      case 0x18: { const o = (this.imm8() << 24) >> 24; this.pc = (this.pc + o) & 0xffff; return 12; }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const o = (this.imm8() << 24) >> 24;
        if (this.cond((op >> 3) & 3)) { this.pc = (this.pc + o) & 0xffff; return 12; }
        return 8;
      }
      case 0x27: { // daa
        let a = this.a;
        let adj = 0;
        let c = this.f & FC;
        if (this.f & FN) {
          if (this.f & FH) adj |= 0x06;
          if (c) adj |= 0x60;
          a = (a - adj) & 0xff;
        } else {
          if ((this.f & FH) || (a & 15) > 9) adj |= 0x06;
          if (c || a > 0x99) { adj |= 0x60; c = FC; }
          a = (a + adj) & 0xff;
        }
        this.a = a;
        this.f = (this.f & FN) | (a ? 0 : FZ) | c;
        return 4;
      }
      case 0x2f: this.a ^= 0xff; this.f = (this.f & (FZ | FC)) | FN | FH; return 4;
      case 0x37: this.f = (this.f & FZ) | FC; return 4;
      case 0x3f: this.f = (this.f & FZ) | ((this.f & FC) ? 0 : FC); return 4;
      case 0xc0: case 0xc8: case 0xd0: case 0xd8:
        if (this.cond((op >> 3) & 3)) { this.pc = this.pop(); return 20; }
        return 8;
      case 0xc9: this.pc = this.pop(); return 16;
      case 0xd9: this.pc = this.pop(); this.ime = true; return 16;
      case 0xc1: this.bc = this.pop(); return 12;
      case 0xd1: this.de = this.pop(); return 12;
      case 0xe1: this.hl = this.pop(); return 12;
      case 0xf1: { const v = this.pop(); this.a = v >> 8; this.f = v & 0xf0; return 12; }
      case 0xc5: this.push(this.bc); return 16;
      case 0xd5: this.push(this.de); return 16;
      case 0xe5: this.push(this.hl); return 16;
      case 0xf5: this.push((this.a << 8) | this.f); return 16;
      case 0xc2: case 0xca: case 0xd2: case 0xda: {
        const a = this.imm16();
        if (this.cond((op >> 3) & 3)) { this.pc = a; return 16; }
        return 12;
      }
      case 0xc3: this.pc = this.imm16(); return 16;
      case 0xe9: this.pc = this.hl; return 4;
      case 0xc4: case 0xcc: case 0xd4: case 0xdc: {
        const a = this.imm16();
        if (this.cond((op >> 3) & 3)) { this.push(this.pc); this.pc = a; return 24; }
        return 12;
      }
      case 0xcd: { const a = this.imm16(); this.push(this.pc); this.pc = a; return 24; }
      case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff:
        this.push(this.pc); this.pc = op & 0x38; return 16;
      case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe:
        this.alu((op >> 3) & 7, this.imm8()); return 8;
      case 0xe0: this.write(0xff00 | this.imm8(), this.a); return 12;
      case 0xf0: this.a = this.read(0xff00 | this.imm8()); return 12;
      case 0xe2: this.write(0xff00 | this.c, this.a); return 8;
      case 0xf2: this.a = this.read(0xff00 | this.c); return 8;
      case 0xea: this.write(this.imm16(), this.a); return 16;
      case 0xfa: this.a = this.read(this.imm16()); return 16;
      case 0xe8: this.sp = this.spOff(); return 16;
      case 0xf8: this.hl = this.spOff(); return 12;
      case 0xf9: this.sp = this.hl; return 8;
      case 0xf3: this.ime = false; this.imeNext = false; return 4;
      case 0xfb: this.imeNext = true; return 4;
      case 0xcb: return this.execCb();
    }
    throw new Error(`gbc: bad opcode ${op.toString(16)} at ${((this.pc - 1) & 0xffff).toString(16)} bank ${this.romBank}`);
  }

  private execCb(): number {
    const op = this.imm8();
    const r = op & 7;
    const cyc = r === 6 ? ((op >> 6) === 1 ? 12 : 16) : 8;
    const v = this.getR(r);
    const grp = op >> 6;
    const n = (op >> 3) & 7;
    if (grp === 1) { this.f = (this.f & FC) | FH | ((v >> n) & 1 ? 0 : FZ); return cyc; }
    if (grp === 2) { this.setR(r, v & ~(1 << n)); return cyc; }
    if (grp === 3) { this.setR(r, v | (1 << n)); return cyc; }
    let out: number;
    let c: number;
    switch (n) {
      case 0: c = v >> 7; out = ((v << 1) | c) & 0xff; break;
      case 1: c = v & 1; out = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; out = ((v << 1) | (this.f & FC ? 1 : 0)) & 0xff; break;
      case 3: c = v & 1; out = (v >> 1) | (this.f & FC ? 0x80 : 0); break;
      case 4: c = v >> 7; out = (v << 1) & 0xff; break;
      case 5: c = v & 1; out = (v >> 1) | (v & 0x80); break;
      case 6: c = 0; out = ((v << 4) | (v >> 4)) & 0xff; break;
      default: c = v & 1; out = v >> 1; break;
    }
    this.setR(r, out);
    this.f = (out ? 0 : FZ) | (c ? FC : 0);
    return cyc;
  }

  // ------------------------------------------------------------------ video
  private color(pal: Uint8Array, p: number, i: number, out: number): void {
    const lo = pal[p * 8 + i * 2]!;
    const hi = pal[p * 8 + i * 2 + 1]!;
    const c = lo | (hi << 8);
    this.fb[out] = (c & 31) << 3;
    this.fb[out + 1] = ((c >> 5) & 31) << 3;
    this.fb[out + 2] = ((c >> 10) & 31) << 3;
    this.fb[out + 3] = 255;
  }

  private drawLine(y: number): void {
    const lcdc = this.io[0x40]!;
    const scy = this.io[0x42]!, scx = this.io[0x43]!;
    const wy = this.io[0x4a]!, wx = this.io[0x4b]! - 7;
    const winOn = (lcdc & 0x20) !== 0 && y >= wy && wx < 160;
    for (let x = 0; x < 160; x++) {
      let mapBase: number, px: number, py: number;
      if (winOn && x >= wx) {
        mapBase = lcdc & 0x40 ? 0x1c00 : 0x1800;
        px = x - wx;
        py = y - wy;
      } else {
        mapBase = lcdc & 0x08 ? 0x1c00 : 0x1800;
        px = (x + scx) & 255;
        py = (y + scy) & 255;
      }
      const mi = mapBase + (py >> 3) * 32 + (px >> 3);
      const tile = this.vram[mi]!;
      const attr = this.vram[0x2000 + mi]!;
      let tx = px & 7, ty = py & 7;
      if (attr & 0x20) tx = 7 - tx;
      if (attr & 0x40) ty = 7 - ty;
      const bank = attr & 8 ? 0x2000 : 0;
      const addr = lcdc & 0x10 ? tile * 16 : 0x1000 + ((tile << 24) >> 24) * 16;
      const b0 = this.vram[bank + addr + ty * 2]!;
      const b1 = this.vram[bank + addr + ty * 2 + 1]!;
      const ci = (((b1 >> (7 - tx)) & 1) << 1) | ((b0 >> (7 - tx)) & 1);
      this.bgPrio[x] = ci === 0 ? 0 : (attr & 0x80 ? 2 : 1);
      this.color(this.bgPal, attr & 7, ci, (y * 160 + x) * 4);
    }
    if (!(lcdc & 0x02)) return;
    const tall = (lcdc & 0x04) !== 0;
    const hgt = tall ? 16 : 8;
    let n = 0;
    for (let s = 0; s < 40 && n < 10; s++) {
      const sy = this.oam[s * 4]! - 16;
      if (y < sy || y >= sy + hgt) continue;
      n++;
      const sx = this.oam[s * 4 + 1]! - 8;
      let tile = this.oam[s * 4 + 2]!;
      const attr = this.oam[s * 4 + 3]!;
      if (tall) tile &= 0xfe;
      let row = y - sy;
      if (attr & 0x40) row = hgt - 1 - row;
      const bank = attr & 8 ? 0x2000 : 0;
      const b0 = this.vram[bank + tile * 16 + row * 2]!;
      const b1 = this.vram[bank + tile * 16 + row * 2 + 1]!;
      for (let i = 0; i < 8; i++) {
        const x = sx + i;
        if (x < 0 || x >= 160) continue;
        const bitn = attr & 0x20 ? i : 7 - i;
        const ci = (((b1 >> bitn) & 1) << 1) | ((b0 >> bitn) & 1);
        if (ci === 0) continue;
        if (this.bgPrio[x] === 2 || ((attr & 0x80) && this.bgPrio[x] === 1)) continue;
        this.color(this.obPal, attr & 7, ci, (y * 160 + x) * 4);
      }
    }
  }

  /** The last frame drawn (RGBA, 160x144), when `render` is on. */
  screen(): Uint8Array {
    return this.fb;
  }

  // ------------------------------------------------------------ save state
  snapshot(): Uint8Array {
    const s = JSON.stringify({
      r: [this.a, this.f, this.b, this.c, this.d, this.e, this.h, this.l, this.sp, this.pc],
      ime: this.ime, imeNext: this.imeNext, halted: this.halted, stopped: this.stopped, ds: this.doubleSpeed,
      romBank: this.romBank, ramBank: this.ramBank, ramEnable: this.ramEnable, rtc: this.rtc, rtcL: this.rtcLatched,
      latchPrev: this.latchPrev, rtcDots: this.rtcDots, ie: this.ie, vbank: this.vbank, wbank: this.wbank,
      dot: this.dot, ly: this.ly, mode: this.mode, div: this.divCycles, tima: this.timaCycles, frames: this.frames,
      hdma: [this.hdmaActive, this.hdmaSrc, this.hdmaDst, this.hdmaLeft], statLine: this.statLine,
    });
    const head = new TextEncoder().encode(s);
    const parts = [this.sram, this.vram, this.wramMem, this.oam, this.hram, this.io, this.bgPal, this.obPal];
    const total = 4 + head.length + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    new DataView(out.buffer).setUint32(0, head.length, true);
    out.set(head, 4);
    let o = 4 + head.length;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  restore(snap: Uint8Array): void {
    const n = new DataView(snap.buffer, snap.byteOffset).getUint32(0, true);
    const s = JSON.parse(new TextDecoder().decode(snap.subarray(4, 4 + n)));
    [this.a, this.f, this.b, this.c, this.d, this.e, this.h, this.l, this.sp, this.pc] = s.r;
    Object.assign(this, {
      ime: s.ime, imeNext: s.imeNext, halted: s.halted, stopped: s.stopped, doubleSpeed: s.ds,
      romBank: s.romBank, ramBank: s.ramBank, ramEnable: s.ramEnable, rtc: { ...s.rtc }, rtcLatched: { ...s.rtcL },
      latchPrev: s.latchPrev, rtcDots: s.rtcDots, ie: s.ie, vbank: s.vbank, wbank: s.wbank,
      dot: s.dot, ly: s.ly, mode: s.mode, divCycles: s.div, timaCycles: s.tima, frames: s.frames, statLine: s.statLine,
    });
    [this.hdmaActive, this.hdmaSrc, this.hdmaDst, this.hdmaLeft] = s.hdma;
    let o = 4 + n;
    for (const p of [this.sram, this.vram, this.wramMem, this.oam, this.hram, this.io, this.bgPal, this.obPal]) {
      p.set(snap.subarray(o, o + p.length));
      o += p.length;
    }
  }
}

/** A PNG of an RGBA image (no dependencies; stored deflate). */
export function png(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  // zlib stored blocks
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    blocks.push(i + len >= raw.length ? 1 : 0, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff);
    for (let k = 0; k < len; k++) blocks.push(raw[i + k]!);
  }
  let a = 1, b2 = 0;
  for (const x of raw) { a = (a + x) % 65521; b2 = (b2 + a) % 65521; }
  blocks.push((b2 >> 8) & 0xff, b2 & 0xff, (a >> 8) & 0xff, a & 0xff);
  const chunk = (type: string, data: Uint8Array): number[] => {
    const t = new TextEncoder().encode(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t);
    body.set(data, t.length);
    const len = data.length;
    const c = crc(body);
    return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body, c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255];
  };
  const ihdr = new Uint8Array([w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 6, 0, 0, 0]);
  const out = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", new Uint8Array(blocks)), ...chunk("IEND", new Uint8Array(0))];
  return new Uint8Array(out);
}
