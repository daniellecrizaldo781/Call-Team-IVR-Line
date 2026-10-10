// scripts/canva-fetch.mjs
// Parse the Canva design text (stored in repo secret CANVA_DESIGN_DATA)
// into the same { cards, arrows, grid, maxCols, merges } structure
// used by the existing build pipeline.  Replaces the Google Sheet fetch.
//
// The Canva design mirrors the IVR tree from the original Google Sheet.
// The exported text is sequential, not grid-based.  We parse it into
// message blocks (title + body) and map each block to its known grid
// position using the tree-structure.json template (which stores card
// positions, arrow connections, and merge info derived from the verified
// tree layout).
//
// The Canva text provides the authoritative message body for each node,
// fixing the "SUB IVR under KEY 1" issue where the sheet parser had
// mismatched body text.

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const treeStructure = require("./tree-structure.json");

const BRAND_SLUG = "oricle-hearing-aid";

// ── Canva block indexing ────────────────────────────────────────────────────

/** Clean and tokenize Canva text into blocks separated by blank lines.
 * KEY headers without body text are merged with the following block
 * (their body), so each block = { title, body }. */
function tokenize(rawText) {
  const cleaned = String(rawText)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\s*Canva\s*$/gm, "")
    .replace(/^\s*Share\s*$/gm, "")
    .replace(/^\s*Create with Canva\s*$/gm, "")
    .replace(/^\s*Previous page\s*$/gm, "")
    .replace(/^\s*Go to page\s*$/gm, "")
    .replace(/^\s*Next page\s*$/gm, "")
    .replace(/^\s*Zoom in and out\s*$/gm, "")
    .replace(/^\s*More\s*$/gm, "")
    .replace(/^\s*Enter full screen\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const rawBlocks = cleaned.split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(b => {
      const t = b.trim();
      return t.length > 0 && t !== "Canva" && !t.includes("(opens in a new tab or window)") && !/^[\d\s]+$/.test(t);
    });

  // Merge KEY headers (title-only) with the following body block
  const merged = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const block = rawBlocks[i];
    const lines = block.split("\n").filter(l => l.trim().length > 0);
    const firstLine = lines[0].trim().toUpperCase();

    // If this block is just a KEY header (key 1, key 2, etc. with no body)
    const isKeyHeader = /^KEY\s+\d+(\s+\(.*\))?$/.test(firstLine);
    const hasOnlyTitle = lines.length === 1;

    if (isKeyHeader && hasOnlyTitle && i + 1 < rawBlocks.length) {
      const nextBlock = rawBlocks[i + 1];
      const nextLines = nextBlock.split("\n").filter(l => l.trim().length > 0);
      const nextFirst = nextLines[0].trim().toUpperCase();

      // Check if next block is a body text (not another header/system block)
      const isBody = !/^KEY\s+\d+/.test(nextFirst)
        && !nextFirst.startsWith("AUDIO MESSAGE")
        && !nextFirst.startsWith("NO INPUT")
        && !nextFirst.startsWith("WAITING")
        && !nextFirst.startsWith("OHA ")
        && !nextFirst.startsWith("BUSINESS HOURS")
        && !nextFirst.startsWith("STANDARD IVR")
        && !nextFirst.startsWith("IVR LINE")
        && !/^["'].*press.*$/.test(nextFirst.toLowerCase()) // Options like 'Press 1 for...'
        && !/^[\d\s,.]+press/.test(nextFirst.toLowerCase()); // Options like 'Press 1 for...'

      if (isBody) {
        merged.push(`${block}\n\n${nextBlock}`);
        i++; // Skip the body block since we merged it
      } else {
        merged.push(block);
      }
    } else {
      merged.push(block);
    }
  }

  return merged;
}

/** Split a block into { title, body, full }. */
function splitBlock(block) {
  const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const title = lines[0];
  const body = lines.slice(1).join("\n").trim() || null;
  return { title, body, full: block };
}

/** Index all blocks by title (case-insensitive). Returns Map of arrays. */
function indexBlocks(blocks) {
  const idx = new Map();
  for (const block of blocks) {
    const { title, body, full } = splitBlock(block);
    const key = title.toLowerCase();
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ title, body, full });
  }
  return idx;
}

/** Find the first block matching title, optionally filtered by body content needle. */
function findBlock(idx, title, needle) {
  const key = title.toLowerCase();
  const candidates = idx.get(key) || [];
  if (needle) {
    const nl = needle.toLowerCase();
    return candidates.find(b => b.full.toLowerCase().includes(nl)) || (candidates[0] || null);
  }
  return candidates[0] || null;
}

// ── Template bodies for system messages ─────────────────────────────────────
// These are standard messages that repeat throughout the IVR tree.

const AUDIO_MSG = "If you would like to speak with an agent, please press 1.\nIf you would like to repeat this message, please press 2.";

