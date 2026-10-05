// Port of gen1recomp src/core/game3/battle/anim_pack_fallback.lua (GPLv3 + additional terms; see LICENSE.md).
// Builtin fallback anim pack when cache extract is missing.
// Provides generic Tackle-like IR for all moves + a few named labels.
// A lazily-required module (anim.lua pcalls it): registered in G3Lazy.

import { G3Lazy } from "../lazy_registry.ts";

// A sequence ({a, b}); local so module-scope tables never call an import.
const lseq = (...xs: any[]): any[] => [null, ...xs];


const GENERIC = lseq(
  { op: "loadspritegfx", tag: "IMPACT" },
  { op: "monbg", battler: "target" },
  { op: "createsprite", template: "gHorizontalLungeSpriteTemplate", animBattler: "attacker", subpriority: 2, args: lseq(4, 4) },
  { op: "delay", frames: 6 },
  { op: "createsprite", template: "gBasicHitSplatSpriteTemplate", animBattler: "attacker", subpriority: 2, tag: "IMPACT", args: lseq(0, 0, "target", 2) },
  { op: "createvisualtask", task: "AnimTask_ShakeMon", priority: 2, args: lseq("target", 3, 0, 6, 1) },
  { op: "waitforvisualfinish" },
  { op: "clearmonbg", battler: "target" },
  { op: "end" },
);

const STATUS = lseq(
  { op: "createvisualtask", task: "AnimTask_ShakeMon", priority: 2, args: lseq("attacker", 2, 0, 10, 1) },
  { op: "waitforvisualfinish" },
  { op: "end" },
);

const pack: Record<string, any> = {
  version: 1,
  moves: {} as Record<number, unknown>,
  status: {
    PSN: STATUS,
    BRN: STATUS,
    SLP: STATUS,
    PAR: STATUS,
    FRZ: STATUS,
  },
  general: {},
  special: {},
  labels: {},
  tags: {},
};

// Move id 33 = Tackle in FRLG; fill a range so lookups work
for (let id = 0; id <= 355; id++) {
  pack.moves[id] = GENERIC;
}

export const AnimPackFallback = pack;
export default AnimPackFallback;

G3Lazy["src.core.game3.battle.anim_pack_fallback"] = AnimPackFallback;
