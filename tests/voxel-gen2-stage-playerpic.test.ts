// The player's own pic on Gold/Silver/Crystal's 3D battle stage
// (platform/battlestage.ts playerPic): CAL where the pak has no player pics
// of its own, Crystal's CHRIS or KRIS by the save's gender, each in its row.
import { describe, expect, test } from "bun:test";
import { playerPic } from "../voxelmon/game/gen2/platform/battlestage.ts";

const male = { player: { gender: "male" } };
const female = { player: { gender: "female" } };

describe("the player's pic on the 3D stage", () => {
  test("Gold and Silver stand CAL whatever the save says", () => {
    const pics = { cal: 662, falkner: 670 };
    expect(playerPic(pics, male)).toEqual({ key: "cal", palette: "PLAYER" });
    expect(playerPic(pics, female)).toEqual({ key: "cal", palette: "PLAYER" });
    expect(playerPic(undefined, male)).toEqual({ key: "cal", palette: "PLAYER" });
  });
  test("Crystal stands CHRIS, or KRIS in her own colours", () => {
    const pics = { cal: 669, chris: 672, kris: 690 };
    expect(playerPic(pics, male)).toEqual({ key: "chris", palette: "PLAYER" });
    expect(playerPic(pics, {})).toEqual({ key: "chris", palette: "PLAYER" });
    expect(playerPic(pics, female)).toEqual({ key: "kris", palette: "FALKNER" });
  });
});
