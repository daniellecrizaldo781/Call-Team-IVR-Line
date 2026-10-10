// scripts/canva-fetch.mjs
// Parse the Canva design text (stored in repo secret CANVA_DESIGN_DATA)
// into the same { cards, arrows } structure used by the existing build
// pipeline.  Replaces the Google Sheet HTML-export fetch.
//
// The Canva design mirrors the Google Sheet IVR layout.  The exported
// text is sequential, not grid-based.  We parse it into message blocks,
// then map each block to its known grid position using the IVR tree
// structure.  The grid positions and arrows match the original sheet
// layout exactly, so the existing buildNodes/buildEdges pipeline works
// unchanged.
const ARROW = "\u2b07";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";
const BRAND_SLUG = "oricle-hearing-aid";

// ── Tokenizer ──────────────────────────────────────────────────────────────

/**
 * Clean the raw Canva text and split into blocks.
 */
function tokenize(rawText) {
  const cleaned = rawText
    .replace(/^\s*Canva\s*$/gm, "")
    .replace(/^\s*Share\s*$/gm, "")
    .replace(/^\s*Create with Canva\s*$/gm, "")
    .replace(/^\s*\u21bb\s*Previous page\s*$/gm, "")
    .replace(/^\s*Go to page\s*$/gm, "")
    .replace(/^\s*Next page\s*$/gm, "")
    .replace(/^\s*Zoom in and out\s*$/gm, "")
    .replace(/^\s*More\s*$/gm, "")
    .replace(/^\s*Enter full screen\s*$/gm, "")
    .replace(/^\s*\d+\s*$/gm, "")
    .replace(/^\s*\/\s*$/gm, "")
    .replace(/^\s*AAAAA\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const blocks = cleaned.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);

  // Filter out pure UI blocks
  return blocks.filter(b => {
    const text = b.trim();
    if (text === "Canva") return false;
    if (text.includes("(opens in a new tab or window)")) return false;
    return true;
  });
}

// ── Block extraction helpers ────────────────────────────────────────────────

/** Split a block into { title, body }. */
function splitBlock(block) {
  const lines = block.split("\n");
  const title = lines[0].trim();
  const body = lines.slice(1).join("\n").trim() || null;
  return { title, body, full: block };
}

/** Index blocks by first line (normalized). */
function indexBlocks(blocks) {
  const idx = new Map();
  for (const block of blocks) {
    const { title } = splitBlock(block);
    const key = title.toLowerCase().trim();
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(splitBlock(block));
  }
  return idx;
}

/** Find blocks matching a title, optionally filtered. */
function findBlocks(idx, title, filter) {
  const key = title.toLowerCase().trim();
  const candidates = idx.get(key) || [];
  if (filter) return candidates.filter(filter);
  return candidates;
}

/** Find first matching block. */
function findBlock(idx, title, filter) {
  return findBlocks(idx, title, filter)[0];
}

// ── Node definition table ────────────────────────────────────────────────────
// Each entry maps a known grid position to a Canva block lookup.
// The grid positions (r, c, span) mirror the original Google Sheet.
// The `lookup` function receives the block index and returns the body text.

