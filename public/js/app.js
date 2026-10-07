/* ── app.js — state, data loading, navigation, auto-refresh ──────────────── */
"use strict";

const REFRESH_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_KEY = "ivr.cachedData"; // last successful payload (offline fallback)

const App = {
  data: null,          // the full baked payload
  currentBrand: null,  // slug of open brand
  status: "init",
  timer: null,
};

/* ── load / refresh ──────────────────────────────────────────────────────── */
async function loadData({silent = false} = {}) {
  setStatus(silent ? App.status : "loading", silent ? undefined : "Refreshing…");
  const url = `data.json?cb=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    App.data = json;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: json }));
    setStatus("ok", `Synced · ${json.brandCount} hotline${json.brandCount === 1 ? "" : "s"}`);
    renderApp();
  } catch (err) {
    console.error("loadData failed:", err);
    // fallback to cached
    const cached = readCache();
    if (cached) {
      App.data = cached;
      setStatus("warn", `Couldn't reach the data source — showing the last successfully-synced data (${cacheAge(cached.ts)}).`);
      renderApp();
    } else {
      setStatus("error", "Failed to load IVR data.");
      showError(err.message || "Network error.");
    }
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.data || null;
  } catch { return null; }
}
function cacheAge(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${(m / 60).toFixed(1)} h ago`;
}

/* ── status / error ──────────────────────────────────────────────────────── */
function setStatus(kind, msg) {
  App.status = kind;
  const bar = document.getElementById("statusbar");
  const el = document.getElementById("statusMsg");
  bar.className = "statusbar";
  if (kind === "error") bar.classList.add("error");
  if (kind === "ok" || kind === "warn") bar.classList.add("ok");
  if (msg) el.textContent = msg;
  updateLastUpdated();
}
function lastUpdatedLabel() {
  if (!App.data || !App.data.generatedAt) return "Last updated: —";
  const d = new Date(App.data.generatedAt);
  const pad = n => String(n).padStart(2, "0");
  return `Last Updated: ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} — ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
function updateLastUpdated() {
  const el = document.getElementById("lastUpdated");
  if (el) el.textContent = lastUpdatedLabel();
}

function showError(msg) {
  document.getElementById("pageHome").classList.add("hidden");
  document.getElementById("pageBrand").classList.add("hidden");
  const err = document.getElementById("pageError");
  err.classList.remove("hidden");
  document.getElementById("errText").textContent = `We couldn't get the latest IVR data.`;
  document.getElementById("errFallback").textContent =
    App.data ? "Showing the last successfully-synced data." : "No cached data found yet — try again shortly.";
  history.replaceState(null, "", "#error");
}

/* ── render: dashboard + brand + nav ─────────────────────────────────────── */
function renderApp() {
  if (!App.data) return;
  renderNav();
  const hash = location.hash;
  if (hash.startsWith("#brand/")) {
    const slug = decodeURIComponent(hash.slice(7));
    openBrand(slug);
  } else if (hash && hash !== "#error") {
    openBrand(hash.slice(1));
  } else {
    showHome();
  }
}

function showHome() {
  document.getElementById("pageBrand").classList.add("hidden");
  document.getElementById("pageError").classList.add("hidden");
  document.getElementById("pageHome").classList.remove("hidden");
  history.replaceState(null, "", "#");
  const grid = document.getElementById("brandGrid");
  const brands = App.data.brands;
  if (!brands.length) {
    grid.innerHTML = `<div class="empty">No hotlines found in the spreadsheet yet.</div>`;
    return;
  }
  grid.innerHTML = brands.map(b => {
    const full = App.data.full.find(f => f.slug === b.slug) || b;
    const preview = (full.nodes && full.nodes[0] && full.nodes[0].title) ? " · " + escapeHtml(full.nodes[0].title) : "";
    return `
      <button class="brand-card" data-slug="${escapeHtml(b.slug)}" aria-label="Open ${escapeHtml(b.brand)} IVR flow">
        <div class="bc-type">Hotline</div>
        <h3>${escapeHtml(b.brand)}</h3>
        <div class="bc-meta">${b.nodeCount} IVR nodes · ${b.edgeCount} connections${preview}</div>
        <span class="go">View IVR flow →</span>
      </button>`;
  }).join("");
  grid.querySelectorAll(".brand-card").forEach(card => {
    card.addEventListener("click", () => openBrand(card.dataset.slug));
  });
  // loading skeleton
  document.getElementById("lastUpdated").textContent = lastUpdatedLabel();
}

