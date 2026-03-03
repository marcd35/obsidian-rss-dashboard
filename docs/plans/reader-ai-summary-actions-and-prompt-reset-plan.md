## Plan: Reader AI Summary Actions + Prompt Reset

Add summary action controls in reader view (delete, hide/collapse, edit) and a new edit-summary modal that can rerun generation with an overridden prompt template loaded from AI settings, plus add a settings-level reset action for the AI prompt template. Scope reflects your decisions: hide is session-only, delete clears all summary metadata fields, and saving edited prompts back to settings from the modal is skipped for now.

**Steps**

1. Phase 1 - Reader summary action surface (_foundational_): In `src/views/reader-view.ts`, refactor the `item.aiSummaryText` render block into a small summary section renderer that includes a header actions row with icon buttons for `trash`, `eye`/`eye-off`, and `pencil`.
2. In the same phase, add reader-local state for summary collapsed state keyed to current display session (non-persistent) and reset it when a different article is displayed in `displayItem(...)`.
3. Phase 2 - Delete + hide behavior wiring (_depends on 1_): Implement delete handler in `src/views/reader-view.ts` to clear `aiSummaryText`, `aiSummaryGeneratedAt`, `aiSummaryProvider`, `aiSummaryModel`, and `aiSummaryError`, propagate via `onArticleUpdate(..., true)`, and show a Notice.
4. Implement hide/collapse toggle in `src/views/reader-view.ts` as pure UI state (no persisted FeedItem changes), with accessible tooltips/aria labels and icon swap (`eye` when expanded, `eye-off` when collapsed).
5. Add summary action and collapsed styles in `src/styles/reader.css` for compact icon row, hover/active states, and hidden body class (for example, a class that hides the summary text paragraph when collapsed).
6. Phase 3 - Edit modal + rerun path (_depends on 1; parallel with step 5 after UI contract is fixed_): Create `src/modals/edit-ai-summary-modal.ts` as an Obsidian `Modal` that pre-fills a textarea from `settings.aiSummary.promptTemplate`, includes Cancel and Rerun buttons, and returns the edited prompt string when submitted.
7. Wire modal invocation from the reader summary edit button in `src/views/reader-view.ts`; on submit, call summarization using the same provider/model/key settings but with the modal’s prompt override, then persist generated summary fields back to the article via existing `onArticleUpdate` flow.
8. Extend `src/services/ai-summary-service.ts` to support prompt override without mutating global settings (recommended: add optional method parameter like `summarizeArticle(article, promptTemplateOverride?)` and route to prompt builder). Keep default behavior unchanged for existing call sites.
9. Add/extend tests in `test_files/unit/ai-summary-service.test.ts` for override behavior: verifies custom prompt template is used when provided and fallback to settings template still works.
10. Phase 4 - AI settings reset control (_parallel with phases 1-3 except final polish_): In `src/settings/settings-tab.ts`, add a small button row directly below the AI Prompt template textarea card using existing `rss-dashboard-template-btn-row`/`rss-dashboard-template-btn` pattern with a `Reset to default` action.
11. Implement reset handler to set `this.plugin.settings.aiSummary.promptTemplate = DEFAULT_SETTINGS.aiSummary.promptTemplate`, save settings, update textarea value (or call `this.display()`), and show a confirmation Notice.
12. Phase 5 - Integration validation + regression checks (_depends on all prior steps_): Validate summary actions in reader view across normal article flow and after rerender; ensure no regressions to summarize button loading state and settings persistence.

**Relevant files**

- `src/views/reader-view.ts` - summary rendering block, action button wiring, collapse state, delete handler, modal trigger, rerun integration.
- `src/services/ai-summary-service.ts` - add prompt-override entry point while preserving current API behavior.
- `src/modals/edit-ai-summary-modal.ts` - new modal for prompt override + rerun submit UX.
- `src/styles/reader.css` - styles for summary action toolbar and collapsed summary presentation.
- `src/settings/settings-tab.ts` - add AI prompt template reset button row and reset logic.
- `src/types/types.ts` - reuse `DEFAULT_SETTINGS.aiSummary.promptTemplate`; no schema change required for this scope.
- `test_files/unit/ai-summary-service.test.ts` - unit coverage for prompt override behavior.

**Verification**

1. Run unit tests with `npm test` (or project-standard vitest command) and confirm `test_files/unit/ai-summary-service.test.ts` passes with new override cases.
2. Manual reader test: open article with summary, click Hide (summary collapses), click Show (expands), click Delete (summary and metadata removed, section no longer shown).
3. Manual reader test: click Edit, confirm modal prefilled from AI settings prompt, modify prompt, click Rerun, confirm regenerated summary renders and article summary metadata updates.
4. Manual settings test: in AI tab edit prompt template, click `Reset to default`, confirm textarea restores to default prompt text exactly and persists after reopening settings.
5. Regression check: normal `Summarize with AI` button in reader still works when modal has never been used and when AI settings are disabled/enabled.

**Decisions**

- Hide/collapse is session-only UI state in reader view and is not persisted to article data.
- Delete clears all summary-related fields, not text-only.
- Modal-driven "save edited prompt as a new prompt in settings" is excluded for now (explicitly deferred).
- No changes to global data schema for this iteration.

**Further Considerations**

1. Deferred enhancement: add optional "Save to settings" CTA in edit modal later, likely gated by explicit button instead of automatic save.
2. UX polish option: include generated timestamp/provider subtitle in summary header for visibility after reruns.
3. If future persistence is desired, collapsed state can be stored per-article via a lightweight UI preference map outside `FeedItem`.
