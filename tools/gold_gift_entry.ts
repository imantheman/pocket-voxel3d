// A Citra check of MYSTERY GIFT between two consoles (cc_linkdrive.ps1 with
// PV_GOLD_LINK=2; this bench on both cards): the card's save loaded, MYSTERY
// GIFT unlocked in it (in play only), the main menu shown with the MYSTERY
// GIFT row picked, A to link, then A through the words. The screen, its
// phase and the outcome are logged. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { MysteryGift } from "../voxelmon/game/gen2/core/MysteryGift.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void; linkLog?: boolean };
g.linkLog = true;
const game = g.goldGame;
const mainFrame = g.frame;
let n = 0;
let last = "";
let shot = false;

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  if (n === 200) {
    const [save] = Save.load();
    if (save) {
      MysteryGift.unlock(save);
      // a fresh day for the bench: today's partners forgotten
      save.mysteryGift.ids = [];
      save.mysteryGift.item = 0;
      game.stack.clear();
      game.phase = "boot";
      game.save = undefined;
      // the main menu's own MYSTERY GIFT row
      Screens.push(game, "Gen2MainMenu", {
        save,
        onNewGame: () => {},
        onContinue: () => {},
        onMysteryGift: (s: any) => {
          game.stack.clear();
          Screens.push(game, "Gen2MysteryGift", { save: s, onClose: () => console.log("[pv] bench gift: closed") });
        },
      });
      const menu = game.stack.top();
      const rows = menu.list.items.map((i: any) => i.value);
      console.log(`[pv] bench gift: main menu ${rows.join(",")}`);
      menu.choose("gift");
    }
  }
  const top = game.stack.top();
  const now = `${top?.screenId ?? "-"}:${top?.phase ?? "-"}`;
  if (now !== last) {
    last = now;
    console.log(`[pv] bench gift: ${now} tick ${n}${top?.result ? ` result ${JSON.stringify(top.result)}` : ""}${top?.pages?.length ? ` "${top.pages.join(" / ").replace(/\n/g, " ")}"` : ""}`);
  }
  if (top?.screenId === "Gen2MysteryGift") {
    if (top.phase === "prompt" && n % 30 === 0) pad = VOX_BTN.a;
    if (top.phase === "message" && !shot) {
      shot = true;
      native.screenshot?.();
    }
    if (top.phase === "message" && n % 90 === 0) pad = VOX_BTN.a;
  }
  mainFrame((b & ~0xff) | pad);
};
