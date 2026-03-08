# Sync & Persistence Incident Report: Resolving Data Loss

## 1. Executive Summary

This report documents the identification and resolution of a critical data loss issue related to Obsidian Sync and tag persistence. The incident was characterized by several failure modes: local state desynchronization (stale references), synchronization race conditions (recursive reload loops), and asynchronous shutdown interruption.

## 2. Technical Root Causes (Resolved)

### A. Stale Settings References

The plugin's `loadSettings()` method originally replaced `this.settings` with a new object literal. However, active Views (Sidebar, Reader, Dashboard) held references to the _initial_ object. Modifications made in those views were never seen by the plugin when calling `saveSettings()`.
**Fix**: Switched to in-place `Object.assign(this.settings, ...)` updates.

### B. Vault Watcher Race Condition (The "Disappearing Tag" Bug)

The vault watcher intercepted local writes as external changes because the `isWritingToSettings` flag was cleared before Obsidian's asynchronous filesystem event reached the event loop. The plugin would then reload "stale" JSON data (which lacks tags) over the newly created in-memory tags.
**Fix**: Implemented 2000-3000ms guard timers (`settingsWriteTimeout`) to bridge the gap between file write completion and watcher event firing.

### C. The "Shutdown Race"

The `onunload()` method used a fire-and-forget async IIFE for database syncing. Obsidian terminates the plugin environment immediately after `onunload` returns, often killing the file-write process before the SQLite data hit the disk.
**Fix**: Refactored `onunload()` to be synchronous, using a new `DatabaseService.saveSync()` method to force a blocking binary flush.

### D. Redundant Database Re-Initialization

`loadSettings()` was recreating the `DatabaseService` on every call, including those triggered by simple JSON setting changes. This orphaned pending writes and caused unnecessary disk I/O.
**Fix**: Implemented a singleton pattern for the database service and a `reloadUserSettingsOnly()` method for JSON-only updates.

## 3. Refactor Implemented on 2026-03-08

The latest refactor changed the persistence architecture, but did **not** fully resolve the two user-visible issues below.

### E. Canonical Tag Mutation Path Refactor

**What Changed**:
- Added plugin-owned mutation helpers for article patches and tag mutations in `main.ts`.
- Routed reader, dashboard article list, sidebar tag actions, and settings tag actions through those helpers instead of direct `availableTags` mutation plus ad hoc saves.
- Introduced immediate persistence helpers so article and tag mutations use `db.forceSave()` plus `saveSettingsOnly()` instead of the older delayed write pattern.
- Unified the saved-article path with the same immediate article persistence flow to remove the special `scheduleSave()` case.

**Why This Was Done**:
- The previous design mixed article-scoped writes with global tag-registry edits.
- That made tag persistence dependent on which UI surface initiated the change.
- The goal of the refactor was to make one canonical path responsible for mutating in-memory state and persisting the matching SQLite scope.

### F. Folder Path Cache Removal

**What Changed**:
- Removed the long-lived sidebar folder-path cache.
- Replaced it with a pure folder-path derivation helper computed from the live folder tree.
- Removed stale cache-reset calls that were previously required before some renders.

**Why This Was Done**:
- The old cache could lag behind folder creation or import flows.
- The intent was to make sidebar rendering derive directly from current state rather than from cache invalidation timing.

## 4. Existing Behavior After the Refactor

The following issues still reproduce after the refactor:

### G. Folder Creation Still Does Not Appear Immediately in the Sidebar

**Current Behavior**: Creating a new folder from the sidebar still does not reliably make that folder appear immediately in the visible sidebar tree.

**What The Refactor Changed**:
- The stale folder-path cache was removed, so the previous cache-invalidation explanation is no longer sufficient on its own.

**Current Interpretation**:
- Folder creation is still spread across multiple flows (`ensureFolderExists`, sidebar-local add-folder methods, import flows, and dashboard refresh paths).
- The remaining bug now appears to be in the render/update sequencing after folder mutation, not in cached folder-path derivation.

### H. Multi-Tag Assignment Still Fails in Practice

**Current Behavior**: It is still not possible to reliably add more than one tag to an article.

**What The Refactor Changed**:
- Tag operations now go through canonical mutation helpers and immediate persistence.
- This addressed the original registry/article drift problem, but did not fully stabilize the active tag-management UI.

**Current Interpretation**:
- The remaining issue is now likely in the interaction between tag mutation callbacks, article/view refresh timing, and the current item/article references held by the open UI.
- In other words: persistence scope was corrected, but repeated tag assignment in the same interaction still behaves incorrectly.

## 5. Timeline of Resolution

| Phase                | Activities                                                                                                               |
| :------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **Detection**        | User reported tags disappearing after restart.                                                                           |
| **Analysis**         | Audit identified stale object references and missing persistence hooks in `ReaderView`.                                  |
| **Hardening**        | Introduced sync guards, in-place settings updates, and synchronous shutdown flushes.                                     |
| **SQLite Migration** | Moved tags and feeds to SQLite to avoid JSON payload limits and sync conflicts.                                          |
| **Targeted Refactor**| Replaced split tag mutation paths with canonical plugin-owned helpers and removed stale sidebar folder-path caching.      |
| **Current State**    | **Status: Partially resolved.** The architecture changed, but folder visibility and multi-tag assignment still fail.      |

---

**Status**: Partial Refactor Applied; User-Visible Issues Persist
**Date**: 2026-03-08
**Verification**: Build and unit tests passed, but manual behavior still reproduces the sidebar-folder and multi-tag issues
