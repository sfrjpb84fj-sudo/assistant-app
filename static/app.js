"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let currentList = "work";
let pending = [];          // attachments waiting to be sent: {name, type, data, preview}
let assistantName = "Assistant";
let userName = "";

// ---------------------------------------------------------- look: theme + orb state
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const dark = t === "hud" || matchMedia("(prefers-color-scheme: dark)").matches;
  $("#theme-color").setAttribute("content", t === "hud" ? "#060c18" : dark ? "#16171a" : "#f6f3ee");
}
function setOrb(state) {
  if (state) document.documentElement.dataset.state = state;
  else delete document.documentElement.dataset.state;
}
applyTheme(localStorage && (() => { try { return localStorage.getItem("theme"); } catch { return null; } })() || "hud");

// ---------------------------------------------------------- helpers
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Please sign in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Error ${res.status}`);
  return data;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small, safe formatter: **bold**, *italic*, and "- " bullet lines. Escapes first.
function formatReply(text) {
  const lines = escapeHtml(text).split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-•*]\s+(.*)$/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += line + "\n";
    }
  }
  if (inList) html += "</ul>";
  return html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/\n*<ul>/g, "<ul>")
    .replace(/<\/ul>\n?/g, "</ul>")
    .replace(/\n+$/, "");
}

function prettyDue(due) {
  if (!due) return "";
  const d = new Date(due.length === 10 ? due + "T12:00:00" : due.replace(" ", "T"));
  if (isNaN(d)) return { label: due, overdue: false };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  let label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (due.length > 10) label += " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return { label, overdue: diff < 0 };
}

const money = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

// ---------------------------------------------------------- sign in
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  setTimeout(() => $("#passcode").focus(), 50);
}

async function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  try {
    const me = await api("/api/me");
    assistantName = me.assistant || "Assistant";
    userName = me.name && me.name !== "the user" && me.name !== "there" ? me.name : "";
    voiceInfo = me.voice || null;
    kairosVoice = !!(voiceInfo && voiceInfo.available);
    document.title = assistantName;
  } catch { /* handled by api() */ }
  switchView("home");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { passcode: $("#passcode").value } });
    $("#passcode").value = "";
    await showApp();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

// ---------------------------------------------------------- navigation
const titles = { home: "", chat: "Chat", tasks: "To-dos", memory: "Brain", more: "More" };
function switchView(name) {
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  for (const v of Object.keys(titles)) $(`#view-${v}`).hidden = v !== name;
  $("#view-title").textContent = name === "home" ? assistantName : titles[name];
  $("#app").classList.toggle("on-home", name === "home");
  if (name === "home") loadHome(); else cancelAnimationFrame(core.raf);
  if (name === "tasks") loadTasks();
  if (name === "memory") loadBrain();
  if (name === "more") loadMore();
  if (name === "chat") { loadMessages(); }
}
$$(".tabbar button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

$("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; });
document.addEventListener("click", () => ($("#menu").hidden = true));
$("#menu").addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (action === "logout") {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    showLogin();
  }
  if (action === "clear-chat" && confirm("Clear the chat history? Your to-dos, memories and reminders stay.")) {
    await api("/api/messages/clear", { method: "POST" });
    await loadMessages();
  }
});

// Reload chat when coming back to the app (a reminder or brief may have arrived).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || $("#app").hidden) return;
  if (!$("#view-chat").hidden && !$("#send").disabled) loadMessages();
  if (!$("#view-home").hidden) loadHome();
});

// ---------------------------------------------------------- chat
function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "assistant") el.innerHTML = formatReply(text);
  else el.textContent = text.replace(/\[photo: (.+?)\]/g, "🖼 $1").replace(/\[PDF: (.+?)\]/g, "📄 $1");
  $("#messages").appendChild(el);
  scrollChat();
  return el;
}
function scrollChat() { const m = $("#messages"); m.scrollTop = m.scrollHeight; }

function orbEl(size) {
  const o = document.createElement("span");
  o.className = `orb orb-${size}`;
  o.setAttribute("aria-hidden", "true");
  o.innerHTML = '<i class="ring r1"></i><i class="ring r3"></i><i class="ring r2"></i><i class="core"></i>';
  return o;
}

function readout(value, label, onClick, warn = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ro" + (warn ? " warn" : "");
  const v = document.createElement("b"); v.textContent = value;
  const l = document.createElement("span"); l.textContent = label;
  b.append(v, l);
  b.addEventListener("click", onClick);
  return b;
}

async function buildHero() {
  const now = new Date();
  const hour = now.getHours();
  const part = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const hero = document.createElement("section");
  hero.className = "hero";
  const greet = document.createElement("p"); greet.className = "greet";
  greet.textContent = `Good ${part}${userName ? ", " + userName : ""}.`;
  const date = document.createElement("p"); date.className = "date";
  date.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const row = document.createElement("div"); row.className = "readouts";
  hero.append(orbEl("lg"), greet, date, row);

  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [tasks, rems, spend] = await Promise.all([
    api("/api/tasks?include_done=false").catch(() => []),
    api("/api/reminders").catch(() => []),
    api(`/api/expenses?start=${start}`).catch(() => ({ total: 0 })),
  ]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = tasks.filter((t) => { const d = prettyDue(t.due); return d && d.overdue; }).length;
  row.append(
    overdue
      ? readout(String(overdue), overdue === 1 ? "overdue to-do" : "overdue to-dos", () => switchView("tasks"), true)
      : readout(String(tasks.length), tasks.length === 1 ? "open to-do" : "open to-dos", () => switchView("tasks")),
    readout(rems.length ? prettyDue(rems[0].fire_at).label.replace(/^(Today|Tomorrow) /, "") : "None",
            rems.length ? (prettyDue(rems[0].fire_at).label.startsWith("Tomorrow") ? "reminder tomorrow" : "next reminder") : "reminders set",
            () => switchView("more")),
    readout("$" + Math.round(spend.total).toLocaleString(), `spent in ${now.toLocaleDateString(undefined, { month: "short" })}`, () => switchView("more")),
  );
  return hero;
}

async function loadMessages() {
  const msgs = await api("/api/messages");
  const box = $("#messages");
  box.innerHTML = "";
  if (!msgs.length) {
    const tip = document.createElement("div");
    tip.className = "empty";
    tip.textContent = 'Try "Remind me at 3pm to call the bank", "Add the monthly report to my work list for Friday", or tap ＋ to send a photo of a receipt.';
    box.appendChild(tip);
  }
  msgs.forEach((m) => addBubble(m.role, m.content));
}

const input = $("#input");
function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

async function sendMessage(text, { spoken = false } = {}) {
  const atts = pending.map(({ name, type, data }) => ({ name, type, data }));
  if (!text && !atts.length) return;
  if ($(".empty")) $(".empty").remove();
  const label = pending.map((p) => (p.type === "application/pdf" ? "📄 " : "🖼 ") + p.name).join("  ");
  addBubble("user", [label, text].filter(Boolean).join("\n"));
  clearAttachments();
  $("#send").disabled = true;
  const typing = addBubble("assistant", "");
  typing.classList.add("typing");
  typing.innerHTML = "<span></span><span></span><span></span>";
  setOrb("thinking");
  try {
    const { reply } = await api("/api/chat", { method: "POST", body: { message: text, attachments: atts } });
    typing.remove();
    addBubble("assistant", reply);
    if (spoken || store.get("speak") === "1") speak(reply);
  } catch (err) {
    typing.remove();
    addBubble("error", err.message + " (Tap to put your message back.)").addEventListener(
      "click", (ev) => { input.value = text; autoGrow(); ev.currentTarget.remove(); input.focus(); }, { once: true });
  } finally {
    $("#send").disabled = false;
    setOrb("");
  }
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  input.value = ""; autoGrow();
  sendMessage(text);
});

