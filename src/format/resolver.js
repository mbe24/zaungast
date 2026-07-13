import fs from 'node:fs'
import { decodePrefix, readStringWithLength, readVarint, utf16be, decodeValue } from './idb.js'

// Resolve a mapping file against a fingerprint, then extract entities generically.

export function loadMapping(path) { return JSON.parse(fs.readFileSync(path, 'utf8')) }

// Pick a mapping for the given fingerprint: exact hash match, else store-presence match.
export function selectMapping(mappings, fp) {
  const storeSet = new Set(fp.stores.map(s => s.store))
  for (const m of mappings) if (m.knownFingerprints?.includes(fp.hash)) return { mapping: m, via: 'fingerprint' }
  for (const m of mappings) {
    const need = m.match?.requireStores ?? []
    if (need.every(s => storeSet.has(s))) return { mapping: m, via: 'store-presence (UNVERIFIED for this fingerprint)' }
  }
  return { mapping: null, via: 'none' }
}

const glob = (pat, s) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s)
function getPath(obj, path) {
  let cur = obj
  for (const part of path.split('.')) { if (cur == null) return undefined; cur = cur[part] }
  return cur
}
function firstDefined(obj, spec) {
  const paths = Array.isArray(spec) ? spec : [spec]
  for (const p of paths) { const v = getPath(obj, p); if (v !== undefined && v !== null && v !== '') return v }
  return undefined
}

// Build dbId->name and (dbId:osId)->storeName tables from the live entries.
function schemaTables(live) {
  const dbNames = new Map(), storeNames = new Map()
  for (const { key, value } of live) {
    if (key.length < 1) continue
    let p; try { p = decodePrefix(key) } catch { continue }
    const { databaseId, objectStoreId, indexId, headerLen } = p
    if (databaseId === 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0xc9) {
      const [, p2] = readStringWithLength(key, headerLen + 1)
      const [name] = readStringWithLength(key, p2)
      const [id] = readVarint(value, 0); dbNames.set(id, name)
    } else if (databaseId > 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0x32) {
      const [osId, pp] = readVarint(key, headerLen + 1)
      if (key[pp] === 0) storeNames.set(`${databaseId}:${osId}`, utf16be(value))
    }
  }
  return { dbNames, storeNames }
}

// The (dbId:osId) keys whose db/store match an entity definition. Computed from the FULL
// live set (needs db-name metadata); cached and reused for incremental extraction.
export function entityTargets(live, mapping, entityName) {
  const def = mapping.entities[entityName]
  const { dbNames, storeNames } = schemaTables(live)
  const targets = new Set()
  for (const [sk, storeName] of storeNames) {
    const dbId = Number(sk.split(':')[0])
    const dbName = dbNames.get(dbId)
    if (dbName && glob(def.db, dbName) && storeName === def.store) targets.add(sk)
  }
  return targets
}

// Extract rows for one entity definition. Each row carries __key = the source record's
// leveldb user-key (latin1) so callers can group messages by their reply-chain record.
// `targets` (from entityTargets) may be supplied to extract from a subset of `live` that
// lacks the db-name metadata (incremental path).
export function extractEntity(live, mapping, entityName, targets) {
  const def = mapping.entities[entityName]
  if (!targets) targets = entityTargets(live, mapping, entityName)

  const rows = []
  const mapFields = (src, recKey) => {
    const r = { __key: recKey }
    for (const [out, spec] of Object.entries(def.fields)) r[out] = firstDefined(src, spec)
    return r
  }

  for (const { key, value } of live) {
    let p; try { p = decodePrefix(key) } catch { continue }
    if (p.indexId !== 1) continue
    if (!targets.has(`${p.databaseId}:${p.objectStoreId}`)) continue
    let obj; try { obj = decodeValue(value) } catch { continue }
    if (!obj) continue
    const recKey = key.toString('latin1')
    if (def.iterate) {
      const container = getPath(obj, def.iterate.replace(/\.\*$/, ''))
      if (container && typeof container === 'object') {
        for (const item of Object.values(container)) {
          if (def.keep && item?.[def.keep.field] !== def.keep.equals) continue
          rows.push(mapFields(item, recKey))
        }
      }
    } else {
      rows.push(mapFields(obj, recKey))
    }
  }
  return rows
}
