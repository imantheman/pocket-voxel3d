// The gen3 (FireRed) port of gen1recomp's demake quantizers -- quantize.lua,
// quantize_lab.lua, quantize_mrf.lua, palette_rules.lua (and luasort.ts, the
// port of LuaJIT's table.sort) -- against his Lua under luajit, on real
// inputs: the 8x8 BGR555 quadrants (and their FRLG palette-slot maps) of the
// metatiles of a dozen ROM map layouts, composited by his own
// Metatile.compositeBgr555, plus each layout's merged map palettes.
//
// The oracle below (written to a temp file, run with cwd ~/gen1recomp-latest)
// builds those inputs, calls every public function the way extract_island1's
// (dormant) quantize path does -- per quad, per metatile, per tileset pair --
// and prints the inputs and each result as JSON. The runner here replays the
// same cases, in the same order, on the port, and compares each result's
// encoding exactly (doubles to 17 significant digits).
//
// Where his result depends on LuaJIT's pairs() order (a tie in
// PaletteRules.ownCategory or a 2-2 split in cohereMidSlots for the network
// profile -- string hashes are seeded per run, so the Lua itself is not
// deterministic there) both sides record "<tie>" instead.
// KEEP THE TWO RUNNERS IN STEP. ROM-gated; also needs luajit.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stageCtx, skipReason, ROM_PATH, type StageCtx } from "./gen3-import-harness.ts";
import { Quantize, type Ramp } from "../voxelmon/import/gen3/quantize.ts";
import { QuantizeLab, type CodebookEntry } from "../voxelmon/import/gen3/quantize_lab.ts";
import { QuantizeMrf, type Placement } from "../voxelmon/import/gen3/quantize_mrf.ts";
import { PaletteRules } from "../voxelmon/import/gen3/palette_rules.ts";
import { luaSort } from "../voxelmon/import/gen3/luasort.ts";
import { format } from "../voxelmon/import/gen3/lua.ts";

const GEN1RECOMP = process.env.GEN1RECOMP ?? join(homedir(), "gen1recomp-latest");

