# Costs

This page is for anyone reading the cost figures in AI Usage. It explains how recorded tokens become API-equivalent costs, which models have built-in prices and how pricing rules apply, the task and sub-agent breakdown, the other Details views, and the optional estimates for Claude desktop and web chats.

## What the figures are

These values are token-only comparisons, not provider invoices. They do not claim to include untracked tool charges, web-search charges, storage, taxes, subscription fees, or usage performed on another device that did not reach the local ledger. USD is the ledger currency; GBP and EUR use the manually saved display conversion rate and are not updated from a live foreign-exchange feed.

## Token API-equivalent costs

The Details screen reconstructs token API-equivalent value from local input, output, cache-write, and cache-read records. Reasoning tokens are retained as an informational subset of output and are never billed twice. Claude five-minute and one-hour cache writes are stored and priced separately.

Every selected historical period is recalculated with the current local price-catalogue row for each model; earlier tariff versions are not reconstructed, so editing a row intentionally reprices the displayed history.

Historical costs, tasks, sessions, and CSV exports include records through the current moment. Records dated in the future remain stored and enter those totals when their timestamp is reached.

The **Costs** search filters model and project summaries and searches every recorded session in the selected period. Session results are paginated, and the filter is retained when switching sections. The default session order is highest API-equivalent value first.

## Pricing and the catalogue

Costs include every model present in the imported Codex and Claude Code token records. Opus 5.5, Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5, Haiku 5.5, and Haiku 4.5 already have built-in prices alongside Astra, GPT-6.1 Sol, GPT-6.1 Terra, Sol, Terra, Luna, Fable 5.2, Fable 5.1 and Fable 5.

### Claude models

- [Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview), released on 9 November 2026, costs $8 input, $10 five-minute cache writes, $16 one-hour cache writes, $0.20 cache reads and $40 output per million tokens, four fifths of Fable 5.1's rates, across its full 1M context window.
- Fable 5.1 differs from Fable 5 only in cache reads, $0.25 rather than $1 per million tokens.
- Sonnet 5.5 differs from Sonnet 5 only in cache reads, $0.10 rather than $0.20 since 7 October 2026.
- [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), released on 7 October 2026, is priced by prompt length: a request whose prompt (uncached input, cache reads and cache writes) is 100,000 tokens or fewer costs $0.10 input, $0.125 five-minute cache writes, $0.20 one-hour cache writes, $0.01 cache reads, and $0.50 output per million tokens, and a longer request pays five times each of those rates, output included. Settings shows the first set of rates; the longer-prompt rates are five times whatever is saved there.

### OpenAI models

GPT-6.1 Sol differs from GPT-6 Sol only in cached input, $0.10 rather than $0.20. The built-in rates are:

- Astra is included in the built-in catalogue at standard API rates of $10 input, $1 cached input, $12.50 cache writes, and $50 output per million tokens, verified against [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) on 4 September 2026.
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) adds $2 input, $0.20 cached input, $2.50 cache writes, and $10 output; [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) adds $0.10 input, $0.01 cached input, $0.125 cache writes, and $0.50 output per million tokens, verified on 22 September 2026.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) adds $2 input, $0.10 cached input, $2.50 cache writes, and $10 output per million tokens, verified on 1 October 2026.
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), released on 26 October 2026, adds $1 input, $0.05 cached input, $1.25 cache writes, and $5 output per million tokens, verified on 30 October 2026.

OpenAI GPT-6.1 Sol and Terra, GPT-6 Astra, Sol, and Luna, and GPT-5.6 Sol, Terra, and Luna requests over the published 272,000-input-token threshold use the long-context multipliers, including cached prompt input when determining whether the threshold is crossed. Above the threshold, input and cache rates double and output rates increase by 50%.

These are standard API-equivalent estimates, not ChatGPT subscription charges.

### How a model is matched to a price

- A model is priced by its own catalogue row or a dated snapshot of it (such as `-20251001`); a point release such as a future `claude-fable-5-3` shows as unpriced until it has a row, rather than borrowing its predecessor's price.
- Unknown or future model names are not assigned a guessed price: their tokens remain visible, price coverage drops, and totals are labelled **At least** until you add the missing row.
- Existing token records are repriced automatically when the new catalogue loads, and saved custom prices are preserved.

### Price coverage

