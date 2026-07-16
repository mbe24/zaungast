// Blink/V8 structured-clone deserializer for Teams IndexedDB values.
// Tag refs: v8 src/objects/value-serializer.cc
//
// Value tags used here:
//   0xFF version, 0xFE blink-envelope, 0x00 padding
//   '_' undefined, '0' null, 'T' true, 'F' false
//   'I' int32 (zigzag varint), 'U' uint32 varint, 'N' double(8 LE), 'D' date(double ms)
//   'Z'/'z' bigint (bitfield varint + LE magnitude bytes), '"' one-byte str, 'c' two-byte(utf16le), 'S' utf8
//   'o' begin object, '{' end object (+varint propCount)
//   'A' begin dense array (+varint len), '$' end dense array (+varint props,+varint len)
//   'a' begin sparse array (+varint len), '@' end sparse array (+varint props,+varint len)
//   ';' begin map, ':' end map ; '\'' begin set, ',' end set
//   'R' regexp (str + varint flags)
import type {
  ArrayBufferViewMarker,
  DeserializeOptions,
  HostObjectMarker,
  RegExpMarker,
  SsvValue,
} from '../types.js';

// Error thrown by Reader.err(), carrying the last N trace entries for deserializeDebug().
interface SsvError extends Error {
  trace?: string[];
}

// The structured-clone stream can yield ANY decoded value as an object/array/map key or
// index (V8's ToPropertyKey coercion applies to whatever came out of the stream at runtime).
// TypeScript can't express "index by whatever this dynamic value coerces to" — this cast is
// type-only (erased at runtime) and does not change the property assignment's behavior; it
// runs exactly as the untyped original did (`target[key] = val`).
function setProp(target: object, key: unknown, val: unknown): void {
  (target as Record<string, unknown>)[key as string] = val;
}

class Reader {
  buf: Buffer;
  pos: number;
  trace: string[] | null;
  // V8 assigns an incrementing id to every JS receiver (object/array/map/set/…) as it is
  // entered; kObjectReference ('^') + varint(id) refers back to one. Register on ENTRY so
  // forward refs / cycles resolve. Primitives and strings get no id.
  objects: unknown[];

  constructor(buf: Buffer, opts: DeserializeOptions = {}) {
    this.buf = buf;
    this.pos = 0;
    this.trace = opts.debug ? [] : null;
    this.objects = [];
  }
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  // V8 pads with 0x00 before two-byte strings to keep their data 2-byte aligned. 0x00 is
  // never a valid tag or terminator, so skipping it wherever we expect one is safe.
  skipPadding(): void {
    while (this.pos < this.buf.length && this.buf[this.pos] === 0x00) this.pos++;
  }
  peek(): number {
    this.skipPadding();
    return this.buf[this.pos];
  }
  log(desc: string): void {
    if (this.trace) {
      this.trace.push(`@${this.pos} ${desc}`);
      if (this.trace.length > 60) this.trace.shift();
    }
  }

