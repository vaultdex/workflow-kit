# Ponytail provenance

The six sibling `ponytail*` skill packages and shared `.agents/hooks/ponytail-*.js` derive from
[DietrichGebert/ponytail 4.10.0](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156),
commit `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`.
Copyright (c) 2026 DietrichGebert; [MIT license](LICENSE.md) applies to all skills and hooks.

Vaultdex adaptations: remove the core's host-specific `argument-hint` metadata;
reuse required repository tests; make help accurate for checkout discovery and hooks;
scan secrets before debt content, exclude vendored skills, include existing
`watchdog:` markers and keep findings in the issue workflow; pin gain sources and
label their figures as historical upstream results. Other content is unchanged
apart from line-ending normalization. All six host skill copies must match.

Hook adaptations: native project manifests run an explicitly installed user-local
snapshot, resolve the Git root for state isolation and pass the host explicitly.
Missing snapshots emit setup guidance without executing checkout code. Runtime
state is separated by checkout and host in the user's Ponytail
config directory instead of sharing another installation's flag. The activation
hook omits global statusline setup and personal Claude-settings reads. Other hook
logic is upstream; no npm dependency or runtime download is added.
