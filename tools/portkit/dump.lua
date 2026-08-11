-- Load a gen1recomp script table and emit JSON.
-- Functions can't serialize; they're marked so we can see what needs hands.
local function esc(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"')
  s = s:gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t')
  return s
end

local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end

local enc
enc = function(v, depth)
  local t = type(v)
  if t == "string" then return '"' .. esc(v) .. '"' end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t == "nil" then return "null" end
  if t == "function" then return '"__FUNCTION__"' end
  if t == "table" then
    if depth > 12 then return '"__DEEP__"' end
    local out = {}
    if isArray(v) then
      for _, x in ipairs(v) do out[#out+1] = enc(x, depth+1) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys+1] = tostring(k) end
    table.sort(keys)
    for _, k in ipairs(keys) do
      out[#out+1] = '"' .. esc(k) .. '":' .. enc(v[k], depth+1)
    end
    return "{" .. table.concat(out, ",") .. "}"
  end
  return '"__' .. t .. '__"'
end

local path = arg[1]
local chunk, err = loadfile(path)
if not chunk then print('{"error":"' .. esc(tostring(err)) .. '"}') os.exit(0) end
local ok, res = pcall(chunk)
if not ok then print('{"error":"' .. esc(tostring(res)) .. '"}') os.exit(0) end
if type(res) ~= "table" then print('{"error":"no table returned"}') os.exit(0) end
print(enc(res, 0))
