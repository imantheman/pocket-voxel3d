// pocket-voxel runtime glue for the gen3 (FireRed) port (GPLv3 + additional
// terms; see LICENSE.md). The registry of lazily-required modules
// (pcall(require, "src....") in gen1recomp): a port ends with
//   G3Lazy["src.ui.game3.credits"] = Credits;
// and is listed in core/lazy_modules.ts. This module imports NOTHING, so it is
// always initialised before any module that imports it -- the registration
// above runs at module load, inside the big import cycle, and must not touch
// a binding that is not ready (it used to live in runtime.ts, which is).

export const G3Lazy: Record<string, any> = {};
export default G3Lazy;
