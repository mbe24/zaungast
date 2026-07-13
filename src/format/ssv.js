// Blink/V8 structured-clone deserializer for Teams IndexedDB values.
// Tag refs: v8 src/objects/value-serializer.cc
//
// Value tags used here:
//   0xFF version, 0xFE blink-envelope, 0x00 padding
//   '_' undefined, '0' null, 'T' true, 'F' false
//   'I' int32 (zigzag varint), 'U' uint32 varint, 'N' double(8 LE), 'D' date(double ms)
//   'B' bigint (bitfield varint + words), '"' one-byte str, 'c' two-byte(utf16le), 'S' utf8
//   'o' begin object, '{' end object (+varint propCount)
//   'A' begin dense array (+varint len), '$' end dense array (+varint props,+varint len)
//   'a' begin sparse array (+varint len), '@' end sparse array (+varint props,+varint len)
//   ';' begin map, ':' end map ; '\'' begin set, ',' end set
//   'R' regexp (str + varint flags)

class Reader {
  constructor(buf, opts = {}) {
    this.buf = buf
    this.pos = 0
    this.trace = opts.debug ? [] : null
    // V8 assigns an incrementing id to every JS receiver (object/array/map/set/…) as it is
    // entered; kObjectReference ('^') + varint(id) refers back to one. Register on ENTRY so
    // forward refs / cycles resolve. Primitives and strings get no id.
    this.objects = []
  }
  eof() { return this.pos >= this.buf.length }
  // V8 pads with 0x00 before two-byte strings to keep their data 2-byte aligned. 0x00 is
  // never a valid tag or terminator, so skipping it wherever we expect one is safe.
  skipPadding() { while (this.pos < this.buf.length && this.buf[this.pos] === 0x00) this.pos++ }
  peek() { this.skipPadding(); return this.buf[this.pos] }
  log(desc) { if (this.trace) { this.trace.push(`@${this.pos} ${desc}`); if (this.trace.length > 60) this.trace.shift() } }

