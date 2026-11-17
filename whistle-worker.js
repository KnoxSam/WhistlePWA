/* Web Worker: carica il motore Cactus (WASM) e il modello Whistle, trascrive a blocchi.
 * API C usata (da cactus.h 4.x, come nel pacchetto Python ufficiale):
 *   int cactus_load(const uint8_t* data, size_t len)
 *   int cactus_transcribe(const float* pcm, size_t n, const char* lang, const char* keywords,
 *                         int word_timestamps, char* out, size_t out_cap)   -> JSON UTF-8 in out
 *   const char* cactus_last_error(void)
 */
importScripts("segments.js");

const SR = 16000;
const OUTPUT_BYTES_PER_SECOND = 4096; // stesso valore del client Python
const HF = "https://huggingface.co/Cactus-Compute/";
// Motori da provare in ordine (il primo che carica il modello vince)
const ENGINES = ["4.1.1", "4.0.0"].map((v) => ({
  version: v,
  js: `${HF}cactus/resolve/main/releases/${v}/wasm/cactus.js`,
  wasm: `${HF}cactus/resolve/main/releases/${v}/wasm/cactus.wasm`,
}));
const MODEL_URL = `${HF}whistle/resolve/main/whistle.cact`;
const FILE_CACHE = "whistle-runtime";
let M = null;

function post(type, data = {}) { self.postMessage({ type, ...data }); }
function log(msg) { post("log", { msg }); }

/** Scarica un file una volta sola e lo tiene nella cache del telefono (uso offline). */
async function cachedFetch(url) {
  let cache = null;
  try { cache = await caches.open(FILE_CACHE); } catch {}
  const hit = cache && await cache.match(url);
  if (hit) return { res: hit, cached: true, cache };
  const res = await fetch(url, { mode: "cors" });
  return { res, cached: false, cache };
}

async function fetchBytes(url, label) {
  const { res, cached, cache } = await cachedFetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} (${url})`);
  if (!cached) log(`Scarico ${label}…`);
  const bytes = await readWithProgress(res, label);
  if (!cached && cache) {
    try { await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })); }
    catch (e) { log(`Non riesco a salvare ${label} per l'uso offline: ${e.message}`); }
  }
  return bytes;
}

