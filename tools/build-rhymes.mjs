// Builds web/rhymes.txt: the offline rhyming dictionary used by the app.
//
// Pronunciations come from the CMU Pronouncing Dictionary; only words that
// also appear in the SUBTLEX-US subtitle corpus are kept (this drops most
// names and junk), and each rhyme group is ordered from most to least common.
//
// Output, one rhyme group per line:   KEY<TAB>word2 word1 ...
// KEY is the phonemes from the last stressed vowel to the end, stress marks
// removed (e.g. "AH V" for love). The digit after each word is its number
// of syllables.
import { readFileSync, writeFileSync } from 'node:fs';
import { dictionary } from 'cmu-pronouncing-dictionary';

const freqList = JSON.parse(
  readFileSync(new URL('../node_modules/subtlex-word-frequencies/index.json', import.meta.url), 'utf8')
);
const freq = new Map();
for (const { word, count } of freqList) {
  const w = word.toLowerCase();
  freq.set(w, (freq.get(w) || 0) + count);
}

const MIN_COUNT = 4;
const groups = new Map(); // key -> Map(word -> syllables)

for (const [entry, pron] of Object.entries(dictionary)) {
  const word = entry.replace(/\(\d+\)$/, '');
  if (!/^[a-z][a-z']*$/.test(word)) continue;
  const count = freq.get(word) || 0;
  if (count < MIN_COUNT) continue;
  // Short entries are mostly abbreviations and names unless very common.
  if (word.length === 1 && word !== 'a' && word !== 'i') continue;
  if (word.length === 2 && count < 3000) continue;
  if (word.length === 3 && count < 300) continue;

  const phones = pron.trim().split(/\s+/);
  const isVowel = (p) => /\d$/.test(p);
  let idx = phones.findLastIndex((p) => p.endsWith('1'));
  if (idx === -1) idx = phones.findLastIndex((p) => p.endsWith('2'));
  if (idx === -1) idx = phones.findLastIndex(isVowel);
  if (idx === -1) continue;

  const key = phones.slice(idx).map((p) => p.replace(/\d/, '')).join(' ');
  const syllables = Math.min(9, phones.filter(isVowel).length);
  if (!groups.has(key)) groups.set(key, new Map());
  groups.get(key).set(word, syllables);
}

const lines = [...groups.entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([key, words]) => {
    const sorted = [...words.entries()].sort((a, b) => freq.get(b[0]) - freq.get(a[0]));
    return key + '\t' + sorted.map(([w, s]) => w + s).join(' ');
  });

writeFileSync(new URL('../web/rhymes.txt', import.meta.url), lines.join('\n') + '\n');
const total = [...groups.values()].reduce((n, g) => n + g.size, 0);
console.log(`rhymes.txt: ${groups.size} rhyme groups, ${total} entries`);
