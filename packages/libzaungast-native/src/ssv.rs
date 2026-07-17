//! Blink/V8 structured-clone value deserializer — faithful port of
//! format/chromium/structured-clone.ts, plus the `decodeValue` wrapper from indexeddb.ts.
//! The concentrated-risk layer: object-reference back-refs ('^') register on ENTRY (matching V8's
//! incrementing receiver id), unknown tags HARD-FAIL (never skipped — a silent skip would mis-decode
//! and mis-sample the frozen fingerprint), and object/array/map iteration preserves insertion order.
//! Verified against the TS decoder by a per-record decoded-value differential.

#[derive(Clone, Debug)]
pub enum Ssv {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),               // int32 / uint32 / double / NumberObject — all JS numbers are f64
    Date(f64),              // ms since epoch
    BigInt { neg: bool, le: Vec<u8> }, // magnitude bytes, little-endian, as read
    Str(String),
    Bytes(Vec<u8>),         // ArrayBuffer
    ArrayBufferView(u64),   // marker: byteLength
    Regexp { pattern: Box<Ssv>, flags: u64 },
    Object(Vec<(String, Ssv)>),
    Array { items: Vec<Ssv>, props: Vec<(String, Ssv)> },
    Blob { blob_type: String, size: u64 },
    BlobIndex { index: u64, file: bool },
    ExternalBlob { method: u8 },
    Partial(Box<Ssv>),
}

