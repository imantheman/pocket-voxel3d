// gen1recomp src/ui/gen2/WaitPlaySFX.lua (bdfac727): play a sound effect and
// hold until it finishes.
// home/audio.asm:220 WaitPlaySFX

import { Sound as SoundModule } from "../shared/core/Sound.ts";

export interface PendingSfx {
  name: string;
  left: number;
}

// Lua: WaitPlaySFX.lua:3 -- the Lua pcall-requires Sound; here it is linked
function sound(): any {
  return SoundModule && typeof SoundModule === "object" ? SoundModule : null;
}

export const WaitPlaySFX = {
  /** Lua: WaitPlaySFX.lua:10 -- home/audio.asm:220 WaitPlaySFX, home/delay.asm:15 */
  arm(name: string, fallback?: number): PendingSfx {
    const Sound = sound();
    const frames = Sound && Sound.waitFramesFor ? Sound.waitFramesFor(name, fallback ?? 30) : undefined;
    const n = Number(frames);
    return { name, left: frames != null && Number.isFinite(n) ? n : 0 };
  },

  /** Lua: WaitPlaySFX.lua:18 -- home/audio.asm:225 WaitSFX */
  waiting(pending: PendingSfx | null | undefined): boolean {
    if (!pending) return false;
    pending.left = (pending.left ?? 0) - 1;
    if (pending.left <= 0) return false;
    const Sound = sound();
    if (!Sound) return false;
    if (Sound.sfxBusy && Sound.sfxBusy()) return true;
    return (Sound.isPlaying && Sound.isPlaying(pending.name)) || false;
  },
};

export default WaitPlaySFX;
