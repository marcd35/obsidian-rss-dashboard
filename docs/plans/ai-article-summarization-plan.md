# Plan: AI Article Summarization (MVP → Enhanced Roadmap)

## TL;DR

Add **user-initiated** AI summarization for articles in RSS Dashboard, integrated into existing article actions and reader actions. Ship a safe MVP first (single provider gateway), then expand to direct OpenAI, direct Claude, and Kilo Gateway integrations through a provider-adapter architecture. Include a hard global disable path for anti-AI users and a dedicated settings panel with privacy/cost controls.

## Implementation Status (Completed)

The following scope has been implemented in code:

1. **Settings and schema foundation**
   - Added `aiSummary` settings block to `RssDashboardSettings` with defaults and migration-safe initialization.
   - Added article-level AI summary metadata fields (`aiSummaryText`, provider/model/timestamp/error fields).

2. **Service layer**
   - Added `src/services/ai-summary-service.ts` with provider dispatch for:
     - OpenRouter (`/chat/completions`)
     - OpenAI (`/chat/completions`)
     - Claude (`/v1/messages`)
     - Kilo Gateway (`/chat/completions`)
   - Added prompt templating and input truncation.

3. **User-triggered UX integration**
   - Added summarize action to article toolbar and article context menu.
   - Added summarize action to reader header actions.
   - Added dashboard handler to persist generated summaries.
   - Added reader inline rendering of generated AI summary.

4. **Settings panel integration**
   - Added new `AI` settings tab with:
     - global enable toggle,
     - provider selector,
     - model input,
     - API key input,
     - prompt template editor,
     - max input/output controls,
     - timeout,
     - test connection button.

5. **Validation status**
   - `npm run build` passes with current implementation.

## Next Blade (Recommended Implementation Slice)

### Blade A — Security hardening + provider correctness

1. Replace plaintext API key storage with Obsidian `SecretStorage` + `SecretComponent`.
2. Keep only secret-name reference in plugin settings.
3. Add provider-specific validation:
   - OpenAI recommendation: Responses API compatibility mode decision.
   - Claude schema validation for message/content response shapes.
   - OpenRouter/Kilo model naming guardrails.
4. Add standardized provider error mapping (auth, quota, timeout, model not found).

### Blade B — UX governance and anti-AI controls

1. Add explicit `hide AI UI when disabled` behavior.
2. Add one-click clear of all generated AI summaries.
3. Add privacy toggles:
   - include/exclude URL,
   - include/exclude full content,
   - persist/non-persist generated summaries.

### Blade C — Test expansion and reliability

1. Add service-level unit tests for each provider response parser and failure mode.
2. Add integration tests for callback wiring (list → dashboard update path).
3. Add snapshot-less UI behavior tests for disabled-state rendering.

### Blade D — Feature depth

1. Add `regenerate summary` action.
2. Add save/export options (append summary to saved note template).
3. Add cost/rate limits and per-day request cap.

---

## Product Goals

1. Let users manually trigger summaries per article (no automatic background summarization in MVP).
2. Keep UX consistent with existing toolbar/context menu patterns.
3. Preserve summaries in plugin state (`data.json`) for continuity.
4. Support strict opt-out/disable for users who do not want AI features.
5. Build architecture once so adding providers is incremental.

---

## Feasibility Summary

This is feasible with current Obsidian plugin APIs and current RSS Dashboard architecture.

### Why it is feasible

- Obsidian supports HTTP requests without browser CORS restrictions via `requestUrl`.
- Plugin settings can store per-feature configuration and are already well-established in this codebase.
- Current article-level action hooks already exist in list/card/reader/context menu flows.
- Existing save/update patterns (`updateArticleStatus`, `saveSettings`) can persist generated summaries.

### Key technical note about "Obsidian CLI login"

- Obsidian does expose CLI handler registration in plugin API (`registerCliHandler`), but CLI-based login/auth is not required for a practical MVP.
- Recommended path:
  - MVP: settings-based credentials (prefer SecretStorage).
  - Optional later: CLI helpers for key setup/testing.

---

## Existing Architecture Fit (Natural Insertion Points)

### UI insertion points

1. `src/components/article-list.ts`
   - `createArticleActionButtons(...)` for toolbar button/icon.
   - `showArticleContextMenu(...)` for right-click menu action.
2. `src/views/reader-view.ts`
   - Reader header action area (`.rss-reader-actions`) for summarize action.
3. `src/views/dashboard-view.ts`
   - Callback wiring point where `ArticleList` handlers are connected.

### Persistence and state flow

- `src/types/types.ts`
  - Extend `FeedItem` with AI summary metadata.
  - Extend `RssDashboardSettings` with AI settings block.
- `main.ts`
  - Migrate/load defaults and ensure backward compatibility.
  - Persist through existing `saveSettings()` workflow.

### Networking pattern reuse

- Existing services already use `requestUrl` robustly.
- New AI service should mirror current retry/error-notice conventions.

---

## Multi-Phase Delivery Plan

