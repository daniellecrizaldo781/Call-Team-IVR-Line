// scripts/build.mjs
// Entry: fetch source -> parse -> emit public/data.json (graph data model).
//
// Data source:
//   - If CANVA_DESIGN_DATA env var is set, use Canva design text (parsed
//     via canva-fetch.mjs into the same card/arrow structure).
//   - Otherwise, fetch the Google Sheet via HTML export (fallback).
//
// Run in GitHub Actions every 15 min. No credentials needed (link-shared
// sheet or repo secret for Canva data).
import fs from "fs";
import path from "path";
import { fetchTabData, buildNodes } from "./fetch.mjs";

const OUT = process.env.OUTPUT_FILE || path.resolve("public/data.json");
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";

// ── type inference ───────────────────────────────────────────────────────────
export function inferType(node) {
  const t = node.text || "";
  const head = (node.texts?.[0] || "").trim();
  if (/(no or wrong input|no\/wrong|invalid|unrecognized|timeout|default)/i.test(head)) return "fallback";
  if (/(business hour|opening|closed|monday - sunday|available)/i.test(t)) return "info";
  if (/(agent queue|sales agent queue|masters agent queue|queue)/i.test(head)) return "transfer";
  if (/busy|unfortunately|email|support@/i.test(t)) return "endpoint";
  if (/(waiting experience|ringing)/i.test(head)) return "info";
  if (/(thank you for calling|welcome|greeting)/i.test(t) && /press \d/i.test(t)) return "greeting";
  if (/press \d/i.test(t)) return "menu";
  if (/(repeat|stay on the line)/i.test(t)) return "repeat";
  if (/transfer|representative|speak with an agent/i.test(t)) return "service";
  if (/audio message|ivr line/i.test(head)) return "message";
  if (/^key\s*\d/i.test(head)) return "option";
  return "message";
}

