// gen1recomp src/core/gen2/PhoneRing.lua at bdfac727 (MIT):
// Script_ReceivePhoneCall (engine/phone/phone.asm) as the row list the VM
// runs around a caller script:
//
//   reanchormap / callasm RingTwice_StartCall / memcall <SCRIPT2> /
//   waitbutton / callasm HangUp / closetext / callasm InitCallReceiveDelay
//
// RingTwice_StartCall rings TWICE (:458-469), each pass opening on
// Phone_StartRinging's WaitSFX (:564-567) and spaced by three
// Phone_Wait20Frames (:576-580) -- the wait matters, because SFX_CALL ($6a)
// is dropped by the PlaySFX priority gate while the textbox's A-press beep
// is still playing. The caller-ID box goes up inside the first ring
// (CallAsm) and stays; the cart's six-times flash is not kept, and the
// rawtext page is the beat that hold needs. HangUp is the VM's own `hangup`.
// Mom's shopping call may hand an inline row list as `scriptKey`.

import { Runtime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";
import type { PhoneCall } from "./Phone.ts";

/** One VM row. */
export interface PhoneRingRow {
  op: string;
  frames?: number;
  label?: string;
  text?: string;
  script?: unknown;
}

/** The rows, carrying the Lua's `rows.phoneContact` field. */
export type PhoneRingRows = PhoneRingRow[] & { phoneContact?: number };

// Lua: PhoneRing.lua:59
const RING_PAGE = Strings.source("RING!…RING!…\n%s");

export const PhoneRing = {
  // Lua: PhoneRing.lua:61-69 -- GetCallerClassAndName: "<name>:" plus the
  // class name for a trainer.
  callerId(name: string | undefined | null, className?: string | null): string {
    let line = `${name ?? ""}:`;
    if (className != null && className !== "") line = `${line} ${className}`;
    return line;
  },

  // Lua: PhoneRing.lua:71-129 -- `call` is a Phone.loadCallerScript /
  // Phone.checkSpecialCall descriptor; `delay` is the special call's
  // `pause 30`. phone.call_received is observation only.
  script(call: PhoneCall | undefined | null, name?: string, className?: string): PhoneRingRows {
    if (Runtime.wants("phone.call_received")) {
      Runtime.emit("phone.call_received", {
        call,
        contact: (call && call.contact) ?? 0,
        name, className,
        special: call ? call.special : undefined,
        scriptKey: call ? call.scriptKey : undefined,
      });
    }
    const rows: PhoneRingRows = [];
    rows.phoneContact = call ? call.contact : undefined;
    if (call && call.delay != null) {
      rows.push({ op: "pause", frames: call.delay });
    }
    rows.push({ op: "reanchormap" });
    // the two .Ring passes; the box goes up inside the first and comes down
    // in the InitCallReceiveDelay row
    rows.push({ op: "waitsfx" });
    rows.push({ op: "callasm", label: "RingTwice_StartCall" });
    rows.push({ op: "pause", frames: 60 });
    rows.push({ op: "waitsfx" });
    rows.push({ op: "callasm", label: "RingTwice_StartCall" });
    rows.push({ op: "rawtext", text: Strings.get(RING_PAGE, PhoneRing.callerId(name, className)) });
    rows.push({ op: "farscall", script: call ? call.scriptKey : undefined });
    rows.push({ op: "waitbutton" });
    rows.push({ op: "hangup" });
    rows.push({ op: "closetext" });
    rows.push({ op: "callasm", label: "InitCallReceiveDelay" });
    rows.push({ op: "end" });
    return rows;
  },
};

export default PhoneRing;
