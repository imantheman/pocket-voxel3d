//! The PVS1 lines: parsing, formatting, the CRC and the name rules.
//!
//! Every control message is one ASCII line, fields split by single spaces,
//! ended by `\n` (a `\r` before it is tolerated). A line that does not fit
//! its verb's shape is not an error to report -- it is simply not a PVS1
//! message, and the session drops it without an answer.

/// The protocol word every line starts with.
pub const MAGIC: &str = "PVS1";
/// Discovery and offers.
pub const UDP_PORT: u16 = 47610;
/// Transfers (advertised in HELLO, so a peer may use another).
pub const TCP_PORT: u16 = 47611;
/// The biggest save a receiver accepts.
pub const MAX_SAVE: usize = 4 * 1024 * 1024;
/// Seconds between HELLOs.
pub const HELLO_EVERY: f64 = 1.0;
/// A peer silent this long (seconds) is dropped.
pub const PEER_TTL: f64 = 4.0;
/// A transfer, either end, gets this long (seconds) in all.
pub const IO_TIMEOUT: f64 = 10.0;
/// The game tokens.
pub const GAMES: [&str; 6] = ["red", "blue", "yellow", "gold", "silver", "crystal"];
/// Names are cut to this many characters.
pub const NAME_MAX: usize = 20;
/// No control line is longer than this; a peer that sends more is dropped.
pub const MAX_LINE: usize = 512;

/// One HELLO: who a peer is and what save it would serve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub id: String,
    pub tcp_port: u16,
    pub platform: String,
    pub game: String,
    pub size: usize,
    pub crc: u32,
    /// Already sanitized ([`sanitize_name`]); may be empty.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    Hello(Hello),
    Offer { from: String, to: String, game: String },
    Get { game: String },
    Ok { game: String, size: usize, crc: u32 },
    Err { reason: String },
}

/// Whether `game` is one of the six tokens.
pub fn is_game(game: &str) -> bool {
    GAMES.contains(&game)
}

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}
static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32/IEEE, the zlib one (reflected, poly 0xEDB88320, init and final
/// xor all ones).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = CRC_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

/// The CRC as it goes on the wire: 8 lowercase hex digits.
pub fn crc_hex(crc: u32) -> String {
    format!("{:08x}", crc)
}

/// A name as receivers show it: uppercased, only `A-Z 0-9`, space and
/// `-._` kept, cut to [`NAME_MAX`] characters, outer spaces trimmed.
pub fn sanitize_name(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .map(|c| c.to_ascii_uppercase())
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, ' ' | '-' | '.' | '_'))
        .take(NAME_MAX)
        .collect();
    kept.trim().to_string()
}

