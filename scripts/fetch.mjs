// scripts/fetch.mjs
// Server-side fetcher + parser. Reads the Google Sheet via the public HTML export
// (which preserves FULL cell values, unlike the gviz JSON endpoint which truncates
// long cells at ~220 chars).
// Emits a JSON data model. Runs in GitHub Actions every 15 min.
// No credentials needed (link-shared sheet).
import XLSX from "xlsx";
import { parseSheetHtml } from "./html-fetch.mjs";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID || "1HZtIq4jt4EHrw2Ord3yqXkdLOHN7h-EDJYK7SbyeQKY";
const ARROW = "\u2b07";

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";
const clean = v => String(v ?? "").replace(/^"|"$/g, "").replace(/\t/g, " ").replace(/[ \t]+/g, " ").trim();
const isArrow = t => t.includes(ARROW);

/** Fetch the HTML export of the sheet. */
async function fetchSheetHtml() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?output=html`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Call-Team-IVR-Builder/1.0" },
  });
  if (!res.ok) throw new Error(`HTML export HTTP ${res.status}`);
  return await res.text();
}

/** Fetch the gviz JSON for a given sheet name. Returns parsed table object. */
export async function fetchGviz(sheetName) {
  const params = new URLSearchParams({ tqx: "out:json" });
  if (sheetName) params.set("sheet", sheetName);
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "Call-Team-IVR-Builder/1.0" } });
  if (!res.ok) throw new Error(`gviz fetch HTTP ${res.status} for sheet '${sheetName}'`);
  const cb = "google.visualization.Query.setResponse(";
  let text = (await res.text()).trim();
  const idx = text.indexOf(cb);
  if (idx < 0) throw new Error("gviz response missing setResponse wrapper");
  let jsonStr = text.slice(idx + cb.length);
  if (jsonStr.endsWith(");")) jsonStr = jsonStr.slice(0, -2);
  if (jsonStr.startsWith("(")) jsonStr = jsonStr.slice(1);
  return JSON.parse(jsonStr);
}

/** Discover all sheet tab names via the xlsx export (sheet names are reliable there). */
async function discoverSheetNames() {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, {
    redirect: "follow", headers: { "User-Agent": "Call-Team-IVR-Builder/1.0" },
  });
  if (!res.ok) throw new Error(`xlsx export HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  return wb.SheetNames;
}

/** Fetch all sheets from the Google Sheet via HTML export.
 *  Returns { sheetName: { cards, arrows, merges } }.
 *  Falls back to gviz JSON if HTML export fails.
 */
export async function fetchTabData() {
  const sheetNames = await discoverSheetNames();
  const tabs = {};

  // Fetch the full HTML once and split by <h1> sheet tab headers
  let fullHtml = "";
  try {
    fullHtml = await fetchSheetHtml();
  } catch (e) {
    console.warn("HTML export failed, falling back to gviz JSON:", e.message);
    return await fetchTabDataGviz(sheetNames);
  }

  // Split the HTML by sheet tab headers. Each sheet starts with <h1>SheetName</h1>
  // or <h2>SheetName</h2> followed by its own <table>.
  const sheetSections = splitHtmlBySheet(fullHtml);

  for (const name of sheetNames) {
    const section = sheetSections[name] || fullHtml;
    try {
      const parsed = parseSheetHtml(section, name);
      if (parsed.cards.length > 0) tabs[name] = parsed;
      else console.warn(`Sheet '${name}' had no cards in HTML`);
    } catch (e) {
      console.warn(`HTML parse failed for '${name}', trying gviz:`, e.message);
      try {
        const data = await fetchGviz(name);
        if (data && data.table) tabs[name] = gvizToTabData(data.table, name);
      } catch (ge) {
        console.warn(`Skipping sheet '${name}': ${ge.message}`);
      }
    }
  }

  // If no sheets had data, try gviz as fallback
  if (Object.keys(tabs).length === 0) {
    for (const name of sheetNames) {
      try {
        const data = await fetchGviz(name);
        if (data && data.table) tabs[name] = gvizToTabData(data.table, name);
      } catch (e) { /* already warned */ }
    }
  }

  return tabs;
}

