-- Port tooling: Lua pattern results under luajit for tests/voxel-gen3-lpattern.test.ts.
-- Reads cases (one per line: fn \t pattern \t subject \t extra, %-escaped
-- bytes) on stdin, prints one result line per case.
local function unesc(s) return (s:gsub("\\x(%x%x)", function(h) return string.char(tonumber(h, 16)) end)) end
local function esc(v)
  if type(v) == "string" then
    return "s" .. v:gsub("[%c\\\128-\255]", function(c) return string.format("\\x%02x", c:byte()) end)
  end
  return type(v):sub(1, 1) .. tostring(v)
end
local function pack(...) return { n = select("#", ...), ... } end
for line in io.lines() do
  local fn, pat, subj, extra = line:match("^(%a+)\t(.-)\t(.-)\t(.*)$")
  pat, subj = unesc(pat), unesc(subj)
  local ok, r = pcall(function()
    if fn == "find" then return pack(subj:find(pat, tonumber(extra) or 1))
    elseif fn == "match" then return pack(subj:match(pat))
    elseif fn == "gmatch" then
      local out = {}
      for a, b, c in subj:gmatch(pat) do out[#out + 1] = esc(a) .. "|" .. esc(b) .. "|" .. esc(c) end
      return pack(table.concat(out, ";"))
    elseif fn == "gsub" then return pack(subj:gsub(pat, unesc(extra)))
    end
  end)
  if not ok then io.write("ERR\n")
  else
    local parts = {}
    for i = 1, r.n do parts[i] = esc(r[i]) end
    io.write(table.concat(parts, ","), "\n")
  end
end
