// Port of gen1recomp src/core/game3/m4a_player.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! A restricted Lua-literal reader for the audio cache's `.lua` files
//! (`return { [1] = { ["freq"] = 13700096, ... }, ... }`), standing in for
//! `load_lua` (m4a_player.lua:36), which runs them as Lua chunks with an
//! empty environment. Accepted: `return` followed by one value; tables with
//! `[expr] = v`, `name = v` and positional entries; numbers (decimal, hex,
//! exponent, unary minus), strings ('..', ".." with the usual escapes),
//! `true`/`false`/`nil`, and `--` comments. That is everything LuaWriter
//! emits; anything else is an error.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    Num(f64),
    Str(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Nil,
    Bool(bool),
    Num(f64),
    Str(Vec<u8>),
    Table(Table),
}

/// A table's entries in source order. Later duplicates win on lookup, as
/// a Lua constructor's would.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Table {
    pub entries: Vec<(Key, Value)>,
}

impl Table {
    pub fn get(&self, k: &Key) -> Option<&Value> {
        self.entries
            .iter()
            .rev()
            .find(|(kk, _)| kk == k)
            .map(|(_, v)| v)
            .filter(|v| **v != Value::Nil)
    }
    pub fn get_str(&self, name: &str) -> Option<&Value> {
        self.get(&Key::Str(name.as_bytes().to_vec()))
    }
    pub fn get_num(&self, n: f64) -> Option<&Value> {
        self.get(&Key::Num(n))
    }
    /// `#t` for a table built as a sequence 1..n (the border LuaJIT reports
    /// for gap-free arrays).
    pub fn len(&self) -> usize {
        let mut n = 0usize;
        while self.get_num((n + 1) as f64).is_some() {
            n += 1;
        }
        n
    }
}

