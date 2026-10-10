// scripts/html-fetch.mjs
// Parse the public HTML export of the sheet to get FULL cell values.
// The gviz JSON endpoint truncates long cells (Google caps at ~220 chars),
// but the HTML export contains the complete text with <br> line breaks and
// colspan/rowspan attributes for merged cells.
// Returns { cards, arrows, merges } — same shape as gvizToTabData() output
// in fetch.mjs, so it's a drop-in replacement.
import { JSDOM } from "jsdom";

const ARROW = "\u2b07";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";

// minimal HTML entity decoder
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", copy: "\u00a9", reg: "\u00ae" };
function decode(s) {
  return s.replace(/&([a-zA-Z#0-9]+);/g, (_, e) => {
    if (e.startsWith("#")) return String.fromCharCode(parseInt(e.slice(1)));
    return ENT[e.toLowerCase()] || `&${e};`;
  });
}

// Extract text from a <td> node, preserving <br> as newlines and <p> as double-newlines.
function textOf(node) {
  // Get innerHTML and process <br> and <p> tags to preserve line structure
  let html = node.innerHTML || "";
  // Replace <br> with newline
  html = html.replace(/<br\s*\/?>/gi, "\n");
  // Replace </p> with newline (paragraphs act as line breaks)
  html = html.replace(/<\/p>/gi, "\n");
  // Strip all remaining tags
  html = html.replace(/<[^>]+>/g, "");
  // Decode entities
  html = decode(html);
  // Normalize blank lines
  html = html.replace(/\n\s*\n+/g, "\n\n").trim();
  return html;
}

/** Parse the public HTML export of a Google Sheet tab.
 *  @param {string} html  — the full HTML document text
 *  @param {string} sheetName  — name of the sheet tab
 *  @returns {{ cards: Array, arrows: Array, merges: Array, grid: Array, maxCols: number }}
 */
export function parseSheetHtml(html, sheetName) {
  const dom = new JSDOM(html, { url: "https://docs.google.com/spreadsheets/" });
  const doc = dom.window.document;

  // Pick the largest table (the data one; skip tiny UI tables)
  const tables = Array.from(doc.querySelectorAll("table"));
  if (!tables.length) throw new Error("No tables found in sheet HTML");
  let best = tables[0];
  for (const t of tables) {
    const cells = t.querySelectorAll("td");
    if (cells.length > best.querySelectorAll("td").length) best = t;
  }

  const rows = Array.from(best.querySelectorAll("tr"));
  if (!rows.length) return { cards: [], arrows: [], merges: [], grid: [], maxCols: 0 };

  const cards = [];
  const arrows = [];
  const grid = [];
  let maxCols = 0;

  // Track rowspan cells bleeding into subsequent rows
  // key: logical col -> { cell, remaining }
  const rowspanMap = new Map();

  for (let ri = 0; ri < rows.length; ri++) {
    const tds = Array.from(rows[ri].querySelectorAll("td"));
    if (!tds.length) { grid.push([]); continue; }

    const rowCells = new Array(maxCols || 0).fill(null);
    let ci = 0;  // logical column index (after accounting for rowspan bleed)

    for (const td of tds) {
      // Skip columns occupied by rowspan from above
      while (rowspanMap.has(ci)) {
        const rs = rowspanMap.get(ci);
        if (rs.remaining > 0) {
          rowCells[ci] = rs.cell;
          rs.remaining--;
          if (rs.remaining === 0) rowspanMap.delete(ci);
        }
        ci++;
      }

      const colspan = parseInt(td.getAttribute("colspan") || "1");
      const rowspan = parseInt(td.getAttribute("rowspan") || "1");
      const c0 = ci;
      const c1 = ci + colspan - 1;
      const text = textOf(td);
      const cell = { row: ri, col: c0, text, sheet: sheetName, colspan, rowspan };

      // Fill rowCells for all spanned columns
      for (let c = c0; c <= c1; c++) {
        rowCells[c] = cell;
      }

      if (text) {
        if (text.includes(ARROW)) {
          arrows.push({ r: ri, c: c0 });
        } else {
          const card = {
            r: ri,
            c: c0,
            text,
            m: (colspan > 1 || rowspan > 1) ? { r0: ri, c0, r1: ri + rowspan - 1, c1 } : null,
            id: `${slug(sheetName)}_r${ri}c${c0}`,
          };
          cards.push(card);
        }
      }

      // Register rowspan cells for future rows
      if (rowspan > 1) {
        for (let c = c0; c <= c1; c++) {
          rowspanMap.set(c, { cell, remaining: rowspan - 1 });
        }
      }

      ci += colspan;
    }

    // Process trailing rowspan cells
    while (rowspanMap.has(ci)) {
      const rs = rowspanMap.get(ci);
      if (rs.remaining > 0) {
        rowCells[ci] = rs.cell;
        rs.remaining--;
        if (rs.remaining === 0) rowspanMap.delete(ci);
      }
      ci++;
    }

    while (rowCells.length < maxCols) rowCells.push(null);
    grid.push(rowCells);
    maxCols = Math.max(maxCols, rowCells.length);
  }

  // Build merges list from cards that had colspan/rowspan
  const merges = [];
  for (const card of cards) {
    if (card.m && (card.m.c0 !== card.m.c1 || card.m.r0 !== card.m.r1)) {
      merges.push({ r0: card.m.r0, c0: card.m.c0, r1: card.m.r1, c1: card.m.c1 });
    }
  }

  // Merge short label cards (like "IVR LINE", "Audio Message") with their adjacent body cells.
  // In the HTML export, a label cell (e.g. colspan="13") sits next to the body cell (e.g. colspan="28")
  // in the same row, possibly with several empty/blank columns in between.
  // We merge the body text into the label card so buildNodes can use it.
  const shortLabels = ["IVR LINE", "Audio Message", "WAITING EXPERIENCE", "KEY 1", "KEY 2", "NO OR WRONG INPUT"];
  for (const card of cards) {
    if (!card.text || card.text.length > 30) continue;
    if (!shortLabels.includes(card.text)) continue;
    const row = grid[card.r];
    if (!row) continue;
    // Search up to 30 columns to the right for a large body cell
    let bestNeighbor = null;
    for (let c = card.c + 1; c < Math.min(card.c + 31, row.length); c++) {
      const neighbor = row[c];
      if (!neighbor || !neighbor.text || neighbor.text.length < 60) continue;
      if (neighbor.text.includes(ARROW)) continue;
      if (neighbor.text === card.text) continue;
      // Skip cells that are themselves labels
      if (shortLabels.includes(neighbor.text)) continue;
      // Pick the longest matching body cell (handles cases where multiple body cells exist)
      if (!bestNeighbor || neighbor.text.length > bestNeighbor.text.length) {
        bestNeighbor = neighbor;
      }
    }
    if (bestNeighbor) {
      card.text = card.text + "\n\n" + bestNeighbor.text;
    }
  }

  return { cards, arrows, grid, maxCols, merges };
}