// ---------------------------------------------------------- attachments (photos & PDFs)
$("#attach-btn").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", async (e) => {
  for (const file of [...e.target.files].slice(0, 4 - pending.length)) {
    try { pending.push(await prepareFile(file)); }
    catch (err) { toast(err.message); }
  }
  e.target.value = "";
  renderTray();
});

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read that file"));
    r.readAsDataURL(blob);
  });
}

async function prepareFile(file) {
  if (file.type === "application/pdf") {
    if (file.size > 9 * 1024 * 1024) throw new Error("That PDF is over 9 MB.");
    const url = await readAsDataURL(file);
    return { name: file.name, type: "application/pdf", data: url.split(",")[1], preview: null };
  }
  if (!file.type.startsWith("image/")) throw new Error("Only photos and PDFs for now.");
  // Shrink photos so they upload fast and stay readable.
  const src = URL.createObjectURL(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("Couldn't open that photo")); i.src = src;
  });
  const max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(src);
  const url = c.toDataURL("image/jpeg", 0.85);
  const name = (file.name || "photo").replace(/\.\w+$/, "") + ".jpg";
  return { name, type: "image/jpeg", data: url.split(",")[1], preview: url };
}

function renderTray() {
  const tray = $("#attach-tray");
  tray.innerHTML = "";
  tray.hidden = !pending.length;
  pending.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    if (p.preview) { const im = document.createElement("img"); im.src = p.preview; im.alt = ""; chip.appendChild(im); }
    else { const d = document.createElement("div"); d.className = "pdf"; d.textContent = "PDF"; chip.appendChild(d); }
    const n = document.createElement("span"); n.className = "name"; n.textContent = p.name; chip.appendChild(n);
    const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×";
    x.setAttribute("aria-label", "Remove");
    x.addEventListener("click", () => { pending.splice(i, 1); renderTray(); });
    chip.appendChild(x);
    tray.appendChild(chip);
  });
}
function clearAttachments() { pending = []; renderTray(); }

// ---------------------------------------------------------- voice
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;

$("#mic-btn").addEventListener("click", () => {
  if (!Recognition) {
    toast("Tap the 🎤 on your keyboard to dictate, or use the Hey Siri shortcut.");
    input.focus();
    return;
  }
  if (recog) { recog.stop(); return; }
  stopSpeaking();
  recog = new Recognition();
  recog.lang = "en-US";
  recog.interimResults = true;
  recog.continuous = false;
  let finalText = "";
  $("#mic-btn").classList.add("listening");
  setOrb("listening");
  recog.onresult = (e) => {
    let interim = "";
    for (const r of e.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
    input.value = finalText || interim; autoGrow();
  };
  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      toast("Microphone access is off. Use the 🎤 on your keyboard instead.");
  };
  recog.onend = () => {
    $("#mic-btn").classList.remove("listening");
    setOrb("");
    recog = null;
    const text = input.value.trim();
    if (text) { input.value = ""; autoGrow(); sendMessage(text, { spoken: true }); }
  };
  try { recog.start(); } catch { recog = null; $("#mic-btn").classList.remove("listening"); toast("Couldn't start the mic."); }
});

// Speaking. Uses the Kairos voice (ElevenLabs, through our server) when it's set up,
// otherwise the phone's built-in voice. The sphere follows the real loudness of the audio.
let kairosVoice = false, voiceInfo = null;
const voiceAudio = new Audio();
voiceAudio.setAttribute("playsinline", "");
let voiceEnv = null, speakSeq = 0;
const SPOKEN_MAX = 900;          // longer replies: speak the start, the rest stays on screen

// iPhone only lets a page play sound after a tap, so play a tiny silent clip on the first taps.
let audioUnlocked = false;
function silentWav() {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 8000, true);
  d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, "data"); d.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
function unlockAudio() {
  if (audioUnlocked || !kairosVoice || !voiceAudio.paused) return;
  voiceAudio.src = silentWav();
  voiceAudio.play().then(() => { audioUnlocked = true; }).catch(() => {});
}
document.addEventListener("pointerdown", unlockAudio, true);

function chosenVoice() { return store.get("voice") || ""; }
function useKairosVoice() {
  const v = chosenVoice();
  return kairosVoice && (v === "" || v.startsWith("k:"));
}

// Split a reply into pieces: a short first one so the voice starts quickly, then ~250-character pieces.
function speechChunks(text) {
  let t = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
  if (t.length > SPOKEN_MAX) {
    const cut = t.slice(0, SPOKEN_MAX), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = (end > SPOKEN_MAX / 2 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…") + " The rest is on screen.";
  }
  const sentences = t.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g) || [t];
  const chunks = [];
  for (const raw of sentences) {
    const s = raw.trim(); if (!s) continue;
    const last = chunks[chunks.length - 1];
    const limit = chunks.length <= 1 ? 120 : 260;
    if (last && chunks.length > 1 && last.length + s.length + 1 <= limit) chunks[chunks.length - 1] = last + " " + s;
    else if (last && chunks.length === 1 && last.length < 40 && last.length + s.length < limit) chunks[0] = last + " " + s;
    else chunks.push(s);
  }
  return chunks;
}

// Loudness envelope (60 steps a second) so the sphere can pulse with the voice.
async function envelopeOf(buf) {
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return null;
    const audio = await new Ctx(1, 44100, 44100).decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0), step = Math.floor(audio.sampleRate / 60), env = [];
    for (let i = 0; i < data.length; i += step) {
      let sum = 0;
      for (let j = i; j < Math.min(i + step, data.length); j++) sum += data[j] * data[j];
      env.push(Math.sqrt(sum / step));
    }
    let peak = 0.0001; for (const x of env) if (x > peak) peak = x;
    return env.map((x) => Math.min(1, x / peak));
  } catch { return null; }
}

function voiceLevel() {         // 0..1 right now, or null when not playing the Kairos voice
  if (!voiceEnv || voiceAudio.paused) return null;
  return voiceEnv[Math.floor(voiceAudio.currentTime * 60)] || 0;
}

function stopSpeaking() {
  speakSeq++;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  if (!voiceAudio.paused) voiceAudio.pause();
  voiceEnv = null;
  if (document.documentElement.dataset.state === "speaking") setOrb("");
}

async function fetchSpeech(text) {
  const v = chosenVoice();
  const res = await fetch("/api/tts", { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: v.startsWith("k:") ? v.slice(2) : "" }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "voice unavailable");
  const type = res.headers.get("content-type") || "audio/wav";
  const buf = await res.arrayBuffer();
  return { url: URL.createObjectURL(new Blob([buf], { type })), env: await envelopeOf(buf) };
}

function playClip(clip, seq) {
  return new Promise((resolve, reject) => {
    if (seq !== speakSeq) return resolve();
    voiceEnv = clip.env;
    voiceAudio.onended = () => { URL.revokeObjectURL(clip.url); resolve(); };
    voiceAudio.onerror = () => reject(new Error("couldn't play"));
    voiceAudio.onpause = () => { if (seq !== speakSeq) resolve(); };
    voiceAudio.src = clip.url;
    voiceAudio.play().then(() => setOrb("speaking")).catch(reject);
  });
}