const ctx: StageCtx | undefined = stageCtx();
const haveLuajit = (() => {
  try { execFileSync("luajit", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();
if (!ctx) console.log(`voxel-gen3-quantize: skipping -- ${skipReason()}`);
else if (!haveLuajit) console.log("voxel-gen3-quantize: skipping -- no luajit");

// ---------------------------------------------------------------- the oracle
const ORACLE = String.raw`
package.path = "./?.lua;./?/init.lua;" .. package.path
local ROM, SHA1 = arg[1], arg[2]
local GameVersion = require("src.core.GameVersion")
GameVersion.set("firered")
local RevisionView = require("src.import.gba.revision_view")
local Versions = require("src.import.gba.versions")
Versions.select(SHA1)
local f = assert(io.open(ROM, "rb"))
local data = RevisionView.apply(f:read("*a"), SHA1)
f:close()
local Rom = require("src.import.gba.rom")
local rom = setmetatable({ size = #data, md5 = SHA1, _raw = data, id = "firered" }, Rom)
local MapTree = require("src.import.gba.map_tree")
local MapCatalog = require("src.import.gba.map_catalog")
local Tileset = require("src.import.gba.tileset")
local Metatile = require("src.import.gba.metatile")
local Quantize = require("src.import.gba.quantize")
local QuantizeLab = require("src.import.gba.quantize_lab")
local QuantizeMrf = require("src.import.gba.quantize_mrf")
local PaletteRules = require("src.import.gba.palette_rules")

-- JSON
local function quote(s)
  return '"' .. s:gsub('[%c"\\\128-\255]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
end
local enc
enc = function(v)
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return tostring(v)
  elseif t == "number" then
    if v ~= v then return '"<nan>"' end
    if v == math.huge or v == -math.huge then return '"<inf>"' end
    if v == math.floor(v) and math.abs(v) < 2 ^ 53 then return string.format("%d", v) end
    return string.format("%.17g", v)
  elseif t == "string" then return quote(v)
  elseif t == "table" then
    local n, count = 0, 0
    for k in pairs(v) do
      count = count + 1
      if type(k) == "number" and k >= 1 and k == math.floor(k) and k > n then n = k end
    end
    if count == 0 then return "[]" end
    local parts = {}
    if n == count then
      for i = 1, n do parts[i] = enc(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys, byStr = {}, {}
    for k, val in pairs(v) do keys[#keys + 1] = tostring(k); byStr[tostring(k)] = val end
    table.sort(keys)
    for i, k in ipairs(keys) do parts[i] = quote(k) .. ":" .. enc(byStr[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return quote("<" .. t .. ">")
end

local res = {}
local function put(name, ...)
  local n, last = select("#", ...), 0
  for i = 1, n do if select(i, ...) ~= nil then last = i end end
  local vals = {}
  for i = 1, last do local v = select(i, ...); if v == nil then vals[i] = "<nil>" else vals[i] = v end end
  res[#res + 1] = "[" .. quote(name) .. "," .. enc(vals) .. "]"
end
local function try(name, fn, ...)
  local out = { pcall(fn, ...) }
  if out[1] then put(name, unpack(out, 2, table.maxn(out)))
  else res[#res + 1] = "[" .. quote(name) .. "," .. quote("<error>") .. "]" end
end

local CATS = { "WATER", "TREE", "SHORT_GRASS", "TALL_GRASS", "SAND", "CLIFF", "COAST_CLIFF", "ROCK_DECK",
  "LEDGE", "BUILDING", "DOOR", "SIGN", "PATH", "TOWN_PATH", "PIER", "STAIR", "CAVE", "BLOCKED" }
local CONTEXTS = { { "TOWN", "sevii_outdoor" }, { "ROUTE", "sevii_outdoor" }, { "INDOOR", "house" },
  { false, "network" }, { false, "harbor" }, { "TOWN", "other_pair" } }

local function own_or_tie(cat, votes)
  if not PaletteRules.isLocked(cat) then
    local base, best, nbest = PaletteRules.priority(cat) + 50, -1, 0
    for c, n in pairs(votes) do
      if n > 0 then
        local s = PaletteRules.priority(c) + n * 8
        if s > best then best, nbest = s, 1 elseif s == best then nbest = nbest + 1 end
      end
    end
    if best > base and nbest > 1 then return "<tie>" end
  end
  return PaletteRules.ownCategory(cat, votes)
end

local function slots_or_tie(prof, cat, slots)
  if prof == "network" then
    local counts, twos = {}, 0
    for i = 1, 4 do local s = slots[i] or 5; counts[s] = (counts[s] or 0) + 1 end
    for _, n in pairs(counts) do if n == 2 then twos = twos + 1 end end
    if twos == 2 then return "<tie>" end
  end
  return PaletteRules.cohereMidSlots(prof, cat, slots)
end

-- inputs
local LAYOUT_IDS = { 1, 2, 3, 5, 9, 12, 19, 25, 40, 60, 89, 101, 120, 160 }
local MIDS_PER, REG_W, REG_H = 20, 7, 5
local layouts, inputs = {}, {}
for _, lid in ipairs(LAYOUT_IDS) do
  local off = rom:ptrOffset(rom:u32(Versions.G_MAP_LAYOUTS + (lid - 1) * 4))
  local layout = off and MapTree.parseLayout(rom, off)
  local mapOff = layout and rom:ptrOffset(layout.mapPtr)
  local pairName = mapOff and MapCatalog.pairForLayout(rom, layout)
  local bundle = pairName and Tileset.loadPair(rom, {}, pairName)
  if bundle then
    local L = { id = lid, pair = pairName, mapPals = {}, quads = {}, region = {} }
    local B = { bundle = bundle }
    for p = 0, 15 do
      local src, t = bundle.mapPals[p] or {}, {}
      for c = 0, 15 do t[c + 1] = src[c] or 0 end
      L.mapPals[p + 1] = t
    end
    local function quads_of(mid)
      local buf, palBuf = Metatile.compositeBgr555(bundle, mid)
      local out = {}
      for q = 0, 3 do out[q + 1] = { buf = Metatile.quadrant(buf, q), pal = Metatile.quadrant(palBuf, q) } end
      return out
    end
    local seen, mids = {}, {}
    for cell = 0, layout.width * layout.height - 1 do
      local mid = rom:u16(mapOff + cell * 2) % 1024
      if not seen[mid] and #mids < MIDS_PER then seen[mid] = true; mids[#mids + 1] = mid end
    end
    for _, mid in ipairs(mids) do
      local qs = quads_of(mid)
      for q = 0, 3 do
        L.quads[#L.quads + 1] = { mid = mid, q = q, buf = qs[q + 1].buf, pal = qs[q + 1].pal, cat = CATS[(mid % #CATS) + 1] }
      end
    end
    for cy = 0, math.min(layout.height, REG_H) - 1 do
      for cx = 0, math.min(layout.width, REG_W) - 1 do
        local mid = rom:u16(mapOff + (cy * layout.width + cx) * 2) % 1024
        local qs = quads_of(mid)
        for q = 0, 3 do
          L.region[#L.region + 1] = { buf = qs[q + 1].buf, pal = qs[q + 1].pal, category = CATS[(mid % #CATS) + 1],
            gx = cx * 2 + q % 2, gy = cy * 2 + math.floor(q / 2), mapId = lid, mid = mid, q = q }
        end
      end
    end
    layouts[#layouts + 1] = { L = L, B = B }
    inputs[#inputs + 1] = L
  end
end

-- cases
local function global_cases()
  put("specialPalettes", PaletteRules.specialPalettes())
  local t = {}
  for k, c in ipairs(CATS) do
    t[k] = { PaletteRules.slotFor(c), PaletteRules.rampFor(c), PaletteRules.priority(c), PaletteRules.isLocked(c),
      PaletteRules.isBuildingCategory(c), Quantize.categoryFamily(c), QuantizeLab.terrainFamily(c) or "<nil>" }
  end
  put("cats", t)
  put("slotFor.nil", PaletteRules.slotFor(nil), PaletteRules.slotFor("NOPE"), PaletteRules.rampForSlot(42))
  local u = {}
  for s = 0, 10 do u[#u + 1] = PaletteRules.usesNearestRampBake(s) end
  put("usesNearestRampBake", u)
  put("usesFixedRampQuantize", PaletteRules.usesFixedRampQuantize("network", "screen"),
    PaletteRules.usesFixedRampQuantize("house", "screen"), PaletteRules.usesFixedRampQuantize("network", "wall"))
  local rs = {}
  for _, r in ipairs({ "floor", "wall", "machine", "screen", "furniture_blue", "furniture_wood", "accent", "plant",
    "escalator", "void", "nope" }) do rs[#rs + 1] = PaletteRules.slotForRole(r) end
  put("slotForRole", rs)
  local profs = {}
  for _, c in ipairs({ { nil, nil }, { "sevii_outdoor", "ROUTE" }, { "sevii_outdoor", "TOWN" }, { "sevii_outdoor", "INDOOR" },
    { "network" }, { "house" }, { "harbor" }, { "other" } }) do
    profs[#profs + 1] = PaletteRules.resolveProfile(c[1], c[2]).id
  end
  profs[#profs + 1] = PaletteRules.resolveProfile("sevii_outdoor", "TOWN", { profileId = "harbor" }).id
  profs[#profs + 1] = PaletteRules.resolveProfile("sevii_outdoor", "TOWN", { indoor = true }).id
  put("resolveProfile", profs)
  put("frlgPalToGen2", Quantize.frlgPalToGen2(0), Quantize.frlgPalToGen2(7), Quantize.frlgPalToGen2(12),
    Quantize.frlgPalToGen2("15"), Quantize.frlgPalToGen2(nil), Quantize.frlgPalToGen2(-3), Quantize.frlgPalToGen2(19.7))
  put("solidBlackBpp", QuantizeLab.solidBlackBpp())
  put("primaryCategory", QuantizeLab.primaryCategory({ WATER = 2, SAND = 2, TREE = 1 }),
    QuantizeLab.primaryCategory({}), QuantizeLab.primaryCategory(nil) or "<nil>")
  put("ownCategory.locked", PaletteRules.ownCategory("WATER", { CLIFF = 9 }), PaletteRules.ownCategory(nil, nil))
  put("deltaE_w", QuantizeLab.deltaE_w(50, 10, -5, 40, 2, 3), QuantizeLab.deltaE_w(50, 10, -5, 40, 2, 3, 1))
  put("lab.private", QuantizeLab._rgb_to_lab(255, 128, 0), QuantizeLab._red_ref_cos(3, -4))
end

local function quad_cases(L, Q, i)
  local tag = L.id .. ":" .. i .. ":"
  local buf, pal, cat = Q.buf, Q.pal, Q.cat
  local bpp, ys, shades = Quantize.tileTo2bpp(buf)
  put(tag .. "tileTo2bpp", bpp, ys, shades)
  try(tag .. "tileTo2bppAndRamp", Quantize.tileTo2bppAndRamp, buf)
  local mr, mg, mb = Quantize.meanRgb(buf)
  put(tag .. "meanRgb", mr, mg, mb)
  put(tag .. "rampFromTile", Quantize.rampFromTile(buf, shades))
  put(tag .. "tileHueSpread", Quantize.tileHueSpread(buf))
  local fixed = PaletteRules.RAMP[(Q.mid % 9) + 1]
  put(tag .. "againstRamp", Quantize.tileTo2bppAgainstRamp(buf, fixed))
  put(tag .. "againstGray", Quantize.tileTo2bppAgainstRamp(buf))
  put(tag .. "tileKey", Quantize.tileKey(bpp))
  put(tag .. "bgr555_to_y", Quantize.bgr555_to_y(buf[1]), Quantize.bgr555_to_y(buf[64]))
  local lbpp, lramp, lshades = QuantizeLab.quadTo2bppAndRamp(buf, pal)
  put(tag .. "lab.quadTo2bppAndRamp", lbpp, lramp, lshades)
  put(tag .. "lab.quadTo2bppAndRamp.nopal", QuantizeLab.quadTo2bppAndRamp(buf))
  put(tag .. "lab.isMixedQuad", QuantizeLab.isMixedQuad(pal))
  put(tag .. "lab.rampFromQuad", QuantizeLab.rampFromQuad(buf, pal))
  put(tag .. "lab.majorityPalSlot", QuantizeLab.majorityPalSlot(pal))
  put(tag .. "lab.bufHasExactBlack", QuantizeLab.bufHasExactBlack(buf))
  put(tag .. "lab.againstRamp", QuantizeLab.quadTo2bppAgainstRamp(buf, lramp))
  put(tag .. "lab.bakeQuad", QuantizeLab.bakeQuad(buf, fixed))
  put(tag .. "lab.pixelDeltaE", QuantizeLab.pixelDeltaE(buf[1], buf[64]), QuantizeLab.pixelDeltaE(buf[10], buf[55]))
  put(tag .. "lab.rampDistance", QuantizeLab.rampDistance(lramp, fixed))
  put(tag .. "lab.quadRampError", QuantizeLab.quadRampError(buf, pal, fixed))
  put(tag .. "rules.treeCliff", PaletteRules.quadIsTreeCliffMix(buf, cat))
  put(tag .. "rules.indoorTerrainSlot", PaletteRules.indoorTerrainSlot(mr, mg, mb))
  for ci, c in ipairs(CONTEXTS) do
    local env, pair = c[1] or nil, c[2]
    local slot = PaletteRules.slotForContext(cat, env, pair, mr, mg, mb, Q.q, { bottomIsRoof = Q.q >= 2 })
    local refined = PaletteRules.refineSlot(slot, cat, mr, mg, mb, Q.q, { pairName = pair, environment = env, bottomIsRoof = true })
    put(tag .. "rules.ctx" .. ci, slot, refined,
      PaletteRules.buildingPartSlot(mr, mg, mb, Q.q, { pairName = pair, environment = env, bottomIsRoof = Q.q < 2 }),
      PaletteRules.isRoofColor(mr, mg, mb, pair, env),
      PaletteRules.resolveProfile(pair, env).id)
  end
  for _, prof in ipairs({ "network", "house", "x" }) do
    put(tag .. "rules.role." .. prof, PaletteRules.resolveRole(prof, cat, mr, mg, mb, Q.q))
  end
  local roles, ref, ind = {}, {}, {}
  for k, c2 in ipairs(CATS) do
    roles[k] = PaletteRules.resolveRole("network", c2, mr, mg, mb)
    ref[k] = PaletteRules.refineSlot(5, c2, mr, mg, mb, Q.q, { pairName = "sevii_outdoor", environment = "TOWN" })
    ind[k] = PaletteRules.slotForContext(c2, "INDOOR", "house", mr, mg, mb, Q.q)
  end
  put(tag .. "rules.roleCats", roles)
  put(tag .. "rules.refineCats", ref)
  put(tag .. "rules.indoorCats", ind)
  local votes = {}
  for k = 1, 3 do local c2 = CATS[((Q.mid + k * 5 + i) % #CATS) + 1]; votes[c2] = (votes[c2] or 0) + k end
  put(tag .. "rules.ownCategory", own_or_tie(cat, votes))
  if i <= 8 then
    local labs = {}
    for k = 1, 64 do
      local r, g, b = Quantize.bgr555_to_rgb(buf[k])
      local LL, a, bb = QuantizeLab._rgb_to_lab(r, g, b)
      labs[k] = { L = LL, a = a, b = bb, k = k }
    end
    try(tag .. "sortCentroids", function()
      QuantizeLab._sort_centroids(labs)
      local o = {}
      for k = 1, #labs do o[k] = labs[k].k end
      return o
    end)
  end
  return bpp, lramp, mr, mg, mb
end

local function mid_cases(L, m, quads, info)
  local tag = L.id .. ":m" .. m .. ":"
  local cat = quads[1].cat
  local slots, ramps, idx, roles = {}, {}, {}, {}
  for q = 1, 4 do
    local I = info[q]
    slots[q] = PaletteRules.slotForContext(cat, "TOWN", "sevii_outdoor", I.mr, I.mg, I.mb, q - 1)
    ramps[q] = Quantize.rampFromTile(quads[q].buf, select(3, Quantize.tileTo2bpp(quads[q].buf)))
    if not QuantizeLab.bufHasExactBlack(quads[q].buf) then idx[q] = (QuantizeLab.majorityPalSlot(quads[q].pal)) end
    roles[q] = PaletteRules.resolveRole("network", cat, I.mr, I.mg, I.mb, q - 1)
  end
  put(tag .. "cohereMetatileSlots", Quantize.cohereMetatileSlots(slots, ramps))
  put(tag .. "cohereMetatileSlots.same", Quantize.cohereMetatileSlots({ slots[1], slots[1], slots[1], slots[4] }, ramps))
  put(tag .. "cohereCodebookIndices", Quantize.cohereCodebookIndices(idx))
  put(tag .. "cohereCodebookIndices.3", Quantize.cohereCodebookIndices({ idx[1], idx[1], idx[1], idx[4] }))
  for _, prof in ipairs({ "network", "house" }) do
    for _, c2 in ipairs({ cat, "BUILDING", "STAIR", "TOWN_PATH" }) do
      local r = PaletteRules.cohereMidRoles(prof, c2, roles)
      put(tag .. "cohereMidRoles." .. prof .. "." .. c2, r, PaletteRules.slotsFromRoles(r))
      put(tag .. "cohereMidSlots." .. prof .. "." .. c2, slots_or_tie(prof, c2, slots))
    end
  end
end

local function layout_cases(L, B)
  local tag = L.id .. ":"
  local infos, allYs, bpps, ramps = {}, {}, {}, {}
  for i, Q in ipairs(L.quads) do
    local bpp, lramp, mr, mg, mb = quad_cases(L, Q, i)
    infos[i] = { mr = mr, mg = mg, mb = mb }
    bpps[i], ramps[i] = bpp, lramp
    local _, ys = Quantize.tileTo2bpp(Q.buf)
    for k = 1, 64 do allYs[#allYs + 1] = ys[k] end
  end
  for m = 1, #L.quads / 4 do
    local b = (m - 1) * 4
    mid_cases(L, m, { L.quads[b + 1], L.quads[b + 2], L.quads[b + 3], L.quads[b + 4] },
      { infos[b + 1], infos[b + 2], infos[b + 3], infos[b + 4] })
  end
  local t1, t2, t3 = Quantize.thresholdsFromYs(allYs)
  put(tag .. "thresholdsFromYs", t1, t2, t3)
  put(tag .. "thresholdsFromYs.empty", Quantize.thresholdsFromYs({}))
  local shared = {}
  for i = 1, math.min(16, #L.quads) do shared[i] = (Quantize.tileTo2bpp(L.quads[i].buf, t1, t2, t3)) end
  put(tag .. "tileTo2bpp.shared", shared)
  local fr = {}
  for p = 0, 15 do fr[p + 1] = Quantize.rampFromFrlgPal(B.bundle.mapPals[p]) end
  put(tag .. "rampFromFrlgPal", fr)
  put(tag .. "rampFromFrlgPal.nil", Quantize.rampFromFrlgPal(nil))

  local sheet = Quantize.Sheet()
  local tids = {}
  for i, bpp in ipairs(bpps) do
    if i % 7 == 0 then tids[i] = Quantize.internUnique(sheet, bpp) else tids[i] = Quantize.intern(sheet, bpp) end
  end
  put(tag .. "intern", tids, sheet.count)
  put(tag .. "sheetToRaw", Quantize.sheetToRaw(sheet))
  put(tag .. "sheetToRaw.8", Quantize.sheetToRaw(sheet, 8))
  put(tag .. "sheetToRaw.empty", Quantize.sheetToRaw(Quantize.Sheet()))
  local acc = {}
  for i, r in ipairs(ramps) do acc[i] = Quantize.accumulatePalette(sheet, (i % 12) + 1, r) end
  put(tag .. "accumulatePalette", acc, sheet.palettes, sheet.paletteCounts)
  put(tag .. "finalizePalettes", Quantize.finalizePalettes(sheet))
  local near = {}
  for i = 1, math.min(20, #ramps) do near[i] = Quantize.nearestPaletteSlot(sheet, ramps[i]) end
  put(tag .. "nearestPaletteSlot", near)
  local s2 = Quantize.Sheet()
  local asg = {}
  for i, r in ipairs(ramps) do asg[i] = Quantize.assignPaletteSlot(s2, r) end
  put(tag .. "assignPaletteSlot", asg, s2.palettes, s2.paletteCounts)
  put(tag .. "finalizePalettes.s2", Quantize.finalizePalettes(s2))
  local s3 = Quantize.Sheet()
  Quantize.seedPalettes(s3, ramps)
  put(tag .. "seedPalettes", s3.palettes, s3.paletteCounts)
  try(tag .. "seedPalettes.small", Quantize.seedPalettes, Quantize.Sheet(), { ramps[1], ramps[2], ramps[3] })
  local s3c = Quantize.Sheet()
  Quantize.seedPalettes(s3c, {})
  put(tag .. "seedPalettes.empty", s3c.palettes)
  local groups = {}
  for i, r in ipairs(ramps) do
    local cat = L.quads[i].cat
    local g = { key = string.format("g%03d", i), ramp = r, count = (i % 5) + 1 }
    if i % 2 == 0 then
      g.family = Quantize.categoryFamily(cat)
    else
      local v = {}
      v[cat] = 3
      local o = CATS[(i % #CATS) + 1]
      v[o] = (v[o] or 0) + 1
      g.categoryVotes = v
    end
    groups[i] = g
  end
  local s4 = Quantize.Sheet()
  put(tag .. "mapGroupsToSlots", Quantize.mapGroupsToSlots(s4, groups), s4.palettes, s4.paletteCounts)
  local s5 = Quantize.Sheet()
  put(tag .. "mapGroupsToSlots.empty", Quantize.mapGroupsToSlots(s5, {}), s5.palettes)

  local mquads = {}
  for i, Q in ipairs(L.quads) do mquads[i] = { buf = Q.buf, pal = Q.pal, pair = L.pair, category = Q.cat } end
  local entries = QuantizeLab.discoverMaterialEntries(mquads, { forbidHueSplit = false })
  put(tag .. "discover", entries)
  put(tag .. "discover.noSplit", QuantizeLab.discoverMaterialEntries(mquads, { forbidHueSplit = true }))
  local merged, oldTo = QuantizeLab.mergeRampsToBudget(entries, QuantizeLab.MAX_SLOTS)
  put(tag .. "merge22", merged, oldTo)
  put(tag .. "merge6", QuantizeLab.mergeRampsToBudget(entries, 6))
  put(tag .. "merge4guard", QuantizeLab.mergeRampsToBudget(entries, 4,
    { nearDupeEps = QuantizeLab.OUTDOOR_NEAR_DUPE_EPS, guardTerrainFamilies = true }))
  local locked = {}
  for i, e in ipairs(entries) do locked[i] = { ramp = e.ramp, count = e.count, locked = (i % 4 == 1), categories = e.categories } end
  put(tag .. "merge5locked", QuantizeLab.mergeRampsToBudget(locked, 5))
  put(tag .. "merge.empty", QuantizeLab.mergeRampsToBudget({}, 4))

  local cats = {}
  for mi = 1, #merged do cats[mi] = {} end
  for ei = 1, #entries do
    local mi = oldTo[ei]
    for c, n in pairs(entries[ei].categories or {}) do cats[mi][c] = (cats[mi][c] or 0) + n end
  end
  local codebook, prim = {}, {}
  for mi = 1, #merged do
    codebook[mi] = { ramp = merged[mi], slot = mi, pair = L.pair, frlgSlot = mi % 16, categories = cats[mi],
      primaryCategory = QuantizeLab.primaryCategory(cats[mi]) }
    prim[mi] = codebook[mi].primaryCategory or "<nil>"
  end
  put(tag .. "codebook.primary", prim)
  local bci = {}
  for i = 1, math.min(40, #L.quads) do
    local Q = L.quads[i]
    local opts = {
      preferFrlgSlot = (QuantizeLab.majorityPalSlot(Q.pal)), frlgBias = QuantizeLab.OUTDOOR_FRLG_BIAS,
      itemCategory = Q.cat, crossCatPenalty = QuantizeLab.OUTDOOR_CROSS_CAT_PENALTY,
      preferRamp = PaletteRules.RAMP[PaletteRules.slotFor(Q.cat)], rampBias = QuantizeLab.OUTDOOR_RAMP_BIAS, categoryBias = 10,
    }
    if QuantizeLab.terrainFamily(Q.cat) then opts.requireCategory = Q.cat end
    local _, s1, m1, c1 = QuantizeLab.resolveQuadRamp(Q.buf, Q.pal, codebook, L.pair)
    bci[i] = {
      QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, L.pair),
      QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, L.pair, opts),
      QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, "zzz", opts),
      QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, {}, L.pair),
      s1, m1, c1,
    }
    put(tag .. i .. ":resolveQuadRamp.local", QuantizeLab.resolveQuadRamp(Q.buf, Q.pal, {}, L.pair))
  end
  put(tag .. "bestCodebookIndex", bci)
  local pcf, ehc = {}, {}
  for k, c in ipairs(CATS) do
    pcf[k] = QuantizeLab.primaryCodebookForCategory(codebook, c) or 0
    local row = {}
    for mi = 1, #codebook do row[mi] = QuantizeLab.entryHasCategory(codebook[mi], c) end
    ehc[k] = row
  end
  put(tag .. "primaryCodebookForCategory", pcf, ehc)

  local labels, stats = QuantizeMrf.assignPlacements(L.region, codebook, { enabled = true, pair = L.pair })
  stats.ms = nil
  put(tag .. "mrf", labels, stats)
  local labels2, stats2 = QuantizeMrf.assignPlacements(L.region, codebook, { enabled = false, pair = L.pair })
  stats2.ms = nil
  put(tag .. "mrf.unary", labels2, stats2)
  put(tag .. "mrf.lam", (QuantizeMrf.assignPlacements(L.region, codebook,
    { enabled = true, pair = L.pair, lambda = 400, edgeDe = 60, expansions = 2 })))
  put(tag .. "majorityPerMid", QuantizeMrf.majorityPerMid(L.region, labels))
  put(tag .. "mrf.empty", (QuantizeMrf.assignPlacements({}, codebook)))
end

global_cases()
for _, LB in ipairs(layouts) do layout_cases(LB.L, LB.B) end
io.write('{"inputs":', enc(inputs), ',"results":[', table.concat(res, ","), "]}")
`;

// ---------------------------------------------------------------- the runner

/** The oracle's JSON encoding of a value (Lua table rules: 1..n -> array, else sorted-key object). */
function quoteJ(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 34 || c === 92 || c >= 128) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}
function enc(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return '"<nan>"';
    if (!Number.isFinite(v)) return '"<inf>"';
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return format("%d", v);
    return format("%.17g", v);
  }
  if (typeof v === "string") return quoteJ(v);
  if (typeof v === "function") return quoteJ("<function>");
  const entries: [number | string, unknown][] = [];
  if (Array.isArray(v)) {
    v.forEach((x, i) => { if (x !== undefined && x !== null) entries.push([i + 1, x]); });
  } else {
    for (const k of Object.keys(v as object)) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined && x !== null) entries.push([/^-?\d+$/.test(k) ? Number(k) : k, x]);
    }
  }
  if (entries.length === 0) return "[]";
  let n = 0;
  for (const [k] of entries) if (typeof k === "number" && k >= 1 && Number.isInteger(k) && k > n) n = k;
  if (n === entries.length) {
    const byNum = new Map(entries as [number, unknown][]);
    const parts: string[] = [];
    for (let i = 1; i <= n; i++) parts.push(enc(byNum.get(i)));
    return "[" + parts.join(",") + "]";
  }
  const keyed = entries.map(([k, x]) => [String(k), x] as [string, unknown]);
  luaSort(keyed, (a, b) => a[0] < b[0]);
  return "{" + keyed.map(([k, x]) => quoteJ(k) + ":" + enc(x)).join(",") + "}";
}

