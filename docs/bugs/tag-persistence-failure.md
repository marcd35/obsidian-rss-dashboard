# Bug Report: Tag Persistence Failure from Article Card/Reader View Submenu

## Issue Description

Tags created or modified through the inline "Add tag" submenu within article cards (Dashboard) or the Reader View are frequently lost upon application restart or when switching views. While the article-tag association might partially persist in the database, the tag is missing from the global "Available Tags" list in settings.

## Root Causes

1.  **Stale Settings References**:
    - Many components (`RssDashboardView`, `Sidebar`, `ReaderView`, `ArticleList`) capture a reference to `plugin.settings` in their constructor.
    - When `plugin.loadSettings()` is called (e.g., at startup or during a data import), it replaces the plugin's `settings` property with a new object: `this.settings = Object.assign(...)`.
    - Existing view instances continue to point to the **old** settings object, meaning any pushes to `availableTags` or changes to filters are invisible to the rest of the app and the persistence layer.

2.  **Missing Persistence Call in Reader View**:
    - `ReaderView.ts` implements tag creation but only calls `this.onArticleUpdate()`. It does **not** call `plugin.saveSettings()`.
    - Consequently, the global `availableTags` list in the SQLite database (controlled by `saveAllTags`) is never updated with the new tag definition.

3.  **Destructive Synchronization**:
    - `saveAllTags(tags: Tag[])` in `database.ts` uses a "sync" strategy where it deletes any tags from the database that are not present in the provided list.
    - If a view with a stale/incomplete settings reference triggers a save (e.g., via a background timer or an unrelated settings change), it will actively delete newly created tags from the DB because they are missing from its stale in-memory list.

## Attempted Fixes (Prior to this report)

- Normalized tag storage with a join table.
- Replaced `DELETE ALL` with `UPSERT` in `saveAllTags` to preserve article-tag associations during overwrites.
- Verified that `upsertArticle` inserts tags into the `tags` table upon association.

## Proposed New Solution

### 1. Unified Settings Access

- Modify all components to use a getter or always access `plugin.settings` directly to ensure they always have the latest reference.
- Alternately, implement a `onSettingsUpdate` event that components subscribe to for re-syncing their local references.

### 2. Standardize Persistence

- Ensure `ReaderView` calls a standard persistence method (like `onPersistSettings`) when modifying global state (like adding/editing tags).

### 3. Defensive Tag Syncing

- Modify `upsertArticle` to ensure it always captures the current tag color/metadata from memory even if the tag is "new" to that article.
- Update `saveSettings` to be more unified across all views.

## Verification Plan

1. Add a tag in Reader View, verify it appears in Dashboard Tags list immediately.
2. Restart Obsidian and verify the tag is still in the "Available Tags" section.
3. Rename the tag in Dashboard, verify it updates in all views and persists after restart.