impl Value {
    pub fn as_num(&self) -> Option<f64> {
        if let Value::Num(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_table(&self) -> Option<&Table> {
        if let Value::Table(t) = self {
            Some(t)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

/// Parse a whole `return <value>` chunk.
pub fn parse(src: &[u8]) -> Result<Value, String> {
    let mut p = P { s: src, i: 0 };
    p.ws();
    if !p.word("return") {
        return Err(String::from("expected 'return'"));
    }
    let v = p.value()?;
    p.ws();
    if p.i < p.s.len() && p.s[p.i] == b';' {
        p.i += 1;
        p.ws();
    }
    if p.i != p.s.len() {
        return Err(format!("trailing input at byte {}", p.i));
    }
    Ok(v)
}

impl<'a> P<'a> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        loop {
            while let Some(c) = self.peek() {
                if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                    self.i += 1;
                } else {
                    break;
                }
            }
            if self.s[self.i..].starts_with(b"--") {
                while let Some(c) = self.peek() {
                    self.i += 1;
                    if c == b'\n' {
                        break;
                    }
                }
                continue;
            }
            break;
        }
    }

    fn is_ident(c: u8) -> bool {
        c.is_ascii_alphanumeric() || c == b'_'
    }

    fn word(&mut self, w: &str) -> bool {
        let wb = w.as_bytes();
        if self.s[self.i..].starts_with(wb) {
            let after = self.s.get(self.i + wb.len()).copied();
            if after.map(Self::is_ident) != Some(true) {
                self.i += wb.len();
                return true;
            }
        }
        false
    }

    fn value(&mut self) -> Result<Value, String> {
        self.ws();
        match self.peek() {
            None => Err(String::from("unexpected end")),
            Some(b'{') => self.table(),
            Some(b'"') | Some(b'\'') => Ok(Value::Str(self.string()?)),
            Some(c) if c == b'-' || c == b'.' || c.is_ascii_digit() => {
                Ok(Value::Num(self.number()?))
            }
            _ => {
                if self.word("true") {
                    Ok(Value::Bool(true))
                } else if self.word("false") {
                    Ok(Value::Bool(false))
                } else if self.word("nil") {
                    Ok(Value::Nil)
                } else {
                    Err(format!("unexpected byte at {}", self.i))
                }
            }
        }
    }

    fn table(&mut self) -> Result<Value, String> {
        self.i += 1; // {
        let mut t = Table::default();
        let mut pos = 1.0;
        loop {
            self.ws();
            match self.peek() {
                None => return Err(String::from("unterminated table")),
                Some(b'}') => {
                    self.i += 1;
                    break;
                }
                Some(b'[') => {
                    self.i += 1;
                    let k = self.value()?;
                    self.ws();
                    if self.peek() != Some(b']') {
                        return Err(format!("expected ']' at {}", self.i));
                    }
                    self.i += 1;
                    self.expect(b'=')?;
                    let v = self.value()?;
                    let key = match k {
                        Value::Num(n) => Key::Num(n),
                        Value::Str(s) => Key::Str(s),
                        _ => return Err(String::from("unsupported table key")),
                    };
                    t.entries.push((key, v));
                }
                Some(c) if c.is_ascii_alphabetic() || c == b'_' => {
                    let save = self.i;
                    let st = self.i;
                    while self.peek().map(Self::is_ident) == Some(true) {
                        self.i += 1;
                    }
                    let name = self.s[st..self.i].to_vec();
                    self.ws();
                    if self.peek() == Some(b'=') {
                        self.i += 1;
                        let v = self.value()?;
                        t.entries.push((Key::Str(name), v));
                    } else {
                        self.i = save;
                        let v = self.value()?;
                        t.entries.push((Key::Num(pos), v));
                        pos += 1.0;
                    }
                }
                _ => {
                    let v = self.value()?;
                    t.entries.push((Key::Num(pos), v));
                    pos += 1.0;
                }
            }
            self.ws();
            match self.peek() {
                Some(b',') | Some(b';') => self.i += 1,
                Some(b'}') => {}
                _ => return Err(format!("expected ',' or '}}' at {}", self.i)),
            }
        }
        Ok(Value::Table(t))
    }

    fn expect(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at {}", c as char, self.i))
        }
    }

    fn number(&mut self) -> Result<f64, String> {
        let mut neg = false;
        if self.peek() == Some(b'-') {
            neg = true;
            self.i += 1;
            self.ws();
        }
        let st = self.i;
        let v;
        if self.s[self.i..].starts_with(b"0x") || self.s[self.i..].starts_with(b"0X") {
            self.i += 2;
            let mut acc = 0.0f64;
            let mut any = false;
            while let Some(c) = self.peek() {
                let d = match c {
                    b'0'..=b'9' => c - b'0',
                    b'a'..=b'f' => c - b'a' + 10,
                    b'A'..=b'F' => c - b'A' + 10,
                    _ => break,
                };
                acc = acc * 16.0 + d as f64;
                any = true;
                self.i += 1;
            }
            if !any {
                return Err(format!("bad hex number at {}", st));
            }
            v = acc;
        } else {
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' {
                    self.i += 1;
                } else if (c == b'-' || c == b'+') && matches!(self.s[self.i - 1], b'e' | b'E') {
                    self.i += 1;
                } else {
                    break;
                }
            }
            let txt = core::str::from_utf8(&self.s[st..self.i])
                .map_err(|_| String::from("bad number"))?;
            v = txt
                .parse::<f64>()
                .map_err(|_| format!("bad number '{}' at {}", txt, st))?;
        }
        Ok(if neg { -v } else { v })
    }

    fn string(&mut self) -> Result<Vec<u8>, String> {
        let q = self.s[self.i];
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let c = self
                .peek()
                .ok_or_else(|| String::from("unterminated string"))?;
            self.i += 1;
            if c == q {
                break;
            }
            if c != b'\\' {
                out.push(c);
                continue;
            }
            let e = self.peek().ok_or_else(|| String::from("bad escape"))?;
            self.i += 1;
            match e {
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'r' => out.push(b'\r'),
                b'a' => out.push(7),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'v' => out.push(11),
                b'\\' => out.push(b'\\'),
                b'"' => out.push(b'"'),
                b'\'' => out.push(b'\''),
                b'\n' => out.push(b'\n'),
                b'x' => {
                    let h = self
                        .s
                        .get(self.i..self.i + 2)
                        .ok_or_else(|| String::from("bad \\x"))?;
                    let t = core::str::from_utf8(h).map_err(|_| String::from("bad \\x"))?;
                    out.push(u8::from_str_radix(t, 16).map_err(|_| String::from("bad \\x"))?);
                    self.i += 2;
                }
                b'0'..=b'9' => {
                    let mut n = (e - b'0') as u32;
                    for _ in 0..2 {
                        match self.peek() {
                            Some(d) if d.is_ascii_digit() => {
                                n = n * 10 + (d - b'0') as u32;
                                self.i += 1;
                            }
                            _ => break,
                        }
                    }
                    if n > 255 {
                        return Err(String::from("bad decimal escape"));
                    }
                    out.push(n as u8);
                }
                _ => return Err(format!("unsupported escape at {}", self.i)),
            }
        }
        Ok(out)
    }
}
