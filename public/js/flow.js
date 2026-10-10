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
function buildTree(brand) {
  const byId = new Map(brand.nodes.map(n => [n.id, n]));
  const children = new Map();
  for (const e of brand.edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
  }
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
  const orderedChildren = id => (children.get(id) || []).slice()
    .sort((a, b) => (byId.get(a)?.col ?? 0) - (byId.get(b)?.col ?? 0));
  return { byId, children, orderedChildren, root };
}

// ── node height from content ───────────────────────────────────────────────
function nodeHeight(n) {
  const bodyText = (n.body || "").trim();
  // If the body is just the title (bare label like "KEY 3") or empty, no body area
  const isBareLabel = !bodyText || bodyText === (n.title || "").trim() || /^KEY\s*\d+$/i.test(bodyText);
  if (isBareLabel) {
    // Just the header + options (if any)
    const optsH = n.options && n.options.length ? 30 : 0;
    return 40 + optsH; // head + options
  }
  const lines = bodyText.split("\n").length;
  const bodyH = Math.min(400, 40 + lines * 15);
  const optsH = n.options && n.options.length ? 30 : 0;
  return 40 + bodyH + optsH; // head + body + options
}

// ── layout: tidy top-down tree ──────────────────────────────────────────────
function layoutTree(tree, brand) {
  const { byId, orderedChildren } = tree;
  const NODE_W = 250, H_GAP = 34, V_GAP = 46, PAD = 30;
  const pos = new Map(); // id -> {x, y, w, h}
  const depth = new Map();

  let cursor = 0;
  function assignX(id) {
    const ch = orderedChildren(id);
    if (!ch.length) {
      pos.set(id, { x: cursor, y: 0, w: NODE_W, h: nodeHeight(byId.get(id)) });
      cursor += NODE_W + H_GAP;
      return;
    }
    for (const c of ch) assignX(c);
    const xs = ch.map(c => pos.get(c).x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    pos.set(id, { x: (minX + maxX) / 2, y: 0, w: NODE_W, h: nodeHeight(byId.get(id)) });
  }
  assignX(tree.root);

  const q = [tree.root];
  depth.set(tree.root, 0);
  while (q.length) {
    const id = q.shift();
    const d = depth.get(id);
    for (const c of orderedChildren(id)) { depth.set(c, d + 1); q.push(c); }
  }
  const depthH = new Map();
  for (const id of pos.keys()) {
    const d = depth.get(id);
    depthH.set(d, Math.max(depthH.get(d) || 0, pos.get(id).h));
  }
  const depthY = new Map();
  let acc = 0;
  const maxDepth = Math.max(...depth.values());
  for (let d = 0; d <= maxDepth; d++) { depthY.set(d, acc); acc += (depthH.get(d) || 0) + V_GAP; }
  for (const [id, p] of pos) { p.y = depthY.get(depth.get(id)); }

  let minX = Infinity;
  for (const p of pos.values()) minX = Math.min(minX, p.x);
  for (const p of pos.values()) p.x += PAD - minX;

  return { pos, NODE_W, V_GAP, PAD };
}

// ── render ──────────────────────────────────────────────────────────────────
function renderFlow(brand) {
  const canvas = document.getElementById("flowCanvas");
  const tree = buildTree(brand);
  const { pos, NODE_W, PAD } = layoutTree(tree, brand);
  const { byId, orderedChildren } = tree;

  let maxX = PAD, maxY = PAD;
  for (const p of pos.values()) {
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + p.h);
  }
  maxX += PAD; maxY += PAD;

  const inner = document.createElement("div");
  inner.className = "flow-inner";
  inner.style.width = maxX + "px";
  inner.style.height = maxY + "px";

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "flow-svg");
  svg.setAttribute("width", maxX);
  svg.setAttribute("height", maxY);
  svg.style.zIndex = "0";
  inner.appendChild(svg);

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
    el.style.height = p.h + "px";
    el.style.zIndex = "1";

    const toggle = hasKids
      ? `<button class="nd-toggle" data-t="${escapeHtml(id)}" title="Collapse branch" aria-label="Collapse branch">−</button>`
      : (collapsed ? `<button class="nd-toggle" data-t="${escapeHtml(id)}" title="Expand branch" aria-label="Expand branch">+</button>` : "");
    const icon = TYPE_ICON[n.type] || "•";
        const opts = (n.options && n.options.length)
          ? `<div class="nd-opt">${n.options.map(o => `<span class="opt-chip">${escapeHtml(o.key)} · ${escapeHtml(o.label)}</span>`).join("")}</div>` : "";
        // if the body is just the title (a bare key label like "KEY 1" or "Key 4 (Sales)"),
        // show no body subtext — the white chip area is removed
        const bodyText = (n.body || "").trim();
        const isBareLabel = !bodyText || bodyText === n.title.trim() || /^KEY\s*\d+$/i.test(bodyText) || /^NO OR WRONG INPUT$/i.test(bodyText);
        let bodyHtml = "";
        if (!isBareLabel) {
          let body = escapeHtml(bodyText).replace(/[Pp]ress\s+(\d+)/g, '<span class="press-highlight">Press $1</span>');
          bodyHtml = `<div class="nd-body">${body}</div>`;
        }

        el.innerHTML =
          `<div class="nd-head"><span class="nd-icon">${icon}</span><span class="nd-title">${escapeHtml(n.title)}</span>${toggle}</div>` +
          bodyHtml + opts;
    inner.appendChild(el);

    const tgl = el.querySelector(".nd-toggle");
    if (tgl) tgl.addEventListener("click", (e) => { e.stopPropagation(); toggleBranch(id); });
  };

  const q = [tree.root];
  while (q.length) {
    const id = q.shift();
    place(id);
    if (collapsedSet.has(id)) continue;
    for (const c of orderedChildren(id)) q.push(c);
  }

  const draw = (fromId, toId) => {
    const pf = pos.get(fromId), cf = pos.get(toId);
    if (!pf || !cf) return;
    const path = document.createElementNS(svgNs, "path");
    const x1 = pf.x + NODE_W / 2, y1 = pf.y + pf.h;
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
  // center the view on the root node via pan translate
  const rp = pos.get(tree.root);
  if (rp) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2 - (rp.x + NODE_W / 2) * scale;
    const cy = rect.height / 2 - (rp.y + rp.h / 2) * scale;
    inner.dataset.panX = Math.min(0, cx);
    inner.dataset.panY = Math.min(0, cy);
    applyTransform();
  }
}

