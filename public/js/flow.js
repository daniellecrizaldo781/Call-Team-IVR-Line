/* ── flow.js — IVR flow diagram renderer (clean top-down tree) ───────────── */
"use strict";

let collapsedSet = new Set(); // node ids whose subtree is collapsed

const TYPE_ICON = {
  greeting: "🎙️", menu: "☰", option: "🔢", transfer: "👤",
  endpoint: "✉️", fallback: "⚠️", info: "ℹ️", repeat: "🔁",
  service: "🎧", message: "🔊",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── build a tree from the graph, starting at the main root ─────────────────
// The sheet is a forest; we render the largest coherent flow (the one rooted at
// "Call Comes In"). Children are ordered by their sheet column (left→right).
function buildTree(brand) {
  const byId = new Map(brand.nodes.map(n => [n.id, n]));
  const children = new Map();
  for (const e of brand.edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
  }
  // pick the root with the most descendants (the main flow)
  const memo = new Map();
  function size(id) {
    if (memo.has(id)) return memo.get(id);
    let s = 1;
    for (const c of children.get(id) || []) s += size(c);
    memo.set(id, s);
    return s;
  }
  let root = null, best = -1;
  for (const r of brand.roots) {
    const s = size(r);
    if (s > best) { best = s; root = r; }
  }
  if (!root && brand.nodes.length) root = brand.nodes[0].id;

  // order children by column
  const orderedChildren = id => (children.get(id) || []).slice()
    .sort((a, b) => (byId.get(a)?.col ?? 0) - (byId.get(b)?.col ?? 0));

  return { byId, children, orderedChildren, root };
}

// ── layout: tidy top-down tree (Reingold–Tilford style) ────────────────────
// Each node gets (x, y). Leaves are spaced horizontally; parents center over
// their children. y = depth * rowHeight.
function layoutTree(tree, brand) {
  const { byId, orderedChildren } = tree;
  const NODE_W = 250, NODE_H = 96, H_GAP = 34, V_GAP = 46, PAD = 30;
  const pos = new Map(); // id -> {x, y, w, h}
  const depth = new Map();

  // compute subtree leaf count for horizontal spacing
  const leafCount = new Map();
  function leaves(id) {
    const ch = orderedChildren(id);
    if (!ch.length) { leafCount.set(id, 1); return 1; }
    let s = 0;
    for (const c of ch) s += leaves(c);
    leafCount.set(id, s);
    return s;
  }
  leaves(tree.root);

  // assign x via a cursor that walks leaves left→right
  let cursor = 0;
  function assignX(id) {
    const ch = orderedChildren(id);
    if (!ch.length) {
      pos.set(id, { x: cursor, y: 0, w: NODE_W, h: NODE_H });
      cursor += NODE_W + H_GAP;
      return;
    }
    for (const c of ch) assignX(c);
    // parent centered over children
    const xs = ch.map(c => pos.get(c).x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    pos.set(id, { x: (minX + maxX) / 2, y: 0, w: NODE_W, h: NODE_H });
  }
  assignX(tree.root);

  // assign y by depth (BFS)
  const q = [tree.root];
  depth.set(tree.root, 0);
  while (q.length) {
    const id = q.shift();
    const d = depth.get(id);
    for (const c of orderedChildren(id)) {
      depth.set(c, d + 1);
      q.push(c);
    }
  }
  for (const [id, p] of pos) {
    p.y = depth.get(id) * (NODE_H + V_GAP);
  }
  // normalize x to >= PAD
  let minX = Infinity;
  for (const p of pos.values()) minX = Math.min(minX, p.x);
  for (const p of pos.values()) p.x += PAD - minX;

  return { pos, NODE_W, NODE_H, H_GAP, V_GAP, PAD };
}

// ── render ──────────────────────────────────────────────────────────────────
function renderFlow(brand) {
  const canvas = document.getElementById("flowCanvas");
  const tree = buildTree(brand);
  const { pos, NODE_W, NODE_H, V_GAP, PAD } = layoutTree(tree, brand);
  const { byId, orderedChildren } = tree;

  // compute canvas size
  let maxX = PAD, maxY = PAD;
  for (const p of pos.values()) {
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  maxX += PAD; maxY += PAD;

  const inner = document.createElement("div");
  inner.className = "flow-inner";
  inner.style.width = maxX + "px";
  inner.style.height = maxY + "px";

  // SVG connectors
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "flow-svg");
  svg.setAttribute("width", maxX);
  svg.setAttribute("height", maxY);
  svg.style.zIndex = "0";
  inner.appendChild(svg);

  // place nodes
  const placed = new Set();
  const place = (id) => {
    if (placed.has(id)) return;
    placed.add(id);
    const n = byId.get(id);
    const p = pos.get(id);
    if (!n || !p) return;
    const collapsed = collapsedSet.has(id) && orderedChildren(id).length > 0;
    const hasKids = orderedChildren(id).length > 0 && !collapsed;

    const el = document.createElement("div");
    el.className = `ivr-node t-${n.type || "message"}`;
    el.style.left = p.x + "px";
    el.style.top = p.y + "px";
    el.style.width = NODE_W + "px";
    el.style.zIndex = "1";

    const toggle = hasKids
      ? `<button class="nd-toggle" data-t="${escapeHtml(id)}" title="Collapse branch" aria-label="Collapse branch">−</button>`
      : (collapsed ? `<button class="nd-toggle" data-t="${escapeHtml(id)}" title="Expand branch" aria-label="Expand branch">+</button>` : "");
    const icon = TYPE_ICON[n.type] || "•";
    const opts = (n.options && n.options.length)
      ? `<div class="nd-opt">${n.options.map(o => `<span class="opt-chip">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</span>`).join("")}</div>` : "";
    let body = escapeHtml(n.body || n.title || "");
    body = body.length > 700 ? body.slice(0, 700) + "…" : body;

    el.innerHTML =
      `<div class="nd-head"><span class="nd-icon">${icon}</span><span class="nd-title">${escapeHtml(n.title)}</span>${toggle}</div>` +
      `<div class="nd-body">${body}</div>` + opts;
    inner.appendChild(el);

    const tgl = el.querySelector(".nd-toggle");
    if (tgl) tgl.addEventListener("click", (e) => { e.stopPropagation(); toggleBranch(id); });
  };

  // BFS place (respect collapse)
  const q = [tree.root];
  while (q.length) {
    const id = q.shift();
    place(id);
    if (collapsedSet.has(id)) continue;
    for (const c of orderedChildren(id)) q.push(c);
  }

  // draw connectors between placed parents & children
  const draw = (fromId, toId) => {
    const pf = pos.get(fromId), cf = pos.get(toId);
    if (!pf || !cf) return;
    const path = document.createElementNS(svgNs, "path");
    const x1 = pf.x + NODE_W / 2, y1 = pf.y + NODE_H;
    const x2 = cf.x + NODE_W / 2, y2 = cf.y;
    const midY = (y1 + y2) / 2;
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    svg.appendChild(path);
  };
  for (const e of brand.edges) {
    if (placed.has(e.from) && placed.has(e.to)) draw(e.from, e.to);
  }

  canvas.innerHTML = "";
  canvas.appendChild(inner);
  fitView(maxX, maxY);
}

/* ── collapse / expand ───────────────────────────────────────────────────── */
function toggleBranch(id) {
  if (collapsedSet.has(id)) collapsedSet.delete(id);
  else collapsedSet.add(id);
  rerender();
}
function setAllBranches(collapse) {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (!brand) return;
  if (collapse) {
    const tree = buildTree(brand);
    const { orderedChildren } = tree;
    const q = [tree.root];
    while (q.length) {
      const id = q.shift();
      if (orderedChildren(id).length) collapsedSet.add(id);
      for (const c of orderedChildren(id)) q.push(c);
    }
  } else {
    collapsedSet.clear();
  }
  rerender();
}
function rerender() {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (brand) renderFlow(brand);
}

/* ── pan / zoom ───────────────────────────────────────────────────────────── */
let scale = 1;
function fitView(w, h) {
  const cv = document.getElementById("flowCanvas");
  const rect = cv.getBoundingClientRect();
  const s = Math.min(1, (rect.width - 20) / Math.max(w, 400));
  scale = Math.max(0.3, s);
  applyTransform();
}
function applyTransform() {
  const inner = document.querySelector(".flow-inner");
  if (!inner) return;
  inner.style.transform = `scale(${scale})`;
  inner.style.transformOrigin = "0 0";
}
function initFlowControls() {
  const canvas = document.getElementById("flowCanvas");
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(2.2, Math.max(0.3, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyTransform();
  }, { passive: false });

  let dragging = false, startX = 0, startY = 0, stLeft = 0, stTop = 0;
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

/* ── print / copy ─────────────────────────────────────────────────────────── */
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

// expose for app.js
window.renderFlow = renderFlow;
window.setAllBranches = setAllBranches;
window.toggleBranch = toggleBranch;
window.printFlow = printFlow;
window.copyFlow = copyFlow;