Regular Claude desktop and web chats can consume the same account allowance but do not appear in the token ledger. A missing model row can therefore mean missing activity records rather than missing pricing. **Price coverage measures only recorded tokens**: 100% does not establish complete account activity coverage. Those chats can be estimated separately; see [Claude desktop and web chat estimates](#claude-desktop-and-web-chat-estimates).

## Tasks and sub-agents

The Costs screen now includes **Tasks & sub-agents**. Expand a row to see the main-agent and sub-agent API-equivalent totals, recorded agent count, each agent/model's uncached input, cache reads, cache writes, output (including reasoning), usage-record count, and first-to-last activity span. Search includes task/session IDs, agent IDs, names, roles, models, and projects. A model switch adds a row without counting the same agent twice. Totals use the existing per-event pricing and currency settings; unknown prices remain unpriced or lower bounds.

### How usage is attributed

- Codex records are grouped by the recorded root turn ID (or a main thread's turn ID) when available. Parent/root session metadata links child and nested agent usage.
- Claude transcripts use their agent ID or the `session/subagents/agent-ID.jsonl` layout, with legacy `agent-ID.jsonl` support.
- When task attribution is absent, the UI explicitly shows a **session breakdown**; it does not infer task boundaries or read prompts to invent names.
- Unlinked child usage remains separate from identified turns. Legacy records without usable agent metadata stay **unattributed**.
- For older Codex logs without a root session ID, ancestry can only be followed through parent links present in the selected period.
- Agent counts include only agents with recorded usage, not every agent spawned.
- Activity span includes idle time and is not execution duration; a single record has no measurable span.

On the next normal collection, each eligible local log is re-read once to backfill structural attribution, using the existing event keys to update rather than duplicate usage. Subsequent scans resume incrementally. Logs no longer available locally retain their existing costs and may remain unattributed. No prompts or response content are added to the ledger. The browser preview includes clearly labelled sample task breakdowns.

## Other Details views

The Details screen also groups the ledger **by project**, using the working directory each Codex or Claude session ran in, and shows **reset cycles**: the peak percentage each past allowance window reached and what that window's tokens are worth today.

**Export CSV…** writes the ledger for the last 30, 90, or 365 local calendar days, the same days as the dashboard's analysis period, with the per-record API-equivalent, and **Copy summary** puts a plain-text version of every allowance on the clipboard.

Details also shows the **cache hit rate** (the share of prompt tokens read from cache), **recent totals** (today, the last seven days against the seven before, month to date, and a straight-line projection for the month), and **when the work happens**, an hour-by-weekday heatmap of API-equivalent cost.

With monthly subscription fees entered under **Settings → Subscriptions → Monthly fees**, the Overview adds a **subscription value** figure: how many times over the period's API-equivalent value covers the fees for the same number of days. It compares; it never charges. Without fees, the Overview offers an **Add fees** link to that setting instead.

## Claude desktop and web chat estimates

### Importing

In Claude, request **Settings → Privacy → Export data**, download the export, and extract its ZIP. In AI Usage, open **Costs → Claude desktop & web chat estimates → Import Claude export…**, then select `conversations.json` (up to 64 MB / 200,000 messages).

Up to 128 distinct model labels can be stored across chat imports and restored estimates, keeping previews and dashboard tables bounded. Review the detected models and missing-data counts before saving. This is a manual import; repeat it with a newer export to add subsequent replies. Desktop and web chats cannot be distinguished by this importer.

### Models

Only the model attached to an individual reply is used. A conversation-level model is not applied to older replies because models can change mid-chat. Missing models stay unknown and unpriced by default.

You may explicitly select a catalogue model as a pricing assumption for all missing-model replies in that import; those rows are labelled **User assumption** separately from **From export** rows. Named models with no catalogue price appear in **Settings → API pricing**, where you can supply prices; their chat estimates are then recalculated separately from recorded usage totals.

### How the estimate is made

The estimate divides visible prompt/reply Unicode character counts by four, rounding each up, and prices them at the current input/output rates. It counts only the immediate human prompt (the explicit human parent for branched replies), not repeated context from earlier turns. Text blocks take precedence over the duplicate convenience `text` field. System prompts, caching, attachments, images, tool content and hidden reasoning are excluded.

This is a rough **visible-text value**, not actual subscription consumption or a reconstructed API bill; accuracy varies by language and content. Missing prompts and omitted content are flagged. All estimates remain outside recorded costs, token-ledger CSVs, quota calibration, and forecasts.

### What is stored

Parsing runs locally in the storage worker. AI Usage persists only opaque hashed reply keys, dates, model evidence/assumptions, estimated counts and limitation flags, never conversation titles or text.

Identical replies are deduplicated across imports; existing estimates and assumptions are kept unchanged. To replace an assumption, use **Remove imported estimates…** (which creates a safety backup) and reimport. Both SQLite and `.aiusage.json` backups include estimates; restore merges them without replacing existing rows. Import previews expire after 30 minutes and save the reviewed counts even if the source file changes meanwhile.
