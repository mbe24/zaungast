//! Blink/V8 structured-clone value deserializer — faithful port of
//! format/chromium/structured-clone.ts, plus the `decodeValue` wrapper from indexeddb.ts.
//! The concentrated-risk layer: object-reference back-refs ('^') register on ENTRY (matching V8's
//! incrementing receiver id), unknown tags HARD-FAIL (never skipped — a silent skip would mis-decode
//! and mis-sample the frozen fingerprint), and object/array/map iteration preserves insertion order.
//! Verified against the TS decoder by a per-record decoded-value differential.

#[derive(Clone, Debug, PartialEq)]
pub enum Ssv {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),  // int32 / uint32 / double / NumberObject — all JS numbers are f64
    Date(f64), // ms since epoch
    BigInt {
        neg: bool,
        le: Vec<u8>,
    }, // magnitude bytes, little-endian, as read
    Str(String),
    Bytes(Vec<u8>),       // ArrayBuffer
    ArrayBufferView(u64), // marker: byteLength
    Regexp {
        pattern: Box<Ssv>,
        flags: u64,
    },
    Object(Vec<(String, Ssv)>),
    Array {
        items: Vec<Ssv>,
        props: Vec<(String, Ssv)>,
    },
    Blob {
        blob_type: String,
        size: u64,
    },
    BlobIndex {
        index: u64,
        file: bool,
    },
    ExternalBlob {
        method: u8,
    },
    Partial(Box<Ssv>),
}

