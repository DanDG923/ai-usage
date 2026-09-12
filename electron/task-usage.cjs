'use strict';

// Only structural identifiers are retained. Task prompts and message bodies
// never enter this projection or the ledger metadata.
function textId(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

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

function metadataOf(event) {
  if (!event.metadata_json || event.metadata_json === '{}') return {};
  try {
    const value = JSON.parse(event.metadata_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Per-event map keys. Serialising a small array as JSON for every ledger row
// was a measurable share of the aggregation. Every part is an identifier
// string or absent, so a control-character join is unambiguous; null and
// undefined share one marker, exactly as they did inside a JSON array. The
// task and agent keys the renderer receives keep their JSON form; those are
// built once per group in finish(), not once per event.
const KEY_SEPARATOR = '\u0000';
const KEY_ABSENT = '\u0001';
function usageKey(...parts) {
  let key = '';
  for (const part of parts) key += `${part == null ? KEY_ABSENT : part}${KEY_SEPARATOR}`;
  return key;
}

function emptyUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    usageCount: 0, costUsd: 0, coveredTokens: 0, startedAt: null, occurredAt: null };
}

function mergeUsage(target, value) {
  for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens', 'usageCount', 'costUsd', 'coveredTokens']) target[field] += value[field];
  if (!target.startedAt || value.startedAt < target.startedAt) target.startedAt = value.startedAt;
  if (!target.occurredAt || value.occurredAt > target.occurredAt) target.occurredAt = value.occurredAt;
}

class TaskUsage {
  constructor() {
    this.rows = new Map();
    this.parents = new Map();
  }

  add(event, cost, totalTokens) {
    const metadata = metadataOf(event);
    const sessionId = event.session_id || event.event_key;
    const parent = textId(metadata.parentSessionId);
    if (parent && parent !== sessionId) this.parents.set(usageKey(event.source_id, sessionId), parent);
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
      inputTokens: event.source_id === 'codex' ? Math.max(0, event.input_tokens - event.cached_input_tokens) : event.input_tokens,
      cachedInputTokens: event.cached_input_tokens, cacheWriteInputTokens: event.cache_write_input_tokens,
      outputTokens: event.output_tokens, reasoningOutputTokens: event.reasoning_output_tokens,
      totalTokens, usageCount: 1, costUsd: cost.actualUsd, coveredTokens: cost.covered ? totalTokens : 0,
      startedAt: event.occurred_at, occurredAt: event.occurred_at,
    });
    if (!row.project && event.project) row.project = event.project;
    this.rows.set(key, row);
  }

  rootFor(row, roots = new Map()) {
    if (row.rootSessionId) return row.rootSessionId;
    const seen = new Set();
    let current = row.sessionId;
    // null marks ancestry that reaches a cycle, not any one session's fallback.
    let root = null;
    while (current) {
      const key = usageKey(row.sourceId, current);
      if (roots.has(key)) { root = roots.get(key); break; }
      if (seen.has(key)) break;
      seen.add(key);
      const parent = this.parents.get(key);
      if (!parent) { root = current; break; }
      current = parent;
    }
    for (const key of seen) roots.set(key, root);
    return root ?? row.sessionId;
  }

  finish(rate) {
    const tasks = new Map();
    // Resolve each source/session once per pass; later add() calls may change parents.
    const roots = new Map();
    const convert = (row) => ({ ...row, cost: row.costUsd * rate,
      coverage: row.totalTokens ? row.coveredTokens / row.totalTokens : 0,
      activitySpanMs: row.usageCount > 1 ? Date.parse(row.occurredAt) - Date.parse(row.startedAt) : null });
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
    return [...tasks.values()].map(({ agents, subagents, main, subagent, unknown, ...task }) => ({
      ...convert(task), subagentCount: subagents.size,
      main: convert(main), subagent: convert(subagent), unknown: convert(unknown),
      agents: [...agents.values()].sort((a, b) => a.agentKind.localeCompare(b.agentKind)
        || b.costUsd - a.costUsd || a.key.localeCompare(b.key)).map(convert),
    })).sort((a, b) => b.cost - a.cost || b.occurredAt.localeCompare(a.occurredAt) || a.key.localeCompare(b.key));
  }
}

module.exports = { TaskUsage, codexAgentMetadata, claudeAgentMetadata, textId };