const NODE_DEFS = [
  // ── Main trunk ──
  { r: 1,  c: 12, span: 1,  title: "Call Comes In",            body: () => null },
  { r: 3,  c: 12, span: 1,  title: "BUSINESS HOURS",             body: () => "Monday - Sunday\n5AM - 9PM PST" },
  { r: 6,  c: 8,  span: 9,  title: "STANDARD IVR",
    body: (idx) => findBlock(idx, "STANDARD IVR", b => b.full.includes("For quality assurance"))?.body || null },

  // ── STANDARD IVR children (left, r9) ──
  { r: 9,  c: 29, span: 1, title: "Key 2 (Audiologist Consultation)",
    body: (idx) => findBlock(idx, "KEY 2 (Audiologist Consultation)", b => b.full.includes("At Oricle Hearing"))?.body || null },
  { r: 9,  c: 30, span: 1, title: "Key 3 (Subscription Cancellation)",
    body: (idx) => findBlock(idx, "KEY 3 (Subscription Cancellation)", b => b.full.includes("subscription cancellation"))?.body || null },
  { r: 9,  c: 31, span: 1, title: "Key 4 (Sales)",
    body: (idx) => findBlock(idx, "KEY 4 (Sales)", b => b.full.includes("OHA Sales"))?.body || null },
  { r: 9,  c: 32, span: 1, title: "Key 5 (Return)",
    body: (idx) => findBlock(idx, "KEY 5 (Return)", b => b.full.includes("Waiting Experience") || b.full.includes("OHA SALES"))?.body || null },
  { r: 9,  c: 33, span: 1, title: "Key 6(OtherConcerns)",
    body: (idx) => findBlock(idx, "KEY 6 (Other Concerns)", b => b.full.includes("Waiting Experience") || b.full.includes("OHA SALES"))?.body || null },
  { r: 9,  c: 35, span: 34, title: "Key 7 (Repeat Message)",
    body: (idx) => findBlock(idx, "KEY 7 (Repeat Entire IVR)")?.body || null },

  // ── KEY 1 (INQUIRY) left subtree (r10c0) ──
  { r: 10, c: 0,  span: 28, title: "KEY 1 (INQUIRY)",
    body: (idx) => findBlocks(idx, "KEY 1 (INQUIRY)")[0]?.body || null },

  // ── Right-side STANDARD IVR (under Key 7, r11c43) ──
  { r: 11, c: 43, span: 9, title: "STANDARD IVR",
    body: (idx) => {
      const blocks = findBlocks(idx, "STANDARD IVR");
      // The second occurrence (after KEY 7)
      return blocks[1]?.body || null;
    } },

  // ── Right-side KEY 1 (INQUIRY) at r15c35 ──
  { r: 15, c: 35, span: 28, title: "KEY 1 (INQUIRY)",
    body: (idx) => {
      const blocks = findBlocks(idx, "KEY 1 (INQUIRY)");
      return blocks[1]?.body || blocks[0]?.body || null;
    } },

  // ── KEY 1 (INQUIRY) children: KEY 1-5 + NO OR WRONG (left, r14) ──
  { r: 14, c: 0,  span: 3,  title: "KEY 1",
    body: (idx) => findBlock(idx, "KEY 1", b => b.full.includes("tinutitis") && b.body?.includes("mild to moderate") && !b.full.includes("US-based"))?.body || null },
  { r: 14, c: 4,  span: 3,  title: "KEY 2",
    body: (idx) => findBlock(idx, "KEY 2", b => b.full.includes("Each hearing aid") && !b.full.includes("Bluetooth"))?.body || null },
  { r: 14, c: 8,  span: 3,  title: "KEY 3",
    body: (idx) => findBlock(idx, "KEY 3", b => b.full.includes("Bluetooth connectivity") && !b.full.includes("US-based"))?.body || null },
  { r: 14, c: 12, span: 13, title: "KEY 4",
    body: (idx) => findBlock(idx, "KEY 4", b => b.full.includes("shipping") || b.full.includes("physical store") || b.full.includes("product is made"))?.body || null },
  { r: 14, c: 26, span: 1,  title: "KEY 5",
    body: (idx) => findBlock(idx, "KEY 5", b => b.full.includes("appreciate your interest"))?.body || null },
  { r: 14, c: 27, span: 1,  title: "NO OR WRONG INPUT",
    body: (idx) => "Hello, unfortunately, all agents are busy assisting other customers. Please email support@oriclehearing.com to resolve your issue most promptly, that is\nsupport @ o r i c l e h e a r i n g dot com. Thank you!" },

  // ── KEY 4 → IVR LINE (left, r16c12) ──
  { r: 16, c: 12, span: 13, title: "IVR LINE",
    body: (idx) => findBlock(idx, "IVR LINE", b => b.full.includes("tinutitis") || b.full.includes("mild to moderate"))?.body || null },

  // ── Audio Message + STANDARD IVR + WAITING + OHA under left KEY 1 children ──
  { r: 16, c: 0,  span: 3,  title: "AUDIO MESSAGE",
    body: (idx) => findBlock(idx, "AUDIO MESSAGE", b => b.full.includes("press 1") && b.full.includes("stay on the line") && !b.full.includes("Each hearing"))?.body || null },
  { r: 16, c: 4,  span: 3,  title: "AUDIO MESSAGE",
    body: (idx) => findBlock(idx, "AUDIO MESSAGE", b => b.full.includes("Each hearing"))?.body || null },
  { r: 16, c: 8,  span: 3,  title: "AUDIO MESSAGE",
    body: (idx) => findBlock(idx, "AUDIO MESSAGE", b => b.full.includes("Bluetooth connectivity"))?.body || null },

  // ─── STANDARD IVR under KEY 1 (left, r17c0) ──
  { r: 17, c: 0,  span: 3,  title: "STANDARD IVR",
    body: (idx) => findBlock(idx, "STANDARD IVR", b => b.full.includes("If you would like to speak with an agent"))?.body || null },

  // ─── WAITING EXPERIENCE + OHA MASTERS (left, r18c0+) ──
  { r: 18, c: 0,  span: 1,  title: "WAITING EXPERIENCE" },
  { r: 18, c: 4,  span: 1,  title: "OHA MASTERS AGENTS QUEUE" },
  { r: 18, c: 8,  span: 1,  title: "OHA MASTERS AGENTS QUEUE" },
  { r: 18, c: 12, span: 1,  title: "OHA MASTERS AGENTS QUEUE" },

  // ─── KEY 1/2 + NO OR WRONG under IVR LINE children (left) ──
  // IVR LINE children: KEY 1/2/3 + NO OR WRONG at r21
  { r: 21, c: 12, span: 3, title: "KEY 1",
    body: (idx) => findBlock(idx, "KEY 1", b => b.full.includes("US-based company"))?.body || null },
  { r: 21, c: 16, span: 3, title: "KEY 2",
    body: (idx) => findBlock(idx, "KEY 2", b => b.full.includes("appreciate your interest"))?.body || null },
  { r: 21, c: 20, span: 3, title: "KEY 3",
    body: (idx) => findBlock(idx, "KEY 3", b => b.full.includes("Bluetooth connectivity") && !b.full.includes("tinutitis"))?.body || null },
  { r: 21, c: 24, span: 1, title: "NO OR WRONG INPUT" },

  // ─── Right-side KEY 1 (INQUIRY) children (r19) ──
  { r: 19, c: 35, span: 1, title: "KEY 1",
    body: (idx) => findBlock(idx, "KEY 1", b => b.full.includes("tinutitis") && b.body?.includes("mild to moderate") && b.full.includes("US-based") === false && b.full.indexOf("tinutitis") > 0 && b.body?.length > 100)?.body || null },
  { r: 19, c: 39, span: 1, title: "KEY 2",
    body: (idx) => findBlock(idx, "KEY 2", b => b.full.includes("Each hearing aid") && b.full.indexOf("Each hearing aid") > 0)?.body || null },
  { r: 19, c: 43, span: 1, title: "KEY 3",
    body: (idx) => findBlock(idx, "KEY 3", b => b.full.includes("Bluetooth") && b.full.includes("not have Bluetooth"))?.body || null },
  { r: 19, c: 47, span: 1, title: "KEY 4",
    body: (idx) => findBlock(idx, "KEY 4", b => b.full.includes("shipping") && b.full.indexOf("shipping") > 0)?.body || null },
  { r: 19, c: 61, span: 1, title: "KEY 5",
    body: (idx) => findBlock(idx, "KEY 5", b => b.full.includes("Waiting Experience") && b.full.includes("OHA SALES"))?.body || null },
  { r: 19, c: 62, span: 1, title: "NO OR WRONG INPUT" },

  // ─── Right IVR LINE (under KEY 4 at r19c47, at r21c47) ──
  { r: 21, c: 47, span: 1, title: "IVR LINE",
    body: (idx) => findBlock(idx, "IVR LINE", b => b.full.includes("US-based") || b.full.includes("shipping"))?.body || null },

  // ─── Audio Message + body text under right-side nodes ──
  { r: 16, c: 35, span: 1, title: "AUDIO MESSAGE",
    body: (idx) => findBlock(idx, "AUDIO MESSAGE", b => b.full.includes("press 1") && !b.full.includes("stay on the line"))?.body || null },

  // ─── IVR LINE children (right, r26) ──
  { r: 26, c: 47, span: 3, title: "KEY 1",
    body: (idx) => findBlock(idx, "KEY 1", b => b.full.includes("US-based") && b.full.indexOf("US-based") > 0)?.body || null },
  { r: 26, c: 51, span: 3, title: "KEY 2",
    body: (idx) => findBlock(idx, "KEY 2", b => b.full.includes("appreciate") && b.full.indexOf("appreciate") > 0)?.body || null },
  { r: 26, c: 55, span: 3, title: "KEY 3",
    body: (idx) => findBlock(idx, "KEY 3", b => b.full.includes("Bluetooth"))?.body || null },
  { r: 26, c: 59, span: 1, title: "NO OR WRONG INPUT" },

  // ─── Right-side waiting experience nodes ──
  { r: 23, c: 47, span: 3, title: "OHA MASTERS AGENTS QUEUE" },
  { r: 23, c: 51, span: 3, title: "OHA MASTERS AGENTS QUEUE" },
  { r: 23, c: 55, span: 3, title: "OHA MASTERS AGENTS QUEUE" },
  { r: 23, c: 59, span: 1, title: "OHA MASTERS AGENTS QUEUE" },
];