const BUSY_MSG = "Hello, unfortunately, all agents are busy assisting other customers. Please email support@oriclehearing.com to resolve your issue most promptly, that is\nsupport @ o r i c l e h e a r i n g dot com. Thank you!";

const WAITING_30S = "WAITING\nEXPERIENCE\n\n30S Ringing Time\n\nSorry, there are currently no agents available at the moment.\nPlease stay on the line as you wait for an agent to be available.\nThank you for your patience.";

const WAITING_120S = "WAITING\nEXPERIENCE\n\n120S Ringing Time\n\nSorry, there are currently no agents available at the moment.\nPlease stay on the line as you wait for an agent to be available.\nThank you for your patience.";

const WAITING_200S = "WAITING\nEXPERIENCE\n\n200S Ringing Time\n\nSorry, there are currently no agents available at the moment.\nPlease stay on the line as you wait for an agent to be available.\nThank you for your patience.";

const MASTERS_QUEUE = "OHA MASTERS\nAGENTS QUEUE\n\n30S Ringing Time\n\nHello, unfortunately, all agents are busy assisting other customers. Please email support@oriclehearing.com to resolve your issue most promptly, that is\nsupport @ o r i c l e h e a r i n g dot com. Thank you!";

const SALES_QUEUE = "OHA SALES\nAGENTS QUEUE\n\n80S Ringing Time\n\nSorry, there are currently no agents available at the moment.\nPlease stay on the line as you wait for an agent to be available.\nThank you for your patience.";

// ── Body text lookup table ──────────────────────────────────────────────────
// Maps (row, col) to a body-resolver function.
// Key nodes get body text from Canva; system nodes use templates.

/**
 * Given the Canva block index, resolve the body text for a card at a
 * specific position.  Returns the body text string, or null if the card
 * is a title-only card (no body).
 */