// ── options: "Press N ..." / "KEY N (label)" ────────────────────────────────
export function extractOptions(node) {
  const opts = [];
  const seen = new Set();
  // In the sheet, descriptions come BEFORE the press number:
  // e.g. "To learn about hearing loss solutions, Press 1"
  // Capture: (description) Press (number)
  const re = /(.+?)\s*,?\s*(?:press|push)\s+#?(\d+)\b/gi;
  let m;
  while ((m = re.exec(node.text)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    let label = (m[1] || "").trim().replace(/[.,;]+$/, "");
    if (!label) label = `Press ${m[2]}`;
    opts.push({ key: m[2], label });
  }
  const hm = /^key\s*#?(\d+)\s*\(?(.{1,45}?)\)?[:\-]?\s*$/i.exec((node.texts?.[0] || "").trim());
  if (hm && opts.length === 0) opts.push({ key: hm[1], label: (hm[2] || "").trim() || "Option " + hm[1] });
  return opts;
}

// ── build edges (parent,child) from arrow geometry ──────────────────────────
export function buildEdges(nodes, arrows) {
  const colCenter = n => (n.col0 + n.col1) / 2;
  const contains = (n, c) => c >= n.col0 && c <= n.col1;
  const overlaps = (a, b) => a.col0 <= b.col1 && b.col0 <= a.col1;
  const edges = [];
  for (const ar of arrows) {
    let parent = null, pk = null, cn = null, ck = null;
    for (const n of nodes) {
      if (n.endR < ar.r) {
        const k = [contains(n, ar.c) ? 0 : 1, ar.r - n.endR, Math.abs(colCenter(n) - ar.c)];
        if (pk === null || k[0] < pk[0] || (k[0] === pk[0] && (k[1] < pk[1] || (k[1] === pk[1] && k[2] < pk[2])))) { pk = k; parent = n; }
      }
      if (n.r > ar.r) {
        const k = [contains(n, ar.c) ? 0 : 1, n.r - ar.r, Math.abs(colCenter(n) - ar.c)];
        if (ck === null || k[0] < ck[0] || (k[0] === ck[0] && (k[1] < ck[1] || (k[1] === ck[1] && k[2] < ck[2])))) { ck = k; cn = n; }
      }
    }
    if (parent && cn && parent.id !== cn.id) edges.push([parent.id, cn.id]);
  }
  // Fill gaps: connect orphaned non-root nodes to nearest column-overlapping ancestor above
  const edgeSet = new Set(edges.map(e => e.join(">")));
  const childIds = new Set(edges.map(e => e[1]));
  for (const n of nodes) {
    if (childIds.has(n.id)) continue;
    // Node has no parent — find closest ancestor above with column overlap
    let best = null;
    for (const cand of nodes) {
      if (cand.endR < n.r && overlaps(cand, n) && cand.id !== n.id) {
        if (best === null || cand.endR > best.endR || (cand.endR === best.endR && Math.abs(colCenter(cand) - colCenter(n)) < Math.abs(colCenter(best) - colCenter(n)))) {
          best = cand;
        }
      }
    }
    if (best) {
      const k = best.id + ">" + n.id;
      if (!edgeSet.has(k)) { edgeSet.add(k); edges.push([best.id, n.id]); }
    }
  }
  const seen = new Set();
  return edges.filter(e => { const k = e.join(">"); if (seen.has(k)) return false; seen.add(k); return true; });
}

function buildTabModel(name, cards, arrows) {
  const nodes = buildNodes(cards, arrows);
  const edges = buildEdges(nodes, arrows);
  const clean = raw => ({
    id: raw.id,
    type: inferType(raw),
    title: (raw.texts?.[0] || raw.line).split("\n")[0].trim(),
    body: raw.text,
    row: raw.r, col: raw.col0, colSpan: raw.col1 - raw.col0 + 1,
    options: extractOptions(raw),
  });
  const ordered = nodes.map(raw => clean(raw));
  const edgeList = edges.map(([p, c]) => ({ from: p, to: c }));
  const roots = nodes.filter(n => !edges.some(e => e[1] === n.id)).map(n => n.id);
  return {
    brand: name, slug: slug(name),
    nodeCount: ordered.length, edgeCount: edgeList.length,
    roots: roots.length ? roots : (ordered.length ? [ordered[0].id] : []),
    nodes: ordered, edges: edgeList,
  };
}

export async function buildModel() {
  // Check if Canva data is available (from repo secret)
  if (process.env.CANVA_DESIGN_DATA) {
    console.log("Using Canva design data as source…");
    const { parseCanvaText } = await import("./canva-fetch.mjs");
    const { cards, arrows, merges } = parseCanvaText(process.env.CANVA_DESIGN_DATA);
    if (cards.length === 0) throw new Error("Canva parser produced no cards");
    return [buildTabModel("Oricle Hearing Aid", cards, arrows)];
  }

  // Default: fetch Google Sheet
  console.log("Fetching Google Sheet…");
  const tabs = await fetchTabData();
  const brands = Object.entries(tabs)
    .filter(([, t]) => t.cards.length > 0)
    .map(([name, t]) => buildTabModel(name, t.cards, t.arrows));
  if (!brands.length) throw new Error("No tabs contained any data");
  return brands;
}

export async function build() {
  const brands = await buildModel();
  const data = {
    generatedAt: new Date().toISOString(),
    sourceSheet: process.env.CANVA_DESIGN_DATA ? "Canva design (CANVA_DESIGN_DATA secret)" : (process.env.GOOGLE_SHEETS_ID || ""),
    brandCount: brands.length,
    brands: brands.map(b => ({ brand: b.brand, slug: b.slug, nodeCount: b.nodeCount, edgeCount: b.edgeCount })),
    full: brands,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf-8");
  const totalNodes = brands.reduce((a, b) => a + b.nodeCount, 0);
  console.log(`✓ Wrote ${OUT}`);
  console.log(`  brands: ${brands.length} (${brands.map(b => b.brand).join(", ")})`);
  console.log(`  nodes: ${totalNodes}, edges: ${brands.reduce((a, b) => a + b.edgeCount, 0)}`);
  return data;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  build().catch(e => { console.error("Build failed:", e.message); process.exit(1); });
}
