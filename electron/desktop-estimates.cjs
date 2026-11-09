'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { periodStart } = require('./time.cjs');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGES = 200_000;
const MAX_MODELS = 128;
const METHOD = 'visible-prompt-reply-chars-v1';
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
const modelName = (value) => typeof value === 'string' && /^claude-[a-z0-9.-]{1,100}$/i.test(value)
  ? value.toLowerCase() : null;
function characterCount(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += text.codePointAt(index) > 0xffff ? 2 : 1) count += 1;
  return count;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 && ms <= Date.now() + 86400000 ? new Date(ms).toISOString() : null;
}

// Deliberately a transparent character heuristic, not a provider tokenizer.
// Content blocks and the convenience `text` field often duplicate each other.
function visibleText(message) {
  let characters = 0;
  let excluded = false;
  let hasBlocks = false;
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (block.text.length) hasBlocks = true;
        characters += characterCount(block.text);
      } else excluded = true;
    }
  }
  if (!hasBlocks && typeof message.text === 'string') {
    characters += characterCount(message.text);
  }
  if ([message.attachments, message.files].some((entries) => Array.isArray(entries) && entries.length)) excluded = true;
  return { tokens: Math.ceil(characters / 4), excluded };
}

function parseDesktopExport(payload) {
  if (!Array.isArray(payload) || !payload.length || payload.length > 50_000
    || !payload.some((conversation) => id(conversation?.uuid) && Array.isArray(conversation.chat_messages))) {
    throw new Error('Choose conversations.json from a Claude data export. Extract the ZIP first.');
  }
  const records = new Map();
  let skipped = 0;
  let scanned = 0;
  const conversations = new Set();
  const models = new Set();
  for (const conversation of payload) {
    if (!id(conversation?.uuid) || !Array.isArray(conversation.chat_messages)) { skipped += 1; continue; }
    const messages = conversation.chat_messages;
    scanned += messages.length;
    if (scanned > MAX_MESSAGES) throw new Error('This export has more than 200,000 messages. Import a smaller export.');
    const byId = new Map(messages.filter((message) => id(message?.uuid)).map((message) => [message.uuid, message]));
    const textCache = new Map();
    const text = (message) => {
      if (!textCache.has(message)) textCache.set(message, visibleText(message));
      return textCache.get(message);
    };
    /** @type {any} */
    let latestHuman = null;
    for (const message of messages) {
      if (message?.sender === 'human') { latestHuman = message; continue; }
      if (message?.sender !== 'assistant') { skipped += 1; continue; }
      const occurredAt = timestamp(message.created_at);
      if (!id(message.uuid) || !occurredAt) { skipped += 1; continue; }
      // A parent link takes precedence over array order in branched exports.
      let human = latestHuman;
      if (message.parent_message_uuid) {
        human = byId.get(message.parent_message_uuid);
        if (human?.sender !== 'human') human = null;
      }
      const output = text(message);
      const input = human ? text(human) : { tokens: 0, excluded: false };
      if (!input.tokens && !output.tokens) { skipped += 1; continue; }
      const model = modelName(message.model);
      if (model) models.add(model);
      if (models.size > MAX_MODELS) throw new Error(`Chat exports support at most ${MAX_MODELS} distinct model labels.`);
      const key = createHash('sha256').update(JSON.stringify([conversation.uuid, message.uuid])).digest('hex');
      records.set(key, {
        event_key: key, occurred_at: occurredAt, model,
        model_origin: model ? 'exported' : 'unknown',
        input_tokens: input.tokens, output_tokens: output.tokens,
        excluded_content: Number(input.excluded || output.excluded), input_missing: Number(!human), method: METHOD,
      });
      conversations.add(conversation.uuid);
    }
  }
  if (!records.size) throw new Error('No dated Claude replies with visible text were found in this export.');
  const rows = [...records.values()];
  return { rows, summary: {
    conversations: conversations.size, replies: rows.length, skipped,
    unknownModelReplies: rows.filter((row) => !row.model).length,
    excludedContentReplies: rows.filter((row) => row.excluded_content || row.input_missing).length,
    models: [...new Set(rows.map((row) => row.model).filter(Boolean))].sort(),
  } };
}

function readDesktopExport(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Choose a JSON export no larger than 64 MB.');
    // Bounded read even if the selected file grows while it is being read.
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stat.size) throw new Error('The export changed while reading. Choose it again.');
    let payload;
    try { payload = JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('This is not valid JSON. Extract conversations.json from the Claude export ZIP.'); }
    return parseDesktopExport(payload);
  } finally { fs.closeSync(fd); }
}

