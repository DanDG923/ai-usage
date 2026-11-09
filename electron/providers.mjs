// The one place a subscription is described. Everything else looks a provider
// up here instead of spelling out its name, so adding one means adding an
// entry below and a collector that writes its readings.
//
// An ES module with no imports: the main process loads it with `require`, and
// the renderer bundle reaches it through dashboard-decision.mjs and
// quota-selection.mjs. Only data and small pure functions belong here.
//
// Three things are tracked. Codex and Claude are subscriptions, each with a
// collector of its own. Fable is not a third subscription: it is a
// model-specific allowance inside Claude's. The Claude collector writes its
// readings and its status, its tokens are Claude's tokens, and its weekly
// limit is a share of Claude's weekly pool. It has an entry because the
// database, the snapshot and the screens address it as they address the other
// two; the fields `sharesAllowanceWith`, `collector` and `ledgerSource` say
// what it borrows.

/** @typedef {(model: string | null | undefined) => boolean} ModelMatcher */

/**
 * @template {string} Id
 * @template {string} Key
 * @template {string} Collector
 * @template {string | null} Host
 * @typedef {object} ProviderDefinition
 * @property {Id} id The id the database and the collectors use: sources.id and
 *   the source_id of a reading. Source health is reported under it too.
 * @property {Key} snapshotKey The key of its quota and its cycles in a snapshot,
 *   which is the id the renderer, the tray and notifications know it by.
 * @property {string} label Its name on screen, and sources.name.
 * @property {string} kind sources.kind as seeded. Stored; nothing reads it.
 * @property {keyof import('./types').Settings} visibilitySetting The
 *   setting that shows or hides it. Fable follows Claude's.
 * @property {Host} sharesAllowanceWith The id of the provider whose weekly
 *   allowance it draws on, or null when its allowance is its own. A recorded
 *   allowance change names the owner and applies to both, and the owner's
 *   weekly window caps what the sharer can still use.
 * @property {number} allowanceShare How much of that weekly allowance its own
 *   limit covers: 1 for an owner, 0.5 for Fable.
 * @property {Collector} collector The collector that writes its readings and
 *   its status. A lane in collector-service.cjs is keyed by this.
 * @property {string} ledgerSource The source_id its tokens are recorded under
 *   in usage_events. Fable's are Claude's.
 * @property {string | null} ledgerModelLike The piece of a model name that
 *   picks its tokens out of that ledger source in a SQL query, or null when
 *   every model is its own. Looser than `countsModel`; see the note there.
 * @property {ModelMatcher} countsModel Whether a request's model draws on its
 *   weekly allowance, as the token-capacity estimate decides it.
 * @property {'overall' | 'model'} weeklyScope Whether that weekly allowance
 *   covers every model of the subscription or one family of them.
 * @property {boolean} cachedInputInsideInput Whether its reported input count
 *   already includes the cached part (Codex), or reports it beside it (Claude).
 * @property {readonly string[]} mainBuckets The bucket ids of the subscription's
 *   own allowance, as opposed to a model or app limit reported beside it.
 * @property {boolean} scopeDecidesMain Whether its collector marks each limit
 *   with a `scope`; when a reading carries one it decides, and `mainBuckets`
 *   stands in only for readings without it.
 * @property {string | null} mainLimitId The provider's own name for the main
 *   allowance in a reading's `limitId`, when it reports one.
 * @property {readonly string[]} weeklyBuckets The bucket ids its weekly
 *   allowance has been recorded under.
 * @property {string} weeklyBucket The one of those the app itself writes to: a
 *   manual entry, or Fable's estimate.
 * @property {string} weeklyBucketName The name the app gives such a reading.
 */

/**
 * @template {string} Id
 * @template {string} Key
 * @template {string} Collector
 * @template {string | null} Host
 * @param {ProviderDefinition<Id, Key, Collector, Host>} definition
 */
function define(definition) {
  return Object.freeze(definition);
}

/**
 * Whether a model id belongs to a Claude model family, such as `opus`.
 * @param {string} name
 * @returns {ModelMatcher}
 */
export function claudeModelFamily(name) {
  const pattern = new RegExp(`^claude-${name}(?:-|$)`, 'i');
  return (model) => pattern.test(model || '');
}

// The Claude models the app knows by name: the ones a model-scoped limit can
// be labelled with, and the ones the Fable estimate has a weight for.
export const CLAUDE_MODEL_IDS = Object.freeze(/** @type {const} */ ([
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5',
]));

