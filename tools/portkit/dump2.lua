-- Same as dump.lua, but stubs engine modules so scripts that `require`
-- Commands/etc. still load. Stubbed calls return no-op functions, so any
-- imperative body serializes as __FUNCTION__ (hand-port marker).
local root = arg[2] or "."
package.path = root .. "/?.lua;" .. root .. "/src/?.lua;" ..
               root .. "/data/?.lua;" .. package.path

local fake = setmetatable({}, {
  __index = function() return function() end end,
  __call = function() return function() end end,
})
local real = require
_G.require = function(n)
  local ok, m = pcall(real, n)
  if ok then return m end
  return fake
end

local function esc(s)
  s = s:gsub('\\','\\\\'):gsub('"','\\"')
  return (s:gsub('\n','\\n'):gsub('\r','\\r'):gsub('\t','\\t'))
end
local function isArr(t)
  local n = 0
  for k in pairs(t) do if type(k) ~= "number" then return false end n = n + 1 end
  return n == #t
end
local enc
enc = function(v, d)
  local t = type(v)
  if t == "string" then return '"'..esc(v)..'"' end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t == "function" then return '"__FUNCTION__"' end
  if t == "table" then
    if d > 12 then return '"__DEEP__"' end
    local o = {}
    if isArr(v) then
      for _, x in ipairs(v) do o[#o+1] = enc(x, d+1) end
      return "["..table.concat(o, ",").."]"
    end
    local ks = {}
    for k in pairs(v) do ks[#ks+1] = tostring(k) end
    table.sort(ks)
    for _, k in ipairs(ks) do o[#o+1] = '"'..esc(k)..'":'..enc(v[k], d+1) end
    return "{"..table.concat(o, ",").."}"
  end
  return "null"
end

local chunk, err = loadfile(arg[1])
if not chunk then print('{"error":"'..esc(tostring(err))..'"}') os.exit(0) end
local ok, res = pcall(chunk)
if not ok then print('{"error":"'..esc(tostring(res))..'"}') os.exit(0) end
if type(res) ~= "table" then print('{"error":"not a table"}') os.exit(0) end
print(enc(res, 0))
