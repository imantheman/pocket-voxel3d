-- Prints LuaJIT's own answers for the formatting cases tests/voxel-gen3-lua.test.ts
-- checks import/gen3/lua.ts against (one JSON array per line: [fmt, args..., result]).
local function q(s)
  return '"' .. s:gsub('[%z\1-\31\\"\127-\255]', function(c)
    if c == "\\" then return "\\\\" elseif c == '"' then return '\\"' end
    return string.format("\\u%04x", c:byte())
  end) .. '"'
end
local nums = { 0, 1, -1, 7, 10, 255, 256, 65535, 65536, 2^31, 2^32, 2^53, -2^31, 0.5, 1.5, 2.5, -0.5, 0.1, 1/3, 2/3, 123.456,
  1e15, 1e16, 1e17, 1e21, 1e-5, 1e-4, 123456789012345, 3.14159265358979, -0.0, 1e100, 5e-324, 0.000123456, 99.995, 1.005 }
local function emit(fmt, v)
  local ok, res = pcall(string.format, fmt, v)
  io.write("[", q(fmt), ",", type(v) == "string" and q(v) or string.format("%.17g", v), ",", ok and q(res) or "null", "]\n")
end
for _, fmt in ipairs({ "%d", "%5d", "%-5d|", "%05d", "%+d", "%x", "%X", "%04x", "%02X", "%o", "%c",
    "%f", "%.2f", "%.0f", "%8.3f", "%e", "%.3e", "%g", "%.3g", "%.14g", "%.17g", "%10.4g", "%#x", "%u" }) do
  for _, v in ipairs(nums) do
    if not (fmt == "%c" and (v < 0 or v > 255 or v % 1 ~= 0)) then emit(fmt, v) end
  end
end
for _, s in ipairs({ "", "abc", 'a"b', "a\\b", "line\nbreak", "tab\there", "nul\0x", "\r\n", "ctl\1\2\31", "del\127",
    "utf8 \195\169", "%s" }) do
  emit("%q", s)
  emit("%s", s)
  emit("[%10s]", s)
  emit("[%-10s]", s)
  emit("%.2s", s)
end
-- tostring of numbers
for _, v in ipairs(nums) do
  io.write("[\"tostring\",", string.format("%.17g", v), ",", q(tostring(v)), "]\n")
end
io.write("[\"tostring\",\"inf\",", q(tostring(math.huge)), "]\n")
io.write("[\"tostring\",\"-inf\",", q(tostring(-math.huge)), "]\n")
