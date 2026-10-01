// Group D shops and PCs (voxelmon/game/gen2/ui/MartMenu, BoxMenu, ItemPcMenu,
// BankOfMom, PcMenu, CenterPcMenu) on a real Game2 with the Gold data and the
// Gold screen, driven through Input the way a player would.

import { describe, expect, test } from "bun:test";
import { gold, mon, rig, standIns, type Rig } from "./gen2-ui-d-harness.ts";
import { Typer } from "../voxelmon/game/gen2/ui/Typer.ts";
import { MartMenu } from "../voxelmon/game/gen2/ui/MartMenu.ts";
import { BoxMenu } from "../voxelmon/game/gen2/ui/BoxMenu.ts";
import { ItemPcMenu } from "../voxelmon/game/gen2/ui/ItemPcMenu.ts";
import { BankOfMom } from "../voxelmon/game/gen2/ui/BankOfMom.ts";
import { PcMenu } from "../voxelmon/game/gen2/ui/PcMenu.ts";
import { CenterPcMenu } from "../voxelmon/game/gen2/ui/CenterPcMenu.ts";
import { World } from "../voxelmon/game/gen2/world/World.ts";

standIns();

/** Idle until the screen's Typer has finished the page (or a cap). */
function settle(r: Rig, screen: any, cap = 400): void {
  for (let i = 0; i < cap && Typer.typing(screen); i++) r.frame(0);
}

const topName = (game: any): string | undefined => {
  const top = game.stack.top();
  return top ? top.constructor.name : undefined;
};

describe("gen2 POKéMART", () => {
  test.skipIf(!gold)("buys two POKé BALLs and sells a POTION: money and bag both change", async () => {
    const r = await rig({ seed: 7 });
    const { game } = r;
    game.save.player.money = 3000;
    game.save.inventory = { POTION: 3 };
    let closed = false;
    const mart = MartMenu.new(game, {
      martType: 0,
      martId: 1,
      text: game.data.gen2Text,
      onClose: () => {
        closed = true;
        game.stack.pop();
      },
    });
    game.stack.push(mart);
    expect(mart.phase).toBe("top");
    expect(mart.entries.map((e) => e.id).slice(0, 2)).toEqual(["POKE_BALL", "POTION"]);
    await r.shot("d_mart_top");

    // BUY
    r.press("a");
    expect(mart.phase).toBe("buy");
    expect(mart.isOpaque).toBe(true);
    await r.shot("d_mart_buy");
    r.press("a");
    expect(mart.phase).toBe("buyQuantity");
    r.press("up");
    expect(mart.qty).toBe(2);
    await r.shot("d_mart_qty");
    r.press("a");
    expect(mart.confirm).toBeDefined();
    settle(r, mart);
    expect(mart.yesNoVisible()).toBe(true);
    await r.shot("d_mart_confirm");
    r.press("a"); // YES
    expect(game.save.player.money).toBe(3000 - 2 * 200);
    expect(game.save.inventory.POKE_BALL).toBe(2);
    expect(mart.message).toBeDefined();
    settle(r, mart);
    r.press("a");
    expect(mart.message).toBeUndefined();
    expect(mart.phase).toBe("buy");

    // back to the top menu, then SELL
    r.press("b");
    expect(mart.phase).toBe("top");
    r.press("down");
    r.press("a");
    expect(mart.phase).toBe("sell");
    expect(mart.pack).toBeDefined();
    await r.shot("d_mart_sell");
    // the PACK opens on the ITEM pocket, POTION on row one
    r.press("a");
    expect(mart.phase).toBe("sellQuantity");
    expect(mart.qtyItem!.id).toBe("POTION");
    expect(mart.qtyMax).toBe(3);
    await r.shot("d_mart_sell_qty");
    r.press("a");
    // MartSellPriceText: the price page, then "Is that OK?" with the YES/NO
    settle(r, mart);
    expect(mart.yesNoVisible()).toBe(false);
    r.press("a");
    settle(r, mart);
    expect(mart.yesNoVisible()).toBe(true);
    r.press("a"); // YES
    expect(game.save.player.money).toBe(2600 + 150);
    expect(game.save.inventory.POTION).toBe(2);
    settle(r, mart);
    r.press("a");
    expect(mart.phase).toBe("sell");

    // out of the PACK, QUIT, come again
    r.press("b");
    expect(mart.phase).toBe("top");
    r.press("b");
    settle(r, mart);
    r.press("a");
    expect(closed).toBe(true);
    expect(game.stack.top()).toBeUndefined();
  });

  test.skipIf(!gold)("a broke player hears about the money, not the PACK", async () => {
    const r = await rig({ seed: 8 });
    const { game } = r;
    game.save.player.money = 100;
    game.save.inventory = {};
    const mart = MartMenu.new(game, { martType: 0, martId: 1, text: game.data.gen2Text });
    game.stack.push(mart);
    r.press("a");
    r.press("a");
    r.press("a");
    settle(r, mart);
    r.press("a");
    expect(game.save.player.money).toBe(100);
    expect(game.save.inventory.POKE_BALL).toBeUndefined();
    expect(mart.message).toBeDefined();
  });
});

