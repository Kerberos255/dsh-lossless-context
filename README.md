# Lossless Context for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

A **hierarchical context-compaction and retrieval backend** for DSH. Keep the native session history intact while building traceable summary nodes and allowing agents to retrieve their original supporting text.

## Features

- Uses the native DSH compaction transaction; the plugin does **not** replace or delete source session logs.
- Summarizes bounded, tool-call-safe event groups into a layered source DAG.
- Exposes one session-local model tool, `lcm_recall`, with `action: 'search'` (default), `action: 'describe'` (summary DAG), and `action: 'expand'` (raw source by sequence, DAG node, or query).
- Adapts headroom, target summary length and output budgets to the **actual selected model**; model failures, timeouts and truncated summaries are handled with bounded attempts and safe commit rules.
- Can prepare reusable summary leaves during idle maintenance without committing compaction.
- Optionally rotates eligible owner-verified Discord/Feishu direct-message sessions after a verified [Dream & Memory](https://github.com/Kerberos255/dsh-memory-dreaming) handoff; recent rotation failures are backed off rather than retried every idle turn.

## Task-end compaction and retained history

The default leaf **source input** chunk is **24,000 tokens** (not the completion cap). Successful, complete leaf and condensed summaries are cached in the derived local SQLite index for up to 7 days, capped at 128 per session / 512 globally and 128 KiB each. A failed multi-stage compaction never publishes an incomplete checkpoint; next retry or restart reuses fragments only when source content, model and summary settings match. The default per-request summarizer timeout is 240 seconds to allow slower valid merged summaries.


Normal pressure threshold checks now schedule **idle compaction after a completed turn**, while active turns only compact for imminent pressure or provider-confirmed context overflow. Both modes use the same `retainRatio` / `retainTokens` budget (including model-specific policies); a threshold such as 0.5 controls *when*, not how much recent text is retained.

The installed DSH RC.2 `compactNow` safety path did not expose a retained-tail parameter. The bundled MIT-licensed, narrowly adapted native helper adds that argument and otherwise preserves the native idle maintenance, complete tool-pair boundaries, durable transaction, cancellation, and checkpoint flushing. It must be reviewed again when updating DSH; see `native/SOURCE.md`.

A provider can advertise a very high absolute `maxTokens` ceiling. Proactive emergency compaction now uses a bounded output forecast, rather than treating that entire ceiling as the expected next completion. It targets near-window pressure while preserving the native context-overflow recovery path; exceptionally long generations can still exceed the forecast. Idle compaction retries a temporarily busy native maintenance slot up to three times, only while the agent is idle.

Transport errors and truncated summaries use separate bounded retries; timeout and output budgets are independently configurable. A successful unit test does not substitute for a live model compaction test.

## Install and enable

Requires a compatible DSH host with its native session, token-meter and compaction services. See [package.json](package.json) for peer dependencies.

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-lossless-context
```

Then open **Settings → Plugins → Lossless Context**, enable the backend, and choose the `dsh-lossless-context/agent` compaction backend for the agent preset that should use it. Installing the settings plugin alone does not guarantee that every preset uses this backend. Restart when changing plugin code or preset composition.

## How it works

```text
Native session events
  → native compaction selection
  → bounded summary leaves → merged summary DAG
  → native commit (only on success)
  → searchable index with references to source event IDs
```

The current session keeps its native record. Retrieval and expansion resolve back to original source events. Model/provider limits and existing policies control thresholds; unavailable model metadata causes a safe error instead of invented budgets.

### Idle preparation

When the deferred timing is enabled, an idle agent may summarise the next compactable segment **before** compaction is needed and keep the result in the summary cache. A later commit then reuses those results instead of calling the model again. The work is bounded: at most two model calls per idle pass, at most three passes per uninterrupted idle period, and it stops as soon as the agent receives a message.

Preparation and commit share the same payload builders (`leafPayload`, `condensedPayload`, `groupLayer`), so a warmed cache entry always matches the key the commit computes. A summary layer that cannot shrink is reported as `lcm-condensed-summary-does-not-fit` and ends the pass instead of retrying the same request.

Diagnostics separate the two sources of cache hits: `warm.completed` reports `cacheHits`/`warmHits` for idle preparation, while `compression.completed` reports `cacheHits`/`modelCalls`/`modelMs` for the commit itself.

## Safety, storage, and tests

The plugin stores **derived indexes** under DSH's data directory, not a second complete conversation history. Invalid, cancelled, oversized or truncated summaries are not committed. Private-channel auto-rotation requires verified owner/workspace bindings and completed Dream evidence; ordinary desktop/group/unverified sessions are not silently moved.

Run `npm test` for portable policy/regression tests. Real compaction and summary quality require an active model and DSH host. Example settings: [config.example.json](config.example.json). Historical notes: [CHANGELOG.md](CHANGELOG.md).

Related: [Dream & Memory](https://github.com/Kerberos255/dsh-memory-dreaming) · [Channel Core](https://github.com/Kerberos255/dsh-channel-core).

MIT licensed. See [LICENSE](LICENSE).

## Optional plugin diagnostics

The plugin optionally emits privacy-restricted operation and failure metadata to dsh-plugin-diagnostics. Diagnostics contain event type, status, fixed error code and elapsed time; conversation content and credentials are not logged. The diagnostics plugin is optional and does not change the host requirements.

## Editable compaction guidance

Leaf and merged summaries can include customizable default quality guidance emphasizing project decisions, exact file paths/configuration names, validation evidence, and task state changes. A **Restore default** button resets the setting. Guidance supplements the native compaction protocol: tool pairing, source retention, cancellation and complete-transaction checks are unchanged. Changes to the summary policy invalidate stale reusable leaves.
