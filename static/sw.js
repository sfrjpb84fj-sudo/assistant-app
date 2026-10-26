// Keeps the app shell available so it opens fast, and shows push notifications.
// Never caches your data (/api/...).
const CACHE = "assistant-v6";
const SHELL = ["/", "/static/style.css", "/static/app.js", "/static/manifest.json", "/static/icon-192.png", "/static/chakra-petch-latin-500-normal.woff2", "/static/chakra-petch-latin-600-normal.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Network first (so updates show up), fall back to the saved copy when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "Assistant", body: "" };
  try { data = e.data.json(); } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(data.title || "Assistant", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
      data: { url: "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if ("focus" in w) return w.focus();
      return self.clients.openWindow("/");
    })
  );
});
