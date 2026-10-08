import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Builds a flat staging folder for the GitHub Wiki from a source folder of
// Markdown pages (#922). The wiki serves pages flat by base name, so this
// script strips front matter, flattens pages, and rewrites links itself
// instead of relying on the publish Action's preprocessing.

const REPO_URL = "https://github.com/amatya-aditya/obsidian-rss-dashboard";
const BRANCH = "master";
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
]);
const SPECIAL_PAGES = new Set(["_Sidebar", "_Footer"]);
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]+?)(\s+["'][^"']*["'])?\s*\)/g;
const REFERENCE_DEFINITION = /^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/gm;

/** Removes a leading YAML front matter block, if any. */
export function stripFrontMatter(markdown) {
  const text = String(markdown).replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^\s*\n/, "") : text;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files.sort();
}

function toPosix(path) {
  return path.split(String.fromCharCode(92)).join("/");
}

function encodePath(path) {
  return toPosix(path).split("/").map(encodeURIComponent).join("/");
}

/** Mask fenced blocks and inline code so link syntax in examples is kept. */
function maskCode(markdown) {
  const saved = [];
  const masked = markdown.replace(
    /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g,
    (chunk) => {
      saved.push(chunk);
      return `@@CODE${saved.length - 1}@@`;
    },
  );
  return { masked, saved };
}

function unmaskCode(masked, saved) {
  return masked.replace(/@@CODE([0-9]+)@@/g, (_m, i) => saved[Number(i)]);
}

/**
 * Builds the wiki staging folder. Throws on duplicate page or image base
 * names, and on links that point at nothing.
 * Returns the list of page names written.
 */
export function buildWiki({ sourceDir, outDir, repoRoot }) {
  const root = resolve(repoRoot);
  const source = resolve(sourceDir);
  const out = resolve(outDir);
  const files = walk(source);

  const pages = new Map(); // absolute source path -> page name
  const images = new Map(); // absolute source path -> image file name
  const pageNames = new Map();
  const imageNames = new Map();

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const name = basename(file);
    if (ext === ".md") {
      const pageName = basename(file, extname(file));
      if (pageNames.has(pageName)) {
        throw new Error(
          `Duplicate page name "${pageName}": ${relative(root, pageNames.get(pageName))} and ${relative(root, file)}`,
        );
      }
      pageNames.set(pageName, file);
      pages.set(file, pageName);
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      if (imageNames.has(name)) {
        throw new Error(
          `Duplicate image name "${name}": ${relative(root, imageNames.get(name))} and ${relative(root, file)}`,
        );
      }
      imageNames.set(name, file);
      images.set(file, name);
    }
  }

  function rewriteTarget(target, fromFile, isImage) {
    if (target.startsWith("#") || SCHEME_PATTERN.test(target)) {
      return target;
    }
    const [pathPart, ...anchorParts] = target.split("#");
    const anchor = anchorParts.length ? `#${anchorParts.join("#")}` : "";
    if (!pathPart) {
      return target;
    }
    const resolved = resolve(dirname(fromFile), decodeURI(pathPart));
    if (pages.has(resolved)) {
      return `${pages.get(resolved)}${anchor}`;
    }
    if (images.has(resolved)) {
      return `images/${encodeURIComponent(images.get(resolved))}${anchor}`;
    }
    const repoPath = toPosix(relative(root, resolved));
    const insideSource = !relative(source, resolved).startsWith("..");
    if (repoPath.startsWith("..") || insideSource) {
      throw new Error(
        `Broken link "${target}" in ${relative(root, fromFile)}: no such page or image in the source folder`,
      );
    }
    if (!existsSync(resolved)) {
      throw new Error(
        `Broken link "${target}" in ${relative(root, fromFile)}: ${repoPath} does not exist`,
      );
    }
    const kind = isImage ? "raw" : "blob";
    return `${REPO_URL}/${kind}/${BRANCH}/${encodePath(repoPath)}${anchor}`;
  }

  function rewriteLinks(markdown, fromFile) {
    const { masked, saved } = maskCode(markdown);
    const inline = masked.replace(
      INLINE_LINK,
      (_m, bang, text, target, title = "") =>
        `${bang}[${text}](${rewriteTarget(target, fromFile, bang === "!")}${title})`,
    );
    const rewritten = inline.replace(
      REFERENCE_DEFINITION,
      (_m, head, target) => `${head}${rewriteTarget(target, fromFile, false)}`,
    );
    return unmaskCode(rewritten, saved);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const [file, pageName] of pages) {
    let content = rewriteLinks(
      stripFrontMatter(readFileSync(file, "utf8")),
      file,
    );
    if (!SPECIAL_PAGES.has(pageName)) {
      const editPath = encodePath(toPosix(relative(root, file)));
      content = `${content.replace(/\s+$/, "")}\n\n[Edit this page](${REPO_URL}/edit/${BRANCH}/${editPath})\n`;
    }
    writeFileSync(join(out, `${pageName}.md`), content);
  }

  if (images.size) {
    mkdirSync(join(out, "images"), { recursive: true });
    for (const [file, name] of images) {
      copyFileSync(file, join(out, "images", name));
    }
  }

  return [...pages.values()];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [sourceDir, outDir = ".wiki-build"] = process.argv.slice(2);
  if (!sourceDir) {
    console.error("Usage: node scripts/build-wiki.mjs <source-folder> [out]");
    process.exit(2);
  }
  try {
    const written = buildWiki({
      sourceDir,
      outDir,
      repoRoot: process.cwd(),
    });
    console.log(`Built ${written.length} wiki page(s) into ${outDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