pub type SsvResult = Result<Ssv, String>;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    objects: Vec<Ssv>, // receiver ref table; reserved on ENTRY, filled on EXIT (no cycles in corpus)
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0, objects: Vec::new() }
    }
    fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn skip_padding(&mut self) {
        while self.pos < self.buf.len() && self.buf[self.pos] == 0x00 {
            self.pos += 1;
        }
    }
    fn peek(&mut self) -> Option<u8> {
        self.skip_padding();
        self.buf.get(self.pos).copied()
    }
    fn varint(&mut self) -> Result<u64, String> {
        let mut v: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let c = *self.buf.get(self.pos).ok_or("varint ran off end")?;
            self.pos += 1;
            v |= ((c & 0x7f) as u64) << shift;
            if c & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift >= 64 {
                return Err("varint too long".into());
            }
        }
        Ok(v)
    }
    fn zigzag(&mut self) -> Result<i64, String> {
        let v = self.varint()?;
        Ok(((v >> 1) as i64) ^ (-((v & 1) as i64)))
    }
    fn double(&mut self) -> Result<f64, String> {
        let b = self.buf.get(self.pos..self.pos + 8).ok_or("double off end")?;
        self.pos += 8;
        Ok(f64::from_le_bytes(b.try_into().unwrap()))
    }

    fn find_envelope_root(&self) -> i64 {
        let scan = std::cmp::min(self.buf.len().saturating_sub(1), 48);
        let mut root: i64 = -1;
        for i in 0..scan {
            if self.buf[i] != 0xff {
                continue;
            }
            let mut j = i + 2; // skip 0xFF + version
            if self.buf.get(j) == Some(&0xfe) {
                j += 1 + 12; // trailer offset(8) + size(4)
            }
            while self.buf.get(j) == Some(&0x00) {
                j += 1;
            }
            if self.buf.get(j) == Some(&0x6f) {
                root = j as i64;
            }
        }
        root
    }
    fn skip_envelope_preamble(&mut self) {
        while !self.eof() {
            match self.buf[self.pos] {
                0xff => self.pos += 2,
                0xfe => self.pos += 1,
                0x00 => self.pos += 1,
                _ => break,
            }
        }
    }
    fn header(&mut self) {
        let root = self.find_envelope_root();
        if root >= 0 {
            self.pos = root as usize;
        } else {
            self.skip_envelope_preamble();
        }
    }

    // number → JS String coercion for object/map keys (integers common; edge floats best-effort).
    fn key_string(v: &Ssv) -> Option<String> {
        match v {
            Ssv::Str(s) => Some(s.clone()),
            Ssv::Num(n) => Some(if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e21 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }),
            _ => None,
        }
    }

    fn value(&mut self) -> SsvResult {
        self.skip_padding();
        let tag = *self.buf.get(self.pos).ok_or("value() past end")?;
        self.pos += 1;
        match tag {
            0x5f => Ok(Ssv::Undefined),
            0x30 => Ok(Ssv::Null),
            0x54 => Ok(Ssv::Bool(true)),
            0x46 => Ok(Ssv::Bool(false)),
            0x49 => Ok(Ssv::Num(self.zigzag()? as f64)),        // 'I' int32
            0x55 => Ok(Ssv::Num(self.varint()? as f64)),        // 'U' uint32
            0x4e => Ok(Ssv::Num(self.double()?)),               // 'N' double
            0x44 => Ok(Ssv::Date(self.double()?)),              // 'D' date
            0x5a => self.bigint(),                              // 'Z' bigint
            0x6e => Ok(Ssv::Num(self.double()?)),               // 'n' Number object
            0x79 => Ok(Ssv::Bool(true)),                        // 'y' true object
            0x78 => Ok(Ssv::Bool(false)),                       // 'x' false object
            0x73 => self.value(),                               // 's' String object
            0x7a => self.bigint(),                              // 'z' BigInt object
            0x42 => self.array_buffer(false),                   // 'B' ArrayBuffer
            0x7e => self.array_buffer(true),                    // '~' resizable ArrayBuffer
            0x56 => self.array_buffer_view(),                   // 'V' ArrayBufferView
            0x22 => {
                // '"' one-byte (latin1)
                let n = self.varint()? as usize;
                let b = self.buf.get(self.pos..self.pos + n).ok_or("str1 off end")?;
                let s: String = b.iter().map(|&c| c as char).collect();
                self.pos += n;
                Ok(Ssv::Str(s))
            }
            0x63 => {
                // 'c' two-byte (utf16le)
                let n = self.varint()? as usize;
                let b = self.buf.get(self.pos..self.pos + n).ok_or("str2 off end")?;
                let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                self.pos += n;
                Ok(Ssv::Str(String::from_utf16_lossy(&units)))
            }
            0x53 => {
                // 'S' utf8
                let n = self.varint()? as usize;
                let b = self.buf.get(self.pos..self.pos + n).ok_or("utf8 off end")?;
                let s = String::from_utf8_lossy(b).into_owned();
                self.pos += n;
                Ok(Ssv::Str(s))
            }
            0x6f => self.object(),        // 'o'
            0x41 => self.dense_array(),   // 'A'
            0x61 => self.sparse_array(),  // 'a'
            0x3b => self.map(),           // ';'
            0x27 => self.set(),           // '\''
            0x52 => self.regexp(),        // 'R'
            0x5e => {
                // '^' object reference
                let id = self.varint()? as usize;
                self.objects.get(id).cloned().ok_or_else(|| format!("objref #{} out of range", id))
            }
            0x5c => self.host_object(),   // '\' host object
            _ => Err(format!("unknown tag 0x{:x}", tag)),
        }
    }

    fn bigint(&mut self) -> SsvResult {
        let bitfield = self.varint()?;
        let byte_len = (bitfield >> 1) as usize;
        let b = self.buf.get(self.pos..self.pos + byte_len).ok_or("bigint off end")?;
        let le = b.to_vec();
        self.pos += byte_len;
        Ok(Ssv::BigInt { neg: bitfield & 1 != 0, le })
    }

    fn array_buffer(&mut self, resizable: bool) -> SsvResult {
        let n = self.varint()? as usize;
        if resizable {
            self.varint()?; // maxByteLength
        }
        let b = self.buf.get(self.pos..self.pos + n).ok_or("arrayBuffer off end")?.to_vec();
        self.pos += n;
        let v = Ssv::Bytes(b);
        self.objects.push(v.clone()); // ArrayBuffers get an object id
        Ok(v)
    }

    fn array_buffer_view(&mut self) -> SsvResult {
        self.pos += 1; // view subtype
        self.varint()?; // byteOffset
        let len = self.varint()?; // byteLength
        self.varint()?; // flags
        Ok(Ssv::ArrayBufferView(len))
    }

    fn object(&mut self) -> SsvResult {
        let id = self.objects.len();
        self.objects.push(Ssv::Null); // reserve id on ENTRY
        let mut props: Vec<(String, Ssv)> = Vec::new();
        while self.peek() != Some(0x7b) {
            // '{'
            if self.eof() {
                return Err("object unterminated".into());
            }
            let key = self.value()?;
            let val = self.value()?;
            if let Some(k) = Self::key_string(&key) {
                push_prop(&mut props, k, val);
            }
        }
        self.pos += 1; // consume '{'
        self.varint()?; // property count
        let obj = Ssv::Object(props);
        self.objects[id] = obj.clone();
        Ok(obj)
    }

    fn dense_array(&mut self) -> SsvResult {
        let len = self.varint()? as usize;
        let id = self.objects.len();
        self.objects.push(Ssv::Null);
        let mut items = Vec::with_capacity(len);
        for _ in 0..len {
            items.push(self.value()?);
        }
        let mut props: Vec<(String, Ssv)> = Vec::new();
        while self.peek() != Some(0x24) {
            // '$'
            if self.eof() {
                return Err("denseArray unterminated".into());
            }
            let key = self.value()?;
            let val = self.value()?;
            if let Some(k) = Self::key_string(&key) {
                push_prop(&mut props, k, val);
            }
        }
        self.pos += 1;
        self.varint()?;
        self.varint()?;
        let arr = Ssv::Array { items, props };
        self.objects[id] = arr.clone();
        Ok(arr)
    }

    fn sparse_array(&mut self) -> SsvResult {
        let len = self.varint()? as usize;
        let id = self.objects.len();
        self.objects.push(Ssv::Null);
        let items = vec![Ssv::Undefined; len]; // holes → undefined (JS new Array(len))
        let mut props: Vec<(String, Ssv)> = Vec::new();
        while self.peek() != Some(0x40) {
            // '@'
            if self.eof() {
                return Err("sparseArray unterminated".into());
            }
            let key = self.value()?;
            let val = self.value()?;
            if let Some(k) = Self::key_string(&key) {
                push_prop(&mut props, k, val);
            }
        }
        self.pos += 1;
        self.varint()?;
        self.varint()?;
        let arr = Ssv::Array { items, props };
        self.objects[id] = arr.clone();
        Ok(arr)
    }

    fn map(&mut self) -> SsvResult {
        let id = self.objects.len();
        self.objects.push(Ssv::Null);
        let mut props: Vec<(String, Ssv)> = Vec::new();
        while self.peek() != Some(0x3a) {
            // ':'
            if self.eof() {
                return Err("map unterminated".into());
            }
            let k = self.value()?;
            let v = self.value()?;
            let ks = Self::key_string(&k).unwrap_or_else(|| coerce_any_key(&k));
            push_prop(&mut props, ks, v);
        }
        self.pos += 1;
        self.varint()?;
        let m = Ssv::Object(props);
        self.objects[id] = m.clone();
        Ok(m)
    }

    fn set(&mut self) -> SsvResult {
        let id = self.objects.len();
        self.objects.push(Ssv::Null);
        let mut items = Vec::new();
        while self.peek() != Some(0x2c) {
            // ','
            if self.eof() {
                return Err("set unterminated".into());
            }
            items.push(self.value()?);
        }
        self.pos += 1;
        self.varint()?;
        let s = Ssv::Array { items, props: Vec::new() };
        self.objects[id] = s.clone();
        Ok(s)
    }

    fn regexp(&mut self) -> SsvResult {
        let pattern = self.value()?;
        let flags = self.varint()?;
        Ok(Ssv::Regexp { pattern: Box::new(pattern), flags })
    }

    fn utf8_string(&mut self) -> Result<String, String> {
        let n = self.varint()? as usize;
        let b = self.buf.get(self.pos..self.pos + n).ok_or("utf8String off end")?;
        let s = String::from_utf8_lossy(b).into_owned();
        self.pos += n;
        Ok(s)
    }

    fn host_object(&mut self) -> SsvResult {
        let subtag = *self.buf.get(self.pos).ok_or("hostObject off end")?;
        self.pos += 1;
        let marker = match subtag {
            0x69 => Ssv::BlobIndex { index: self.varint()?, file: false }, // 'i' kBlobIndexTag
            0x65 => Ssv::BlobIndex { index: self.varint()?, file: true },  // 'e' kFileIndexTag
            0x62 => {
                // 'b' kBlobTag: uuid, type, size
                self.utf8_string()?; // uuid (discarded)
                let blob_type = self.utf8_string()?;
                let size = self.varint()?;
                Ssv::Blob { blob_type, size }
            }
            _ => return Err(format!("unknown host-object tag 0x{:x}", subtag)),
        };
        self.objects.push(marker.clone());
        Ok(marker)
    }
}

