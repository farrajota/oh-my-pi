# Changelog

## [Unreleased]

### Added

- Initial release: Chrome MV3 extension that lets the omp browser tool attach to and drive the user's existing tabs through `chrome.debugger`. The companion CDP relay lives in the omp CLI (`omp browser-relay`); this package builds the extension zip for GitHub releases and generates the embedded install assets consumed by `omp browser-relay install`. Tabs the agent actively drives are gathered into a per-window "omp" tab group while the relay is connected.

### Fixed

- Fixed duplicate "omp" tab groups: `group`/`ungroup` RPCs are now serialized in the service worker (Chrome's query→create→set-title sequence is not atomic), and `groupTabs` folds stray same-title groups left by earlier races back into the canonical per-window group. The omp group title is also mirrored to `chrome.storage.session`, so a service worker restarted between grouping and disconnect can still dissolve the group instead of leaving it behind.
