import { App, Modal, Notice, Setting } from "obsidian";

export class EditAiSummaryModal extends Modal {
  private promptTextAreaEl: HTMLTextAreaElement | null = null;
  private isSubmitting = false;

  constructor(
    app: App,
    private initialPrompt: string,
    private onRerun: (promptTemplate: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Edit AI summary prompt" });
    contentEl.createEl("p", {
      text: "Adjust the prompt used for this summary rerun. This does not update settings.",
    });

    const promptContainer = contentEl.createDiv({
      cls: "rss-dashboard-ai-edit-prompt-container",
    });
    const promptTextAreaEl = promptContainer.createEl("textarea", {
      cls: "rss-dashboard-ai-prompt-template rss-dashboard-ai-edit-prompt-input",
    });
    promptTextAreaEl.rows = 10;
    promptTextAreaEl.value = this.initialPrompt;
    this.promptTextAreaEl = promptTextAreaEl;

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Rerun summary")
          .setCta()
          .onClick(() => {
            void this.handleRerun(button.buttonEl);
          }),
      );

    window.setTimeout(() => {
      const promptEl = this.promptTextAreaEl;
      if (!promptEl) {
        return;
      }
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    }, 30);
  }

  private async handleRerun(buttonEl: HTMLButtonElement): Promise<void> {
    if (this.isSubmitting) {
      return;
    }

    const promptTemplate = this.promptTextAreaEl?.value ?? "";
    if (!promptTemplate.trim()) {
      new Notice("Prompt template cannot be empty.");
      return;
    }

    this.isSubmitting = true;
    buttonEl.disabled = true;

    try {
      await this.onRerun(promptTemplate);
      this.close();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to rerun summary.";
      new Notice(message);
    } finally {
      this.isSubmitting = false;
      buttonEl.disabled = false;
    }
  }
}
