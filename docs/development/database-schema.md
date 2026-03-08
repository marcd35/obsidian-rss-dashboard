# RSS Dashboard SQLite Schema Reference

This document outlines the SQLite database structure used by the RSS Dashboard plugin. The database file is located at `rss-dashboard.sqlite` in the plugin directory.

## Configuration

- **Journal Mode**: WAL (Write-Ahead Logging)
- **Foreign Keys**: Enabled (`PRAGMA foreign_keys=ON`)
- **Current Schema Version**: 3

## Tables

### `meta`

Stores plugin-level metadata and schema versioning.

| Column  | Type | Constraints | Description                                                       |
| :------ | :--- | :---------- | :---------------------------------------------------------------- |
| `key`   | TEXT | PRIMARY KEY | Unique identifier for the metadata entry (e.g., `schema_version`) |
| `value` | TEXT |             | The value associated with the key                                 |

### `feeds`

Contains information about subscribed RSS feeds.

| Column                 | Type    | Constraints         | Description                                   |
| :--------------------- | :------ | :------------------ | :-------------------------------------------- |
| `url`                  | TEXT    | PRIMARY KEY         | The canonical URL of the feed                 |
| `title`                | TEXT    | NOT NULL            | Display title of the feed                     |
| `folder`               | TEXT    | NOT NULL DEFAULT '' | Folder path for organization                  |
| `last_updated`         | INTEGER | NOT NULL DEFAULT 0  | Timestamp of last successful scan             |
| `author`               | TEXT    |                     | Default author for the feed                   |
| `media_type`           | TEXT    | DEFAULT 'article'   | Type of content (article, video, audio)       |
| `auto_detect`          | INTEGER | DEFAULT 0           | Boolean flag for auto-detection logic         |
| `custom_template`      | TEXT    |                     | Custom Liquid/Markdown template for this feed |
| `custom_folder`        | TEXT    |                     | Override folder for saved articles            |
| `custom_tags`          | TEXT    |                     | JSON string of tags to apply to new articles  |
| `auto_delete_duration` | INTEGER | DEFAULT 0           | Days to keep articles before purging          |
| `max_items_limit`      | INTEGER | DEFAULT 25          | Maximum articles to store per feed            |
| `scan_interval`        | INTEGER | DEFAULT 0           | Minutes between automatic scans               |
| `icon_url`             | TEXT    |                     | URL for the feed's favicon/icon               |
| `filters`              | TEXT    |                     | JSON string of filtering rules                |

### `articles`

Stores individual feed items and their states.

| Column            | Type    | Constraints               | Description                                  |
| :---------------- | :------ | :------------------------ | :------------------------------------------- |
| `id`              | INTEGER | PRIMARY KEY AUTOINCREMENT | Internal unique ID                           |
| `guid`            | TEXT    | NOT NULL                  | Unique identifier from the feed              |
| `feed_url`        | TEXT    | NOT NULL, FK              | Reference to `feeds.url` (ON DELETE CASCADE) |
| `title`           | TEXT    | NOT NULL DEFAULT ''       | Article title                                |
| `link`            | TEXT    | NOT NULL DEFAULT ''       | Direct link to the content                   |
| `description`     | TEXT    | DEFAULT ''                | Short description/summary                    |
| `content`         | TEXT    | DEFAULT ''                | Full article content/HTML                    |
| `pub_date`        | TEXT    | DEFAULT ''                | Publication date string                      |
| `author`          | TEXT    | DEFAULT ''                | Article author                               |
| `summary`         | TEXT    | DEFAULT ''                | AI or manual summary                         |
| `cover_image`     | TEXT    | DEFAULT ''                | URL for the cover image                      |
| `read`            | INTEGER | NOT NULL DEFAULT 0        | Boolean flag for read status                 |
| `starred`         | INTEGER | NOT NULL DEFAULT 0        | Boolean flag for starred status              |
| `saved`           | INTEGER | NOT NULL DEFAULT 0        | Boolean flag for local save status           |
| `saved_file_path` | TEXT    |                           | Path to the local Markdown file if saved     |
| `media_type`      | TEXT    | DEFAULT 'article'         | Media type (video, podcast, etc)             |
| `video_id`        | TEXT    |                           | ID for YouTube/Video platforms               |
| `video_url`       | TEXT    |                           | Direct video URL                             |
| `audio_url`       | TEXT    |                           | Direct audio/podcast URL                     |
| `duration`        | TEXT    |                           | Duration string                              |
| `enclosure`       | TEXT    |                           | JSON string for RSS enclosure metadata       |

