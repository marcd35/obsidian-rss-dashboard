import type { Folder } from "../types/types";

export function collectFolderPaths(folders: Folder[], base = ""): string[] {
  const paths: string[] = [];

  for (const folder of folders) {
    const path = base ? `${base}/${folder.name}` : folder.name;
    paths.push(path);

    if (folder.subfolders?.length) {
      paths.push(...collectFolderPaths(folder.subfolders, path));
    }
  }

  return paths;
}
