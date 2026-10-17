# Vendored DSH BasicCompactionEngine

Original package: @deepseek-ai/dsh-compaction-basic 0.2.1-rc.2
Source: officially installed DSH app.asar (RC.2); SHA256 b7ac52f20a36430cf01a66b3a36f23a48ffdb22708d714dbe1fff541b5df4ec5
License: MIT (see LICENSE.dsh-compaction-basic).

Modification: add a fourth optional `retainTokens` argument to `compactNow` and
pass that number to the existing native `selectCompactableRange`. All native
`agent.runMaintenance`, durable compaction lifecycle, tool pair validation,
flush, cancellation and error handling remain untouched. Existing callers
continue to use the original zero-retention default.

Update policy: regenerate with tooling/refresh-lcm-native-20261017.mjs against
the newly installed DSH release, review the diff and run retention contract tests.
The generator fails closed if the host ABI no longer matches.
