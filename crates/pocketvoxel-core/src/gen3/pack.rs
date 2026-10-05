// Port of gen1recomp src/core/game3/m4a_player.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).

//! The audio pack: what `Player.loadPack` (m4a_player.lua:46) and
//! `Player.loadSongBin` (:72) read from the cache, held in the `M4AP` blob
//! documented in the [module root](super). [`build_blob`] makes the blob
//! from the cache files; [`AudioPack::from_blob`] reads it.

use alloc::format;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use super::lualit::{self, Key, Table, Value};

/// `index.songs[id]` — the fields the engine reads.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SongInfo {
    pub voicegroup_id: Option<f64>,
    pub reverb: Option<f64>,
    pub sample_id: Option<f64>,
    pub player: Option<f64>,
    pub has_goto: Option<bool>,
    /// `index.fanfares[id].frames` (m4a_worker.lua:145).
    pub fanfare_frames: Option<f64>,
}

/// `index.samples[id]` (WaveData header as cached). Missing fields are 0,
/// which every Lua read of them defaults to.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SampleMeta {
    pub offset: f64,
    pub size: f64,
    pub freq: f64,
    pub loop_start: f64,
    pub status: f64,
}

/// One ToneData entry of a voicegroup (a Lua table; `None` = nil field).
/// `key_split`/`wave` index the pack's pools. `is_rhy` marks the copy
/// `resolve_tone` makes for a rhythm voice (m4a_player.lua:113).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tone {
    pub typ: Option<f64>,
    pub key: Option<f64>,
    pub length: Option<f64>,
    pub pan: Option<f64>,
    pub sample_id: Option<f64>,
    pub attack: Option<f64>,
    pub decay: Option<f64>,
    pub sustain: Option<f64>,
    pub release: Option<f64>,
    pub wav_param: Option<f64>,
    pub sub_vg_id: Option<f64>,
    pub key_split: Option<u32>,
    pub wave: Option<u32>,
    pub is_rhy: bool,
}

const TONE_FIELDS: [&str; 11] = [
    "type", "key", "length", "pan", "sampleId", "attack", "decay", "sustain", "release",
    "wavParam", "subVgId",
];

