import {
  AutoTagCondition,
  AutoTagRule,
  AutoTagSettings,
  Feed,
  FeedItem,
  RssDashboardSettings,
  Tag,
} from "../types/types";
import { MediaService } from "./media-service";

export interface AutoTagApplyResult {
  changed: boolean;
  tagsAdded: number;
  tagsRemoved: number;
}

export interface AutoTagReapplyResult {
  scannedItems: number;
  changedItems: number;
  tagsAdded: number;
  tagsRemoved: number;
}

export class AutoTagService {
  static readonly YOUTUBE_SHORTS_PRESET_RULE_ID = "preset-youtube-shorts";
  static readonly YOUTUBE_SHORTS_PRESET_KEY = "youtube-shorts";

  static createDefaultSettings(): AutoTagSettings {
    return {
      rules: [],
    };
  }

  static createDefaultRule(): AutoTagRule {
    const timestamp = Date.now();
    return {
      id: `auto-tag-rule-${timestamp}-${Math.floor(Math.random() * 10000)}`,
      name: "New auto-tag rule",
      enabled: true,
      source: "custom",
      tagName: "",
      matchLogic: "any",
      conditions: [this.createDefaultCondition()],
      createdAt: timestamp,
    };
  }

  static createDefaultCondition(
    type: AutoTagCondition["type"] = "phrase",
  ): AutoTagCondition {
    const timestamp = Date.now();
    return {
      id: `auto-tag-condition-${timestamp}-${Math.floor(Math.random() * 10000)}`,
      type,
      value: "",
      enabled: true,
      caseSensitive: false,
      textTargets: ["title"],
      urlTargets: ["itemLink"],
      urlPatternMode: "contains",
      createdAt: timestamp,
    };
  }

  static buildYouTubeShortsPresetRule(enabled: boolean): AutoTagRule {
    return {
      id: this.YOUTUBE_SHORTS_PRESET_RULE_ID,
      name: "YouTube Shorts",
      enabled,
      source: "preset",
      presetKey: this.YOUTUBE_SHORTS_PRESET_KEY,
      tagName: MediaService.YOUTUBE_SHORT_TAG_NAME,
      matchLogic: "all",
      conditions: [
        {
          id: `${this.YOUTUBE_SHORTS_PRESET_RULE_ID}-feed-url`,
          type: "url-pattern",
          value: "youtube.com/feeds/videos.xml",
          enabled: true,
          caseSensitive: false,
          textTargets: [],
          urlTargets: ["feedUrl"],
          urlPatternMode: "contains",
          createdAt: 0,
        },
        {
          id: `${this.YOUTUBE_SHORTS_PRESET_RULE_ID}-item-url`,
          type: "url-pattern",
          value: "/shorts/",
          enabled: true,
          caseSensitive: false,
          textTargets: [],
          urlTargets: ["itemLink"],
          urlPatternMode: "contains",
          createdAt: 0,
        },
      ],
      createdAt: 0,
    };
  }

  static ensureSettings(settings: RssDashboardSettings): void {
    if (!settings.autoTagging) {
      settings.autoTagging = this.createDefaultSettings();
    }

    if (!Array.isArray(settings.autoTagging.rules)) {
      settings.autoTagging.rules = [];
    }

  }

  static syncYouTubeShortsPreset(settings: RssDashboardSettings): void {
    this.ensureSettings(settings);

    const enabled = !!settings.media.detectYouTubeShorts;
    const presetRule = this.buildYouTubeShortsPresetRule(enabled);
    const presetRuleIndex = settings.autoTagging.rules.findIndex(
      (rule) => rule.id === this.YOUTUBE_SHORTS_PRESET_RULE_ID,
    );

    if (presetRuleIndex === -1) {
      settings.autoTagging.rules.push(presetRule);
    } else {
      const existingRule = settings.autoTagging.rules[presetRuleIndex];
      settings.autoTagging.rules[presetRuleIndex] = {
        ...existingRule,
        ...presetRule,
        tagName: existingRule.tagName || presetRule.tagName,
        createdAt: existingRule.createdAt || presetRule.createdAt,
      };
    }

    if (enabled) {
      this.ensureTagExists(
        settings.availableTags,
        this.getPresetRule(settings)?.tagName || MediaService.YOUTUBE_SHORT_TAG_NAME,
        MediaService.YOUTUBE_SHORT_TAG_COLOR,
      );
    }
  }

  static getPresetRule(settings: RssDashboardSettings): AutoTagRule | undefined {
    return settings.autoTagging?.rules.find(
      (rule) => rule.id === this.YOUTUBE_SHORTS_PRESET_RULE_ID,
    );
  }

