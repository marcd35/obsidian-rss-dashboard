import { Notice, Setting } from "obsidian";
import { AutoTagService } from "../services/auto-tag-service";
import {
  AutoTagCondition,
  AutoTagRule,
  AutoTagTextTarget,
  AutoTagUrlTarget,
  RssDashboardSettings,
} from "../types/types";

interface AutoTagRuleEditorOptions {
  containerEl: HTMLElement;
  settings: RssDashboardSettings;
  onChange: () => void | Promise<void>;
  onReapply: () => void | Promise<void>;
}

type CommitOptions = {
  rerender?: boolean;
};

interface TargetOption<T extends string> {
  key: T;
  label: string;
  description: string;
}

const TEXT_TARGET_OPTIONS: TargetOption<AutoTagTextTarget>[] = [
  {
    key: "title",
    label: "Title",
    description: "Match against the article title.",
  },
  {
    key: "summary",
    label: "Summary",
    description: "Match against the article summary or description.",
  },
  {
    key: "content",
    label: "Content",
    description: "Match against the full article content when available.",
  },
];

const URL_TARGET_OPTIONS: TargetOption<AutoTagUrlTarget>[] = [
  {
    key: "itemLink",
    label: "Item URL",
    description: "Match against the article URL.",
  },
  {
    key: "feedUrl",
    label: "Feed URL",
    description: "Match against the source feed URL.",
  },
];

export function renderAutoTagRuleEditor(
  options: AutoTagRuleEditorOptions,
): void {
  const { containerEl, settings, onChange, onReapply } = options;
  containerEl.empty();
  containerEl.addClass("rss-auto-tag-editor-shell");

  const commit = ({ rerender = false }: CommitOptions = {}): void => {
    void (async () => {
      await onChange();
      if (rerender) {
        renderAutoTagRuleEditor(options);
      }
    })();
  };

  const actionsSurface = containerEl.createDiv({
    cls: "rss-auto-tag-surface rss-auto-tag-actions-surface",
  });

  new Setting(actionsSurface)
    .setName("Scan all and apply auto tagging")
    .setDesc("Scan every stored article and apply enabled auto-tagging rules.")
    .setClass("rss-auto-tag-action-setting")
    .addButton((button) => {
      button
        .setButtonText("Scan and tag")
        .setCta()
        .onClick(() => {
          void onReapply();
        });
      button.buttonEl.addClass("rss-auto-tag-action-button");
    });

  const rulesSurface = containerEl.createDiv({
    cls: "rss-auto-tag-surface rss-auto-tag-rules-surface",
  });

  new Setting(rulesSurface)
    .setName("Custom rules")
    .setHeading()
    .setClass("rss-auto-tag-section-heading");

  rulesSurface.createEl("p", {
    cls: "rss-auto-tag-section-description",
    text: "Create rules that apply tags from title, summary, content, feed URL, or article URL matches.",
  });

  const rulesList = rulesSurface.createDiv({
    cls: "rss-auto-tag-rules-list",
  });

  const customRules = AutoTagService.getCustomRules(settings);
  if (customRules.length === 0) {
    rulesList.createDiv({
      cls: "rss-auto-tag-empty-state",
      text: "No custom auto-tag rules configured yet.",
    });
  } else {
    customRules.forEach((rule, index) => {
      renderRuleCard(rulesList, settings, rule, index, commit);
    });
  }

  new Setting(rulesSurface)
    .setClass("rss-auto-tag-footer-setting")
    .addButton((button) => {
      button
        .setButtonText("Add auto-tag rule")
        .setCta()
        .onClick(() => {
          const nextRules = [
            ...AutoTagService.getCustomRules(settings),
            AutoTagService.createDefaultRule(),
          ];
          AutoTagService.setCustomRules(settings, nextRules);
          commit({ rerender: true });
        });
      button.buttonEl.addClass(
        "rss-auto-tag-action-button",
        "rss-auto-tag-add-button",
      );
    });
}

