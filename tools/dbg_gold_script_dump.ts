// Debug: print Gold event scripts as the VM runs them (bun
// tools/dbg_gold_script_dump.ts <scriptKey>...) -- each op with its args,
// specials by name (constants.specialOrder), text by its first line, and
// every script it jumps or calls into, once. For reading the ROM's own flow
// (the link receptionists, the link rooms) before porting the specials.
import { readFileSync } from "node:fs";

const gen = "dist/voxelmon/gold/gen";
const scripts = JSON.parse(readFileSync(`${gen}/scripts.json`, "utf8"));
const constants = JSON.parse(readFileSync(`${gen}/constants.json`, "utf8"));
const text = JSON.parse(readFileSync(`${gen}/text.json`, "utf8"));
const order: string[] = constants.specialOrder ?? [];
const textOf = (k: unknown): string => {
  const t = (text.texts ?? text)[String(k)];
  const s = typeof t === "string" ? t : Array.isArray(t) ? t.join(" ") : t?.text ?? JSON.stringify(t ?? "");
  return String(s ?? "").replace(/\s+/g, " ").slice(0, 70);
};
const seen = new Set<string>();
const queue: string[] = process.argv.slice(2);
while (queue.length) {
  const key = queue.shift()!;
  if (seen.has(key)) continue;
  seen.add(key);
  const ops = scripts[key];
  console.log(`\n== ${key}`);
  if (!Array.isArray(ops)) {
    console.log("   (not a script)");
    continue;
  }
  for (const o of ops) {
    let line = `   ${o.op}`;
    if (o.op === "special") line += ` ${order[o.id ?? o.args?.[0]] ?? o.id}`;
    else if (o.args) line += ` ${JSON.stringify(o.args)}`;
    if (o.text) line += `  "${textOf(o.text)}"`;
    if (o.script) {
      line += `  -> ${o.script}`;
      queue.push(String(o.script));
    }
    if (o.movement) line += `  move ${JSON.stringify(o.movement).slice(0, 60)}`;
    for (const k of Object.keys(o)) {
      if (!["op", "args", "text", "script", "movement", ...(o.op === "special" ? ["id"] : [])].includes(k)) line += ` ${k}=${JSON.stringify(o[k]).slice(0, 50)}`;
    }
    console.log(line);
  }
}