fn all(s: &str, f: impl Fn(u8) -> bool) -> bool {
    !s.is_empty() && s.bytes().all(f)
}
fn hex_token(s: &str) -> bool {
    s.len() <= 32 && all(s, |b| b.is_ascii_hexdigit())
}
fn word_token(s: &str) -> bool {
    s.len() <= 32 && all(s, |b| b.is_ascii_alphanumeric())
}
fn dec<T: core::str::FromStr>(s: &str) -> Option<T> {
    if s.len() > 12 || !all(s, |b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}
fn crc_field(s: &str) -> Option<u32> {
    if s.len() > 8 || !all(s, |b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

/// One received line (with or without its `\n` / `\r\n`) as a message, or
/// None when it is not a PVS1 line of a known verb and shape.
pub fn parse_line(raw: &[u8]) -> Option<Msg> {
    if raw.len() > MAX_LINE {
        return None;
    }
    let mut end = raw.len();
    if end > 0 && raw[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && raw[end - 1] == b'\r' {
        end -= 1;
    }
    let body = &raw[..end];
    if body.contains(&b'\n') {
        return None;
    }
    // The fields are ASCII; only the name may carry anything else, and the
    // sanitizer drops it.
    let line = String::from_utf8_lossy(body);
    let mut head = line.splitn(3, ' ');
    if head.next()? != MAGIC {
        return None;
    }
    let verb = head.next()?;
    let rest = head.next();
    match verb {
        "HELLO" => {
            let mut f = rest?.splitn(7, ' ');
            let id = f.next()?;
            let port: u16 = dec(f.next()?)?;
            let platform = f.next()?;
            let game = f.next()?;
            let size: usize = dec(f.next()?)?;
            let crc = crc_field(f.next()?)?;
            let name = f.next()?;
            if !hex_token(id) || !word_token(platform) || !word_token(game) || port == 0 {
                return None;
            }
            Some(Msg::Hello(Hello {
                id: id.to_ascii_lowercase(),
                tcp_port: port,
                platform: platform.to_ascii_lowercase(),
                game: game.to_ascii_lowercase(),
                size,
                crc,
                name: sanitize_name(name),
            }))
        }
        "OFFER" => {
            let f: Vec<&str> = rest?.split(' ').collect();
            if f.len() != 3 || !hex_token(f[0]) || !hex_token(f[1]) || !word_token(f[2]) {
                return None;
            }
            Some(Msg::Offer { from: f[0].to_ascii_lowercase(), to: f[1].to_ascii_lowercase(), game: f[2].to_ascii_lowercase() })
        }
        "GET" => {
            let g = rest?;
            if !word_token(g) {
                return None;
            }
            Some(Msg::Get { game: g.to_ascii_lowercase() })
        }
        "OK" => {
            let f: Vec<&str> = rest?.split(' ').collect();
            if f.len() != 3 || !word_token(f[0]) {
                return None;
            }
            Some(Msg::Ok { game: f[0].to_ascii_lowercase(), size: dec(f[1])?, crc: crc_field(f[2])? })
        }
        "ERR" => Some(Msg::Err { reason: rest.unwrap_or("").to_string() }),
        _ => None,
    }
}

/// `PVS1 HELLO <id> <tcpPort> <platform> <game> <size> <crc> <name>\n`.
/// A name that sanitizes to nothing goes out as the platform, uppercased.
pub fn hello_line(h: &Hello) -> String {
    let mut name = sanitize_name(&h.name);
    if name.is_empty() {
        name = sanitize_name(&h.platform);
    }
    if name.is_empty() {
        name = "PLAYER".into();
    }
    format!("{} HELLO {} {} {} {} {} {} {}\n", MAGIC, h.id, h.tcp_port, h.platform, h.game, h.size, crc_hex(h.crc), name)
}

/// `PVS1 OFFER <fromId> <toId> <game>\n`.
pub fn offer_line(from: &str, to: &str, game: &str) -> String {
    format!("{} OFFER {} {} {}\n", MAGIC, from, to, game)
}

/// `PVS1 GET <game>\n`.
pub fn get_line(game: &str) -> String {
    format!("{} GET {}\n", MAGIC, game)
}

/// `PVS1 OK <game> <size> <crc>\n` (the bytes follow it).
pub fn ok_line(game: &str, size: usize, crc: u32) -> String {
    format!("{} OK {} {} {}\n", MAGIC, game, size, crc_hex(crc))
}

/// `PVS1 ERR <reason>\n`.
pub fn err_line(reason: &str) -> String {
    format!("{} ERR {}\n", MAGIC, reason)
}

/// A session id: 8 lowercase hex digits from `seed` (any entropy at hand).
pub fn make_id(seed: u64) -> String {
    // splitmix64: spreads a weak seed (a tick count) over all the bits
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    format!("{:08x}", z as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc_hex(crc32(b"123456789")), "cbf43926");
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn hello_round_trip() {
        let h = Hello {
            id: "0a1b2c3d".into(),
            tcp_port: 47611,
            platform: "3ds".into(),
            game: "red".into(),
            size: 1234,
            crc: 0xcbf43926,
            name: "Isaac".into(),
        };
        let line = hello_line(&h);
        assert_eq!(line, "PVS1 HELLO 0a1b2c3d 47611 3ds red 1234 cbf43926 ISAAC\n");
        assert_eq!(parse_line(line.as_bytes()), Some(Msg::Hello(Hello { name: "ISAAC".into(), ..h })));
    }

    #[test]
    fn hello_name_is_the_rest_of_the_line() {
        let m = parse_line(b"PVS1 HELLO ff 47611 pc gold 0 00000000 my pc  (den)\r\n").unwrap();
        match m {
            Msg::Hello(h) => {
                assert_eq!(h.name, "MY PC  DEN");
                assert_eq!(h.size, 0);
                assert_eq!(h.crc, 0);
                assert_eq!(h.game, "gold");
            }
            _ => panic!("not a hello"),
        }
    }

    #[test]
    fn tolerates_crlf_and_bare_lines() {
        assert_eq!(parse_line(b"PVS1 GET red\r\n"), Some(Msg::Get { game: "red".into() }));
        assert_eq!(parse_line(b"PVS1 GET red\n"), Some(Msg::Get { game: "red".into() }));
        assert_eq!(parse_line(b"PVS1 GET red"), Some(Msg::Get { game: "red".into() }));
        assert_eq!(parse_line(b"PVS1 OK blue 42 0000002a\n"), Some(Msg::Ok { game: "blue".into(), size: 42, crc: 42 }));
        assert_eq!(parse_line(b"PVS1 ERR wrong game\n"), Some(Msg::Err { reason: "wrong game".into() }));
        assert_eq!(
            parse_line(b"PVS1 OFFER 01234567 89abcdef crystal\n"),
            Some(Msg::Offer { from: "01234567".into(), to: "89abcdef".into(), game: "crystal".into() })
        );
    }

    #[test]
    fn rejects_junk_and_other_versions() {
        for bad in [
            &b""[..],
            b"\n",
            b"hello",
            b"PVS2 GET red\n",
            b"pvs1 GET red\n",
            b"PVS1 GET\n",
            b"PVS1 GET red blue\n",
            b"PVS1 GET  red\n",
            b"PVS1 YELL red\n",
            b"PVS1 HELLO 0a1b 47611 3ds red 12 abc\n",
            b"PVS1 HELLO zz 47611 3ds red 12 abc NAME\n",
            b"PVS1 HELLO 0a1b 0 3ds red 12 abc NAME\n",
            b"PVS1 HELLO 0a1b 99999 3ds red 12 abc NAME\n",
            b"PVS1 HELLO 0a1b 47611 3ds red -1 abc NAME\n",
            b"PVS1 HELLO 0a1b 47611 3ds red 12 123456789 NAME\n",
            b"PVS1 OK red 12\n",
            b"PVS1 OK red twelve 0\n",
            b"PVS1 OFFER 01 02\n",
            b"PVS1 GET red\nPVS1 GET blue\n",
            b"\xff\xfe PVS1 GET red\n",
        ] {
            assert_eq!(parse_line(bad), None, "{:?}", String::from_utf8_lossy(bad));
        }
        let long = format!("PVS1 HELLO ff 1 pc red 0 0 {}\n", "A".repeat(600));
        assert_eq!(parse_line(long.as_bytes()), None);
    }

    #[test]
    fn names() {
        assert_eq!(sanitize_name("isaac"), "ISAAC");
        assert_eq!(sanitize_name("  Desk-PC_2.home  "), "DESK-PC_2.HOME");
        assert_eq!(sanitize_name("a<b>c!d@e#f"), "ABCDEF");
        assert_eq!(sanitize_name("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "ABCDEFGHIJKLMNOPQRST");
        assert_eq!(sanitize_name("Pok\u{e9}fan"), "POKFAN");
        assert_eq!(sanitize_name("\u{1f600}"), "");
        assert_eq!(sanitize_name("x                    y"), "X");
    }

    #[test]
    fn hello_never_sends_an_empty_name() {
        let h = Hello { id: "1".into(), tcp_port: 1, platform: "3ds".into(), game: "red".into(), size: 0, crc: 0, name: "!!".into() };
        assert!(hello_line(&h).ends_with(" 3DS\n"));
    }

    #[test]
    fn ids_are_eight_hex() {
        let a = make_id(1);
        let b = make_id(2);
        assert_eq!(a.len(), 8);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }
}