// ── Known arrows (same as Google Sheet grid layout) ──────────────────────────
// These positions are derived from the existing data.json which builds
// the correct tree from the sheet.  The Canva design has the same structure.
const ARROWS = [
  // Main trunk
  { r: 2, c: 12 },                                     // Call Comes In → BUSINESS HOURS
  { r: 5, c: 12 },                                     // BUSINESS HOURS → STANDARD IVR
  // STANDARD IVR → Key 2-6 + Key 7
  { r: 8, c: 29 }, { r: 8, c: 30 }, { r: 8, c: 31 },
  { r: 8, c: 32 }, { r: 8, c: 33 }, { r: 8, c: 35 },
  // STANDARD IVR → KEY 1 (INQUIRY) left
  { r: 9, c: 0 },
  // KEY 1 (INQUIRY) → KEY 1-5 + NO OR WRONG (left)
  { r: 13, c: 0 }, { r: 13, c: 4 }, { r: 13, c: 8 },
  { r: 13, c: 12 }, { r: 13, c: 26 }, { r: 13, c: 27 },
  // KEY 4 → IVR LINE (left)
  { r: 15, c: 12 },
  // KEY 1 → Audio Message → STANDARD IVR → WAITING → OHA (left)
  { r: 15, c: 0 },
  // IVR LINE children (left)
  { r: 20, c: 12 }, { r: 20, c: 16 }, { r: 20, c: 20 }, { r: 20, c: 24 },
  // Key 7 → STANDARD IVR (right)
  { r: 10, c: 47 },
  // Key 7 → Key 2-6 (right)
  { r: 13, c: 64 }, { r: 13, c: 65 }, { r: 13, c: 66 },
  { r: 13, c: 67 }, { r: 13, c: 68 },
  // KEY 1 (INQUIRY) right → KEY 1-5 + NO OR WRONG
  { r: 18, c: 35 }, { r: 18, c: 39 }, { r: 18, c: 43 },
  { r: 18, c: 47 }, { r: 18, c: 61 }, { r: 18, c: 62 },
  // KEY 4 (right) → IVR LINE
  { r: 20, c: 47 },
  // IVR LINE → KEY 1-3 + NO OR WRONG (left)
  { r: 20, c: 12 }, { r: 20, c: 16 }, { r: 20, c: 20 }, { r: 20, c: 24 },
  // IVR LINE (right) → KEY 1-3 + NO OR WRONG
  { r: 25, c: 47 }, { r: 25, c: 51 }, { r: 25, c: 55 }, { r: 25, c: 59 },
];