export const CODEX = define({
  id: 'codex',
  snapshotKey: 'codex',
  label: 'Codex',
  kind: 'codex',
  visibilitySetting: 'showCodexSubscription',
  sharesAllowanceWith: null,
  allowanceShare: 1,
  collector: 'codex',
  ledgerSource: 'codex',
  ledgerModelLike: null,
  // Spark is metered separately. Its tokens remain in the ledger but cannot
  // explain movement in the main Codex allowance or increase its capacity.
  countsModel: (model) =>
    !/^gpt-5\.3-codex-spark(?:$|-(?:\d{8}|\d{4}-\d{2}-\d{2})$)/i.test(typeof model === 'string' ? model.trim() : ''),
  weeklyScope: 'overall',
  cachedInputInsideInput: true,
  // Codex can use primary and secondary for either duration, so the main and
  // the weekly lists are the same; callers that mean weekly check the duration.
  mainBuckets: Object.freeze(['codex:primary', 'codex:secondary', 'codex:weekly']),
  scopeDecidesMain: false,
  mainLimitId: 'codex',
  weeklyBuckets: Object.freeze(['codex:weekly', 'codex:primary', 'codex:secondary']),
  weeklyBucket: 'codex:weekly',
  weeklyBucketName: 'Weekly',
});

export const CLAUDE = define({
  id: 'claude',
  snapshotKey: 'claude',
  label: 'Claude',
  kind: 'claude',
  visibilitySetting: 'showClaudeSubscription',
  sharesAllowanceWith: null,
  allowanceShare: 1,
  collector: 'claude',
  ledgerSource: 'claude',
  ledgerModelLike: null,
  countsModel: () => true,
  weeklyScope: 'overall',
  cachedInputInsideInput: false,
  mainBuckets: Object.freeze(['seven_day', 'five_hour']),
  scopeDecidesMain: true,
  mainLimitId: null,
  weeklyBuckets: Object.freeze(['seven_day']),
  weeklyBucket: 'seven_day',
  weeklyBucketName: 'Weekly',
});

export const FABLE = define({
  id: 'claude-fable',
  snapshotKey: 'fable',
  label: 'Fable',
  kind: 'fable',
  visibilitySetting: CLAUDE.visibilitySetting,
  sharesAllowanceWith: CLAUDE.id,
  // Fable's cap is half the overall weekly allowance: spending all of Fable is
  // spending half the week.
  allowanceShare: 0.5,
  collector: CLAUDE.collector,
  ledgerSource: CLAUDE.ledgerSource,
  // The two rules below have never been the same test. Queries over the ledger
  // (cycle history, Fable activity, the estimate) take any model whose name
  // contains "fable"; the token-capacity estimate takes the claude-fable family.
  ledgerModelLike: 'fable',
  countsModel: claudeModelFamily('fable'),
  weeklyScope: 'model',
  cachedInputInsideInput: CLAUDE.cachedInputInsideInput,
  mainBuckets: Object.freeze(['fable_seven_day', 'fable:seven_day_fable']),
  // Claude's collector marks a Fable limit as model-scoped, which describes its
  // place inside Claude's subscription; among Fable's own windows it is the main one.
  scopeDecidesMain: false,
  mainLimitId: null,
  weeklyBuckets: Object.freeze(['fable_seven_day', 'fable:seven_day_fable']),
  weeklyBucket: 'fable_seven_day',
  // One allowance covers Fable 5 and Fable 5.1; Claude reports it as "Fable".
  weeklyBucketName: 'Fable weekly',
});

// In display order, which is also the order the snapshot lists them in.
export const PROVIDERS = Object.freeze([CODEX, CLAUDE, FABLE]);

/** @typedef {typeof PROVIDERS[number]} Provider */
/** @typedef {Provider['id']} ProviderId A subscription as the database and the collectors name it. */
/** @typedef {Provider['snapshotKey']} SnapshotKey A subscription as a snapshot and the renderer name it. */
/** @typedef {Provider['collector']} CollectorId A collector, and its lane in the collector service. */
/** @typedef {typeof CLAUDE_MODEL_IDS[number]} ClaudeModelId */

/** @type {ReadonlyMap<unknown, Provider>} */
const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
/** @type {ReadonlyMap<unknown, Provider>} */
const bySnapshotKey = new Map(PROVIDERS.map((provider) => [provider.snapshotKey, provider]));