## Phase 0 — Design & Guardrails (Pre-MVP)

### Scope

- Finalize data model and provider abstraction contract.
- Define non-goals (no auto-summarize, no streaming UI in MVP).

### Deliverables

1. `AiSummarySettings` interface in `src/types/types.ts`.
2. `AiProviderAdapter` interface (service-level contract):
   - `summarize(input): Promise<SummaryResult>`
   - `validateConfig(): Promise<ValidationResult>`
3. Error taxonomy (auth, quota, timeout, network, parsing).

---

## Phase 1 — MVP (Gateway-first, user-initiated)

### Recommended MVP provider

- **OpenRouter** (single gateway, model-flexible, can route to GPT/Claude-family models).

### User experience

- User clicks "Summarize" icon/menu item.
- Button enters in-progress state (`summarizing`).
- Summary appears inline where article summary content already renders.
- Result persists after reload.

### Implementation

1. **Settings foundation**
   - Add AI block under plugin settings:
     - `enabled`
     - `provider = openrouter`
     - `model`
     - `apiKeySecretName` (preferred) or fallback plaintext key
     - `promptTemplate`
     - `maxInputChars`, `maxOutputTokens`, `timeoutMs`
     - `dailyBudgetSoftLimit` (optional)
2. **Service layer**
   - New file: `src/services/ai-summary-service.ts`
   - Build prompt from title/feed/source/description/content.
   - Truncate input safely by char budget.
   - Parse and normalize response.
3. **UI integration**
   - Add `onArticleSummarize` callback in article list callbacks.
   - Add action to toolbar + context menu + reader view.
4. **Persistence**
   - Add article summary metadata fields:
     - `aiSummaryText?`
     - `aiSummaryGeneratedAt?`
     - `aiSummaryProvider?`
     - `aiSummaryModel?`
     - `aiSummaryError?`

### MVP acceptance criteria

- Works desktop/tablet/mobile.
- Fails gracefully with Notice messages.
- No automatic calls unless user explicitly triggers.

---

## Phase 2 — Control Plane Hardening (Settings Panel + Disable AI)

### Core requirement: anti-AI users

Implement a **hard kill switch**:

- `ai.enabled = false` disables:
  - all summarize buttons/icons/menu entries,
  - all summarize commands,
  - all background AI jobs (if any later),
  - all outbound AI network calls.

### Additional UX for anti-AI users

- Optional `ai.uiVisibility = hidden | visible-disabled`.
- If `hidden`, AI controls do not render anywhere.
- If `visible-disabled`, disabled controls show explanatory tooltip.

### New settings panel specification (comprehensive)

Add top-level settings section: **AI Summaries**

1. **Master Controls**
   - `Enable AI summaries` (global toggle)
   - `Hide all AI UI when disabled` toggle
2. **Provider**
   - Provider dropdown: OpenRouter, OpenAI, Claude, Kilo Gateway (future providers can be appended)
   - Model input/dropdown (provider-aware)
3. **Authentication**
   - Preferred: `SecretComponent` + `SecretStorage` secret name selector
   - Fallback option (if needed): plain key field with warning
   - `Test connection` button
4. **Prompt & Output**
   - Prompt template editor
   - Summary style preset (`brief`, `bullets`, `key takeaways`, `custom`)
   - Max output tokens/length
5. **Safety & Budget**
   - Timeout ms
   - Retries count
   - Daily soft cap (requests or spend estimate)
   - Confirmation before expensive model calls (optional)
6. **Data & Privacy**
   - "Store generated summaries in data.json" toggle
   - "Include full article content in prompt" toggle
   - "Send article URL to provider" toggle
7. **Diagnostics**
   - Last request status
   - Last provider/model used
   - Last error summary

---

## Phase 3 — Provider Expansion (OpenAI + Claude + Kilo)

### Architecture approach

Keep one core service orchestrator and add provider adapters:

- `src/services/ai/providers/openrouter-adapter.ts`
- `src/services/ai/providers/openai-adapter.ts`
- `src/services/ai/providers/claude-adapter.ts`
- `src/services/ai/providers/kilo-gateway-adapter.ts`

Shared types:

- `SummaryRequest`
- `SummaryResult`
- `ProviderConfig`
- `ProviderError`

### Benefits

- Same UI and state path regardless of provider.
- Easy A/B or fallback routing in future.
- Mobile/desktop UX remains identical.

---

## Phase 4 — Enhanced UX and Mobile/Tablet Optimization

### Mobile/tablet behavior

Use existing toolbar strategies and avoid crowded button rows.

1. If mobile toolbar is `minimal`, prioritize context menu summarize action.
2. For `bottom-row`, keep icon-only summarize action with existing sizing conventions.
3. Maintain touch-target accessibility and avoid overflow regressions.
4. Preserve existing responsive behavior around 768px breakpoints.

### UX improvements

- Optional tiny inline status chip: `Summarized • 2m ago`.
- `Regenerate summary` menu item.
- `Copy summary` and `Append to saved note` actions.

---

## Phase 5 — Advanced Features (Future)

