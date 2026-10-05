-- Port tooling for gen1recomp's FireRed engine (GPLv3 + additional terms;
-- see voxelmon/import/gen3/LICENSE.md). The oracle for the TypeScript port of
-- src/core/game3/scripting/text_ir.lua: runs gen1recomp's own text_ir over
-- every ROM string the importers decode (Versions.NAMED_TEXTS,
-- NAMED_BATTLE_TEXTS, TEXT_TABLES, gStdStringPtrs, the species / move /
-- ability / trainer class / item name tables) plus synthetic inputs, through
-- every public function, and prints the inputs and results as JSON.
-- tests/voxel-gen3-import-text.test.ts runs the same cases on the port.
--
--   cd ~/gen1recomp-latest
--   luajit /home/isaac/pocket-voxel/tools/gen3/text_ir_oracle.lua ROM SHA1 > out.json
--
-- Nothing ROM-derived is stored: the test runs this at test time.
-- KEEP IN STEP with the runner in the test (same cases, same order).
package.path = "./?.lua;./?/init.lua;" .. package.path
local ROM, SHA1 = arg[1], arg[2]
assert(ROM and SHA1, "usage: text_ir_oracle.lua ROM SHA1")

-- frlg_font: the wrapper pcall-requires it. FAKE_FONT selects a stand-in
-- with a fixed measure; otherwise the require fails (the 6px fallback).
local FONT = "src.ui.game3.frlg_font"
local FAKE_FONT = false
local FakeFont = {
  measure = function(str)
    local w = 0
    for i = 1, #str do w = w + (str:byte(i) * 7) % 5 + 3 end
    return w
  end,
}
package.preload[FONT] = function()
  if FAKE_FONT then return FakeFont end
  error("frlg_font unavailable in the oracle")
end
local function setFont(on)
  FAKE_FONT = on
  package.loaded[FONT] = nil
end

local GameVersion = require("src.core.GameVersion")
GameVersion.set("firered")
local TextIR = require("src.core.game3.scripting.text_ir")
local RevisionView = require("src.import.gba.revision_view")
local Versions = require("src.import.gba.versions")
Versions.select(SHA1)

local f = assert(io.open(ROM, "rb"))
local data = RevisionView.apply(f:read("*a"), SHA1)
f:close()
local function get(off) return data:byte(off + 1) or 0 end
local function u32(off) return get(off) + get(off + 1) * 256 + get(off + 2) * 65536 + get(off + 3) * 16777216 end
local function ptrOffset(ptr)
  if ptr >= 0x08000000 and ptr < 0x08000000 + #data then return ptr - 0x08000000 end
  return nil
end

-- ------------------------------------------------------------------ JSON
local function quote(s)
  return '"' .. s:gsub('[%c"\\\128-\255]', function(c)
    return string.format("\\u%04x", c:byte())
  end) .. '"'