  static getPresetRules(settings: RssDashboardSettings): AutoTagRule[] {
    return settings.autoTagging.rules.filter((rule) => rule.source === "preset");
  }

  static getCustomRules(settings: RssDashboardSettings): AutoTagRule[] {
    return settings.autoTagging.rules.filter((rule) => rule.source === "custom");
  }

  static setCustomRules(
    settings: RssDashboardSettings,
    customRules: AutoTagRule[],
  ): void {
    const presetRules = this.getPresetRules(settings);
    settings.autoTagging.rules = [...presetRules, ...customRules];
  }

  static ensureTagExists(
    availableTags: Tag[],
    tagName: string,
    tagColor: string,
  ): Tag {
    const existingTag = availableTags.find(
      (tag) => tag.name.toLowerCase() === tagName.toLowerCase(),
    );
    if (existingTag) {
      return existingTag;
    }

    const newTag = {
      name: tagName,
      color: tagColor,
    };
    availableTags.push(newTag);
    return newTag;
  }

  static applyAutoTagsToItem(
    item: FeedItem,
    feed: Pick<Feed, "url">,
    settings: RssDashboardSettings,
  ): AutoTagApplyResult {
    this.ensureSettings(settings);
    const activeRules = this.getActiveRules(settings);

    if (!item.tags) {
      item.tags = [];
    }

    const matchedRuleIdsByTag = new Map<string, string[]>();

    for (const rule of activeRules) {
      const targetTag = this.findAvailableTag(settings.availableTags, rule.tagName);
      if (!targetTag) {
        continue;
      }

      if (this.matchesRule(rule, item, feed)) {
        const existingRuleIds = matchedRuleIdsByTag.get(
          targetTag.name.toLowerCase(),
        );
        if (existingRuleIds) {
          existingRuleIds.push(rule.id);
        } else {
          matchedRuleIdsByTag.set(targetTag.name.toLowerCase(), [rule.id]);
        }
      }
    }

    const previousState = new Map(
      (item.autoTagState || []).map((entry) => [entry.tagName.toLowerCase(), entry]),
    );
    const nextState: FeedItem["autoTagState"] = [];
    let tagsAdded = 0;
    let tagsRemoved = 0;

    for (const [tagNameLower, ruleIds] of matchedRuleIdsByTag.entries()) {
      const targetTag = this.findAvailableTag(settings.availableTags, tagNameLower);
      if (!targetTag) {
        continue;
      }

      if (!item.tags.some((tag) => tag.name.toLowerCase() === tagNameLower)) {
        item.tags.push({ ...targetTag });
        tagsAdded++;
      }

      nextState.push({
        tagName: targetTag.name,
        ruleIds: [...new Set(ruleIds)],
      });
      previousState.delete(tagNameLower);
    }

    for (const [tagNameLower, stateEntry] of previousState.entries()) {
      if (!stateEntry.ruleIds.length) {
        continue;
      }

      const tagIndex = item.tags.findIndex(
        (tag) => tag.name.toLowerCase() === tagNameLower,
      );
      if (tagIndex !== -1) {
        item.tags.splice(tagIndex, 1);
        tagsRemoved++;
      }
    }

    item.autoTagState = nextState.length > 0 ? nextState : undefined;

    return {
      changed: tagsAdded > 0 || tagsRemoved > 0,
      tagsAdded,
      tagsRemoved,
    };
  }

  static reapplyToAllFeeds(settings: RssDashboardSettings): AutoTagReapplyResult {
    let scannedItems = 0;
    let changedItems = 0;
    let tagsAdded = 0;
    let tagsRemoved = 0;

    for (const feed of settings.feeds) {
      for (const item of feed.items) {
        scannedItems++;
        const result = this.applyAutoTagsToItem(item, feed, settings);
        if (result.changed) {
          changedItems++;
          tagsAdded += result.tagsAdded;
          tagsRemoved += result.tagsRemoved;
        }
      }
    }

    return {
      scannedItems,
      changedItems,
      tagsAdded,
      tagsRemoved,
    };
  }

  static renameTagReferences(
    settings: RssDashboardSettings,
    previousName: string,
    nextName: string,
  ): void {
    const previousNameLower = previousName.toLowerCase();

    settings.autoTagging.rules.forEach((rule) => {
      if (rule.tagName.toLowerCase() === previousNameLower) {
        rule.tagName = nextName;
      }
    });

    settings.feeds.forEach((feed) => {
      feed.items.forEach((item) => {
        if (!item.autoTagState) {
          return;
        }

        item.autoTagState.forEach((entry) => {
          if (entry.tagName.toLowerCase() === previousNameLower) {
            entry.tagName = nextName;
          }
        });
      });
    });
  }

