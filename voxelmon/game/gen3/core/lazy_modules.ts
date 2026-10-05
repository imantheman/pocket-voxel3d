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

import "../ui/coins_box.ts";
import "../ui/berry_powder_box.ts";
import "../ui/stat_growth.ts";
import "../ui/ui_pass.ts";
import "../ui/credits.ts";
import "../ui/diploma.ts";
import "../ui/museum_fossil_pic.ts";
import "../ui/trainer_tower_records.ts";
import "../ui/move_relearner.ts";
import "../ui/daycare_menu.ts";
import "./town_map_stub.ts";
import "./battle/anim_pack_fallback.ts";
import "./camera_object.ts";
import "./field_weather.ts";
import "./pokecenter_heal.ts";
import "./ss_anne_cutscene.ts";
import "./league_lighting.ts";
import "./truck_sequence.ts";
import "./fldeff_misc.ts";
import "./scripting/natives_listmenu.ts";
import "../ui/elevator_window.ts";

export {};
