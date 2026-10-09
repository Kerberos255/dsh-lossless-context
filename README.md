# Lossless Context for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

A **hierarchical context-compaction and retrieval backend** for DSH. Keep the native session history intact while building traceable summary nodes and allowing agents to retrieve their original supporting text.

## Features

- Uses the native DSH compaction transaction; the plugin does **not** replace or delete source session logs.
- Summarizes bounded, tool-call-safe event groups into a layered source DAG.
- Exposes `lcm_grep`, `lcm_describe`, `lcm_expand`, and `lcm_expand_query` for authorized session-local retrieval.
- Adapts headroom and output budgets to the **actual selected model**, with bounded retries for truncated summaries.
- Can prepare reusable summary leaves during idle maintenance without committing compaction.
- Optionally rotates eligible owner-verified Discord/Feishu direct-message sessions after a verified [Dream & Memory](https://github.com/Kerberos255/dsh-memory-dreaming) handoff.

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

## Safety, storage, and tests

The plugin stores **derived indexes** under DSH's data directory, not a second complete conversation history. Invalid, cancelled, oversized or truncated summaries are not committed. Private-channel auto-rotation requires verified owner/workspace bindings and completed Dream evidence; ordinary desktop/group/unverified sessions are not silently moved.

Run `npm test` for portable policy/regression tests. Real compaction and summary quality require an active model and DSH host. Example settings: [config.example.json](config.example.json). Historical notes: [CHANGELOG.md](CHANGELOG.md).

Related: [Dream & Memory](https://github.com/Kerberos255/dsh-memory-dreaming) · [Channel Core](https://github.com/Kerberos255/dsh-channel-core).

MIT licensed. See [LICENSE](LICENSE).
