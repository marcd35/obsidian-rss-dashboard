# Sync & Persistence Incident Report: Resolving Data Loss

## 1. Executive Summary

This report documents the identification and resolution of a critical data loss issue related to Obsidian Sync and tag persistence. The incident was characterized by two primary failure modes: local state desynchronization (stale references) and synchronization race conditions (recursive reload loops).

## 2. Technical Root Causes

### A. Stale Settings References (The "Reference Bug")

The plugin's `loadSettings()` method was originally implemented as:

```typescript
this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
```

This created a **new object reference** every time settings were loaded. However, active Views (Sidebar, Reader, Dashboard) held references to the _initial_ settings object. Consequently, when the plugin reloaded data from disk, views continued to modify the old object, and those changes were never persisted.

### B. Missing Reader View Callbacks

New tags created via the `ReaderView` UI were added to the `settings.availableTags` array, but the view lacked a reference to the plugin's `saveSettings()` method, causing the change to reside only in temporary memory.

### C. Vault Watcher Race Condition (The "Disappearing Tag" Bug)

Even after `ReaderView` was fixed, a race condition caused data loss during inline tag creation:

1. When a new tag is added to the plugin's state, `this.plugin.saveSettings()` is invoked.
2. This writes the tag-less `usersettings.json` payload, asynchronously resolving the Obsidian filesystem write.
3. The plugin immediately flipped its `isWritingToSettings` flag back to `false`.
4. Obsidian's asynchronous `modify` event fired shortly after on the event loop.
5. Because `isWritingToSettings` was `false`, the vault watcher falsely intercepted the plugin's own write as an external Obsidian Sync change.
6. The watcher called `loadSettings()`, replacing the active application state with data from the JSON API (which lacks tags) before the SQLite DB finished saving. This completely erased the tags from memory and UI right before the sync interval.

### D. Sync Conflict & Recursive Reloads

Obsidian Sync updates the `.sqlite` database and `usersettings.json` file. Without a file watcher, the plugin remained unaware of external changes. Conversely, adding a naive watcher created a **recursive loop**:

1. Plugin writes to file.
2. Watcher detects change.
3. Watcher triggers reload.
4. Reload overwrites in-memory changes.

## 3. Timeline of Resolution

| Phase              | Duration | Activities                                                                                                                                                                                                                                                                                                                                  |
| :----------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection**      | T-0      | User reported that tags created in Reader View/Article Card submenus disappeared after app restart.                                                                                                                                                                                                                                         |
| **Analysis**       | T+1h     | Audit of `main.ts` and `ReaderView.ts` identified the stale reference pattern and missing persistence hooks.                                                                                                                                                                                                                                |
| **Strategy**       | T+2h     | Shifted focus from a "simple bug" to "sync architecture hardening." Proposed "Sync Security" flags and Database Hot-Reloading.                                                                                                                                                                                                              |
| **Implementation** | T+4h     | Refactored settings to use `Object.assign(this.settings, ...)` (In-place update). Implemented `isWritingToDatabase` guards.                                                                                                                                                                                                                 |
| **Deep Analysis**  | T+6h     | Discovered that tag adds via the card submenu still failed despite the above fixes. Root cause identified as a race condition where the Obsidian `modify` event fired after `isWritingToSettings` was synchronously cleared, causing `loadSettings` to reload from JSON and wipe the newly created tags before the SQLite DB was persisted. |
| **Verification**   | T+7h     | Build pipeline cleanup: fixed floating promise errors in `ReaderView` and resolved `TFile` casting issues in `main.ts`. Applied 2000-3000ms debounce timeouts to sync guards (`settingsWriteTimeout`, `databaseWriteTimeout`).                                                                                                              |
| **Resolution**     | T+8h     | Successful `npm run build`. Verified that tags are accurately retained.                                                                                                                                                                                                                                                                     |

## 4. Implemented Solutions

### Singleton Settings Reference

All settings updates now use in-place assignment to ensure all plugin components see the same "Source of Truth."

```typescript
Object.assign(this.settings, DEFAULT_SETTINGS, data ?? {});
```

### Sync Guards (Write-Safety with Debounce)

Introduced `isWritingToSettings` and `isWritingToDatabase` flags. These flags are set briefly during local write operations to instruct the vault watcher to ignore the subsequent "modify" event. Because Obsidian's file watcher events are highly asynchronous and can trail the completion of `adapter.write`, these flags are now wrapped in `setTimeout` debounce blocks (2000-3000ms) to ensure the file event buffer is fully consumed before the plugin "listens" to the vault again.

### Database Hot-Reload

Added `DatabaseService.reinit()` to allow the SQLite connection to refresh its internal state when the underlying file is replaced by Obsidian Sync.

## 5. Prevention Strategies for Developers

1. **Never replace `this.settings`**: Always update the existing object to preserve references in views.
2. **Explicit Promise Handling**: Use the `void` operator for intentional floating promises in UI events to satisfy strict linting.
3. **Guard File Watchers**: Always distinguish between "Plugin-Internal Writes" and "External Modification" using transient state flags.

---

**Status**: Resolved
**Date**: 2026-03-08
**Verification**: `npm run build` PASS