end
local enc
enc = function(v)
  local t = type(v)
  if t == "nil" then return "null"
  elseif t == "boolean" then return tostring(v)
  elseif t == "number" then
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
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local byStr = {}
    for k, val in pairs(v) do byStr[tostring(k)] = val end
    for i, k in ipairs(keys) do parts[i] = quote(k) .. ":" .. enc(byStr[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return quote("<" .. t .. ">")
end

local function hex(bytes)
  local t = {}
  for i = 1, #bytes do t[i] = string.format("%02x", bytes[i]) end
  return table.concat(t)
end
local function tostr(bytes)
  local t = {}
  for i = 1, #bytes do t[i] = string.char(bytes[i]) end
  return table.concat(t)
end

-- one result: { name, value } or { name, nil, err }
local function try(res, name, fn, ...)
  local out = { pcall(fn, ...) }
  if out[1] then
    local vals = {}
    for i = 2, table.maxn(out) do vals[i - 1] = out[i] == nil and "<nil>" or out[i] end
    res[#res + 1] = { name, vals }
  else
    res[#res + 1] = { name, "<error>", tostring(out[2]) }
  end
end

local function deepEq(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= "table" then return a == b end
  for k, v in pairs(a) do if not deepEq(v, b[k]) then return false end end
  for k in pairs(b) do if a[k] == nil then return false end end
  return true
end

-- ------------------------------------------------------------------ contexts
local BATTLE = {}
for code = 0, 0x34 do BATTLE[code] = "B" .. code end
local PLACEHOLDERS = {
  KUN = "kun", VERSION = "FR", UNKNOWN = "", MAGMA = "MAG", AQUA = "AQ%",
  byGender = { RIVAL = { male = "RM", female = "RF" }, KUN = { male = "KM", female = "KF" } },
}
local function ctxA(extra)
  local c = {
    playerName = "RED\195\169", rivalName = "BLUE",
    stringVars = { [1] = "ONE", [2] = "12", [3] = "TH%REE" },
    dynamic = { [0] = "D0", [1] = "D1", [2] = "D2" },
    battle = BATTLE,
  }
  for k, v in pairs(extra or {}) do c[k] = v end
  return c
end
local function provider(kind, d, ctx)
  if kind == "playerName" then return "PROV" end
  if kind == "gender" then return "female" end
  if kind == "stringVars" then return { [1] = 7, [2] = "x" } end
  if kind == "placeholders" then return PLACEHOLDERS end
  return nil
end

local SRC_OPTS = {
  { named = true, digits = true, trim = true, para = "\f", nl = "\n", scroll = "\\l" },
  { trim = true },
  { digits = true, para = "", trim = true },
  { named = true, scroll = "\\l", trim = true },
}

-- ------------------------------------------------------------------ runners
local function runIr(res, ir)
  -- provider unset
  TextIR.setContextProvider(nil)
  setFont(false)
  try(res, "plain", TextIR.toPlain, ir, nil)
  try(res, "ascii", TextIR.toAscii, ir, nil)
  try(res, "src", TextIR.toSource, ir, nil)
  try(res, "tb", TextIR.toTextBox, ir, nil)
  local pages, idx, kind = {}, 1, nil
  local ok, err = pcall(function()
    repeat
      local page
      page, idx, kind = TextIR.expandPage(ir, idx, nil)
      pages[#pages + 1] = { page, idx - 1, kind }
    until kind == "eos" or not kind or #pages > 500
  end)
  res[#res + 1] = { "pages", ok and pages or "<error>", not ok and tostring(err) or nil }
  try(res, "plainA", TextIR.toPlain, ir, ctxA())
  for i, o in ipairs(SRC_OPTS) do try(res, "srcA" .. i, TextIR.toSource, ir, ctxA(), o) end
  try(res, "asciiA", TextIR.toAscii, ir, ctxA())
  setFont(true)
  try(res, "tbFont", TextIR.toTextBox, ir, ctxA({ maxWidth = 150 }))
  try(res, "tbFont208", TextIR.toTextBox, ir, ctxA())
  setFont(false)
  try(res, "tbA60", TextIR.toTextBox, ir, ctxA({ maxWidth = 60 }))
  -- provider set
  TextIR.setContextProvider(provider)
  try(res, "plainP", TextIR.toPlain, ir, {})
  try(res, "tbP", TextIR.toTextBox, ir, {})
  try(res, "plainPrse", TextIR.toPlain, ir, { dialect = "rse" })
  try(res, "asciiPrse", TextIR.toAscii, ir, { dialect = "rse", playerGender = "F" })
  TextIR.setContextProvider(nil)
  try(res, "plainPh", TextIR.toPlain, ir, { dialect = "rse", placeholders = PLACEHOLDERS, playerGender = 0 })
  -- string helpers over the text-box string
  local okTb, tb = pcall(TextIR.toTextBox, ir, ctxA())
  if okTb then
    try(res, "split", TextIR.splitPages, tb)
    try(res, "splitKeep", TextIR.splitPages, tb, true)
    try(res, "prot", TextIR.protectExt, tb)
    try(res, "rest", TextIR.restoreExt, TextIR.protectExt(tb))
  end
  local okA, ascii = pcall(TextIR.toAscii, ir, nil)
  if okA then
    try(res, "back", TextIR.fromAscii, ascii)
    try(res, "backRse", TextIR.fromAscii, ascii, { dialect = "rse" })
  end
end

local function runBytes(bytes, battle)
  local res = {}
  local opts = battle and { battle = true } or nil
  local ir = TextIR.decode(bytes, opts)
  res[#res + 1] = { "ir", ir }
  res[#res + 1] = { "irStrSame", deepEq(ir, TextIR.decode(tostr(bytes), opts)) }
  local irRse = TextIR.decode(bytes, { dialect = "rse", battle = battle or nil })
  res[#res + 1] = { "irRse", irRse }
  res[#res + 1] = { "irFrlgNamed", TextIR.decode(bytes, { dialect = "frlg" }) }
  runIr(res, ir)
  TextIR.setContextProvider(nil)
  try(res, "plainRse", TextIR.toPlain, irRse, { dialect = "rse", placeholders = PLACEHOLDERS, battle = BATTLE })
  return res
end

local function runAscii(s)
  local res = {}
  local ir = TextIR.fromAscii(s)
  res[#res + 1] = { "ir", ir }
  res[#res + 1] = { "irRse", TextIR.fromAscii(s, { dialect = "rse" }) }
  runIr(res, ir)
  try(res, "protRaw", TextIR.protectExt, s)
  try(res, "restRaw", TextIR.restoreExt, s)
  try(res, "splitRaw", TextIR.splitPages, s)
  try(res, "splitRawKeep", TextIR.splitPages, s, true)
  return res
end

-- ------------------------------------------------------------------ cases
local out = {}
local function emit(case) out[#out + 1] = enc(case) end

local function readTerminated(off, max)
  local bytes = {}
  for i = 0, (max or 1024) - 1 do
    local b = get(off + i)
    bytes[#bytes + 1] = b
    if b == 0xFF then break end
  end
  return bytes
end
local function readFixed(off, n)
  local bytes = {}
  for i = 0, n - 1 do bytes[#bytes + 1] = get(off + i) end
  return bytes
end
local function romCase(label, bytes, battle)
  emit({ op = "bytes", label = label, hex = hex(bytes), battle = battle or false, res = runBytes(bytes, battle) })
end

local function sortedPairs(t)
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys)
  local i = 0
  return function() i = i + 1; local k = keys[i]; if k ~= nil then return k, t[k] end end
end

for name, off in sortedPairs(Versions.NAMED_TEXTS) do romCase("named:" .. name, readTerminated(off)) end
for name, off in sortedPairs(Versions.NAMED_BATTLE_TEXTS) do romCase("battle:" .. name, readTerminated(off), true) end
for _, t in ipairs(Versions.TEXT_TABLES) do
  for i = 0, t.count * (t.inner or 1) - 1 do
    local label = t.name .. "[" .. i .. "]"
    if t.inline then
      romCase(label, readTerminated(t.addr + i * t.stride))
    else
      local off = ptrOffset(u32(t.addr + i * t.stride))
      if off then romCase(label, readTerminated(off), t.battle) end
    end
  end
end
for i = 0, Versions.STD_STRING_COUNT - 1 do
  local off = ptrOffset(u32(Versions.STD_STRING_PTRS + i * 4))
  if off then romCase("stdstring:" .. i, readTerminated(off)) end
end
for i = 0, 411 do romCase("species:" .. i, readFixed(Versions.SPECIES_NAMES + i * 11, 11)) end
for i = 0, 354 do romCase("move:" .. i, readFixed(Versions.MOVE_NAMES + i * 13, 13)) end
for i = 0, 77 do romCase("ability:" .. i, readFixed(Versions.ABILITY_NAMES + i * 13, 13)) end
for i = 0, 106 do romCase("tclass:" .. i, readFixed(Versions.TRAINER_CLASS_NAMES + i * 13, 13)) end
for i = 0, 374 do romCase("item:" .. i, readFixed(Versions.ITEMS + i * 44, 14)) end

-- synthetic byte strings
local function synth(label, bytes, battle)
  emit({ op = "bytes", label = label, hex = hex(bytes), battle = battle or false, res = runBytes(bytes, battle) })
end
for b = 0, 255 do
  synth("one:" .. b, { b, 0xBB, 0xFF })
  synth("bare:" .. b, { b })
end
for _, lead in ipairs({ 0xF7, 0xF8, 0xF9, 0xFC, 0xFD, 0x53 }) do
  for x = 0, 255 do
    synth(string.format("pair:%02x:%02x", lead, x), { lead, x, 0x01, 0x02, 0x03, 0xD5, 0xFF })
    if lead == 0xFD then synth(string.format("bph:%02x", x), { 0xD5, lead, x, 0xFE, 0xFF }, true) end
  end
end
for _, run in ipairs({
  { 0x55, 0x56, 0x57, 0x58, 0x59, 0xFF }, { 0x55, 0x56, 0xFF }, { 0x56, 0x57, 0xBB }, { 0x34, 0xA2 },
  { 0x77, 0x79, 0x7A, 0x7B, 0x7C }, { 0x53, 0x54, 0x53, 0x00, 0x54 }, { 0x53 }, { 0xFC }, { 0xFC, 0x04, 1 },
  { 0xFD }, { 0xF9 }, { 0xFE, 0xFA, 0xFB, 0xFE, 0xFE, 0xFB, 0xFF }, { 0xBB, 0xFB, 0xFE, 0xFE },
  { 0xFC, 0x06, 0x04, 0xBB, 0xFC, 0x06, 0x09, 0xFC, 0x06, 0x02, 0xBC },
}) do synth("run:" .. hex(run), run) end
-- pseudo-random strings (an LCG; the test sees the bytes, not the generator)
local seed = 12345
local function rnd(n)
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
end
local POOL = { 0x00, 0xBB, 0xD5, 0xE8, 0xA1, 0xAB, 0xB0, 0x1B, 0x5B, 0xFE, 0xFA, 0xFB, 0xFD, 0xFC, 0xF7, 0xF8,
  0xF9, 0x53, 0x54, 0x55, 0x34, 0x77, 0xB4, 0xF0, 0xEF }
for k = 1, 1500 do
  local bytes, len = {}, 1 + rnd(48)
  for i = 1, len do
    if rnd(3) == 0 then bytes[i] = rnd(256) else bytes[i] = POOL[1 + rnd(#POOL)] end
  end
  if rnd(2) == 0 then bytes[#bytes + 1] = 0xFF end
  synth("rand:" .. k, bytes, rnd(5) == 0)
end

-- synthetic ASCII sources (fromAscii and the runtime helpers)
local ASCII = {
  "", "plain", "{PLAYER} met {RIVAL}.\\n{STR_VAR_1} {STR_VAR_2} {STR_VAR_3}\\p", "{B_BUFF1} {B_TRAINER2_CLASS} {B_BUFF3}",
  "{PK}{MN}{PKMN} {A_BUTTON} {EMOJI_HEART} {LV} {POKEBLOCK} {UP_ARROW}", "{COLOR RED}{SHADOW X}{HIGHLIGHT}{BG 1}{FONT_MALE}x{FONT_NORMAL}",
  "{constructor} {__proto__} {toString} {hasOwnProperty} {KUN} {VERSION} {UNKNOWN} {MAGMA} {AQUA}",
  "{unterminated", "a}b{c", "{\252\004abc}", "x\252\004\001\002\003{PLAYER}y", "\252\001", "\252",
  "line1\nline2\nline3\nline4\fpage2\r\nmore\\lscroll\\ffeed\\x\\\\", "\\n\\p\\l", "\\", "100% sure %d %s %%",
  "123", "{STR_VAR_2}", "A very long line with many words that will surely need wrapping somewhere along the way ok",
  "Supercalifragilisticexpialidocious_word_without_spaces_at_all_and_more_and_more_and_more",
  "short\\pnext page here\\pand a third one that is longer than the others by far, really",
  "tabs\tand\vvertical\fforms", "utf8 \195\169 \226\128\166 \194\160nbsp\194\160here and \195\160 there with spaces",
  "\255AB\254 \255ABC\254 \255zz\254 \255\254 \252\004\255\254x", "\252\012a\012b\012\012c", "\012\012",
  "{PLAYER}: {B_PLAYER_NAME} {B_26} {B_PARTNER_NAME}", "p\\p\n\n\n", "x\\p\n", "{RIVAL}{RIVAL}{PLAYER}",
}
for i, s in ipairs(ASCII) do emit({ op = "ascii", label = "ascii:" .. i, s = s, res = runAscii(s) }) end

-- expandSeg, dialects, constants
local misc = {}
local SEGS = {
  { t = "ph", code = 5 }, { t = "ph", code = 7, name = "VERSION" }, { t = "ph", name = "STR_VAR_2" },
  { t = "ph", name = "COLOR_X" }, { t = "ph", code = "6" }, { t = "ph", code = 3 }, { t = "ph", name = "KUN" },
  { t = "ph", name = "RIVAL" }, { t = "ph", name = "AQUA" }, { t = "ph" }, { t = "dynamic", n = 3 },
  { t = "dynamic", n = 1 }, { t = "unknown" }, { t = "bph", code = 0x99 }, { t = "bph", code = 0x31 },
  { t = "bph", code = 2 }, { t = "strvar", n = 2 }, { t = "tag", tag = "{X}" }, { t = "text", s = "t" },
}
local CTXS = {
  function() return nil end,
  function() return ctxA() end,
  function() return { dialect = "rse" } end,
  function() return { dialect = "rse", placeholders = PLACEHOLDERS, playerGender = "girl" } end,
  function() return { placeholders = PLACEHOLDERS, playerGender = 1, dynamic = false, battle = false } end,
}
for pi, prov in ipairs({ false, true }) do
  TextIR.setContextProvider(prov and provider or nil)
  for si, seg in ipairs(SEGS) do
    for ci, mk in ipairs(CTXS) do try(misc, "seg" .. pi .. ":" .. si .. ":" .. ci, TextIR.expandSeg, seg, mk()) end
  end
end
TextIR.setContextProvider(nil)
try(misc, "dialectOf:firered", TextIR.dialectOf, "firered")
try(misc, "dialectOf:leafgreen", TextIR.dialectOf, "leafgreen")
try(misc, "dialectOf:nil", TextIR.dialectOf, nil)
misc[#misc + 1] = { "dialect:rse", TextIR.dialect("rse").name }
misc[#misc + 1] = { "dialect:nope", TextIR.dialect("nope").name }
misc[#misc + 1] = { "dialect:nil", TextIR.dialect(nil).name }
misc[#misc + 1] = { "dialect:table", TextIR.dialect({ name = "custom" }).name }
misc[#misc + 1] = { "DEFAULT_DIALECT", TextIR.DEFAULT_DIALECT }
for _, k in ipairs({ "CHARMAP", "CTRL", "PH", "EXTRA_SYMBOL", "B_TXT", "B_TXT_CODE", "KEYGFX", "LIGATURE", "EXT_ARGS", "TAG_NAMES" }) do
  misc[#misc + 1] = { k, TextIR[k] }
end
for _, d in ipairs({ "frlg", "rse" }) do misc[#misc + 1] = { "DIALECTS." .. d, TextIR.DIALECTS[d] } end
emit({ op = "misc", label = "misc", res = misc })

io.write("[\n", table.concat(out, ",\n"), "\n]\n")
