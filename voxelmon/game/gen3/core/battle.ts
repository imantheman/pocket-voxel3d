// Port of gen1recomp src/core/game3/battle.lua (GPLv3 + additional terms; see LICENSE.md).
// Package entry (custom searchers that only try *.lua, not */init.lua):
// `return require("src.core.game3.battle.init")`.
//
// Port note: pure re-exports (live bindings), so nothing here reads Battle at
// load time; an import cycle through battle/init.ts cannot hit its TDZ.

export { Battle, Battle as battle, Battle as default } from "./battle/init.ts";
