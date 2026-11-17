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
      const rc = M._cactus_load(ptr, model.length);
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
    const rc = M._cactus_transcribe(pcm, samples.length, langPtr, kwPtr, 1, out, cap);
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

self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === "init") await init();
    else if (type === "transcribe") transcribe(e.data);
  } catch (err) {
    post("error", { msg: String(err && err.message || err) });
  }
};