describe("gen2 BILL's PC boxes", () => {
  test.skipIf(!gold)("deposits a party mon into BOX1 and withdraws it again", async () => {
    const r = await rig({ seed: 9 });
    const { game } = r;
    game.save.party = [mon(game, "CYNDAQUIL", 8), mon(game, "PIDGEY", 4), mon(game, "RATTATA", 3)];
    game.save.currentBox = 1;
    game.save.boxes = [];
    const box = BoxMenu.new(game, { mode: "deposit", onClose: () => game.stack.pop() });
    game.stack.push(box);
    r.press("down");
    expect(box.selected().species).toBe("PIDGEY");
    await r.shot("d_box_main");
    r.press("a");
    expect(box.phase).toBe("submenu");
    await r.shot("d_box_submenu");
    r.press("a"); // DEPOSIT
    expect(game.save.party.map((m: any) => m.species)).toEqual(["CYNDAQUIL", "RATTATA"]);
    expect(game.save.boxes[0].map((m: any) => m.species)).toEqual(["PIDGEY"]);
    expect(box.message).toBe("Stored PIDGEY!");
    await r.shot("d_box_stored");
    r.idle(60);
    expect(box.message).toBeUndefined();
    r.press("b");
    expect(game.stack.top()).toBeUndefined();

    const withdraw = BoxMenu.new(game, { mode: "withdraw", onClose: () => game.stack.pop() });
    game.stack.push(withdraw);
    expect(withdraw.selected().species).toBe("PIDGEY");
    await r.shot("d_box_withdraw");
    r.press("a");
    r.press("a"); // WITHDRAW
    expect(game.save.party.map((m: any) => m.species)).toEqual(["CYNDAQUIL", "RATTATA", "PIDGEY"]);
    expect(game.save.boxes[0].length).toBe(0);
    r.idle(60);
    r.press("b");
    expect(game.stack.top()).toBeUndefined();
  });

  test.skipIf(!gold)("MOVE walks into the PARTY and inserts there", async () => {
    const r = await rig({ seed: 10 });
    const { game } = r;
    game.save.party = [mon(game, "CYNDAQUIL", 8)];
    game.save.currentBox = 1;
    game.save.boxes = [[mon(game, "SENTRET", 3)]];
    const box = BoxMenu.new(game, { mode: "move", onClose: () => game.stack.pop() });
    game.stack.push(box);
    r.press("a");
    r.press("a"); // MOVE
    expect(box.phase).toBe("insert");
    r.press("left"); // BOX1 -> PARTY
    expect(box.boxIndex).toBe(0);
    await r.shot("d_box_move_insert");
    r.press("a");
    expect(game.save.party.map((m: any) => m.species)).toEqual(["SENTRET", "CYNDAQUIL"]);
    expect(game.save.boxes[0].length).toBe(0);
  });
});

describe("gen2 item PC", () => {
  test.skipIf(!gold)("stores three POTIONs and withdraws one", async () => {
    const r = await rig({ seed: 11 });
    const { game } = r;
    game.save.party = [mon(game, "CYNDAQUIL", 8)];
    game.save.inventory = { POTION: 5 };
    game.save.pcItems = {};
    let closed = false;
    const pc = ItemPcMenu.new(game, {
      onClose: () => {
        closed = true;
        game.stack.pop();
      },
    });
    game.stack.push(pc);
    await r.shot("d_itempc");
    r.press("down"); // DEPOSIT ITEM
    r.press("a");
    expect(pc.phase).toBe("deposit");
    await r.shot("d_itempc_deposit");
    r.press("a"); // POTION
    expect(pc.qtyState).toBeDefined();
    r.press("up");
    r.press("up");
    expect(pc.qtyState!.qty).toBe(3);
    await r.shot("d_itempc_qty");
    r.press("a");
    expect(game.save.pcItems.POTION).toBe(3);
    expect(game.save.inventory.POTION).toBe(2);
    settle(r, pc);
    r.press("a");
    r.press("b"); // out of the PACK
    expect(pc.phase).toBe("menu");

    r.press("up"); // WITHDRAW ITEM
    r.press("a");
    expect(pc.phase).toBe("withdraw");
    expect(pc.rows.map((row) => [row.id, row.count])).toEqual([["POTION", 3]]);
    await r.shot("d_itempc_withdraw");
    r.press("a");
    r.press("a"); // x1
    expect(game.save.pcItems.POTION).toBe(2);
    expect(game.save.inventory.POTION).toBe(3);
    settle(r, pc);
    r.press("a");
    r.press("b");
    expect(pc.phase).toBe("menu");
    r.press("b");
    expect(closed).toBe(true);
  });
});