interface QuadIn { mid: number; q: number; buf: number[]; pal: number[]; cat: string }
interface LayoutIn { id: number; pair: string; mapPals: number[][]; quads: QuadIn[]; region: Placement[] }

const CATS = ["WATER", "TREE", "SHORT_GRASS", "TALL_GRASS", "SAND", "CLIFF", "COAST_CLIFF", "ROCK_DECK",
  "LEDGE", "BUILDING", "DOOR", "SIGN", "PATH", "TOWN_PATH", "PIER", "STAIR", "CAVE", "BLOCKED"];
const CONTEXTS: [string | undefined, string][] = [["TOWN", "sevii_outdoor"], ["ROUTE", "sevii_outdoor"], ["INDOOR", "house"],
  [undefined, "network"], [undefined, "harbor"], ["TOWN", "other_pair"]];

function runPort(inputs: LayoutIn[]): [string, string][] {
  const res: [string, string][] = [];
  const put = (name: string, ...vals: unknown[]): void => {
    let last = 0;
    vals.forEach((v, i) => { if (v !== undefined && v !== null) last = i + 1; });
    const out = vals.slice(0, last).map((v) => (v === undefined || v === null ? "<nil>" : v));
    res.push([name, enc(out)]);
  };
  const tryv = (name: string, fn: () => unknown[]): void => {
    let vals: unknown[];
    try { vals = fn(); } catch { res.push([name, enc("<error>")]); return; }
    put(name, ...vals);
  };

  const own_or_tie = (cat: string, votes: Record<string, number>): string => {
    if (!PaletteRules.isLocked(cat)) {
      const base = PaletteRules.priority(cat) + 50;
      let best = -1, nbest = 0;
      for (const c of Object.keys(votes)) {
        const n = votes[c]!;
        if (n > 0) {
          const s = PaletteRules.priority(c) + n * 8;
          if (s > best) { best = s; nbest = 1; } else if (s === best) nbest++;
        }
      }
      if (best > base && nbest > 1) return "<tie>";
    }
    return PaletteRules.ownCategory(cat, votes);
  };
  const slots_or_tie = (prof: string, cat: string, slots: (number | undefined)[]): unknown => {
    if (prof === "network") {
      const counts = new Map<number, number>();
      for (let i = 0; i < 4; i++) { const s = slots[i] ?? 5; counts.set(s, (counts.get(s) ?? 0) + 1); }
      let twos = 0;
      for (const n of counts.values()) if (n === 2) twos++;
      if (twos === 2) return "<tie>";
    }
    return PaletteRules.cohereMidSlots(prof, cat, slots);
  };

  // global_cases
  put("specialPalettes", PaletteRules.specialPalettes());
  put("cats", CATS.map((c) => [PaletteRules.slotFor(c), PaletteRules.rampFor(c), PaletteRules.priority(c), PaletteRules.isLocked(c),
    PaletteRules.isBuildingCategory(c), Quantize.categoryFamily(c), QuantizeLab.terrainFamily(c) ?? "<nil>"]));
  put("slotFor.nil", PaletteRules.slotFor(undefined), PaletteRules.slotFor("NOPE"), PaletteRules.rampForSlot(42));
  const u: boolean[] = [];
  for (let s = 0; s <= 10; s++) u.push(PaletteRules.usesNearestRampBake(s));
  put("usesNearestRampBake", u);
  put("usesFixedRampQuantize", PaletteRules.usesFixedRampQuantize("network", "screen"),
    PaletteRules.usesFixedRampQuantize("house", "screen"), PaletteRules.usesFixedRampQuantize("network", "wall"));
  put("slotForRole", ["floor", "wall", "machine", "screen", "furniture_blue", "furniture_wood", "accent", "plant",
    "escalator", "void", "nope"].map((r) => PaletteRules.slotForRole(r)));
  const profs: string[] = ([[undefined, undefined], ["sevii_outdoor", "ROUTE"], ["sevii_outdoor", "TOWN"], ["sevii_outdoor", "INDOOR"],
    ["network"], ["house"], ["harbor"], ["other"]] as (string | undefined)[][]).map((c) => PaletteRules.resolveProfile(c[0], c[1]).id);
  profs.push(PaletteRules.resolveProfile("sevii_outdoor", "TOWN", { profileId: "harbor" }).id);
  profs.push(PaletteRules.resolveProfile("sevii_outdoor", "TOWN", { indoor: true }).id);
  put("resolveProfile", profs);
  put("frlgPalToGen2", Quantize.frlgPalToGen2(0), Quantize.frlgPalToGen2(7), Quantize.frlgPalToGen2(12),
    Quantize.frlgPalToGen2("15"), Quantize.frlgPalToGen2(undefined), Quantize.frlgPalToGen2(-3), Quantize.frlgPalToGen2(19.7));
  put("solidBlackBpp", QuantizeLab.solidBlackBpp());
  put("primaryCategory", QuantizeLab.primaryCategory({ WATER: 2, SAND: 2, TREE: 1 }),
    QuantizeLab.primaryCategory({}), QuantizeLab.primaryCategory(undefined) ?? "<nil>");
  put("ownCategory.locked", PaletteRules.ownCategory("WATER", { CLIFF: 9 }), PaletteRules.ownCategory(undefined, undefined));
  put("deltaE_w", QuantizeLab.deltaE_w(50, 10, -5, 40, 2, 3), QuantizeLab.deltaE_w(50, 10, -5, 40, 2, 3, 1));
  // (a Lua call that is not the last argument is truncated to its first value)
  put("lab.private", QuantizeLab._rgb_to_lab(255, 128, 0)[0], QuantizeLab._red_ref_cos(3, -4));

  for (const L of inputs) {
    const tag = L.id + ":";
    // quad_cases (i is the Lua's 1-based quad index)
    const infos: { mr: number; mg: number; mb: number }[] = [];
    const allYs: number[] = [], bpps: number[][] = [], ramps: Ramp[] = [];
    L.quads.forEach((Q, i0) => {
      const i = i0 + 1;
      const qt = L.id + ":" + i + ":";
      const { buf, pal, cat } = Q;
      const [bpp, ys, shades] = Quantize.tileTo2bpp(buf);
      put(qt + "tileTo2bpp", bpp, ys, shades);
      tryv(qt + "tileTo2bppAndRamp", () => Quantize.tileTo2bppAndRamp(buf));
      const [mr, mg, mb] = Quantize.meanRgb(buf);
      put(qt + "meanRgb", mr, mg, mb);
      put(qt + "rampFromTile", Quantize.rampFromTile(buf, shades));
      put(qt + "tileHueSpread", Quantize.tileHueSpread(buf));
      const fixed = PaletteRules.RAMP[(Q.mid % 9) + 1]!;
      put(qt + "againstRamp", ...Quantize.tileTo2bppAgainstRamp(buf, fixed));
      put(qt + "againstGray", ...Quantize.tileTo2bppAgainstRamp(buf));
      put(qt + "tileKey", Quantize.tileKey(bpp));
      put(qt + "bgr555_to_y", Quantize.bgr555_to_y(buf[0]!), Quantize.bgr555_to_y(buf[63]!));
      const [lbpp, lramp, lshades] = QuantizeLab.quadTo2bppAndRamp(buf, pal);
      put(qt + "lab.quadTo2bppAndRamp", lbpp, lramp, lshades);
      put(qt + "lab.quadTo2bppAndRamp.nopal", ...QuantizeLab.quadTo2bppAndRamp(buf));
      put(qt + "lab.isMixedQuad", QuantizeLab.isMixedQuad(pal));
      put(qt + "lab.rampFromQuad", QuantizeLab.rampFromQuad(buf, pal));
      put(qt + "lab.majorityPalSlot", ...QuantizeLab.majorityPalSlot(pal));
      put(qt + "lab.bufHasExactBlack", QuantizeLab.bufHasExactBlack(buf));
      put(qt + "lab.againstRamp", ...QuantizeLab.quadTo2bppAgainstRamp(buf, lramp));
      put(qt + "lab.bakeQuad", ...QuantizeLab.bakeQuad(buf, fixed));
      put(qt + "lab.pixelDeltaE", QuantizeLab.pixelDeltaE(buf[0]!, buf[63]!), QuantizeLab.pixelDeltaE(buf[9]!, buf[54]!));
      put(qt + "lab.rampDistance", QuantizeLab.rampDistance(lramp, fixed));
      put(qt + "lab.quadRampError", QuantizeLab.quadRampError(buf, pal, fixed));
      put(qt + "rules.treeCliff", PaletteRules.quadIsTreeCliffMix(buf, cat));
      put(qt + "rules.indoorTerrainSlot", PaletteRules.indoorTerrainSlot(mr, mg, mb));
      CONTEXTS.forEach(([env, pair], ci) => {
        const slot = PaletteRules.slotForContext(cat, env, pair, mr, mg, mb, Q.q, { bottomIsRoof: Q.q >= 2 });
        const refined = PaletteRules.refineSlot(slot, cat, mr, mg, mb, Q.q, { pairName: pair, environment: env, bottomIsRoof: true });
        put(qt + "rules.ctx" + (ci + 1), slot, refined,
          PaletteRules.buildingPartSlot(mr, mg, mb, Q.q, { pairName: pair, environment: env, bottomIsRoof: Q.q < 2 }),
          PaletteRules.isRoofColor(mr, mg, mb, pair, env),
          PaletteRules.resolveProfile(pair, env).id);
      });
      for (const prof of ["network", "house", "x"]) put(qt + "rules.role." + prof, PaletteRules.resolveRole(prof, cat, mr, mg, mb, Q.q));
      put(qt + "rules.roleCats", CATS.map((c2) => PaletteRules.resolveRole("network", c2, mr, mg, mb)));
      put(qt + "rules.refineCats", CATS.map((c2) => PaletteRules.refineSlot(5, c2, mr, mg, mb, Q.q, { pairName: "sevii_outdoor", environment: "TOWN" })));
      put(qt + "rules.indoorCats", CATS.map((c2) => PaletteRules.slotForContext(c2, "INDOOR", "house", mr, mg, mb, Q.q)));
      const votes: Record<string, number> = {};
      for (let k = 1; k <= 3; k++) { const c2 = CATS[(Q.mid + k * 5 + i) % CATS.length]!; votes[c2] = (votes[c2] ?? 0) + k; }
      put(qt + "rules.ownCategory", own_or_tie(cat, votes));
      if (i <= 8) {
        const labs: { L: number; a: number; b: number; k: number }[] = [];
        for (let k = 1; k <= 64; k++) {
          const [r, g, b] = Quantize.bgr555_to_rgb(buf[k - 1]!);
          const [LL, a, bb] = QuantizeLab._rgb_to_lab(r, g, b);
          labs.push({ L: LL, a, b: bb, k });
        }
        tryv(qt + "sortCentroids", () => { QuantizeLab._sort_centroids(labs); return [labs.map((x) => x.k)]; });
      }
      infos[i0] = { mr, mg, mb };
      bpps[i0] = bpp; ramps[i0] = lramp;
      const [, ys2] = Quantize.tileTo2bpp(buf);
      for (let k = 0; k < 64; k++) allYs.push(ys2[k]!);
    });

    // mid_cases
    for (let m = 1; m <= L.quads.length / 4; m++) {
      const b = (m - 1) * 4;
      const quads = L.quads.slice(b, b + 4), info = infos.slice(b, b + 4);
      const mt = L.id + ":m" + m + ":";
      const cat = quads[0]!.cat;
      const slots: number[] = [], mramps: Ramp[] = [], idx: (number | undefined)[] = [undefined, undefined, undefined, undefined], roles: string[] = [];
      for (let q = 0; q < 4; q++) {
        const I = info[q]!;
        slots[q] = PaletteRules.slotForContext(cat, "TOWN", "sevii_outdoor", I.mr, I.mg, I.mb, q);
        mramps[q] = Quantize.rampFromTile(quads[q]!.buf, Quantize.tileTo2bpp(quads[q]!.buf)[2]);
        if (!QuantizeLab.bufHasExactBlack(quads[q]!.buf)) idx[q] = QuantizeLab.majorityPalSlot(quads[q]!.pal)[0];
        roles[q] = PaletteRules.resolveRole("network", cat, I.mr, I.mg, I.mb, q);
      }
      put(mt + "cohereMetatileSlots", Quantize.cohereMetatileSlots(slots, mramps));
      put(mt + "cohereMetatileSlots.same", Quantize.cohereMetatileSlots([slots[0], slots[0], slots[0], slots[3]], mramps));
      put(mt + "cohereCodebookIndices", Quantize.cohereCodebookIndices(idx));
      put(mt + "cohereCodebookIndices.3", Quantize.cohereCodebookIndices([idx[0], idx[0], idx[0], idx[3]]));
      for (const prof of ["network", "house"]) {
        for (const c2 of [cat, "BUILDING", "STAIR", "TOWN_PATH"]) {
          const r = PaletteRules.cohereMidRoles(prof, c2, roles);
          put(mt + "cohereMidRoles." + prof + "." + c2, r, PaletteRules.slotsFromRoles(r));
          put(mt + "cohereMidSlots." + prof + "." + c2, slots_or_tie(prof, c2, slots));
        }
      }
    }

    // layout_cases
    const [t1, t2, t3] = Quantize.thresholdsFromYs(allYs);
    put(tag + "thresholdsFromYs", t1, t2, t3);
    put(tag + "thresholdsFromYs.empty", ...Quantize.thresholdsFromYs([]));
    const shared: number[][] = [];
    for (let i = 0; i < Math.min(16, L.quads.length); i++) shared[i] = Quantize.tileTo2bpp(L.quads[i]!.buf, t1, t2, t3)[0];
    put(tag + "tileTo2bpp.shared", shared);
    put(tag + "rampFromFrlgPal", L.mapPals.map((p) => Quantize.rampFromFrlgPal(p)));
    put(tag + "rampFromFrlgPal.nil", Quantize.rampFromFrlgPal(undefined));

    const sheet = Quantize.Sheet();
    const tids = bpps.map((bpp, i0) => ((i0 + 1) % 7 === 0 ? Quantize.internUnique(sheet, bpp) : Quantize.intern(sheet, bpp)));
    put(tag + "intern", tids, sheet.count);
    put(tag + "sheetToRaw", ...Quantize.sheetToRaw(sheet));
    put(tag + "sheetToRaw.8", ...Quantize.sheetToRaw(sheet, 8));
    put(tag + "sheetToRaw.empty", ...Quantize.sheetToRaw(Quantize.Sheet()));
    const acc = ramps.map((r, i0) => Quantize.accumulatePalette(sheet, ((i0 + 1) % 12) + 1, r));
    put(tag + "accumulatePalette", acc, sheet.palettes, sheet.paletteCounts);
    put(tag + "finalizePalettes", Quantize.finalizePalettes(sheet));
    const near: number[] = [];
    for (let i = 0; i < Math.min(20, ramps.length); i++) near[i] = Quantize.nearestPaletteSlot(sheet, ramps[i]!);
    put(tag + "nearestPaletteSlot", near);
    const s2 = Quantize.Sheet();
    const asg = ramps.map((r) => Quantize.assignPaletteSlot(s2, r));
    put(tag + "assignPaletteSlot", asg, s2.palettes, s2.paletteCounts);
    put(tag + "finalizePalettes.s2", Quantize.finalizePalettes(s2));
    const s3 = Quantize.Sheet();
    Quantize.seedPalettes(s3, ramps);
    put(tag + "seedPalettes", s3.palettes, s3.paletteCounts);
    tryv(tag + "seedPalettes.small", () => { Quantize.seedPalettes(Quantize.Sheet(), [ramps[0]!, ramps[1]!, ramps[2]!]); return []; });
    const s3c = Quantize.Sheet();
    Quantize.seedPalettes(s3c, []);
    put(tag + "seedPalettes.empty", s3c.palettes);
    const groups = ramps.map((r, i0) => {
      const i = i0 + 1;
      const cat = L.quads[i0]!.cat;
      const g: { key: string; ramp: Ramp; count: number; family?: string; categoryVotes?: Record<string, number> } =
        { key: format("g%03d", i), ramp: r, count: (i % 5) + 1 };
      if (i % 2 === 0) g.family = Quantize.categoryFamily(cat);
      else {
        const v: Record<string, number> = {};
        v[cat] = 3;
        const o = CATS[i % CATS.length]!;
        v[o] = (v[o] ?? 0) + 1;
        g.categoryVotes = v;
      }
      return g;
    });
    const s4 = Quantize.Sheet();
    put(tag + "mapGroupsToSlots", Quantize.mapGroupsToSlots(s4, groups), s4.palettes, s4.paletteCounts);
    const s5 = Quantize.Sheet();
    put(tag + "mapGroupsToSlots.empty", Quantize.mapGroupsToSlots(s5, []), s5.palettes);

    const mquads = L.quads.map((Q) => ({ buf: Q.buf, pal: Q.pal, pair: L.pair, category: Q.cat }));
    const entries = QuantizeLab.discoverMaterialEntries(mquads, { forbidHueSplit: false });
    put(tag + "discover", entries);
    put(tag + "discover.noSplit", QuantizeLab.discoverMaterialEntries(mquads, { forbidHueSplit: true }));
    const [merged, oldTo] = QuantizeLab.mergeRampsToBudget(entries, QuantizeLab.MAX_SLOTS);
    put(tag + "merge22", merged, oldTo);
    put(tag + "merge6", ...QuantizeLab.mergeRampsToBudget(entries, 6));
    put(tag + "merge4guard", ...QuantizeLab.mergeRampsToBudget(entries, 4,
      { nearDupeEps: QuantizeLab.OUTDOOR_NEAR_DUPE_EPS, guardTerrainFamilies: true }));
    const locked = entries.map((e, i0) => ({ ramp: e.ramp, count: e.count, locked: (i0 + 1) % 4 === 1, categories: e.categories }));
    put(tag + "merge5locked", ...QuantizeLab.mergeRampsToBudget(locked, 5));
    put(tag + "merge.empty", ...QuantizeLab.mergeRampsToBudget([], 4));

    const cats: Record<string, number>[] = merged.map(() => ({}));
    entries.forEach((e, ei) => {
      const mi = oldTo[ei]!;
      for (const c of Object.keys(e.categories ?? {})) cats[mi - 1]![c] = (cats[mi - 1]![c] ?? 0) + e.categories![c]!;
    });
    const codebook: CodebookEntry[] = merged.map((ramp, i0) => ({
      ramp, slot: i0 + 1, pair: L.pair, frlgSlot: (i0 + 1) % 16, categories: cats[i0],
      primaryCategory: QuantizeLab.primaryCategory(cats[i0]),
    }));
    put(tag + "codebook.primary", codebook.map((e) => e.primaryCategory ?? "<nil>"));
    const bci: unknown[] = [];
    for (let i0 = 0; i0 < Math.min(40, L.quads.length); i0++) {
      const Q = L.quads[i0]!;
      const opts: Record<string, any> = {
        preferFrlgSlot: QuantizeLab.majorityPalSlot(Q.pal)[0], frlgBias: QuantizeLab.OUTDOOR_FRLG_BIAS,
        itemCategory: Q.cat, crossCatPenalty: QuantizeLab.OUTDOOR_CROSS_CAT_PENALTY,
        preferRamp: PaletteRules.RAMP[PaletteRules.slotFor(Q.cat)], rampBias: QuantizeLab.OUTDOOR_RAMP_BIAS, categoryBias: 10,
      };
      if (QuantizeLab.terrainFamily(Q.cat)) opts.requireCategory = Q.cat;
      const [, s1, m1, c1] = QuantizeLab.resolveQuadRamp(Q.buf, Q.pal, codebook, L.pair);
      bci[i0] = [
        QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, L.pair),
        QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, L.pair, opts),
        QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, codebook, "zzz", opts),
        QuantizeLab.bestCodebookIndex(Q.buf, Q.pal, [], L.pair),
        s1, m1, c1,
      ];
      put(tag + (i0 + 1) + ":resolveQuadRamp.local", ...QuantizeLab.resolveQuadRamp(Q.buf, Q.pal, [], L.pair));
    }
    put(tag + "bestCodebookIndex", bci);
    put(tag + "primaryCodebookForCategory",
      CATS.map((c) => QuantizeLab.primaryCodebookForCategory(codebook, c) ?? 0),
      CATS.map((c) => codebook.map((e) => QuantizeLab.entryHasCategory(e, c))));

    const [labels, stats] = QuantizeMrf.assignPlacements(L.region, codebook, { enabled: true, pair: L.pair });
    delete stats.ms;
    put(tag + "mrf", labels, stats);
    const [labels2, stats2] = QuantizeMrf.assignPlacements(L.region, codebook, { enabled: false, pair: L.pair });
    delete stats2.ms;
    put(tag + "mrf.unary", labels2, stats2);
    put(tag + "mrf.lam", QuantizeMrf.assignPlacements(L.region, codebook,
      { enabled: true, pair: L.pair, lambda: 400, edgeDe: 60, expansions: 2 })[0]);
    put(tag + "majorityPerMid", QuantizeMrf.majorityPerMid(L.region, labels));
    put(tag + "mrf.empty", QuantizeMrf.assignPlacements([], codebook)[0]);
  }
  return res;
}