impl Tone {
    fn field_mut(&mut self, i: usize) -> &mut Option<f64> {
        match i {
            0 => &mut self.typ,
            1 => &mut self.key,
            2 => &mut self.length,
            3 => &mut self.pan,
            4 => &mut self.sample_id,
            5 => &mut self.attack,
            6 => &mut self.decay,
            7 => &mut self.sustain,
            8 => &mut self.release,
            9 => &mut self.wav_param,
            _ => &mut self.sub_vg_id,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct SongEntry {
    info: Option<SongInfo>,
    bin: Option<(usize, usize)>,
}

/// The loaded pack. Owns the blob; PCM and song bins are borrowed from it.
pub struct AudioPack {
    blob: Vec<u8>,
    songs: Vec<SongEntry>,
    samples: Vec<Option<SampleMeta>>,
    voicegroups: Vec<Option<Vec<Option<Tone>>>>,
    key_splits: Vec<[u8; 128]>,
    waves: Vec<Vec<u8>>,
    cries: Vec<Option<f64>>,
    cry_ids: Vec<Option<f64>>,
    pcm: (usize, usize),
}

/// Integer id lookup for a Lua number key (non-integers never match a
/// cached integer key).
#[inline]
fn idx(id: f64, len: usize) -> Option<usize> {
    if id >= 0.0 && id < len as f64 && id == (id as usize) as f64 {
        Some(id as usize)
    } else {
        None
    }
}

fn rd_u32(b: &[u8], at: usize) -> Result<u32, String> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| format!("M4AP: read past end at {}", at))
}

fn rd_i32(b: &[u8], at: usize) -> Result<i32, String> {
    rd_u32(b, at).map(|v| v as i32)
}

impl AudioPack {
    /// Read an `M4AP` blob (layout in the module root).
    pub fn from_blob(blob: Vec<u8>) -> Result<AudioPack, String> {
        let b = &blob[..];
        if b.len() < 64 || &b[0..4] != b"M4AP" {
            return Err(String::from("M4AP: bad magic"));
        }
        if rd_u32(b, 4)? != 1 {
            return Err(String::from("M4AP: unsupported version"));
        }
        let h = |i: usize| rd_u32(b, i).map(|v| v as usize);
        let (song_n, song_off) = (h(8)?, h(12)?);
        let (sample_n, sample_off) = (h(16)?, h(20)?);
        let (vg_n, vg_off) = (h(24)?, h(28)?);
        let (cry_n, cry_off) = (h(32)?, h(36)?);
        let (cid_n, cid_off) = (h(40)?, h(44)?);
        let (pcm_off, pcm_len) = (h(48)?, h(52)?);
        if pcm_off.checked_add(pcm_len).map_or(true, |e| e > b.len()) {
            return Err(String::from("M4AP: pcm out of range"));
        }

        let mut songs = Vec::with_capacity(song_n);
        for i in 0..song_n {
            let r = song_off + i * 40;
            let flags = rd_u32(b, r)?;
            let f = |bit: u32, at: usize| -> Result<Option<f64>, String> {
                Ok(if flags & (1 << bit) != 0 {
                    Some(rd_i32(b, r + at)? as f64)
                } else {
                    None
                })
            };
            let info = if flags & 1 != 0 {
                Some(SongInfo {
                    voicegroup_id: f(1, 4)?,
                    reverb: f(2, 8)?,
                    sample_id: f(3, 12)?,
                    player: f(4, 16)?,
                    has_goto: if flags & (1 << 5) != 0 {
                        Some(flags & (1 << 6) != 0)
                    } else {
                        None
                    },
                    fanfare_frames: f(7, 20)?,
                })
            } else {
                None
            };
            let bin = if flags & (1 << 8) != 0 {
                let (o, l) = (rd_u32(b, r + 24)? as usize, rd_u32(b, r + 28)? as usize);
                if o.checked_add(l).map_or(true, |e| e > b.len()) {
                    return Err(format!("M4AP: song {} bin out of range", i));
                }
                Some((o, l))
            } else {
                None
            };
            songs.push(SongEntry { info, bin });
        }

        let mut samples = Vec::with_capacity(sample_n);
        for i in 0..sample_n {
            let r = sample_off + i * 24;
            samples.push(if rd_u32(b, r)? != 0 {
                Some(SampleMeta {
                    offset: rd_u32(b, r + 4)? as f64,
                    size: rd_u32(b, r + 8)? as f64,
                    freq: rd_u32(b, r + 12)? as f64,
                    loop_start: rd_u32(b, r + 16)? as f64,
                    status: rd_u32(b, r + 20)? as f64,
                })
            } else {
                None
            });
        }

        let mut key_splits: Vec<[u8; 128]> = Vec::new();
        let mut waves: Vec<Vec<u8>> = Vec::new();
        let mut voicegroups = Vec::with_capacity(vg_n);
        for i in 0..vg_n {
            let block = rd_u32(b, vg_off + i * 4)? as usize;
            if block == 0 {
                voicegroups.push(None);
                continue;
            }
            let mut tones = Vec::with_capacity(128);
            for t in 0..128 {
                let r = block + t * 56;
                let flags = rd_u32(b, r)?;
                if flags & 1 == 0 {
                    tones.push(None);
                    continue;
                }
                let mut tone = Tone::default();
                for fi in 0..11 {
                    if flags & (1 << (fi + 1)) != 0 {
                        *tone.field_mut(fi) = Some(rd_i32(b, r + 4 + fi * 4)? as f64);
                    }
                }
                if flags & (1 << 12) != 0 {
                    let o = rd_u32(b, r + 48)? as usize;
                    let s = b
                        .get(o..o + 128)
                        .ok_or_else(|| String::from("M4AP: keySplit out of range"))?;
                    let mut ks = [0u8; 128];
                    ks.copy_from_slice(s);
                    tone.key_split = Some(key_splits.len() as u32);
                    key_splits.push(ks);
                }
                if flags & (1 << 13) != 0 {
                    let o = rd_u32(b, r + 52)? as usize;
                    let n = *b
                        .get(o)
                        .ok_or_else(|| String::from("M4AP: wave out of range"))?
                        as usize;
                    let s = b
                        .get(o + 1..o + 1 + n)
                        .ok_or_else(|| String::from("M4AP: wave out of range"))?;
                    tone.wave = Some(waves.len() as u32);
                    waves.push(s.to_vec());
                }
                tones.push(Some(tone));
            }
            voicegroups.push(Some(tones));
        }

        let mut cries = Vec::with_capacity(cry_n);
        for i in 0..cry_n {
            let v = rd_i32(b, cry_off + i * 4)?;
            cries.push(if v < 0 { None } else { Some(v as f64) });
        }
        let mut cry_ids = Vec::with_capacity(cid_n);
        for i in 0..cid_n {
            let v = rd_i32(b, cid_off + i * 4)?;
            cry_ids.push(if v < 0 { None } else { Some(v as f64) });
        }

        Ok(AudioPack {
            blob,
            songs,
            samples,
            voicegroups,
            key_splits,
            waves,
            cries,
            cry_ids,
            pcm: (pcm_off, pcm_len),
        })
    }