function resolveCardBody(idx, r, c, title, cardText) {
  const t = title.toLowerCase().trim();
  const ct = (cardText || "").toLowerCase();

  // ── System messages (use templates, not Canva) ──
  if (t === "audio message" || t === "audio message (1)" || t === "audio message (2)") return AUDIO_MSG;
  if (t === "no input" || t === "no input (1)" || t === "no input (2)") return BUSY_MSG;
  if (t.toLowerCase().includes("waiting experience")) {
    if (ct.includes("200s")) return WAITING_200S;
    if (ct.includes("120s")) return WAITING_120S;
    if (ct.includes("30s")) return WAITING_30S;
    return WAITING_30S;
  }
  if (t.toLowerCase().includes("oha masters")) return MASTERS_QUEUE;
  if (t.toLowerCase().includes("oha sales")) return SALES_QUEUE;

  // ── Business Hours ──
  if (t === "business hours") return "Monday - Sunday\n\n5AM - 9PM PST";

  // ── Call Comes In (no body) ──
  if (t === "call comes in") return null;

  // ── STANDARD IVR ──
  if (t === "standard ivr") {
    const b = findBlock(idx, "STANDARD IVR", "For quality assurance");
    if (b?.body) return b.body;
    const b2 = findBlock(idx, "STANDARD IVR", "If you would like to speak");
    if (b2?.body) return b2.body;
    return null;
  }

  // ── KEY nodes under STANDARD IVR (top-level keys) ──
  if (t.includes("key 2") && t.includes("audiologist")) {
    return findBlock(idx, "KEY 2 (Audiologist Consultation)", "At Oricle Hearing")?.body || null;
  }
  if (t.includes("key 3") && t.includes("subscription")) {
    return findBlock(idx, "KEY 3 (Subscription Cancellation)", "cancellation")?.body || null;
  }
  if (t.includes("key 4") && t.includes("sales")) {
    return findBlock(idx, "KEY 4 (Sales)", "OHA Sales")?.body || null;
  }
  if (t.includes("key 5") && t.includes("return")) {
    return findBlock(idx, "KEY 5 (Return)", "Waiting Experience")?.body || null;
  }
  if (t.includes("key 6") && t.includes("other")) {
    return findBlock(idx, "KEY 6 (Other Concerns)", "Waiting Experience")?.body || null;
  }
  if (t.includes("key 7") && t.includes("repeat")) {
    return findBlock(idx, "KEY 7 (Repeat Entire IVR)")?.body || null;
  }

  // ── KEY 1 (INQUIRY) ──
  // Top-level inquiry key (r10c0, r15c35) gets the KEY 1 (INQUIRY) body
  if (t === "key 1 (inquiry)") {
    return findBlock(idx, "KEY 1 (INQUIRY)")?.body || null;
  }

  // ── KEY 1 branch nodes (have body message) ──
  // Under STANDARD IVR left/right subtree: "tinutitis" body
  if (t === "key 1" && r === 14 && c === 0) {
    return findBlock(idx, "KEY 1", "tinutitis")?.body || null;
  }
  if (t === "key 1" && r === 19 && c === 35) {
    return findBlock(idx, "KEY 1", "tinutitis")?.body || null;
  }
  // KEY 1 under IVR LINE: "US-based" body
  if (t === "key 1" && r === 21 && c === 12) {
    return findBlock(idx, "KEY 1", "US-based")?.body || null;
  }
  if (t === "key 1" && r === 26 && c === 47) {
    return findBlock(idx, "KEY 1", "US-based")?.body || null;
  }
  // Leaf KEY 1 nodes (title-only routing keys, no body message)
  if (t === "key 1") return null;

  // ── KEY 2 under KEY 1 (INQUIRY) - "Each hearing aid" body ──
  if (t === "key 2" && (c === 4 || c === 39)) {
    return findBlock(idx, "KEY 2", "Each hearing aid")?.body || null;
  }
  // KEY 2 under IVR LINE - "appreciate" body
  if (t === "key 2" && r === 21 && c === 16) {
    return findBlock(idx, "KEY 2", "appreciate")?.body || null;
  }
  if (t === "key 2" && r === 26 && c === 51) {
    return findBlock(idx, "KEY 2", "appreciate")?.body || null;
  }

  // ── KEY 3 under KEY 1 (INQUIRY) - "Bluetooth" body ──
  if (t === "key 3" && (c === 8 || c === 43)) {
    return findBlock(idx, "KEY 3", "Bluetooth")?.body || null;
  }

  // ── KEY 4 under KEY 1 (INQUIRY) - "shipping" body ──
  if (t === "key 4" && (c === 12 || c === 47)) {
    return findBlock(idx, "KEY 4", "shipping")?.body || null;
  }

  // ── KEY 5 under KEY 1 (INQUIRY) - "Waiting Experience" body ──
  if (t === "key 5" && (c === 26 || c === 61)) {
    return findBlock(idx, "KEY 5", "Waiting Experience")?.body || null;
  }

  // ── IVR LINE ──
  if (t === "ivr line" || t.toLowerCase().includes("ivr line")) {
    const b = findBlock(idx, "IVR LINE", "US-based");
    if (b?.body) return b.body;
    const b2 = findBlock(idx, "IVR LINE", "tinutitis");
    if (b2?.body) return b2.body;
    return null;
  }

  // ── NO OR WRONG INPUT ──
  // At r14c27, r19c62 (under STANDARD IVR subtress): body = "tinutitis"
  // (sheet had wrong "subscription cancellation" text)
  if ((t === "no or wrong input" || t.toLowerCase().includes("no or wrong")) &&
      ((r === 14 && c === 27) || (r === 19 && c === 62))) {
    return findBlock(idx, "KEY 1", "tinutitis")?.body || null;
  }
  // Leaf NO OR WRONG INPUT nodes (routing, no body)
  if (t === "no or wrong input" || t.toLowerCase().includes("no or wrong")) return null;

  // ── Default: try to find by title in Canva blocks ──
  const b = findBlock(idx, title);
  if (b?.body) return b.body;
  return null;
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Parse the Canva design text and return { cards, arrows, grid, maxCols, merges }.
 *
 * Uses the tree-structure.json template for card positions, merges, and arrows.
 * Body text for each card is sourced from the Canva design text blocks.
 */
export function parseCanvaText(rawText) {
  if (!rawText || !rawText.trim()) {
    throw new Error("CANVA_DESIGN_DATA is empty or not set");
  }

  const blocks = tokenize(rawText);
  const idx = indexBlocks(blocks);

  // Build merge lookup: for each (r,c), find the merge that contains it
  const merges = treeStructure.merges || [];
  const findMerge = (r, c) => merges.find(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);

  // Build cards from tree-structure template, with body text from Canva
  const cards = treeStructure.nodes.map(node => {
    const { r, c, span, title } = node;
    const fullText = (node.texts && node.texts[0]) || title;
    const m = findMerge(r, c);
    const col0 = c;
    const col1 = m ? m.c1 : (c + span - 1);
    const id = `${BRAND_SLUG}_r${r}c${c}`;

    // Check if the card text already contains body (title + body merged in sheet)
    const lines = fullText.split("\n").filter(l => l.trim().length > 0);
    const firstLine = lines[0].trim();
    const hasBody = lines.length > 1;
    const existingBody = hasBody ? lines.slice(1).join("\n\n").trim() : null;

    // Resolve new body text from Canva
    const newBody = resolveCardBody(idx, r, c, title, fullText);

    // Use Canva body if available, otherwise keep existing
    const bodyText = newBody || existingBody || null;
    const text = bodyText ? `${title}\n\n${bodyText}` : title;

    return {
      r, c, text, m, id,
      col0, col1,
      endR: r,
    };
  });

  // Build grid from cards
  const grid = [];
  for (const card of cards) {
    if (!grid[card.r]) grid[card.r] = [];
    for (let x = card.col0; x <= card.col1; x++) {
      grid[card.r][x] = card;
    }
  }
  const maxCols = treeStructure.maxCols || 70;

  return { cards, arrows: treeStructure.arrows, grid, maxCols, merges };
}