function renderRuleCard(
  containerEl: HTMLElement,
  settings: RssDashboardSettings,
  rule: AutoTagRule,
  ruleIndex: number,
  commit: (options?: CommitOptions) => void,
): void {
  const ruleContainer = containerEl.createDiv({
    cls: "rss-auto-tag-rule-card",
  });
  if (!rule.enabled) {
    ruleContainer.addClass("is-disabled");
  }

  const headerSetting = new Setting(ruleContainer)
    .setName(rule.name || "Untitled rule")
    .setDesc(`Rule ${ruleIndex + 1}`)
    .setClass("rss-auto-tag-rule-header");
  const updateRuleTitle = (): void => {
    headerSetting.setName(rule.name || "Untitled rule");
  };

  headerSetting.addToggle((toggle) =>
    toggle.setValue(rule.enabled).onChange((value) => {
      rule.enabled = value;
      ruleContainer.toggleClass("is-disabled", !value);
      commit();
    }),
  );
  headerSetting.addButton((button) => {
    button
      .setButtonText("Delete")
      .setWarning()
      .setTooltip(`Delete ${rule.name || "this rule"}`)
      .onClick(() => {
        AutoTagService.setCustomRules(
          settings,
          AutoTagService.getCustomRules(settings).filter(
            (candidate) => candidate.id !== rule.id,
          ),
        );
        commit({ rerender: true });
      });
    button.buttonEl.addClass("rss-auto-tag-delete-button");
  });

  const ruleBody = ruleContainer.createDiv({
    cls: "rss-auto-tag-rule-body",
  });

  new Setting(ruleBody)
    .setName("Rule name")
    .setDesc("Give this rule a recognizable label.")
    .setClass("rss-auto-tag-card-setting")
    .setDisabled(!rule.enabled)
    .addText((text) => {
      text.setValue(rule.name);
      text.inputEl.spellcheck = false;
      text.inputEl.addClass("rss-auto-tag-text-input");
      text.onChange((value) => {
        rule.name = value.trim() || "Untitled rule";
        updateRuleTitle();
        commit();
      });
    });

  new Setting(ruleBody)
    .setName("Target tag")
    .setDesc("Choose which existing tag this rule will apply.")
    .setClass("rss-auto-tag-card-setting")
    .setDisabled(!rule.enabled)
    .addDropdown((dropdown) => {
      dropdown.selectEl.addClass("rss-auto-tag-select");
      dropdown.addOption("", "Select a tag");
      settings.availableTags.forEach((tag) => {
        dropdown.addOption(tag.name, tag.name);
      });
      dropdown.setValue(rule.tagName || "");
      dropdown.onChange((value) => {
        rule.tagName = value;
        commit({ rerender: true });
      });
    });

  new Setting(ruleBody)
    .setName("Match logic")
    .setDesc("Choose whether any condition or every condition must match.")
    .setClass("rss-auto-tag-card-setting")
    .setDisabled(!rule.enabled)
    .addDropdown((dropdown) => {
      dropdown.selectEl.addClass("rss-auto-tag-select");
      dropdown.addOption("any", "Any condition");
      dropdown.addOption("all", "All conditions");
      dropdown.setValue(rule.matchLogic);
      dropdown.onChange((value) => {
        rule.matchLogic = value as AutoTagRule["matchLogic"];
        commit();
      });
    });

  const validationList = ruleBody.createDiv({
    cls: "rss-auto-tag-validation-list",
  });
  if (!hasValidRuleTag(rule, settings)) {
    validationList.createDiv({
      cls: "rss-auto-tag-validation-note",
      text: "Select a valid target tag before this rule can apply anything.",
    });
    ruleContainer.addClass("is-invalid");
  }

  const conditionsSection = ruleBody.createDiv({
    cls: "rss-auto-tag-conditions-section",
  });
  const conditionsHeader = new Setting(conditionsSection)
    .setName("Conditions")
    .setDesc("Add one or more checks to determine when the tag should be applied.")
    .setClass("rss-auto-tag-conditions-heading");
  conditionsHeader.setHeading();

  const conditionsList = conditionsSection.createDiv({
    cls: "rss-auto-tag-conditions-list",
  });

  rule.conditions.forEach((condition, conditionIndex) => {
    renderConditionCard(
      conditionsList,
      condition,
      conditionIndex,
      rule,
      settings,
      !rule.enabled,
      commit,
    );
  });

  new Setting(conditionsSection)
    .setClass("rss-auto-tag-footer-setting")
    .addButton((button) => {
      button
        .setButtonText("Add condition")
        .setDisabled(!rule.enabled)
        .onClick(() => {
          rule.conditions.push(AutoTagService.createDefaultCondition());
          commit({ rerender: true });
        });
      button.buttonEl.addClass("rss-auto-tag-add-condition-button");
    });
}

