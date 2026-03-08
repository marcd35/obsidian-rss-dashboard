import {
  Plugin,
  Notice,
  WorkspaceLeaf,
  setIcon,
  Setting,
  Platform,
  requireApiVersion,
} from "obsidian";

import {
  RssDashboardSettings,
  DEFAULT_SETTINGS,
  Feed,
  FeedItem,
  FeedMetadata,
  FeedFilterSettings,
  Tag,
} from "./src/types/types";
import { DatabaseService } from "./src/services/database";
import { MigrationService } from "./src/services/migrator";

import { RssDashboardSettingTab } from "./src/settings/settings-tab";
import {
  RssDashboardView,
  RSS_DASHBOARD_VIEW_TYPE,
} from "./src/views/dashboard-view";
import {
  DiscoverView,
  RSS_DISCOVER_VIEW_TYPE,
} from "./src/views/discover-view";
import {
  KagiSmallwebView,
  RSS_SMALLWEB_VIEW_TYPE,
} from "./src/views/kagi-smallweb-view";
import { ReaderView, RSS_READER_VIEW_TYPE } from "./src/views/reader-view";
import {
  FeedParser,
  formatFeedParseNoticeMessage,
  getFeedErrorMessage,
} from "./src/services/feed-parser";
import { ArticleSaver } from "./src/services/article-saver";
import { AutoTagService } from "./src/services/auto-tag-service";
import { OpmlManager } from "./src/services/opml-manager";
import { MediaService } from "./src/services/media-service";
import { sleep, setCssProps } from "./src/utils/platform-utils";
import { ImportOpmlModal } from "./src/modals/import-opml-modal";
import {
  deleteTagFromSettings,
  ensureTagExists,
  findTagByName,
  toggleTagOnArticle,
  updateTagColorInSettings,
  updateTagInSettings,
} from "./src/utils/tag-utils";
import {
  persistArticleMutation,
  persistTagMutation,
} from "./src/services/mutation-persistence";

export interface FiltersUpdatedEventPayload {
  source: string;
  feedUrl?: string;
  timestamp: number;
}

const SQLITE_DB_FILENAME = "rss-dashboard.sqlite";
const USER_SETTINGS_FILENAME = "usersettings.json";
const AUTO_COMPACT_MIN_FEEDS_REMOVED = 250;
const AUTO_COMPACT_MIN_DB_SIZE_BYTES = 20 * 1024 * 1024;
const IMMEDIATE_SYNC_MAX_OPML_FEEDS = 2000;

export default class RssDashboardPlugin extends Plugin {
  settings!: RssDashboardSettings;
  feedParser!: FeedParser;
  articleSaver!: ArticleSaver;
  db!: DatabaseService;
  private dbSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private importStatusBarItem: HTMLElement | null = null;
  public backgroundImportQueue: FeedMetadata[] = [];
  public settingTab: RssDashboardSettingTab | null = null;
  private isBackgroundImporting = false;
  private isWritingToSettings = false;
  private isWritingToDatabase = false;
  private settingsWriteTimeout: ReturnType<typeof setTimeout> | null = null;
  private databaseWriteTimeout: ReturnType<typeof setTimeout> | null = null;