    /// `pack.samplesBin`.
    #[inline]
    pub fn samples_bin(&self) -> &[u8] {
        &self.blob[self.pcm.0..self.pcm.0 + self.pcm.1]
    }

    /// `Player.songInfo` (m4a_player.lua:65).
    pub fn song_info(&self, id: f64) -> Option<&SongInfo> {
        idx(id, self.songs.len()).and_then(|i| self.songs[i].info.as_ref())
    }

    /// The raw `songs/<id>.bin`, if the cache has it.
    pub fn song_bin(&self, id: f64) -> Option<&[u8]> {
        idx(id, self.songs.len())
            .and_then(|i| self.songs[i].bin)
            .map(|(o, l)| &self.blob[o..o + l])
    }

    /// `pack.samples[id]`.
    pub fn sample(&self, id: f64) -> Option<&SampleMeta> {
        idx(id, self.samples.len()).and_then(|i| self.samples[i].as_ref())
    }

    /// `pack.voicegroups[id]` (128 voice slots).
    pub fn voicegroup(&self, id: f64) -> Option<&[Option<Tone>]> {
        idx(id, self.voicegroups.len()).and_then(|i| self.voicegroups[i].as_deref())
    }

    /// `tone.keySplit[key] or 0`.
    pub fn key_split(&self, tone: &Tone, key: f64) -> Option<f64> {
        let ks = &self.key_splits[tone.key_split? as usize];
        idx(key, 128).map(|k| ks[k] as f64)
    }

    /// `tone.wave` as its 1-based nibble list (0-based here).
    pub fn wave(&self, tone: &Tone) -> Option<&[u8]> {
        tone.wave.map(|w| &self.waves[w as usize][..])
    }

    /// `pack.index.cries[idx].sampleId`.
    pub fn cry_sample_id(&self, cry_index: f64) -> Option<f64> {
        idx(cry_index, self.cries.len()).and_then(|i| self.cries[i])
    }

    /// `pack.index.cryIds[species]`.
    pub fn cry_id(&self, species: f64) -> Option<f64> {
        idx(species, self.cry_ids.len()).and_then(|i| self.cry_ids[i])
    }

