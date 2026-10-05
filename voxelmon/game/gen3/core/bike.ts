// Port of gen1recomp src/core/game3/bike/init.lua (GPLv3 + additional terms; see LICENSE.md).
// require("src.core.game3.bike") resolves to bike/init.lua. Its rse parts
// (bike/rse.lua, bike/specials_rse.lua: the Mach/Acro bike) are Emerald only.

import { Capabilities } from "./capabilities.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const Bike = {
  // Lua: bike/init.lua:4 -- pokeemerald/src/bike.c:127 MovePlayerOnBike
  rse(session: any): any {
    if (!Capabilities.has(session, "machAcroBike")) return null;
    // NOT FAITHFUL: Emerald only -- src.core.game3.bike.rse is not ported.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.bike.rse");
  },
};

export default Bike;
