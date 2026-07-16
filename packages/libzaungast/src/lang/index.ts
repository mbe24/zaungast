// Extensible stopword registry. Add a new language by dropping in `xx.ts`
// (exporting `code` + `stopwords`) and registering it here — nothing else changes.
import * as en from './en.js';
import * as de from './de.js';

const LANGS: Record<string, string> = {
  [en.code]: en.stopwords,
  [de.code]: de.stopwords,
};

export const AVAILABLE_LANGUAGES = Object.keys(LANGS);
export const DEFAULT_LANGUAGES = ['en', 'de'];

// Merge stopwords for the requested languages into one lowercase Set.
export function getStopwords(languages: string[] = DEFAULT_LANGUAGES): Set<string> {
  const set = new Set<string>();
  for (const code of languages) {
    const words = LANGS[code];
    if (!words) continue;
    for (const w of words.toLowerCase().split(/\s+/)) if (w) set.add(w);
  }
  return set;
}