function migrateDesktopEstimates(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_chat_estimates (
    event_key TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, model TEXT,
    model_origin TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    excluded_content INTEGER NOT NULL, input_missing INTEGER NOT NULL, method TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS desktop_estimate_date ON desktop_chat_estimates(occurred_at);`);
}

/** @param {import('./store.cjs').Store} store */
function storedDesktopModels(store) {
  return new Set(store.prepare('SELECT DISTINCT model FROM desktop_chat_estimates WHERE model IS NOT NULL')
    .all().map((row) => row.model.toLowerCase()));
}

/** @param {import('./store.cjs').Store} store */
function insertDesktopEstimate(store, row, models = storedDesktopModels(store)) {
  if (!row || typeof row.event_key !== 'string' || !/^[a-f0-9]{64}$/.test(row.event_key) || !timestamp(row.occurred_at)
    || row.method !== METHOD || !['exported', 'assumed', 'unknown'].includes(row.model_origin)
    || (row.model_origin === 'unknown' ? row.model !== null : !modelName(row.model))
    || ![row.input_tokens, row.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_BYTES)
    || ![row.excluded_content, row.input_missing].every((n) => n === 0 || n === 1)) {
    throw new Error('Invalid desktop estimate record.');
  }
  const model = modelName(row.model);
  if (model && !models.has(model) && models.size >= MAX_MODELS) {
    // An already-imported reply is still a duplicate even if a later export
    // changes its model. Only newly stored labels consume the model budget.
    if (store.prepare('SELECT 1 FROM desktop_chat_estimates WHERE event_key = ?').get(row.event_key)) return 0;
    throw new Error(`Chat estimates support at most ${MAX_MODELS} distinct model labels.`);
  }
  const changed = store.prepare(`INSERT INTO desktop_chat_estimates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO NOTHING`).run(row.event_key, timestamp(row.occurred_at), model,
    row.model_origin, row.input_tokens, row.output_tokens, row.excluded_content, row.input_missing, row.method).changes;
  if (changed && model) models.add(model);
  return changed;
}

/** @param {import('./store.cjs').Store} store */
function saveDesktopEstimates(store, rows, assumedModel = /** @type {string | null} */ (null)) {
  if (assumedModel !== null && (!modelName(assumedModel) || !store.resolvePrice(assumedModel))) {
    throw new Error('Choose a priced Claude model or leave missing models unknown.');
  }
  let imported = 0;
  store.transaction(() => {
    const models = storedDesktopModels(store);
    for (const row of rows) imported += insertDesktopEstimate(store, row.model || !assumedModel ? row
      : { ...row, model: assumedModel, model_origin: 'assumed' }, models);
  });
  return { imported, duplicates: rows.length - imported };
}

/** @param {import('./store.cjs').Store} store */
function desktopAnalytics(store, days, settings, nowMs) {
  return store.withPriceCache(() => buildDesktopAnalytics(store, days, settings, nowMs));
}

/** @param {import('./store.cjs').Store} store */
function buildDesktopAnalytics(store, days, settings, nowMs) {
  const period = [new Date(periodStart(days, nowMs)).toISOString(), new Date(nowMs).toISOString()];
  const rows = store.prepare(`SELECT model, model_origin AS modelOrigin, COUNT(*) AS replies,
    SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
    SUM(CASE WHEN excluded_content OR input_missing THEN 1 ELSE 0 END) AS incompleteReplies
    FROM desktop_chat_estimates WHERE occurred_at >= ? AND occurred_at <= ? GROUP BY model, model_origin
    ORDER BY replies DESC, model, model_origin`).all(...period);
  // Each reply is priced by the rate card its own prompt selects, as recorded
  // requests are, so replies are summed within a long-context tier, never
  // across one. The visible prompt is all an estimate knows of a reply's
  // prompt; earlier turns could only raise its tier.
  const { contextTierSql } = require('./store.cjs');
  const usdByModel = new Map();
  for (const tier of store.prepare(`SELECT model, model_origin AS modelOrigin, ${contextTierSql('input_tokens')} AS contextTier,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
    FROM desktop_chat_estimates WHERE occurred_at >= ? AND occurred_at <= ? GROUP BY model, model_origin, contextTier`).iterate(...period)) {
    const cost = store.calculateCost({ ...tier, source_id: 'claude' });
    const key = `${tier.model}|${tier.modelOrigin}`;
    usdByModel.set(key, cost.covered ? (usdByModel.get(key) ?? 0) + cost.actualUsd : null);
  }
  const conversion = settings.currency === 'USD' ? 1 : settings.usdToCurrency;
  let estimatedUsd = 0;
  let unpricedReplies = 0;
  for (const row of rows) {
    const usd = usdByModel.get(`${row.model}|${row.modelOrigin}`) ?? null;
    row.estimatedCost = usd === null ? null : usd * conversion;
    if (usd === null) unpricedReplies += row.replies;
    else estimatedUsd += usd;
  }
  return { periodDays: days, currency: settings.currency, estimatedCost: estimatedUsd * conversion,
    unpricedReplies, replies: rows.reduce((sum, row) => sum + row.replies, 0), byModel: rows,
    storedReplies: store.prepare('SELECT COUNT(*) AS count FROM desktop_chat_estimates').get().count };
}

module.exports = { readDesktopExport, parseDesktopExport, migrateDesktopEstimates, insertDesktopEstimate,
  saveDesktopEstimates, desktopAnalytics, storedDesktopModels, MAX_MODELS };
