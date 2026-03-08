import { Notice, Setting } from "obsidian";
import { FeedItem, RssDashboardSettings, Tag } from "../types/types";
import { AutoTagService } from "../services/auto-tag-service";

interface ShowEditTagModalOptions {
  settings: RssDashboardSettings;
  tag: Tag;
  title?: string;
  submitLabel?: string;
  onSave?: (updates: { name: string; color: string }) => void | Promise<void>;
}

export function findTagByName(
  settings: RssDashboardSettings,
  tagName: string,
): Tag | undefined {
  const normalizedName = tagName.trim().toLowerCase();
  return settings.availableTags.find(
    (tag) => tag.name.trim().toLowerCase() === normalizedName,
  );
}

export function ensureTagExists(
  settings: RssDashboardSettings,
  tag: Tag,
): { tag: Tag; created: boolean } {
  const existingTag = findTagByName(settings, tag.name);
  if (existingTag) {
    return { tag: existingTag, created: false };
  }

  const createdTag: Tag = {
    name: tag.name.trim(),
    color: tag.color,
  };
  settings.availableTags.push(createdTag);
  return { tag: createdTag, created: true };
}

export function toggleTagOnArticle(
  item: FeedItem,
  tag: Tag,
  shouldAdd: boolean,
): boolean {
  const normalizedName = tag.name.trim().toLowerCase();
  const currentTags = item.tags ?? [];
  const hasTag = currentTags.some(
    (existingTag) => existingTag.name.trim().toLowerCase() === normalizedName,
  );

  if (shouldAdd) {
    if (hasTag) {
      return false;
    }
    item.tags = [...currentTags, { ...tag }];
    return true;
  }

  if (!hasTag) {
    return false;
  }

  item.tags = currentTags.filter(
    (existingTag) => existingTag.name.trim().toLowerCase() !== normalizedName,
  );
  return true;
}

export function updateTagInSettings(
  settings: RssDashboardSettings,
  tag: Tag,
  updates: { name: string; color: string },
): FeedItem[] {
  const previousName = tag.name;
  const previousNameLower = previousName.toLowerCase();
  const affectedItems: FeedItem[] = [];

  tag.name = updates.name;
  tag.color = updates.color;
  if (previousName !== updates.name) {
    AutoTagService.renameTagReferences(settings, previousName, updates.name);
  }

  settings.feeds.forEach((feed) => {
    feed.items.forEach((item) => {
      if (!item.tags) {
        return;
      }

      let changed = false;
      item.tags.forEach((itemTag) => {
        if (itemTag.name.toLowerCase() === previousNameLower) {
          itemTag.name = updates.name;
          itemTag.color = updates.color;
          changed = true;
        }
      });

      if (changed) {
        affectedItems.push(item);
      }
    });
  });

  return affectedItems;
}

export function updateTagColorInSettings(
  settings: RssDashboardSettings,
  tagName: string,
  color: string,
): FeedItem[] {
  const tag = findTagByName(settings, tagName);
  if (!tag) {
    return [];
  }

  return updateTagInSettings(settings, tag, {
    name: tag.name,
    color,
  });
}

export function deleteTagFromSettings(
  settings: RssDashboardSettings,
  tag: Tag,
): FeedItem[] {
  const affectedItems: FeedItem[] = [];
  const deletedTagLower = tag.name.toLowerCase();
  const tagIndex = settings.availableTags.findIndex(
    (candidateTag) => candidateTag.name.toLowerCase() === deletedTagLower,
  );
  if (tagIndex !== -1) {
    settings.availableTags.splice(tagIndex, 1);
  }

  settings.feeds.forEach((feed) => {
    feed.items.forEach((item) => {
      if (!item.tags?.length) {
        return;
      }
      if (
        item.tags.some(
          (itemTag) => itemTag.name.toLowerCase() === deletedTagLower,
        )
      ) {
        affectedItems.push(item);
      }
    });
  });

  AutoTagService.removeTagReferences(settings, tag.name);
  return affectedItems;
}

export function showEditTagModal({
  settings,
  tag,
  title = "Edit tag",
  submitLabel = "Save changes",
  onSave,
}: ShowEditTagModalOptions): void {
  const modal = document.body.createDiv({
    cls: "rss-dashboard-modal rss-dashboard-modal-container rss-dashboard-tag-edit-modal",
  });

  const modalContent = modal.createDiv({
    cls: "rss-dashboard-modal-content",
  });

  new Setting(modalContent).setName(title).setHeading();

  const formContainer = modalContent.createDiv({
    cls: "rss-dashboard-tag-modal-form",
  });

  const colorInput = formContainer.createEl("input", {
    attr: {
      type: "color",
      value: tag.color,
    },
    cls: "rss-dashboard-tag-modal-color-picker",
  });

  const nameInput = formContainer.createEl("input", {
    attr: {
      type: "text",
      value: tag.name,
      placeholder: "Enter tag name",
      autocomplete: "off",
    },
    cls: "rss-dashboard-tag-modal-name-input",
  });
  nameInput.spellcheck = false;

  const buttonContainer = modalContent.createDiv({
    cls: "rss-dashboard-modal-buttons",
  });

  const closeModal = () => {
    if (modal.parentElement) {
      document.body.removeChild(modal);
    }
  };

  const cancelButton = buttonContainer.createEl("button", {
    text: "Cancel",
  });
  cancelButton.addEventListener("click", closeModal);

  const saveButton = buttonContainer.createEl("button", {
    text: submitLabel,
    cls: "rss-dashboard-primary-button",
  });
  saveButton.addEventListener("click", () => {
    void (async () => {
      const newTagName = nameInput.value.trim();
      const newTagColor = colorInput.value;

      if (!newTagName) {
        new Notice("Please enter a tag name!");
        return;
      }

      if (
        settings.availableTags.some(
          (existingTag) =>
            existingTag !== tag &&
            existingTag.name.toLowerCase() === newTagName.toLowerCase(),
        )
      ) {
        new Notice("A tag with this name already exists!");
        return;
      }

      await onSave?.({
        name: newTagName,
        color: newTagColor,
      });
      closeModal();

      new Notice(`Tag "${newTagName}" updated successfully!`);
    })();
  });

  buttonContainer.appendChild(saveButton);
  formContainer.appendChild(buttonContainer);

  modal.appendChild(modalContent);
  document.body.appendChild(modal);

  requestAnimationFrame(() => {
    nameInput.focus();
    nameInput.select();
  });
}