async function speak(text) {
  stopSpeaking();
  if (useKairosVoice()) {
    const seq = speakSeq, chunks = speechChunks(text);
    if (!document.documentElement.dataset.state) { setOrb("thinking"); coreLabels("thinking"); }
    let started = false;
    try {
      let next = fetchSpeech(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const clip = await next;
        if (seq !== speakSeq) return;
        next = i + 1 < chunks.length ? fetchSpeech(chunks[i + 1]) : null;   // make the next piece while this one plays
        if (next) next.catch(() => {});
        started = true;
        await playClip(clip, seq);
        if (seq !== speakSeq) return;
      }
      voiceEnv = null;
      if (document.documentElement.dataset.state === "speaking") setOrb("");
      return;
    } catch (err) {
      if (seq !== speakSeq) return;
      voiceEnv = null;
      if (["thinking", "speaking"].includes(document.documentElement.dataset.state)) { setOrb(""); coreLabels(""); }
      if (/allowance|out of characters/i.test(err.message)) toast(err.message);
      if (started) return;              // it got partway; don't start over in another voice
    }
  }
  phoneSpeak(text);
}

function phoneSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const clean = text.replace(/\*\*?/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/[#`_]/g, "");
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "en-US";
  const voices = speechSynthesis.getVoices();
  const chosen = store.get("voice");
  const v = (chosen && voices.find((x) => x.name === chosen))
    || voices.find((x) => /en[-_]GB/i.test(x.lang) && /Daniel|Arthur/i.test(x.name))
    || voices.find((x) => /en[-_]US/i.test(x.lang) && /Enhanced|Premium/i.test(x.name))
    || voices.find((x) => /^en/i.test(x.lang));
  if (v) { u.voice = v; u.lang = v.lang; }
  // Make every orb on screen pulse while speaking, with a little kick on each word.
  u.onstart = () => setOrb("speaking");
  u.onend = u.onerror = () => { if (document.documentElement.dataset.state === "speaking") setOrb(""); };
  u.onboundary = () => {
    $$(".orb").forEach((o) => { o.classList.remove("beat"); void o.offsetWidth; o.classList.add("beat"); });
    if (window.corePulse) window.corePulse(0.9);
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------- to-dos
$$(".segmented button").forEach((b) =>
  b.addEventListener("click", () => {
    currentList = b.dataset.list;
    $$(".segmented button").forEach((x) => x.classList.toggle("active", x === b));
    loadTasks();
  })
);

function taskItem(t) {
  const li = document.createElement("li");
  li.className = "item" + (t.done ? " done" : "");
  const check = document.createElement("button");
  check.className = "check" + (t.done ? " on" : "");
  check.setAttribute("aria-label", t.done ? "Mark not done" : "Mark done");
  check.textContent = t.done ? "✓" : "";
  check.addEventListener("click", async () => {
    await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { done: !t.done } });
    loadTasks();
  });
  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title;
  body.appendChild(title);
  const due = prettyDue(t.due);
  if (due || t.notes) {
    const meta = document.createElement("div");
    meta.className = "meta" + (due && due.overdue && !t.done ? " overdue" : "");
    meta.textContent = [due && due.label, t.notes].filter(Boolean).join(" · ");
    body.appendChild(meta);
  }
  const del = document.createElement("button");
  del.className = "del";
  del.setAttribute("aria-label", "Delete");
  del.textContent = "×";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    await api(`/api/tasks/${t.id}`, { method: "DELETE" });
    loadTasks();
  });
  li.append(check, body, del);
  return li;
}

async function loadTasks() {
  const tasks = await api(`/api/tasks?list=${currentList}&include_done=true`);
  const open = tasks.filter((t) => !t.done), done = tasks.filter((t) => t.done);
  const ul = $("#task-list"); ul.innerHTML = "";
  if (!open.length) ul.innerHTML = '<li class="list-empty">Nothing here. Nice.</li>';
  open.forEach((t) => ul.appendChild(taskItem(t)));
  const dl = $("#done-list"); dl.innerHTML = "";
  done.slice(-30).reverse().forEach((t) => dl.appendChild(taskItem(t)));
  $("#done-count").textContent = done.length ? `(${done.length})` : "";
  $("#done-wrap").hidden = !done.length;
}

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/tasks", { method: "POST", body: { list: currentList, title: $("#task-title").value, due: $("#task-due").value } });
    $("#task-title").value = ""; $("#task-due").value = "";
    loadTasks();
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------- Brain: about you, on its own, memories
const PROFILE_HINTS = {
  about: "Your name, where you live, languages, what matters to you…",
  work: "Your role and company, what a normal week looks like, tools you use, recurring work…",
  goals: "What you're working toward this year (career, money, health, skills) and why…",
  preferences: "How you like things done, e.g. bullet points not paragraphs; no meetings before 9; remind me the night before…",
  people: "Who matters and how you refer to them: your manager, family, close friends…",
};
let brainPane = "about", allMemories = [];

$$("#brain-tabs button").forEach((b) => b.addEventListener("click", () => {
  brainPane = b.dataset.brain;
  $$("#brain-tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".brain-pane").forEach((p) => (p.hidden = p.id !== "brain-" + brainPane));
  loadBrain();
}));

async function loadBrain() {
  if (brainPane === "about") return loadProfile();
  if (brainPane === "missions") return loadMissions();
  return loadMemories();
}

const PERSONALITY_DESC = {
  kairos: "Your sparring partner: sharp, dry wit and fighting spirit. Makes you defend your thinking and ends with a question that sticks.",
  jarvis: "Polished and unflappable, with dry, understated wit. Anticipates what you need.",
  friend: "Warm and encouraging. Celebrates your wins and checks in on how things went.",
  coach: "Direct and candid. No fluff, pushes back on weak plans, holds you to your goals.",
  playful: "Upbeat and cheeky. Jokes, callbacks to past chats, light teasing.",
  plain: "Claude's natural voice, no extra character.",
};
async function loadPersonality() {
  const b = await api("/api/brain");
  const sel = $("#personality-select");
  if (!sel.options.length) for (const [k, name] of Object.entries(b.personalities)) {
    const o = document.createElement("option"); o.value = k; o.textContent = name; sel.appendChild(o);
  }
  sel.value = b.personality;
  $("#personality-desc").textContent = PERSONALITY_DESC[b.personality] || "";
  $("#personality-notes").value = b.personality_notes || "";
  $("#assistant-name").value = b.name || "";
  $("#assistant-name").dataset.saved = b.name || "";
  $("#personality-notes").dataset.saved = b.personality_notes || "";
}
$("#personality-select").addEventListener("change", async (e) => {
  await api("/api/brain", { method: "POST", body: { personality: e.target.value } });
  $("#personality-desc").textContent = PERSONALITY_DESC[e.target.value] || "";
  toast("Personality updated");
});
$("#assistant-name").addEventListener("blur", async (e) => {
  const v = e.target.value.trim();
  if (!v || v === e.target.dataset.saved) return;
  try {
    await api("/api/brain", { method: "POST", body: { name: v } });
    e.target.dataset.saved = v; assistantName = v; document.title = v; toast("Name saved");
  } catch (err) { toast(err.message); }
});
$("#personality-notes").addEventListener("blur", async (e) => {
  if (e.target.value === e.target.dataset.saved) return;
  await api("/api/brain", { method: "POST", body: { personality_notes: e.target.value } });
  e.target.dataset.saved = e.target.value; toast("Saved");
});

async function loadProfile() {
  loadPersonality();
  const { sections, profile } = await api("/api/profile");
  const box = $("#profile-fields"); box.innerHTML = "";
  for (const [key, label] of Object.entries(sections)) {
    const wrap = document.createElement("label"); wrap.className = "profile-field";
    const span = document.createElement("span"); span.textContent = label;
    const ta = document.createElement("textarea");
    ta.rows = 3; ta.maxLength = 3000; ta.placeholder = PROFILE_HINTS[key] || ""; ta.value = profile[key] || "";
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + "px"; };
    ta.addEventListener("input", grow);
    let saved = ta.value;
    ta.addEventListener("blur", async () => {
      if (ta.value === saved) return;
      try { await api("/api/profile", { method: "POST", body: { section: key, text: ta.value } }); saved = ta.value; toast("Saved"); }
      catch (err) { toast(err.message); }
    });
    wrap.append(span, ta); box.appendChild(wrap);
    requestAnimationFrame(grow);
  }
}

