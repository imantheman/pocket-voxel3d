// gen1recomp src/script/gen2/specials/crystal_story.lua at bdfac727 (MIT): Crystal-only
// specials (pokecrystal/data/events/special_pointers.asm:124-181), NOT ported.
// Gold's SpecialsPointers never names them, so this module is deliberately
// empty: Specials.merge adds nothing, and Specials' own STUB_ROWS answer for
// every name the Lua defined here (BeastsCheck, GiveDratini, GiveOddEgg, HoOhChamber, OmanyteChamber, CelebiShrineEvent, CheckCaughtCelebi) with their
// documented wScriptVar, the same as a Lua boot without this module would.

export const crystal_story: Record<string, (vm: any) => any> = {};
export default crystal_story;