pub type SsvResult = Result<Ssv, String>;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    // Offset-based ref table: the receiver ref table holds each container's BYTE OFFSET (not a cloned value). A '^'
    // re-decodes from the offset rather than cloning a stored value — killing the per-record
    // clone-cascade that dominated allocation. The corpus is acyclic (a target is fully decoded before
    // it's referenced), so a re-decode always yields the equal value.
    objects: Vec<usize>,
    // >0 while re-decoding a back-ref target: containers register NO new id then (their id was assigned
    // on the forward pass), and it bounds recursion so a (corpus-absent) cycle fails instead of hanging.
    resolve_depth: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader {
            buf,
            pos: 0,
            objects: Vec::new(),
            resolve_depth: 0,
        }
    }
    // Offset-based ref table: reserve a container's receiver id on ENTRY, recording its byte offset. Skipped during a
    // back-ref re-decode (resolve_depth>0) so the id sequence matches the forward pass exactly.
    fn register(&mut self, tag_pos: usize) {
        if self.resolve_depth == 0 {
            self.objects.push(tag_pos);
        }
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
        let b = self
            .buf
            .get(self.pos..self.pos + 8)
            .ok_or("double off end")?;
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
                0xfe | 0x00 => self.pos += 1,
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
                format!("{n}")
            }),
            _ => None,
        }
    }

    // Each arm is a distinct structured-clone wire tag documented inline; some decode to the same
    // Rust value (e.g. 'T'/'y' → true). Keep them one-per-tag rather than merging by body.
    #[allow(clippy::match_same_arms)]
    fn value(&mut self) -> SsvResult {
        self.skip_padding();
        let tag_pos = self.pos; // the offset to re-decode this value from if it's a back-ref target
        let tag = *self.buf.get(self.pos).ok_or("value() past end")?;
        self.pos += 1;
        match tag {
            0x5f => Ok(Ssv::Undefined),
            0x30 => Ok(Ssv::Null),
            0x54 => Ok(Ssv::Bool(true)),
            0x46 => Ok(Ssv::Bool(false)),
            0x49 => Ok(Ssv::Num(self.zigzag()? as f64)), // 'I' int32
            0x55 => Ok(Ssv::Num(self.varint()? as f64)), // 'U' uint32
            0x4e => Ok(Ssv::Num(self.double()?)),        // 'N' double
            0x44 => Ok(Ssv::Date(self.double()?)),       // 'D' date
            0x5a => self.bigint(),                       // 'Z' bigint
            0x6e => Ok(Ssv::Num(self.double()?)),        // 'n' Number object
            0x79 => Ok(Ssv::Bool(true)),                 // 'y' true object
            0x78 => Ok(Ssv::Bool(false)),                // 'x' false object
            0x73 => self.value(),                        // 's' String object
            0x7a => self.bigint(),                       // 'z' BigInt object
            0x42 => self.array_buffer(false, tag_pos),   // 'B' ArrayBuffer
            0x7e => self.array_buffer(true, tag_pos),    // '~' resizable ArrayBuffer
            0x56 => self.array_buffer_view(),            // 'V' ArrayBufferView
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
                let units: Vec<u16> = b
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
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
            0x6f => self.object(tag_pos),       // 'o'
            0x41 => self.dense_array(tag_pos),  // 'A'
            0x61 => self.sparse_array(tag_pos), // 'a'
            0x3b => self.map(tag_pos),          // ';'
            0x27 => self.set(tag_pos),          // '\''
            0x52 => self.regexp(),              // 'R' (no receiver id)
            0x5e => {
                // '^' object reference — re-decode the target from its recorded byte offset (the ref
                // table holds offsets, not cloned values). resolve_depth>0 makes that re-decode register
                // no new ids (the id was assigned on the forward pass); the acyclic corpus guarantees
                // the target is fully decoded before it's referenced. The depth cap fails a (absent)
                // cycle gracefully instead of recursing forever.
                let id = self.varint()? as usize;
                let off = *self
                    .objects
                    .get(id)
                    .ok_or_else(|| format!("objref #{id} out of range"))?;
                if self.resolve_depth > 1024 {
                    return Err("back-ref resolve too deep (cycle?)".into());
                }
                let save = self.pos;
                self.pos = off;
                self.resolve_depth += 1;
                let v = self.value();
                self.resolve_depth -= 1;
                self.pos = save;
                v
            }
            0x5c => self.host_object(tag_pos), // '\' host object
            _ => Err(format!("unknown tag 0x{tag:x}")),
        }
    }

    fn bigint(&mut self) -> SsvResult {
        let bitfield = self.varint()?;
        let byte_len = (bitfield >> 1) as usize;
        let b = self
            .buf
            .get(self.pos..self.pos + byte_len)
            .ok_or("bigint off end")?;
        let le = b.to_vec();
        self.pos += byte_len;
        Ok(Ssv::BigInt {
            neg: bitfield & 1 != 0,
            le,
        })
    }

    fn array_buffer(&mut self, resizable: bool, tag_pos: usize) -> SsvResult {
        let n = self.varint()? as usize;
        if resizable {
            self.varint()?; // maxByteLength
        }
        let b = self
            .buf
            .get(self.pos..self.pos + n)
            .ok_or("arrayBuffer off end")?
            .to_vec();
        self.pos += n;
        self.register(tag_pos); // ArrayBuffers get a receiver id
        Ok(Ssv::Bytes(b))
    }

    fn array_buffer_view(&mut self) -> SsvResult {
        self.pos += 1; // view subtype
        self.varint()?; // byteOffset
        let len = self.varint()?; // byteLength
        self.varint()?; // flags
        Ok(Ssv::ArrayBufferView(len))
    }

    fn object(&mut self, tag_pos: usize) -> SsvResult {
        self.register(tag_pos); // reserve this container's receiver id on ENTRY
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
        Ok(Ssv::Object(props))
    }

    fn dense_array(&mut self, tag_pos: usize) -> SsvResult {
        let len = self.varint()? as usize;
        self.register(tag_pos);
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
            set_array_elem(&mut items, &mut props, &key, val);
        }
        self.pos += 1;
        self.varint()?;
        self.varint()?;
        Ok(Ssv::Array { items, props })
    }

    fn sparse_array(&mut self, tag_pos: usize) -> SsvResult {
        let len = self.varint()? as usize;
        self.register(tag_pos);
        let mut items = vec![Ssv::Undefined; len]; // holes → undefined (JS new Array(len))
        let mut props: Vec<(String, Ssv)> = Vec::new();
        while self.peek() != Some(0x40) {
            // '@'
            if self.eof() {
                return Err("sparseArray unterminated".into());
            }
            let key = self.value()?;
            let val = self.value()?;
            set_array_elem(&mut items, &mut props, &key, val);
        }
        self.pos += 1;
        self.varint()?;
        self.varint()?;
        Ok(Ssv::Array { items, props })
    }

    fn map(&mut self, tag_pos: usize) -> SsvResult {
        self.register(tag_pos);
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
        Ok(Ssv::Object(props))
    }

    fn set(&mut self, tag_pos: usize) -> SsvResult {
        self.register(tag_pos);
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
        Ok(Ssv::Array {
            items,
            props: Vec::new(),
        })
    }

    fn regexp(&mut self) -> SsvResult {
        let pattern = self.value()?;
        let flags = self.varint()?;
        Ok(Ssv::Regexp {
            pattern: Box::new(pattern),
            flags,
        })
    }

    fn utf8_string(&mut self) -> Result<String, String> {
        let n = self.varint()? as usize;
        let b = self
            .buf
            .get(self.pos..self.pos + n)
            .ok_or("utf8String off end")?;
        let s = String::from_utf8_lossy(b).into_owned();
        self.pos += n;
        Ok(s)
    }

    fn host_object(&mut self, tag_pos: usize) -> SsvResult {
        let subtag = *self.buf.get(self.pos).ok_or("hostObject off end")?;
        self.pos += 1;
        let marker = match subtag {
            0x69 => Ssv::BlobIndex {
                index: self.varint()?,
                file: false,
            }, // 'i' kBlobIndexTag
            0x65 => Ssv::BlobIndex {
                index: self.varint()?,
                file: true,
            }, // 'e' kFileIndexTag
            0x62 => {
                // 'b' kBlobTag: uuid, type, size
                self.utf8_string()?; // uuid (discarded)
                let blob_type = self.utf8_string()?;
                let size = self.varint()?;
                Ssv::Blob { blob_type, size }
            }
            _ => return Err(format!("unknown host-object tag 0x{subtag:x}")),
        };
        self.register(tag_pos);
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

// A property key is a JS array index iff ToString(ToUint32(P)) == P and ToUint32(P) != 2^32-1.
fn array_index(v: &Ssv) -> Option<usize> {
    match v {
        Ssv::Num(n) if *n >= 0.0 && n.fract() == 0.0 && *n < 4_294_967_295.0 => Some(*n as usize),
        Ssv::Str(s) => s
            .parse::<u32>()
            .ok()
            .and_then(|u| (u != u32::MAX && *s == u.to_string()).then_some(u as usize)),
        _ => None,
    }
}

// JS `arr[key] = val`: an array-index key lands in the indexed slots (extending with holes), any
// other key becomes an own property. The canonical serializes only the indexed items — so an array
// encoded as (index,value) pairs (sparse form, or dense trailing props) reconstructs correctly.
fn set_array_elem(items: &mut Vec<Ssv>, props: &mut Vec<(String, Ssv)>, key: &Ssv, val: Ssv) {
    if let Some(idx) = array_index(key) {
        if idx >= items.len() {
            items.resize(idx + 1, Ssv::Undefined);
        }
        items[idx] = val;
    } else if let Some(k) = Reader::key_string(key) {
        push_prop(props, k, val);
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

// ---- canonical serialization (for the cross-language differential; see harness/diff-ssv.mjs) ----
// Deterministic byte form of a decoded value. Object keys sorted by UTF-8 bytes on BOTH sides (the
// TS harness sorts identically), so decoder-content bugs surface while JS's integer-key iteration
// order — validated elsewhere — doesn't cause false diffs. Array own-properties are ignored on both
// sides (indexed items only). Markers are emitted as their TS object-equivalents so an enum variant
// here and a plain marker object there produce identical bytes.
fn varint_out(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n != 0 {
            out.push(b | 0x80);
        } else {
            out.push(b);
            break;
        }
    }
}

pub fn canonical(v: &Ssv, out: &mut Vec<u8>) {
    match v {
        Ssv::Undefined => out.push(b'u'),
        Ssv::Null => out.push(b'n'),
        Ssv::Bool(true) => out.push(b'T'),
        Ssv::Bool(false) => out.push(b'F'),
        Ssv::Num(f) => {
            out.push(b'd');
            out.extend_from_slice(&f.to_le_bytes());
        }
        Ssv::Date(f) => {
            out.push(b'M');
            out.extend_from_slice(&f.to_le_bytes());
        }
        Ssv::BigInt { neg, le } => {
            out.push(b'G');
            out.push(u8::from(*neg));
            let mut end = le.len(); // trim trailing zero bytes (LE) → minimal magnitude
            while end > 0 && le[end - 1] == 0 {
                end -= 1;
            }
            varint_out(out, end as u64);
            out.extend_from_slice(&le[..end]);
        }
        Ssv::Str(s) => {
            out.push(b's');
            varint_out(out, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Ssv::Bytes(b) => {
            out.push(b'b');
            varint_out(out, b.len() as u64);
            out.extend_from_slice(b);
        }
        Ssv::Object(props) => {
            out.push(b'{');
            let mut sorted: Vec<&(String, Ssv)> = props.iter().collect();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            for (k, val) in sorted {
                varint_out(out, k.len() as u64);
                out.extend_from_slice(k.as_bytes());
                canonical(val, out);
            }
            out.push(b'}');
        }
        Ssv::Array { items, .. } => {
            out.push(b'[');
            varint_out(out, items.len() as u64);
            for it in items {
                canonical(it, out);
            }
            out.push(b']');
        }
        // markers → their TS object-equivalents
        Ssv::ArrayBufferView(len) => canonical(
            &Ssv::Object(vec![("__arrayBufferView".into(), Ssv::Num(*len as f64))]),
            out,
        ),
        Ssv::Regexp { pattern, flags } => canonical(
            &Ssv::Object(vec![
                ("__regexp".into(), (**pattern).clone()),
                ("flags".into(), Ssv::Num(*flags as f64)),
            ]),
            out,
        ),
        Ssv::Blob { blob_type, size } => canonical(
            &Ssv::Object(vec![(
                "__blob".into(),
                Ssv::Object(vec![
                    ("type".into(), Ssv::Str(blob_type.clone())),
                    ("size".into(), Ssv::Num(*size as f64)),
                ]),
            )]),
            out,
        ),
        Ssv::BlobIndex { index, file } => {
            let mut props = vec![("__blobIndex".into(), Ssv::Num(*index as f64))];
            if *file {
                props.push(("__file".into(), Ssv::Bool(true)));
            }
            canonical(&Ssv::Object(props), out);
        }
        Ssv::ExternalBlob { method } => canonical(
            &Ssv::Object(vec![
                ("__externalBlob".into(), Ssv::Bool(true)),
                ("method".into(), Ssv::Num(*method as f64)),
            ]),
            out,
        ),
        Ssv::Partial(root) => match &**root {
            Ssv::Object(props) => {
                let mut p = props.clone();
                p.push(("__partial".into(), Ssv::Bool(true)));
                canonical(&Ssv::Object(p), out);
            }
            other => canonical(other, out),
        },
    }
}

/// Deserialize a value payload (post-envelope). `lenient` returns the partially-decoded root on error.
pub fn deserialize(buf: &[u8], lenient: bool) -> SsvResult {
    let mut r = Reader::new(buf);
    r.header();
    match r.value() {
        Ok(v) => Ok(v),
        Err(e) => {
            // lenient best-effort: recover the partially-decoded root. The ref table stores offsets, not values, so
            // re-decode the root from its offset (resolve_depth>0 ⇒ register no ids). Matches the old
            // behaviour (a completed root → Partial; a truncated root → Err). No production caller passes
            // lenient=true — kept for parity with the TS decoder's `__partial` path.
            if lenient && !r.objects.is_empty() {
                r.pos = r.objects[0];
                r.resolve_depth = 1;
                if let Ok(root) = r.value() {
                    if !matches!(root, Ssv::Null) {
                        return Ok(Ssv::Partial(Box::new(root)));
                    }
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
        let c = *value
            .get(pos)
            .ok_or("decode_value: version varint off end")?;
        pos += 1;
        if c & 0x80 == 0 {
            break;
        }
    }
    let blob = &value[pos..];
    if blob.first() == Some(&0xff) && blob.get(1) == Some(&0x11) {
        let method = *blob.get(2).ok_or("decode_value: truncated wrapper")?;
        if method == 0x02 {
            let un = crate::snappy::uncompress(&blob[3..])
                .map_err(|_| "decode_value: snappy failed".to_string())?;
            return deserialize(&un, lenient);
        }
        return Ok(Ssv::ExternalBlob { method });
    }
    deserialize(blob, lenient)
}
