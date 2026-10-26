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
const titles = { home: "", chat: "Chat", tasks: "To-dos", memory: "Memory", more: "More" };
function switchView(name) {
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  for (const v of Object.keys(titles)) $(`#view-${v}`).hidden = v !== name;
  $("#view-title").textContent = name === "home" ? assistantName : titles[name];
  if (name === "home") loadHome();
  if (name === "tasks") loadTasks();
  if (name === "memory") loadMemories();
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
  speechSynthesis.cancel();
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

function speak(text) {
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

// ---------------------------------------------------------- memory
async function loadMemories() {
  const mems = await api("/api/memories");
  const ul = $("#memory-list"); ul.innerHTML = "";
  if (!mems.length) ul.innerHTML = '<li class="list-empty">Nothing saved yet. Say "remember that…" in chat, or add something above.</li>';
  for (const m of mems) {
    const li = document.createElement("li");
    li.className = "item";
    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = '<div class="title"></div><div class="meta"></div>';
    body.querySelector(".title").textContent = m.fact;
    body.querySelector(".meta").textContent = "Saved " + m.created_at.slice(0, 10);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×"; del.setAttribute("aria-label", "Forget");
    del.addEventListener("click", async () => {
      if (!confirm("Forget this?")) return;
      await api(`/api/memories/${m.id}`, { method: "DELETE" });
      loadMemories();
    });
    li.append(body, del);
    ul.appendChild(li);
  }
}

$("#memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/memories", { method: "POST", body: { fact: $("#memory-fact").value } });
    $("#memory-fact").value = "";
    loadMemories();
  } catch (err) { toast(err.message); }
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
  if (!("speechSynthesis" in window)) { $("#voice-select").disabled = true; return; }
  const sel = $("#voice-select");
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Automatic</option>';
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang.replace("_", "-")})`;
    sel.appendChild(o);
  }
  sel.value = store.get("voice") || "";
}
if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { if (!$("#view-more").hidden) fillVoices(); });
$("#voice-select").addEventListener("change", (e) => store.set("voice", e.target.value));
$("#voice-test").addEventListener("click", () => speak(`Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}. All systems are running normally.`));

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

// ---------------------------------------------------------- Home: dial, countdown, weather, date
let homeData = { next: null, created: null };
let clockTimer = null;

(function drawTicks() {
  const g = $("#ticks"), ns = "http://www.w3.org/2000/svg";
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 2 * Math.PI, major = i % 5 === 0;
    const r1 = major ? 126 : 129, r2 = 134;
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", 150 + r1 * Math.cos(a)); l.setAttribute("y1", 150 + r1 * Math.sin(a));
    l.setAttribute("x2", 150 + r2 * Math.cos(a)); l.setAttribute("y2", 150 + r2 * Math.sin(a));
    if (major) l.setAttribute("class", "major");
    g.appendChild(l);
  }
})();

const pad = (n) => String(n).padStart(2, "0");
function parseLocal(s) { return new Date(s.replace(" ", "T")); }

function tickClock() {
  const now = new Date();
  const h = now.getHours();
  $("#clock-hm").textContent = `${h % 12 || 12}:${pad(now.getMinutes())}`;
  $("#clock-ap").textContent = h < 12 ? "AM" : "PM";
  $("#clock-s").textContent = pad(now.getSeconds());
  $("#sec-arc").style.strokeDasharray = `${now.getSeconds() || 0.001} 60`;

  const arc = $("#countdown-arc"), cd = $("#next-cd");
  if (homeData.next) {
    const when = parseLocal(homeData.next.fire_at), left = when - now;
    // The ring fills over the last 24 hours before a reminder (or since it was set, if sooner).
    const windowMs = Math.min(24 * 3600e3, Math.max(60e3, when - parseLocal(homeData.next.created_at)));
    const pct = Math.max(0, Math.min(100, 100 - (left / windowMs) * 100));
    arc.style.strokeDasharray = `${pct} 100`;
    arc.classList.toggle("calm", left > 3600e3);
    cd.classList.toggle("calm", left > 3600e3);
    if (left <= 0) { cd.textContent = "now"; setTimeout(loadHome, 5000); }
    else {
      const s = Math.floor(left / 1000), d = Math.floor(s / 86400);
      cd.textContent = d >= 1
        ? `in ${d}d ${Math.floor((s % 86400) / 3600)}h`
        : `in ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    }
  } else {
    // No reminders: the ring shows how much of the day has gone by.
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    arc.style.strokeDasharray = `${((now - start) / 864e3).toFixed(2)} 100`;
    arc.classList.add("calm");
    cd.textContent = "";
  }
}

