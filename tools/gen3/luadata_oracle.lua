-- Port tooling: load a cache data chunk under luajit and print it as
-- canonical JSON (every table an object, keys stringified and sorted,
-- numbers %.17g), for tests/voxel-gen3-luadata.test.ts.
--   luajit tools/gen3/luadata_oracle.lua <file>...   (one JSON line per file)
local function enc(v, out)
  local t = type(v)
  if t == "table" then
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    local strs = {}
    for i, k in ipairs(keys) do
      strs[i] = type(k) == "number" and string.format("%.17g", k) or tostring(k)
    end
    local idx = {}
    for i = 1, #keys do idx[i] = i end
    table.sort(idx, function(a, b) return strs[a] < strs[b] end)
    -- a key held both as a number and as its string (5 and "5") is ONE key in
    -- the JS port: merge such pairs when their values encode the same, and
    -- mark them when they do not
    out[#out + 1] = "{"
    local prevKey, prevVal, n = nil, nil, 0
    for _, i in ipairs(idx) do
      local sub = {}
      enc(v[keys[i]], sub)
      local val = table.concat(sub)
      if strs[i] == prevKey then
        if val ~= prevVal then out[#out + 1] = ',"COLLISION":true' end
      else
        n = n + 1
        if n > 1 then out[#out + 1] = "," end
        out[#out + 1] = string.format("%q", strs[i]):gsub("\\\n", "\\n")
        out[#out + 1] = ":"
        out[#out + 1] = val
      end
      prevKey, prevVal = strs[i], val
    end
    out[#out + 1] = "}"
  elseif t == "string" then
    local s = v:gsub('[%c"\\\128-\255]', function(c) return string.format("\\u%04x", c:byte()) end)
    out[#out + 1] = '"' .. s .. '"'
  elseif t == "number" then
    if v ~= v then out[#out + 1] = '"nan"'
    elseif v == math.huge then out[#out + 1] = '"inf"'
    elseif v == -math.huge then out[#out + 1] = '"-inf"'
    else out[#out + 1] = string.format("%.17g", v) end
  elseif t == "boolean" then
    out[#out + 1] = tostring(v)
  else
    out[#out + 1] = "null"
  end
end
for _, path in ipairs(arg) do
  local f = assert(io.open(path, "rb"))
  local src = f:read("*a")
  f:close()
  local chunk, err = load(src, "@" .. path, "t", {})
  if not chunk then
    io.write('{"error":"load"}\n')
  else
    local ok, v = pcall(chunk)
    local out = {}
    if ok then enc(v, out) else out = { '{"error":"run"}' } end
    io.write(table.concat(out), "\n")
  end
end