  public async getActiveDashboardView(): Promise<RssDashboardView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        return view;
      }
    }
    return null;
  }

  public async refreshDashboardViews(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        view.refresh();
      }
    }
  }

  public async refreshReaderViews(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_READER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (!(view instanceof ReaderView)) {
        continue;
      }

      try {
        const readerState = view as unknown as {
          currentItem?: FeedItem | null;
          relatedItems?: FeedItem[];
          displayItem?: (
            item: FeedItem,
            relatedItems?: FeedItem[],
          ) => Promise<void>;
        };

        if (
          readerState.currentItem &&
          typeof readerState.displayItem === "function"
        ) {
          await readerState.displayItem(
            readerState.currentItem,
            readerState.relatedItems ?? [],
          );
        }
      } catch {
        // Best effort only: reader refresh should not block settings persistence.
      }
    }
  }

  public async refreshOpenViews(): Promise<void> {
    await this.refreshDashboardViews();
    await this.refreshReaderViews();
  }

  private cloneTags(tags?: Tag[]): Tag[] {
    return tags?.map((tag) => ({ ...tag })) ?? [];
  }

  private findArticleRecord(
    feedUrl: string,
    articleGuid: string,
  ): { feed: Feed; article: FeedItem } | null {
    const feed = this.settings.feeds.find((candidate) => candidate.url === feedUrl);
    if (!feed) {
      return null;
    }

    const article = feed.items.find((item) => item.guid === articleGuid);
    if (!article) {
      return null;
    }

    return { feed, article };
  }

  private async withImmediateDatabaseMutation(
    mutation: () => Promise<void>,
  ): Promise<void> {
    this.isWritingToDatabase = true;
    if (this.databaseWriteTimeout) {
      clearTimeout(this.databaseWriteTimeout);
      this.databaseWriteTimeout = null;
    }

    try {
      await mutation();
    } finally {
      this.databaseWriteTimeout = setTimeout(() => {
        this.isWritingToDatabase = false;
      }, 3000);
    }
  }

  public async persistArticlePatch(
    feedUrl: string,
    articleGuid: string,
    updates: Partial<FeedItem>,
  ): Promise<FeedItem | null> {
    const record = this.findArticleRecord(feedUrl, articleGuid);
    if (!record) {
      return null;
    }

    const normalizedUpdates: Partial<FeedItem> = { ...updates };
    if (updates.tags) {
      normalizedUpdates.tags = this.cloneTags(updates.tags);
    }

    Object.assign(record.article, normalizedUpdates);
    if (normalizedUpdates.tags) {
      record.article.tags = normalizedUpdates.tags;
    }

    await this.withImmediateDatabaseMutation(async () => {
      await persistArticleMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        record.article,
      );
    });

    return record.article;
  }

  public async toggleArticleTag(
    feedUrl: string,
    articleGuid: string,
    tag: Tag,
    checked: boolean,
  ): Promise<FeedItem | null> {
    const record = this.findArticleRecord(feedUrl, articleGuid);
    if (!record) {
      return null;
    }

    const canonicalTag = findTagByName(this.settings, tag.name) ?? tag;
    const changed = toggleTagOnArticle(record.article, canonicalTag, checked);
    if (!changed) {
      return record.article;
    }

    await this.withImmediateDatabaseMutation(async () => {
      await persistArticleMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        record.article,
      );
    });

    return record.article;
  }

  public async createTag(tag: Tag): Promise<Tag> {
    const { tag: createdTag, created } = ensureTagExists(this.settings, tag);
    if (!created) {
      return createdTag;
    }

    await this.withImmediateDatabaseMutation(async () => {
      await persistTagMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        this.settings.availableTags,
        [],
      );
    });

    return createdTag;
  }

  public async createTagAndAssign(
    feedUrl: string,
    articleGuid: string,
    tag: Tag,
  ): Promise<FeedItem | null> {
    const record = this.findArticleRecord(feedUrl, articleGuid);
    if (!record) {
      return null;
    }

    const { tag: canonicalTag, created } = ensureTagExists(this.settings, tag);
    const assigned = toggleTagOnArticle(record.article, canonicalTag, true);
    if (!created && !assigned) {
      return record.article;
    }

    await this.withImmediateDatabaseMutation(async () => {
      if (created) {
        await persistTagMutation(
          this.db?.isInitialized() ? this.db : null,
          () => this.saveSettingsOnly(),
          this.settings.availableTags,
          assigned ? [record.article] : [],
        );
        return;
      }

      await persistArticleMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        record.article,
      );
    });

    return record.article;
  }

  public async renameTag(previousName: string, nextTag: Tag): Promise<boolean> {
    const tag = findTagByName(this.settings, previousName);
    if (!tag) {
      return false;
    }

    const duplicate = findTagByName(this.settings, nextTag.name);
    if (duplicate && duplicate !== tag) {
      return false;
    }

    const affectedArticles = updateTagInSettings(this.settings, tag, nextTag);
    await this.withImmediateDatabaseMutation(async () => {
      await persistTagMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        this.settings.availableTags,
        affectedArticles,
      );
    });

    return true;
  }

  public async deleteTag(tagName: string): Promise<boolean> {
    const tag = findTagByName(this.settings, tagName);
    if (!tag) {
      return false;
    }

    const affectedArticles = deleteTagFromSettings(this.settings, tag);
    await this.withImmediateDatabaseMutation(async () => {
      await persistTagMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        this.settings.availableTags,
        affectedArticles,
      );
    });

    return true;
  }

  public async updateTagColor(
    tagName: string,
    color: string,
  ): Promise<boolean> {
    const tag = findTagByName(this.settings, tagName);
    if (!tag) {
      return false;
    }

    if (tag.color === color) {
      return true;
    }

    const affectedArticles = updateTagColorInSettings(
      this.settings,
      tag.name,
      color,
    );
    await this.withImmediateDatabaseMutation(async () => {
      await persistTagMutation(
        this.db?.isInitialized() ? this.db : null,
        () => this.saveSettingsOnly(),
        this.settings.availableTags,
        affectedArticles,
      );
    });

    return true;
  }

  /**
   * Reloads ONLY the user settings (JSON) without touching the database or bulk data.
   * This is intended for vault watcher events on usersettings.json to avoid DB races.
   */
  private async reloadUserSettingsOnly(): Promise<void> {
    const data = await this.loadUserSettings();
    if (data) {
      // Merge keys one by one to preserve the this.settings object reference
      if (data.display) {
        this.settings.display = Object.assign(
          {},
          this.settings.display,
          data.display,
        );
      }
      if (data.filters) {
        this.settings.filters = Object.assign(
          {},
          this.settings.filters,
          data.filters,
        );
      }
      if (data.media) {
        this.settings.media = Object.assign(
          {},
          this.settings.media,
          data.media,
        );
      }
      if (data.articleSaving) {
        this.settings.articleSaving = Object.assign(
          {},
          this.settings.articleSaving,
          data.articleSaving,
        );
      }

      // Handle simple top-level fields
      const simpleKeys: (keyof RssDashboardSettings)[] = [
        "viewStyle",
        "refreshInterval",
        "maxItems",
        "readerViewLocation",
        "useWebViewer",
        "sidebarCollapsed",
        "autoTagging",
      ];
      for (const key of simpleKeys) {
        if (data[key] !== undefined) {
          // @ts-ignore
          this.settings[key] = data[key];
        }
      }
    }
  }

  public notifyFiltersUpdated(payload: FiltersUpdatedEventPayload): void {
    this.app.workspace.trigger("rss-dashboard:filters-updated", payload);
  }

  public async getActiveDiscoverView(): Promise<DiscoverView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DISCOVER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof DiscoverView) {
        return view;
      }
    }
    return null;
  }

  public async getActiveReaderView(): Promise<ReaderView | null> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_READER_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof ReaderView) {
        return view;
      }
    }
    return null;
  }

  public async openTagsSettings(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const setting = (this.app as any).setting;
    if (setting) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      setting.open();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      setting.openTabById(this.manifest.id);
      if (this.settingTab) {
        this.settingTab.activateTab("Tags");
      }
    }
  }

  public async openSettingsToTab(tabName: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const setting = (this.app as any).setting;
    if (setting) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      setting.open();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      setting.openTabById(this.manifest.id);
      if (this.settingTab) {
        this.settingTab.activateTab(tabName);
      }
    }
  }

  async onload() {
    await this.loadSettings();

    const view = await this.getActiveDashboardView();
    if (view) {
      view.render();
    }

    try {
      this.feedParser = new FeedParser(this.settings);
      this.articleSaver = new ArticleSaver(
        this.app,
        this.settings.articleSaving,
      );

      if (Platform.isMobile) {
        this.applyMobileOptimizations();
      }

      const allArticles = this.getAllArticles();
      await this.articleSaver.fixSavedFilePaths(allArticles);

      await this.validateSavedArticles();

      this.registerView(
        RSS_DASHBOARD_VIEW_TYPE,
        (leaf) => new RssDashboardView(leaf, this),
      );

      this.registerView(
        RSS_DISCOVER_VIEW_TYPE,
        (leaf) => new DiscoverView(leaf, this),
      );

      this.registerView(
        RSS_READER_VIEW_TYPE,
        (leaf) =>
          new ReaderView(
            leaf,
            this.settings,
            this.articleSaver,
            (item: FeedItem) => {
              void this.onArticleSaved(item);
            },
            (
              item: FeedItem,
              updates: Partial<FeedItem>,
              shouldRerender?: boolean,
            ) => {
              void this.updateArticleFromReader(item, updates, shouldRerender);
            },
            {
              onToggleArticleTag: async (
                item: FeedItem,
                tag: Tag,
                checked: boolean,
              ) => {
                if (!item.feedUrl) {
                  return;
                }
                const updatedArticle = await this.toggleArticleTag(
                  item.feedUrl,
                  item.guid,
                  tag,
                  checked,
                );
                if (!updatedArticle) {
                  return;
                }
                Object.assign(item, updatedArticle, {
                  tags: this.cloneTags(updatedArticle.tags),
                });
                await this.syncDashboardArticleUpdate(
                  item.guid,
                  item.feedUrl,
                  { tags: this.cloneTags(updatedArticle.tags) },
                  false,
                );
              },
              onCreateTagAndAssign: async (item: FeedItem, tag: Tag) => {
                if (!item.feedUrl) {
                  return;
                }
                const updatedArticle = await this.createTagAndAssign(
                  item.feedUrl,
                  item.guid,
                  tag,
                );
                if (!updatedArticle) {
                  return;
                }
                Object.assign(item, updatedArticle, {
                  tags: this.cloneTags(updatedArticle.tags),
                });
                await this.syncDashboardArticleUpdate(
                  item.guid,
                  item.feedUrl,
                  { tags: this.cloneTags(updatedArticle.tags) },
                  false,
                );
                await this.refreshDashboardViews();
              },
              onRenameTag: async (previousName: string, nextTag: Tag) => {
                const renamed = await this.renameTag(previousName, nextTag);
                if (renamed) {
                  await this.refreshDashboardViews();
                }
              },
              onDeleteTag: async (tagName: string) => {
                const deleted = await this.deleteTag(tagName);
                if (deleted) {
                  await this.refreshDashboardViews();
                }
              },
            },
          ),
      );

      this.registerView(
        RSS_SMALLWEB_VIEW_TYPE,
        (leaf) => new KagiSmallwebView(leaf, this),
      );

      this.addRibbonIcon("compass", "RSS dashboard", () => {
        void this.activateView();
      });

      this.settingTab = new RssDashboardSettingTab(this.app, this);
      this.addSettingTab(this.settingTab);

      this.addCommand({
        id: "open-dashboard",
        name: "Open dashboard",
        callback: () => {
          void this.activateView();
        },
      });

      this.addCommand({
        id: "open-discover",
        name: "Open discover",
        callback: () => {
          void this.activateDiscoverView();
        },
      });

      this.addCommand({
        id: "refresh-feeds",
        name: "Refresh feeds",
        callback: () => {
          void this.refreshFeeds();
        },
      });

      this.addCommand({
        id: "import-opml",
        name: "Import opml",
        callback: () => {
          new ImportOpmlModal(this.app, this).open();
        },
      });

      this.addCommand({
        id: "export-opml",
        name: "Export opml",
        callback: () => {
          void this.exportOpml();
        },
      });

      this.addCommand({
        id: "import-usersettings-json",
        name: "Import usersettings.json",
        callback: () => {
          this.importUserSettingsJson();
        },
      });

      this.addCommand({
        id: "export-usersettings-json",
        name: "Export usersettings.json",
        callback: () => {
          void this.exportUserSettingsJson();
        },
      });

      this.addCommand({
        id: "import-sqlite-database",
        name: "Import sqlite database",
        callback: () => {
          this.importSqliteDatabase();
        },
      });

      this.addCommand({
        id: "export-sqlite-database",
        name: "Export sqlite database",
        callback: () => {
          void this.exportSqliteDatabase();
        },
      });

      this.addCommand({
        id: "optimize-database-storage",
        name: "Optimize database storage",
        callback: () => {
          void this.optimizeDatabaseStorage();
        },
      });

      this.addCommand({
        id: "restore-from-json-backup",
        name: "Restore from JSON backup",
        callback: () => {
          void this.restoreFromJsonBackup();
        },
      });

      this.addCommand({
        id: "apply-feed-limits",
        name: "Apply feed limits to all feeds",
        callback: () => {
          void this.applyFeedLimitsToAllFeeds();
        },
      });

      this.addCommand({
        id: "reapply-auto-tag-rules",
        name: "Reapply auto-tag rules to all articles",
        callback: () => {
          void this.reapplyAutoTagRulesToAllArticles();
        },
      });

      this.addCommand({
        id: "toggle-sidebar",
        name: "Toggle sidebar",
        checkCallback: (checking: boolean) => {
          const leaves = this.app.workspace.getLeavesOfType(
            RSS_DASHBOARD_VIEW_TYPE,
          );
          if (leaves.length > 0) {
            if (!checking) {
              void (async () => {
                const view = await this.getActiveDashboardView();
                if (view) {
                  this.settings.sidebarCollapsed =
                    !this.settings.sidebarCollapsed;
                  await this.saveSettings();
                  view.render();
                }
              })();
            }
            return true;
          }
          return false;
        },
      });

      this.registerInterval(
        window.setInterval(
          () => {
            void this.refreshFeeds();
          },
          this.settings.refreshInterval * 60 * 1000,
        ),
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (!file || !("path" in file)) return;

          const pluginDir = this.manifest.dir ?? "";
          if (!pluginDir) return;

          const settingsPath = `${pluginDir}/${USER_SETTINGS_FILENAME}`;
          const dbPath = `${pluginDir}/${SQLITE_DB_FILENAME}`;

          if (file.path === settingsPath && !this.isWritingToSettings) {
            void (async () => {
              await this.reloadUserSettingsOnly();
              await this.refreshOpenViews();
            })();
          } else if (file.path === dbPath && !this.isWritingToDatabase) {
            void (async () => {
              // Flush any pending local sync before loading external changes
              if (this.dbSyncTimer) {
                await this.flushDatabaseToDisk();
              }
              if (this.db?.isInitialized()) {
                await this.db.reinit();
                this.settings.feeds = this.db.loadAllFeeds();
                this.settings.folders = this.db.loadAllFolders();
                this.settings.availableTags = this.db.loadAllTags();
                await this.refreshOpenViews();
              }
            })();
          }
        }),
      );
    } catch {
      new Notice("Error initializing RSS dashboard plugin.");
    }
  }

  private applyMobileOptimizations(): void {
    if (this.settings.refreshInterval < 60) {
      this.settings.refreshInterval = 60;
    }

    if (this.settings.maxItems > 50) {
      this.settings.maxItems = 50;
    }

    if (this.settings.viewStyle === "list") {
      this.settings.viewStyle = "card";
    }

    if (!this.settings.sidebarCollapsed) {
      this.settings.sidebarCollapsed = true;
    }
  }

  async activateView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        switch (this.settings.viewLocation) {
          case "left-sidebar":
            leaf = workspace.getLeftLeaf(false);
            break;
          case "right-sidebar":
            leaf = workspace.getRightLeaf(false);
            break;
          default:
            leaf = workspace.getLeaf("tab");
            break;
        }
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_DASHBOARD_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      new Notice("Error opening RSS dashboard view");
    }
  }

  async activateDiscoverView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_DISCOVER_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        switch (this.settings.viewLocation) {
          case "left-sidebar":
            leaf = workspace.getLeftLeaf(false);
            break;
          case "right-sidebar":
            leaf = workspace.getRightLeaf(false);
            break;
          default:
            leaf = workspace.getLeaf("tab");
            break;
        }
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_DISCOVER_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      new Notice("Error opening RSS discover view");
    }
  }

  async activateSmallwebView() {
    const { workspace } = this.app;

    try {
      let leaf: WorkspaceLeaf | null = null;
      const leaves = workspace.getLeavesOfType(RSS_SMALLWEB_VIEW_TYPE);

      if (leaves.length > 0) {
        leaf = leaves[0];
      } else {
        switch (this.settings.viewLocation) {
          case "left-sidebar":
            leaf = workspace.getLeftLeaf(false);
            break;
          case "right-sidebar":
            leaf = workspace.getRightLeaf(false);
            break;
          default:
            leaf = workspace.getLeaf("tab");
            break;
        }
      }

      if (leaf) {
        await leaf.setViewState({
          type: RSS_SMALLWEB_VIEW_TYPE,
          active: true,
        });
        void workspace.revealLeaf(leaf);
      }
    } catch {
      new Notice("Error opening kagi smallweb");
    }
  }

  private async onArticleSaved(item: FeedItem): Promise<void> {
    if (!item.feedUrl) {
      return;
    }

    const record = this.findArticleRecord(item.feedUrl, item.guid);
    if (!record) {
      return;
    }

    const nextTags = this.cloneTags(record.article.tags);
    if (
      this.settings.articleSaving.addSavedTag &&
      !nextTags.some((tag) => tag.name.toLowerCase() === "saved")
    ) {
      const savedTag =
        this.settings.availableTags.find(
          (tag) => tag.name.toLowerCase() === "saved",
        ) ?? { name: "saved", color: "#3498db" };
      nextTags.push({ ...savedTag });
    }

    const updatedArticle = await this.persistArticlePatch(item.feedUrl, item.guid, {
      saved: true,
      savedFilePath: item.savedFilePath,
      tags: nextTags,
    });
    if (!updatedArticle) {
      return;
    }

    Object.assign(item, updatedArticle, {
      tags: this.cloneTags(updatedArticle.tags),
    });
    await this.syncDashboardArticleUpdate(
      item.guid,
      item.feedUrl,
      {
        saved: true,
        savedFilePath: updatedArticle.savedFilePath,
        tags: this.cloneTags(updatedArticle.tags),
      },
      false,
    );
  }

  private async updateArticleFromReader(
    item: FeedItem,
    updates: Partial<FeedItem>,
    shouldRerender?: boolean,
  ): Promise<void> {
    if (item.feedUrl) {
      const feed = this.settings.feeds.find((f) => f.url === item.feedUrl);
      if (!feed) return;

      const originalItem = feed.items.find((i) => i.guid === item.guid);
      if (!originalItem) return;

      const updatedArticle = await this.persistArticlePatch(
        item.feedUrl,
        item.guid,
        updates,
      );
      if (!updatedArticle) {
        return;
      }
      Object.assign(item, updatedArticle, {
        tags: this.cloneTags(updatedArticle.tags),
      });
      await this.syncDashboardArticleUpdate(
        item.guid,
        item.feedUrl,
        {
          ...updates,
          ...(updatedArticle.tags ? { tags: this.cloneTags(updatedArticle.tags) } : {}),
        },
        !!shouldRerender,
      );
    }
  }

  private async syncDashboardArticleUpdate(
    articleGuid: string,
    feedUrl: string,
    updates: Partial<FeedItem>,
    shouldRerender: boolean,
  ): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(RSS_DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      if (requireApiVersion("1.7.2")) {
        await leaf.loadIfDeferred();
      }
      const view = leaf.view;
      if (view instanceof RssDashboardView) {
        view.applyExternalArticleUpdate(
          articleGuid,
          feedUrl,
          updates,
          shouldRerender,
        );
      }
    }
  }

  async refreshFeeds(selectedFeeds?: Feed[]) {
    try {
      const feedsToRefresh = selectedFeeds || this.settings.feeds;
      let feedNoticeText = "";
      if (feedsToRefresh.length === 1) {
        feedNoticeText = feedsToRefresh[0].title;
      } else {
        feedNoticeText = `${feedsToRefresh.length} feeds`;
      }

      new Notice(`Refreshing ${feedNoticeText}...`);
      const updatedFeeds =
        await this.feedParser.refreshAllFeeds(feedsToRefresh);

      updatedFeeds.forEach((updatedFeed) => {
        const index = this.settings.feeds.findIndex(
          (f) => f.url === updatedFeed.url,
        );
        if (index >= 0) {
          this.settings.feeds[index] = updatedFeed;
        }
      });

      await this.validateSavedArticles();
      await this.saveSettings();
      const view = await this.getActiveDashboardView();
      if (view) {
        view.refresh();
        new Notice(`Feeds refreshed: ${feedNoticeText}`);
      }
    } catch (error) {
      console.error(`[RSS dashboard] Error refreshing feeds:`, error);
      new Notice(
        `Error refreshing  ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Apply feed limits (maxItemsLimit and autoDeleteDuration) to all feeds
   * This is useful when users want to apply their current settings to existing feeds
   */
  async applyFeedLimitsToAllFeeds() {
    try {
      let updatedCount = 0;

      for (const feed of this.settings.feeds) {
        const originalCount = feed.items.length;

        if (
          feed.maxItemsLimit &&
          feed.maxItemsLimit > 0 &&
          feed.items.length > feed.maxItemsLimit
        ) {
          const readItems = feed.items.filter((item) => item.read);
          const unreadItems = feed.items.filter((item) => !item.read);

          unreadItems.sort(
            (a, b) =>
              new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime(),
          );

          const maxUnreadItems = Math.max(
            0,
            feed.maxItemsLimit - readItems.length,
          );
          const limitedUnreadItems = unreadItems.slice(0, maxUnreadItems);

          feed.items = [...readItems, ...limitedUnreadItems];
        }

        if (feed.autoDeleteDuration && feed.autoDeleteDuration > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - feed.autoDeleteDuration);

          const readItems = feed.items.filter((item) => item.read);
          const unreadItems = feed.items.filter(
            (item) =>
              !item.read &&
              new Date(item.pubDate).getTime() > cutoffDate.getTime(),
          );

          feed.items = [...readItems, ...unreadItems];
        }

        if (feed.items.length !== originalCount) {
          updatedCount++;
        }
      }

      await this.saveSettings();
      const view = await this.getActiveDashboardView();
      if (view) {
        view.refresh();
      }

      if (updatedCount > 0) {
        new Notice(`Applied limits to ${updatedCount} feeds`);
      } else {
        new Notice("No feeds needed limit adjustments");
      }
    } catch (error) {
      new Notice(
        `Error applying feed limits: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async refreshSelectedFeed(feed: Feed) {
    await this.refreshFeeds([feed]);
  }

  async refreshFeedsInFolder(folderPath: string) {
    const feedsInFolder = this.settings.feeds.filter((feed) => {
      if (!feed.folder) return false;
      return (
        feed.folder === folderPath || feed.folder.startsWith(folderPath + "/")
      );
    });

    if (feedsInFolder.length > 0) {
      await this.refreshFeeds(feedsInFolder);
    } else {
      new Notice("No feeds found in the selected folder");
    }
  }

  async updateArticle(
    articleGuid: string,
    feedUrl: string,
    updates: Partial<FeedItem>,
    shouldRefreshView = true,
  ) {
    const article = await this.persistArticlePatch(feedUrl, articleGuid, updates);
    if (!article) {
      return;
    }

    if (shouldRefreshView) {
      const view = await this.getActiveDashboardView();
      if (view) {
        view.refresh();
      }
    }
  }

  private showImportProgressModal(
    totalFeeds: number,
    onMinimize: () => void,
    onAbort: () => void,
  ): HTMLElement {
    const modal = document.body.createDiv({
      cls: "rss-dashboard-modal rss-dashboard-modal-container rss-dashboard-import-modal",
    });

    const modalContent = modal.createDiv({
      cls: "rss-dashboard-modal-content",
    });

    const modalHeader = modalContent.createDiv({
      cls: "rss-dashboard-import-modal-header",
    });

    new Setting(modalHeader).setName("Importing opml feeds").setHeading();

    const minimizeButton = modalHeader.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Minimize" },
    });
    setIcon(minimizeButton, "minus");
    minimizeButton.onclick = onMinimize;

    const abortButton = modalHeader.createEl("button", {
      text: "Abort",
      cls: "rss-dashboard-import-abort-button",
    });
    abortButton.onclick = onAbort;

    const buttonGroup = modalHeader.createDiv({
      cls: "import-modal-header-buttons",
    });
    buttonGroup.appendChild(minimizeButton);
    buttonGroup.appendChild(abortButton);

    modalContent.createDiv({
      attr: { id: "import-progress-text" },
      cls: "rss-dashboard-center-text rss-dashboard-import-progress-text",
      text: `Preparing to import ${totalFeeds} feeds...`,
    });

    const progressBar = modalContent.createDiv({
      cls: "rss-dashboard-import-progress-bar",
    });

    const progressFill = progressBar.createDiv({
      attr: { id: "import-progress-fill" },
      cls: "rss-dashboard-import-progress-fill",
    });
    setCssProps(progressFill, { "--progress-width": "0%" });

    modalContent.createDiv({
      attr: { id: "import-current-feed" },
      cls: "rss-dashboard-center-text rss-dashboard-import-current-feed",
    });

    return modal;
  }

  importOpml(): void {
    const input = document.body.createEl("input", {
      attr: { type: "file" },
    });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file && file.name.endsWith(".opml")) {
        const content = await file.text();
        try {
          const { feeds: newFeedsMetadata, folders: newFolders } =
            OpmlManager.parseOpmlMetadata(content);

          const feedsToAdd = newFeedsMetadata.filter(
            (newFeed) =>
              !this.settings.feeds.some((f) => f.url === newFeed.url),
          );

          if (feedsToAdd.length === 0) {
            new Notice("No new feeds found in the opml file.");
            return;
          }

          const addedFeeds: Feed[] = [];
          for (const feedMetadata of feedsToAdd) {
            const feedToAdd: Feed = {
              title: feedMetadata.title,
              url: feedMetadata.url,
              folder: feedMetadata.folder,
              items: [],
              lastUpdated: Date.now(),
              mediaType: feedMetadata.mediaType || "article",
              autoDeleteDuration: feedMetadata.autoDeleteDuration,
              maxItemsLimit: feedMetadata.maxItemsLimit || 50,
              scanInterval: feedMetadata.scanInterval,
              filters: {
                overrideGlobalFilters: false,
                includeLogic: "AND",
                rules: [],
              },
            };

            if (
              feedToAdd.mediaType === "video" &&
              (!feedToAdd.folder || feedToAdd.folder === "Uncategorized")
            ) {
              feedToAdd.folder = this.settings.media.defaultYouTubeFolder;
            } else if (
              feedToAdd.mediaType === "podcast" &&
              (!feedToAdd.folder || feedToAdd.folder === "Uncategorized")
            ) {
              feedToAdd.folder = this.settings.media.defaultPodcastFolder;
            }

            addedFeeds.push(feedToAdd);
          }

          this.settings.feeds.push(...addedFeeds);
          this.settings.folders = OpmlManager.mergeFolders(
            this.settings.folders,
            newFolders,
          );

          for (const feed of addedFeeds) {
            if (feed.folder) {
              await this.ensureFolderExists(feed.folder, {
                saveSettings: false,
                refreshView: false,
              });
            }
          }
          await this.saveSettings();
          // Avoid expensive immediate full sync for huge OPML imports.
          if (addedFeeds.length <= IMMEDIATE_SYNC_MAX_OPML_FEEDS) {
            await this.flushDatabaseToDisk();
          }

          const view = await this.getActiveDashboardView();
          if (view) {
            view.render();
          }

          new Notice(
            `Imported ${addedFeeds.length} feeds. Articles will be fetched in the background.`,
          );

          void this.startBackgroundImport(addedFeeds);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          new Notice(message);
        }
      } else {
        new Notice("Please select a valid opml file.");
      }
    };
    input.click();
  }

  public startBackgroundImport(feeds: Feed[]): void {
    this.backgroundImportQueue.push(
      ...feeds.map((feed) => ({
        ...feed,
        importStatus: "pending" as const,
      })),
    );

    // Defer heavy full-database sync while bulk background import is active.
    if (this.dbSyncTimer) {
      clearTimeout(this.dbSyncTimer);
      this.dbSyncTimer = null;
    }

    if (!this.isBackgroundImporting) {
      void this.processBackgroundImportQueue();
    }
  }

  private async processBackgroundImportQueue() {
    if (this.isBackgroundImporting || this.backgroundImportQueue.length === 0) {
      return;
    }

    this.isBackgroundImporting = true;

    if (!this.importStatusBarItem) {
      this.importStatusBarItem = this.addStatusBarItem();
      this.importStatusBarItem.textContent = "";
      const iconSpan = this.importStatusBarItem.createSpan({
        cls: "import-statusbar-icon",
      });
      setIcon(iconSpan, "rss");
      this.importStatusBarItem.createSpan({
        cls: "import-statusbar-text",
      });
    }

    const totalFeeds = this.backgroundImportQueue.length;
    let processedCount = 0;
    const saveEvery =
      totalFeeds >= 20000
        ? 200
        : totalFeeds >= 5000
          ? 100
          : totalFeeds >= 1000
            ? 25
            : 5;
    const renderEvery =
      totalFeeds >= 20000
        ? 500
        : totalFeeds >= 5000
          ? 150
          : totalFeeds >= 1000
            ? 40
            : 3;
    const interFeedDelayMs = totalFeeds >= 5000 ? 10 : 100;
    const shouldRenderDuringImport = totalFeeds < 5000;

    while (this.backgroundImportQueue.length > 0) {
      const feedMetadata = this.backgroundImportQueue[0];
      if (!feedMetadata) break;

      try {
        feedMetadata.importStatus = "processing";
        this.updateBackgroundImportProgress(
          processedCount,
          totalFeeds,
          feedMetadata.title,
        );

        const parsedFeed = await this.feedParser.parseFeed(feedMetadata.url);

        const feedIndex = this.settings.feeds.findIndex(
          (f) => f.url === feedMetadata.url,
        );
        if (feedIndex >= 0) {
          this.settings.feeds[feedIndex] = {
            ...this.settings.feeds[feedIndex],
            title: parsedFeed.title || feedMetadata.title,
            items: parsedFeed.items.slice(0, 50),
            lastUpdated: Date.now(),
            mediaType: parsedFeed.mediaType,
          };
        }

        feedMetadata.importStatus = "completed";
      } catch (error) {
        feedMetadata.importStatus = "failed";
        feedMetadata.importError = getFeedErrorMessage(error);
        processedCount++;
      } finally {
        this.backgroundImportQueue.shift();
      }

      if (processedCount % saveEvery === 0) {
        await this.saveSettingsOnly();
      }

      if (shouldRenderDuringImport && processedCount % renderEvery === 0) {
        const view = await this.getActiveDashboardView();
        if (view) {
          view.render();
        }
      }

      await sleep(interFeedDelayMs);
    }

    await this.saveSettingsOnly();
    await this.flushDatabaseToDisk();
    const view = await this.getActiveDashboardView();
    if (view) {
      view.render();
    }

    if (this.importStatusBarItem) {
      this.importStatusBarItem.remove();
      this.importStatusBarItem = null;
    }

    this.isBackgroundImporting = false;
    new Notice(
      `Background import completed. Processed ${processedCount} feeds.`,
    );
  }

  private updateBackgroundImportProgress(
    current: number,
    total: number,
    currentFeedTitle: string,
  ): void {
    if (this.importStatusBarItem) {
      const textSpan = this.importStatusBarItem.querySelector(
        ".import-statusbar-text",
      );
      if (textSpan) {
        textSpan.textContent = `  Fetching articles: ${current}/${total} - ${currentFeedTitle}`;
      }
    }
  }

  public importUserSettingsJson(): void {
    const input = document.body.createEl("input", {
      attr: {
        type: "file",
        accept: ".json,application/json",
      },
    });

    input.onchange = () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const parsed = JSON.parse(text) as Partial<RssDashboardSettings>;
          if (!parsed || typeof parsed !== "object") {
            throw new Error("Invalid usersettings.json");
          }

          const parsedWithCollections =
            parsed as Partial<RssDashboardSettings> & {
              feeds?: unknown;
              folders?: unknown;
              availableTags?: unknown;
            };
          const hasFeedCollections =
            Array.isArray(parsedWithCollections.feeds) ||
            Array.isArray(parsedWithCollections.folders) ||
            Array.isArray(parsedWithCollections.availableTags);

          if (hasFeedCollections) {
            this.settings = Object.assign(
              {},
              DEFAULT_SETTINGS,
              this.settings,
              parsed,
            );
            this.settings.feeds = Array.isArray(parsedWithCollections.feeds)
              ? parsedWithCollections.feeds
              : [];
            this.settings.folders = Array.isArray(parsedWithCollections.folders)
              ? parsedWithCollections.folders
              : this.settings.folders;
            this.settings.availableTags = Array.isArray(
              parsedWithCollections.availableTags,
            )
              ? parsedWithCollections.availableTags
              : this.settings.availableTags;

            this.migrateLegacySettings();
            for (const feed of this.settings.feeds) {
              if (!feed.filters) {
                feed.filters = {
                  overrideGlobalFilters: false,
                  includeLogic: "AND",
                  rules: [],
                };
                continue;
              }
              feed.filters = Object.assign(
                {},
                {
                  overrideGlobalFilters: false,
                  includeLogic: "AND",
                  rules: [],
                },
                feed.filters,
              );
            }

            if (!this.db?.isInitialized()) {
              const pluginDir = this.manifest.dir ?? "";
              this.db = new DatabaseService();
              await this.db.init(pluginDir, this.app.vault.adapter);
            }

            await this.flushDatabaseToDisk();
            await this.saveSettingsOnly();
            await this.refreshDashboardViews();
            const discoverView = await this.getActiveDiscoverView();
            discoverView?.render();

            new Notice("Imported JSON with feeds and settings");
            return;
          }

          const {
            feeds: _feeds,
            folders: _folders,
            availableTags: _availableTags,
            ...settingsOnly
          } = parsed as Partial<RssDashboardSettings> & {
            feeds?: unknown;
            folders?: unknown;
            availableTags?: unknown;
          };
          void _feeds;
          void _folders;
          void _availableTags;

          this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            this.settings,
            settingsOnly,
          );

          // Keep legacy keys and nested defaults normalized after import.
          this.migrateLegacySettings();

          await this.saveSettingsOnly();
          await this.refreshDashboardViews();
          const discoverView = await this.getActiveDiscoverView();
          discoverView?.render();

          new Notice("Imported usersettings.json");
        } catch (error) {
          new Notice(
            `Invalid usersettings.json file${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      })();
    };

    input.click();
  }

  public async exportUserSettingsJson(): Promise<void> {
    const settingsOnly = this.getSettingsOnlyData();
    const blob = new Blob([JSON.stringify(settingsOnly, null, 2)], {
      type: "application/json",
    });
    this.downloadBlob(blob, USER_SETTINGS_FILENAME);
    new Notice("Exported usersettings.json");
  }

  public importSqliteDatabase(): void {
    const input = document.body.createEl("input", {
      attr: {
        type: "file",
        accept: ".sqlite,.db,application/x-sqlite3,application/octet-stream",
      },
    });

    input.onchange = () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;

        const pluginDir = this.manifest.dir ?? "";
        if (!pluginDir) {
          new Notice("Plugin directory not found");
          return;
        }

        const dbPath = `${pluginDir}/${SQLITE_DB_FILENAME}`;
        let previousDbBinary: ArrayBuffer | null = null;
        try {
          previousDbBinary = await this.app.vault.adapter.readBinary(dbPath);
        } catch {
          previousDbBinary = null;
        }

        try {
          const importedDb = await file.arrayBuffer();
          if (importedDb.byteLength === 0) {
            throw new Error("Empty sqlite file");
          }

          this.db?.close();
          await this.app.vault.adapter.writeBinary(dbPath, importedDb);

          this.db = new DatabaseService();
          await this.db.init(pluginDir, this.app.vault.adapter);

          this.settings.feeds = this.db.loadAllFeeds();
          this.settings.folders = this.db.loadAllFolders();
          const tags = this.db.loadAllTags();
          if (tags.length > 0) {
            this.settings.availableTags = tags;
          } else {
            this.settings.availableTags = [];
          }

          // Ensure feed filters are complete after DB import.
          this.settings.feeds.forEach((feed) => {
            if (!feed.filters) {
              feed.filters = {
                overrideGlobalFilters: false,
                includeLogic: "AND",
                rules: [],
              };
              return;
            }
            if (feed.filters.overrideGlobalFilters === undefined) {
              feed.filters.overrideGlobalFilters = false;
            }
            if (!feed.filters.includeLogic) {
              feed.filters.includeLogic = "AND";
            }
            if (!feed.filters.rules) {
              feed.filters.rules = [];
            }
          });

          await this.saveSettingsOnly();
          await this.refreshDashboardViews();
          const discoverView = await this.getActiveDiscoverView();
          discoverView?.render();

          new Notice("Imported sqlite database");
        } catch (error) {
          // Best-effort rollback to previous database file if import fails.
          if (previousDbBinary) {
            try {
              await this.app.vault.adapter.writeBinary(
                dbPath,
                previousDbBinary,
              );
            } catch {
              // ignore rollback failure
            }
          }

          try {
            this.db = new DatabaseService();
            await this.db.init(pluginDir, this.app.vault.adapter);
          } catch {
            // ignore recovery init failure
          }

          new Notice(
            `Failed to import sqlite database: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      })();
    };

    input.click();
  }

  public async exportSqliteDatabase(): Promise<void> {
    if (!this.db?.isInitialized()) {
      new Notice("Database is not initialized yet");
      return;
    }

    const pluginDir = this.manifest.dir ?? "";
    if (!pluginDir) {
      new Notice("Plugin directory not found");
      return;
    }

    try {
      await this.db.forceSave();
      const dbPath = `${pluginDir}/${SQLITE_DB_FILENAME}`;
      const data = await this.app.vault.adapter.readBinary(dbPath);
      const blob = new Blob([data], { type: "application/x-sqlite3" });
      this.downloadBlob(blob, SQLITE_DB_FILENAME);
      new Notice("Exported sqlite database");
    } catch (error) {
      new Notice(
        `Failed to export sqlite database: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  public async optimizeDatabaseAfterBulkDelete(
    deletedFeedCount: number,
  ): Promise<void> {
    if (deletedFeedCount <= 0) return;

    const dbSizeBytes = await this.getDatabaseFileSizeBytes();
    const shouldOptimizeByCount =
      deletedFeedCount >= AUTO_COMPACT_MIN_FEEDS_REMOVED;
    const shouldOptimizeBySize =
      dbSizeBytes !== null && dbSizeBytes >= AUTO_COMPACT_MIN_DB_SIZE_BYTES;

    if (!shouldOptimizeByCount && !shouldOptimizeBySize) {
      return;
    }

    await this.optimizeDatabaseStorage({
      showStartNotice: false,
      showResultNotice: true,
    });
  }

  public async optimizeDatabaseStorage(options?: {
    showStartNotice?: boolean;
    showResultNotice?: boolean;
  }): Promise<void> {
    const showStartNotice = options?.showStartNotice ?? true;
    const showResultNotice = options?.showResultNotice ?? true;

    if (!this.db?.isInitialized()) {
      if (showResultNotice) {
        new Notice("Database is not initialized yet");
      }
      return;
    }

    try {
      if (showStartNotice) {
        new Notice("Optimizing database storage...");
      }

      const beforeBytes = await this.getDatabaseFileSizeBytes();
      await this.flushDatabaseToDisk();
      await this.db.compactStorage();
      const afterBytes = await this.getDatabaseFileSizeBytes();

      if (!showResultNotice) {
        return;
      }

      if (beforeBytes !== null && afterBytes !== null) {
        const reclaimedBytes = Math.max(0, beforeBytes - afterBytes);
        if (reclaimedBytes > 0) {
          new Notice(
            `Database optimized. Reclaimed ${this.formatFileSize(reclaimedBytes)} (${this.formatFileSize(beforeBytes)} -> ${this.formatFileSize(afterBytes)}).`,
          );
        } else {
          new Notice(
            `Database optimized. Current size: ${this.formatFileSize(afterBytes)}.`,
          );
        }
      } else {
        new Notice("Database optimized.");
      }
    } catch (error) {
      if (showResultNotice) {
        new Notice(
          `Failed to optimize database: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    }
  }

  private async getDatabaseFileSizeBytes(): Promise<number | null> {
    const pluginDir = this.manifest.dir ?? "";
    if (!pluginDir) return null;
    const dbPath = `${pluginDir}/${SQLITE_DB_FILENAME}`;
    try {
      const stat = await this.app.vault.adapter.stat(dbPath);
      return stat?.size ?? null;
    } catch {
      return null;
    }
  }

  private formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    const precision = value >= 10 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
  }

  exportOpml(): void {
    const opmlContent = OpmlManager.generateOpml(
      this.settings.feeds,
      this.settings.folders,
    );

    // Detect iOS: it's neither Android app nor Desktop app
    const isIOS = !Platform.isAndroidApp && !Platform.isDesktopApp;

    if (isIOS) {
      // iOS fallback: copy to clipboard
      void this.exportOpmlToClipboardIos(opmlContent);
    } else {
      // Desktop and Android: use traditional blob download
      void this.exportOpmlAsFile(opmlContent);
    }
  }

  private exportOpmlAsFile(opmlContent: string): void {
    const blob = new Blob([opmlContent], { type: "text/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.body.createEl("a", {
      attr: { href: url },
    });
    a.download = "obsidian-rss-feeds.opml";
    a.click();
    URL.revokeObjectURL(url);
  }

  private async exportOpmlToClipboardIos(opmlContent: string): Promise<void> {
    try {
      // Try to use navigator.clipboard API (available on iOS 13.2+)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(opmlContent);
        new Notice(
          "Feed list copied to clipboard. Paste into your reader to import",
        );
        return;
      }
    } catch (error) {
      console.warn("[RSS Dashboard] Clipboard copy failed:", error);
    }

    // Fallback: open OPML content in a new window for user to save manually
    try {
      const blob = new Blob([opmlContent], { type: "text/xml" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      new Notice(
        "Feed list opened in a new window. Save to download and import",
      );
      // Note: Don't revoke the URL immediately - the new window needs it
      // It will be revoked when the window closes or navigates away
    } catch (error) {
      console.error("[RSS Dashboard] Failed to export OPML:", error);
      new Notice("Unable to export feed list. Please try again.");
    }
  }

  private folderPathExists(folderPath: string): boolean {
    if (!folderPath || folderPath === "Uncategorized") {
      return true;
    }

    const parts = folderPath
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      return true;
    }

    let currentLevel = this.settings.folders;
    for (const part of parts) {
      const folder = currentLevel.find((f) => f.name === part);
      if (!folder) {
        return false;
      }
      currentLevel = folder.subfolders || [];
    }

    return true;
  }

  private async repairMissingFolderPathsForFeeds(): Promise<void> {
    const missingPaths = new Set<string>();

    for (const feed of this.settings.feeds) {
      if (!feed.folder || feed.folder === "Uncategorized") {
        continue;
      }
      if (!this.folderPathExists(feed.folder)) {
        missingPaths.add(feed.folder);
      }
    }

    if (missingPaths.size === 0) {
      return;
    }

    let changed = false;
    for (const path of missingPaths) {
      const created = await this.ensureFolderExists(path, {
        saveSettings: false,
        refreshView: false,
      });
      if (created) {
        changed = true;
      }
    }

    if (changed) {
      await this.saveSettings();
      console.warn(
        `[RSS dashboard] Repaired ${missingPaths.size} missing feed folder path(s) during settings load.`,
      );
    }
  }

  /**
   * Ensures a folder path exists in the settings hierarchy
   * Handles nested paths like "News/Tech"
   */
  async ensureFolderExists(
    folderPath: string,
    options?: { saveSettings?: boolean; refreshView?: boolean },
  ): Promise<boolean> {
    if (!folderPath || folderPath === "Uncategorized") return false;

    const shouldSave = options?.saveSettings ?? true;
    const shouldRefresh = options?.refreshView ?? true;
    const parts = folderPath.split("/");
    let currentLevel = this.settings.folders;
    let changed = false;

    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      let folder = currentLevel.find((f) => f.name === part);
      if (!folder) {
        folder = {
          name: part,
          subfolders: [],
          createdAt: Date.now(),
          modifiedAt: Date.now(),
        };
        currentLevel.push(folder);
        changed = true;
      }
      if (!folder.subfolders) {
        folder.subfolders = [];
      }
      currentLevel = folder.subfolders;
    }

    if (changed && shouldSave) {
      await this.saveSettings();
      if (shouldRefresh) {
        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
        }
      }
    }

    return changed;
  }

  async addFeed(
    title: string,
    url: string,
    folder: string,
    autoDeleteDuration?: number,
    maxItemsLimit?: number,
    scanInterval?: number,
    feedFilters?: FeedFilterSettings,
  ) {
    try {
      if (this.settings.feeds.some((f) => f.url === url)) {
        new Notice("This feed URL already exists");
        return false;
      }

      let mediaType: "article" | "video" | "podcast" = "article";
      if (folder === this.settings.media.defaultYouTubeFolder) {
        mediaType = "video";
      } else if (folder === this.settings.media.defaultPodcastFolder) {
        mediaType = "podcast";
      }

      const newFeed: Feed = {
        title,
        url,
        folder,
        items: [],
        lastUpdated: Date.now(),
        autoDeleteDuration: autoDeleteDuration || 0,
        maxItemsLimit: maxItemsLimit || this.settings.maxItems,
        scanInterval: scanInterval || 0,
        mediaType: mediaType,
        filters: feedFilters || {
          overrideGlobalFilters: false,
          includeLogic: "AND",
          rules: [],
        },
      };

      // Try to parse the feed BEFORE adding it to settings
      try {
        const parsedFeed = await this.feedParser.parseFeed(url, newFeed, {
          allowEmpty: true,
        });
        if (parsedFeed.folder) {
          await this.ensureFolderExists(parsedFeed.folder, {
            saveSettings: false,
            refreshView: false,
          });
        }
        // Only add to settings if parsing succeeded
        this.settings.feeds.push(parsedFeed);
        await this.saveSettings();

        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
        }
        new Notice(`Feed "${title}" added`);
        return true;
      } catch (error) {
        new Notice(formatFeedParseNoticeMessage(error));
        return false;
      }
    } catch (error) {
      new Notice(
        `Error adding feed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return false;
    }
  }

  async addYouTubeFeed(input: string, customTitle?: string) {
    try {
      const feedUrl = await MediaService.getYouTubeRssFeed(input);

      if (!feedUrl) {
        new Notice("Unable to determine YouTube feed URL from input");
        return;
      }

      if (this.settings.feeds.some((f) => f.url === feedUrl)) {
        new Notice("This YouTube feed already exists");
        return;
      }

      const title = customTitle || `YouTube: ${input}`;
      await this.addFeed(
        title,
        feedUrl,
        this.settings.media.defaultYouTubeFolder,
      );
    } catch (error) {
      new Notice(
        `Error adding YouTube feed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async addSubfolder(parentFolderName: string, subfolderName: string) {
    const parentFolder = this.settings.folders.find(
      (f) => f.name === parentFolderName,
    );

    if (parentFolder) {
      if (!parentFolder.subfolders.some((sf) => sf.name === subfolderName)) {
        parentFolder.subfolders.push({
          name: subfolderName,
          subfolders: [],
        });

        await this.saveSettings();

        const view = await this.getActiveDashboardView();
        if (view) {
          void view.refresh();
          new Notice(
            `Subfolder "${subfolderName}" created under "${parentFolderName}"`,
          );
        }
      } else {
        new Notice(
          `Subfolder "${subfolderName}" already exists in "${parentFolderName}"`,
        );
      }
    }
  }

  async editFeed(
    feed: Feed,
    newTitle: string,
    newUrl: string,
    newFolder: string,
  ) {
    if (newFolder) {
      await this.ensureFolderExists(newFolder, {
        saveSettings: false,
        refreshView: false,
      });
    }

    const oldTitle = feed.title;
    feed.title = newTitle;
    feed.url = newUrl;
    feed.folder = newFolder;

    // Update feedTitle for all articles in this feed when the title changes
    if (oldTitle !== newTitle) {
      for (const item of feed.items) {
        item.feedTitle = newTitle;
      }
    }

    await this.saveSettings();

    const view = await this.getActiveDashboardView();
    if (view) {
      void view.refresh();
      new Notice(`Feed "${newTitle}" updated`);
    }
  }

  async loadSettings() {
    try {
      // Load settings from usersettings.json first, fall back to data.json
      const data = await this.loadUserSettings();

      if (!this.settings) {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
      } else {
        // Clear current settings to ensure we don't have stale data if fields were removed
        // but keep the object reference intact.
        Object.keys(this.settings).forEach((key) => {
          // @ts-ignore
          delete this.settings[key];
        });
        Object.assign(this.settings, DEFAULT_SETTINGS, data ?? {});
      }

      this.migrateLegacySettings();

      if (!this.settings.readerViewLocation) {
        this.settings.readerViewLocation = "right-sidebar";
      }

      if (this.settings.useWebViewer === undefined) {
        this.settings.useWebViewer = true;
      }

      if (!this.settings.articleSaving) {
        this.settings.articleSaving = DEFAULT_SETTINGS.articleSaving;
      } else {
        this.settings.articleSaving = Object.assign(
          {},
          DEFAULT_SETTINGS.articleSaving,
          this.settings.articleSaving,
        );
      }

      if (!this.settings.media) {
        this.settings.media = DEFAULT_SETTINGS.media;
      } else {
        this.settings.media = Object.assign(
          {},
          DEFAULT_SETTINGS.media,
          this.settings.media,
        );
      }

      if (!this.settings.autoTagging) {
        this.settings.autoTagging = DEFAULT_SETTINGS.autoTagging;
      } else {
        this.settings.autoTagging = Object.assign(
          {},
          DEFAULT_SETTINGS.autoTagging,
          this.settings.autoTagging,
        );
        if (!Array.isArray(this.settings.autoTagging.rules)) {
          this.settings.autoTagging.rules = [];
        }
      }

      // Ensure display settings are properly initialized
      if (!this.settings.display) {
        this.settings.display = DEFAULT_SETTINGS.display;
      } else {
        this.settings.display = Object.assign(
          {},
          DEFAULT_SETTINGS.display,
          this.settings.display,
        );
      }

      if (!this.settings.filters) {
        this.settings.filters = DEFAULT_SETTINGS.filters;
      } else {
        this.settings.filters = Object.assign(
          {},
          DEFAULT_SETTINGS.filters,
          this.settings.filters,
        );
      }

      for (const feed of this.settings.feeds) {
        if (!feed.filters) {
          feed.filters = {
            overrideGlobalFilters: false,
            includeLogic: "AND",
            rules: [],
          };
          continue;
        }

        feed.filters = Object.assign(
          {},
          {
            overrideGlobalFilters: false,
            includeLogic: "AND",
            rules: [],
          },
          feed.filters,
        );
      }

      // Initialize SQLite database only on first load
      const pluginDir = this.manifest.dir ?? "";
      if (!this.db || !this.db.isInitialized()) {
        this.db = new DatabaseService();
        await this.db.init(pluginDir, this.app.vault.adapter);
      }

      if (this.db.hasCorruption()) {
        const recoveredFromJson =
          await this.tryRecoverFromJsonBackups(pluginDir);
        if (recoveredFromJson) {
          new Notice(
            "Database was unreadable; feed data was recovered from backup and will be resynced.",
          );
        } else {
          const corruptionMessage = this.db.getCorruptionMessage();
          new Notice(
            `SQLite was unreadable and has been reset${corruptionMessage ? `: ${corruptionMessage}` : ""}`,
          );
        }
      }

      // Check if migration from JSON to SQLite is needed
      if (MigrationService.needsMigration(this.settings, this.db)) {
        new Notice("Migrating feed data to database for better performance...");
        await MigrationService.migrateFromJson(
          this.settings,
          this.db,
          this.app.vault.adapter,
          pluginDir,
        );
        new Notice("Migration complete");
      }

      // Load bulk data from SQLite (overrides any JSON data)
      if (this.db.hasData()) {
        this.settings.feeds = this.db.loadAllFeeds();
        this.settings.folders = this.db.loadAllFolders();
        const tags = this.db.loadAllTags();
        if (tags.length > 0) {
          this.settings.availableTags = tags;
        }
      }

      // Ensure feed filters after loading from SQLite
      for (const feed of this.settings.feeds) {
        if (!feed.filters) {
          feed.filters = {
            overrideGlobalFilters: false,
            includeLogic: "AND",
            rules: [],
          };
        }
      }
      AutoTagService.syncYouTubeShortsPreset(this.settings);
      await this.repairMissingFolderPathsForFeeds();
    } catch (error) {
      new Notice(
        `Error loading settings: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      this.settings = DEFAULT_SETTINGS;
    }
  }

  private async loadUserSettings(): Promise<RssDashboardSettings | null> {
    const pluginDir = this.manifest.dir ?? "";
    const settingsPath = `${pluginDir}/${USER_SETTINGS_FILENAME}`;

    try {
      const raw = await this.app.vault.adapter.read(settingsPath);
      return JSON.parse(raw) as RssDashboardSettings;
    } catch {
      // usersettings.json doesn't exist yet, fall back to data.json
      return (await this.loadData()) as RssDashboardSettings | null;
    }
  }

  private async tryRecoverFromJsonBackups(pluginDir: string): Promise<boolean> {
    const candidatePaths = [
      `${pluginDir}/data.json.backup`,
      `${pluginDir}/data.json`,
    ];

    for (const path of candidatePaths) {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsedUnknown = JSON.parse(raw) as unknown;
        if (!parsedUnknown || typeof parsedUnknown !== "object") {
          continue;
        }

        const parsed = parsedUnknown as Partial<RssDashboardSettings> & {
          feeds?: unknown;
          folders?: unknown;
          availableTags?: unknown;
        };
        if (!Array.isArray(parsed.feeds) || parsed.feeds.length === 0) {
          continue;
        }

        Object.keys(this.settings).forEach((key) => {
          delete (this.settings as unknown as Record<string, unknown>)[key];
        });
        Object.assign(this.settings, DEFAULT_SETTINGS, parsed);
        this.settings.feeds = parsed.feeds;
        this.settings.folders = Array.isArray(parsed.folders)
          ? parsed.folders
          : this.settings.folders;
        this.settings.availableTags = Array.isArray(parsed.availableTags)
          ? parsed.availableTags
          : this.settings.availableTags;

        this.migrateLegacySettings();
        for (const feed of this.settings.feeds) {
          if (!feed.filters) {
            feed.filters = {
              overrideGlobalFilters: false,
              includeLogic: "AND",
              rules: [],
            };
            continue;
          }

          feed.filters = Object.assign(
            {},
            {
              overrideGlobalFilters: false,
              includeLogic: "AND",
              rules: [],
            },
            feed.filters,
          );
        }

        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private migrateLegacySettings(): void {
    const settingsUnknown = this.settings as unknown as Record<string, unknown>;
    if (
      settingsUnknown.savePath &&
      !this.settings.articleSaving?.defaultFolder
    ) {
      if (!this.settings.articleSaving) {
        this.settings.articleSaving = DEFAULT_SETTINGS.articleSaving;
      }
      this.settings.articleSaving.defaultFolder =
        settingsUnknown.savePath as string;
      delete settingsUnknown.savePath;
    }

    if (
      settingsUnknown.template &&
      !this.settings.articleSaving?.defaultTemplate
    ) {
      if (!this.settings.articleSaving) {
        this.settings.articleSaving = DEFAULT_SETTINGS.articleSaving;
      }
      this.settings.articleSaving.defaultTemplate =
        settingsUnknown.template as string;
      delete settingsUnknown.template;
    }

    if (
      settingsUnknown.addSavedTag !== undefined &&
      this.settings.articleSaving?.addSavedTag === undefined
    ) {
      if (!this.settings.articleSaving) {
        this.settings.articleSaving = DEFAULT_SETTINGS.articleSaving;
      }
      this.settings.articleSaving.addSavedTag =
        settingsUnknown.addSavedTag as boolean;
      delete settingsUnknown.addSavedTag;
    }

    const articleSavingUnknown = this.settings
      .articleSaving as unknown as Record<string, unknown>;
    if (
      articleSavingUnknown.template &&
      !this.settings.articleSaving?.defaultTemplate
    ) {
      this.settings.articleSaving.defaultTemplate =
        articleSavingUnknown.template as string;
      delete articleSavingUnknown.template;
    }

    // Migrate display settings
    if (!this.settings.display) {
      this.settings.display = DEFAULT_SETTINGS.display;
    } else {
      // Ensure new display properties exist
      if (this.settings.display.filterDisplayStyle === undefined) {
        this.settings.display.filterDisplayStyle =
          DEFAULT_SETTINGS.display.filterDisplayStyle;
      }
      if (this.settings.display.defaultFilter === undefined) {
        this.settings.display.defaultFilter =
          DEFAULT_SETTINGS.display.defaultFilter;
      }
      if (this.settings.display.hiddenFilters === undefined) {
        this.settings.display.hiddenFilters =
          DEFAULT_SETTINGS.display.hiddenFilters;
      }
      if (this.settings.display.showFilterStatusBar === undefined) {
        this.settings.display.showFilterStatusBar =
          DEFAULT_SETTINGS.display.showFilterStatusBar;
      }
      if (this.settings.display.showFolderUnreadBadges === undefined) {
        this.settings.display.showFolderUnreadBadges =
          DEFAULT_SETTINGS.display.showFolderUnreadBadges;
      }
      if (this.settings.display.showAllFeedsUnreadBadges === undefined) {
        this.settings.display.showAllFeedsUnreadBadges =
          DEFAULT_SETTINGS.display.showAllFeedsUnreadBadges;
      }
      if (this.settings.display.showFeedUnreadBadges === undefined) {
        this.settings.display.showFeedUnreadBadges =
          DEFAULT_SETTINGS.display.showFeedUnreadBadges;
      }
      if (!this.settings.display.allFeedsUnreadBadgeColor) {
        this.settings.display.allFeedsUnreadBadgeColor =
          DEFAULT_SETTINGS.display.allFeedsUnreadBadgeColor;
      }
      if (!this.settings.display.folderUnreadBadgeColor) {
        this.settings.display.folderUnreadBadgeColor =
          DEFAULT_SETTINGS.display.folderUnreadBadgeColor;
      }
      if (!this.settings.display.feedUnreadBadgeColor) {
        this.settings.display.feedUnreadBadgeColor =
          DEFAULT_SETTINGS.display.feedUnreadBadgeColor;
      }
      if (!this.settings.display.allFeedsUnreadBadgeDefaultColor) {
        this.settings.display.allFeedsUnreadBadgeDefaultColor =
          DEFAULT_SETTINGS.display.allFeedsUnreadBadgeDefaultColor;
      }
      if (!this.settings.display.folderUnreadBadgeDefaultColor) {
        this.settings.display.folderUnreadBadgeDefaultColor =
          DEFAULT_SETTINGS.display.folderUnreadBadgeDefaultColor;
      }
      if (!this.settings.display.feedUnreadBadgeDefaultColor) {
        this.settings.display.feedUnreadBadgeDefaultColor =
          DEFAULT_SETTINGS.display.feedUnreadBadgeDefaultColor;
      }
    }

    if (!this.settings.filters) {
      this.settings.filters = DEFAULT_SETTINGS.filters;
    } else {
      if (!this.settings.filters.includeLogic) {
        this.settings.filters.includeLogic = "AND";
      }
      if (this.settings.filters.bypassAll === undefined) {
        this.settings.filters.bypassAll = false;
      }
      if (!this.settings.filters.rules) {
        this.settings.filters.rules = [];
      }
    }

    this.settings.feeds.forEach((feed) => {
      if (!feed.filters) {
        feed.filters = {
          overrideGlobalFilters: false,
          includeLogic: "AND",
          rules: [],
        };
        return;
      }

      if (feed.filters.overrideGlobalFilters === undefined) {
        feed.filters.overrideGlobalFilters = false;
      }
      if (!feed.filters.includeLogic) {
        feed.filters.includeLogic = "AND";
      }
      if (!feed.filters.rules) {
        feed.filters.rules = [];
      }
    });
  }

  async saveSettings() {
    // Save settings-only (without feeds/folders/tags) to usersettings.json
    await this.saveSettingsOnly();

    if (this.isBackgroundImporting) {
      return;
    }

    // Write to in-memory SQLite immediately, debounce disk flush only
    if (this.db?.isInitialized()) {
      this.db.saveAllFeeds(this.settings.feeds);
      this.db.saveAllFolders(this.settings.folders);
      this.db.saveAllTags(this.settings.availableTags);
    }
    this.scheduleDiskFlush();
  }

  private async saveSettingsOnly(): Promise<void> {
    const pluginDir = this.manifest.dir ?? "";
    const settingsPath = `${pluginDir}/${USER_SETTINGS_FILENAME}`;
    const settingsOnly = this.getSettingsOnlyData();

    if (this.settingsWriteTimeout) {
      clearTimeout(this.settingsWriteTimeout);
      this.settingsWriteTimeout = null;
    }
    this.isWritingToSettings = true;
    try {
      await this.app.vault.adapter.write(
        settingsPath,
        JSON.stringify(settingsOnly, null, 2),
      );
    } finally {
      this.settingsWriteTimeout = setTimeout(() => {
        this.isWritingToSettings = false;
      }, 2000);
    }
  }

  private getSettingsOnlyData(): Omit<
    RssDashboardSettings,
    "feeds" | "folders" | "availableTags"
  > {
    const { feeds, folders, availableTags, ...settingsOnly } = this.settings;
    void feeds;
    void folders;
    void availableTags;
    return settingsOnly;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.body.createEl("a", {
      attr: { href: url, download: filename },
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  private scheduleDiskFlush(): void {
    if (this.dbSyncTimer) {
      clearTimeout(this.dbSyncTimer);
    }
    this.dbSyncTimer = setTimeout(() => {
      void this.flushDatabaseToDisk();
      this.dbSyncTimer = null;
    }, 2000); // Reduced to 2s for more responsive disk sync
  }

  private async flushDatabaseToDisk(): Promise<void> {
    if (this.dbSyncTimer) {
      clearTimeout(this.dbSyncTimer);
      this.dbSyncTimer = null;
    }
    if (this.databaseWriteTimeout) {
      clearTimeout(this.databaseWriteTimeout);
      this.databaseWriteTimeout = null;
    }
    this.isWritingToDatabase = true;
    try {
      if (this.db?.isInitialized()) {
        await this.db.forceSave();
      }
    } finally {
      this.databaseWriteTimeout = setTimeout(() => {
        this.isWritingToDatabase = false;
      }, 2000);
    }
  }

  async reapplyAutoTagRulesToAllArticles(): Promise<void> {
    AutoTagService.syncYouTubeShortsPreset(this.settings);
    const result = AutoTagService.reapplyToAllFeeds(this.settings);
    await this.saveSettings();
    await this.refreshOpenViews();

    new Notice(
      `Auto-tag reapply complete: scanned ${result.scannedItems} items, updated ${result.changedItems}, added ${result.tagsAdded}, removed ${result.tagsRemoved}`,
    );
  }

  onunload() {
    // Synchronous shutdown: sync in-memory state to SQLite object, then export
    try {
      if (this.db?.isInitialized()) {
        this.db.saveAllFeeds(this.settings.feeds);
        this.db.saveAllFolders(this.settings.folders);
        this.db.saveAllTags(this.settings.availableTags);
        this.db.saveSync(this.app.vault.adapter, this.manifest.dir ?? "");
      }
    } finally {
      this.db?.close();
    }
  }

  private async validateSavedArticles(): Promise<void> {
    let updatedCount = 0;

    for (const feed of this.settings.feeds) {
      for (const item of feed.items) {
        if (item.saved) {
          const fileExists = this.checkSavedFileExists(item);
          if (!fileExists) {
            item.saved = false;

            if (item.tags) {
              item.tags = item.tags.filter(
                (tag) => tag.name.toLowerCase() !== "saved",
              );
            }

            updatedCount++;
          }
        }
      }
    }

    if (updatedCount > 0) {
      await this.saveSettings();

      const view = await this.getActiveDashboardView();
      if (view) {
        view.render();
      }
    }
  }

  private checkSavedFileExists(item: FeedItem): boolean {
    try {
      const folder =
        this.settings.articleSaving.defaultFolder || "RSS articles";
      const filename = this.sanitizeFilename(item.title);
      const filePath = folder ? `${folder}/${filename}.md` : `${filename}.md`;

      return this.app.vault.getAbstractFileByPath(filePath) !== null;
    } catch {
      return false;
    }
  }

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .substring(0, 100);
  }

  private async restoreFromJsonBackup(): Promise<void> {
    const pluginDir = this.manifest.dir ?? "";
    const hasBackup = await MigrationService.hasBackup(
      this.app.vault.adapter,
      pluginDir,
    );
    if (!hasBackup) {
      new Notice("No backup found");
      return;
    }
    const backupData = await MigrationService.restoreFromBackup(
      this.app.vault.adapter,
      pluginDir,
    );
    if (!backupData) {
      new Notice("Backup file could not be read");
      return;
    }

    try {
      const restoredUnknown = JSON.parse(backupData) as unknown;
      if (!restoredUnknown || typeof restoredUnknown !== "object") {
        throw new Error("Backup JSON is invalid");
      }

      const restored = restoredUnknown as Partial<RssDashboardSettings> & {
        feeds?: unknown;
        folders?: unknown;
        availableTags?: unknown;
      };
      if (!Array.isArray(restored.feeds)) {
        throw new Error("Backup JSON does not contain feeds");
      }

      this.settings = Object.assign({}, DEFAULT_SETTINGS, restored);
      this.settings.feeds = restored.feeds;
      this.settings.folders = Array.isArray(restored.folders)
        ? restored.folders
        : this.settings.folders;
      this.settings.availableTags = Array.isArray(restored.availableTags)
        ? restored.availableTags
        : this.settings.availableTags;

      this.migrateLegacySettings();
      for (const feed of this.settings.feeds) {
        if (!feed.filters) {
          feed.filters = {
            overrideGlobalFilters: false,
            includeLogic: "AND",
            rules: [],
          };
          continue;
        }
        feed.filters = Object.assign(
          {},
          {
            overrideGlobalFilters: false,
            includeLogic: "AND",
            rules: [],
          },
          feed.filters,
        );
      }

      if (!this.db?.isInitialized()) {
        this.db = new DatabaseService();
        await this.db.init(pluginDir, this.app.vault.adapter);
      }

      await this.flushDatabaseToDisk();
      await this.saveSettingsOnly();
      new Notice("Restored from backup successfully");
      const view = await this.getActiveDashboardView();
      if (view) {
        view.render();
      }
    } catch (error) {
      new Notice(
        `Failed to restore from backup: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private getAllArticles(): FeedItem[] {
    let allArticles: FeedItem[] = [];
    for (const feed of this.settings.feeds) {
      allArticles = allArticles.concat(feed.items);
    }
    return allArticles;
  }
}