function renderConditionCard(
  containerEl: HTMLElement,
  condition: AutoTagCondition,
  conditionIndex: number,
  rule: AutoTagRule,
  settings: RssDashboardSettings,
  ruleDisabled: boolean,
  commit: (options?: CommitOptions) => void,
): void {
  const conditionContainer = containerEl.createDiv({
    cls: "rss-auto-tag-condition-card",
  });
  if (ruleDisabled || !condition.enabled) {
    conditionContainer.addClass("is-disabled");
  }

  const conditionDisabled = ruleDisabled || !condition.enabled;
  const headerSetting = new Setting(conditionContainer)
    .setName(`Condition ${conditionIndex + 1}`)
    .setDesc(getConditionDescription(condition))
    .setClass("rss-auto-tag-condition-header");

  const updateConditionHeader = (): void => {
    headerSetting.setDesc(getConditionDescription(condition));
  };

  headerSetting.addToggle((toggle) =>
    toggle.setValue(condition.enabled).onChange((value) => {
      condition.enabled = value;
      conditionContainer.toggleClass("is-disabled", ruleDisabled || !value);
      commit();
    }),
  );
  headerSetting.addButton((button) => {
    button
      .setButtonText("Delete")
      .setWarning()
      .setTooltip(`Delete condition ${conditionIndex + 1}`)
      .onClick(() => {
        rule.conditions = rule.conditions.filter(
          (candidate) => candidate.id !== condition.id,
        );
        if (rule.conditions.length === 0) {
          rule.conditions.push(AutoTagService.createDefaultCondition());
        }
        commit({ rerender: true });
      });
    button.buttonEl.addClass("rss-auto-tag-delete-button");
  });

  new Setting(conditionContainer)
    .setName("Condition type")
    .setDesc("Choose the kind of match this condition should perform.")
    .setClass("rss-auto-tag-card-setting")
    .setDisabled(conditionDisabled)
    .addDropdown((dropdown) => {
      dropdown.selectEl.addClass("rss-auto-tag-select");
      dropdown.addOption("keyword", "Keyword");
      dropdown.addOption("phrase", "Phrase");
      dropdown.addOption("url-pattern", "URL pattern");
      dropdown.setValue(condition.type);
      dropdown.onChange((value) => {
        condition.type = value as AutoTagCondition["type"];
        if (condition.type === "url-pattern") {
          if (condition.urlTargets.length === 0) {
            condition.urlTargets = ["itemLink"];
          }
        } else if (condition.textTargets.length === 0) {
          condition.textTargets = ["title"];
        }
        updateConditionHeader();
        commit({ rerender: true });
      });
    });

  new Setting(conditionContainer)
    .setName("Match value")
    .setDesc(
      condition.type === "url-pattern"
        ? "Use plain text or `*` wildcards depending on the mode below."
        : "Enter the word or phrase that should trigger this condition.",
    )
    .setClass("rss-auto-tag-card-setting")
    .setDisabled(conditionDisabled)
    .addText((text) => {
      text.setValue(condition.value);
      text.inputEl.spellcheck = false;
      text.inputEl.addClass("rss-auto-tag-text-input");
      text.setPlaceholder(
        condition.type === "url-pattern"
          ? "youtube.com/shorts/*"
          : "keyword or phrase",
      );
      text.onChange((value) => {
        condition.value = value;
        updateConditionHeader();
        renderConditionValidation();
        commit();
      });
    });

  if (condition.type === "url-pattern") {
    new Setting(conditionContainer)
      .setName("URL match mode")
      .setDesc("Contains looks for partial matches. Wildcard treats `*` as any characters.")
      .setClass("rss-auto-tag-card-setting")
      .setDisabled(conditionDisabled)
      .addDropdown((dropdown) => {
        dropdown.selectEl.addClass("rss-auto-tag-select");
        dropdown.addOption("contains", "Contains");
        dropdown.addOption("wildcard", "Wildcard (*)");
        dropdown.setValue(condition.urlPatternMode || "contains");
        dropdown.onChange((value) => {
          condition.urlPatternMode =
            value as NonNullable<AutoTagCondition["urlPatternMode"]>;
          commit();
        });
      });
  } else {
    new Setting(conditionContainer)
      .setName("Case sensitive")
      .setDesc("Match uppercase and lowercase exactly.")
      .setClass("rss-auto-tag-card-setting")
      .setDisabled(conditionDisabled)
      .addToggle((toggle) =>
        toggle.setValue(condition.caseSensitive).onChange((value) => {
          condition.caseSensitive = value;
          commit();
        }),
      );
  }

  renderTargetsGroup(
    conditionContainer,
    condition,
    conditionDisabled,
    commit,
  );

  const validationList = conditionContainer.createDiv({
    cls: "rss-auto-tag-validation-list",
  });

  const renderConditionValidation = (): void => {
    validationList.empty();
    let isInvalid = false;

    if (!hasValidRuleTag(rule, settings)) {
      validationList.createDiv({
        cls: "rss-auto-tag-validation-note",
        text: "This condition needs a valid target tag on the parent rule.",
      });
      isInvalid = true;
    }

    if (!condition.value.trim()) {
      validationList.createDiv({
        cls: "rss-auto-tag-validation-note",
        text: "Enter a match value for this condition.",
      });
      isInvalid = true;
    }

    if (!hasConditionTargets(condition)) {
      validationList.createDiv({
        cls: "rss-auto-tag-validation-note",
        text: "Select at least one target to search.",
      });
      isInvalid = true;
    }

    conditionContainer.toggleClass("is-invalid", isInvalid);
  };

  renderConditionValidation();
}

