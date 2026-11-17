/* Pagina principale: decodifica audio (al posto di ffmpeg), registra, mostra ed esporta i risultati. */
"use strict";

const SR = 16000;
const $ = (id) => document.getElementById(id);

const ui = {
  pill: $("pill"), file: $("file"), pick: $("pickBtn"), rec: $("recBtn"), lang: $("lang"), kw: $("kw"),
  work: $("work"), fname: $("fname"), bar: $("barFill"), status: $("status"),
  card: $("resultCard"), meta: $("meta"), text: $("text"), segs: $("segs"), log: $("log"),
};

let worker, ready, readyResolve, readyReject, busy = false, current = null, recorder = null;
ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
ready.catch(() => {});

/* ---------------------------------------------------------------- utility */
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  ui.log.textContent += line;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function pill(text, cls = "") { ui.pill.textContent = text; ui.pill.className = "pill " + cls; }
function setStatus(text, frac) {
  ui.status.textContent = text;
  if (frac != null) ui.bar.style.width = Math.round(frac * 100) + "%";
}
function fmtDur(s) {
  s = Math.round(s); const m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(r).padStart(2, "0")}`;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem("whistle." + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("whistle." + k, v); } catch {} },
};

/* ---------------------------------------------------------------- worker */
function startWorker() {
  worker = new Worker("whistle-worker.js");
  worker.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
      case "log": log(d.msg); break;
      case "loading": pill(`Scarico ${d.label} ${Math.round(d.frac * 100)}%`); break;
      case "ready":
        pill("Modello pronto", "ok");
        log(`Modello caricato (${d.modelMB} MB) in ${d.ms} ms`);
        readyResolve(); break;
      case "progress":
        setStatus(`Trascrizione… blocco ${d.done}/${d.total}`, 0.1 + 0.9 * d.done / d.total);
        if (d.text) { ui.card.classList.remove("hidden"); ui.text.textContent = d.text + " …"; }
        break;
      case "result": onResult(d.result); break;
      case "error":
        log("ERRORE: " + d.msg);
        if (!busy) {
          pill(/fetch|network|HTTP/i.test(d.msg) ? "Download non riuscito: serve internet" : "Errore modello", "err");
          readyReject(new Error(d.msg));
        }
        else { setStatus("Errore: " + d.msg); endBusy(); }
        break;
    }
  };
  worker.onerror = (e) => { log("Worker: " + e.message); pill("Errore", "err"); };
  pill("Preparo il modello…");
  worker.postMessage({ type: "init" });
}

/* ---------------------------------------------------------------- audio */
async function decodeTo16kMono(arrayBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let buf;
  try {
    // decodeAudioData ricampiona già alla frequenza del contesto (16 kHz)
    buf = await new Offline(1, 1, SR).decodeAudioData(arrayBuffer.slice(0));
  } catch (e) {
    log("Decodifica a 16 kHz non riuscita, riprovo alla frequenza nativa: " + e.message);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    ctx.close();
  }
  const n = buf.length, ch = buf.numberOfChannels;
  let mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  if (buf.sampleRate !== SR) mono = resampleLinear(mono, buf.sampleRate, SR);
  return mono;
}

function resampleLinear(x, from, to) {
  const ratio = from / to, n = Math.floor(x.length / ratio), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    y[i] = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f;
  }
  return y;
}

/* ---------------------------------------------------------------- flusso */
let wakeLock = null;
async function startBusy() {
  busy = true;
  ui.pick.classList.add("disabled"); ui.rec.disabled = true;
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
function endBusy() {
  busy = false;
  ui.pick.classList.remove("disabled"); ui.rec.disabled = false;
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

async function handleFile(blob, name) {
  if (busy) return;
  await startBusy();
  ui.work.classList.remove("hidden");
  ui.card.classList.add("hidden");
  ui.fname.textContent = name;
  current = { name: name.replace(/\.[^.]+$/, "") || "trascrizione" };
  try {
    setStatus("Lettura del file…", 0.02);
    const ab = await blob.arrayBuffer();
    setStatus("Conversione audio a 16 kHz mono…", 0.05);
    const samples = await decodeTo16kMono(ab);
    const dur = samples.length / SR;
    log(`${name}: ${fmtDur(dur)} di audio, ${(blob.size / 1048576).toFixed(1)} MB`);
    if (!dur) throw new Error("nessun audio nel file");
    setStatus(ready ? "In attesa del modello…" : "", 0.08);
    await ready;
    setStatus(`Trascrizione di ${fmtDur(dur)}…`, 0.1);
    const lang = ui.lang.value;
    const keywords = ui.kw.value.split(",").map((s) => s.trim()).filter(Boolean).join("\n");
    worker.postMessage({ type: "transcribe", samples, lang, keywords, chunkSec: 120 }, [samples.buffer]);
  } catch (e) {
    log("ERRORE: " + (e.message || e));
    setStatus("Impossibile leggere questo file: " + (e.message || e) +
      ". Prova un formato diverso (mp3, m4a, wav).");
    endBusy();
  }
}

function onResult(r) {
  current.result = r;
  endBusy();
  const speed = r.elapsedMs ? (r.duration / (r.elapsedMs / 1000)).toFixed(1) : "?";
  setStatus(`Fatto in ${fmtDur(r.elapsedMs / 1000)} (${speed}× tempo reale)`, 1);
  ui.meta.textContent = `Lingua: ${r.language} · durata ${fmtDur(r.duration)} · ${r.segments.length} segmenti`;
  ui.text.textContent = WS.toTxt(r).trim() || "(nessun parlato riconosciuto)";
  ui.segs.innerHTML = "";
  for (const s of r.segments) {
    const row = document.createElement("div");
    const t = document.createElement("span");
    t.textContent = WS.ts(s.start, ".").slice(0, 8).replace(/^00:/, "");
    const p = document.createElement("p");
    p.style.margin = "0"; p.textContent = s.text;
    row.append(t, p); ui.segs.append(row);
  }
  ui.card.classList.remove("hidden");
  log(`Trascritto: ${r.text.length} caratteri, ${r.decodeTps ?? "?"} tok/s`);
}

/* ---------------------------------------------------------------- export */
const FORMATS = {
  txt: ["text/plain", WS.toTxt], srt: ["application/x-subrip", WS.toSrt],
  vtt: ["text/vtt", WS.toVtt], json: ["application/json", WS.toJson],
};
function makeFile(fmt) {
  const [type, fn] = FORMATS[fmt];
  return new File([fn(current.result)], `${current.name}.${fmt}`, { type });
}
function download(fmt) {
  if (!current?.result) return;
  const f = makeFile(fmt), a = document.createElement("a");
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
document.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => download(b.dataset.fmt)));

$("copyBtn").addEventListener("click", async () => {
  if (!current?.result) return;
  try { await navigator.clipboard.writeText(WS.toTxt(current.result)); $("copyBtn").textContent = "Copiato ✓"; }
  catch { $("copyBtn").textContent = "Copia non riuscita"; }
  setTimeout(() => ($("copyBtn").textContent = "Copia testo"), 1500);
});
$("shareBtn").addEventListener("click", async () => {
  if (!current?.result) return;
  const text = WS.toTxt(current.result);
  try {
    const f = makeFile("txt");
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: current.name });
    else if (navigator.share) await navigator.share({ text, title: current.name });
    else download("txt");
  } catch (e) { if (e.name !== "AbortError") log("Condivisione: " + e.message); }
});

document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", x === b));
  ui.text.classList.toggle("hidden", b.dataset.tab !== "text");
  ui.segs.classList.toggle("hidden", b.dataset.tab !== "segs");
}));

/* ---------------------------------------------------------------- input */
ui.file.addEventListener("change", () => {
  const f = ui.file.files[0];
  if (f) handleFile(f, f.name);
  ui.file.value = "";
});

ui.rec.addEventListener("click", async () => {
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    const t0 = Date.now();
    const tick = setInterval(() => (ui.rec.innerHTML = `⏹ Stop <span class="timer">${fmtDur((Date.now() - t0) / 1000)}</span>`), 500);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      ui.rec.className = ""; ui.rec.textContent = "🎙️ Registra";
      const blob = new Blob(chunks, { type: recorder.mimeType });
      recorder = null;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      handleFile(blob, `registrazione-${stamp}`);
    };
    recorder.start(1000);
    ui.rec.className = "rec"; ui.rec.innerHTML = "⏹ Stop <span class=\"timer\">0:00</span>";
  } catch (e) {
    log("Microfono: " + e.message);
    alert("Microfono non disponibile. Serve HTTPS e il permesso del browser.");
  }
});

// drag & drop (utile sul PC)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f, f.name);
});

/* ---------------------------------------------------------------- opzioni */
ui.lang.value = store.get("lang", "it");
ui.kw.value = store.get("kw", "");
ui.lang.addEventListener("change", () => store.set("lang", ui.lang.value));
ui.kw.addEventListener("change", () => store.set("kw", ui.kw.value));

/* ---------------------------------------------------------------- file condivisi (Android) */
async function checkSharedFile() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("whistle-share-inbox");
    const res = await cache.match("shared-file");
    if (!res) return;
    await cache.delete("shared-file");
    const name = decodeURIComponent(res.headers.get("x-file-name") || "audio-condiviso");
    handleFile(await res.blob(), name);
  } catch (e) { log("File condiviso: " + e.message); }
}

/* ---------------------------------------------------------------- avvio */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => log("Service worker: " + e.message));
}
if (!window.isSecureContext) log("Attenzione: pagina non in HTTPS, microfono e uso offline non disponibili.");
startWorker();
checkSharedFile();