    /// `Sample.loadPcm(pack.samplesBin, meta)` (m4a_sample.lua:249) as a
    /// range into [`samples_bin`](Self::samples_bin): `None` when the Lua
    /// returns nil.
    pub fn pcm_range(&self, meta: &SampleMeta) -> Option<(usize, usize)> {
        let off = meta.offset;
        let size = meta.size;
        if size <= 0.0 || off < 0.0 || off + size > self.pcm.1 as f64 {
            return None;
        }
        Some((off as usize, size as usize))
    }
}

// ---------------------------------------------------------------------------
// Builder (cache files -> blob)
// ---------------------------------------------------------------------------

fn int_field(t: &Table, name: &str, what: &str) -> Result<Option<i64>, String> {
    match t.get_str(name) {
        None => Ok(None),
        Some(Value::Num(n)) => {
            if *n != (*n as i64) as f64 || *n < i32::MIN as f64 || *n > u32::MAX as f64 {
                return Err(format!(
                    "{}: {} = {} is not a 32-bit integer",
                    what, name, n
                ));
            }
            Ok(Some(*n as i64))
        }
        Some(_) => Err(format!("{}: {} is not a number", what, name)),
    }
}

/// Integer keys of a table, ascending.
fn int_keys(t: &Table) -> Vec<i64> {
    let mut ks: Vec<i64> = t
        .entries
        .iter()
        .filter_map(|(k, v)| match (k, v) {
            (Key::Num(n), v) if *v != Value::Nil && *n >= 0.0 && *n == (*n as i64) as f64 => {
                Some(*n as i64)
            }
            _ => None,
        })
        .collect();
    ks.sort_unstable();
    ks.dedup();
    ks
}

fn align4(out: &mut Vec<u8>) {
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

fn put_u32(out: &mut Vec<u8>, at: usize, v: u32) {
    out[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Build the `M4AP` blob from the audio cache files. `index_lua` is
/// `index.lua`; `samples_lua` / `voicegroups_lua` are read only when the
/// index lacks `samples` / `voicegroups` (as loadPack does); `song_bins`
/// lists every `songs/<id>.bin` present.
pub fn build_blob(
    index_lua: &[u8],
    samples_lua: Option<&[u8]>,
    voicegroups_lua: Option<&[u8]>,
    samples_bin: &[u8],
    song_bins: &[(u32, &[u8])],
) -> Result<Vec<u8>, String> {
    let index_v = lualit::parse(index_lua).map_err(|e| format!("index.lua: {}", e))?;
    let index = index_v
        .as_table()
        .ok_or_else(|| String::from("index.lua: not a table"))?;
    let empty = Table::default();

    let samples_v;
    let samples: &Table = match index.get_str("samples").and_then(Value::as_table) {
        Some(t) => t,
        None => match samples_lua {
            Some(src) => {
                samples_v = lualit::parse(src).map_err(|e| format!("samples.lua: {}", e))?;
                samples_v.as_table().unwrap_or(&empty)
            }
            None => &empty,
        },
    };
    let vgs_v;
    let vgs: &Table = match index.get_str("voicegroups").and_then(Value::as_table) {
        Some(t) => t,
        None => match voicegroups_lua {
            Some(src) => {
                vgs_v = lualit::parse(src).map_err(|e| format!("voicegroups.lua: {}", e))?;
                vgs_v.as_table().unwrap_or(&empty)
            }
            None => &empty,
        },
    };
    let songs = index
        .get_str("songs")
        .and_then(Value::as_table)
        .unwrap_or(&empty);
    let fanfares = index
        .get_str("fanfares")
        .and_then(Value::as_table)
        .unwrap_or(&empty);
    let cries = index
        .get_str("cries")
        .and_then(Value::as_table)
        .unwrap_or(&empty);
    let cry_ids = index
        .get_str("cryIds")
        .and_then(Value::as_table)
        .unwrap_or(&empty);

    let mut out = vec![0u8; 64];
    out[0..4].copy_from_slice(b"M4AP");
    put_u32(&mut out, 4, 1);

    // Songs.
    let song_keys = int_keys(songs);
    let max_bin = song_bins
        .iter()
        .map(|(id, _)| *id as i64)
        .max()
        .unwrap_or(-1);
    let song_n = (song_keys.last().copied().unwrap_or(-1).max(max_bin) + 1) as usize;
    let songs_off = out.len();
    out.resize(songs_off + song_n * 40, 0);
    for id in 0..song_n {
        let r = songs_off + id * 40;
        let mut flags = 0u32;
        if let Some(t) = songs.get_num(id as f64).and_then(Value::as_table) {
            flags |= 1;
            let what = format!("songs[{}]", id);
            for (bit, name, at) in [
                (1, "voicegroupId", 4),
                (2, "reverb", 8),
                (3, "sampleId", 12),
                (4, "player", 16),
            ] {
                if let Some(v) = int_field(t, name, &what)? {
                    flags |= 1 << bit;
                    put_u32(&mut out, r + at, v as u32);
                }
            }
            match t.get_str("hasGoto") {
                Some(Value::Bool(b)) => {
                    flags |= 1 << 5;
                    if *b {
                        flags |= 1 << 6;
                    }
                }
                None => {}
                Some(_) => return Err(format!("{}: hasGoto is not a boolean", what)),
            }
            if let Some(ff) = fanfares.get_num(id as f64).and_then(Value::as_table) {
                if let Some(fr) = int_field(ff, "frames", &format!("fanfares[{}]", id))? {
                    flags |= 1 << 7;
                    put_u32(&mut out, r + 20, fr as u32);
                }
            }
        }
        put_u32(&mut out, r, flags);
    }

    // Samples.
    let sample_keys = int_keys(samples);
    let sample_n = (sample_keys.last().copied().unwrap_or(-1) + 1) as usize;
    let samples_off = out.len();
    out.resize(samples_off + sample_n * 24, 0);
    for &id in &sample_keys {
        let t = match samples.get_num(id as f64).and_then(Value::as_table) {
            Some(t) => t,
            None => continue,
        };
        let r = samples_off + id as usize * 24;
        put_u32(&mut out, r, 1);
        let what = format!("samples[{}]", id);
        for (name, at) in [
            ("offset", 4),
            ("size", 8),
            ("freq", 12),
            ("loopStart", 16),
            ("status", 20),
        ] {
            let v = int_field(t, name, &what)?.unwrap_or(0);
            if v < 0 {
                return Err(format!("{}: {} is negative", what, name));
            }
            put_u32(&mut out, r + at, v as u32);
        }
    }

    // Voicegroups: offset table, then the tone blocks and their pools.
    let vg_keys = int_keys(vgs);
    let vg_n = (vg_keys.last().copied().unwrap_or(-1) + 1) as usize;
    if vg_n > 65536 {
        return Err(String::from("voicegroup ids out of range"));
    }
    let vg_off = out.len();
    out.resize(vg_off + vg_n * 4, 0);
    for &vg_id in &vg_keys {
        let vg = match vgs.get_num(vg_id as f64).and_then(Value::as_table) {
            Some(t) => t,
            None => continue,
        };
        align4(&mut out);
        let block = out.len();
        put_u32(&mut out, vg_off + vg_id as usize * 4, block as u32);
        out.resize(block + 128 * 56, 0);
        for ti in 0..128usize {
            let tone = match vg.get_num(ti as f64).and_then(Value::as_table) {
                Some(t) => t,
                None => continue,
            };
            let r = block + ti * 56;
            let what = format!("voicegroups[{}][{}]", vg_id, ti);
            let mut flags = 1u32;
            for (fi, name) in TONE_FIELDS.iter().enumerate() {
                if let Some(v) = int_field(tone, name, &what)? {
                    flags |= 1 << (fi + 1);
                    put_u32(&mut out, r + 4 + fi * 4, v as i32 as u32);
                }
            }
            if let Some(ks) = tone.get_str("keySplit").and_then(Value::as_table) {
                let mut bytes = [0u8; 128];
                for (k, v) in &ks.entries {
                    if let (Key::Num(kn), Value::Num(vn)) = (k, v) {
                        if *kn >= 0.0 && *kn < 128.0 && *kn == (*kn as usize) as f64 {
                            if *vn < 0.0 || *vn > 255.0 || *vn != (*vn as u8) as f64 {
                                return Err(format!("{}: keySplit value {} not a byte", what, vn));
                            }
                            bytes[*kn as usize] = *vn as u8;
                        } else {
                            return Err(format!("{}: keySplit key {} out of 0..127", what, kn));
                        }
                    }
                }
                align4(&mut out);
                let o = out.len();
                out.extend_from_slice(&bytes);
                flags |= 1 << 12;
                put_u32(&mut out, r + 48, o as u32);
            }
            if let Some(w) = tone.get_str("wave").and_then(Value::as_table) {
                let n = w.len();
                if n > 255 {
                    return Err(format!("{}: wave longer than 255", what));
                }
                align4(&mut out);
                let o = out.len();
                out.push(n as u8);
                for i in 1..=n {
                    let v = w.get_num(i as f64).and_then(Value::as_num).unwrap_or(0.0);
                    if v < 0.0 || v > 255.0 || v != (v as u8) as f64 {
                        return Err(format!("{}: wave value {} not a byte", what, v));
                    }
                    out.push(v as u8);
                }
                flags |= 1 << 13;
                put_u32(&mut out, r + 52, o as u32);
            }
            put_u32(&mut out, r, flags);
        }
    }

    // Cries and cryIds.
    align4(&mut out);
    let cry_keys = int_keys(cries);
    let cry_n = (cry_keys.last().copied().unwrap_or(-1) + 1) as usize;
    let cries_off = out.len();
    for i in 0..cry_n {
        let sid = match cries.get_num(i as f64).and_then(Value::as_table) {
            Some(t) => int_field(t, "sampleId", &format!("cries[{}]", i))?,
            None => None,
        };
        push_u32(&mut out, sid.map_or(-1i32, |v| v as i32) as u32);
    }
    let cid_keys = int_keys(cry_ids);
    let cid_n = (cid_keys.last().copied().unwrap_or(-1) + 1) as usize;
    let cids_off = out.len();
    for i in 0..cid_n {
        let v = match cry_ids.get_num(i as f64) {
            Some(Value::Num(n)) if *n >= 0.0 && *n == (*n as i32) as f64 => *n as i32,
            Some(Value::Num(n)) => return Err(format!("cryIds[{}] = {} unsupported", i, n)),
            _ => -1,
        };
        push_u32(&mut out, v as u32);
    }

    // PCM, then song bins.
    align4(&mut out);
    let pcm_off = out.len();
    out.extend_from_slice(samples_bin);
    for (id, bin) in song_bins {
        align4(&mut out);
        let o = out.len();
        out.extend_from_slice(bin);
        let r = songs_off + *id as usize * 40;
        let flags = u32::from_le_bytes([out[r], out[r + 1], out[r + 2], out[r + 3]]) | (1 << 8);
        put_u32(&mut out, r, flags);
        put_u32(&mut out, r + 24, o as u32);
        put_u32(&mut out, r + 28, bin.len() as u32);
    }

    put_u32(&mut out, 8, song_n as u32);
    put_u32(&mut out, 12, songs_off as u32);
    put_u32(&mut out, 16, sample_n as u32);
    put_u32(&mut out, 20, samples_off as u32);
    put_u32(&mut out, 24, vg_n as u32);
    put_u32(&mut out, 28, vg_off as u32);
    put_u32(&mut out, 32, cry_n as u32);
    put_u32(&mut out, 36, cries_off as u32);
    put_u32(&mut out, 40, cid_n as u32);
    put_u32(&mut out, 44, cids_off as u32);
    put_u32(&mut out, 48, pcm_off as u32);
    put_u32(&mut out, 52, samples_bin.len() as u32);
    Ok(out)
}