  varint(): number {
    // Fast path: single-byte varint (high bit clear) — the common case. `this.buf[pos]` is
    // `undefined` when past end; `undefined < 0x80` is false, so we correctly fall into the
    // loop below which throws 'varint ran off end' (error behavior preserved).
    const c0 = this.buf[this.pos];
    if (c0 < 0x80) {
      this.pos++;
      return c0;
    }
    let v = 0,
      shift = 0;
    while (true) {
      if (this.pos >= this.buf.length) throw this.err('varint ran off end');
      const c = this.buf[this.pos++];
      v += (c & 0x7f) * 2 ** shift;
      if (!(c & 0x80)) break;
      shift += 7;
    }
    return v;
  }
  zigzag(): number {
    const v = this.varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }
  double(): number {
    const d = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return d;
  }
  bytes(n: number): Buffer {
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  err(msg: string): SsvError {
    const e = new Error(`SSV: ${msg} at pos ${this.pos}/${this.buf.length}`) as SsvError;
    if (this.trace) e.trace = this.trace.slice();
    return e;
  }

  // Anchor on the LAST `0xFF <ver> [0xFE + 12-byte trailer] [0x00…] 0x6F` in the small preamble —
  // this transparently skips any number of nested envelopes. Returns the object-root offset, or
  // -1 if none was found.
  findEnvelopeRoot(): number {
    const scan = Math.min(this.buf.length - 1, 48);
    let root = -1;
    for (let i = 0; i < scan; i++) {
      if (this.buf[i] !== 0xff) continue;
      let j = i + 2; // skip 0xFF + version byte
      if (this.buf[j] === 0xfe) j += 1 + 12; // trailer offset(8) + size(4)
      while (this.buf[j] === 0x00) j++;
      if (this.buf[j] === 0x6f) root = j;
    }
    return root;
  }

  // Fallback when no object root is found: consume 0xFF<ver> / 0xFE / 0x00 runs until a real tag.
  skipEnvelopePreamble(): void {
    while (!this.eof()) {
      const b = this.buf[this.pos];
      if (b === 0xff) {
        this.pos += 2;
        continue;
      }
      if (b === 0xfe) {
        this.pos += 1;
        continue;
      }
      if (b === 0x00) {
        this.pos += 1;
        continue;
      }
      break;
    }
  }

  header(): void {
    // The value is wrapped in a Blink envelope + a V8 envelope, and occasionally an extra outer
    // Blink envelope. Each envelope is `0xFF <version>`; a Blink version >= 21 adds `0xFE` + a
    // 12-byte trailer (8-byte offset + 4-byte size). The real payload root is a JS object (0x6F).
    const root = this.findEnvelopeRoot();
    if (root >= 0) {
      this.pos = root;
      return;
    }
    this.skipEnvelopePreamble();
  }

  value(): unknown {
    // Hoist trace once: the per-case log-string arguments are only built when tracing is on.
    const trace = this.trace;
    this.skipPadding();
    if (this.pos >= this.buf.length) throw this.err('value() past end');
    const tag = this.buf[this.pos++];
    switch (tag) {
      case 0x5f:
        if (trace) this.log('undefined');
        return undefined;
      case 0x30:
        if (trace) this.log('null');
        return null;
      case 0x54:
        if (trace) this.log('true');
        return true;
      case 0x46:
        if (trace) this.log('false');
        return false;
      case 0x49: {
        const v = this.zigzag();
        if (trace) this.log(`int32 ${v}`);
        return v;
      }
      case 0x55: {
        const v = this.varint();
        if (trace) this.log(`uint32 ${v}`);
        return v;
      }
      case 0x4e: {
        const d = this.double();
        if (trace) this.log(`double ${d}`);
        return d;
      }
      case 0x44: {
        const d = this.double();
        if (trace) this.log(`date ${d}`);
        return new Date(d);
      }
      case 0x5a:
        return this.bigint(); // 'Z' bigint
      case 0x6e: {
        const d = this.double();
        if (trace) this.log(`NumberObj ${d}`);
        return d;
      } // 'n' Number object
      case 0x79:
        if (trace) this.log('BoolObj');
        return true; // 'y' true object
      case 0x78:
        if (trace) this.log('BoolObj');
        return false; // 'x' false object
      case 0x73:
        if (trace) this.log('StringObj');
        return this.value(); // 's' String object → wraps a string value
      case 0x7a:
        return this.bigint(); // 'z' BigInt object
      case 0x42:
        return this.arrayBuffer(); // 'B' ArrayBuffer
      case 0x7e:
        return this.arrayBuffer(true); // '~' resizable ArrayBuffer
      case 0x56:
        return this.arrayBufferView(); // 'V' ArrayBufferView
      case 0x22: {
        const n = this.varint();
        // Decode straight from the backing buffer (no intermediate subarray alloc).
        const s = this.buf.toString('latin1', this.pos, this.pos + n);
        this.pos += n;
        if (trace) this.log(`str1(${n}) ${JSON.stringify(s.slice(0, 24))}`);
        return s;
      }
      case 0x63: {
        const n = this.varint();
        const s = this.buf.toString('utf16le', this.pos, this.pos + n);
        this.pos += n;
        if (trace) this.log(`str2(${n})`);
        return s;
      }
      case 0x53: {
        const n = this.varint();
        const s = this.buf.toString('utf8', this.pos, this.pos + n);
        this.pos += n;
        if (trace) this.log(`utf8(${n})`);
        return s;
      }
      case 0x6f:
        if (trace) this.log('BEGIN_OBJ');
        return this.object();
      case 0x41:
        if (trace) this.log('BEGIN_DENSE');
        return this.denseArray();
      case 0x61:
        if (trace) this.log('BEGIN_SPARSE');
        return this.sparseArray();
      case 0x3b:
        if (trace) this.log('BEGIN_MAP');
        return this.map();
      case 0x27:
        if (trace) this.log('BEGIN_SET');
        return this.set();
      case 0x52:
        return this.regexp();
      case 0x5e: {
        const id = this.varint();
        if (trace) this.log(`objref #${id}`);
        return this.objects[id];
      } // '^'
      case 0x5c:
        return this.hostObject(); // '\' kHostObject — Blink DOM extension (Blob/File)
      default:
        throw this.err(
          `unknown tag 0x${tag.toString(16)} ('${tag >= 0x20 && tag < 0x7f ? String.fromCharCode(tag) : '.'}')`, // NOSONAR S7758 — UTF-16 code units by design (see verify.ts round-trip)
        );
    }
  }

  bigint(): bigint {
    // bitfield = (byteLength << 1) | signBit; then `byteLength` magnitude bytes, little-endian.
    const bitfield = this.varint();
    const byteLength = bitfield >> 1;
    let v = 0n;
    for (let i = 0; i < byteLength; i++) v |= BigInt(this.buf[this.pos + i]) << BigInt(8 * i);
    this.pos += byteLength;
    if (this.trace) this.log(`bigint ${byteLength}B`);
    return bitfield & 1 ? -v : v;
  }

  arrayBuffer(resizable = false): Buffer {
    const byteLength = this.varint();
    if (resizable) this.varint(); // maxByteLength
    const bytes = this.bytes(byteLength);
    const buf = Buffer.from(bytes);
    this.objects.push(buf); // ArrayBuffers get an object id
    if (this.trace) this.log(`arrayBuffer ${byteLength}B`);
    return buf;
  }

  // 'V' ArrayBufferView: subtag(1) + byteOffset(varint) + byteLength(varint) + flags(varint).
  // Follows a value that yielded an ArrayBuffer; we just skip the metadata and return a marker.
  arrayBufferView(): ArrayBufferViewMarker {
    this.pos++; // view subtype tag
    this.varint(); // byteOffset
    const len = this.varint(); // byteLength
    this.varint(); // flags (tracking / length-tracking)
    if (this.trace) this.log(`arrayBufferView ${len}B`);
    return { __arrayBufferView: len };
  }

  // read key/value pairs until `endTag`, return count consumed via terminator handling by caller
  object(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    this.objects.push(obj);
    while (this.peek() !== 0x7b) {
      // '{'
      if (this.pos >= this.buf.length) throw this.err('object unterminated');
      const key = this.value();
      const val = this.value();
      if (typeof key === 'string' || typeof key === 'number') setProp(obj, key, val);
    }
    this.pos++; // consume '{'
    this.varint(); // property count
    if (this.trace) this.log('END_OBJ');
    return obj;
  }

  denseArray(): unknown[] {
    const len = this.varint();
    const arr: unknown[] = [];
    this.objects.push(arr);
    for (let i = 0; i < len; i++) arr.push(this.value());
    // trailing own-properties (key/value) until '$'
    while (this.peek() !== 0x24) {
      // '$'
      if (this.pos >= this.buf.length) throw this.err('denseArray unterminated');
      const key = this.value();
      const val = this.value();
      if (typeof key === 'string' || typeof key === 'number') setProp(arr, key, val);
    }
    this.pos++;
    this.varint();
    this.varint();
    if (this.trace) this.log(`END_DENSE len=${len}`);
    return arr;
  }

  sparseArray(): unknown[] {
    const len = this.varint();
    const arr: unknown[] = new Array(len);
    this.objects.push(arr);
    while (this.peek() !== 0x40) {
      // '@'
      if (this.pos >= this.buf.length) throw this.err('sparseArray unterminated');
      const idx = this.value();
      const val = this.value();
      if (typeof idx === 'number' || typeof idx === 'string') setProp(arr, idx, val);
    }
    this.pos++;
    this.varint();
    this.varint();
    if (this.trace) this.log(`END_SPARSE len=${len}`);
    return arr;
  }

  map(): Record<string, unknown> {
    const m: Record<string, unknown> = {};
    this.objects.push(m);
    while (this.peek() !== 0x3a) {
      // ':'
      if (this.pos >= this.buf.length) throw this.err('map unterminated');
      const k = this.value();
      const v = this.value();
      setProp(m, k, v);
    }
    this.pos++;
    this.varint();
    if (this.trace) this.log('END_MAP');
    return m;
  }

  set(): unknown[] {
    const s: unknown[] = [];
    this.objects.push(s);
    while (this.peek() !== 0x2c) {
      // ','
      if (this.pos >= this.buf.length) throw this.err('set unterminated');
      s.push(this.value());
    }
    this.pos++;
    this.varint();
    if (this.trace) this.log('END_SET');
    return s;
  }

  regexp(): RegExpMarker {
    const pattern = this.value();
    const flags = this.varint();
    return { __regexp: pattern, flags };
  }

  // ReadUTF8String: varint(byteLength) + that many UTF-8 bytes. Blink writes Blob uuid/type this
  // way (same coding as the 'S' value tag). Used only for skipping/reading host-object strings.
  utf8String(): string {
    const n = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  // '\' kHostObject: V8 delegates to Blink's V8ScriptValueDeserializer::ReadHostObject, which
  // reads a Blink SerializationTag byte then type-specific fields (v8_script_value_deserializer.cc
  // ReadDOMObject). URL-only design: we do NOT decode media bytes — we parse just enough to
  // advance `this.pos` exactly and return a metadata-only marker. V8's ReadHostObject assigns the
  // host object a ref id (next_id_++ / AddObjectWithID), so we register the marker on this.objects
  // to keep back-references ('^') aligned. Strings are ReadUTF8String (varint len + utf8), and
  // sizes/indices are ReadUint32/ReadUint64 (varint). In this corpus all occurrences are Blobs
  // (app-icon 'imageBlob' fields) serialized as kBlobIndexTag with index 0.
  // For an UNKNOWN Blink SerializationTag we THROW — an unknown-length structure can't be safely
  // skipped, so we stay correct rather than guessing (e.g. kFileTag 'f', whose layout is
  // version-gated, lands here).
  hostObject(): HostObjectMarker {
    const subtag = this.buf[this.pos++]; // Blink SerializationTag
    let marker: HostObjectMarker;
    switch (subtag) {
      case 0x69: // 'i' kBlobIndexTag: ReadUint32(index)
        marker = { __blobIndex: this.varint() };
        break;
      case 0x65: // 'e' kFileIndexTag: ReadUint32(index)
        marker = { __blobIndex: this.varint(), __file: true };
        break;
      case 0x62: {
        // 'b' kBlobTag: ReadUTF8String(uuid), ReadUTF8String(type), ReadUint64(size)
        this.utf8String(); // uuid (discarded — not media, but no downstream use)
        const type = this.utf8String();
        const size = this.varint(); // uint64; real blob sizes fit in a JS safe integer
        marker = { __blob: { type, size } };
        break;
      }
      default:
        throw this.err(
          `unknown host-object tag 0x${subtag.toString(16)} ('${subtag >= 0x20 && subtag < 0x7f ? String.fromCharCode(subtag) : '.'}')`,
        );
    }
    this.objects.push(marker);
    if (this.trace) this.log(`hostObject 0x${subtag.toString(16)}`);
    return marker;
  }
}

export function deserialize(buf: Buffer, opts: DeserializeOptions = {}): SsvValue {
  const r = new Reader(buf, opts);
  r.header();
  try {
    return r.value();
  } catch (e) {
    // Lenient: return the partially-decoded root (fields decoded before the failure).
    // Chat fields (content/sender/time) appear early, so they survive an unsupported
    // embedded structure (e.g. a Blob HostObject) later in the record.
    if (opts.lenient && r.objects.length) {
      const root = r.objects[0];
      if (root) {
        (root as Record<string, unknown>).__partial = true;
        return root;
      }
    }
    throw e;
  }
}

// debug helper: returns {value?, error?, trace}
export function deserializeDebug(buf: Buffer): {
  value?: unknown;
  error?: string;
  trace?: string[] | null;
} {
  const r = new Reader(buf, { debug: true });
  try {
    r.header();
    const v = r.value();
    return { value: v, trace: r.trace };
  } catch (e) {
    return { error: (e as SsvError).message, trace: (e as SsvError).trace ?? r.trace };
  }
}