function startClock() {
  tickClock();
  clearInterval(clockTimer);
  clockTimer = setInterval(() => { if (!$("#view-home").hidden) tickClock(); }, 1000);
}

async function loadHome() {
  const now = new Date();
  $("#dt-month").textContent = now.toLocaleDateString(undefined, { month: "long" });
  $("#dt-day").textContent = now.getDate();
  $("#dt-week").textContent = now.toLocaleDateString(undefined, { weekday: "long" });
  $("#dt-year").textContent = now.getFullYear();
  updateStatus();
  startClock();

  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const [rems, tasks, spend, wx, settings, agenda] = await Promise.all([
    api("/api/reminders").catch(() => []),
    api("/api/tasks?include_done=false").catch(() => []),
    api(`/api/expenses?start=${start}`).catch(() => ({ total: 0 })),
    api("/api/weather").catch(() => ({ set: false })),
    api("/api/settings").catch(() => ({})),
    api("/api/agenda").catch(() => ({ connected: false })),
  ]);
  homeData.next = rems[0] || null;
  $("#next-label").textContent = homeData.next ? "Next reminder" : "No reminders set";
  $("#next-text").textContent = homeData.next ? homeData.next.text : "Ask me to remind you";
  tickClock();

  if (!wx.set) {
    $("#wx-place").textContent = "Weather"; $("#wx-temp").textContent = "--°";
    $("#wx-cond").textContent = "Tap to set your city"; $("#wx-hl").textContent = "";
  } else if (!wx.ok) {
    $("#wx-place").textContent = settings.weather_city || "Weather"; $("#wx-temp").textContent = "--°";
    $("#wx-cond").textContent = "Unavailable right now"; $("#wx-hl").textContent = "";
  } else {
    $("#wx-place").textContent = wx.place;
    $("#wx-temp").textContent = `${wx.temp}°`;
    $("#wx-cond").textContent = wx.condition;
    $("#wx-hl").textContent = `High ${wx.high}°, low ${wx.low}°`;
  }

  const overdue = tasks.filter((t) => { const d = prettyDue(t.due); return d && d.overdue; }).length;
  const row = $("#home-readouts"); row.innerHTML = "";
  row.append(
    overdue
      ? readout(String(overdue), overdue === 1 ? "overdue to-do" : "overdue to-dos", () => switchView("tasks"), true)
      : readout(String(tasks.length), tasks.length === 1 ? "open to-do" : "open to-dos", () => switchView("tasks")),
    readout("$" + Math.round(spend.total).toLocaleString(), `spent in ${now.toLocaleDateString(undefined, { month: "short" })}`, () => switchView("more")),
  );
  if (agenda.connected) {
    const nx = agenda.next;
    row.prepend(nx
      ? readout(parseLocal(nx.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }), nx.title, () => { switchView("chat"); })
      : readout(String(agenda.events.length), agenda.events.length ? "events today, all done" : "no events today", () => switchView("chat")));
  }
  row.classList.toggle("three", row.children.length === 3);
  updateStatus(settings.push_devices);
}

function updateStatus(devices) {
  const speakOn = store.get("speak") === "1";
  $("#st-voice").classList.toggle("on", speakOn);
  $("#st-voice .st-text").textContent = speakOn ? "Voice replies on" : "Voice replies off";
  if (devices !== undefined) {
    const on = devices > 0 && "Notification" in window && Notification.permission === "granted";
    $("#st-push").classList.toggle("on", on);
    $("#st-push .st-text").textContent = on ? "Alerts on" : "Alerts off";
  }
}

$("#st-voice").addEventListener("click", () => {
  store.set("speak", store.get("speak") === "1" ? "0" : "1");
  updateStatus();
  toast(store.get("speak") === "1" ? "Replies will be spoken out loud" : "Replies will be text only");
});
$("#st-push").addEventListener("click", () => switchView("more"));
$("#tile-date").addEventListener("click", () => switchView("tasks"));
$("#tile-weather").addEventListener("click", async () => {
  const city = prompt("Which city should the weather show? For example: Irvine, CA");
  if (!city || !city.trim()) return;
  try { await api("/api/settings", { method: "POST", body: { weather_city: city.trim() } }); toast("Weather city saved"); loadHome(); }
  catch (err) { toast(err.message); }
});
$("#home-type").addEventListener("click", () => { switchView("chat"); setTimeout(() => input.focus(), 50); });
$("#home-talk").addEventListener("click", () => { switchView("chat"); $("#mic-btn").click(); });

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
  if (e.target.closest(".orb") && document.documentElement.dataset.state === "speaking") {
    speechSynthesis.cancel();
    setOrb("");
  }
});

// ---------------------------------------------------------- start
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // warm up the voice list
api("/api/me").then(showApp).catch(() => showLogin());