$("#interview-btn").addEventListener("click", () => {
  switchView("chat");
  sendMessage("Interview me so you really know me: who I am, my work, my goals, how I like things done, and the people in my life. Ask one short question at a time, and save what you learn to my profile and memory as we go.");
});

const SCHEDULES = [
  ["daily", "Every day"], ["weekdays", "Weekdays"],
  ["weekly:mon", "Mondays"], ["weekly:tue", "Tuesdays"], ["weekly:wed", "Wednesdays"], ["weekly:thu", "Thursdays"],
  ["weekly:fri", "Fridays"], ["weekly:sat", "Saturdays"], ["weekly:sun", "Sundays"],
  ["monthly:1", "1st of each month"], ["monthly:15", "15th of each month"],
  ["every:1", "Every hour (7am–9pm)"], ["every:2", "Every 2 hours (7am–9pm)"], ["every:3", "Every 3 hours (7am–9pm)"], ["every:4", "Every 4 hours (7am–9pm)"],
];
(function fillSchedules() {
  const sel = $("#mission-schedule");
  for (const [v, t] of SCHEDULES) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = "weekdays";
  sel.addEventListener("change", () => ($("#mission-time").hidden = sel.value.startsWith("every")));
})();
function fmtTime(hm) { const [h, m] = hm.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function scheduleText(sch, at) {
  const known = SCHEDULES.find(([v]) => v === sch);
  let label = known ? known[1] : sch.startsWith("monthly:") ? `Day ${sch.split(":")[1]} of each month` : sch;
  return sch.startsWith("every") ? label : `${label} at ${fmtTime(at)}`;
}

async function loadMissions() {
  const list = await api("/api/missions");
  const ul = $("#mission-list"); ul.innerHTML = "";
  if (!list.length) ul.innerHTML = '<li class="list-empty">No standing instructions yet.</li>';
  for (const m of list) {
    const li = document.createElement("li"); li.className = "item mission" + (m.enabled ? "" : " paused");
    const body = document.createElement("div"); body.className = "body";
    const title = document.createElement("div"); title.className = "title"; title.textContent = m.name;
    const meta = document.createElement("div"); meta.className = "meta";
    meta.textContent = (m.enabled ? "" : "Paused · ") + scheduleText(m.schedule, m.at);
    const det = document.createElement("details");
    const sum = document.createElement("summary"); sum.className = "small-text muted"; sum.textContent = "Details";
    const ins = document.createElement("p"); ins.className = "small-text"; ins.textContent = m.instruction;
    det.append(sum, ins);
    if (m.last_result) {
      const last = document.createElement("p"); last.className = "small-text muted";
      last.textContent = `Last run ${m.last_run}: ${m.last_result}`;
      det.appendChild(last);
    }
    const acts = document.createElement("div"); acts.className = "row-btns";
    const run = document.createElement("button"); run.className = "secondary small"; run.textContent = "Run now";
    run.addEventListener("click", async () => {
      run.disabled = true; run.textContent = "Running…";
      try {
        const { result } = await api(`/api/missions/${m.id}/run`, { method: "POST" });
        toast(result === "[quiet]" ? "Done. Nothing needed your attention." : "Done. See Chat for the result.");
        loadMissions();
      } catch (err) { toast(err.message); run.disabled = false; run.textContent = "Run now"; }
    });
    const tog = document.createElement("button"); tog.className = "secondary small"; tog.textContent = m.enabled ? "Pause" : "Resume";
    tog.addEventListener("click", async () => { await api(`/api/missions/${m.id}`, { method: "PATCH", body: { enabled: !m.enabled } }); loadMissions(); });
    const del = document.createElement("button"); del.className = "secondary small"; del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${m.name}"?`)) return;
      await api(`/api/missions/${m.id}`, { method: "DELETE" }); loadMissions();
    });
    acts.append(run, tog, del);
    body.append(title, meta, det, acts);
    li.appendChild(body); ul.appendChild(li);
  }
}

$("#mission-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/missions", { method: "POST", body: {
      name: $("#mission-name").value, instruction: $("#mission-text").value,
      schedule: $("#mission-schedule").value, time: $("#mission-time").value || "08:00" } });
    $("#mission-name").value = ""; $("#mission-text").value = ""; $("#mission-new").open = false;
    toast("Saved. It will run on schedule.");
    loadMissions();
  } catch (err) { toast(err.message); }
});

const CAT_LABELS = { preference: "Preference", goal: "Goal", work: "Work", person: "Person", project: "Project", routine: "Routine", fact: "Fact" };
(function fillCats() {
  const sel = $("#memory-cat");
  for (const [v, t] of Object.entries(CAT_LABELS)) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = "fact";
})();

async function loadMemories() {
  const [mems, brain] = await Promise.all([api("/api/memories"), api("/api/brain")]);
  allMemories = mems;
  $("#learn-toggle").checked = brain.learn_nightly;
  $("#web-toggle").checked = brain.web_search;
  $("#model-select").value = brain.model;
  $("#learn-last").textContent = brain.last_learn ? "Last learned " + brain.last_learn : "Every Sunday night it reviews the week's chats and saves what matters.";
  renderMemories();
}

function renderMemories() {
  const q = $("#memory-filter").value.trim().toLowerCase();
  const ul = $("#memory-list"); ul.innerHTML = "";
  const shown = allMemories.filter((m) => !q || (m.fact + " " + m.category).toLowerCase().includes(q))
    .sort((a, b) => b.id - a.id);
  if (!shown.length) ul.innerHTML = `<li class="list-empty">${q ? "No matches." : "Nothing saved yet. Tell your assistant about yourself, or add something above."}</li>`;
  for (const m of shown) {
    const li = document.createElement("li"); li.className = "item";
    const body = document.createElement("div"); body.className = "body";
    const title = document.createElement("div"); title.className = "title"; title.textContent = m.fact;
    const meta = document.createElement("div"); meta.className = "meta";
    const chip = document.createElement("span"); chip.className = "chip-cat"; chip.textContent = CAT_LABELS[m.category] || m.category;
    const src = { you: "added by you", chat: "noted in chat", learned: "learned" }[m.source] || m.source;
    meta.append(chip, ` ${src} · ${m.created_at.slice(0, 10)}`);
    body.append(title, meta);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×"; del.setAttribute("aria-label", "Forget");
    del.addEventListener("click", async () => {
      if (!confirm("Forget this?")) return;
      await api(`/api/memories/${m.id}`, { method: "DELETE" });
      loadMemories();
    });
    li.append(body, del); ul.appendChild(li);
  }
}
$("#memory-filter").addEventListener("input", renderMemories);

