import { Notice, Setting } from "obsidian";
import { RssDashboardSettings, Tag } from "../types/types";
import { AutoTagService } from "../services/auto-tag-service";

interface ShowEditTagModalOptions {
  settings: RssDashboardSettings;
  tag: Tag;
  title?: string;
  submitLabel?: string;
  onSave?: () => void | Promise<void>;
}

export function updateTagInSettings(
  settings: RssDashboardSettings,
  tag: Tag,
  updates: { name: string; color: string },
): void {
  const previousName = tag.name;

  tag.name = updates.name;
  tag.color = updates.color;
  AutoTagService.renameTagReferences(settings, previousName, updates.name);

  settings.feeds.forEach((feed) => {
    feed.items.forEach((item) => {
      if (!item.tags) {
        return;
      }

      item.tags.forEach((itemTag) => {
        if (itemTag.name === previousName) {
          itemTag.name = updates.name;
          itemTag.color = updates.color;
        }
      });
    });
  });
}

export function deleteTagFromSettings(
  settings: RssDashboardSettings,
  tag: Tag,
): void {
  const tagIndex = settings.availableTags.findIndex((t) => t.name === tag.name);
  if (tagIndex !== -1) {
    settings.availableTags.splice(tagIndex, 1);
  }

  AutoTagService.removeTagReferences(settings, tag.name);
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

      updateTagInSettings(settings, tag, {
        name: newTagName,
        color: newTagColor,
      });

      await onSave?.();
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