describe.skipIf(!ctx || !haveLuajit)("gen3 quantizers vs gen1recomp under luajit", () => {
  test("every case matches the Lua exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gen3-quantize-"));
    const oracle = join(dir, "quantize_oracle.lua");
    writeFileSync(oracle, ORACLE);
    const json = execFileSync("luajit", [oracle, ROM_PATH, ctx!.sha1], {
      cwd: GEN1RECOMP, encoding: "latin1", maxBuffer: 1 << 30,
    });
    const lua = JSON.parse(json) as { inputs: LayoutIn[]; results: [string, unknown][] };
    expect(lua.inputs.length).toBeGreaterThanOrEqual(8);
    const ours = runPort(lua.inputs);
    const bad: string[] = [];
    const n = Math.max(ours.length, lua.results.length);
    for (let i = 0; i < n && bad.length < 12; i++) {
      const l = lua.results[i], o = ours[i];
      if (!l || !o || l[0] !== o[0]) { bad.push(`case ${i}: name ${l?.[0]} vs ${o?.[0]}`); break; }
      const le = enc(l[1]);
      if (le !== o[1]) bad.push(`${o[0]}\n  lua  ${le.slice(0, 400)}\n  port ${o[1].slice(0, 400)}`);
    }
    if (bad.length) console.log(bad.join("\n"));
    const ties = ours.filter(([, e]) => e.includes('"<tie>"')).length;
    const errs = ours.filter(([, e]) => e === '"<error>"').length;
    console.log(`voxel-gen3-quantize: ${ours.length} cases over ${lua.inputs.length} layouts (${ties} pairs()-order ties, ${errs} errors on both sides)`);
    expect(bad).toEqual([]);
    expect(ours.length).toBe(lua.results.length);
  }, 900_000);
});
