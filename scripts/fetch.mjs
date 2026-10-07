// scripts/fetch.mjs
// Server-side fetcher + parser. Reads the Google Sheet (public xlsx export — no
// credentials needed for a link-shared sheet) and emits a JSON data model.
// Runs in GitHub Actions every 15 min. Layers: fetch -> parse -> tree -> emit.
import XLSX from "xlsx";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID || "1HZtIq4jt4EHrw2Ord3yqXkdLOHN7h-EDJYK7SbyeQKY";
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
const ARROW = "\u2b07";

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";
const clean = v => String(v ?? "").replace(/^"|"$/g, "").replace(/\t/g, " ").replace(/[ \t]+/g, " ").trim();
const isArrow = t => t.includes(ARROW);

export async function fetchBucket() {
  const res = await fetch(EXPORT_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`Sheet export HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Step 1: raw cards (merged range or single cell) + arrows (positions) ─────
export function collectCells(wb) {
  const tabs = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) { tabs[name] = { cards: [], arrows: [] }; continue; }
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const merges = (ws["!merges"] || []).map(m => ({ r0: m.s.r, c0: m.s.c, r1: m.e.r, c1: m.e.c }));
    const inMerge = (r, c) => merges.find(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
    const cards = []; const arrows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell || cell.v == null) continue;
        const txt = clean(cell.v);
        if (!txt) continue;
        if (isArrow(txt)) { arrows.push({ r, c }); continue; }
        const m = inMerge(r, c);
        if (m && (r !== m.r0 || c !== m.c0)) continue;
        cards.push({ r, c, text: txt, m, id: `${slug(name)}_r${r}c${c}` });
      }
    }
    tabs[name] = { cards, arrows, merges };
  }
  return tabs;
}

// ── Step 2: build nodes by merging adjacent header+body cards vertically ─────
// A card that sits directly below an existing node (gap 1, no arrow between,
// column spans overlap) is treated as the BODY of that node and merged into it.
// This handles "Audio Message" label + message text stacked with slight col offset.
export function buildNodes(cards, arrows) {
  const sorted = [...cards].sort((a, b) => a.r - b.r || a.c - b.c);
  const nodes = [];
  const overlaps = (n, card) => !(n.col1 < card.c0 || card.col1 < n.col0);
  const cardSpan = card => card.m ? [card.m.c0, card.m.c1] : [card.c, card.c];
  // an arrow blocks a vertical merge only if it sits in the SAME column span
  const arrowInSpan = (row, c0, c1) => arrows.some(a => a.r === row && a.c >= c0 && a.c <= c1);
  for (const card of sorted) {
    const [c0, c1] = cardSpan(card);
    card.c0 = c0; card.c1 = c1;
    // find nearest existing node directly above (max endR) that overlaps and no arrow between
    let target = null;
    for (const n of nodes) {
      if (n.endR === card.r - 1 && !arrowInSpan(card.r - 1, c0, c1) && overlaps(n, card)) {
        if (!target || n.endR > target.endR) target = n;
      }
    }
    if (target) {
      target.texts.push(card.text);
      target.text = target.texts.join("\n\n");
      target.endR = card.r;
      target.line = target.line.replace(/\s+$/, "") + "\n" + card.text.split("\n").slice(0, 8).join(" ");
      continue;
    }
    const node = {
      id: card.id,
      r: card.r, c: card.c, endR: card.r,
      texts: [card.text],
      text: card.text,
      line: card.text.split("\n").slice(0, 8).join(" "),
      col0: c0, col1: c1,
    };
    nodes.push(node);
  }
  return nodes;
}

// ── Step 3: connect nodes into a tree using arrow geometry ───────────────────
// For each arrow: parent = nearest node whose endR < arrow.r (prefer one whose
// column span contains arrow.c); child = node whose r > arrow.r whose column
// span contains arrow.c (prefer), else nearest center.
export function buildTree(nodes, arrows) {
  const colCenter = n => (n.col0 + n.col1) / 2;
  const contains = (n, c) => c >= n.col0 && c <= n.col1;
  for (const ar of arrows) {
    let parent = null, pkey = null;
    let cnode = null, ckey = null;
    for (const n of nodes) {
      if (n.endR < ar.r) {
        const cont = contains(n, ar.c) ? 0 : 1;
        const k2 = ar.r - n.endR, k3 = Math.abs(colCenter(n) - ar.c);
        const key = [cont, k2, k3];
        if (pkey === null || key[0] < pkey[0] || (key[0] === pkey[0] && (key[1] < pkey[1] || (key[1] === pkey[1] && key[2] < pkey[2])))) { pkey = key; parent = n; }
      }
      if (n.r > ar.r) {
        const cont = contains(n, ar.c) ? 0 : 1;
        const k2 = n.r - ar.r, k3 = Math.abs(colCenter(n) - ar.c);
        const key = [cont, k2, k3];
        if (ckey === null || key[0] < ckey[0] || (key[0] === ckey[0] && (key[1] < ckey[1] || (key[1] === ckey[1] && key[2] < ckey[2])))) { ckey = key; cnode = n; }
      }
    }
    if (parent && cnode && parent !== cnode) {
      if (!parent.children) parent.children = [];
      if (!parent.children.includes(cnode)) parent.children.push(cnode);
    }
  }
  return nodes;
}

export function findRoot(nodes) {
  const childIds = new Set();
  for (const n of nodes) for (const ch of (n.children || [])) childIds.add(ch.id);
  return nodes.filter(n => !childIds.has(n.id)).sort((a, b) => a.r - b.r)[0] || null;
}
