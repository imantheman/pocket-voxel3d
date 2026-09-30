// Port of gen1recomp RomExtractorGen2.lua (bdfac727): extractItems (:4331),
// extractMarts (:4458) and extractMoves (:4507, which writes type_chart
// too).

import type { Gen2Ctx } from "./ctx.ts";
import { lua, percentOf } from "./helpers.ts";

/** :375 ITEMMENU_* — not contiguous (const_skip 3 after NOUSE). */
const ITEM_MENU_NAME: Record<number, string> = {
  0: "ITEMMENU_NOUSE",
  4: "ITEMMENU_CURRENT",
  5: "ITEMMENU_PARTY",
  6: "ITEMMENU_CLOSE",
};

/** :4457 constants/mart_constants.asm (MART_UNDERGROUND is 33). */
const NUM_MARTS = 34;

/**
 * RomExtractorGen2.lua:4331 extractItems. items.json: {generation 2, source,
 * pockets (pocketOrder), ITEM_ID: {id, index (1-based item id), name?,
 * source "ROM:ItemNames[i]", price, heldEffect?, heldParameter, canSelect,
 * canToss, propertyRaw, pocket (name; pocket ids are 1-based), pocketId,
 * fieldMenu?, battleMenu?, description, tmNumber?, teaches?, tmLabel?}}.
 * TM/HM items past itemNameCount have no ItemNames row: their name is the
 * TM##/HM## label.
 */
export function extractItems(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants as Record<string, any>;
  const order: string[] | undefined = consts.itemOrder;
  if (!order || order.length === 0) {
    return {
      generation: 2,
      source: "Gold items: itemOrder missing from manifest : re-run make_gold_manifest.py",
    };
  }
  const charmap = ctx.manifest.charmap ?? {};
  const names = ctx.symbol("ItemNames");
  const attributes = ctx.symbol("ItemAttributes");
  const descriptions = ctx.symbol("ItemDescriptions");
  const pocketOrder: string[] = consts.pocketOrder ?? [];
  const heldOrder: string[] = consts.heldEffectOrder ?? [];
  const out: Record<string, any> = {
    generation: 2,
    source: "ROM:ItemNames + ItemAttributes + constants/item_constants.asm",
    pockets: pocketOrder,
  };
  const nameCount: number = consts.itemNameCount ?? order.length;
  let address = names.address;
  order.forEach((itemId, i) => {
    const index = i + 1;
    let value: string | undefined;
    if (index <= nameCount) {
      const [str, consumed] = rom.readString(names.bank, address, charmap, 0x50, 32);
      value = str;
      address += consumed;
    }
    if (itemId && itemId !== "UNUSED") {
      // ItemAttributes rows (7 bytes): dw price; db held effect, parameter,
      // property, pocket; dn field menu, battle menu. MASTER_BALL (1) is row 0.
      const base = attributes.address + (index - 1) * 7;
      const property = rom.byte(attributes.bank, base + 4);
      const pocket = rom.byte(attributes.bank, base + 5);
      const menus = rom.byte(attributes.bank, base + 6);
      const descAddress = rom.word(descriptions.bank, descriptions.address + (index - 1) * 2);
      out[itemId] = {
        id: itemId,
        index,
        name: value,
        source: `ROM:ItemNames[${index}]`,
        price: rom.word(attributes.bank, base),
        heldEffect: heldOrder[rom.byte(attributes.bank, base + 2)], // Lua [byte + 1]
        heldParameter: rom.byte(attributes.bank, base + 3),
        // CANT_SELECT is bit 6, CANT_TOSS bit 7
        canSelect: Math.floor(property / 0x40) % 2 === 0,
        canToss: Math.floor(property / 0x80) % 2 === 0,
        propertyRaw: property,
        // item types are const_def 1: indexed by the value itself
        pocket: lua(pocketOrder, pocket) ?? pocket,
        pocketId: pocket,
        fieldMenu: ITEM_MENU_NAME[Math.floor(menus / 16)],
        battleMenu: ITEM_MENU_NAME[menus % 16],
        description: rom.readString(descriptions.bank, descAddress, charmap, 0x50, 128)[0],
      };
    }
  });

  // :4417 TM/HM numbering and TMHMMoves.
  const tmhmMoves = ctx.symbol("TMHMMoves");
  const moveOrder: string[] = consts.moveOrder ?? [];
  let number = 0;
  let hmCount = 0;
  for (const itemId of order) {
    const entry = out[itemId];
    if (entry && (itemId.startsWith("TM_") || itemId.startsWith("HM_"))) {
      number += 1;
      const moveId = rom.byte(tmhmMoves.bank, tmhmMoves.address + number - 1);
      entry.tmNumber = number;
      entry.teaches = lua(moveOrder, moveId) ?? moveId;
      if (itemId.startsWith("HM_")) {
        hmCount += 1;
        entry.tmLabel = `HM${String(hmCount).padStart(2, "0")}`;
      } else {
        entry.tmLabel = `TM${String(number).padStart(2, "0")}`;
      }
      entry.name = entry.name ?? entry.tmLabel;
    }
  }
  return out;
}

/**
 * RomExtractorGen2.lua:4458 extractMarts. marts.json: {generation 2, source,
 * lists?: [34 lists of item ids] (lists[martId] = MART_* id martId, i.e.
 * Brian's 1-based lists[martId + 1]), bargain?: [{item, price}]}.
 */