/**
 * The provider with this database id. A value that is known to be an id
 * always finds one; anything else may not.
 * @overload
 * @param {ProviderId} id
 * @returns {Provider}
 */
/**
 * @overload
 * @param {unknown} id
 * @returns {Provider | undefined}
 */
/** @param {unknown} id */
export function providerById(id) {
  return byId.get(id);
}

/**
 * The provider a snapshot lists under this key.
 * @overload
 * @param {SnapshotKey} key
 * @returns {Provider}
 */
/**
 * @overload
 * @param {unknown} key
 * @returns {Provider | undefined}
 */
/** @param {unknown} key */
export function providerBySnapshotKey(key) {
  return bySnapshotKey.get(key);
}

/**
 * @param {unknown} value
 * @returns {value is ProviderId}
 */
export function isProviderId(value) {
  return byId.has(value);
}

/**
 * @param {unknown} value
 * @returns {value is SnapshotKey}
 */
export function isSnapshotKey(value) {
  return bySnapshotKey.has(value);
}

/**
 * The provider whose weekly allowance this one draws on, or null when its
 * allowance is its own.
 * @param {Provider} provider
 * @returns {Provider | null}
 */
export function allowanceHost(provider) {
  return provider.sharesAllowanceWith == null ? null : providerById(provider.sharesAllowanceWith);
}

/**
 * The id a recorded allowance change is filed under for this source: the
 * owner of the weekly allowance it draws on. An id nobody registered is its own.
 * @param {string | undefined} sourceId
 */
export function allowanceFamily(sourceId) {
  return providerById(sourceId)?.sharesAllowanceWith ?? sourceId;
}

/**
 * The source_id this source's tokens are recorded under in usage_events.
 * An id nobody registered is its own, and has no tokens.
 * @param {string} sourceId
 */
export function ledgerSourceOf(sourceId) {
  return providerById(sourceId)?.ledgerSource ?? sourceId;
}

// Asked once per usage event by the cost analytics, so it is a set lookup.
/** @type {ReadonlySet<unknown>} */
const cachedInsideInput = new Set(PROVIDERS.filter((provider) => provider.cachedInputInsideInput).map((provider) => provider.ledgerSource));

/**
 * Whether a usage event recorded under this ledger source counts its cached
 * input inside its input. Then the uncached part is input minus cached, and
 * cached can never exceed input.
 * @param {unknown} ledgerSource
 */
export function cachedInputInsideInput(ledgerSource) {
  return cachedInsideInput.has(ledgerSource);
}

/**
 * Whether a bucket of this source is one its weekly allowance is recorded
 * under. The duration is the caller's to check.
 * @param {string | undefined} sourceId
 * @param {string | undefined} bucketId
 */
export function isWeeklyBucket(sourceId, bucketId) {
  const provider = providerById(sourceId);
  // Also asked about a reading that names no bucket, which is in no list.
  return provider !== undefined && bucketId !== undefined && provider.weeklyBuckets.includes(bucketId);
}

/**
 * Whether a `limitId` is some provider's own name for its main allowance.
 * @param {unknown} limitId
 */
export function isMainLimitId(limitId) {
  return limitId != null && PROVIDERS.some((provider) => provider.mainLimitId === limitId);
}

/**
 * Whether a window is a subscription's own allowance, from its bucket id and
 * its metadata alone: bucket ids are disjoint across providers, so no source
 * id is needed. Manual and older restored readings may lack a limit id or a
 * scope; the bucket lists stand in.
 * @param {string} bucketId
 * @param {{ limitId?: unknown, scope?: unknown }} metadata
 */
export function isMainBucket(bucketId, metadata) {
  if (isMainLimitId(metadata.limitId)) return true;
  if (PROVIDERS.some((provider) => !provider.scopeDecidesMain && provider.mainBuckets.includes(bucketId))) return true;
  if (metadata.scope) return metadata.scope === 'overall';
  return PROVIDERS.some((provider) => provider.scopeDecidesMain && provider.mainBuckets.includes(bucketId));
}

/**
 * The setting that shows or hides a subscription, by either id it is known
 * by. Anything else reads Claude's setting, as it always has: the rule used
 * to be "Codex's switch for Codex, Claude's for everything else".
 * @param {unknown} idOrKey
 */
export function visibilitySettingFor(idOrKey) {
  return (providerBySnapshotKey(idOrKey) ?? providerById(idOrKey) ?? CLAUDE).visibilitySetting;
}
