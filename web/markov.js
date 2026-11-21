'use strict';

/**
 * Markov chain text generator (no DOM; also loads in Node for testing).
 *
 * The chain maps every run of `order` consecutive words in the source to the
 * words that followed it. Generating walks the chain: look at the last
 * `order` words written, pick one of the words that came after them in the
 * source, repeat. A higher order sticks closer to the source's phrasing.
 *
 * With line breaks kept, a line break is a token like any word, so the
 * output picks up the rhythm of the source's lines and stanzas.
 */
const Markov = (() => {
  const NL = '\n';
  const SEP = '\u0001';
  const isWord = (t) => t !== NL;

  /** Plain text from a note: drop Markdown markers, keep the words and lines. */
  function clean(body) {
    let inCode = false;
    return body
      .split('\n')
      .filter((line) => {
        if (/^\s*```/.test(line)) {
          inCode = !inCode;
          return false;
        }
        return !inCode && !/^\s*(-{3,}|\*{3,})\s*$/.test(line);
      })
      .map((line) =>
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
          .replace(/^\s*\d+[.)]\s+/, '')
          .replace(/^\s*>\s?/, '')
          .replace(/\*\*|__|~~|`/g, '')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      )
      .join('\n');
  }

  function tokenize(text, keepLines) {
    const out = [];
    for (const line of clean(text).split('\n')) {
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) {
        // A blank line: a stanza break (at most one empty line in a row).
        if (keepLines && out.length && out[out.length - 1] === NL && out[out.length - 2] !== NL) out.push(NL);
        continue;
      }
      out.push(...words);
      if (keepLines) out.push(NL);
    }
    while (out[out.length - 1] === NL) out.pop();
    return out;
  }

  // A natural place to begin: the start of a note, a line or a sentence.
  const isBoundary = (prev) => prev === undefined || prev === NL || /[.!?]["'’”)\]]*$/.test(prev);

  /**
   * @param {string[]} texts  note bodies
   * @param {{order?: number, keepLines?: boolean}} opts
   */
  function build(texts, { order = 2, keepLines = true } = {}) {
    const chain = new Map(); // key -> next tokens (repeats kept, for weighting)
    const starts = [];
    let words = 0;
    let used = 0;
    for (const text of texts) {
      const toks = tokenize(text, keepLines);
      words += toks.filter(isWord).length;
      if (toks.length <= order) continue;
      used++;
      for (let i = 0; i + order <= toks.length; i++) {
        const state = toks.slice(i, i + order);
        const key = state.join(SEP);
        if (i + order < toks.length) {
          let next = chain.get(key);
          if (!next) chain.set(key, (next = []));
          next.push(toks[i + order]);
        }
        if (isBoundary(toks[i - 1]) && !state.includes(NL)) starts.push(key);
      }
    }
    return { chain, starts, order, keepLines, words, notes: used };
  }

  const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  /**
   * @param model  from build()
   * @param {{words?: number, weighted?: boolean, seed?: string, random?: () => number}} opts
   * @returns {{text: string, words: number} | {error: string}}
   */
  function generate(model, { words = 100, weighted = true, seed = '', random = Math.random } = {}) {
    const { chain, starts, order, keepLines } = model;
    if (!starts.length) return { error: 'Not enough text to learn from.' };
    const pick = (arr) => arr[Math.floor(random() * arr.length)];

    let first = pick(starts);
    const s = norm(seed || '');
    if (s) {
      const keys = [...new Set(starts.filter((k) => norm(k.split(SEP)[0]) === s))];
      const anywhere = keys.length ? keys : [...chain.keys()].filter((k) => norm(k.split(SEP)[0]) === s);
      if (!anywhere.length) return { error: `“${seed}” isn't in the source notes.` };
      first = pick(anywhere);
    }

    const out = first.split(SEP);
    let count = out.filter(isWord).length;
    const target = Math.max(1, words);
    // Run to the target length, then finish the current line or sentence.
    const done = () =>
      count >= target &&
      (keepLines ? out[out.length - 1] === NL : /[.!?]["'’”)\]]*$/.test(out[out.length - 1]) || count >= target + 30);
    let guard = target * 20 + 200;

    while (!done() && guard-- > 0) {
      if (keepLines && count >= target + 30) break;
      const next = chain.get(out.slice(-order).join(SEP));
      let tok;
      if (!next) {
        // Dead end (the end of a note): carry on from a fresh starting point.
        if (keepLines && out[out.length - 1] !== NL) out.push(NL);
        const fresh = pick(starts).split(SEP);
        out.push(...fresh);
        count += fresh.filter(isWord).length;
        continue;
      }
      tok = weighted ? pick(next) : pick([...new Set(next)]);
      out.push(tok);
      if (isWord(tok)) count++;
    }

    let text = '';
    for (const t of out) {
      if (t === NL) text += '\n';
      else text += (text && !text.endsWith('\n') ? ' ' : '') + t;
    }
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return { text, words: count };
  }

  return { build, generate, tokenize };
})();

if (typeof module !== 'undefined') module.exports = Markov;
