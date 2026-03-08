import type { FeedItem, Tag } from "../types/types";

export interface ImmediateMutationDatabase {
  upsertArticle(article: FeedItem): void;
  saveAllTags(tags: Tag[]): void;
  forceSave(): Promise<void>;
}

export async function persistArticleMutation(
  db: ImmediateMutationDatabase | null | undefined,
  saveSettingsOnly: () => Promise<void>,
  article: FeedItem,
): Promise<void> {
  db?.upsertArticle(article);
  if (db) {
    await db.forceSave();
  }
  await saveSettingsOnly();
}

export async function persistTagMutation(
  db: ImmediateMutationDatabase | null | undefined,
  saveSettingsOnly: () => Promise<void>,
  tags: Tag[],
  affectedArticles: FeedItem[],
): Promise<void> {
  db?.saveAllTags(tags);
  for (const article of affectedArticles) {
    db?.upsertArticle(article);
  }
  if (db) {
    await db.forceSave();
  }
  await saveSettingsOnly();
}
