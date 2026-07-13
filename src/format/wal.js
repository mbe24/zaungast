// LevelDB write-ahead-log (.log) parser.
// Block = 32768 bytes. Record header = crc(4) + length(2 LE) + type(1).
//   type: 1=FULL, 2=FIRST, 3=MIDDLE, 4=LAST  (0 = zero/padding)
// A reassembled record is a WriteBatch:
//   header: sequence(8 LE) + count(4 LE); then `count` ops:
//     op: 1=kTypeValue -> key(varlen)+value(varlen); 0=kTypeDeletion -> key(varlen)
import fs from 'node:fs'
import { crc32c, unmaskCrc } from './sstable.js'

const BLOCK = 32768
const HEADER = 7

function readVarint(buf, off) {
  let v = 0, shift = 0, pos = off
  while (true) { const c = buf[pos++]; v += (c & 0x7f) * 2 ** shift; if (!(c & 0x80)) break; shift += 7 }
  return [v, pos]
}

// Return array of {sequence, ops:[{type,key,value}]}
export function parseLog(path) {
  const data = fs.readFileSync(path)
  const batches = []
  let pos = 0
  let frag = null // {parts:[]}

  while (pos + HEADER <= data.length) {
    const blockOff = pos % BLOCK
    if (BLOCK - blockOff < HEADER) { pos += BLOCK - blockOff; continue } // trailer padding
    const storedCrc = data.readUInt32LE(pos)
    const len = data.readUInt16LE(pos + 4)
    const type = data[pos + 6]
    const dataStart = pos + HEADER
    if (type === 0 && len === 0) { // zero padding to block end
      pos += BLOCK - blockOff
      continue
    }
    // A copy taken mid-append can have a torn tail. Verify the record CRC (covers type+data)
    // and treat the first bad/short record as end-of-log (leveldb's own recovery semantics).
    // NOTE: a torn tail here is deliberately NOT "lossy" — the WAL is append-only and we read
    // sequentially from offset 0, so the parsed prefix is a consistent earlier point-in-time and
    // never regresses below an already-read seq; the truncated batch is picked up next refresh.
    if (dataStart + len > data.length) break
    if (unmaskCrc(storedCrc) !== crc32c(data, pos + 6, pos + 7 + len)) break
    const chunk = data.subarray(dataStart, dataStart + len)
    pos = dataStart + len

    if (type === 1) { emit(chunk) }               // FULL
    else if (type === 2) { frag = [chunk] }         // FIRST
    else if (type === 3) { if (frag) frag.push(chunk) } // MIDDLE
    else if (type === 4) { if (frag) { frag.push(chunk); emit(Buffer.concat(frag)); frag = null } } // LAST
  }

  function emit(record) {
    if (record.length < 12) return
    const sequence = Number(record.readBigUInt64LE(0))
    const count = record.readUInt32LE(8)
    let p = 12
    const ops = []
    for (let i = 0; i < count && p < record.length; i++) {
      const opType = record[p++]
      let klen, vlen, key, value
      ;[klen, p] = readVarint(record, p)
      key = record.subarray(p, p + klen); p += klen
      if (opType === 1) { [vlen, p] = readVarint(record, p); value = record.subarray(p, p + vlen); p += vlen }
      ops.push({ type: opType, key: Buffer.from(key), value: value ? Buffer.from(value) : null })
    }
    batches.push({ sequence, ops })
  }

  return batches
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const batches = parseLog(process.argv[2])
  let ops = 0; for (const b of batches) ops += b.ops.length
  console.log(`batches: ${batches.length}, total ops: ${ops}`)
}