  static removeTagReferences(
    settings: RssDashboardSettings,
    deletedTagName: string,
  ): void {
    const deletedTagLower = deletedTagName.toLowerCase();

    settings.autoTagging.rules = settings.autoTagging.rules.filter((rule) => {
      if (rule.tagName.toLowerCase() !== deletedTagLower) {
        return true;
      }

      if (rule.source === "preset") {
        settings.media.detectYouTubeShorts = false;
        return true;
      }

      return false;
    });

    settings.feeds.forEach((feed) => {
      feed.items.forEach((item) => {
        if (item.tags) {
          item.tags = item.tags.filter(
            (tag) => tag.name.toLowerCase() !== deletedTagLower,
          );
        }

        if (item.autoTagState) {
          item.autoTagState = item.autoTagState.filter(
            (entry) => entry.tagName.toLowerCase() !== deletedTagLower,
          );
          if (item.autoTagState.length === 0) {
            item.autoTagState = undefined;
          }
        }
      });
    });

    this.syncYouTubeShortsPreset(settings);
  }

  private static getActiveRules(settings: RssDashboardSettings): AutoTagRule[] {
    return settings.autoTagging.rules.filter((rule) => rule.enabled);
  }

  private static findAvailableTag(
    availableTags: Tag[],
    tagName: string,
  ): Tag | undefined {
    const tagNameLower = tagName.toLowerCase();
    return availableTags.find((tag) => tag.name.toLowerCase() === tagNameLower);
  }

  private static matchesRule(
    rule: AutoTagRule,
    item: FeedItem,
    feed: Pick<Feed, "url">,
  ): boolean {
    const conditions = rule.conditions.filter((condition) =>
      this.isConditionValid(condition),
    );

    if (conditions.length === 0) {
      return false;
    }

    const results = conditions.map((condition) =>
      this.matchesCondition(condition, item, feed),
    );

    if (rule.matchLogic === "all") {
      return results.every(Boolean);
    }

    return results.some(Boolean);
  }

  private static isConditionValid(condition: AutoTagCondition): boolean {
    if (!condition.enabled || !condition.value.trim()) {
      return false;
    }

    if (condition.type === "url-pattern") {
      return condition.urlTargets.length > 0;
    }

    return condition.textTargets.length > 0;
  }

  private static matchesCondition(
    condition: AutoTagCondition,
    item: FeedItem,
    feed: Pick<Feed, "url">,
  ): boolean {
    if (condition.type === "url-pattern") {
      const urlValues = condition.urlTargets.map((target) =>
        target === "feedUrl" ? feed.url : item.link || "",
      );
      return urlValues.some((value) =>
        this.matchesUrlPattern(value, condition),
      );
    }

    const textValues = condition.textTargets.map((target) => {
      if (target === "title") return item.title || "";
      if (target === "summary") return item.summary || item.description || "";
      return item.content || item.description || "";
    });

    return textValues.some((value) => this.matchesText(value, condition));
  }

  private static matchesText(
    value: string,
    condition: AutoTagCondition,
  ): boolean {
    const normalizedValue = this.normalizeText(value, condition.caseSensitive);
    const normalizedNeedle = this.normalizeText(
      condition.value,
      condition.caseSensitive,
    );

    if (!normalizedValue || !normalizedNeedle) {
      return false;
    }

    if (condition.type === "phrase") {
      return normalizedValue.includes(normalizedNeedle);
    }

    const flags = condition.caseSensitive ? "" : "i";
    const escapedNeedle = this.escapeRegex(normalizedNeedle);
    const wordRegex = new RegExp(`(^|[^A-Za-z0-9_])${escapedNeedle}([^A-Za-z0-9_]|$)`, flags);
    return wordRegex.test(normalizedValue);
  }

  private static matchesUrlPattern(
    value: string,
    condition: AutoTagCondition,
  ): boolean {
    const normalizedValue = condition.caseSensitive ? value : value.toLowerCase();
    const normalizedPattern = condition.caseSensitive
      ? condition.value
      : condition.value.toLowerCase();

    if (!normalizedValue || !normalizedPattern) {
      return false;
    }

    if (condition.urlPatternMode === "wildcard") {
      const wildcardPattern = this.escapeRegex(normalizedPattern).replace(
        /\\\*/g,
        ".*",
      );
      return new RegExp(`^${wildcardPattern}$`).test(normalizedValue);
    }

    return normalizedValue.includes(normalizedPattern);
  }

  private static normalizeText(value: string, caseSensitive: boolean): string {
    const plainText = value
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();

    return caseSensitive ? plainText : plainText.toLowerCase();
  }

  private static escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