describe("gen2 Bank of Mom", () => {
  test.skipIf(!gold)("SAVE moves ¥1200 from the wallet into Mom's savings", async () => {
    const r = await rig({ seed: 12 });
    const { game } = r;
    game.save.player.money = 5000;
    game.save.mom = { active: true, savedMoney: 100 };
    let answered: number | undefined = -1;
    // World.bankOfMomAmount is the special's hook: it pushes the keypad and
    // hands back the typed amount; the StoreMoney arithmetic is H.BankOfMom's.
    const host: any = { game, pushScreen: (World as any).prototype.pushScreen };
    (World as any).prototype.bankOfMomAmount.call(host, "deposit",
      game.save.mom.savedMoney, game.save.player.money, (amount: number | undefined) => {
        answered = amount;
        if (amount != null && amount <= game.save.player.money) {
          game.save.mom.savedMoney += amount;
          game.save.player.money -= amount;
        }
      });
    expect(topName(game)).toBe("BankOfMom");
    const bank: BankOfMom = game.stack.top();
    r.press("left");
    r.press("left"); // hundreds
    r.press("up");
    r.press("up");
    r.press("left"); // thousands
    r.press("up");
    expect(bank.amount).toBe(1200);
    r.press("down");
    r.press("up");
    await r.shot("d_bank");
    r.press("a");
    expect(answered).toBe(1200);
    expect(game.save.player.money).toBe(3800);
    expect(game.save.mom.savedMoney).toBe(1300);
    expect(game.stack.top()).toBeUndefined();
  });
});

describe("gen2 PC top menus", () => {
  test.skipIf(!gold)("BILL's PC draws, opens a box list, the CHANGE BOX picker, and logs off", async () => {
    const r = await rig({ seed: 13 });
    const { game } = r;
    game.save.party = [mon(game, "CYNDAQUIL", 8)];
    let closed = false;
    const pc = PcMenu.new(game, {
      bills: true,
      onClose: () => {
        closed = true;
        game.stack.pop();
      },
    });
    game.stack.push(pc);
    expect(pc.entries.map((e) => e.id)).toEqual(["withdraw", "deposit", "changebox", "move", "seeya"]);
    await r.shot("d_pc");
    r.press("a"); // WITHDRAW -> BoxMenu
    expect(topName(game)).toBe("BoxMenu");
    r.press("b");
    expect(game.stack.top()).toBe(pc);
    r.press("down");
    r.press("down");
    r.press("a"); // CHANGE BOX
    expect(pc.picking).toBe(true);
    await r.shot("d_pc_changebox");
    r.press("b");
    expect(pc.picking).toBe(false);
    r.press("b");
    expect(closed).toBe(true);

    // .CheckCanUsePC: no party, the refusal, and the PC closes
    game.save.party = [];
    let refused = false;
    const empty = PcMenu.new(game, { onClose: () => (refused = true) });
    expect(empty.message).toBe("You'll need a\nPOKéMON to call");
    game.stack.push(empty);
    r.press("a");
    r.press("a");
    expect(refused).toBe(true);
  });

  test.skipIf(!gold)("the whose-PC menu boots, opens BILL's PC and turns off", async () => {
    const r = await rig({ seed: 14 });
    const { game } = r;
    game.save.party = [mon(game, "CYNDAQUIL", 8)];
    let closed = false;
    const center = CenterPcMenu.new(game, {
      onClose: () => {
        closed = true;
        game.stack.pop();
      },
    });
    game.stack.push(center);
    settle(r, center);
    await r.shot("d_centerpc_boot");
    r.press("a");
    expect(center.booted).toBe(true);
    expect(center.entries.map((e) => e.id)).toEqual(["bills", "players", "turnoff"]);
    await r.shot("d_centerpc");
    r.press("a"); // BILL's PC
    settle(r, center);
    r.press("a");
    settle(r, center);
    r.press("a");
    expect(topName(game)).toBe("PcMenu");
    r.press("b"); // SEE YA via B
    expect(game.stack.top()).toBe(center);
    r.press("down");
    r.press("a"); // <PLAYER>'s PC
    settle(r, center);
    r.press("a");
    settle(r, center);
    r.press("a");
    expect(topName(game)).toBe("ItemPcMenu");
    r.press("b");
    expect(game.stack.top()).toBe(center);
    r.press("down");
    r.press("a"); // TURN OFF
    settle(r, center);
    r.press("a");
    expect(closed).toBe(true);

    // no party: the Bzzzzt! refusal, and the PC never boots
    game.save.party = [];
    let refused = false;
    const empty = CenterPcMenu.new(game, { onClose: () => (refused = true) });
    game.stack.push(empty);
    for (let i = 0; i < 4 && !refused; i++) {
      settle(r, empty);
      r.press("a");
    }
    expect(empty.booted).toBe(false);
    expect(refused).toBe(true);
  });
});