function renderTargetsGroup(
  containerEl: HTMLElement,
  condition: AutoTagCondition,
  disabled: boolean,
  commit: (options?: CommitOptions) => void,
): void {
  const groupContainer = containerEl.createDiv({
    cls: "rss-auto-tag-targets-group",
  });

  new Setting(groupContainer)
    .setName(condition.type === "url-pattern" ? "Match against" : "Search in")
    .setDesc(
      condition.type === "url-pattern"
        ? "Choose which URLs this condition should check."
        : "Choose which article fields this condition should search.",
    )
    .setHeading()
    .setClass("rss-auto-tag-targets-heading");

  if (condition.type === "url-pattern") {
    URL_TARGET_OPTIONS.forEach((option) => {
      new Setting(groupContainer)
        .setName(option.label)
        .setDesc(option.description)
        .setClass("rss-auto-tag-target-row")
        .setDisabled(disabled)
        .addToggle((toggle) =>
          toggle
            .setValue(condition.urlTargets.includes(option.key))
            .onChange((value) => {
              condition.urlTargets = updateTargetList(
                condition.urlTargets,
                option.key,
                value,
              );
              commit({ rerender: true });
            }),
        );
    });
    return;
  }

  TEXT_TARGET_OPTIONS.forEach((option) => {
    new Setting(groupContainer)
      .setName(option.label)
      .setDesc(option.description)
      .setClass("rss-auto-tag-target-row")
      .setDisabled(disabled)
      .addToggle((toggle) =>
        toggle
          .setValue(condition.textTargets.includes(option.key))
          .onChange((value) => {
            condition.textTargets = updateTargetList(
              condition.textTargets,
              option.key,
              value,
            );
            commit({ rerender: true });
          }),
      );
  });
}

function hasValidRuleTag(
  rule: AutoTagRule,
  settings: RssDashboardSettings,
): boolean {
  return (
    !!rule.tagName &&
    settings.availableTags.some((tag) => tag.name === rule.tagName)
  );
}

function hasConditionTargets(condition: AutoTagCondition): boolean {
  return condition.type === "url-pattern"
    ? condition.urlTargets.length > 0
    : condition.textTargets.length > 0;
}

function getConditionDescription(condition: AutoTagCondition): string {
  const prefix =
    condition.type === "url-pattern"
      ? "URL pattern"
      : condition.type === "keyword"
        ? "Keyword"
        : "Phrase";
  const value = condition.value.trim();
  return value ? `${prefix}: ${value}` : `${prefix}: not configured`;
}

function updateTargetList<T extends string>(
  values: T[],
  target: T,
  checked: boolean,
): T[] {
  if (checked) {
    return values.includes(target) ? values : [...values, target];
  }

  const nextValues = values.filter((value) => value !== target);
  if (nextValues.length === 0) {
    new Notice("At least one target is required.");
    return values;
  }

  return nextValues;
}
