/* ── flow.js — IVR flow diagram renderer (geometric, sheet-faithful) ─────── */
"use strict";

const X_UNIT = 92;        // px per spreadsheet column
const VGAP = 26;          // vertical gap between rows
const HPAD = 26;          // left/top padding
const MIN_H = 74;         // min row height baseline

let collapsedSet = new Set(); // node ids whose subtree is collapsed

const TYPE_LABEL = {
  greeting: "Greeting",
  menu: "Menu",
  option: "Option",
  transfer: "Transfer",
  endpoint: "Endpoint",
  fallback: "Fallback",
  info: "Info",
  repeat: "Repeat",
  service: "Agent",
  message: "Message",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function nodeHeight(node) {
  const lines = (node.body || node.title || "").split("\n").length;
  const base = node.options && node.options.length ? 30 : 16;
  const body = Math.max(node.options && node.options.length ? 92 : 74, 44 + lines * 16);
  return body + 34;
}

function renderFlow(brand) {
  const canvas = document.getElementById("flowCanvas");
  const wrap = document.getElementById("flowWrap");
  const collapsedRoots = collapsedSet;

  // ── compute geometry ──────────────────────────────────────────────────────
  const byRow = new Map();
  for (const n of brand.nodes) {
    if (!byRow.has(n.row)) byRow.set(n.row, []);
    byRow.get(n.row).push(n);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);

  // cumulative Y per row
  const yPos = new Map();
  let y = HPAD;
  let maxX = HPAD;
  for (const r of rows) {
    let rh = MIN_H;
    for (const n of byRow.get(r)) {
      if (!collapsedRoots.has(n.id)) {
        rh = Math.max(rh, nodeHeight(n));
        maxX = Math.max(maxX, HPAD + (n.col + n.colSpan) * X_UNIT);
      }
    }
    yPos.set(r, y);
    y += rh + VGAP;
  }
  const totalH = y + HPAD;

  const inner = document.createElement("div");
  inner.className = "flow-inner";
  const svgNs = "http://www.w3.org/2000/svg";

  // ── SVG connectors layer ──────────────────────────────────────────────────
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "flow-svg");
  svg.setAttribute("width", maxX);
  svg.setAttribute("height", totalH);
  const posOf = id => (nodePosCache.get(id) || null);
  const drawConnector = (fromX, fromY, toX, toY, hot) => {
    const path = document.createElementNS(svgNs, "path");
    const midY = (fromY + toY) / 2;
    const d = `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
    path.setAttribute("d", d);
    if (hot) path.setAttribute("class", "hot");
    svg.appendChild(path);
  };
  inner.appendChild(svg);

  // ── node layer (capture positions while building) ─────────────────────────
  const nodeEls = new Map();
  const nodePosCache = new Map(); // id -> {x, y, w, h}

  for (const r of rows) {
    const rowNodes = byRow.get(r).slice().sort((a, b) => a.col - b.col);
    for (const n of rowNodes) {
      const w = Math.max(n.colSpan * X_UNIT - 10, 150);
      const x = HPAD + n.col * X_UNIT;
      const yp = yPos.get(r);
      const hp = nodeHeight(n);
      nodePosCache.set(n.id, { x, y: yp, w, h: hp });
    }
  }

  const placeNode = (n) => {
    const p = nodePosCache.get(n.id);
    if (!p) return;
    const el = document.createElement("div");
    el.className = `ivr-node t-${n.type || "message"}`;
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
    el.style.width = p.w + "px";
    el.style.height = p.h + "px";
    const collapsed = collapsedRoots.has(n.id) && (brand.edges.some(e => e.from === n.id));
    const hasKids = brand.edges.some(e => e.from === n.id) && !collapsedRoots.has(n.id);

    let head = `<div class="nd-head">${TYPE_LABEL[n.type] || "Step"}${hasKids ? `<button class="nd-toggle" data-t="${escapeHtml(n.id)}" title="Collapse branch" aria-label="Collapse branch">−</button>` : ""}</div>`;
    if (collapsed) {
      head = `<div class="nd-head">${TYPE_LABEL[n.type] || "Step"}<button class="nd-toggle" data-t="${escapeHtml(n.id)}" title="Expand branch" aria-label="Expand branch">+</button></div>`;
    }
    const opts = (n.options && n.options.length)
      ? `<div class="nd-opt">${n.options.map(o => `<span class="opt-chip">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</span>`).join("")}</div>` : "";
    let body = escapeHtml(n.body || n.title || "");
    body = body.length > 900 ? body.slice(0, 900) + "…" : body;
    el.innerHTML = head + `<div class="nd-body">${body}</div>` + opts;
    canvas.appendChild(el);
    nodeEls.set(n.id, el);

    // collapse toggle
    const tgl = el.querySelector(".nd-toggle");
    if (tgl) tgl.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBranch(n.id);
    });
  };

  inner.appendChild(svg);
  canvas.innerHTML = "";
  canvas.appendChild(inner);

  // build nodes (but skip rendering children of a collapsed root)
  const renderedIds = new Set();
  const buildNodeTree = (id) => {
    if (renderedIds.has(id)) return;
    renderedIds.add(id);
    const n = brand.nodes.find(x => x.id === id);
    if (!n) return;
    placeNode(n);
    // children
    const kids = brand.edges.filter(e => e.from === id).map(e => e.to);
    for (const k of kids) {
      if (collapsedRoots.has(id)) {
        markHidden(k); // subtree hidden
      } else {
        buildNodeTree(k);
      }
    }
  };
  const markHidden = (id) => {
    if (renderedIds.has(id)) return;
    renderedIds.add(id);
    const kids = brand.edges.filter(e => e.from === id).map(e => e.to);
    kids.forEach(markHidden);
  };

  // render all roots (the sheet may have several)
  const rootIds = [...brand.roots];
  const seenIds = new Set();
  const allNodesId = new Map(brand.nodes.map(n => [n.id, n]));
  for (const rid of rootIds) buildNodeTree(rid);
  for (const n of brand.nodes) buildNodeTree(n.id); // stragglers

  // ── draw connectors between rendered parents & children ───────────────────
  for (const e of brand.edges) {
    const pf = posOf(e.from);
    const cf = posOf(e.to);
    if (!pf || !cf) continue;
    drawConnector(pf.x + pf.w / 2, pf.y + pf.h, cf.x + cf.w / 2, cf.y, false);
  }
  // position svg behind nodes (append after is fine visually; set z-index)
  svg.style.zIndex = "0";
  inner.querySelectorAll(".ivr-node").forEach(el => el.style.zIndex = "1");

  // dim hidden (collapsed) descendants
  markHiddenAll();
  function markHiddenAll() {
    // children of collapsed nodes are not placed -> nothing to dim
  }

  // ── sizing / zoom-fit ─────────────────────────────────────────────────────
  inner.style.width = maxX + "px";
  inner.style.height = totalH + "px";
  fitView(maxX, totalH);
}

/* collapse one branch: hide the child subtree of `id` */
function toggleBranch(id) {
  if (collapsedSet.has(id)) collapsedSet.delete(id);
  else collapsedSet.add(id);
  if (App.currentBrand) {
    const brand = App.data.full.find(b => b.slug === App.currentBrand);
    if (brand) renderFlow(brand);
  }
}
function setAllBranches(collapse) {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (!brand) return;
  if (collapse) {
    // collapse every node that has children except roots
    const childIds = new Set(brand.edges.map(e => e.from));
    brand.nodes.forEach(n => { if (childIds.has(n.id) && !brand.roots.includes(n.id)) collapsedSet.add(n.id); });
  } else {
    collapsedSet.clear();
  }
  renderFlow(brand);
}

/* ── pan / zoom (wheel + pointer-drag) ────────────────────────────────────── */
let scale = 1;
function fitView(w, h) {
  const cv = document.getElementById("flowCanvas");
  const rect = cv.getBoundingClientRect();
  const s = Math.min(1, (rect.width - 20) / Math.max(w, 400));
  scale = Math.max(0.35, s);
  applyTransform();
}
function applyTransform() {
  const inner = document.querySelector(".flow-inner");
  if (!inner) return;
  inner.style.transform = `scale(${scale})`;
}
function initFlowControls() {
  const canvas = document.getElementById("flowCanvas");
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(2.2, Math.max(0.3, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyTransform();
  }, { passive: false });

  let dragging = false, startX = 0, startY = 0, stLeft = 0;
  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ivr-node, .nd-toggle, button")) return;
    dragging = true;
    canvas.classList.add("dragging");
    startX = e.clientX; startY = e.clientY;
    stLeft = canvas.scrollLeft; stTop = canvas.scrollTop;
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    canvas.scrollLeft = stLeft - (e.clientX - startX);
    canvas.scrollTop = stTop - (e.clientY - startY);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("dragging");
  });
  // touch pan
  let t0 = null, t0scroll = null;
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    t0scroll = { l: canvas.scrollLeft, t: canvas.scrollTop };
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    if (!t0 || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - t0.x, dy = e.touches[0].clientY - t0.y;
    canvas.scrollLeft = t0scroll.l - dx;
    canvas.scrollTop = t0scroll.t - dy;
  }, { passive: true });
  canvas.addEventListener("touchend", () => { t0 = null; });
}

/* ── print ────────────────────────────────────────────────────────────────── */
function printFlow() {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (!brand) return;
  const w = window.open("", "_blank");
  const nodes = brand.nodes.map(n =>
    `<div style="margin:8px 0;border:1px solid #ddd;border-left:4px solid #E0457B;border-radius:6px;padding:8px 12px">
       <b>${escapeHtml(n.title)}</b><div style="white-space:pre-wrap;font-size:13px">${escapeHtml(n.body || "")}</div>
     </div>`).join("");
  w.document.write(`<!doctype html><html><head><title>${escapeHtml(brand.brand)} — IVR</title><style>body{font-family:sans-serif;color:#333;padding:20px;max-width:760px;margin:auto}</style></head><body>
    <h1>${escapeHtml(brand.brand)} — Call Team IVR Hotline</h1>
    <p>Nodes: ${brand.nodeCount} · Connections: ${brand.edgeCount}</p>
    ${nodes}
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/* ── copy IVR text ────────────────────────────────────────────────────────── */
function copyFlow() {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (!brand) return;
  const lines = brand.nodes.map(n =>
    `• ${n.title}${n.options && n.options.length ? "  [Press " + n.options.map(o => o.key + ": " + o.label).join(" | ") + "]" : ""}\n  ${(n.body || "").replace(/\n/g, "\n  ")}`
  );
  const text = `${brand.brand} — Call Team IVR Hotline\n\n${lines.join("\n")}`;
  const done = () => setStatus("ok", "IVR copied to clipboard.");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta);
  ta.select(); try { document.execCommand("copy"); done(); } catch {}
  document.body.removeChild(ta);
}

document.addEventListener("DOMContentLoaded", initFlowControls);

// expose for app.js (classic scripts share globals; explicit for clarity)
window.renderFlow = renderFlow;
window.setAllBranches = setAllBranches;
window.toggleBranch = toggleBranch;
window.printFlow = printFlow;
window.copyFlow = copyFlow;
