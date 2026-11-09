'use strict';

const { cachedInputInsideInput } = require('./providers.mjs');

/** @typedef {import('./types').IsoTime} IsoTime */
/** @typedef {'main' | 'subagent' | 'unknown'} AgentKind */
/**
 * Token and cost totals of a row, an agent or a task. The two times are null
 * until the first usage is merged in.
 * @typedef {object} UsageTotals
 * @property {number} inputTokens
 * @property {number} cachedInputTokens
 * @property {number} cacheWriteInputTokens
 * @property {number} outputTokens
 * @property {number} reasoningOutputTokens
 * @property {number} totalTokens
 * @property {number} usageCount
 * @property {number} costUsd
 * @property {number} coveredTokens
 * @property {IsoTime | null} startedAt
 * @property {IsoTime | null} occurredAt
 */
/**
 * The usage of one agent on one model within a session and task.
 * @typedef {UsageTotals & {
 *   sourceId: string, sessionId: string, taskId: string | null, rootSessionId: string | null,
 *   agentId: string | null, agentKind: AgentKind, parentSessionId: string | null,
 *   agentName: string | null, agentRole: string | null, model: string, project: string | null,
 * }} AgentUsage
 */
/**
 * A task while its agents are being gathered.
 * @typedef {UsageTotals & {
 *   key: string, sourceId: string, sessionId: string, taskId: string | null, project: string | null,
 *   agents: Map<string, AgentUsage & { key: string }>, subagents: Set<string>,
 *   main: UsageTotals, subagent: UsageTotals, unknown: UsageTotals,
 * }} TaskTotals
 */
/**
 * The usage that is attributed: a usage_events row, or a sum of them that
 * share a session, model and attribution metadata.
 * @typedef {object} AttributedUsage
 * @property {string} source_id
 * @property {string | null} session_id
 * @property {string} event_key
 * @property {string | null} model
 * @property {string | null} project
 * @property {string | null} [metadata_json]
 * @property {number} input_tokens
 * @property {number} cached_input_tokens
 * @property {number} cache_write_input_tokens
 * @property {number} output_tokens
 * @property {number} reasoning_output_tokens
 * @property {number} [event_count] On a sum: how many requests it covers.
 * @property {IsoTime} [first_occurred_at] On a sum: its earliest request.
 * @property {IsoTime} occurred_at
 */

// Only structural identifiers are retained. Task prompts and message bodies
// never enter this projection or the ledger metadata.
/** @param {unknown} value */
function textId(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

// `payload` is a Codex session's metadata as parsed from its log.
/** @param {Record<string, any>} [payload] */
function codexAgentMetadata(payload = {}) {
  if (!payload || typeof payload !== 'object') payload = {};
  const spawn = payload.source?.subagent?.thread_spawn;
  const parentSessionId = textId(payload.parent_thread_id) || textId(spawn?.parent_thread_id);
  const subagent = Boolean(parentSessionId || payload.source?.subagent || payload.thread_source === 'subagent');
  return {
    agentAttributionVersion: 1,
    agentId: textId(payload.id),
    agentKind: subagent ? 'subagent' : 'main',
    parentSessionId,
    rootSessionId: textId(payload.session_id),
    agentName: textId(payload.agent_nickname) || textId(spawn?.agent_nickname),
    agentRole: textId(payload.agent_role) || textId(payload.agent_type) || textId(spawn?.agent_role) || textId(spawn?.agent_type),
  };
}

/**
 * @param {{ agentId?: unknown, isSidechain?: unknown, sessionId?: unknown }} row A line of a Claude transcript.
 * @param {string} fullPath
 */
function claudeAgentMetadata(row, fullPath) {
  const normalized = fullPath.replaceAll('\\', '/');
  const nested = normalized.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/);
  const legacy = normalized.match(/\/agent-([^/]+)\.jsonl$/);
  const agentId = textId(row.agentId) || nested?.[2] || legacy?.[1] || null;
  const subagent = Boolean(agentId || row.isSidechain);
  return {
    agentAttributionVersion: 1,
    agentId: agentId || (subagent ? null : textId(row.sessionId)),
    agentKind: subagent ? (agentId ? 'subagent' : 'unknown') : 'main',
    rootSessionId: nested?.[1] || textId(row.sessionId),
    parentSessionId: subagent ? nested?.[1] || textId(row.sessionId) : null,
  };
}

