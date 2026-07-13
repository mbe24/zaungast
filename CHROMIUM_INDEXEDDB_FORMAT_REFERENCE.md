# Chromium IndexedDB On-Disk Format — Technical Reference

**Scope:** Everything needed to build a byte-exact reader for Chromium/WebView2 IndexedDB
LevelDB stores (as used by the new Microsoft Teams client): the LevelDB SSTable/Snappy
container, the IndexedDB LevelDB key/value coding, the Blink `SerializedScriptValue`
envelope, and the V8 `ValueSerializer` structured-clone wire format.

**Verification convention used throughout:**
- **[PRIMARY]** — read directly from Chromium/V8/LevelDB/Snappy source at the cited path/commit.
- **[TRIANGULATED]** — additionally confirmed by an independent re-implementation
  (`ccl_chromium_reader` and/or `dfindexeddb`).
- **[SECONDARY]** — only a forensics write-up or re-implementation, not primary source.
- **[TIME-SENSITIVE]** — a rolling version counter; **read it from the buffer, never hardcode.**
- **[INFERRED / UNCERTAIN]** — could not be pinned to a primary source; flagged for follow-up.

All numeric constants are hex unless noted. All multi-byte integers are **little-endian
unless explicitly stated otherwise** — the two exceptions (LevelDB restart/CRC are LE; the
Blink trailer offset/size are **big-endian**) are called out at each site.

---

## Table of contents