$("#memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/memories", { method: "POST", body: { fact: $("#memory-fact").value, category: $("#memory-cat").value } });
    $("#memory-fact").value = "";
    loadMemories();
  } catch (err) { toast(err.message); }
});
$("#learn-toggle").addEventListener("change", (e) => api("/api/brain", { method: "POST", body: { learn_nightly: e.target.checked } }).then(() => toast("Saved")));
$("#model-select").addEventListener("change", (e) => api("/api/brain", { method: "POST", body: { model: e.target.value } }).then(() => toast("Saved")));
$("#web-toggle").addEventListener("change", (e) => api("/api/brain", { method: "POST", body: { web_search: e.target.checked } }).then(() => toast("Saved")));
$("#learn-now").addEventListener("click", async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = "Learning…";
  try { const { summary } = await api("/api/brain/learn-now", { method: "POST" }); toast(summary); loadMemories(); }
  catch (err) { toast(err.message); }
  finally { b.disabled = false; b.textContent = "Learn from recent chats now"; }
});

// ---------------------------------------------------------- More tab
function miniRow(main, sub, buttons = []) {
  const li = document.createElement("li");
  const left = document.createElement("div");
  const a = document.createElement("div"); a.textContent = main; left.appendChild(a);
  if (sub) { const b = document.createElement("div"); b.className = "sub"; b.textContent = sub; left.appendChild(b); }
  const act = document.createElement("div"); act.className = "actions";
  for (const [label, fn, cls] of buttons) {
    const btn = document.createElement("button");
    btn.className = cls || "secondary small"; btn.textContent = label; btn.addEventListener("click", fn);
    act.appendChild(btn);
  }
  li.append(left, act);
  return li;
}
function emptyRow(text) { const li = document.createElement("li"); li.className = "empty-row"; li.textContent = text; return li; }

let shortcutKey = "";
async function loadMore() {
  const s = await api("/api/settings");
  $("#brief-days").value = s.brief_days; $("#brief-time").value = s.brief_time;
  $("#review-day").value = s.review_day; $("#review-time").value = s.review_time;
  $("#speak-toggle").checked = store.get("speak") === "1";
  $("#theme-select").value = document.documentElement.dataset.theme;
  $("#city-input").value = s.weather_city || "";
  loadGoogle();
  loadICloud();
  fillVoices();
  const vu = $("#voice-usage");
  if (s.voice && s.voice.engine === "elevenlabs") {
    vu.hidden = false;
    vu.textContent = `Kairos voice this month: ${s.voice.used.toLocaleString()} of ${s.voice.limit.toLocaleString()} characters.`;
  } else vu.hidden = true;
  shortcutKey = s.shortcut_token;
  $("#shortcut-key").textContent = "••••••••••••";
  $("#key-show").textContent = "Show";
  $("#shortcut-url").textContent = location.origin + "/api/shortcut";
  updatePushStatus(s.push_devices);

  const rems = await api("/api/reminders");
  const rl = $("#reminder-list"); rl.innerHTML = "";
  if (!rems.length) rl.appendChild(emptyRow('None. Try "remind me tomorrow at 9 to…" in chat.'));
  for (const r of rems) {
    const when = prettyDue(r.fire_at);
    rl.appendChild(miniRow(r.text, when.label, [["Cancel", async () => {
      await api(`/api/reminders/${r.id}`, { method: "DELETE" }); loadMore();
    }]]));
  }

  const routines = await api("/api/routines");
  const ro = $("#routine-list"); ro.innerHTML = "";
  if (!routines.length) ro.appendChild(emptyRow("No routines yet."));
  for (const r of routines) {
    const sched = r.schedule === "none" ? "Run by hand"
      : r.schedule.startsWith("monthly") ? `Monthly on day ${r.schedule.split(":")[1]}`
      : `Every ${r.schedule.split(":")[1]}`;
    ro.appendChild(miniRow(r.name, `${r.items.length} items · ${r.list} · ${sched}`, [
      ["Run now", async () => { const x = await api(`/api/routines/${r.id}/run`, { method: "POST" }); toast(`Added ${x.added} to-dos`); }],
      ["×", async () => { if (confirm(`Delete routine "${r.name}"?`)) { await api(`/api/routines/${r.id}`, { method: "DELETE" }); loadMore(); } }, "del"],
    ]));
  }

  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const ex = await api(`/api/expenses?start=${start}`);
  $("#spend-total").textContent = money(ex.total);
  const cats = $("#spend-cats"); cats.innerHTML = "";
  const sorted = Object.entries(ex.by_category).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) cats.appendChild(emptyRow("Nothing logged. Send a receipt photo in chat."));
  sorted.forEach(([c, v]) => cats.appendChild(miniRow(c, "", [[money(v), () => {}, "amount"]])));
  const items = $("#spend-items"); items.innerHTML = "";
  for (const it of ex.items) {
    items.appendChild(miniRow(`${it.merchant} — ${money(it.amount)}`, `${it.date} · ${it.category}`, [["×", async () => {
      if (confirm(`Delete ${it.merchant} ${money(it.amount)}?`)) { await api(`/api/expenses/${it.id}`, { method: "DELETE" }); loadMore(); }
    }, "del"]]));
  }
}

async function saveSettings() {
  try {
    await api("/api/settings", { method: "POST", body: {
      brief_days: $("#brief-days").value, brief_time: $("#brief-time").value,
      review_day: $("#review-day").value, review_time: $("#review-time").value,
    } });
    toast("Saved");
  } catch (err) { toast(err.message); }
}
["#brief-days", "#brief-time", "#review-day", "#review-time"].forEach((id) => $(id).addEventListener("change", saveSettings));
$("#speak-toggle").addEventListener("change", (e) => store.set("speak", e.target.checked ? "1" : "0"));
$("#theme-select").addEventListener("change", (e) => { store.set("theme", e.target.value); applyTheme(e.target.value); });

