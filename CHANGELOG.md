# Changelog · Lossless Context

Historical behavior notes moved out of README so the entry points do not need edits for every release.

- **Native compaction integration:** selected context is summarized with native transactional commit, source event pointers and resumable retrieval.
- **Trusted direct-message rotation:** checks Dream report integrity, owner identity, workspace, native session cursor and channel receipt state before moving bindings.
- **Adaptive headroom:** bounds model safety margin using the actual model context window and configured limits.
- **Idle precomputation:** can prepare leaves during native maintenance, with cancellation and bounded cache; a later compaction reuses matching leaves when possible.
- **Bounded summary output retries:** may enlarge output budgets after recognized truncation without committing incomplete results.

See Git history for exact versions and commits. For current configuration, read [README.md](README.md) / [简体中文](README.zh-CN.md).