// object property set: last-write-wins on an existing key (JS `obj[k]=v`), else append (insertion order)
fn push_prop(props: &mut Vec<(String, Ssv)>, k: String, v: Ssv) {
    if let Some(slot) = props.iter_mut().find(|(pk, _)| *pk == k) {
        slot.1 = v;
    } else {
        props.push((k, v));
    }
}

fn coerce_any_key(v: &Ssv) -> String {
    match v {
        Ssv::Bool(true) => "true".into(),
        Ssv::Bool(false) => "false".into(),
        Ssv::Null => "null".into(),
        Ssv::Undefined => "undefined".into(),
        _ => "[object Object]".into(),
    }
}

/// Deserialize a value payload (post-envelope). `lenient` returns the partially-decoded root on error.
pub fn deserialize(buf: &[u8], lenient: bool) -> SsvResult {
    let mut r = Reader::new(buf);
    r.header();
    match r.value() {
        Ok(v) => Ok(v),
        Err(e) => {
            if lenient && !r.objects.is_empty() {
                let root = r.objects[0].clone();
                if !matches!(root, Ssv::Null) {
                    return Ok(Ssv::Partial(Box::new(root)));
                }
            }
            Err(e)
        }
    }
}

/// Decode an IndexedDB object-store VALUE: varint value-version, then the raw Blink/V8 blob OR
/// Chromium's value-compression wrapper (0xFF 0x11 <method>: 0x02 = inline Snappy; else EXTERNAL
/// .blob, returned as a marker). Port of indexeddb.ts::decodeValue.
pub fn decode_value(value: &[u8], lenient: bool) -> SsvResult {
    // skip the varint value-version
    let mut pos = 0usize;
    loop {
        let c = *value.get(pos).ok_or("decode_value: version varint off end")?;
        pos += 1;
        if c & 0x80 == 0 {
            break;
        }
    }
    let blob = &value[pos..];
    if blob.first() == Some(&0xff) && blob.get(1) == Some(&0x11) {
        let method = *blob.get(2).ok_or("decode_value: truncated wrapper")?;
        if method == 0x02 {
            let un = crate::snappy::uncompress(&blob[3..]).map_err(|_| "decode_value: snappy failed".to_string())?;
            return deserialize(&un, lenient);
        }
        return Ok(Ssv::ExternalBlob { method });
    }
    deserialize(blob, lenient)
}
