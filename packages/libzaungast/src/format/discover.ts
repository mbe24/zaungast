import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DiscoveredStore, DiscoverOptions } from './types.js';

// Auto-detect the Teams IndexedDB leveldb dir. Returns ranked candidates (newest first).
// Manual override always wins: env TEAMS_LEVELDB_DIR or config.dir.
//
// Everything below the `EBWebView` dir is identical across platforms — only its location differs:
//   Windows: %LOCALAPPDATA%\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\EBWebView\
//   macOS:   ~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/
//            Microsoft/MSTeams/EBWebView/   (new Teams is a sandboxed app; observed on Teams 2.x)
// …then \<profile>\IndexedDB\https_teams.*.indexeddb.leveldb. <profile> is usually WV2Profile_tfw
// but varies, and there can be several (multi-account).

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// walk one level of children matching a predicate
function children(dir: string, test: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(test)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// A leveldb dir is valid if it has CURRENT + a MANIFEST-*.
function isLevelDb(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir);
    return files.includes('CURRENT') && files.some((f) => f.startsWith('MANIFEST-'));
  } catch {
    return false;
  }
}

// Collect candidate leveldb stores under one profile dir (WV2Profile_tfw, WV2Profile_*, "Default",
// …) — the innermost step of the discovery walk, pulled out to keep discoverTeamsDbs flat.
function candidatesInProfile(pkg: string, profile: string): DiscoveredStore[] {
  const idbRoot = path.join(profile, 'IndexedDB');
  if (!existsDir(idbRoot)) return [];
  const found: DiscoveredStore[] = [];
  for (const store of children(idbRoot, (n) => /^https_teams\..*\.indexeddb\.leveldb$/i.test(n))) {
    if (isLevelDb(store)) {
      found.push({
        dir: store,
        source: 'auto',
        package: path.basename(pkg),
        profile: path.basename(profile),
        origin: path.basename(store).replace(/\.indexeddb\.leveldb$/i, ''),
        mtime: mtime(store),
      });
    }
  }
  return found;
}

// The EBWebView root(s) holding the WebView2 profiles, per platform. Only this step is
// OS-specific; the profile→IndexedDB→leveldb walk below is shared. platform/home/localAppData are
// parameters (not read directly) so discovery can be tested for either OS on any host.
function ebWebViewRoots(
  platform: NodeJS.Platform,
  home: string,
  localAppData: string,
): { pkg: string; ebweb: string }[] {
  const roots: { pkg: string; ebweb: string }[] = [];
  if (platform === 'darwin') {
    // new Teams (bundle id com.microsoft.teams2) is sandboxed — its store lives in the container.
    const ebweb = path.join(
      home,
      'Library',
      'Containers',
      'com.microsoft.teams2',
      'Data',
      'Library',
      'Application Support',
      'Microsoft',
      'MSTeams',
      'EBWebView',
    );
    if (existsDir(ebweb)) roots.push({ pkg: 'com.microsoft.teams2', ebweb });
  } else {
    // Windows: one EBWebView per MSTeams_* package under %LOCALAPPDATA%\Packages.
    for (const pkg of children(path.join(localAppData, 'Packages'), (n) => /^MSTeams_/i.test(n))) {
      const ebweb = path.join(pkg, 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView');
      if (existsDir(ebweb)) roots.push({ pkg, ebweb });
    }
  }
  return roots;
}

export function discoverTeamsDbs(
  { override }: DiscoverOptions = {},
  env: { platform?: NodeJS.Platform; home?: string; localAppData?: string } = {},
): DiscoveredStore[] {
  if (override)
    return [
      { dir: override, source: 'override', mtime: mtime(override), valid: isLevelDb(override) },
    ];

  const home = env.home ?? os.homedir();
  const platform = env.platform ?? process.platform;
  const localAppData =
    env.localAppData ?? process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  const candidates: DiscoveredStore[] = [];
  for (const { pkg, ebweb } of ebWebViewRoots(platform, home, localAppData)) {
    // profile dirs (WV2Profile_tfw, WV2Profile_*, "Default", …)
    for (const profile of children(ebweb, (n) => !n.startsWith('.')))
      candidates.push(...candidatesInProfile(pkg, profile));
  }
  candidates.sort((a, b) => b.mtime - a.mtime); // most-recently-active first
  return candidates;
}

if (process.argv[1]?.endsWith('discover.js')) {
  const found = discoverTeamsDbs({ override: process.env.TEAMS_LEVELDB_DIR });
  console.log(`found ${found.length} candidate(s):\n`);
  for (const c of found) {
    console.log(`• ${c.dir}`);
    console.log(
      `    origin=${c.origin ?? '-'} profile=${c.profile ?? '-'} lastModified=${c.mtime ? new Date(c.mtime).toISOString() : '?'}`,
    );
  }
}