1. **Batch summarize selected articles** with queue and cancel support.
2. **Auto-summarize on save** (opt-in only, default off).
3. **Prompt presets per feed/folder**.
4. **Structured output mode** (JSON schema -> render bullets/highlights).
5. **Cost telemetry dashboard** (per provider/model usage in settings).
6. **Background worker/queue service** with retry policy and exponential backoff.
7. **Per-provider fallback chain** (e.g., provider/model failover).

---

## Security and Privacy Plan

### MVP minimum

- Prefer Obsidian SecretStorage for API credentials.
- If plaintext fallback is offered, show explicit warning in UI.

### Recommended baseline

1. Do not log full prompts/responses by default.
2. Redact tokens/API keys in all errors.
3. Add explicit consent text that external AI providers receive prompt content.
4. Let users disable inclusion of article body and/or URL.

---

## Integration with Existing Codebase (Concrete)

### Files to add

- `src/services/ai-summary-service.ts`
- `src/services/ai/providers/*.ts` (from Phase 3 onward)

### Files to modify

- `src/types/types.ts`
  - settings + `FeedItem` summary metadata
- `main.ts`
  - settings migration/defaults and optional commands
- `src/settings/settings-tab.ts`
  - AI settings section and provider/auth controls
- `src/components/article-list.ts`
  - summarize toolbar/context action wiring
- `src/views/dashboard-view.ts`
  - summarize callback handler and persistence
- `src/views/reader-view.ts`
  - reader action wiring
- `styles.css` or `src/styles/*`
  - minimal visual states (`summarizing`, `summary-error`)

---

## Risks and Mitigations

1. **UI crowding on mobile**
   - Mitigation: context-menu-first on minimal toolbar mode.
2. **Unexpected provider response shapes**
   - Mitigation: strict parser/validator and normalized adapter results.
3. **Credential handling concerns**
   - Mitigation: SecretStorage-first + clear fallback warnings.
4. **Cost surprises**
   - Mitigation: model labels, budget limits, optional confirmation prompt.
5. **Anti-AI trust concerns**
   - Mitigation: hard global disable and full UI removal option.

---

## Recommended Release Sequence

1. **vNext (MVP)**: OpenRouter only, manual summarize, inline persistence, hard disable toggle.
2. **vNext+1**: OpenAI + Claude direct adapters, connection test UX, improved diagnostics.
3. **vNext+2**: Kilo Gateway adapter, provider fallback, usage insights.
4. **vNext+3**: batch/automation features (still opt-in).

---

## Verification Checklist

1. Enable AI, summarize one article from:
   - list toolbar,
   - article context menu,
   - reader action bar.
2. Reload plugin; confirm generated summary persists.
3. Turn global AI off; confirm all AI controls disappear/disable and no calls are sent.
4. Test invalid key, timeout, and network failure; confirm clean user Notices.
5. Validate mobile and tablet layouts for overflow/regression.
6. Run `npm run build`.

---

## Reference URLs (Research)

### Obsidian

- Plugin API: https://docs.obsidian.md/Reference/TypeScript+API/Plugin
- `requestUrl`: https://docs.obsidian.md/Reference/TypeScript+API/requestUrl
- SecretStorage API: https://docs.obsidian.md/Reference/TypeScript+API/SecretStorage
- Store secrets guide: https://docs.obsidian.md/plugins/guides/secret-storage
- Build plugin guide: https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin

### OpenRouter

- API overview: https://openrouter.ai/docs/api-reference/overview
- OpenAPI spec (YAML): https://openrouter.ai/openapi.yaml
- OpenAPI spec (JSON): https://openrouter.ai/openapi.json

### OpenAI

- Responses API resource: https://developers.openai.com/api/reference/resources/responses
- API authentication overview: https://developers.openai.com/api/reference/overview#authentication
- Text guide: https://developers.openai.com/api/docs/guides/text

### Claude (Anthropic)

- Messages API: https://platform.claude.com/docs/en/api/messages
- API quickstart: https://platform.claude.com/docs/en/docs/quickstart
- API errors: https://platform.claude.com/docs/en/api/errors

### Kilo / Kilo Gateway

- Kilo docs home: https://kilo.ai/docs
- Kilo Gateway overview: https://kilo.ai/docs/gateway
- Kilo Gateway quickstart: https://kilo.ai/docs/gateway/quickstart
- Kilo Gateway API reference: https://kilo.ai/docs/gateway/api-reference
- BYOK: https://kilo.ai/docs/getting-started/byok

---

## Recommendation Summary

Best architectural fit for your codebase:

1. Implement a provider-agnostic adapter layer now (even if only one adapter ships first).
2. Ship OpenRouter as MVP provider to reduce initial integration complexity.
3. Add global hard-disable AI controls in the first release (trust + governance).
4. Use SecretStorage from day one if possible.
5. Keep all summarization user-initiated and visible in existing action surfaces.

This yields a low-risk MVP while keeping a clean path to OpenAI, Claude, and Kilo integrations in enhanced versions.