export function extractMarts(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const order: string[] = (ctx.manifest.constants.itemOrder as string[] | undefined) ?? [];
  const out: Record<string, unknown> = {
    generation: 2,
    source: "ROM:Marts + BargainShopData (data/items/marts.asm)",
  };
  const marts = ctx.location("Marts");
  if (marts) {
    const bank = marts[0];
    const lists: (string | number)[][] = [];
    for (let index = 0; index < NUM_MARTS; index++) {
      const address = rom.word(bank, marts[1] + index * 2);
      const count = rom.byte(bank, address);
      const list: (string | number)[] = [];
      for (let slot = 1; slot <= count; slot++) {
        const id = rom.byte(bank, address + slot);
        if (id === 0xff) break;
        list.push(lua(order, id) ?? id);
      }
      lists.push(list);
    }
    out.lists = lists;
  }
  const bargain = ctx.location("BargainShopData");
  if (bargain) {
    const bank = bargain[0];
    let address = bargain[1] + 1; // past the count byte
    const rows: { item: string | number; price: number }[] = [];
    while (true) {
      const id = rom.byte(bank, address);
      if (id === 0xff) break;
      rows.push({ item: lua(order, id) ?? id, price: rom.word(bank, address + 1) });
      address += 3;
    }
    out.bargain = rows;
  }
  return out;
}

/**
 * RomExtractorGen2.lua:4507 extractMoves. Returns {moves, type_chart}:
 * - moves.json: {generation 2, source, MOVE_ID: {id, index (1-based),
 *   name, source "ROM:Moves[i]", animation, effect, effectId, power, type,
 *   accuracy (0-100), accuracyRaw, pp, effectChance (0-100),
 *   effectChanceRaw, description}};
 * - type_chart.json: {generation 2, source, names {TYPE: display},
 *   types {TYPE: {id, index, name, category physical|special}},
 *   matchups [{attacker, defender, multiplier (x10)}], foresightMatchups}.
 */
export function extractMoves(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants as Record<string, any>;
  const order: string[] = consts.moveOrder ?? [];
  const effects: string[] = consts.moveEffectOrder ?? [];
  const types: Record<string, number> = consts.types ?? {};
  const typeById: Record<number, string> = {};
  for (const [name, value] of Object.entries(types)) typeById[value] = name;
  const charmap = ctx.manifest.charmap ?? {};

  const moves = ctx.symbol("Moves");
  const names = ctx.symbol("MoveNames");
  const descriptions = ctx.symbol("MoveDescriptions");
  const out: Record<string, unknown> = { generation: 2, source: "ROM:Moves + MoveNames" };
  let nameAddress = names.address;
  order.forEach((moveId, i) => {
    const index = i + 1;
    const row = rom.bytes(moves.bank, moves.address + i * 7, 7);
    const [name, consumed] = rom.readString(names.bank, nameAddress, charmap, 0x50, 32);
    nameAddress += consumed;
    const descAddress = rom.word(descriptions.bank, descriptions.address + i * 2);
    const description = rom.readString(descriptions.bank, descAddress, charmap, 0x50, 128)[0];
    if (moveId && moveId !== "UNUSED") {
      out[moveId] = {
        id: moveId,
        index,
        name,
        source: `ROM:Moves[${index}]`,
        animation: row[0],
        effect: effects[row[1]!] ?? row[1], // Lua [byte + 1]
        effectId: row[1],
        power: row[2],
        type: typeById[row[3]!] ?? row[3],
        // `db N percent` stores 255*N/100
        accuracy: percentOf(row[4]),
        accuracyRaw: row[4],
        pp: row[5],
        effectChance: percentOf(row[6]),
        effectChanceRaw: row[6],
        description,
      };
    }
  });

  // :4563 TypeMatchups: -2 starts the Foresight block, -1 ends.
  const matchupSymbol = ctx.symbol("TypeMatchups");
  const matchups: unknown[] = [];
  const foresight: unknown[] = [];
  let target = matchups;
  let offset = 0;
  while (offset < 0x400) {
    const attacker = rom.byte(matchupSymbol.bank, matchupSymbol.address + offset);
    if (attacker === 0xff) break;
    if (attacker === 0xfe) {
      target = foresight;
      offset += 1;
    } else {
      const defender = rom.byte(matchupSymbol.bank, matchupSymbol.address + offset + 1);
      const multiplier = rom.byte(matchupSymbol.bank, matchupSymbol.address + offset + 2);
      target.push({
        attacker: typeById[attacker] ?? attacker,
        defender: typeById[defender] ?? defender,
        multiplier,
      });
      offset += 3;
    }
  }

  // :4591 ids below FIRE (the SPECIAL block start) are physical.
  const specialBoundary = types.FIRE ?? 0x14;
  const typeNames = ctx.symbol("TypeNames");
  const names2: Record<string, string> = {};
  const records: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(types)) {
    const pointer = rom.word(typeNames.bank, typeNames.address + value * 2);
    const display = rom.readString(typeNames.bank, pointer, charmap, 0x50, 16)[0];
    names2[name] = display;
    records[name] = { id: name, index: value, name: display, category: value < specialBoundary ? "physical" : "special" };
  }
  return {
    moves: out,
    type_chart: {
      generation: 2,
      source: "ROM:TypeMatchups + TypeNames",
      names: names2,
      types: records,
      matchups,
      foresightMatchups: foresight,
    },
  };
}