function fillVoices() {
  if (!("speechSynthesis" in window) && !kairosVoice) { $("#voice-select").disabled = true; return; }
  const sel = $("#voice-select");
  const voices = (("speechSynthesis" in window) ? speechSynthesis.getVoices() : []).filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  sel.innerHTML = "";
  const add = (value, label, group) => { const o = document.createElement("option"); o.value = value; o.textContent = label; (group || sel).appendChild(o); };
  if (kairosVoice && voiceInfo.engine === "kokoro") {
    const g = document.createElement("optgroup"); g.label = "Kairos voices (free, private)"; sel.appendChild(g);
    for (const v of voiceInfo.voices) add(v.id === voiceInfo.default ? "" : "k:" + v.id,
      `${v.name} (${v.id.startsWith("bm") ? "British man" : "British woman"})`, g);
  } else if (kairosVoice) add("", "Kairos voice (ElevenLabs)");
  const pg = document.createElement("optgroup"); pg.label = "Phone voices"; sel.appendChild(pg);
  add(kairosVoice ? "phone" : "", "Phone voice: automatic", pg);
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang.replace("_", "-")})`;
    pg.appendChild(o);
  }
  sel.value = store.get("voice") || "";
}
if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { if (!$("#view-more").hidden) fillVoices(); });
const voiceSample = () => speak(`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}${userName ? ", " + userName : ""}. All systems are running, which is more than I can say for your to-do list.`);
$("#voice-select").addEventListener("change", (e) => { store.set("voice", e.target.value); voiceSample(); });
$("#voice-test").addEventListener("click", voiceSample);

$("#key-show").addEventListener("click", () => {
  const hidden = $("#key-show").textContent === "Show";
  $("#shortcut-key").textContent = hidden ? shortcutKey : "••••••••••••";
  $("#key-show").textContent = hidden ? "Hide" : "Show";
});
$("#key-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(shortcutKey); toast("Copied"); } catch { toast("Couldn't copy. Tap Show and copy it by hand."); }
});
$("#key-new").addEventListener("click", async () => {
  if (!confirm("Make a new key? You'll need to paste it into your Siri shortcut again.")) return;
  await api("/api/settings/new-shortcut-token", { method: "POST" });
  loadMore();
  toast("New key made");
});

// ---------------------------------------------------------- push notifications
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function updatePushStatus(devices) {
  const st = $("#push-status"), on = $("#push-on"), test = $("#push-test");
  if (!pushSupported) {
    st.textContent = isStandalone
      ? "This phone doesn't support notifications here. Make sure iOS is up to date."
      : "Open the app from its Home Screen icon to turn on notifications (Share → Add to Home Screen).";
    on.hidden = true; test.hidden = true; return;
  }
  const perm = Notification.permission;
  if (perm === "granted" && devices > 0) { st.textContent = "On. Reminders and check-ins will pop up on this phone."; on.textContent = "Re-connect this phone"; test.hidden = false; }
  else if (perm === "denied") { st.textContent = "Blocked. Turn them on in iPhone Settings → Notifications → this app."; on.hidden = true; test.hidden = true; return; }
  else { st.textContent = "Off. Turn on to get reminders, your morning brief and weekly review."; on.textContent = "Turn on notifications"; test.hidden = true; }
  on.hidden = false;
}

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$("#push-on").addEventListener("click", async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications weren't allowed."); return loadMore(); }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api("/api/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
    await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
    toast("Notifications are on");
    loadMore();
  } catch (err) { toast("Couldn't turn on notifications: " + err.message); }
});
$("#push-test").addEventListener("click", async () => {
  try { await api("/api/push/test", { method: "POST" }); toast("Sent. It should pop up in a few seconds."); }
  catch (err) { toast(err.message); }
});

// ---------------------------------------------------------- Home: the core (particle sphere + voice)
const pad = (n) => String(n).padStart(2, "0");
function parseLocal(s) { return new Date(s.replace(" ", "T")); }
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- the sphere: ~260 points in a slowly turning ball; heartbeat when idle, reacts to voice
const core = { energy: 0, raf: 0, pts: [], w: 0, h: 0, dpr: 1, t0: performance.now() };
window.corePulse = (x = 1) => { core.energy = Math.min(3, core.energy + x); };

(function buildPoints() {
  const n = 260, golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
    const depth = 0.55 + Math.random() * 0.45;               // some points sit inside the ball
    const roll = Math.random();
    core.pts.push({ x: Math.cos(th) * r * depth, y: y * depth, z: Math.sin(th) * r * depth,
      c: roll < 0.08 ? "amber" : roll < 0.14 ? "white" : "cyan", s: 0.6 + Math.random() * 0.9, ph: Math.random() * 6.28 });
  }
})();

function heartbeat(t, period) {             // "lub-dub": two quick bumps, then rest
  const p = t % period;
  const a = p / 0.055, b = (p - 0.2) / 0.06;
  return Math.exp(-(a * a)) + 0.65 * Math.exp(-(b * b));
}

function sizeCanvas() {
  const c = $("#sphere-canvas"), r = c.getBoundingClientRect();
  core.dpr = Math.min(window.devicePixelRatio || 1, 2);
  core.w = r.width; core.h = r.height;
  c.width = Math.round(r.width * core.dpr); c.height = Math.round(r.height * core.dpr);
}

function drawCore(now) {
  const c = $("#sphere-canvas"), ctx = c.getContext("2d");
  if (!core.w) sizeCanvas();
  const { w, h, dpr } = core, t = (now - core.t0) / 1000;
  const state = document.documentElement.dataset.state || "";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.33;

  // how the core moves in each state
  const beat = state === "listening" ? heartbeat(t, 0.62) : state === "thinking" ? 0.4 + 0.3 * Math.sin(t * 9) : heartbeat(t, 1.05);
  core.energy *= 0.92;
  const lvl = state === "speaking" ? voiceLevel() : null;
  const e = core.energy + (state === "speaking" ? (lvl !== null ? 1.1 * lvl : 0.35 + 0.25 * Math.sin(t * 7)) : 0);
  const spin = reduceMotion ? 0 : t * (state === "thinking" ? 1.6 : state === "listening" ? 0.45 : 0.18);
  const scale = 1 + (reduceMotion ? 0.02 : 0.05) * beat + 0.06 * e;
  const swirl = state === "thinking" ? 0.85 + 0.08 * Math.sin(t * 5) : 1;

  // glow behind the ball
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
  g.addColorStop(0, `rgba(95,227,255,${0.20 + 0.18 * beat + 0.15 * e})`);
  g.addColorStop(0.45, "rgba(30,120,160,0.10)");
  g.addColorStop(1, "rgba(6,12,24,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, 6.283); ctx.fill();

  // outer rings
  ctx.lineWidth = 1;
  for (const [k, a] of [[1.28, 0.16], [1.45, 0.09]]) {
    ctx.strokeStyle = `rgba(95,227,255,${a + 0.12 * beat})`;
    ctx.beginPath(); ctx.arc(cx, cy, R * k * (1 + 0.02 * beat), 0, 6.283); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(95,227,255,${0.55 + 0.3 * e})`; ctx.lineWidth = 2;
  ctx.beginPath(); const a0 = -spin * 1.5; ctx.arc(cx, cy, R * 1.28, a0, a0 + 0.9); ctx.stroke();
  ctx.lineWidth = 1;

  // points
  const cosY = Math.cos(spin), sinY = Math.sin(spin), tilt = 0.35, cosX = Math.cos(tilt), sinX = Math.sin(tilt);
  const listenJitter = state === "listening" ? 0.04 + 0.05 * e : 0;
  for (const p of core.pts) {
    let x = p.x * cosY - p.z * sinY, z = p.x * sinY + p.z * cosY, y = p.y;
    const y2 = y * cosX - z * sinX; z = y * sinX + z * cosX; y = y2;
    const wob = 1 + listenJitter * Math.sin(t * 9 + p.ph);
    const k = R * scale * swirl * wob;
    const px = cx + x * k, py = cy + y * k, depth = (z + 1) / 2;   // 0 = back, 1 = front
    const alpha = 0.18 + 0.75 * depth;
    const size = (0.7 + 1.5 * depth) * p.s * (1 + 0.4 * e);
    ctx.fillStyle = p.c === "amber" ? `rgba(255,181,71,${alpha})` : p.c === "white" ? `rgba(235,250,255,${alpha})` : `rgba(95,227,255,${alpha})`;
    ctx.beginPath(); ctx.arc(px, py, size, 0, 6.283); ctx.fill();
  }

  // the core: small ring and bright centre
  const cr = R * 0.07 * (1 + 0.35 * beat + 0.4 * e);
  ctx.strokeStyle = "rgba(95,227,255,0.9)"; ctx.beginPath(); ctx.arc(cx, cy, cr * 1.8, 0, 6.283); ctx.stroke();
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 1.4);
  cg.addColorStop(0, "rgba(255,255,255,1)"); cg.addColorStop(0.5, "rgba(95,227,255,0.95)"); cg.addColorStop(1, "rgba(95,227,255,0)");
  ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, cr * 1.4, 0, 6.283); ctx.fill();

  core.raf = requestAnimationFrame(drawCore);
}