async function readWithProgress(res, label) {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    post("loading", { label, frac: Math.min(got / total, 1) });
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Chiama una funzione del motore. Alcuni parametri (es. le lunghezze size_t/int64) nel build WASM
 * sono a 64 bit e JavaScript li vuole come BigInt: se il motore lo segnala ("can't convert N to
 * BigInt"), converto quel parametro, riprovo e ricordo la scelta per le chiamate successive.
 */
const BIG_ARGS = {};
function call(name, ...args) {
  const fn = M["_" + name];
  if (typeof fn !== "function") throw new Error(`funzione ${name} assente nel motore`);
  const big = BIG_ARGS[name] || (BIG_ARGS[name] = new Set());
  for (let attempt = 0; attempt <= args.length; attempt++) {
    const a = args.map((v, i) => (big.has(i) ? BigInt(Math.trunc(v)) : v));
    try {
      const r = fn(...a);
      return typeof r === "bigint" ? Number(r) : r;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/convert .*to (a )?BigInt/i.test(msg)) throw e;
      const num = (msg.match(/-?\d+/) || [])[0];
      let idx = num == null ? -1 : args.findIndex((v, i) => !big.has(i) && typeof v === "number" && String(v) === num);
      if (idx < 0) idx = args.findIndex((v, i) => !big.has(i) && typeof v === "number");
      if (idx < 0) throw e;
      big.add(idx);
      log(`${name}: parametro ${idx + 1} passato come intero a 64 bit`);
    }
  }
  throw new Error(`${name}: tipi dei parametri non riconosciuti`);
}

function heap() { return M.HEAPU8; } // la vista può cambiare quando la memoria cresce

function allocBytes(bytes) {
  const ptr = M._malloc(bytes.length || 1);
  if (!ptr) throw new Error("memoria WASM esaurita");
  heap().set(bytes, ptr);
  return ptr;
}

function allocString(s) {
  if (!s) return 0;
  const b = new TextEncoder().encode(s);
  const z = new Uint8Array(b.length + 1);
  z.set(b);
  return allocBytes(z);
}

function lastError() {
  try { return M.UTF8ToString(M._cactus_last_error()) || "errore sconosciuto"; }
  catch { return "errore sconosciuto"; }
}

async function loadEngine(engine) {
  const jsBytes = await fetchBytes(engine.js, "motore (js)");
  self.createCactus = undefined;
  // il loader viene eseguito da un blob: funziona anche offline, dalla cache
  const blobUrl = URL.createObjectURL(new Blob([jsBytes], { type: "text/javascript" }));
  try { importScripts(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
  if (typeof createCactus !== "function") throw new Error("cactus.js non espone createCactus");
  const wasmBinary = await fetchBytes(engine.wasm, "motore");
  return createCactus({
    wasmBinary,
    print: (t) => log(t),
    printErr: (t) => log("[engine] " + t),
  });
}

async function init() {
  const t0 = performance.now();
  const model = await fetchBytes(MODEL_URL, "modello");
  let lastErr = null;
  for (const engine of ENGINES) {
    try {
      M = await loadEngine(engine);
      const ptr = allocBytes(model); // non viene liberato: il motore può riferirsi a questi byte
      const rc = call("cactus_load", ptr, model.length);
      if (rc < 0) throw new Error("cactus_load: " + lastError());
      log(`Motore Cactus ${engine.version} pronto`);
      post("ready", { ms: Math.round(performance.now() - t0), modelMB: +(model.length / 1048576).toFixed(1) });
      return;
    } catch (e) {
      lastErr = e;
      log(`Motore ${engine.version} non utilizzabile: ${e.message}`);
      M = null;
    }
  }
  throw lastErr || new Error("nessun motore disponibile");
}

function transcribeChunk(samples, lang, keywords) {
  const seconds = Math.ceil(samples.length / SR);
  const cap = Math.max(1 << 18, seconds * OUTPUT_BYTES_PER_SECOND);
  const pcm = allocBytes(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  const langPtr = allocString(lang);
  const kwPtr = allocString(keywords);
  const out = M._malloc(cap);
  try {
    heap()[out] = 0;
    const rc = call("cactus_transcribe", pcm, samples.length, langPtr, kwPtr, 1, out, cap);
    if (rc < 0) throw new Error("cactus_transcribe: " + lastError());
    const txt = M.UTF8ToString(out, cap);
    return txt ? JSON.parse(txt) : { text: "" };
  } finally {
    M._free(pcm); M._free(out);
    if (langPtr) M._free(langPtr);
    if (kwPtr) M._free(kwPtr);
  }
}

function transcribe({ samples, lang, keywords, chunkSec }) {
  const t0 = performance.now();
  const bounds = WS.chunkBounds(samples, SR, chunkSec || 120);
  const words = [], texts = [], extraSegs = [];
  let language = lang || null, tps = [];
  bounds.forEach(([a, b], i) => {
    const res = transcribeChunk(samples.subarray(a, b), lang, keywords);
    const off = a / SR;
    if (res.language) language = language || res.language;
    if (typeof res.decode_tps === "number") tps.push(res.decode_tps);
    const t = (res.text || "").trim();
    if (t) texts.push(t);
    const ws = WS.normWords(res.words || [], off);
    if (ws.length) words.push(...ws);
    else if (t) extraSegs.push({ start: off, end: b / SR, text: t });
    post("progress", { done: i + 1, total: bounds.length, text: texts.join(" ") });
  });
  const segments = words.length ? WS.wordsToSegments(words) : extraSegs;
  post("result", {
    result: {
      text: texts.join(" "),
      language: language || "?",
      duration: samples.length / SR,
      segments,
      words,
      elapsedMs: Math.round(performance.now() - t0),
      decodeTps: tps.length ? Math.round(tps.reduce((x, y) => x + y) / tps.length) : null,
    },
  });
}

/* ------------------------------------------------------------------ dal vivo
 * Modalità "native": cactus_stream_transcribe_process(pcm, n, lang, keywords, out, cap) per ogni
 * ~1 s di audio, cactus_stream_transcribe_stop(out, cap) alla fine (come cactus.stream in Python).
 * Se lo streaming non è disponibile: modalità "chunk", blocchi di 10-15 s tagliati nelle pause.
 */
const LIVE_CAP = 4 << 20;
let live = null;

function liveStart({ lang, keywords }) {
  if (live) liveFree();
  live = {
    lang, keywords,
    langPtr: allocString(lang), kwPtr: allocString(keywords), out: M._malloc(LIVE_CAP),
    mode: typeof M._cactus_stream_transcribe_process === "function" ? "native" : "chunk",
    committed: "", pending: "", words: [], orphans: [], language: lang || null,
    received: 0,            // campioni ricevuti
    chunkBuf: [], chunkLen: 0, chunkOffset: 0, // per la modalità chunk
    t0: performance.now(), lastPassMs: 0,
  };
  log(`Dal vivo: modalità ${live.mode === "native" ? "streaming Whistle" : "a blocchi"}`);
}

function liveFree() {
  if (!live) return;
  M._free(live.out);
  if (live.langPtr) M._free(live.langPtr);
  if (live.kwPtr) M._free(live.kwPtr);
  live = null;
}

function readOut() {
  const txt = M.UTF8ToString(live.out, LIVE_CAP);
  return txt ? JSON.parse(txt) : {};
}

function addOrphan(text) {
  // testo senza tempi per parola: lo colloco dopo l'ultima parola nota
  const last = live.orphans.length ? live.orphans[live.orphans.length - 1].end : 0;
  const lastWord = live.words.length ? live.words[live.words.length - 1].end : 0;
  const start = Math.max(last, lastWord), end = Math.max(start, live.received / SR);
  live.orphans.push({ start: +start.toFixed(3), end: +end.toFixed(3), text });
}

function applyStream(res) {
  if (res.language) live.language = res.language;
  const t = (res.text || "").trim();
  const before = live.committed;
  if (t) {
    // il testo può arrivare cumulativo o solo la parte nuova: gestisco entrambi i casi
    if (t.startsWith(live.committed)) live.committed = t;
    else live.committed = (live.committed + " " + t).trim();
  }
  const added = live.committed.startsWith(before) ? live.committed.slice(before.length).trim() : t;
  const ws = WS.normWords(res.words || [], 0);
  if (added && !ws.length) addOrphan(added);
  if (ws.length) {
    const cumulative = live.words.length && ws.length >= live.words.length &&
      Math.abs(ws[0].start - live.words[0].start) < 0.01;
    if (cumulative) live.words = ws; else live.words.push(...ws);
  }
  live.pending = (res.pending || "").trim();
  if (typeof res.pass_ms === "number") live.lastPassMs = res.pass_ms;
}

function chunkFlush(final) {
  if (!live.chunkLen) return;
  const buf = new Float32Array(live.chunkLen);
  let o = 0;
  for (const c of live.chunkBuf) { buf.set(c, o); o += c.length; }
  let cut = buf.length;
  if (!final) {
    // taglio nel punto più silenzioso degli ultimi 3 s
    const frame = SR / 10;
    let best = Infinity;
    for (let f = Math.max(0, buf.length - 3 * SR); f + frame <= buf.length; f += frame) {
      let e = 0;
      for (let k = f; k < f + frame; k += 4) e += buf[k] * buf[k];
      if (e < best) { best = e; cut = f + frame / 2; }
    }
  }
  const head = buf.subarray(0, cut), rest = buf.slice(cut);
  const t0 = performance.now();
  const res = transcribeChunk(head, live.lang, live.keywords);
  live.lastPassMs = Math.round(performance.now() - t0);
  if (res.language) live.language = live.language || res.language;
  const t = (res.text || "").trim();
  if (t) live.committed = (live.committed + " " + t).trim();
  const ws = WS.normWords(res.words || [], live.chunkOffset / SR);
  live.words.push(...ws);
  if (t && !ws.length) live.orphans.push({ start: +(live.chunkOffset / SR).toFixed(3),
    end: +((live.chunkOffset + cut) / SR).toFixed(3), text: t });
  live.chunkOffset += cut;
  live.chunkBuf = rest.length ? [rest] : [];
  live.chunkLen = rest.length;
}

function liveChunk({ samples }) {
  if (!live) return;
  live.received += samples.length;
  if (live.mode === "native") {
    const pcm = allocBytes(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    try {
      heap()[live.out] = 0;
      const rc = call("cactus_stream_transcribe_process", pcm, samples.length, live.langPtr, live.kwPtr,
        live.out, LIVE_CAP);
      if (rc < 0) throw new Error(lastError());
      applyStream(readOut());
    } catch (e) {
      log(`Streaming non disponibile (${e.message}): passo alla modalità a blocchi`);
      live.mode = "chunk";
      live.chunkOffset = live.received - samples.length;
    } finally { M._free(pcm); }
  }
  if (live.mode === "chunk") {
    live.chunkBuf.push(samples.slice());
    live.chunkLen += samples.length;
    if (live.chunkLen >= 12 * SR) chunkFlush(false);
  }
  post("live", { committed: live.committed, pending: live.pending, seconds: live.received / SR,
                 passMs: live.lastPassMs, mode: live.mode });
}

function liveStop() {
  if (!live) return;
  if (live.mode === "native") {
    try {
      heap()[live.out] = 0;
      const rc = call("cactus_stream_transcribe_stop", live.out, LIVE_CAP);
      if (rc < 0) throw new Error(lastError());
      const res = readOut();
      applyStream(res);
      if (live.pending) {
        live.committed = (live.committed + " " + live.pending).trim();
        addOrphan(live.pending);
      }
    } catch (e) { log("Chiusura streaming: " + e.message); }
  } else {
    chunkFlush(true);
  }
  const duration = live.received / SR;
  const segments = WS.wordsToSegments(live.words).concat(live.orphans).sort((a, b) => a.start - b.start);
  post("result", {
    result: {
      text: live.committed, language: live.language || "?", duration, segments, words: live.words,
      elapsedMs: Math.round(performance.now() - live.t0), decodeTps: null, live: true,
    },
  });
  liveFree();
}

self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === "init") await init();
    else if (type === "transcribe") transcribe(e.data);
    else if (type === "live_start") liveStart(e.data);
    else if (type === "live_chunk") liveChunk(e.data);
    else if (type === "live_stop") liveStop();
  } catch (err) {
    post("error", { msg: String(err && err.message || err) });
  }
};
