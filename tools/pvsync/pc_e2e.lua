-- Test tool, not shipped: the PC mod itself (its SYNC screen, inside the
-- game's real save code, headless) against pocket-voxel's Rust peer. Run from
-- a gen1recomp checkout's root with the mod copied to mods/pvsync, by
-- tools/pvsync/pc_e2e.sh, which also starts the Rust side:
--
--   luajit pc_e2e.lua get   <game> <expectName> <expectStatus>
--       the PC pulls the Rust peer's save (A, A on GET <name>); the status
--       must contain <expectStatus>; on GOT, the PC's active slot must hold it
--   luajit pc_e2e.lua serve <game> <seconds>
--       the PC holds a save of its own and keeps SYNC open for the Rust peer
--       to pull
package.path = "./?.lua;./?/init.lua;" .. package.path
love = love or require("tests.love_stub")
local T = require("tests.modkit")
local socket = require("socket")
local SaveData = require("src.core.SaveData")
local GameVersion = require("src.core.GameVersion")

local mode, game = arg[1], arg[2]
local files = {}
love.filesystem = {
  write = function(p, c) files[p] = c return true end,
  read = function(p) return files[p] end,
  remove = function(p) files[p] = nil return true end,
  getInfo = function(p) return files[p] and { type = "file" } or nil end,
}
SaveData.resetSlotState()
GameVersion.set(game)

local function pcSave(name)
  return { version = game, player = { name = name, map = "PALLET_TOWN", x = 5, y = 6 },
           pokedex = { seen = {}, owned = {} }, inventory = {}, money = 777, playTime = 60 }
end
local slot = SaveData.createSlot(game)
SaveData.setActiveSlot(game, slot)
assert(SaveData.writeSlot(game, slot, pcSave("PCSIDE")))

local data = { screens = {} }
local run = T.sdk.loadMod("mods/pvsync", { generation = 1, data = data })
T.eq(#run.errors, 0, "the mod loads: " .. tostring(run.errors[1]))
local pressA = false
local stack = { states = {} }
function stack:push(s) self.states[#self.states + 1] = s end
function stack:pop() return table.remove(self.states) end
function stack:top() return self.states[#self.states] end
local input = setmetatable({}, { __index = function(_, k)
  if k == "wasPressed" then return function(_, b) return b == "a" and pressA end end
  return function() return false end
end })
local g = { stack = stack, input = input, data = data }
local Runtime = require("src.mods.Runtime")
local rows = Runtime.call("ui.title_menu.items", function(_, i) return i end, g,
  { { label = "NEW GAME" }, { label = "EXIT GAME" } })
rows[2].onSelect()
local screen = stack:top()
T.check(screen and screen.items, "SYNC open on the PC")

local function rowIndex(prefix)
  for i, it in ipairs(screen.items) do
    if it.label:sub(1, #prefix) == prefix then return i end
  end
end
local function pump(seconds, cond)
  local t0 = socket.gettime()
  while socket.gettime() - t0 < seconds do
    screen:update(0.016); pressA = false
    if cond and cond() then return true end
    socket.sleep(0.016)
  end
  return false
end

if mode == "get" then
  local name, want = arg[3], arg[4]
  T.check(pump(6, function() return rowIndex("GET " .. name) end), "the 3DS listed as GET " .. name)
  for _, it in ipairs(screen.items) do print("row: " .. it.label .. (it.right and ("  " .. it.right) or "")) end
  screen.index = rowIndex("GET " .. name)
  pressA = true; screen:update(0.016); pressA = false
  screen.index = rowIndex("GET " .. name)
  pressA = true; screen:update(0.016); pressA = false
  pump(10, function() local f = screen.footer or "" return f:find("GOT") or f:find("REFUSED") or f:find("ERROR") end)
  print("status: " .. tostring(screen.footer))
  T.check((screen.footer or ""):find(want, 1, true), "status has '" .. want .. "': " .. tostring(screen.footer))
  local now = SaveData.decode(SaveData.readSlotSource(game, SaveData.activeSlot(game)))
  if want:find("GOT") then
    T.eq(now.player.name, name, "the PC's slot now holds the 3DS save")
    T.eq(now.version, game, "and it is a " .. game .. " save")
  else
    T.eq(now.player.name, "PCSIDE", "a refused save leaves the PC's slot alone")
  end
elseif mode == "serve" then
  pump(tonumber(arg[3] or "10"))
  T.check(true, "served for " .. tostring(arg[3]) .. " s")
end
input.wasPressed = function(_, b) return b == "b" end
screen:update(0.016)
run.release()
T.finish("pc e2e " .. mode .. " " .. game)
