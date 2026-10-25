"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let currentList = "work";
let pending = [];          // attachments waiting to be sent: {name, type, data, preview}
let assistantName = "Assistant";

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
    document.title = assistantName;
    if (!$("#view-chat").hidden) $("#view-title").textContent = assistantName;
  } catch { /* handled by api() */ }
  await loadMessages();
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
const titles = { chat: "Chat", tasks: "To-dos", memory: "Memory", more: "More" };
function switchView(name) {
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  for (const v of Object.keys(titles)) $(`#view-${v}`).hidden = v !== name;
  $("#view-title").textContent = name === "chat" ? assistantName : titles[name];
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
  if (document.visibilityState === "visible" && !$("#app").hidden && !$("#view-chat").hidden && !$("#send").disabled) loadMessages();
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

function renderEmpty() {
  $("#messages").innerHTML = "";
  const d = document.createElement("div");
  d.className = "empty";
  const s = document.createElement("strong");
  s.textContent = `Hi, I'm ${assistantName}.`;
  d.append(s, 'Try "Remind me at 3pm to call the bank", "Add the monthly report to my work list for Friday", or snap a photo of a receipt with ＋.');
  $("#messages").appendChild(d);
}

async function loadMessages() {
  const msgs = await api("/api/messages");
  $("#messages").innerHTML = "";
  if (!msgs.length) return renderEmpty();
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
  if ($(".empty")) $("#messages").innerHTML = "";
  const label = pending.map((p) => (p.type === "application/pdf" ? "📄 " : "🖼 ") + p.name).join("  ");
  addBubble("user", [label, text].filter(Boolean).join("\n"));
  clearAttachments();
  $("#send").disabled = true;
  const typing = addBubble("assistant", "");
  typing.classList.add("typing");
  typing.innerHTML = "<span></span><span></span><span></span>";
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
  const v = voices.find((x) => /en[-_]GB/i.test(x.lang) && /Daniel|Arthur/i.test(x.name))
    || voices.find((x) => /en[-_]US/i.test(x.lang) && /Enhanced|Premium/i.test(x.name))
    || voices.find((x) => /^en/i.test(x.lang));
  if (v) { u.voice = v; u.lang = v.lang; }
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

// ---------------------------------------------------------- start
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // warm up the voice list
api("/api/me").then(showApp).catch(() => showLogin());
