// Keyword/phrase extraction for rank_topics (RAKE-style, stopword + name + code-id filtered).
import { getStopwords, DEFAULT_LANGUAGES } from '../lang/index.js';

const looksHex = (w: string) => /^[0-9a-f]{5,}$/i.test(w) && !/[gh-z]/i.test(w);

// `extraStopwords` (optional) are merged into the default language stopword set — a consumer-facing
// hook so a downstream caller can suppress domain-specific noise phrases. When omitted the behavior
// is byte-identical to the language-default set (getStopwords returns a fresh Set, so mutating it is
// local to this extractor). Words are lowercased to match the tokenizer.
export function makeExtractor(
  nameTokens: Set<string>,
  languages: string[] = DEFAULT_LANGUAGES,
  extraStopwords?: Iterable<string>,
) {
  const STOP = getStopwords(languages);
  if (extraStopwords)
    for (const w of extraStopwords) {
      const s = String(w).toLowerCase();
      if (s) STOP.add(s);
    }
  const isStop = (w: string) => STOP.has(w) || w.length < 3;
  const bad = (w: string) => nameTokens.has(w) || looksHex(w);
  const tokens = (text: string) =>
    (text.toLowerCase().match(/[\p{L}\p{M}][\p{L}\p{M}'’-]{2,}/gu) || []).map((w) =>
      w.replace(/[’']s$/, ''),
    );
  const phrases = (text: string): string[] => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      for (let n = 1; n <= 3 && n <= run.length; n++)
        for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n).join(' '));
      run = [];
    };
    for (const w of tokens(text)) {
      if (isStop(w) || bad(w)) flush();
      else run.push(w);
    }
    flush();
    return out;
  };
  return { phrases };
}
