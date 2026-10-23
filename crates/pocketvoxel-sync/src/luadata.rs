//! A received save, checked as DATA: the `.lua` save grammar and nothing
//! else.
//!
//! A save file is `return <value>`, where a value is a double-quoted string,
//! a number, `true`, `false`, or a table of `name = value` / `[key] = value`
//! entries split by commas. That is all the save writers on either side
//! produce, and all this accepts: no calls, no operators, no comments, no
//! second statement. Nothing is ever run -- this only reads the bytes, so a
//! file with code in it fails to parse instead of executing.
//!
//! The game reads the save with its own reader on CONTINUE; this is the
//! host's check before the bytes are written at all, and it pulls out the
//! two fields the install needs: the top-level `version` and `player.name`.

use std::collections::HashSet;

/// Nesting deeper than this is refused (the saves nest a handful deep).
pub const MAX_DEPTH: usize = 128;

/// What the install needs to know about a save that parsed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaveInfo {
    /// The top-level `version` string (the game the save belongs to).
    pub version: Option<String>,
    /// `player.name`, when it is a string.
    pub player_name: Option<String>,
}

#[derive(PartialEq, Eq, Hash)]
enum Key {
    Num(u64),
    Str(Vec<u8>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Root,
    Player,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Just after `{` or after a `,`: a key or `}`.
    Open,
    /// After a value: `,` or `}`.
    AfterValue,
}

struct Frame {
    tag: Tag,
    state: State,
    seen: HashSet<Key>,
    /// The key whose value is being read (for the captures).
    key: Option<Vec<u8>>,
}

enum Scalar {
    Str(Vec<u8>),
    Num(f64),
    Bool,
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn err<T>(&self, why: &str) -> Result<T, String> {
        Err(format!("{} at byte {}", why, self.i))
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\r' | b'\n') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ident(&mut self) -> Option<&'a [u8]> {
        let start = self.i;
        match self.peek() {
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {}
            _ => return None,
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == b'_') {
            self.i += 1;
        }
        Some(&self.s[start..self.i])
    }
    fn string(&mut self) -> Result<Vec<u8>, String> {
        // at the opening quote
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let Some(c) = self.peek() else { return self.err("unterminated string") };
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(e) = self.peek() else { return self.err("unterminated string") };
                    if e.is_ascii_digit() {
                        let mut v: u32 = 0;
                        let mut n = 0;
                        while n < 3 && matches!(self.peek(), Some(d) if d.is_ascii_digit()) {
                            v = v * 10 + (self.s[self.i] - b'0') as u32;
                            self.i += 1;
                            n += 1;
                        }
                        if v > 255 {
                            return self.err("escape out of range");
                        }
                        out.push(v as u8);
                        continue;
                    }
                    self.i += 1;
                    out.push(match e {
                        b'"' => b'"',
                        b'\\' => b'\\',
                        b'n' | b'\n' | b'\r' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'a' => 7,
                        b'b' => 8,
                        b'f' => 12,
                        b'v' => 11,
                        _ => return self.err("bad string escape"),
                    });
                }
                _ => out.push(c),
            }
        }
    }
    fn number(&mut self) -> Result<f64, String> {
        let start = self.i;
        while matches!(self.peek(), Some(c) if !matches!(c, b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n')) {
            self.i += 1;
        }
        let tok = &self.s[start..self.i];
        let (neg, body) = match tok.first() {
            Some(b'-') => (true, &tok[1..]),
            _ => (false, tok),
        };
        let v = if body.len() > 2 && (body.starts_with(b"0x") || body.starts_with(b"0X")) {
            let h = &body[2..];
            if h.len() > 16 || !h.iter().all(|c| c.is_ascii_hexdigit()) {
                return self.err("malformed number");
            }
            u64::from_str_radix(core::str::from_utf8(h).unwrap(), 16).map_err(|_| "malformed number".to_string())? as f64
        } else {
            if !decimal_ok(body) {
                return self.err("malformed number");
            }
            core::str::from_utf8(body).unwrap().parse::<f64>().map_err(|_| "malformed number".to_string())?
        };
        if !v.is_finite() {
            return self.err("malformed number");
        }
        Ok(if neg { -v } else { v })
    }
    /// A scalar value, or None at a `{`.
    fn scalar(&mut self) -> Result<Option<Scalar>, String> {
        match self.peek() {
            None => self.err("unexpected end"),
            Some(b'{') => Ok(None),
            Some(b'"') => Ok(Some(Scalar::Str(self.string()?))),
            Some(c) if c == b'-' || c == b'.' || c.is_ascii_digit() => Ok(Some(Scalar::Num(self.number()?))),
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {
                let at = self.i;
                match self.ident() {
                    Some(b"true") | Some(b"false") => Ok(Some(Scalar::Bool)),
                    _ => {
                        self.i = at;
                        self.err("unexpected name")
                    }
                }
            }
            Some(_) => self.err("unexpected character"),
        }
    }
}

