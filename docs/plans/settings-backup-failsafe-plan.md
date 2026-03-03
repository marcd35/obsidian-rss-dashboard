# Plan: Settings Backup Failsafe Implementation

## TL;DR

Implement automatic backups of user settings (excluding article/feed data) to a separate JSON file (`settings.backup.json`) on critical operations. Add a manual restore button in settings UI to recover settings if `data.json` corrupts. Scope: settings-only, single rolling backup file, manual recovery. Interim solution until major version data storage overhaul.

---

## Decisions

- **Scope:** Settings-only and Feed Folder backup (sidebar). Excludes feed articles/items to minimize file size and storage overhead
- **Timing:** Backup should only be created on explicit events located within Scope above
- **Frequency:** On-demand on specific events (feed/settings changes), not every article state toggle
- **Retention:** Single backup file (overwrite pattern) for simplicity; can upgrade to rolling backups later
- **Recovery:** Manual UI button (safest for interim solution; avoids auto-recovery bugs that could wipe data)
- **Failsafe philosophy:** Backup is a _temporary_ holdover—not a replacement for proper data storage architecture redesign in next major version
- **Backup file schema versioning** — `settings.backup.json` should include a `_version` key to handle future settings structure changes

---

## Steps

### Phase 1: Backup Storage Infrastructure (Foundation)

1. **Create backup service module** `src/services/settings-backup-service.ts`
   - `backupSettings(settings: RssDashboardSettings): Promise<void>` — write backup to plugin directory
   - `restoreSettings(): Promise<RssDashboardSettings | null>` — read backup file, return parsed settings
   - `deleteBackup(): Promise<void>` — cleanup backup file
   - _Depends on: understanding plugin API for file writes (use Obsidian's adapter pattern like saveData)_

2. **Add backup file path constant** to `main.ts` or settings
   - Filename: `settings.backup.json` (stored in `.obsidian/plugins/rss-dashboard/`)
   - Use Obsidian's `adapter.write()` API (same as saveData but manual control)

3. **Extract backup-eligible settings from data.json**
   - Determine what constitutes "settings" vs "feed data"
   - Create a filtered type/function that excludes: `feeds[].items[]`, `feeds[].lastUpdated`
   - Keep: feed metadata (title, URL, folder), all display/filter/media/article saving settings, tags
   - Result: ~5-10KB per backup vs 100KB+ for full data

### Phase 2: Backup Trigger Integration (Write Calls)

4. **Patch `saveSettings()` in main.ts** to trigger backup
   - After successful `saveData(this.settings)` call
   - Silently backup settings (no user-facing spinners—background operation)
   - Catch backup errors and log to console (don't interrupt main save)
   - _Depends on step 1_

5. **Identify selective trigger points** (avoid over-writing)
   - Backup on: feed add/edit/delete, settings UI save, folder operations, tag add/remove
   - Don't backup on: each article refresh read-status toggle (too frequent)
   - Implement simple rate-limiting flag or event-based decoration on `saveSettings()`
   - _Depends on: understanding current save call frequency in dashboard-view.ts vs settings-tab.ts_

### Phase 3: Recovery UI (Manual Restore Interface)

6. **Add restore button to settings UI** in `src/settings/settings-tab.ts`
   - New section: "Data Recovery" near existing Export/Import buttons
   - Button text: "Restore from Settings Backup"
   - Show backup file timestamp/size in UI (use file metadata)
   - Behavior:
     - Show confirmation modal (warn: overwrites current settings)
     - Call `restoreSettings()`, merge into current settings, call `saveSettings()`
     - Show success notice or error message
   - _Depends on step 1_

### Phase 4: Validation & Error Handling

7. **Add validation on backup load**
   - Parse backup JSON safely (try/catch)
   - Validate against schema (check for required top-level properties)
   - If invalid, show error notice + refuse restore
   - Log warnings for missing/unexpected properties

8. **Add backup integrity check on plugin load**
   - Optional: log backup file size/timestamp to console for debugging
   - Consider (future): auto-detect if data.json is corrupt and show recovery prompt

---

## Relevant Files

- **New:** `src/services/settings-backup-service.ts` — backup/restore logic
- **Modify:** main.ts (L1481) — `saveSettings()` to call backup after successful save
- **Modify:** src/settings/settings-tab.ts (L1628) — add restore UI button near export/import
- **Reference:** main.ts (L1259-L1330) — `loadSettings()` pattern for restore logic
- **Reference:** src/settings/settings-tab.ts (L1628-L1695) — export/import button pattern to mirror

---

## Verification

1. **Manual backup creation:**
   - Add a feed, edit settings UI, verify `settings.backup.json` exists in plugin folder
   - Inspect backup: confirm it contains settings but NOT article items
   - Verify backup file is ~5-10KB, not 100KB+

2. **Restore flow:**
   - Manually edit `data.json` to corrupt a setting (e.g., delete `displaySettings` key)
   - Re-enable plugin or reload Obsidian
   - Click "Restore from Settings Backup" button
   - Verify corrupted setting is restored and functional

3. **Backup silencing:**
   - Toggle article read status 10 times in dashboard
   - Confirm backup file timestamp is NOT constantly updating (backup should only trigger on settings changes, not every article toggle)

4. **Error cases:**
   - Delete `settings.backup.json` and click restore → should show error "no backup found"
   - Corrupt the backup JSON and click restore → should show error "invalid backup file"

5. **UI fidelity:**
   - Restore button placement/styling matches export/import buttons
   - Confirmation modal is clear about consequences
   - All success/error notices are user-friendly

---
