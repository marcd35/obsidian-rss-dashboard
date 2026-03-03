# AI API Key Storage Security Plan

## Goal

Replace plaintext API-key persistence with a layered secret-storage design: default to non-persistent/session keys, use OS keychain on desktop when available, and use encrypted-at-rest fallback for environments without keychain support.

## Steps

1. Confirm current exposure points and lock scope.
2. Document current behavior for maintainers based on `saveData(this.settings)` and Import/Export behavior.
3. Define a `SecretStore` abstraction with `set/get/delete` and provider keys (`openai`, `openrouter`, `claude`).
4. Implement storage backends:

- Desktop secure backend (OS keychain if runtime supports it).
- Encrypted fallback backend for unsupported platforms.

5. Add a session-only mode (default) where keys are memory-only and never persisted.
6. Migrate settings schema so `aiSummary` no longer stores raw `openaiApiKey`, `openrouterApiKey`, `claudeApiKey`; store metadata only (for example `hasStoredKeyByProvider`).
7. Refactor AI settings UI to read/write keys through `SecretStore`, and remove plaintext reveal behavior (or gate behind explicit action).
8. Update Import/Export to exclude secrets by default and optionally include encrypted secret payload only when explicitly requested.
9. Add one-time migration: if plaintext keys are found in `data.json`, import into secure backend, wipe plaintext fields, save settings immediately.
10. Add tests for migration, backend selection, failure handling, and ensuring exports exclude plaintext keys.
11. Add user-facing docs and in-app copy clarifying storage mode and platform tradeoffs.

## Relevant Files

- `main.ts`: load/save pipeline (`loadSettings`, `saveSettings`) and migration hook location.
- `src/settings/settings-tab.ts`: AI key input UI and Import/Export handlers.
- `src/services/ai-summary-service.ts`: runtime key retrieval (`getApiKeyForProvider`) to switch to secret accessor.
- `src/types/types.ts`: settings schema updates.
- `test_files/unit/ai-summary-service.test.ts`: tests for secure retrieval and migration behavior.
- `README.md`: security disclosure and platform behavior documentation.

## Verification

1. Configure a provider key, restart Obsidian, verify summaries work and `data.json` contains no plaintext keys.
2. Export `data.json`, verify no plaintext key material is present.
3. Run `npm run test:unit`, including focused tests for migration and backend fallback behavior.
4. Simulate missing keychain/encryption backend, verify session-only mode or encrypted fallback with clear user messaging.
5. Validate desktop and mobile behavior separately to confirm no silent downgrade to plaintext.

## Decisions

- Primary storage location: OS keychain/credential vault on desktop when available.
- Fallback storage: encrypted secret blob managed by plugin, never raw key fields in settings JSON.
- Default posture: session-only (non-persistent) unless the user explicitly enables persistent secret storage.
- Included scope: AI provider API keys only.
- Excluded scope: unrelated settings hardening.

## Open Decisions

1. Persistence default:

- Option A: session-only by default (recommended).
- Option B: remember key by default for convenience.

2. Backup behavior:

- Option A: never export secrets (recommended).
- Option B: explicit "include encrypted secrets" checkbox.

3. Mobile strategy:

- Option A: encrypted fallback only (recommended).
- Option B: disallow persistent storage on mobile and enforce session-only.
