import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Auto-detect the Teams IndexedDB leveldb dir. Returns ranked candidates (newest first).
// Manual override always wins: env TEAMS_LEVELDB_DIR or config.dir.
//
// Layout (new Teams / MSTeams / WebView2):
//   %LOCALAPPDATA%\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\EBWebView\<profile>\
//       IndexedDB\https_teams.*.indexeddb.leveldb
// <profile> is usually WV2Profile_tfw but varies; there can be several (multi-account).

function existsDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function mtime(p) { try { return fs.statSync(p).mtimeMs } catch { return 0 } }

// walk one level of children matching a predicate
function children(dir, test) {
  try { return fs.readdirSync(dir).filter(test).map(n => path.join(dir, n)) } catch { return [] }
}

// A leveldb dir is valid if it has CURRENT + a MANIFEST-*.
function isLevelDb(dir) {
  try {
    const files = fs.readdirSync(dir)
    return files.includes('CURRENT') && files.some(f => f.startsWith('MANIFEST-'))
  } catch { return false }
}

export function discoverTeamsDbs({ override } = {}) {
  if (override) return [{ dir: override, source: 'override', mtime: mtime(override), valid: isLevelDb(override) }]

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const packages = path.join(localAppData, 'Packages')
  const candidates = []

  for (const pkg of children(packages, n => /^MSTeams_/i.test(n))) {
    const ebweb = path.join(pkg, 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView')
    if (!existsDir(ebweb)) continue
    // profile dirs (WV2Profile_tfw, WV2Profile_*, "Default", …)
    for (const profile of children(ebweb, n => !n.startsWith('.'))) {
      const idbRoot = path.join(profile, 'IndexedDB')
      if (!existsDir(idbRoot)) continue
      for (const store of children(idbRoot, n => /^https_teams\..*\.indexeddb\.leveldb$/i.test(n))) {
        if (isLevelDb(store)) {
          candidates.push({
            dir: store, source: 'auto',
            package: path.basename(pkg), profile: path.basename(profile),
            origin: path.basename(store).replace(/\.indexeddb\.leveldb$/i, ''),
            mtime: mtime(store),
          })
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime) // most-recently-active first
  return candidates
}

if (process.argv[1] && process.argv[1].endsWith('discover.js')) {
  const found = discoverTeamsDbs({ override: process.env.TEAMS_LEVELDB_DIR })
  console.log(`found ${found.length} candidate(s):\n`)
  for (const c of found) {
    console.log(`• ${c.dir}`)
    console.log(`    origin=${c.origin ?? '-'} profile=${c.profile ?? '-'} lastModified=${c.mtime ? new Date(c.mtime).toISOString() : '?'}`)
  }
}
