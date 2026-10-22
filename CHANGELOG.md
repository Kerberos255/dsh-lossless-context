# Changelog · Lossless Context

Historical behavior notes moved out of README so the entry points do not need edits for every release.

- **Native compaction integration:** selected context is summarized with native transactional commit, source event pointers and resumable retrieval.
- **Trusted direct-message rotation:** checks Dream report integrity, owner identity, workspace, native session cursor and channel receipt state before moving bindings.
- **Adaptive headroom:** bounds model safety margin using the actual model context window and configured limits.
- **Idle precomputation:** can prepare leaves during native maintenance, with cancellation and bounded cache; a later compaction reuses matching leaves when possible.
- **Bounded summary output retries:** may enlarge output budgets after recognized truncation without committing incomplete results.

See Git history for exact versions and commits. For current configuration, read [README.md](README.md) / [简体中文](README.zh-CN.md).

## Unreleased · project/task memory and editable prompts

- Add editable summary-quality guidance to leaf and merge compaction while preserving native transactional safety.

## 0.1.32 – 0.1.36 · summary envelope, shared payload builders, externalised large blocks

- Share one set of pure payload builders (`leafPayload`, `condensedPayload`, `groupLayer`) between idle preparation and the committed compaction, so a warmed cache entry always matches the key the commit computes.
- Bound idle preparation to three campaigns per idle period and stop cleanly when a summary layer cannot shrink (`lcm-condensed-summary-does-not-fit`), instead of retrying the same request.
- Separate idle cache hits (`warmHits`) from commit hits, and report `prepareMs`/`leafCount`/`branchCount`/`modelCalls`/`modelMs` on `compression.completed`.
- Deliver summaries inside a `<summary>` envelope carrying `id`, `kind`, `depth`, `sources` and `descendants`; unknown metadata is omitted rather than invented, and the recall hint now lives inside the envelope.
- Externalise text blocks larger than `largeFileCharsThreshold` (default 60000 characters, 0 disables) to `lcm-files/<session>/<file_id>.txt`, replacing them with a content-addressed reference; a failure keeps the original input instead of dropping content.
- Extend `lcm_recall` with a `files` scope: `search` scans externalised excerpts, `describe` returns a file record, `expand` reads stored text by offset. No additional tool was introduced.
- Keep the standalone test suite runnable without the workspace settings page: those cases skip instead of failing when `_shared/plugin-settings` is absent.
- Match `%`/`_` in file excerpts with an explicit `ESCAPE` clause, escape `&` and `<` in envelope attributes, and document `largeFileCharsThreshold` in the example configuration.
