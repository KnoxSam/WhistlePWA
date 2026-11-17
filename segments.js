/* Funzioni pure condivise tra pagina e worker: blocchi audio, segmenti, export. */
(function (root) {
  const WS = {};

  /** Divide l'audio in blocchi di ~chunkSec, tagliando nel punto più silenzioso degli ultimi 10 s. */
  WS.chunkBounds = function (samples, sr, chunkSec) {
    const n = samples.length, target = Math.round(chunkSec * sr);
    if (n <= target * 1.25) return [[0, n]];
    const frame = Math.round(sr * 0.1), search = sr * 10, bounds = [];
    let start = 0;
    while (n - start > target * 1.25) {
      const hi = start + target, lo = Math.max(start + sr, hi - search);
      let best = hi, bestE = Infinity;
      for (let f = lo; f + frame <= hi; f += frame) {
        let e = 0;
        for (let k = f; k < f + frame; k += 4) e += samples[k] * samples[k];
        if (e < bestE) { bestE = e; best = f + (frame >> 1); }
      }
      bounds.push([start, best]);
      start = best;
    }
    bounds.push([start, n]);
    return bounds;
  };

  WS.normWords = function (words, offset) {
    const out = [];
    for (const w of words || []) {
      const word = w.word ?? w.text;
      if (word == null || w.start == null || w.end == null) continue;
      const item = { start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3), word: String(word) };
      const p = w.probability ?? w.prob;
      if (p != null) item.prob = +(+p).toFixed(3);
      out.push(item);
    }
    return out;
  };

  WS.wordsToSegments = function (words, maxChars = 84, maxDur = 6, gap = 0.8) {
    const segs = [];
    let cur = [];
    const join = (ws) => ws.map((w) => (w.word.startsWith(" ") ? w.word : " " + w.word)).join("").trim();
    const flush = () => {
      if (cur.length) segs.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: join(cur) });
      cur = [];
    };
    for (const w of words) {
      if (cur.length) {
        const last = cur[cur.length - 1];
        const len = join(cur).length + w.word.length + 1;
        if (w.start - last.end > gap || w.end - cur[0].start > maxDur || len > maxChars ||
            /[.?!]$/.test(last.word.trim())) flush();
      }
      cur.push(w);
    }
    flush();
    return segs;
  };

  WS.ts = function (t, sep = ",") {
    let ms = Math.round(Math.max(t, 0) * 1000);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const p = (x, l = 2) => String(x).padStart(l, "0");
    return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
  };

  WS.toTxt = (r) => r.segments.length ? r.segments.map((s) => s.text).join("\n") + "\n" : r.text + "\n";
  WS.toSrt = (r) => r.segments.map((s, i) =>
    `${i + 1}\n${WS.ts(s.start)} --> ${WS.ts(s.end)}\n${s.text}\n`).join("\n");
  WS.toVtt = (r) => "WEBVTT\n\n" + r.segments.map((s) =>
    `${WS.ts(s.start, ".")} --> ${WS.ts(s.end, ".")}\n${s.text}\n`).join("\n");
  WS.toJson = (r) => JSON.stringify({
    language: r.language, duration: +r.duration.toFixed(3), text: r.text,
    segments: r.segments, words: r.words,
  }, null, 2);

  root.WS = WS;
  if (typeof module !== "undefined") module.exports = WS;
})(typeof self !== "undefined" ? self : globalThis);