/// `\d+\.?\d*` or `\.\d+`, then an optional `[eE][-+]?\d+`.
fn decimal_ok(b: &[u8]) -> bool {
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - s
    };
    let int = digits(&mut i);
    let mut frac = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        frac = digits(&mut i);
    }
    if int == 0 && frac == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// Check `bytes` as a save (see the module notes). Ok with the fields the
/// install reads; Err with why it is not a save.
pub fn check(bytes: &[u8]) -> Result<SaveInfo, String> {
    let mut p = P { s: bytes, i: 0 };
    let mut info = SaveInfo::default();
    // a UTF-8 byte-order mark is not part of the grammar either
    p.ws();
    if p.ident() != Some(b"return") {
        return p.err("expected return");
    }
    let mut stack: Vec<Frame> = Vec::new();
    // Read a value: a scalar finishes at once, a table opens a frame.
    // `pending` carries the tag for a table about to open.
    let mut need_value = true;
    let mut child_tag = Tag::Root;
    loop {
        p.ws();
        if need_value {
            need_value = false;
            match p.scalar()? {
                None => {
                    if stack.len() >= MAX_DEPTH {
                        return p.err("nesting too deep");
                    }
                    p.i += 1; // the {
                    stack.push(Frame { tag: child_tag, state: State::Open, seen: HashSet::new(), key: None });
                    continue;
                }
                Some(v) => {
                    let Some(top) = stack.last_mut() else {
                        return p.err("the save is not a table");
                    };
                    if let (Scalar::Str(s), Some(k)) = (&v, top.key.as_deref()) {
                        match (top.tag, k) {
                            (Tag::Root, b"version") => info.version = Some(String::from_utf8_lossy(s).into_owned()),
                            (Tag::Player, b"name") => info.player_name = Some(String::from_utf8_lossy(s).into_owned()),
                            _ => {}
                        }
                    }
                    top.key = None;
                    top.state = State::AfterValue;
                    continue;
                }
            }
        }
        let Some(top) = stack.last_mut() else { break };
        match (top.state, p.peek()) {
            (_, Some(b'}')) => {
                p.i += 1;
                stack.pop();
                match stack.last_mut() {
                    Some(parent) => {
                        parent.key = None;
                        parent.state = State::AfterValue;
                    }
                    None => break, // the root table closed
                }
            }
            (State::AfterValue, Some(b',')) => {
                p.i += 1;
                top.state = State::Open;
            }
            (State::AfterValue, _) => return p.err("expected , or }"),
            (State::Open, Some(b'[')) => {
                p.i += 1;
                p.ws();
                let key = match p.scalar()? {
                    Some(Scalar::Str(s)) => Key::Str(s),
                    Some(Scalar::Num(n)) => Key::Num(if n == 0.0 { 0 } else { n.to_bits() }),
                    _ => return p.err("bad table key"),
                };
                p.ws();
                if p.peek() != Some(b']') {
                    return p.err("expected ]");
                }
                p.i += 1;
                p.ws();
                if p.peek() != Some(b'=') {
                    return p.err("expected =");
                }
                p.i += 1;
                let name = if let Key::Str(s) = &key { Some(s.clone()) } else { None };
                if !top.seen.insert(key) {
                    return p.err("duplicate table key");
                }
                child_tag = if top.tag == Tag::Root && name.as_deref() == Some(b"player") { Tag::Player } else { Tag::Other };
                top.key = name;
                need_value = true;
            }
            (State::Open, Some(c)) if c.is_ascii_alphabetic() || c == b'_' => {
                let name = p.ident().unwrap().to_vec();
                p.ws();
                if p.peek() != Some(b'=') {
                    return p.err("expected =");
                }
                p.i += 1;
                if !top.seen.insert(Key::Str(name.clone())) {
                    return p.err("duplicate table key");
                }
                child_tag = if top.tag == Tag::Root && name == b"player" { Tag::Player } else { Tag::Other };
                top.key = Some(name);
                need_value = true;
            }
            (State::Open, None) => return p.err("unexpected end"),
            (State::Open, _) => return p.err("expected key"),
        }
    }
    p.ws();
    if p.i != bytes.len() {
        return p.err("trailing content");
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAVE: &str = "return {\n  meta = {\n    format = 7,\n    mods = {},\n  },\n  party = {\n    [1] = {\n      species = \"BULBASAUR\",\n      level = 5,\n    },\n  },\n  player = {\n    name = \"ISAAC\",\n    x = 3,\n  },\n  money = 3000,\n  version = \"red\",\n  ratio = -1.5e+03,\n  hexy = 0x1F,\n  flag = true,\n  [\"odd key\"] = \"a\\\"b\\\\c\\n\\065\",\n}\n";

    #[test]
    fn a_save_reads_and_gives_its_fields() {
        let info = check(SAVE.as_bytes()).unwrap();
        assert_eq!(info.version.as_deref(), Some("red"));
        assert_eq!(info.player_name.as_deref(), Some("ISAAC"));
    }

    #[test]
    fn only_the_top_level_version_counts() {
        let s = "return { party = { version = \"blue\" }, player = { version = \"x\", name = \"A\" } }";
        let info = check(s.as_bytes()).unwrap();
        assert_eq!(info.version, None);
        assert_eq!(info.player_name.as_deref(), Some("A"));
        let s = "return { [\"version\"] = \"gold\", [\"player\"] = { [\"name\"] = \"KRIS\" } }";
        let info = check(s.as_bytes()).unwrap();
        assert_eq!(info.version.as_deref(), Some("gold"));
        assert_eq!(info.player_name.as_deref(), Some("KRIS"));
    }

    #[test]
    fn code_in_a_save_is_refused() {
        for bad in [
            "return os.execute(\"rm -rf /\")",
            "return { a = os.time() }",
            "return { a = 1 } os.exit()",
            "return { a = 1 }; print(1)",
            "return { a = (function() return 1 end)() }",
            "return { a = 1 + 2 }",
            "return { a = \"x\" .. \"y\" }",
            "return { a = b }",
            "return { a = nil }",
            "return { a = 1 } -- trailing comment",
            "-- comment\nreturn {}",
            "local t = {} return t",
            "return { a = [[long string]] }",
            "return { a = 'single' }",
            "return { [{}] = 1 }",
            "return { [true] = 1 }",
            "return { a = 1; b = 2 }",
            "return { a = 1, a = 2 }",
            "return { [1] = 1, [1.0] = 2 }",
            "return setmetatable({}, {__index = os})",
            "return {} return {}",
            "return",
            "return \"just a string\"",
            "return 5",
            "",
            "{ a = 1 }",
            "return { a = 1",
            "return { a = \"unterminated }",
            "return { a = \"\\400\" }",
            "return { a = \"\\q\" }",
            "return { a = 0xZZ }",
            "return { a = 1e }",
            "return { a = 1.2.3 }",
            "return { a = - 1 }",
            "return { a = inf }",
            "return { a = 1e999 }",
        ] {
            assert!(check(bad.as_bytes()).is_err(), "accepted: {}", bad);
        }
    }

    #[test]
    fn edge_cases_that_are_data() {
        for good in [
            "return {}",
            "return {}\n",
            "  return{a=1,}",
            "return { [1] = 1, [\"1\"] = 2 }",
            "return { [-2] = 1, [0.5] = 2, [0] = 3 }",
            "return { a = { b = { c = { } } } }",
            "return { s = \"line\\\nnext\" }",
            "return { s = \"caf\u{e9}\" }",
            "return { n = .5, m = 5., e = 1E10, h = -0x10 }",
        ] {
            assert!(check(good.as_bytes()).is_ok(), "refused: {} ({:?})", good, check(good.as_bytes()));
        }
    }

    #[test]
    fn depth_is_capped() {
        let deep = format!("return {}{}", "{ a = ".repeat(MAX_DEPTH + 1), "1".to_string() + &" }".repeat(MAX_DEPTH + 1));
        assert!(check(deep.as_bytes()).is_err());
        let ok = format!("return {}{}", "{ a = ".repeat(MAX_DEPTH - 1), "{}".to_string() + &" }".repeat(MAX_DEPTH - 1));
        assert!(check(ok.as_bytes()).is_ok(), "{:?}", check(ok.as_bytes()));
    }
}
