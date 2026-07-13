import crypto from 'node:crypto'
import { decodePrefix, readStringWithLength, readVarint, utf16be } from './idb.js'
import { deserialize } from './ssv.js'

// Build a stable, PII-free fingerprint of the Teams IndexedDB schema:
//   - normalized database "kind" names (GUIDs / build tokens / locale stripped)
//   - object store names
//   - the set of top-level field keys seen in a sample of each store's records
// This identifies the Teams *schema version* without depending on volatile db ids or GUIDs.

function normalizeDbName(name) {
  return name
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/:en-us$|:[a-z]{2}-[a-z]{2}$/i, ':<locale>')
    .replace(/:\d+:/g, ':<n>:')
    .replace(/_\d+_/g, '_<n>_')
}

export function fingerprint(live, { samplePerStore = 5 } = {}) {
  const dbNames = new Map()          // dbId -> raw name
  const storeNames = new Map()       // `${dbId}:${osId}` -> name
  const sampleKeys = new Map()       // `${dbId}:${osId}` -> Set(field names)
  const sampleCounts = new Map()

  for (const { key, value } of live) {
    if (key.length < 1) continue
    let p; try { p = decodePrefix(key) } catch { continue }
    const { databaseId, objectStoreId, indexId, headerLen } = p
    if (databaseId === 0 && objectStoreId === 0 && indexId === 0) {
      if (key[headerLen] === 0xc9) {
        const [, p2] = readStringWithLength(key, headerLen + 1)
        const [name] = readStringWithLength(key, p2)
        const [id] = readVarint(value, 0)
        dbNames.set(id, name)
      }
    } else if (databaseId > 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0x32) {
      const [osId, pp] = readVarint(key, headerLen + 1)
      if (key[pp] === 0) storeNames.set(`${databaseId}:${osId}`, utf16be(value))
    } else if (indexId === 1) {
      const sk = `${databaseId}:${objectStoreId}`
      const n = sampleCounts.get(sk) || 0
      if (n < samplePerStore) {
        sampleCounts.set(sk, n + 1)
        try {
          const [, vpos] = readVarint(value, 0)
          const obj = deserialize(value.subarray(vpos))
          const set = sampleKeys.get(sk) || new Set()
          if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) set.add(k)
          sampleKeys.set(sk, set)
        } catch {}
      }
    }
  }

  // Assemble normalized store descriptors.
  const stores = []
  for (const [sk, storeName] of storeNames) {
    const dbId = Number(sk.split(':')[0])
    const dbName = dbNames.get(dbId)
    if (!dbName) continue
    stores.push({
      db: normalizeDbName(dbName),
      store: storeName,
      fields: [...(sampleKeys.get(sk) || [])].sort(),
    })
  }
  stores.sort((a, b) => (a.db + a.store).localeCompare(b.db + b.store))

  const canonical = JSON.stringify(stores.map(s => [s.db, s.store, s.fields]))
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return { hash, storeCount: stores.length, stores, dbCount: dbNames.size }
}