1. [V8 ValueSerializer / ValueDeserializer wire format](#1-v8-valueserializer--valuedeserializer-wire-format)
2. [Blink SerializedScriptValue envelope + host objects](#2-blink-serializedscriptvalue-envelope--host-objects)
3. [Chromium IndexedDB LevelDB coding](#3-chromium-indexeddb-leveldb-coding)
4. [LevelDB table (.ldb / SSTable) + Snappy raw block format](#4-leveldb-table-ldb--sstable--snappy-raw-block-format)
5. [Documentation / version-adaptation strategy](#5-documentation--version-adaptation-strategy)
6. [Sources](#6-sources)

---

## The full nesting, top to bottom

Before the details, the complete containment picture for one IndexedDB object-store record:

```
.ldb / .log file
 └─ LevelDB SSTable                      §4
     └─ data block (Snappy-compressed or raw)   §4
         └─ block entry (prefix-compressed key + value)   §4
             ├─ KEY  = LevelDB internal key = [IDB user key encoding] + 8-byte (seq<<8|type)   §3/§4
             │        where the IDB portion = KeyPrefix + type-specific suffix                §3
             └─ VALUE = varint(version) + SerializedScriptValue blob                          §3
                         └─ Blink envelope: FF <blinkver> [FE <trailer ptr>]                  §2
                             └─ V8 envelope: FF <v8ver>                                        §1/§2
                                 └─ V8 root value (tags…)                                      §1
                                     └─ on kHostObject (0x5C): Blink host-object sub-tag       §2
```

---

# 1. V8 ValueSerializer / ValueDeserializer wire format

**Primary source:** `v8/src/objects/value-serializer.cc`
- `.cc` @ commit `a59996fbddfd1867aa5501283859fd4b6af210ba` (2026-07-01)
- `.h` @ commit `3f4cb1dd32849258430f6b60da620141dcc42400` (2026-04-10, the version-16 bump)

**Structural correction worth knowing:** `enum class SerializationTag` and
`ArrayBufferViewTag` are **not** in `value-serializer.h` (which only forward-declares
`enum class SerializationTag : uint8_t;`). The real enum bodies live in the anonymous
namespace of `value-serializer.cc` (approx. lines 121–245 and 253–266). Only
`kLatestVersion` and the version-history comment sit near the top of the `.cc`.

## 1.1 Complete `SerializationTag` enum [PRIMARY, TRIANGULATED against dfindexeddb]

Every ASCII value below was cross-checked against `dfindexeddb`'s `definitions.py`
(which is pinned to an older V8 at `LATEST_VERSION = 15`, so it lacks the two newest tags,
noted below).

| Tag | Char | Hex | Notes |
|---|---|---|---|
| `kVersion` | — | `0xFF` | Header. Followed by version varint. |
| `kPadding` | `\0` | `0x00` | Filler; skip. See §1.6 (2-byte string alignment). |
| `kVerifyObjectCount` | `?` | `0x3F` | Debug/legacy; followed by a varint count. |
| `kTheHole` | `-` | `0x2D` | Array hole (distinct from undefined, ≥ v11). |
| `kUndefined` | `_` | `0x5F` | |
| `kNull` | `0` | `0x30` | |
| `kTrue` | `T` | `0x54` | |
| `kFalse` | `F` | `0x46` | |
| `kInt32` | `I` | `0x49` | Zig-zag varint. |
| `kUint32` | `U` | `0x55` | Varint. |
| `kDouble` | `N` | `0x4E` | 8 raw bytes, host byte order (LE in practice). |
| `kBigInt` | `Z` | `0x5A` | See §1.3. |
| `kUtf8String` | `S` | `0x53` | varint byteLength + UTF-8 bytes. |
| `kOneByteString` | `"` | `0x22` | varint byteLength + Latin-1 bytes. |
| `kTwoByteString` | `c` | `0x63` | varint byteLength + UTF-16LE bytes. See §1.6. |
| `kObjectReference` | `^` | `0x5E` | varint id (into id table). See §1.5. |
| `kBeginJSObject` | `o` | `0x6F` | |
| `kEndJSObject` | `{` | `0x7B` | Followed by varint property count. |
| `kBeginSparseJSArray` | `a` | `0x61` | |
| `kEndSparseJSArray` | `@` | `0x40` | |
| `kBeginDenseJSArray` | `A` | `0x41` | |
| `kEndDenseJSArray` | `$` | `0x24` | |
| `kDate` | `D` | `0x44` | 8-byte double, ms since epoch. See §1.4. |
| `kTrueObject` | `y` | `0x79` | Boxed `Boolean(true)`. |
| `kFalseObject` | `x` | `0x78` | Boxed `Boolean(false)`. |
| `kNumberObject` | `n` | `0x6E` | Boxed Number: 8-byte double. |
| `kBigIntObject` | `z` | `0x7A` | Boxed BigInt: same payload as `kBigInt`. |
| `kStringObject` | `s` | `0x73` | Boxed String: a string value. |
| `kRegExp` | `R` | `0x52` | string + flags varint. See §1.4. |
| `kBeginJSMap` | `;` | `0x3B` | |
| `kEndJSMap` | `:` | `0x3A` | Followed by varint (2×entry count). |
| `kBeginJSSet` | `'` | `0x27` | |
| `kEndJSSet` | `,` | `0x2C` | Followed by varint element count. |
| `kArrayBuffer` | `B` | `0x42` | varint byteLength + raw bytes. See §1.2. |
| `kImmutableArrayBuffer` | `C` | `0x43` | **NEW** (post-v15). Wire-identical to `kArrayBuffer`. |
| `kResizableArrayBuffer` | `~` | `0x7E` | varint byteLength + varint maxByteLength + bytes. |
| `kArrayBufferTransfer` | `t` | `0x74` | varint transfer id (out-of-band). |
| `kArrayBufferView` | `V` | `0x56` | See §1.2 (has version-gated flags field). |
| `kSharedArrayBuffer` | `u` | `0x75` | varint clone id (out-of-band). |
| `kSharedObject` | `p` | `0x70` | ≥ v15; varint shared-object id. |
| `kWasmModuleTransfer` | `w` | `0x77` | varint transfer id. |
| `kWasmMemoryTransfer` | `m` | `0x6D` | varint + ArrayBuffer. |
| `kHostObject` | `\` | `0x5C` | Delegates to Blink; see §2. |
| `kError` | `r` | `0x72` | Error sub-tag stream; see §1.7. |

**Legacy-reserved tags** (predate `kHostObject`/v13; never reused, but you may see them in
very old blobs — they were how Blink host objects were tagged before v13):

| Tag | Char | Hex |
|---|---|---|
| `kLegacyReservedMessagePort` | `M` | `0x4D` |
| `kLegacyReservedBlob` | `b` | `0x62` |
| `kLegacyReservedBlobIndex` | `i` | `0x69` |
| `kLegacyReservedFile` | `f` | `0x66` |
| `kLegacyReservedFileIndex` | `e` | `0x65` |
| `kLegacyReservedDOMFileSystem` | `d` | `0x64` |
| `kLegacyReservedFileList` | `l` | `0x6C` |
| `kLegacyReservedFileListIndex` | `L` | `0x4C` |
| `kLegacyReservedImageData` | `#` | `0x23` |
| `kLegacyReservedImageBitmap` | `g` | `0x67` |
| `kLegacyReservedImageBitmapTransfer` | `G` | `0x47` |
| `kLegacyReservedOffscreenCanvas` | `H` | `0x48` |
| `kLegacyReservedCryptoKey` | `K` | `0x4B` |
| `kLegacyReservedRTCCertificate` | `k` | `0x6B` |

> **Implementation note:** `kImmutableArrayBuffer` (`C`/`0x43`) is not in most existing
> parsers' tables (it postdates `dfindexeddb`'s last sync). Treat it as an alias of
> `kArrayBuffer` for decoding — the only difference is a "don't allow mutation" semantic
> flag on the deserialized object; the wire bytes are identical.

## 1.2 ArrayBuffer / ArrayBufferView payloads [PRIMARY]

Source: `WriteJSArrayBuffer` (approx. `.cc` L987–1075), `WriteJSArrayBufferView` (L1076–1111).

**`kArrayBuffer` / `kImmutableArrayBuffer`:**
```
byteLength : varint             ← see width note below
data       : byte[byteLength]   ← raw element bytes, host byte order (no normalization)
```

**`kResizableArrayBuffer`:**
```
byteLength    : varint
maxByteLength : varint
data          : byte[byteLength]
```

> **CRITICAL width note (version 16):** as of format **version 16** (commit `3f4cb1d`,
> ~2026-04), these lengths/offsets are written with `WriteVarint<size_t>` — i.e. they can
> be **full 64-bit varints (up to 10 bytes)**, not fixed 4-byte. The reader (`ReadSizeT`,
> ~L1569) **always** reads a `uint64_t` varint regardless of platform. The inline comment
> in the enum still says `uint32_t` — that comment is stale. **Always parse these as
> arbitrary-width unsigned LEB128 varints.**

**`ArrayBufferViewTag` sub-tag enum** (`.cc` L253–266):

| View | Char | Hex |
|---|---|---|
| `kInt8Array` | `b` | `0x62` |
| `kUint8Array` | `B` | `0x42` |
| `kUint8ClampedArray` | `C` | `0x43` |
| `kInt16Array` | `w` | `0x77` |
| `kUint16Array` | `W` | `0x57` |
| `kInt32Array` | `d` | `0x64` |
| `kUint32Array` | `D` | `0x44` |
| `kFloat16Array` | `h` | `0x68` | **NEW** (post-v15; guarded by `js_float16array` flag on read) |
| `kFloat32Array` | `f` | `0x66` |
| `kFloat64Array` | `F` | `0x46` |
| `kBigInt64Array` | `q` | `0x71` |
| `kBigUint64Array` | `Q` | `0x51` |
| `kDataView` | `?` | `0x3F` |

**`kArrayBufferView` payload:**
```
subtag     : varint (1 byte in practice)   ← ArrayBufferViewTag above
byteOffset : varint
byteLength : varint
flags      : varint (uint32)               ← ONLY if version >= 14   ← see below
```

Flags bitfield (`.cc` L103–104):
```
bit 0 (0x1) = is_length_tracking
bit 1 (0x2) = is_backed_by_rab   (resizable-ArrayBuffer-backed)
bits 2+     = reserved / unused
```

> **Version gate — this is the field you need for older captures.** The flags varint was
> added in **format version 14** ("flags for JSArrayBufferViews"). Deserializer:
> `bool should_read_flags = version_ >= 14 || version_13_broken_data_mode_;` (~L2264).
> - `version < 14` → **stop after `byteLength`; there is NO flags field.**
> - `version >= 14` → read the flags varint.
> `version_13_broken_data_mode_` is a narrow Chromium quirk for a batch of buggy v13 data;
> a from-scratch reader can ignore it unless specifically targeting that window.

> **Ordering quirk:** a `kArrayBufferView` is **always** immediately preceded by an
> `kArrayBuffer`/`kResizableArrayBuffer`/`kImmutableArrayBuffer` tag **or** a
> `kObjectReference` back-reference to one (comment at `.cc` L212–215). The view does not
> carry its own buffer bytes; it points at the just-seen buffer.

## 1.3 BigInt payload [PRIMARY] — bitfield is BYTE LENGTH, not digit count

Source: `WriteBigIntContents` (`.cc` L389–398); `bigint.cc` L1274–1286; `bigint.h` L118–126.

```
bitfield : varint(uint32)
digits   : byte[byteLength]     ← little-endian magnitude
```
Bitfield layout (`LengthBitsForSerialization = SignBits::Next<uint32_t, 31>`):
```
bit 0        = sign      (1 = negative)
bits 1..31   = byteLength of the digit data   ← NOT a digit/word count
```
So `bitfield = (byteLength << 1) | sign`. To decode: read `byteLength = bitfield >> 1`,
`negative = bitfield & 1`, then read `byteLength` raw bytes as a little-endian unsigned
integer of that width and negate if the sign bit is set. V8 deliberately encodes
byte-length (not 64-bit-word count) so 32-bit and 64-bit builds produce interoperable data.
`kBigIntObject` uses the identical payload, just a different lead tag.

## 1.4 Date and RegExp payloads [PRIMARY]

**`kDate`** (`WriteJSDate`, ~L880):
```
value : 8-byte IEEE-754 double, host byte order (LE)   ← milliseconds since Unix epoch
```
Equivalent to `new Date(value)`.

**`kRegExp`** (`WriteJSRegExp`, ~L912):
```
source : string value       ← full tagged string (one-byte / two-byte / utf8), see §1.6
flags  : varint(uint32)
```
Flag bits (`js-regexp.h` L28–47) [PRIMARY, not commit-pinned — stable]:
```
bit 0 (0x001) = global      (g)
bit 1 (0x002) = ignoreCase  (i)
bit 2 (0x004) = multiline   (m)
bit 3 (0x008) = sticky      (y)
bit 4 (0x010) = unicode     (u)
bit 5 (0x020) = dotAll      (s)
bit 6 (0x040) = linear      (V8-internal experimental-engine flag; not a JS-visible flag)
bit 7 (0x080) = hasIndices  (d)
bit 8 (0x100) = unicodeSets (v)
```
`kFlagCount = 9`. The deserializer masks off bits ≥ 9 and rejects bit 6 unless the
experimental-regexp build flag is set.

## 1.5 Object-reference id table [PRIMARY]

Single mint point on the write side: `WriteJSReceiver` (`.cc` L587–627):
```cpp
auto find_result = id_map_.FindOrInsert(receiver);
if (find_result.already_exists) {
  WriteTag(kObjectReference);
  WriteVarint(*find_result.entry - 1);   // 0-based id
  return ...;
}
uint32_t id = next_id_++;                 // assign new id BEFORE recursing into contents
*find_result.entry = id + 1;
```

**What gets an id (every `JSReceiver`):** plain objects, dense & sparse `JSArray`,
`JSDate`, `JSPrimitiveWrapper` (**boxed `kTrueObject`/`kFalseObject`/`kNumberObject`/
`kBigIntObject`/`kStringObject` DO get ids**), `JSRegExp`, `JSMap`, `JSSet`,
`JSArrayBuffer`, `JSArrayBufferView`, `JSError`, shared structs/arrays, Wasm module/memory.
Symmetric on read: all 15 `AddObjectWithID` call sites correspond to these.

**What does NOT get an id:** primitive strings (`WriteString` never touches `id_map_` — two
identical string *values* are each written out in full; there is **no** back-reference for
primitive strings, only for boxed String *objects*), numbers, booleans, `undefined`/`null`/
hole, BigInt primitives.

**ArrayBufferView gets its OWN id, separate from its buffer's** (`.cc` L497–512): the writer
calls `WriteJSReceiver(buffer)` (id N) then `WriteJSReceiver(view)` (id N+1) — two distinct
`next_id_++`. Both are addressable by `kObjectReference`.

**Ids are assigned before recursing into contents**, so cyclic/self-referential graphs
correctly back-reference their own not-yet-finished object.

## 1.6 Two-byte string alignment [PRIMARY] — the padding rule

Source: `WriteString` (`.cc` L564–583), verbatim:
```cpp
} else if (flat.IsTwoByte()) {
  base::Vector<const base::uc16> chars = flat.ToUC16Vector();
  uint32_t byte_length = chars.length() * sizeof(base::uc16);
  // The existing reading code expects 16-byte strings to be aligned.
  if ((buffer_size_ + 1 + BytesNeededForVarint(byte_length)) & 1) {
    WriteTag(SerializationTag::kPadding);
  }
  WriteTag(SerializationTag::kTwoByteString);
  WriteTwoByteString(chars);
}
```
**Exactly one `kPadding` (`0x00`) byte is conditionally emitted immediately before the
`kTwoByteString` tag**, iff `(currentBufferSize + 1 + varintByteLength(byte_length))` is
odd. The math computes what the offset of the UTF-16 *payload* (which follows the tag byte
and the length varint) will be, and inserts one pad byte so that offset is even — i.e. the
UTF-16LE data lands 2-byte aligned. It is always 0 or 1 pad bytes (parity alignment).
`WriteTwoByteString` = `varint(byteLength)` + raw UTF-16 bytes in host endianness (LE).

> The comment says "16-byte strings" but means "two-byte (UTF-16) strings" — it aligns to a
> **2-byte** boundary. Easy to misread.
>
> **Decoder guidance:** a naive decoder should simply treat a `kPadding` byte anywhere in
> the value stream as a no-op to skip. The alignment is relative to the start of the whole
> serialization buffer (`buffer_size_`), so if you're tracking absolute offset from the V8
> header you can predict it, but skip-on-encounter is the robust approach.

## 1.7 Error payload [PRIMARY, brief]

`kError` (`r`/`0x72`) is followed by a stream of `ErrorTag` sub-tag bytes terminated by an
end marker; sub-tags carry the error type (Eval/Range/Reference/Syntax/Type/URI), an
optional message string, an optional stack string, and an optional cause value. If you only
need to stay byte-aligned, decode: lead tag `r`, then loop reading one sub-tag byte and its
associated payload (string or nested value) until the end sub-tag. Full `ErrorTag` values
live in the same anonymous namespace in `value-serializer.cc`; consult source if you need
to fully materialize errors (rare in IndexedDB records).

## 1.8 `kLatestVersion` and version history [PRIMARY, TIME-SENSITIVE]

`static const uint32_t kLatestVersion = 16;` (`.cc` ~L55, at commit `3f4cb1d`).
Verbatim history comment:
```
// Version 9:  (imported from Blink)
// Version 10: one-byte (Latin-1) strings
// Version 11: properly separate undefined from the hole in arrays
// Version 12: regexp and string objects share normal string encoding
// Version 13: host objects have an explicit tag (rather than handling all unknown tags)
// Version 14: flags for JSArrayBufferViews
// Version 15: support for shared objects with an explicit tag
// Version 16: don't truncate JSArrayBuffer's/JSArrayBufferView's lengths & offsets to
//             32-bit; write full size_t's; deserializer handles 64-bit even on 32-bit;
//             allow resizable ArrayBuffers with maxByteLength > 4GB.
```
Practical version gates for the reader (all from `ReadHeader`/`ReadString`/`ReadObjectInternal`):
- No leading `0xFF` at all → legacy, `version_ = 0`.
- `version < 12` → RegExp/String objects use raw UTF-8 string encoding, not tagged strings (`ReadString` → `ReadUtf8String`, ~L1785).
- `version < 13` → any unrecognized tag falls through to `ReadHostObject()` rather than failing.
- `version < 14` → `kArrayBufferView` has **no** flags field (see §1.2).
- `version < 15` → `kSharedObject` treated as unknown/host-delegated.
- `version > 16` at read time → hard error (`kDataCloneDeserializationVersionError`). If you
  see a version stamp > 16, treat as corrupted or newer-than-documented V8 and flag it.

Expect **v15 or v16** in current Chromium/WebView2 (and thus current Teams). Older = old
profile/migration. **[TIME-SENSITIVE] — always read the varint; never hardcode.**

---

# 2. Blink SerializedScriptValue envelope + host objects

**Primary source:** `third_party/blink/renderer/bindings/core/v8/serialization/` — files
`serialized_script_value.{cc,h}`, `serialization_tag.h`, `v8_script_value_serializer.cc`,
`v8_script_value_deserializer.cc`, `trailer_reader.cc`, `trailer_writer.cc`,
`serialized_params.h`; modules host objects in `.../bindings/modules/v8/serialization/`.
Two agents pinned commit `9533c6cf5d638b0620ddab91b5e0d3e4636a2bb5` for stable line numbers;
otherwise `main` as of 2026-07-10/11.

## 2.0 Encoding primitives [PRIMARY] — get these right first

| Primitive | Encoding |
|---|---|
| Tag byte | exactly **1 raw byte** (not varint) |
| `WriteUint32` / `WriteUint64` | **LEB128 varint** (covers all lengths, indices, versions) |
| `WriteDouble` | raw **8-byte** IEEE-754 little-endian (no varint) |
| `WriteOneByte` (modules) | exactly **1 raw byte** (e.g. CryptoKey sub-tag) |
| `WriteRawBytes` | literal bytes |
| UTF8String field | `length:varint(uint32)` + `length` raw UTF-8 bytes |
| **Trailer offset/size (after 0xFE)** | **fixed-width BIG-ENDIAN** — the ONE exception |

## 2.1 Blink version envelope [PRIMARY, TRIANGULATED]

`serialized_script_value.h`: `static constexpr uint32_t kWireFormatVersion = 21;`

Written as `kVersionTag (0xFF)` + `WriteUint32(21)` (varint; `21 = 0x15`, one byte). This is
**separate** from V8's own version (§1.8 / §2.3).

Verbatim history comment (`serialized_script_value.h` ~L116–151):
```
// Version 2:  Added StringUCharTag for UChar v8 strings.
// Version 3:  Switched to using uuids as blob data identifiers.
// Version 4:  Extended File serialization to be complete.
// Version 5:  Added CryptoKeyTag for Key objects.
// Version 6:  Added indexed serialization for File, Blob, and FileList.
// Version 7:  Extended File serialization with user visibility.
// Version 8:  File.lastModified in milliseconds (seconds in earlier versions).
// Version 9:  Added Map and Set support.
// [versions skipped]            ← literal text in the source; 10–15 changelog never filled in
// Version 16: Separate versioning between V8 and Blink.
// Version 17: Remove unnecessary byte swapping.
// Version 18: Key-value list for ImageBitmap/ImageData (color space, compression, …).
// Version 19: Add DetectedBarcode/Face/Text support.
// Version 20: Remove DetectedBarcode/Face/Text support.
// Version 21: Add trailer data marking required exposed interfaces.
// DO NOT USE: 35, 64, 68, 73, 78, 82, 83, 85, 91, 98, 102, 108, 123.
```

Two thresholds that drive parsing:
- **`version >= 16`** → separate Blink and V8 envelopes (**two** `0xFF` tags near the start).
  Below 16 → a single combined envelope (**one** `0xFF`). (`kMinVersionForSeparateEnvelope = 16`.)
- **`version >= 21`** → the `0xFE` trailer-offset section is present. (`TrailerReader::kMinWireFormatVersion = 21`.)

## 2.2 The trailer mechanism [PRIMARY, TRIANGULATED]

`serialization_tag.h` (L144–150):
```cpp
kTrailerOffsetTag = 0xFE,   // offset:uint64_t (fixed, network order) + size:uint32_t (fixed, network order)
kVersionTag       = 0xFF,   // version:uint32_t
kTrailerRequiresInterfacesTag = 0xA0,   // used only inside the trailer region
```

**Trailer-offset section (near buffer start), version ≥ 21:**
```
offset  byte(s)                     meaning
[0]     0xFF                        kVersionTag (Blink)
[1]     0x15                        Blink version 21 (varint)
[2]     0xFE                        kTrailerOffsetTag
[3..10] uint64 BIG-ENDIAN           trailer_offset (from buffer start)
[11..14] uint32 BIG-ENDIAN          trailer_size
```
Constants: `kTrailerOffsetPosition = 3`, `kTrailerOffsetDataSize = 1 + 8 + 4 = 13`.
Your assumptions were exactly right: **0xFE tag, 8-byte big-endian offset, 4-byte big-endian
size.** Writer uses `base::U64ToBigEndian`/`U32ToBigEndian`; reader `…FromBigEndian`.

- **No trailer:** if `offset == 0 && size == 0`, there is no trailer region (the 13-byte
  section is still structurally present and always emitted for v ≥ 21 — the placeholder is
  simply never patched). The deserializer skips 13 bytes unconditionally when v ≥ 21.
- **Trailer region (at buffer END, pointed to by offset)** — a single record, NOT a bitset:
  ```
  [0]      0xA0             kTrailerRequiresInterfacesTag
  [1..4]   uint32 BIG-ENDIAN  num_exposed
  [5..]    N × 1 raw SerializationTag byte   ← "required exposed interface" tags
  ```
  It lists tags for objects whose backing Web API might be absent in the receiving realm
  (CryptoKey, RTCCertificate, RTC/Media/WebCodecs types, DOMFileSystem, CropTarget, …).
  **Blob/File/ImageData/geometry are NOT listed** — so this is a feature/exotic-interface
  checklist, not a manifest of stored host-object types. Consumed by `CanDeserializeIn()`;
  irrelevant to actually decoding the value bytes.

> `dfindexeddb` reads the offset/size (to know where the V8 payload ends) but does not decode
> the trailer record's contents; the trailer-record layout above is PRIMARY (Blink C++) only.

## 2.3 Overall byte sequence — two nested 0xFF envelopes [PRIMARY, TRIANGULATED]

Verbatim comment (`v8_script_value_serializer.cc` ~L72–87):
> The serialization format has two "envelopes": an outer one controlled by Blink and an
> inner one by V8. `[version tag] [Blink version] [version tag] [v8 version] …`. Before
> version 16 there was only a single envelope and both version numbers were always equal.

`Serialize()` header write (~L251–265): write `0xFF` + Blink version; write `0xFE` + 12 zero
placeholder bytes; then call `serializer_.WriteHeader()`, which independently writes V8's own
`kVersion (0xFF)` + `WriteVarint(v8 kLatestVersion)`. The 12 placeholder bytes are
back-patched with the real big-endian offset/size after the whole graph (and any trailer) is
written.

**Byte-sequence diagram — current format (Blink v21, typical value):**
```
FF 15                                   Blink envelope: kVersionTag + version 21
FE <8-byte BE offset> <4-byte BE size>  kTrailerOffsetTag + pointer (all zero if no trailer)
FF <v8-version varint>                  V8 envelope: V8 kVersion tag + V8 ValueSerializer version
<tag> <value …>                         V8 object graph (root tag first)
…
[trailer bytes at buffer end]           only if size != 0:  A0 <u32 count BE> <count tag bytes>
```

Version-dependent variants:
- **16 ≤ v < 21:** `FF <blinkver> FF <v8ver> <value…>` (two 0xFF, no 0xFE section).
- **v < 16:** `FF <ver> <value…>` (single combined envelope, one 0xFF).

**Why two 0xFF:** Blink writes its own envelope, then delegates to
`v8::ValueSerializer::WriteHeader()` which writes a second, independent `0xFF` + V8 version.
This is the "two nested 0xFF envelopes" you observed. [TRIANGULATED: CCL
`read_record_precursor` reads Blink `0xFF`+varint, then (v ≥ 21) `struct.unpack(">cQI", …)`
= tag+BE u64+BE u32 = 13 bytes, then a V8 deserializer whose `_read_header()` reads the
second `0xFF`. dfindexeddb `_ReadVersionEnvelope` uses `_MIN_VERSION_FOR_SEPARATE_ENVELOPE =
16`, `_MIN_WIRE_FORMAT_VERSION = 21`.]

> **IndexedDB storage-layer caveat [SECONDARY — CCL only, verify if hit]:** in real IndexedDB
> records, CCL's parser peeks — after the Blink version varint — for a `0x01` byte signalling
> a `kReplaceWithBlob`/external-value wrapping (value stored out-of-line as a blob). This is
> an IndexedDB storage-layer concern around the SSV, not part of SSV itself. See §3.3 for the
> primary-source IndexedDB value framing; be aware the wrapper may exist and was not fully
> reconciled against Chromium's backing-store source here.

## 2.4 Blink `SerializationTag` (host-object sub-tags) [PRIMARY]

`enum SerializationTag : uint8_t` in `serialization_tag.h` (49 enumerators). These are the
payload of V8's `kHostObject` (`\`/`0x5C`): V8 emits `0x5C`, then Blink reads one of these
bytes and dispatches. `uint32`/`uint64` = **varint**; `double` = 8 raw LE bytes.

| Tag | Char | Hex | Payload (enough to skip) |
|---|---|---|---|
| `kMessagePortTag` | `M` | `0x4D` | index:uint32 (transferred port, out-of-band) |
| `kMojoHandleTag` | `h` | `0x68` | index:uint32 (out-of-band) |
| `kBlobTag` | `b` | `0x62` | uuid:UTF8Str, type:UTF8Str, size:uint64 |
| `kBlobIndexTag` | `i` | `0x69` | index:uint32 |
| `kFileTag` | `f` | `0x66` | RawFile (see §2.5) |
| `kFileIndexTag` | `e` | `0x65` | index:uint32 |
| `kDOMFileSystemTag` | `d` | `0x64` | type:uint32, name:UTF8Str, rootURL:UTF8Str |
| `kFileSystemFileHandleTag` | `n` | `0x6E` | name:UTF8Str, index:uint32 |
| `kFileSystemDirectoryHandleTag` | `N` | `0x4E` | name:UTF8Str, index:uint32 |
| `kFileListTag` | `l` | `0x6C` | length:uint32, then length × RawFile |
| `kFileListIndexTag` | `L` | `0x4C` | length:uint32, then length × uint32 |
| `kImageDataTag` | `#` | `0x23` | tagged prelude→kEnd, width:u32, height:u32, len:**uint64**, bytes |
| `kImageBitmapTag` | `g` | `0x67` | tagged prelude→kEnd, width:u32, height:u32, len:**uint32**, bytes |
| `kImageBitmapTransferTag` | `G` | `0x47` | index:uint32 |
| `kElementImageTransferTag` | `J` | `0x4A` | index:uint32 |
| `kOffscreenCanvasTransferTag` | `H` | `0x48` | width,height,id,clientId,sinkId (u32/u64) |
| `kReadableStreamTransferTag` | `r` | `0x72` | index:uint32 (transfer-only) |
| `kTransformStreamTransferTag` | `m` | `0x6D` | index:uint32 |
| `kWritableStreamTransferTag` | `w` | `0x77` | index:uint32 |
| `kMediaStreamTrack` | `s` | `0x73` | not for-storage |
| `kDOMPointTag` | `Q` | `0x51` | 4 doubles (x,y,z,w) |
| `kDOMPointReadOnlyTag` | `W` | `0x57` | 4 doubles |
| `kDOMRectTag` | `E` | `0x45` | 4 doubles (x,y,width,height) |
| `kDOMRectReadOnlyTag` | `R` | `0x52` | 4 doubles |
| `kDOMQuadTag` | `T` | `0x54` | 16 doubles (4 points × x,y,z,w) |
| `kDOMMatrixTag` | `Y` | `0x59` | 16 doubles (m11..m44) |
| `kDOMMatrixReadOnlyTag` | `U` | `0x55` | 16 doubles |
| `kDOMMatrix2DTag` | `I` | `0x49` | 6 doubles (a..f) |
| `kDOMMatrix2DReadOnlyTag` | `O` | `0x4F` | 6 doubles |
| `kCryptoKeyTag` | `K` | `0x4B` | see §2.5 (modules deserializer) |
| `kRTCCertificateTag` | `k` | `0x6B` | pemPrivateKey:UTF8Str, pemCertificate:UTF8Str |
| `kRTCEncodedAudioFrameTag` | `A` | `0x41` | index:uint32 (not for-storage) |
| `kRTCEncodedVideoFrameTag` | `V` | `0x56` | index:uint32 (not for-storage) |
| `kRTCDataChannel` | `p` | `0x70` | index:uint32 (not for-storage) |
| `kAudioDataTag` | `a` | `0x61` | index:uint32 (not for-storage) |
| `kVideoFrameTag` | `v` | `0x76` | index:uint32 (not for-storage) |
| `kEncodedAudioChunkTag` | `y` | `0x79` | index:uint32 (not for-storage) |
| `kEncodedVideoChunkTag` | `z` | `0x7A` | index:uint32 (not for-storage) |
| `kCropTargetTag` | `c` | `0x63` | id:UTF8Str |
| `kRestrictionTargetTag` | `D` | `0x44` | id:UTF8Str |
| `kMediaSourceHandleTag` | `S` | `0x53` | index:uint32 (not for-storage) |
| `kDeprecatedDetectedBarcodeTag` | `B` | `0x42` | removed (M71–M81) |
| `kDeprecatedDetectedFaceTag` | `F` | `0x46` | removed |
| `kDeprecatedDetectedTextTag` | `t` | `0x74` | removed |
| `kFencedFrameConfigTag` | `C` | `0x43` | URL + flags/optionals (transfer) |
| `kDOMExceptionTag` | `x` | `0x78` | name:UTF8Str, message:UTF8Str, stack:UTF8Str |
| `kQuotaExceededErrorTag` | `q` | `0x71` | message, stack, has_quota:u32, quota:double, has_requested:u32, requested:double |
| `kTrailerOffsetTag` | — | `0xFE` | envelope (§2.2) |
| `kVersionTag` | — | `0xFF` | envelope (§2.1) |
| `kTrailerRequiresInterfacesTag` | — | `0xA0` | inside trailer only |

> **For at-rest IndexedDB records** you realistically only see: Blob, File, FileList,
> ImageData, ImageBitmap, CryptoKey, DOMException, the DOM geometry types, DOMFileSystem,
> FileSystemHandle. All transfer-only tags (streams, OffscreenCanvas/ImageBitmap transfer,
> MojoHandle, MessagePort) and "not for-storage" media tags (RTC*, VideoFrame, AudioData,
> Encoded*Chunk, MediaStreamTrack, CropTarget, RestrictionTarget, MediaSourceHandle) throw
> `DataCloneError` when serialized for storage and should not appear (`IsForStorage()`
> guards in `v8_script_value_serializer_for_modules.cc`).

## 2.5 Host-object payload layouts [PRIMARY] (read order = authoritative)

Version gates are exact — replicate them or you desync. All from
`v8_script_value_deserializer.cc` unless noted; CryptoKey is in the **modules** deserializer.

**Blob (`kBlobTag`, v ≥ 3):** `uuid:UTF8Str, type:UTF8Str, size:uint64`.
`kBlobIndexTag` (v ≥ 6): `index:uint32`.

**File (`ReadFile`, current v ≥ 8) — read order:**
```
1. path:UTF8Str
2. name:UTF8Str            (only if v >= 4)
3. relative_path:UTF8Str   (only if v >= 4)
4. uuid:UTF8Str
5. type:UTF8Str
6. has_snapshot:uint32     (only if v >= 4)          ← the "flag" you asked about
7. if has_snapshot != 0:  size:uint64, last_modified:double   (v < 8: value in seconds ×1000)
8. is_user_visible:uint32  (only if v >= 7; default 1)
```
`kFileIndexTag` (v ≥ 6): `index:uint32`. (Serializer currently hardcodes `has_snapshot = 1`.)

**FileList (`kFileListTag`):** `length:uint32`, then `length` × full inline `ReadFile()`
records (not a flat index array). `kFileListIndexTag`: `length:uint32` + length × `uint32`.

**ImageData (`kImageDataTag`):** if v ≥ 18, a prelude loop of `ImageSerializationTag:uint32`
+ value terminated by `kEnd(0)` (legal: `kPredefinedColorSpace(1)`+enum,
`kImageDataPixelFormat(3)`+enum). Then always: `width:u32, height:u32, byteLength:uint64,
pixels:byte[byteLength]`. Pre-v18: no prelude (sRGB/rgba8 defaults).

**ImageBitmap (`kImageBitmapTag`):** if v ≥ 18, prelude→kEnd (legal: `kOriginClean(4)`+u32,
`kIsPremultiplied(5)`+u32, `kPredefinedColorSpace(1)`+enum, `kParametricColorSpace(7)`+**16
doubles**, `kCanvasPixelFormat(2)`+enum, `kCanvasOpacityMode(6)`+enum, `kImageOrientation(8)`
+enum). Else (pre-v18): `origin_clean:u32, is_premultiplied:u32`. Then always: `width:u32,
height:u32, byteLength:**uint32**, pixels:byte[byteLength]`.
**Note the difference: ImageData length = uint64; ImageBitmap length = uint32.**

`ImageSerializationTag` (`serialized_params.h`): kEnd=0, kPredefinedColorSpace=1,
kCanvasPixelFormat=2, kImageDataPixelFormat=3, kOriginClean=4, kIsPremultiplied=5,
kCanvasOpacityMode=6, kParametricColorSpace=7 (16 doubles), kImageOrientation=8.

**DOM geometry (all pure doubles, no length prefix):** DOMPoint/ReadOnly = 4 doubles;
DOMRect/ReadOnly = 4 doubles; DOMQuad = 16 doubles; DOMMatrix2D/ReadOnly = 6 doubles;
DOMMatrix/ReadOnly = 16 doubles (row-major m11..m44).

**DOMException (`kDOMExceptionTag`):** `name:UTF8Str, message:UTF8Str, stack:UTF8Str` — all
three always present (stack discarded on read).

**MessagePort (`kMessagePortTag`):** `index:uint32` into out-of-band ports array.

**CryptoKey (`kCryptoKeyTag`, MODULES deserializer):**
```
subtag : 1 raw byte (WriteOneByte)      ← CryptoKeySubTag
<algorithm-specific params, per subtag below>
usages : uint32                          ← bitmask; bit0 = extractable (NOT a separate field)
keyDataLength : uint32
keyData : byte[keyDataLength]
```
Sub-tag branches (exact read order):
| Subtag | Val | Params after subtag |
|---|---|---|
| `kAesKeyTag` | 1 | algorithmId:u32, lengthBytes:u32 (×8 = bits) |
| `kHmacKeyTag` | 2 | lengthBytes:u32, hashAlgorithmId:u32 *(length before hash — opposite of AES)* |
| `kRsaHashedKeyTag` | 4 | algorithmId:u32, keyType:u32, modulusLengthBits:u32, publicExponentSize:u32, publicExponent:byte[size], hashAlgorithmId:u32 |
| `kEcKeyTag` | 5 | algorithmId:u32, keyType:u32, namedCurve:u32 |
| `kNoParamsKeyTag` | 6 | algorithmId:u32 |
| `kEd25519KeyTag` | 7 | algorithmId:u32, keyType:u32 |
| `kX25519KeyTag` | 8 | algorithmId:u32, keyType:u32 |
| `kNoParamsWithKeyTypeKeyTag` | 9 | algorithmId:u32, keyType:u32 |

CryptoKey enums (`web_crypto_sub_tags.h`): `CryptoKeyType`: kPublic=1, kPrivate=2,
kSecret=3. `NamedCurveTag`: kP256=1, kP384=2, kP521=3. `CryptoKeyUsage` bitmask:
Extractable=1<<0, Encrypt=1<<1, Decrypt=1<<2, Sign=1<<3, Verify=1<<4, DeriveKey=1<<5,
WrapKey=1<<6, UnwrapKey=1<<7, DeriveBits=1<<8, EncapsulateKey=1<<9, EncapsulateBits=1<<10,
DecapsulateKey=1<<11, DecapsulateBits=1<<12. `CryptoKeyAlgorithmTag:uint32`: AesCbc=1,
Hmac=2, RsaSsaPkcs1v1_5=3, Sha1=5, Sha256=6, Sha384=7, Sha512=8, AesGcm=9, RsaOaep=10,
AesCtr=11, AesKw=12, RsaPss=13, Ecdsa=14, Ecdh=15, Hkdf=16, Pbkdf2=17, Ed25519=18, X25519=19,
ChaCha20Poly1305=20, MlDsa44=21, MlDsa65=22, MlDsa87=23, MlKem768=24, MlKem1024=25,
MlKem768X25519=26.
> **Bug-for-bug quirk:** the serializer maps `MlKem768X25519` → `kMlKem1024Tag` (apparent
> Chromium bug, `v8_script_value_serializer_for_modules.cc` ~L442). Match actual behavior
> for that (very new, rare) algorithm.

---

# 3. Chromium IndexedDB LevelDB coding

**Primary source:** `content/browser/indexed_db/indexed_db_leveldb_coding.{cc,h}`; design doc
`content/browser/indexed_db/docs/leveldb_coding_scheme.md`; backing-store read/write in
`content/browser/indexed_db/instance/leveldb/backing_store.cc`. (Chromium moved much of this
under `instance/` recently; if a path 404s, search under `content/browser/indexed_db/instance/`
or `components/services/storage/indexed_db/`.)

## 3.1 KeyPrefix encoding [PRIMARY] — bit layout is 3/3/2

Source: `indexed_db_leveldb_coding.h` L140–231; `KeyPrefix::Decode`/`EncodeInternal`
(`.cc` L1749–1835); design doc L127–145.

**First byte** packs the three field byte-lengths:
```
bit 7..5  (3 bits): database_id_bytes    - 1   (kMaxDatabaseIdSizeBits    = 3, max 8 bytes)
bit 4..2  (3 bits): object_store_id_bytes - 1  (kMaxObjectStoreIdSizeBits = 3, max 8 bytes)
bit 1..0  (2 bits): index_id_bytes       - 1   (kMaxIndexIdSizeBits       = 2, max 4 bytes)

first_byte = ((db_bytes-1) << 5) | ((os_bytes-1) << 2) | (idx_bytes-1)
```
> This corrects a common assumption: it is **3/3/2**, not 2/2/3.

**Full key layout:**
```
[1 byte]   KeyPrefix first byte (bit-packed sizes above)
[N bytes]  database_id        (little-endian fixed-width "Int", N = db_bytes)
[M bytes]  object_store_id     (little-endian fixed-width, M = os_bytes)
[K bytes]  index_id            (little-endian fixed-width, K = idx_bytes)
[...]      type-specific suffix, depending on index_id (see §3.2)
```
> **Endianness:** the design doc explicitly says these three ids are **little-endian**.
> (Distinct from the encoded IDBKey suffix, where numbers/dates are stored big-endian — see
> §3.4.)

## 3.2 Special index_id values [PRIMARY]

Source: `.cc` L76–78; `kMinimumIndexId` in `.h` L36; dispatch in `KeyPrefix::MaybeType`
(`.cc` L1888–1907).
```cpp
constexpr unsigned char kObjectStoreDataIndexId = 1;
constexpr unsigned char kExistsEntryIndexId     = 2;
constexpr unsigned char kBlobEntryIndexId       = 3;
inline constexpr unsigned char kMinimumIndexId  = 30;   // user/secondary indexes start here
```
Classification (`KeyPrefix::Type` — a derived enum, not the raw index_id):
- `database_id == 0` → GLOBAL_METADATA
- `object_store_id == 0` (db ≠ 0) → DATABASE_METADATA
- `index_id == 1` → **OBJECT_STORE_DATA** (the actual record, keyed by user's IDB key)
- `index_id == 2` → **EXISTS_ENTRY** (internal existence marker; value = record version)
- `index_id == 3` → **BLOB_ENTRY** ("External Object entry table"; per-record blob metadata)
- `index_id >= 30` → INDEX_DATA (real secondary/user-defined indexes)

> **Discrepancy flagged:** CCL's blog says real indexes "begin at ID 4 or higher." Primary
> source says `kMinimumIndexId = 30`. **Trust 30** (current Chromium); the CCL figure is
> likely an older version or an error.

## 3.3 Object-store data VALUE format [PRIMARY]

Source: design doc L286; `BackingStore::Transaction::PutRecord` (`backing_store.cc` L2312–2361);
cursor read (L3669–3682).

```cpp
// write
std::string v;
EncodeVarInt(version, &v);                        // IndexedDB record version (a varint)
v.append(value.bits.begin(), value.bits.end());   // raw SerializedScriptValue bytes
// read
DecodeVarInt(&value_slice, &version);
current_value_.bits = BigBuffer(base::as_byte_span(value_slice));  // "the rest" = SSV
```

**VALUE layout for `index_id == 1`:**
```
version : varint      ← IndexedDB record version number
ssv     : byte[...]   ← raw Blink SerializedScriptValue, to end of value; starts with 0xFF (§2)
```
There is **no length prefix on the SSV** — it is simply "everything after the varint." The
SSV begins with Blink's `kVersionTag = 0xFF` (confirmed `serialization_tag.h` L147).

## 3.4 Blobs / external objects [PRIMARY] — fully external, no inline prefix

Source: design doc L106–124, L300–308; `EncodeExternalObjects` (`backing_store.cc` L460–493).

**Answer: the object-store-data value layout (varint version + raw SSV) is unconditional and
does NOT change when the record references Blobs/Files.** Blob/File/FileSystemAccessHandle
**metadata** is stored under a **separate key** with `index_id == 3` (`BlobEntryKey`), keyed
by the same user primary key. Its value is a concatenation of zero-or-more fixed-shape
records (read to end of value, no count/length prefix):
```
per external object:
  object_type : 1 byte          (0=Blob, 1=File, 2=FileSystemAccessHandle)
  -- Blob & File:
  blob_number : varint
  mime_type   : StringWithLength
  size        : varint
  -- File only (adds):
  filename      : StringWithLength
  last_modified : varint (microseconds)
  -- FileSystemAccessHandle only:
  token       : Binary (varint length + bytes)
```
> **Schema-version gate:** there is a legacy "V3" external-object format
> (`DecodeV3ExternalObjects`) lacking file `size`/`last_modified`. Schema versions 0–3 vs 4+
> differ ("4 - Adds size & last_modified to 'file' blob_info encodings", `.h` L24–29). Branch
> on the global-metadata schema-version key (`SchemaVersionKey`) to pick the decode variant.
>
> Actual blob file **bytes** live outside LevelDB entirely, at
> `{blob_dir}/{database_id:hex}/{(blob_number>>8)&0xff:02x}/{blob_number:hex}`
> (`file_path_util.cc` L81–102).

**Practical takeaway for the value parser:** you do **not** need a variable-length "blob
prefix" handler in the main data record — the main value is always `varint(version) + SSV`.
Blob metadata is out-of-line under `index_id == 3`.

## 3.5 The `idb_cmp1` comparator [PRIMARY, summary]

Source: `indexed_db_leveldb_operations.cc` L43–56; `content::indexed_db::Compare`
(`indexed_db_leveldb_coding.cc` L1328–1469).

The registered comparator is `LDBComparator`, `Name() == "idb_cmp1"` (this string is
persisted in the LevelDB MANIFEST — a useful signature to sanity-check you're looking at a
Chromium IndexedDB store). It decodes `KeyPrefix` on both sides and compares `database_id`,
then `object_store_id`, then `index_id` as integers; on equal prefixes it dispatches by
record type: metadata compares a type byte then nested structures;
OBJECT_STORE_DATA/EXISTS_ENTRY/BLOB_ENTRY compare the encoded user IDBKey suffix via
`CompareEncodedIDBKeys` (W3C IndexedDB key ordering: number/date < string < binary < array;
numbers/dates as **big-endian doubles**, binary lexicographic, arrays element-wise then by
length); INDEX_DATA additionally compares a trailing sequence-number varint and the primary
key.

---

# 4. LevelDB table (.ldb / SSTable) + Snappy raw block format

**Primary source:** upstream `github.com/google/leveldb` (`doc/table_format.md`,
`table/format.{h,cc}`, `table/block_builder.cc`, `table/block.cc`, `table/table_builder.cc`,
`util/crc32c.h`, `include/leveldb/options.h`, `db/dbformat.h`); Chromium's fork mirror
`chromium.googlesource.com/external/leveldatabase`; Snappy spec
`github.com/google/snappy/blob/main/format_description.txt`.
> Chromium's fork is at `third_party/leveldatabase` (NOT `third_party/leveldb`); `src/` is
> vendored from the `external/leveldatabase` mirror.

## 4.1 Block trailer [PRIMARY] — 5 bytes, masked CRC32C, little-endian

`table/format.h`: `static const size_t kBlockTrailerSize = 5;`
```
block layout on disk:
  [0 .. n-1]   block_contents      (possibly compressed; n = compressed size)
  [n]          compression type    (1 byte)
  [n+1 .. n+4] masked CRC32C       (4 bytes, LITTLE-ENDIAN)
```
Writer (`table_builder.cc WriteRawBlock`):
```cpp
trailer[0] = type;
uint32_t crc = crc32c::Value(block_contents.data(), block_contents.size());
crc = crc32c::Extend(crc, trailer, 1);            // CRC covers block_contents + the 1 type byte
EncodeFixed32(trailer + 1, crc32c::Mask(crc));    // stored little-endian, masked
```
So the CRC covers `block_contents || type_byte` and **not** itself. `EncodeFixed32` is LE.

**CRC masking** (`util/crc32c.h`, defined inline):
```cpp
static const uint32_t kMaskDelta = 0xa282ead8ul;
inline uint32_t Mask(uint32_t crc)   { return ((crc >> 15) | (crc << 17)) + kMaskDelta; }
inline uint32_t Unmask(uint32_t m)   { uint32_t rot = m - kMaskDelta; return (rot >> 17) | (rot << 15); }
```
The underlying CRC is standard **CRC32C (Castagnoli)**, reflected, init `0xFFFFFFFF`,
final-xor `0xFFFFFFFF` — same as Chromium's `base::Crc32c`. To verify a block:
`crc = Unmask(readLE32(trailer+1)); ok = (crc == crc32c(block_contents ++ [type]))`.

## 4.2 Compression types [PRIMARY] — Chromium fork has NO zstd

Upstream `include/leveldb/options.h` (current main) defines three:
```cpp
enum CompressionType { kNoCompression = 0x0, kSnappyCompression = 0x1, kZstdCompression = 0x2 };
```
**But Chromium's actual fork** (`chromium.googlesource.com/external/leveldatabase/+/HEAD/
include/leveldb/options.h`) defines only:
```cpp
enum CompressionType { kNoCompression = 0x0, kSnappyCompression = 0x1 };
```
and its `table/format.cc ReadBlock` switch has only `kNoCompression`, `kSnappyCompression`,
and a `default: return Status::Corruption("bad block type")`.

> **Conclusion:** Chromium IndexedDB `.ldb` files use **only** compression type `0x00` (none)
> or `0x01` (snappy). Any other type byte would be rejected by Chromium's own reader — treat
> it as corruption. **Do not implement zstd for the Chromium/Teams case** (upstream Google
> LevelDB does have zstd = 0x2, but Chromium's fork does not). [PRIMARY — confirmed in the
> fork's actual options.h and format.cc.]

## 4.3 Block internal layout [PRIMARY]

`block_builder.cc` header comment (verbatim):
```
// Entry:  shared_bytes:varint32  unshared_bytes:varint32  value_length:varint32
//         key_delta:char[unshared_bytes]  value:char[value_length]
//         (shared_bytes == 0 for restart points)
// Trailer: restarts:uint32[num_restarts]   num_restarts:uint32
//          restarts[i] = offset within block of the i-th restart point
```
So, within the **uncompressed** block:
```
[entries...]                            each: varint32 shared, varint32 non_shared,
                                        varint32 value_len, key_delta[non_shared], value[value_len]
[restarts: num_restarts × uint32 LE]    offsets where full (non-shared) keys begin
[num_restarts: uint32 LE]               the very last 4 bytes of the block
```
Key reconstruction: `key = prev_key[0:shared] + key_delta`. Restart-point entries have
`shared == 0` (full key). Reader confirmation (`block.cc`): `NumRestarts() =
DecodeFixed32(data + size - 4)`; `restart_offset_ = size - (1 + NumRestarts()) * 4`.
`DecodeEntry` has a fast path when all three varint32 fit in one byte each (`< 128`), reading
3 bytes; else it decodes three varint32s.

## 4.4 Can one value exceed block_size? [PRIMARY] — YES

`table_builder.cc Add()`:
```cpp
r->data_block.Add(key, value);                        // entry appended to block FIRST
const size_t estimated = r->data_block.CurrentSizeEstimate();
if (estimated >= r->options.block_size) Flush();      // size check AFTER, flush next cycle
```
`CurrentSizeEstimate() = buffer_.size() + restarts_.size()*4 + 4` (actual accumulated size).
The entry is **unconditionally appended first**; only afterward does the builder check
whether the block reached `block_size` and flush. **There is no logic anywhere that splits a
key/value across blocks, and none that rejects an oversized value.** Consequently:

> **A single value larger than `block_size` (default 4096) lands entirely in one block, which
> then becomes an oversized block and is flushed before the next entry. Values NEVER span
> multiple blocks. Do not assume any block is ≤ 4096 bytes** — use each block's `BlockHandle`
> (offset + size, both varint64, from the index block / footer) to learn its true extent.

## 4.5 Defaults + footer [PRIMARY]

| Constant | Value | Source |
|---|---|---|
| default `block_size` | `4096` (4 × 1024) | options.h |
| default `block_restart_interval` (data blocks) | `16` | options.h |
| index-block `block_restart_interval` | `1` (hardcoded — every index entry is a restart point, no prefix sharing) | table_builder.cc `Rep` ctor |
| `kBlockTrailerSize` | `5` | format.h |
| `kTableMagicNumber` | `0xdb4775248b80fb57` (LE on disk, last 8 bytes of file) | format.h |
| Footer `kEncodedLength` | `48` (`2 × BlockHandle::kMaxEncodedLength(20) + 8`) | format.h |

**Footer** (last 48 bytes of the file): metaindex BlockHandle (varint64 offset + varint64
size), index BlockHandle, zero-padding, then the 8-byte magic number.

**Internal key trailer** [PRIMARY, but the byte-order of the 8-byte trailer was read via a
summarized fetch — verify byte offsets if load-bearing]: LevelDB keys are
`user_key || (sequence_number << 8 | value_type)` as a 64-bit **little-endian** trailer —
low byte = `ValueType` (`kTypeDeletion = 0x0`, `kTypeValue = 0x1`), upper 56 bits = sequence
number. Comparator orders by user key, then **decreasing** sequence number. For an IndexedDB
reader you typically strip the trailing 8 bytes to recover the IDB-encoded user key, then
decode per §3.

## 4.6 Snappy raw (unframed) block format [PRIMARY — snappy format_description.txt]

LevelDB stores the **raw/unframed** Snappy format inside compressed blocks.

**Preamble:** uncompressed length as a **little-endian base-128 varint** (low 7 bits data,
high bit = continuation), max 2³²−1.

**Element stream:** each element starts with a tag byte; **low 2 bits select the type:**
```
00 = literal
01 = copy, 1-byte offset
10 = copy, 2-byte offset
11 = copy, 4-byte offset
```

**Literal (low bits 00):**
- If upper 6 bits ≤ 59: `len - 1` = upper 6 bits; literal bytes follow immediately.
- If upper 6 bits ∈ {60,61,62,63}: that means "length stored in next 1/2/3/4 bytes"
  respectively (60→1, 61→2, 62→3, 63→4), each holding `len - 1` little-endian; literal bytes
  follow the length field.

**Copy, 1-byte offset (low bits 01):** length ∈ [4,11], offset ∈ [0,2047].
`len - 4` = tag bits [2..4] (3 bits); offset = (tag bits [5..7] as high 3 bits << 8) | (next byte).

**Copy, 2-byte offset (low bits 10):** length ∈ [1,64], offset ∈ [0,65535].
`len - 1` = upper 6 tag bits; offset = next 2 bytes, little-endian.

**Copy, 4-byte offset (low bits 11):** length ∈ [1,64] (same as 2-byte form);
offset = next 4 bytes, little-endian.

**Overlapping-copy / RLE edge case [CRITICAL]:** the spec explicitly allows `length > offset`
(e.g. `"xababab"` = `literal "xab"` + `copy offset=2 length=4`). When `offset < length` the
source and destination ranges overlap, so you **must copy byte-by-byte** (source pointer
trailing `offset` bytes behind the write cursor, both advancing together) — a bulk `memcpy`
reads not-yet-written bytes and corrupts the output. Also validate defensively: `offset == 0`
is illegal, and `offset > current_output_position` (referencing before the buffer start) is
illegal. (The current compressor uses ≤ 32 KB windows, but the spec says decoders must not
rely on that.)

---

# 5. Documentation / version-adaptation strategy

How the two mature re-implementations stay robust across Chromium/V8/Blink drift, and what to
mirror in TypeScript. [TRIANGULATED — both projects independently confirm the same version
thresholds used above: V8 v12/v13/v14/v15, Blink v16/v21.]

**`dfindexeddb` (Google, Python)** — `dfindexeddb/indexeddb/chromium/{v8,blink,record}.py`:
- Hardcoded numeric version gates: `ReadString` → `if self.version < 12: ReadUTF8String()`;
  `_ReadJSArrayBufferView` → `if self.version >= 14: read flags`; dense-array hole handling
  `if self.version < 11`; host-object dispatch `elif self.version < 13`. Blink side:
  `_MIN_VERSION_FOR_SEPARATE_ENVELOPE = 16`, `_MIN_WIRE_FORMAT_VERSION = 21`; File/Blob branch
  on `version < 3/4/6/7/8`.
- **Per-record isolation:** `ChromiumIndexedDBRecord.FromFile/FromFolder` wraps each record in
  `try/except (ParserError, DecoderError, NotImplementedError)`, logs + traceback to stderr,
  and **continues to the next record**. Field-level parsing still fails loud (raises).

**`ccl_chromium_reader` (Alex Caithness / CCL, Python)** —
`serialization_formats/ccl_v8_value_deserializer.py`, `ccl_chromium_indexeddb.py`:
- Same `version >= 14` ArrayBufferView-flags gate, with an inline comment linking the exact
  V8 source line. Same `version < 12` string branch.
- **Tag→handler dict** dispatch (`_read_object_internal`) + `if func is None: raise
  ValueError(f"Unknown tag {tag}")` — closer to a registry than a giant switch.
- Documents **legacy-reserved tags** with the rationale ("reserved because in use before
  token_kHostObject in v13 … must not be reused without a version check").
- **Caller-injectable best-effort:** `read_record_precursor`/`iterate_records` accept a
  `bad_deserializer_data_handler` callback; on a bad Blink tag, missing blob, or any V8
  deserialization exception, it calls the handler with `(key, raw_bytes)` and yields
  `None`/skips instead of crashing — **raw bytes are preserved and handed back**.

Neither README pins a validated Chromium version range; both resync against live source. CCL's
blog advises consulting *current* Chromium source rather than a compatibility matrix.

## Patterns to mirror in the TypeScript reader

- **Central tag→handler registry** (`Map<number, Handler>`) for both V8 `SerializationTag` and
  Blink host-object tags, instead of a monolithic switch — adding a new tag becomes additive.
- **Version-gated field reads as small named predicates** — e.g.
  `arrayBufferViewHasFlags(v8Version) = v8Version >= 14`,
  `hasSeparateEnvelope(blinkVersion) = blinkVersion >= 16`,
  `hasTrailer(blinkVersion) = blinkVersion >= 21`,
  `fileHasSnapshotFlag(blinkVersion) = blinkVersion >= 4` — each a named constant with a
  comment citing the V8/Blink source line, exactly as CCL does. **Always read version varints
  from the buffer; never hardcode** (both `kWireFormatVersion` and V8 `kLatestVersion` roll).
- **Per-record isolation:** wrap each LevelDB record's value decode in try/catch; on failure
  log `{tag, offset, blinkVersion, v8Version}` and continue the DB scan (dfindexeddb pattern).
- **Preserve raw bytes + best-effort decode + a caller "bad data" callback** (CCL pattern) so
  an unknown/newer tag yields an opaque-blob result rather than throwing to the top.
- **Unknown tag → typed "unsupported" result carrying the raw tag byte + remaining bytes**,
  caught at each tag-dispatch boundary (go further than both tools, which mostly still raise
  deep in the tree) — this is the key to surviving future Chromium versions gracefully and
  is likely where your missing ~0.5% of records live.
- **Signature checks:** verify the LevelDB MANIFEST comparator name `idb_cmp1` and the SSTable
  magic `0xdb4775248b80fb57` to confirm you're parsing the expected format before trusting
  offsets.
- **Keep the legacy-reserved-tag table + comments** referencing the exact source revision, to
  ease future format-drift maintenance.

---

# 6. Sources

**V8 ValueSerializer (§1):**
- `value-serializer.cc` @ `a59996fbddfd1867aa5501283859fd4b6af210ba` — https://github.com/v8/v8/blob/a59996fbddfd1867aa5501283859fd4b6af210ba/src/objects/value-serializer.cc
- `value-serializer.h` @ `3f4cb1dd32849258430f6b60da620141dcc42400` (version-16 bump) — https://github.com/v8/v8/blob/3f4cb1dd32849258430f6b60da620141dcc42400/src/objects/value-serializer.h
- version-16 CL — https://chromium-review.googlesource.com/c/v8/v8/+/7739143
- `bigint.cc` / `bigint.h` @ `a59996fb…` — https://github.com/v8/v8/blob/a59996fbddfd1867aa5501283859fd4b6af210ba/src/objects/bigint.cc
- `js-regexp.h` (main) — https://raw.githubusercontent.com/v8/v8/main/src/objects/js-regexp.h
- `include/v8-value-serializer-version.h` — https://github.com/v8/v8/blob/master/include/v8-value-serializer-version.h
- (cross-check) dfindexeddb `definitions.py` — https://github.com/google/dfindexeddb/blob/main/dfindexeddb/indexeddb/chromium/definitions.py

**Blink SerializedScriptValue (§2):**
- `serialization_tag.h` — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/serialization_tag.h
- `serialized_script_value.h` (version history, `kWireFormatVersion = 21`) — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/serialized_script_value.h
- `serialized_script_value.cc` (`CanDeserializeIn`) — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/serialized_script_value.cc
- `v8_script_value_serializer.{cc,h}` (two-envelope comment, header write/back-patch) — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/v8_script_value_serializer.cc
- `v8_script_value_deserializer.cc` @ `9533c6cf5d638b0620ddab91b5e0d3e4636a2bb5` (host-object read order) — https://github.com/chromium/chromium/blob/9533c6cf5d638b0620ddab91b5e0d3e4636a2bb5/third_party/blink/renderer/bindings/core/v8/serialization/v8_script_value_deserializer.cc
- `trailer_reader.cc` / `trailer_writer.cc` — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/core/v8/serialization/trailer_reader.cc
- `serialized_params.h` (image sub-enums) — https://github.com/chromium/chromium/blob/9533c6cf5d638b0620ddab91b5e0d3e4636a2bb5/third_party/blink/renderer/bindings/core/v8/serialization/serialized_params.h
- `v8_script_value_deserializer_for_modules.cc` (CryptoKey) — https://github.com/chromium/chromium/blob/9533c6cf5d638b0620ddab91b5e0d3e4636a2bb5/third_party/blink/renderer/bindings/modules/v8/serialization/v8_script_value_deserializer_for_modules.cc
- `web_crypto_sub_tags.h` — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/bindings/modules/v8/serialization/web_crypto_sub_tags.h
- (cross-check) dfindexeddb `blink.py` — https://github.com/google/dfindexeddb/blob/main/dfindexeddb/indexeddb/chromium/blink.py
- (cross-check) CCL `ccl_chromium_indexeddb.py` — https://github.com/cclgroupltd/ccl_chromium_reader/blob/master/ccl_chromium_reader/ccl_chromium_indexeddb.py

**Chromium IndexedDB LevelDB coding (§3):**
- `indexed_db_leveldb_coding.cc` — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/indexed_db/indexed_db_leveldb_coding.cc
- `indexed_db_leveldb_coding.h` — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/indexed_db/indexed_db_leveldb_coding.h
- `docs/leveldb_coding_scheme.md` — https://chromium.googlesource.com/chromium/src/+/main/content/browser/indexed_db/docs/leveldb_coding_scheme.md
- `instance/leveldb/backing_store.cc` (PutRecord, EncodeExternalObjects) — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/indexed_db/instance/leveldb/backing_store.cc
- `instance/leveldb/indexed_db_leveldb_operations.cc` (`idb_cmp1`) — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/indexed_db/instance/leveldb/indexed_db_leveldb_operations.cc
- `file_path_util.cc` (blob paths) — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/indexed_db/file_path_util.cc
- (secondary) CCL "IndexedDB on Chromium" — https://www.cclsolutionsgroup.com/post/indexeddb-on-chromium

**LevelDB table + Snappy (§4):**
- `doc/table_format.md` — https://github.com/google/leveldb/blob/main/doc/table_format.md
- `table/format.h` — https://github.com/google/leveldb/blob/main/table/format.h
- `table/format.cc` — https://github.com/google/leveldb/blob/main/table/format.cc
- `table/table_builder.cc` — https://github.com/google/leveldb/blob/main/table/table_builder.cc
- `table/block_builder.cc` — https://github.com/google/leveldb/blob/main/table/block_builder.cc
- `table/block.cc` — https://github.com/google/leveldb/blob/main/table/block.cc
- `util/crc32c.h` — https://github.com/google/leveldb/blob/main/util/crc32c.h
- `include/leveldb/options.h` — https://github.com/google/leveldb/blob/main/include/leveldb/options.h
- `db/dbformat.h` — https://github.com/google/leveldb/blob/main/db/dbformat.h
- Chromium fork options.h (NO zstd) — https://chromium.googlesource.com/external/leveldatabase/+/HEAD/include/leveldb/options.h
- Chromium fork format.cc — https://chromium.googlesource.com/external/leveldatabase/+/HEAD/table/format.cc
- Snappy raw format spec — https://github.com/google/snappy/blob/main/format_description.txt

**Version-adaptation strategy (§5):**
- dfindexeddb `v8.py` — https://github.com/google/dfindexeddb/blob/main/dfindexeddb/indexeddb/chromium/v8.py
- dfindexeddb `record.py` — https://github.com/google/dfindexeddb/blob/main/dfindexeddb/indexeddb/chromium/record.py
- CCL `ccl_v8_value_deserializer.py` — https://github.com/cclgroupltd/ccl_chromium_reader/blob/master/ccl_chromium_reader/serialization_formats/ccl_v8_value_deserializer.py

---

## Appendix: items flagged uncertain / to verify against source before relying on

- **[INFERRED]** Exact originating CL/commit for `kImmutableArrayBuffer` (`0x43`) and
  `kFloat16Array` (`0x68`) — confirmed present in current V8 `main` and confirmed to postdate
  dfindexeddb's v15 sync, but the specific introducing commits were not pinned. Run
  `git log -S kImmutableArrayBuffer` on `value-serializer.cc` if needed.
- **[SECONDARY]** The IndexedDB `0x01` `kReplaceWithBlob` external-value wrapper that CCL peeks
  for *after* the Blink version varint (§2.3) — from CCL code, not reconciled against
  Chromium's backing-store source here. Investigate if you encounter records where the byte
  after the Blink version varint is `0x01` rather than V8's `0xFF`.
- **[VERIFY]** The 8-byte LevelDB internal-key trailer byte order (§4.5) was read via a
  summarized fetch, not raw source — re-verify `db/dbformat.h` if exact trailer offsets are
  load-bearing in your key decoder.
- **[TIME-SENSITIVE]** All version numbers (Blink `kWireFormatVersion = 21`, V8
  `kLatestVersion = 16`, and the observed V8 v13 in one agent's fetch of `master` at a
  different moment) roll forward. Read them from the buffer; the tables above tell you what
  each threshold *changes*, which is the durable part.
