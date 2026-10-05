// Port of gen1recomp src/core/game3/battle/effects.lua (GPLv3 + additional terms; see LICENSE.md).
// Package entry for effects registry:
// `return require("src.core.game3.battle.effects.init")`.
//
// Port note: pure re-exports (live bindings), so an import cycle through
// effects/init.ts cannot hit its TDZ.

export { Effects, Effects as effects, Effects as default } from "./effects/init.ts";
