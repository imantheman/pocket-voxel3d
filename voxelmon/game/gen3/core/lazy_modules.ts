// pocket-voxel runtime glue for the gen3 (FireRed) port (GPLv3 + additional
// terms; see LICENSE.md). gen1recomp requires some modules lazily by name
// (pcall(require, "src.ui.game3.credits") and the like); the port looks those
// up in `G3Lazy` (core/runtime.ts), where each port registers itself:
//
//   // at the end of the module
//   G3Lazy["src.ui.game3.credits"] = Credits;
//
// and is imported here, so that loading Game3 loads every registered module.
// A module not listed here reads as absent -- Brian's failed-require path.
// Add one import line per lazily-required module you port.

export {};
