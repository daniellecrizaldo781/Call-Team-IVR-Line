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
    // KEY 1 (INQUIRY) is NOT merged — its body is a separate card
    // KEY 2-7 (descriptions) ARE merged with their body block
    const isKeyHeader = /^KEY\s+\d+(\s|\(|$)/.test(firstLine) && !/INQUIRY/.test(firstLine);
    const hasOnlyTitle = lines.length === 1;

    if (isKeyHeader && hasOnlyTitle && i + 1 < rawBlocks.length) {
      const nextBlock = rawBlocks[i + 1];
      const nextLines = nextBlock.split("\n").filter(l => l.trim().length > 0);
      const nextFirst = nextLines[0].trim().toUpperCase();

      // Check if next block is a body text (not another header/system block)
      // KEY 2-7 (descriptions) can have bodies starting with "WAITING EXPERIENCE"
      // — only skip if next block is a standalone header (title-only)
      const isBody = !/^KEY\s+\d+/.test(nextFirst)
        && !nextFirst.startsWith("AUDIO MESSAGE")
        && !nextFirst.startsWith("NO INPUT")
        && !nextFirst.startsWith("OHA ")
        && !nextFirst.startsWith("BUSINESS HOURS")
        && !nextFirst.startsWith("STANDARD IVR")
        && !nextFirst.startsWith("IVR LINE")
        && !nextFirst.startsWith("ORICLE HEARING")
        && !nextFirst.startsWith("CALL COMES IN")
        && !(nextFirst.startsWith("WAITING") && nextLines.length <= 2) // standalone WAITING EXPERIENCE header
        && !/^["'].*press.*$/.test(nextFirst.toLowerCase()) // Options like 'Press 1 for...'
        && !/^\d\s*[\t,]?\s*press/i.test(nextFirst.toLowerCase());

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
function resolveCardBody(idx, blocks, r, c, title, cardText) {
  const t = title.toLowerCase().trim();
  const ct = (cardText || "").toLowerCase();

  // ── Body continuation cards (greeting/body text, not headers) ──
  // These are cells that contain only body text (e.g. "Thank you for calling...")
  // and are merged with their parent header card by buildNodes. They should
  // not override the existing body or pull from Canva.
  if (t.startsWith("thank you for calling") || t.startsWith("thank you for your") ||
      t.startsWith("to learn if our hearing") || t.startsWith("to learn about") ||
      t.startsWith("to repeat") || t.startsWith("for shipping") ||
      t.startsWith("at oricle hearing") || t.startsWith("our hearing aid") ||
      t.startsWith("to repeat this message")) return null;

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
  // Do NOT resolve body here — the body card below (r4c12 "Monday - Sunday")
  // provides the business hours text after buildNodes merges the two cards.
  if (t === "business hours") return null;

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
  // Canva text uses full titles like "KEY 2 (AUDIOLOGIST CONSULTATION)".
  // Use title + body needle to disambiguate between multiple KEY blocks.
  if (t.includes("key 2") && t.includes("audiologist")) {
    return findBlock(idx, "KEY 2 (AUDIOLOGIST CONSULTATION)", "At Oricle Hearing")?.body || null;
  }
  if (t.includes("key 3") && t.includes("subscription")) {
    return findBlock(idx, "KEY 3 (SUBSCRIPTION CANCELLATION)", "cancellation")?.body || null;
  }
  // KEY 4-6 bodies span multiple Canva blocks (Waiting Experience, OHA Queues, etc.)
  // Collect all blocks after the KEY header until the next KEY/system header.
  if (t.includes("key 4") && t.includes("sales")) {
    return collectMultiBlockBody(idx, blocks, "KEY 4 (SALES)");
  }
  if (t.includes("key 5") && t.includes("return")) {
    return collectMultiBlockBody(idx, blocks, "KEY 5 (RETURN)");
  }
  if (t.includes("key 6") && t.includes("other")) {
    return collectMultiBlockBody(idx, blocks, "KEY 6 (OTHER CONCERNS)");
  }
  if (t.includes("key 7") && t.includes("repeat")) {
    return findBlock(idx, "KEY 7 (REPEAT ENTIRE IVR)")?.body || null;
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
  // r16c12 has wrong body text from sheet (KEY 1 INQUIRY body). Return null so
  // the body card below (r17c12) provides the correct text after buildNodes merge.
  if (t === "ivr line" || t.toLowerCase().includes("ivr line")) {
    if (r === 16 && c === 12) return null;
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Collect body text from multiple Canva blocks following a KEY header.
 * Some KEY nodes (KEY 4, 5, 6) have bodies that span multiple blocks
 * because the body starts with "WAITING EXPERIENCE" which tokenize()
 * treats as a standalone header. This collects all blocks after the
 * KEY header title block until the next KEY/system header. */
function collectMultiBlockBody(idx, blocks, title) {
  const key = title.toLowerCase();
  const candidates = idx.get(key) || [];
  // Find the block that is just the title (no body)
  const headerBlock = candidates.find(b => !b.body || b.body === b.full);
  if (!headerBlock) return null;
  const startIdx = blocks.indexOf(headerBlock.full);
  if (startIdx < 0) return null;

  const collected = [];
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const blk = blocks[i];
    const { title: blkTitle, full } = splitBlock(blk);
    const firstUpper = blkTitle.toUpperCase();
    // Stop at next KEY header or system message block
    if (/^KEY\s+\d+/i.test(firstUpper) ||
        firstUpper.startsWith("AUDIO MESSAGE") ||
        firstUpper.startsWith("NO INPUT") ||
        firstUpper === "STANDARD IVR" ||
        firstUpper === "IVR LINE" ||
        firstUpper === "BUSINESS HOURS" ||
        firstUpper === "CALL COMES IN" ||
        firstUpper === "ORICLE HEARING AID IVR") {
      break;
    }
    collected.push(full);
  }
  return collected.length > 0 ? collected.join("\n") : null;
}



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
    let existingBody = hasBody ? lines.slice(1).join("\n\n").trim() : null;

    // Filter out wrong "subscription cancellation" body text that the sheet
    // parser misattributed to KEY 1 / Audio Message / WAITING cards.
    // The correct body for these positions is the "tinutitis" message.
    if (existingBody && existingBody.includes("For subscription cancellation")) {
      existingBody = null;
    }
    // Filter out IVR LINE at r16c12 which has KEY 1 (INQUIRY) body misattributed
    // by the sheet parser. The correct body comes from the card below (r17c12).
    const t_lower = title.toLowerCase().trim();
    if ((t_lower === "ivr line" || t_lower.includes("ivr line")) && r === 16 && c === 12) {
      existingBody = null;
    }

    // Resolve new body text from Canva
    const newBody = resolveCardBody(idx, blocks, r, c, title, fullText);

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
