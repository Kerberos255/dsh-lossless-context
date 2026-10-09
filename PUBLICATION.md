# Public source release

This is the standalone source distribution for dsh-lossless-context.
Only plugin source and example configuration belong here. Do not commit user
sessions, credentials, databases, or a full DSH installation.

Requires a compatible DeepSeek Harness host providing the peer services from package.json.
The CI runs host-free tests; a passing result does not imply real Discord, Feishu, or browser integration.
The included client code is already generated, so standard installation needs no generator.
Replace <DSH_ROOT> in legacy documentation examples with your DSH install path.
Upstream third-party dependencies retain their own licenses.

Host-dependent integration test: `tests/rotation-config.test.mjs` imports the DSH Typert SDK. Run it inside a compatible DSH development/profile environment; it is intentionally outside standalone CI.

UI generation: node tools/settings/build.mjs (full rebuild requires matching DSH host packages).

Local-first performance optimization synchronized on 2026-10-08 from DSH plugin source 0.1.11. Changes: fewer repeated SQLite prepares; fresh Channel Core identity bindings are still checked on every recall. Regression tests were run against the local DSH SDK before this public-source sync.

## 0.1.16 · 2026-10-09

- Model-window-aware automatic compaction headroom (default 10% capped at 65536 tokens); the fixed option and explicit model overrides remain available. Concurrency-safe invocation-scoped native policy and matching prewarm cache key.
- Idle prewarming triggers before the effective native pressure threshold; model-safe input and output budgets; visibility into prewarm state, errors and actual leaf-cache hit rate.
- Default first summary budget 16384, retry ceiling 32768, two truncation retries. Existing user configuration is never overwritten on install. New input-splitting logic respects actual model input capacity and complete tool pairs.
- Synthetic 480-event offline replay: 8K/12K/16K chunk budgets require 11/7/6 leaf calls respectively, but this is **not** a measured model quality, latency or cost A/B; default leaf budget remains 8K.
- Host-free public tests check budget bounds and source pairing; DSH native integration tests remain local to the host development environment.