function startCore() {
  cancelAnimationFrame(core.raf);
  if ($("#view-home").hidden || document.hidden) return;
  sizeCanvas();
  core.raf = requestAnimationFrame(drawCore);
}
window.addEventListener("resize", () => { if (!$("#view-home").hidden) sizeCanvas(); });
document.addEventListener("visibilitychange", () => (document.hidden ? cancelAnimationFrame(core.raf) : startCore()));

// ---- labels that follow the state
function coreState(state) {
  if ((document.documentElement.dataset.state || "") !== (state || "")) setOrb(state);
  coreLabels(state);
}
function coreLabels(state) {
  const sub = { listening: "LISTENING…", thinking: "THINKING…", speaking: "SPEAKING · TAP TO STOP" }[state] || "VOICE-DRIVEN · TAP TO TALK";
  $("#core-sub").textContent = sub;
  const rec = $("#rec-status");
  rec.classList.toggle("live", state === "listening");
  rec.querySelector("span").textContent = state === "listening" ? "REC" : "STANDBY";
}
// keep labels right when speech ends on its own
new MutationObserver(() => {
  const st = document.documentElement.dataset.state || "";
  if (!$("#view-home").hidden && !["listening", "thinking"].includes(st)) coreLabels(st);
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-state"] });

function plain(text) {
  return text.replace(/\*\*?/g, "").replace(/^\s*[-•]\s+/gm, "· ").replace(/[#`_]/g, "").replace(/\n+/g, " ").trim();
}
function showCaption(you, ai, full = false) {
  $("#cap-you").textContent = you ? `“${you}”` : "";
  const p = plain(ai || "");
  const short = p.length > 240 ? p.slice(0, 237).replace(/\s+\S*$/, "") + "…" : p;
  $("#cap-ai").textContent = short;
  $("#cap-more").hidden = !full && short === p;
}
$("#cap-more").addEventListener("click", () => switchView("chat"));

// ---- talking from Home: tap the sphere
let homeRecog = null;
async function askFromHome(text) {
  showCaption(text, "");
  coreState("thinking");
  try {
    const { reply } = await api("/api/chat", { method: "POST", body: { message: text } });
    showCaption(text, reply);
    if (useKairosVoice()) setOrb("");       // speak() shows "thinking" until the voice arrives
    else coreState("");
    speak(reply);
  } catch (err) {
    coreState("");
    showCaption(text, err.message);
  }
}

$("#sphere").addEventListener("click", () => {
  const st = document.documentElement.dataset.state || "";
  if (st === "speaking") { stopSpeaking(); coreState(""); return; }
  if (st === "thinking") return;
  if (homeRecog) { homeRecog.stop(); return; }
  if (!Recognition) {
    toast("Voice input isn't available in this browser. Type instead, or use the Hey Siri shortcut.");
    switchView("chat"); setTimeout(() => input.focus(), 50);
    return;
  }
  stopSpeaking();
  // A silent clip "unlocks" sound on iPhone so the reply can be spoken later.
  if (!useKairosVoice()) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch { /* ignore */ } }
  const r = new Recognition();
  homeRecog = r;
  r.lang = "en-US"; r.interimResults = true; r.continuous = false;
  let finalText = "", interim = "";
  coreState("listening");
  showCaption("", "");
  r.onresult = (e) => {
    interim = "";
    for (const res of e.results) (res.isFinal ? (finalText = res[0].transcript) : (interim += res[0].transcript));
    $("#cap-you").textContent = finalText || interim;
    window.corePulse(0.6);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed")
      toast("Microphone access is off. Allow it in Settings, or type instead.");
  };
  r.onend = () => {
    homeRecog = null;
    const text = (finalText || interim).trim();
    if (text) askFromHome(text);
    else { coreState(""); greet(); }
  };
  try { r.start(); } catch { homeRecog = null; coreState(""); toast("Couldn't start the mic."); }
});
$("#home-type").addEventListener("click", () => { switchView("chat"); setTimeout(() => input.focus(), 50); });

// ---- gauges
function setGauge(id, value, label, pct, warn = false) {
  const g = $(id);
  g.querySelector(".g-val").textContent = value;
  g.querySelector(".g-label").textContent = label;
  g.querySelector(".g-arc").style.strokeDasharray = `${Math.max(0.5, Math.min(100, pct))} 100`;
  g.classList.toggle("warn", warn);
}

function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? "evening" : h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  showCaption("", `Good ${part}${userName ? ", " + userName : ""}. Tap the core to talk.`);
}

let lastAgenda = null, lastRem = null;
async function loadHome() {
  const now = new Date();
  $("#core-name").textContent = (assistantName || "Kairos").toUpperCase();
  $("#side-right").textContent = now.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase().replace(" ", " · ");
  $("#side-left").textContent = (userName || "YOU").toUpperCase().slice(0, 8) + " · " + pad(now.getHours() < 12 ? 1 : 2);
  if (!$("#cap-ai").textContent && !(document.documentElement.dataset.state)) greet();
  startCore();

  const t0 = performance.now();
  const ok = await api("/api/me").then(() => true).catch(() => false);
  const ms = Math.round(performance.now() - t0);
  $("#sys-status").classList.toggle("down", !ok);
  $("#sys-status span").textContent = ok ? "SYS.ONLINE" : "OFFLINE";
  $("#core-status").textContent = `LATENCY: ${ok ? ms + "MS" : "--"} · ENCRYPTED · STATUS: ${ok ? "NOMINAL" : "NO SIGNAL"}`;
  if (!ok) return;

  const [rems, tasks, wx, agenda] = await Promise.all([
    api("/api/reminders").catch(() => []),
    api("/api/tasks?include_done=true").catch(() => []),
    api("/api/weather").catch(() => ({ set: false })),
    api("/api/agenda").catch(() => ({ connected: false })),
  ]);
  lastAgenda = agenda; lastRem = rems[0] || null;

  // TO-DOS: open count; ring = share of today's list already done
  const localToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => { const d = prettyDue(t.due); return d && d.overdue; }).length;
  const dueNow = open.filter((t) => t.due && t.due.slice(0, 10) <= localToday).length;
  const doneToday = tasks.filter((t) => t.done && (t.done_at || "").startsWith(localToday)).length;
  const denom = doneToday + dueNow;
  setGauge("#g-todos", String(open.length), overdue ? `${overdue} OVERDUE` : "TO-DOS",
           denom ? (doneToday / denom) * 100 : 100, overdue > 0);

  // NEXT: next calendar event, else next reminder; ring fills as it gets closer (last 24h)
  const nx = agenda && agenda.next ? { when: parseLocal(agenda.next.start), title: agenda.next.title }
           : lastRem ? { when: parseLocal(lastRem.fire_at), title: lastRem.text } : null;
  if (nx) {
    const left = nx.when - now;
    const time = nx.when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, (m) => m.trim()[0].toLowerCase());
    const sameDay = nx.when.toDateString() === now.toDateString();
    setGauge("#g-next", sameDay ? time : nx.when.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase(),
             nx.title.toUpperCase().slice(0, 14), 100 - Math.max(0, Math.min(1, left / 864e5)) * 100, left < 36e5);
    $("#g-next").title = nx.title;
  } else setGauge("#g-next", "—", "ALL CLEAR", 100);

  // WEATHER: temp; ring = where now sits between today's low and high
  if (wx.set && wx.ok) {
    const span = Math.max(1, wx.high - wx.low);
    setGauge("#g-wx", `${wx.temp}°`, wx.place.toUpperCase().slice(0, 14), ((wx.temp - wx.low) / span) * 100);
    $("#g-wx").title = `${wx.condition}. High ${wx.high}°, low ${wx.low}°`;
  } else setGauge("#g-wx", "SET", wx.set ? "UNAVAILABLE" : "WEATHER", 0);
}

