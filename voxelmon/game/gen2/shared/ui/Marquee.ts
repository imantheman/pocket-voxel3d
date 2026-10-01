// gen1recomp src/ui/Marquee.lua (bdfac727): scrolling for a menu line too
// long for its box -- hold, step one character at a time, hold on the tail,
// snap back. Shared by the Gen 2 textbox (ui/OptionsMenu.ts).

// Only ever one row scrolls (the cursor's), so one shared phase keeps that
// row's label and value stepping together (Marquee.lua:13).
const phase: { key: unknown; start: number } = { key: undefined, start: 0 };

// Marquee.lua:15 -- love.timer.getTime
function clock(): number {
  return Date.now() / 1000;
}

export const Marquee = {
  HOLD: 1.0,
  STEP: 0.25,

  /** Marquee.lua:21 -- pure, so a test can step it without a clock. */
  at(text: string | null | undefined, maxChars: number, elapsed: number): string {
    text = text ?? "";
    const over = text.length - maxChars;
    if (over <= 0) return text;
    const span = Marquee.HOLD * 2 + over * Marquee.STEP;
    const now = ((elapsed % span) + span) % span;
    let offset: number;
    if (now < Marquee.HOLD) offset = 0;
    else if (now < Marquee.HOLD + over * Marquee.STEP) offset = Math.floor((now - Marquee.HOLD) / Marquee.STEP);
    else offset = over;
    return text.slice(offset, offset + maxChars);
  },

  /** Marquee.lua:39 -- `key` identifies the highlighted row; changing it restarts the cycle. */
  scroll(text: string | null | undefined, maxChars: number, key?: unknown): string {
    if (!text || text.length <= maxChars) return text ?? "";
    if (phase.key !== key) {
      phase.key = key;
      phase.start = clock();
    }
    return Marquee.at(text, maxChars, clock() - phase.start);
  },

  /** Marquee.lua:45 */
  clip(text: string | null | undefined, maxChars: number): string {
    return (text ?? "").slice(0, maxChars);
  },
};

export default Marquee;