> [!NOTE]
> There is a UNIQUE constraint on `(feed_url, guid)` to prevent duplicate articles from the same source.

### `folders`

Manages hierarchical folder organization.

| Column        | Type    | Constraints               | Description                                                     |
| :------------ | :------ | :------------------------ | :-------------------------------------------------------------- |
| `id`          | INTEGER | PRIMARY KEY AUTOINCREMENT | Internal unique ID                                              |
| `name`        | TEXT    | NOT NULL                  | Folder name                                                     |
| `parent_id`   | INTEGER | FK                        | Reference to `folders.id` (Self-referential, ON DELETE CASCADE) |
| `created_at`  | INTEGER |                           | Creation timestamp                                              |
| `modified_at` | INTEGER |                           | Last modification timestamp                                     |
| `pinned`      | INTEGER | DEFAULT 0                 | Boolean flag for pinned status                                  |

### `article_tags`

Join table for many-to-many relationship between articles and tags.

| Column       | Type    | Constraints | Description                                    |
| :----------- | :------ | :---------- | :--------------------------------------------- |
| `article_id` | INTEGER | FK          | Reference to `articles.id` (ON DELETE CASCADE) |
| `tag_id`     | INTEGER | FK          | Reference to `tags.id` (ON DELETE CASCADE)     |

### `tags`

Defines available tags and their presentation.

| Column  | Type    | Constraints                | Description        |
| :------ | :------ | :------------------------- | :----------------- |
| `id`    | INTEGER | PRIMARY KEY AUTOINCREMENT  | Internal unique ID |
| `name`  | TEXT    | UNIQUE NOT NULL            | Tag name           |
| `color` | TEXT    | NOT NULL DEFAULT '#3498db' | Hex color code     |

## Indexes

To optimize performance, the following indexes are maintained:

- `idx_articles_feed_url` on `articles(feed_url)`
- `idx_articles_read` on `articles(read)`
- `idx_articles_starred` on `articles(starred)`
- `idx_articles_pub_date` on `articles(pub_date)`
- `idx_feeds_folder` on `feeds(folder)`

## Maintenance

The `DatabaseService` performs periodic maintenance:

- `VACUUM` is run during storage compaction.
- `PRAGMA integrity_check` is performed on initialization.
- `PRAGMA optimize` is run before saving after maintenance.

## Schema Update Rules

To ensure database stability and backward compatibility, follow these rules when updating the schema:

### 1. Versioning

- Increment the `SCHEMA_VERSION` constant in `src/services/database.ts` for every change.
- Never reuse a version number.

### 2. Migration Procedure

- Implement all migrations within the `migrateSchema` method in `DatabaseService`.
- Use `try...catch` blocks for `ALTER TABLE` statements to handle cases where a user might have a partially migrated database.
- Always update the `meta` table's `schema_version` after a successful migration using `setSchemaVersion`.

### 3. Additive Changes Only

- **Prefer additive changes**: Use `ALTER TABLE ... ADD COLUMN ...` rather than modifying or deleting existing columns.
- **SQLite Limitations**: Remember that SQLite has limited `ALTER TABLE` support. Renaming columns or changing types often requires recreating the table.
- If a table MUST be recreated:
  1. Rename the old table (e.g., `feeds_old`).
  2. Create the new table with the desired schema.
  3. Copy data: `INSERT INTO feeds SELECT ... FROM feeds_old`.
  4. Drop the old table: `DROP TABLE feeds_old`.

### 4. Data Integrity

- Maintain `FOREIGN KEY` constraints and `CASCADE` behaviors.
- Ensure all new columns have sensible `DEFAULT` values or allow `NULL` to avoid breaking existing inserts.
- Update the documentation in `docs/development/database-schema.md` in the same PR as the schema change.

### 5. Verification

- Test migrations from at least one version prior to the new version.
- Verify that `PRAGMA integrity_check` returns `ok` after migration.

## Migration History

### Version 3 (2026-03-08)

- **Changes**:
  - Normalized tag storage into `article_tags` join table and introduced numeric `id` for `tags`.
  - Removed `tags` column from `articles`.
- **Rationale**: Eliminated data duplication in article rows and enabled efficient, atomic tag renames/color updates across the entire library.

### Version 2 (2026-03-04)

- **Changes**:
  - Added `icon_url` column to `feeds` table.
  - Added `filters` column to `feeds` table.
- **Rationale**: Required for visual feed identification (icons) and advanced content filtering features.

### Version 1 (2026-02-28)

- **Changes**: Initial schema implementation.
- **Rationale**: Transitioned from JSON-based `data.json` storage to SQLite for improved performance, scalability, and data integrity.