/** Fallback: fetch all sheets via gviz JSON (truncates long cells). */
async function fetchTabDataGviz(sheetNames) {
  const tabs = {};
  if (sheetNames.length === 0) {
    try {
      const data = await fetchGviz();
      if (data && data.table) tabs[data.table.label || "Sheet1"] = gvizToTabData(data.table, "Sheet1");
    } catch (e) {
      throw new Error("Failed to fetch any sheet data: " + e.message);
    }
  } else {
    for (const name of sheetNames) {
      try {
        const data = await fetchGviz(name);
        if (data && data.table) tabs[name] = gvizToTabData(data.table, name);
      } catch (e) {
        console.warn(`Skipping sheet '${name}': ${e.message}`);
      }
    }
  }
  return tabs;
}

/** Split the full HTML export into per-sheet sections.
 *  The HTML export contains all sheet tabs, each preceded by a header.
 *  We look for table boundaries to isolate each sheet's data.
 */
function splitHtmlBySheet(html) {
  const result = {};
  // The HTML export format: each sheet has a heading with the sheet name,
  // then a <table> with the data. Find all <h1>/<h2> elements that contain
  // sheet names and the tables that follow them.
  const headingRe = /<(?:h1|h2)[^>]*>([^<]+)<\/(?:h1|h2)>/gi;
  let lastSheetName = "";
  let lastHeadingEnd = 0;

  // Split by headings
  const segments = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    if (lastSheetName) {
      segments.push({ name: lastSheetName, start: lastHeadingEnd, end: m.index });
    }
    lastSheetName = m[1].trim();
    lastHeadingEnd = m.index + m[0].length;
  }
  if (lastSheetName) {
    segments.push({ name: lastSheetName, start: lastHeadingEnd, end: html.length });
  }

  // If we couldn't split by headings, treat the whole HTML as one sheet
  if (segments.length === 0) {
    return result;
  }

  // For each segment, find the <table> within it
  for (const seg of segments) {
    const segHtml = html.slice(seg.start, seg.end);
    const tableStart = segHtml.indexOf("<table");
    if (tableStart >= 0) {
      const beforeTable = segHtml.slice(0, tableStart);
      const tableEnd = segHtml.indexOf("</table>", tableStart);
      const tableHtml = tableEnd >= 0 ? segHtml.slice(tableStart, tableEnd + 8) : segHtml.slice(tableStart);
      // Wrap the table in a simple HTML document for JSDOM
      result[seg.name] = `<html><body>${tableHtml}</body></html>`;
    }
  }

  return result;
}

/** Convert gviz table data into card/arrow structure (same shape as collectCells output). */
function gvizToTabData(table, name) {
  const cols = table.cols.length;
  const cards = []; const arrows = [];
  for (let r = 0; r < table.rows.length; r++) {
    const cells = table.rows[r].c;
    for (let c = 0; c < cols; c++) {
      const cell = cells[c];
      if (!cell || cell.v == null) continue;
      const txt = clean(cell.v);
      if (!txt) continue;
      if (isArrow(txt)) { arrows.push({ r, c }); continue; }
      cards.push({ r, c, text: txt, m: null, id: `${slug(name)}_r${r}c${c}` });
    }
  }
  return { cards, arrows, merges: [] };
}

/** Legacy: fetch xlsx buffer (for backward compat with collectCells). */
export async function fetchBucket() {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, {
    redirect: "follow", headers: { "User-Agent": "Call-Team-IVR-Builder/1.0" },
  });
  if (!res.ok) throw new Error(`Sheet export HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Step 1 (legacy): raw cards from XLSX workbook ──────────────────────────
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
export function buildNodes(cards, arrows) {
  const sorted = [...cards].sort((a, b) => a.r - b.r || a.c - b.c);
  const nodes = [];
  const overlaps = (n, card) => !(n.col1 < card.c0 || card.c1 < n.col0);
  const cardSpan = card => card.m ? [card.m.c0, card.m.c1] : [card.c, card.c];
  const arrowInSpan = (row, c0, c1) => arrows.some(a => a.r === row && a.c >= c0 && a.c <= c1);
  for (const card of sorted) {
    const [c0, c1] = cardSpan(card);
    card.c0 = c0; card.c1 = c1;
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
    nodes.push({
      id: card.id,
      r: card.r, c: card.c, endR: card.r,
      texts: [card.text],
      text: card.text,
      line: card.text.split("\n").slice(0, 8).join(" "),
      col0: c0, col1: c1,
    });
  }
  return nodes;
}

// ── Step 3: connect nodes into a tree using arrow geometry ───────────────────
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