/**
 * @param {{ metadata_json?: string | null }} event
 * @returns {Record<string, any>} The event's metadata as parsed, or an empty object.
 */
function metadataOf(event) {
  if (!event.metadata_json || event.metadata_json === '{}') return {};
  try {
    const value = JSON.parse(event.metadata_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Per-event map keys. Serialising a small array as JSON for every ledger row
// was a measurable share of the aggregation. Each present part is written
// with its length in front, so the encoding is unambiguous whatever the
// identifier contains (a separator character inside a transcript id cannot be
// mistaken for framing); null and undefined share one marker, exactly as they
// did inside a JSON array. The task and agent keys the renderer receives keep
// their JSON form; those are built once per group in finish(), not per event.
/** @param {...(string | number | null | undefined)} parts */
function usageKey(...parts) {
  let key = '';
  for (const part of parts) {
    if (part == null) {
      key += '~|';
    } else {
      const text = String(part);
      key += `${text.length}:${text}|`;
    }
  }
  return key;
}

/** @returns {UsageTotals} */
function emptyUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    usageCount: 0, costUsd: 0, coveredTokens: 0, startedAt: null, occurredAt: null };
}

/**
 * @param {UsageTotals} target
 * @param {UsageTotals} value
 */
function mergeUsage(target, value) {
  for (const field of /** @type {const} */ (['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens', 'usageCount', 'costUsd', 'coveredTokens'])) target[field] += value[field];
  // Only usage that has happened is merged in, so `value` has both its times.
  if (!target.startedAt || /** @type {IsoTime} */ (value.startedAt) < target.startedAt) target.startedAt = value.startedAt;
  if (!target.occurredAt || /** @type {IsoTime} */ (value.occurredAt) > target.occurredAt) target.occurredAt = value.occurredAt;
}

class TaskUsage {
  constructor() {
    /** @type {Map<string, AgentUsage>} */
    this.rows = new Map();
    // A session's parent session, by source and session.
    /** @type {Map<string, string>} */
    this.parents = new Map();
  }

  /**
   * @param {AttributedUsage} event
   * @param {{ actualUsd: number, covered: boolean }} cost
   * @param {number} totalTokens
   */
  add(event, cost, totalTokens) {
    const metadata = metadataOf(event);
    const sessionId = event.session_id || event.event_key;
    const parent = textId(metadata.parentSessionId);
    if (parent && parent !== sessionId) this.parents.set(usageKey(event.source_id, sessionId), parent);
    /** @type {AgentKind} */
    const kind = metadata.agentKind === 'main' || metadata.agentKind === 'subagent' ? metadata.agentKind : 'unknown';
    const agentId = textId(metadata.agentId);
    const taskId = textId(metadata.taskId);
    const rootSessionId = textId(metadata.rootSessionId);
    const key = usageKey(event.source_id, sessionId, taskId, agentId, kind, event.model, rootSessionId);
    const row = this.rows.get(key) || {
      ...emptyUsage(), sourceId: event.source_id, sessionId, taskId, rootSessionId,
      agentId, agentKind: kind, parentSessionId: parent,
      agentName: textId(metadata.agentName), agentRole: textId(metadata.agentRole),
      model: event.model || 'Unknown', project: event.project || null,
    };
    mergeUsage(row, {
      inputTokens: cachedInputInsideInput(event.source_id) ? Math.max(0, event.input_tokens - event.cached_input_tokens) : event.input_tokens,
      cachedInputTokens: event.cached_input_tokens, cacheWriteInputTokens: event.cache_write_input_tokens,
      outputTokens: event.output_tokens, reasoningOutputTokens: event.reasoning_output_tokens,
      totalTokens, usageCount: event.event_count ?? 1, costUsd: cost.actualUsd, coveredTokens: cost.covered ? totalTokens : 0,
      startedAt: event.first_occurred_at ?? event.occurred_at, occurredAt: event.occurred_at,
    });
    if (!row.project && event.project) row.project = event.project;
    this.rows.set(key, row);
  }

  /**
   * @param {AgentUsage} row
   * @param {Map<string, string | null>} [roots] Roots already found, by source and session.
   * @returns {string}
   */
  rootFor(row, roots = new Map()) {
    if (row.rootSessionId) return row.rootSessionId;
    const seen = new Set();
    let current = row.sessionId;
    // null marks ancestry that reaches a cycle, not any one session's fallback.
    /** @type {string | null} */
    let root = null;
    while (current) {
      const key = usageKey(row.sourceId, current);
      // has() was true, so the lookup finds an entry, which may be null.
      if (roots.has(key)) { root = /** @type {string | null} */ (roots.get(key)); break; }
      if (seen.has(key)) break;
      seen.add(key);
      const parent = this.parents.get(key);
      if (!parent) { root = current; break; }
      current = parent;
    }
    for (const key of seen) roots.set(key, root);
    return root ?? row.sessionId;
  }

  /**
   * @param {number} rate Display currency per US dollar.
   * @returns {import('./types').TaskCost[]}
   */
  finish(rate) {
    /** @type {Map<string, TaskTotals>} */
    const tasks = new Map();
    // Resolve each source/session once per pass; later add() calls may change parents.
    /** @type {Map<string, string | null>} */
    const roots = new Map();
    // Totals with more than one use have had usage merged in, so both times are set.
    /**
     * @template {UsageTotals} T
     * @param {T} row
     */
    const convert = (row) => ({ ...row, cost: row.costUsd * rate,
      coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
      activitySpanMs: row.usageCount > 1 ? Date.parse(/** @type {IsoTime} */ (row.occurredAt)) - Date.parse(/** @type {IsoTime} */ (row.startedAt)) : null });
    for (const row of this.rows.values()) {
      const sessionId = this.rootFor(row, roots);
      const key = JSON.stringify([row.sourceId, sessionId, row.taskId]);
      const task = tasks.get(key) || { ...emptyUsage(), key, sourceId: row.sourceId, sessionId,
        taskId: row.taskId, project: row.project, agents: new Map(), subagents: new Set(),
        main: emptyUsage(), subagent: emptyUsage(), unknown: emptyUsage() };
      mergeUsage(task, row);
      mergeUsage(task[row.agentKind], row);
      if (!task.project && row.project) task.project = row.project;
      // Model changes produce separate rows without inflating the agent count.
      const agentKey = JSON.stringify([row.sessionId, row.agentId, row.agentKind, row.model]);
      const agent = task.agents.get(agentKey) || { ...row, ...emptyUsage(), key: agentKey };
      mergeUsage(agent, row);
      task.agents.set(agentKey, agent);
      if (row.agentKind === 'subagent') task.subagents.add(JSON.stringify([row.sessionId, row.agentId]));
      tasks.set(key, task);
    }
    // On the casts in the final sort: a task exists only once a row has been
    // merged into it, so it has its times.
    return [...tasks.values()].map(({ agents, subagents, main, subagent, unknown, ...task }) => ({
      ...convert(task), subagentCount: subagents.size,
      main: convert(main), subagent: convert(subagent), unknown: convert(unknown),
      agents: [...agents.values()].sort((a, b) => a.agentKind.localeCompare(b.agentKind)
        || b.costUsd - a.costUsd || a.key.localeCompare(b.key)).map(convert),
    })).sort((a, b) => b.cost - a.cost || /** @type {IsoTime} */ (b.occurredAt).localeCompare(/** @type {IsoTime} */ (a.occurredAt)) || a.key.localeCompare(b.key));
  }
}

module.exports = { TaskUsage, codexAgentMetadata, claudeAgentMetadata, textId };