/**
 * Parse the Canva text into { cards, arrows, grid, maxCols, merges }.
 */
export function parseCanvaText(rawText) {
  const blocks = tokenize(rawText);
  const idx = indexBlocks(blocks);

  const cards = NODE_DEFS.map(def => {
    const { r, c, span, title, body } = def;
    const bodyText = typeof body === "function" ? body(idx) : body;
    const text = bodyText ? `${title}\n\n${bodyText}` : title;
    const texts = [title, ...(bodyText ? [bodyText] : [])];
    const col0 = c;
    const col1 = c + span - 1;
    return {
      r: r, c: c,
      text: text,
      texts: texts,
      line: title,
      m: span > 1 ? { r0: r, c0: col0, r1: r, c1: col1 } : null,
      id: `${BRAND_SLUG}_r${r}c${c}`,
      endR: r,
      col0: col0,
      col1: col1,
    };
  });

  // Build grid from cards
  const grid = [];
  for (const card of cards) {
    if (!grid[card.r]) grid[card.r] = [];
    for (let c = card.col0; c <= card.col1; c++) {
      grid[card.r][c] = card;
    }
  }
  const maxCols = cards.reduce((max, card) => Math.max(max, card.col1 + 1), 0);

  return { cards, arrows: ARROWS, grid, maxCols, merges: [] };
}