$("#g-todos").addEventListener("click", () => switchView("tasks"));
$("#g-next").addEventListener("click", () => {
  if (!$("#g-next").title) return;
  showCaption("", `Next up: ${$("#g-next").title}.`);
});
$("#g-wx").addEventListener("click", async () => {
  if ($("#g-wx").title) { showCaption("", $("#g-wx").title + "."); return; }
  const city = prompt("Which city should the weather show? For example: Irvine, CA");
  if (!city || !city.trim()) return;
  try { await api("/api/settings", { method: "POST", body: { weather_city: city.trim() } }); toast("Weather city saved"); loadHome(); }
  catch (err) { toast(err.message); }
});

$("#city-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", { method: "POST", body: { weather_city: $("#city-input").value.trim() } });
    toast($("#city-input").value.trim() ? "Weather city saved" : "Weather turned off");
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------- Google (Gmail + Calendar)
let googleState = { accounts: [], default: "" };
async function loadGoogle() {
  const g = await api("/api/google/status").catch(() => null);
  if (!g) return;
  googleState = g;
  $("#g-redirect").textContent = location.origin + "/api/google/callback";
  if (g.client_id) $("#g-client-id").value = g.client_id;
  $("#g-details").open = !g.configured;
  $("#g-connect").hidden = !g.configured;
  const n = g.accounts.length;
  $("#g-status").textContent = n
    ? `${n} account${n > 1 ? "s" : ""} connected. Jarvis can read, draft and (with your OK) send email, and use their calendars.`
    : g.configured ? "Ready. Tap Add Gmail account and allow access on Google's screen."
    : "Not set up yet. Open Setup details below.";
  $("#g-picker").hidden = !n;
  const sel = $("#g-select"), keep = sel.value;
  sel.innerHTML = "";
  for (const email of g.accounts) {
    const o = document.createElement("option");
    o.value = email;
    o.textContent = email + (email === g.default && n > 1 ? "  (default)" : "");
    sel.appendChild(o);
  }
  sel.value = g.accounts.includes(keep) ? keep : g.default || g.accounts[0] || "";
  updateGoogleButtons();
}
function updateGoogleButtons() {
  const v = $("#g-select").value;
  $("#g-make-default").hidden = googleState.accounts.length < 2 || v === googleState.default;
}
$("#g-select").addEventListener("change", updateGoogleButtons);
$("#g-make-default").addEventListener("click", async () => {
  const email = $("#g-select").value;
  await api("/api/google/default", { method: "POST", body: { email } });
  toast("New emails will come from " + email);
  loadGoogle();
});
$("#g-remove").addEventListener("click", async () => {
  const email = $("#g-select").value;
  if (!email || !confirm(`Disconnect ${email}? Jarvis will stop seeing its email and calendar.`)) return;
  await api("/api/google/disconnect", { method: "POST", body: { email } });
  toast("Disconnected " + email);
  loadGoogle(); loadICloud();
});
$("#g-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#g-redirect").textContent); toast("Copied"); }
  catch { toast("Couldn't copy. Select the address and copy it by hand."); }
});
$("#g-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/google/credentials", { method: "POST", body: {
      client_id: $("#g-client-id").value, client_secret: $("#g-client-secret").value, origin: location.origin } });
    $("#g-client-secret").value = "";
    toast("Saved. Now tap Add Gmail account.");
    loadGoogle();
  } catch (err) { toast(err.message); }
});
$("#g-connect").addEventListener("click", async () => {
  try { const { url } = await api("/api/google/start", { method: "POST" }); location.href = url; }
  catch (err) { toast(err.message); }
});

// ---------------------------------------------------------- Apple iCloud Calendar
async function loadICloud() {
  const [ic, g] = await Promise.all([
    api("/api/icloud/status").catch(() => ({ connected: false })),
    api("/api/google/status").catch(() => ({ accounts: [] })),
  ]);
  $("#ic-form").hidden = ic.connected;
  $("#ic-connected").hidden = !ic.connected;
  if (!ic.connected) {
    $("#ic-status").textContent = "Connect with your Apple ID and an app-specific password. The setup guide shows how to make one.";
    return;
  }
  $("#ic-status").textContent = ic.ok ? `Connected as ${ic.apple_id}.` : `Connected as ${ic.apple_id}, but iCloud didn't answer just now.`;
  $("#ic-cals").textContent = ic.calendars.length ? "iCloud calendars: " + ic.calendars.join(", ") : "";
  const sel = $("#ic-default"); sel.innerHTML = "";
  for (const name of ic.calendars) {
    const o = document.createElement("option"); o.value = "iCloud|" + name; o.textContent = `iCloud: ${name}`; sel.appendChild(o);
  }
  for (const email of g.accounts || []) {
    const o = document.createElement("option"); o.value = email; o.textContent = email; sel.appendChild(o);
  }
  sel.value = ic.current_target === "iCloud" || !ic.current_target ? "iCloud|" + ic.default_calendar : ic.current_target;
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
}
$("#ic-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("#ic-form button");
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    await api("/api/icloud/connect", { method: "POST", body: { apple_id: $("#ic-user").value, password: $("#ic-pass").value } });
    $("#ic-pass").value = "";
    toast("iCloud Calendar connected");
    loadICloud();
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = "Connect iCloud Calendar"; }
});
$("#ic-default").addEventListener("change", async (e) => {
  const v = e.target.value;
  const body = v.startsWith("iCloud|") ? { target: "iCloud", icloud_calendar: v.slice(7) } : { target: v };
  try { await api("/api/calendar/default", { method: "POST", body }); toast("New events will go to " + (body.icloud_calendar ? "iCloud: " + body.icloud_calendar : v)); }
  catch (err) { toast(err.message); }
});
$("#ic-disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect iCloud Calendar? Jarvis will stop seeing it.")) return;
  await api("/api/icloud/disconnect", { method: "POST" });
  toast("iCloud disconnected"); loadICloud();
});

// Tap the orb to stop Jarvis talking.
document.addEventListener("click", (e) => {
  if (e.target.closest(".orb") && document.documentElement.dataset.state === "speaking") stopSpeaking();
});

// ---------------------------------------------------------- start
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // warm up the voice list
api("/api/me").then(showApp).catch(() => showLogin());