function openBrand(slug) {
  const brand = App.data.full.find(b => b.slug === slug);
  if (!brand) { showHome(); return; }
  App.currentBrand = slug;
  document.getElementById("pageHome").classList.add("hidden");
  document.getElementById("pageError").classList.add("hidden");
  document.getElementById("pageBrand").classList.remove("hidden");
  history.replaceState(null, "", `#brand/${encodeURIComponent(slug)}`);
  document.getElementById("brandTitle").textContent = brand.brand;
  document.getElementById("brandSub").textContent = "Call Team IVR Hotline";
  renderFlow(brand);
  refreshNavActive();
}

function renderNav() {
  const menu = document.getElementById("brandMenu");
  const brands = App.data ? App.data.brands : [];
  menu.innerHTML = brands.map(b =>
    `<button data-slug="${escapeHtml(b.slug)}">${escapeHtml(b.brand)}</button>`
  ).join("");
  menu.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      closeNav();
      openBrand(btn.dataset.slug);
    });
  });
  refreshNavActive();
}
function refreshNavActive() {
  document.querySelectorAll("#tnNav button[data-page], #brandMenu button").forEach(b => {
    b.classList.remove("active");
  });
  if (App.currentBrand && document.querySelector(`#brandMenu button[data-slug="${CSS.escape(App.currentBrand)}"]`)) {
    document.querySelector(`#brandMenu button[data-slug="${CSS.escape(App.currentBrand)}"]`).classList.add("active");
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── nav interactions ────────────────────────────────────────────────────── */
function toggleNav(forceOpen = null) {
  const top = document.getElementById("topnav");
  const toggle = document.getElementById("navToggle");
  const open = forceOpen !== null ? forceOpen : !top.classList.contains("open");
  top.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
}
function closeNav() {
  toggleNav(false);
  const dd = document.getElementById("brandDrop");
  const trigger = dd.querySelector(".tn-drop-trigger");
  document.getElementById("brandMenu").classList.remove("open");
  trigger.setAttribute("aria-expanded", "false");
}

/* ── init ────────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (page === "home") { showHome(); closeNav(); }
    });
  });
  // brand dropdown
  const trigger = document.querySelector(".tn-drop-trigger");
  const menu = document.getElementById("brandMenu");
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains("open");
    menu.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tn-drop")) {
      menu.classList.remove("open");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    }
  });
  document.getElementById("navToggle").addEventListener("click", () => toggleNav());

  // refresh
  document.getElementById("refreshBtn").addEventListener("click", () => manualRefresh());
  document.getElementById("errRetry").addEventListener("click", () => loadData());
  // tools
  document.getElementById("expandAllBtn").addEventListener("click", () => setAllBranches(false));
  document.getElementById("collapseAllBtn").addEventListener("click", () => setAllBranches(true));
  document.getElementById("printBtn").addEventListener("click", () => printFlow());
  document.getElementById("copyBtn").addEventListener("click", () => copyFlow());

  // start
  loadData();
  App.timer = setInterval(() => loadData({ silent: true }), REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadData({ silent: true });
  });
});

async function manualRefresh() {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");
  btn.disabled = true;
  try {
    await loadData();
  } finally {
    setTimeout(() => { btn.classList.remove("spinning"); btn.disabled = false; }, 600);
  }
}

// expose for flow.js (classic scripts share globals; explicit for clarity)
window.App = App;
window.loadData = loadData;
window.showHome = showHome;
window.openBrand = openBrand;
