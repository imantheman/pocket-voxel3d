// gen1recomp src/script/gen2/specials/battle_tower.lua at bdfac727 (MIT): Crystal-only
// specials (pokecrystal/data/events/special_pointers.asm:124-181), NOT ported.
// Gold's SpecialsPointers never names them, so this module is deliberately
// empty: Specials.merge adds nothing, and Specials' own STUB_ROWS answer for
// every name the Lua defined here (BattleTowerAction, CheckForBattleTowerRules, Menu_ChallengeExplanationCancel, LoadOpponentTrainerAndPokemonWithOTSprite, BattleTowerBattle, BattleTowerRoomMenu) with their
// documented wScriptVar, the same as a Lua boot without this module would.

export const battle_tower: Record<string, (vm: any) => any> = {};
export default battle_tower;