  varint() {
    let v = 0, shift = 0
    while (true) {
      if (this.pos >= this.buf.length) throw this.err('varint ran off end')
      const c = this.buf[this.pos++]
      v += (c & 0x7f) * 2 ** shift
      if (!(c & 0x80)) break
      shift += 7
    }
    return v
  }
  zigzag() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2 }
  double() { const d = this.buf.readDoubleLE(this.pos); this.pos += 8; return d }
  bytes(n) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b }

  err(msg) {
    const e = new Error(`SSV: ${msg} at pos ${this.pos}/${this.buf.length}`)
    if (this.trace) e.trace = this.trace.slice()
    return e
  }

  header() {
    // The value is wrapped in a Blink envelope + a V8 envelope, and occasionally an extra
    // outer Blink envelope. Each envelope is `0xFF <version>`; a Blink version >= 21 adds
    // `0xFE` + a 12-byte trailer (8-byte offset + 4-byte size). The real payload root is a
    // JS object (0x6F). Anchor on the LAST `0xFF <ver> [0xFE + 12] [0x00…] 0x6F` in the
    // small preamble — this transparently skips any number of nested envelopes.
    const scan = Math.min(this.buf.length - 1, 48)
    let root = -1
    for (let i = 0; i < scan; i++) {
      if (this.buf[i] !== 0xff) continue
      let j = i + 2 // skip 0xFF + version byte
      if (this.buf[j] === 0xfe) j += 1 + 12 // trailer offset(8) + size(4)
      while (this.buf[j] === 0x00) j++
      if (this.buf[j] === 0x6f) root = j
    }
    if (root >= 0) { this.pos = root; return }
    // Fallback: consume 0xFF<ver>/0xFE/0x00 runs until a real value tag.
    while (!this.eof()) {
      const b = this.buf[this.pos]
      if (b === 0xff) { this.pos += 2; continue }
      if (b === 0xfe) { this.pos += 1; continue }
      if (b === 0x00) { this.pos += 1; continue }
      break
    }
  }

  value() {
    this.skipPadding()
    if (this.pos >= this.buf.length) throw this.err('value() past end')
    const tag = this.buf[this.pos++]
    switch (tag) {
      case 0x5f: this.log('undefined'); return undefined
      case 0x30: this.log('null'); return null
      case 0x54: this.log('true'); return true
      case 0x46: this.log('false'); return false
      case 0x49: { const v = this.zigzag(); this.log(`int32 ${v}`); return v }
      case 0x55: { const v = this.varint(); this.log(`uint32 ${v}`); return v }
      case 0x4e: { const d = this.double(); this.log(`double ${d}`); return d }
      case 0x44: { const d = this.double(); this.log(`date ${d}`); return new Date(d) }
      case 0x5a: return this.bigint()                                    // 'Z' bigint
      case 0x6e: { const d = this.double(); this.log(`NumberObj ${d}`); return d } // 'n' Number object
      case 0x79: this.log('BoolObj'); return true                        // 'y' true object
      case 0x78: this.log('BoolObj'); return false                       // 'x' false object
      case 0x73: this.log('StringObj'); return this.value()             // 's' String object → wraps a string value
      case 0x7a: return this.bigint()                                    // 'z' BigInt object
      case 0x42: return this.arrayBuffer()                               // 'B' ArrayBuffer
      case 0x7e: return this.arrayBuffer(true)                           // '~' resizable ArrayBuffer
      case 0x56: return this.arrayBufferView()                           // 'V' ArrayBufferView
      case 0x22: { const n = this.varint(); const s = this.bytes(n).toString('latin1'); this.log(`str1(${n}) ${JSON.stringify(s.slice(0, 24))}`); return s }
      case 0x63: { const n = this.varint(); const s = this.bytes(n).toString('utf16le'); this.log(`str2(${n})`); return s }
      case 0x53: { const n = this.varint(); const s = this.bytes(n).toString('utf8'); this.log(`utf8(${n})`); return s }
      case 0x6f: this.log('BEGIN_OBJ'); return this.object()
      case 0x41: this.log('BEGIN_DENSE'); return this.denseArray()
      case 0x61: this.log('BEGIN_SPARSE'); return this.sparseArray()
      case 0x3b: this.log('BEGIN_MAP'); return this.map()
      case 0x27: this.log('BEGIN_SET'); return this.set()
      case 0x52: return this.regexp()
      case 0x5e: { const id = this.varint(); this.log(`objref #${id}`); return this.objects[id] } // '^'
      default: throw this.err(`unknown tag 0x${tag.toString(16)} ('${tag >= 0x20 && tag < 0x7f ? String.fromCharCode(tag) : '.'}')`)
    }
  }

  bigint() {
    const bitfield = this.varint()
    const byteLength = bitfield >> 1
    this.pos += byteLength // skip digits (we don't need exact bigint value)
    this.log(`bigint ${byteLength}B`)
    return 0n
  }

  arrayBuffer(resizable = false) {
    const byteLength = this.varint()
    if (resizable) this.varint() // maxByteLength
    const bytes = this.bytes(byteLength)
    const buf = Buffer.from(bytes)
    this.objects.push(buf) // ArrayBuffers get an object id
    this.log(`arrayBuffer ${byteLength}B`)
    return buf
  }

  // 'V' ArrayBufferView: subtag(1) + byteOffset(varint) + byteLength(varint) + flags(varint).
  // Follows a value that yielded an ArrayBuffer; we just skip the metadata and return a marker.
  arrayBufferView() {
    this.pos++            // view subtype tag
    this.varint()         // byteOffset
    const len = this.varint() // byteLength
    this.varint()         // flags (tracking / length-tracking)
    this.log(`arrayBufferView ${len}B`)
    return { __arrayBufferView: len }
  }

  // read key/value pairs until `endTag`, return count consumed via terminator handling by caller
  object() {
    const obj = {}
    this.objects.push(obj)
    while (this.peek() !== 0x7b) { // '{'
      if (this.pos >= this.buf.length) throw this.err('object unterminated')
      const key = this.value()
      const val = this.value()
      if (typeof key === 'string' || typeof key === 'number') obj[key] = val
    }
    this.pos++            // consume '{'
    this.varint()         // property count
    this.log('END_OBJ')
    return obj
  }

  denseArray() {
    const len = this.varint()
    const arr = []
    this.objects.push(arr)
    for (let i = 0; i < len; i++) arr.push(this.value())
    // trailing own-properties (key/value) until '$'
    while (this.peek() !== 0x24) { // '$'
      if (this.pos >= this.buf.length) throw this.err('denseArray unterminated')
      const key = this.value(); const val = this.value()
      if (typeof key === 'string' || typeof key === 'number') arr[key] = val
    }
    this.pos++; this.varint(); this.varint()
    this.log(`END_DENSE len=${len}`)
    return arr
  }

  sparseArray() {
    const len = this.varint()
    const arr = new Array(len)
    this.objects.push(arr)
    while (this.peek() !== 0x40) { // '@'
      if (this.pos >= this.buf.length) throw this.err('sparseArray unterminated')
      const idx = this.value()
      const val = this.value()
      if (typeof idx === 'number' || typeof idx === 'string') arr[idx] = val
    }
    this.pos++; this.varint(); this.varint()
    this.log(`END_SPARSE len=${len}`)
    return arr
  }

  map() {
    const m = {}
    this.objects.push(m)
    while (this.peek() !== 0x3a) { // ':'
      if (this.pos >= this.buf.length) throw this.err('map unterminated')
      const k = this.value(); const v = this.value(); m[k] = v
    }
    this.pos++; this.varint()
    this.log('END_MAP')
    return m
  }

  set() {
    const s = []
    this.objects.push(s)
    while (this.peek() !== 0x2c) { // ','
      if (this.pos >= this.buf.length) throw this.err('set unterminated')
      s.push(this.value())
    }
    this.pos++; this.varint()
    this.log('END_SET')
    return s
  }

  regexp() {
    const pattern = this.value()
    const flags = this.varint()
    return { __regexp: pattern, flags }
  }
}

export function deserialize(buf, opts = {}) {
  const r = new Reader(buf, opts)
  r.header()
  try {
    return r.value()
  } catch (e) {
    // Lenient: return the partially-decoded root (fields decoded before the failure).
    // Chat fields (content/sender/time) appear early, so they survive an unsupported
    // embedded structure (e.g. a Blob HostObject) later in the record.
    if (opts.lenient && r.objects.length) { const root = r.objects[0]; if (root) { root.__partial = true; return root } }
    throw e
  }
}

// debug helper: returns {value?, error?, trace}
export function deserializeDebug(buf) {
  const r = new Reader(buf, { debug: true })
  try { r.header(); const v = r.value(); return { value: v, trace: r.trace } }
  catch (e) { return { error: e.message, trace: e.trace ?? r.trace } }
}