/* ── collapse / expand (per-branch toggle only) ───────────────────────────── */
function toggleBranch(id) {
  if (collapsedSet.has(id)) collapsedSet.delete(id);
  else collapsedSet.add(id);
  rerender();
}
function rerender() {
  if (!App.currentBrand) return;
  const brand = App.data.full.find(b => b.slug === App.currentBrand);
  if (brand) renderFlow(brand);
}

/* ── pan / zoom / fullscreen ──────────────────────────────────────────────── */
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
  const px = +(inner.dataset.panX || 0);
  const py = +(inner.dataset.panY || 0);
  inner.style.transform = `translate(${px}px, ${py}px) scale(${scale})`;
  inner.style.transformOrigin = "0 0";
}
function initFlowControls() {
  const canvas = document.getElementById("flowCanvas");
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(2.2, Math.max(0.3, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    applyTransform();
  }, { passive: false });

  let dragging = false, startX = 0, startY = 0, panX = 0, panY = 0, moved = false;
  let panDX = 0, panDY = 0;
  canvas.addEventListener("mousedown", (e) => {
    // allow dragging from anywhere, except from the collapse toggle button
    if (e.target.closest(".nd-toggle, button, a")) return;
    e.preventDefault(); // prevent text highlighting during drag
    dragging = true; moved = false;
    canvas.classList.add("dragging");
    canvas.classList.add("no-select");
    startX = e.clientX; startY = e.clientY;
    const inner = canvas.querySelector(".flow-inner");
    panDX = inner ? +(inner.dataset.panX || 0) : 0;
    panDY = inner ? +(inner.dataset.panY || 0) : 0;
  });
  // Prevent text selection during drag (covers edge cases e.preventDefault misses)
  document.addEventListener("selectstart", (e) => {
    if (dragging) e.preventDefault();
  }, true);
  canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; // it's a drag, not a click
    panDrag(panDX + dx, panDY + dy);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("dragging");
    canvas.classList.remove("no-select");
  });
  // pan by translating the inner content (smooth up/down/left/right)
  function panDrag(dx, dy) {
    const inner = canvas.querySelector(".flow-inner");
    if (!inner) return;
    inner.dataset.panX = dx; inner.dataset.panY = dy;
    inner.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  }
  let t0 = null, t0pan = null;
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const inner = canvas.querySelector(".flow-inner");
    t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    t0pan = { x: inner ? +(inner.dataset.panX || 0) : 0, y: inner ? +(inner.dataset.panY || 0) : 0 };
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    if (!t0 || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - t0.x, dy = e.touches[0].clientY - t0.y;
    panDrag(t0pan.x + dx, t0pan.y + dy);
  }, { passive: true });
  canvas.addEventListener("touchend", () => { t0 = null; });

  // Keyboard arrow-key panning (easy drag up down left right without scroll)
  const PAN_STEP = 60;
  function panBy(dx, dy) {
    const inner = canvas.querySelector(".flow-inner");
    if (!inner) return;
    const curX = +(inner.dataset.panX || 0);
    const curY = +(inner.dataset.panY || 0);
    inner.dataset.panX = curX + dx;
    inner.dataset.panY = curY + dy;
    applyTransform();
  }
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.target.closest("button, a")) return;
    switch (e.key) {
      case "ArrowUp":    e.preventDefault(); panBy(0, PAN_STEP);  break;
      case "ArrowDown":  e.preventDefault(); panBy(0, -PAN_STEP); break;
      case "ArrowLeft":  e.preventDefault(); panBy(PAN_STEP, 0);  break;
      case "ArrowRight": e.preventDefault(); panBy(-PAN_STEP, 0); break;
      case " ":        // space = reset pan to center
        e.preventDefault();
        const inner = canvas.querySelector(".flow-inner");
        if (inner) { inner.dataset.panX = 0; inner.dataset.panY = 0; applyTransform(); }
        break;
    }
  });
}

function toggleFullscreen() {
  const wrap = document.getElementById("flowWrap");
  const btn = document.getElementById("fullscreenBtn");
  if (!document.fullscreenElement) {
    if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
    if (btn) btn.textContent = "Exit Fullscreen";
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    if (btn) btn.textContent = "Fullscreen";
  }
}
document.addEventListener("fullscreenchange", () => {
  const btn = document.getElementById("fullscreenBtn");
  if (btn) btn.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
});

document.addEventListener("DOMContentLoaded", initFlowControls);

// expose for app.js
window.renderFlow = renderFlow;
window.toggleBranch = toggleBranch;
window.toggleFullscreen = toggleFullscreen;
