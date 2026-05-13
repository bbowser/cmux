import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  flatNavItems,
  navItems,
} from "../app/[locale]/components/docs-nav-items";
import { changelogMedia } from "../app/[locale]/docs/changelog/changelog-media";
import { routing } from "../i18n/routing";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(projectRoot, "..");
const siteDir = path.join(projectRoot, ".pagefind-site");
const outputDir = path.join(projectRoot, "public", "pagefind");
const rawMessagesCache = new Map();
const mergedMessagesCache = new Map();

const searchAliases = {
  apiReference: [
    "socket API",
    "JSON RPC",
    "automation API",
    "workspace.list",
    "surface.send_text",
  ],
  browserAutomation: [
    "browser CLI",
    "webview automation",
    "snapshot",
    "click",
    "fill",
    "console logs",
  ],
  claudeCodeTeams: ["Claude teams", "teammate mode", "tmux shim"],
  configuration: ["settings.json", "cmux.json", "Ghostty config"],
  customCommands: ["command palette", "project commands", "cmux.json"],
  dock: ["dock", "agent dock", "workspace dock"],
  notifications: ["OSC 777", "OSC 99", "hooks", "notification rings"],
  ohMyClaudeCode: ["omc", "oh my claude", "oh-my-claudecode"],
  ohMyCodex: ["omx", "oh my codex", "oh-my-codex"],
  ohMyOpenCode: ["omo", "oh-my-opencode", "oh-my-openagent"],
  ssh: ["remote sessions", "SSH relay", "scp uploads"],
};

export function docsSearchRoutes() {
  const links = flatNavItems(navItems);
  return routing.locales.flatMap((locale) =>
    links.map((navItem) => ({
      locale,
      navItem,
      href: navItem.href,
      path: localizedDocsPath(locale, navItem.href),
    })),
  );
}

export function localizedDocsPath(locale, href) {
  return locale === routing.defaultLocale ? href : `/${locale}${href}`;
}

async function main() {
  const startedAt = Date.now();
  await rm(siteDir, { force: true, recursive: true });
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(siteDir, { recursive: true });

  const pages = await docsSearchPages();

  try {
    await Promise.all(pages.map(writePageHtml));
    await runPagefind();
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      `Docs search index built for ${pages.length} localized pages in ${elapsedSeconds}s`,
    );
  } finally {
    await rm(siteDir, { force: true, recursive: true });
  }
}

async function docsSearchPages() {
  const codeByHref = await docsCodeSnippetsByHref();
  const headingsByHref = await docsHeadingsByHref();
  const changelogText = await changelogSearchText();
  const routes = docsSearchRoutes();
  const pages = [];

  for (const route of routes) {
    const messages = await messagesForLocale(route.locale);
    const docsMessages = getObject(messages, ["docs"]);
    const pageMessages = getObject(docsMessages, [route.navItem.titleKey]);
    const navMessages = getObject(docsMessages, ["navItems"]);
    const navTitle = getString(navMessages, [route.navItem.titleKey]);
    const title = getString(pageMessages, ["title"]) || navTitle;
    const description =
      getString(pageMessages, ["metaDescription"]) ||
      getString(pageMessages, ["intro"]);
    const headings = (headingsByHref.get(route.href) ?? [])
      .map((heading) => ({
        ...heading,
        text: heading.key
          ? getString(pageMessages, [heading.key]) || heading.text
          : heading.text,
      }))
      .filter((heading) => heading.id && heading.text);

    const texts = uniqueText([
      navTitle,
      title,
      description,
      ...headings.map((heading) => heading.text),
      ...collectStrings(pageMessages),
      ...(codeByHref.get(route.href) ?? []),
      ...(searchAliases[route.navItem.titleKey] ?? []),
      ...(route.navItem.titleKey === "changelog" ? changelogText : []),
    ]);

    pages.push({
      ...route,
      title,
      description,
      headings,
      texts,
    });
  }

  return pages;
}

async function messagesForLocale(locale) {
  if (!mergedMessagesCache.has(locale)) {
    mergedMessagesCache.set(
      locale,
      (async () => {
        const defaultMessages = await readMessages(routing.defaultLocale);
        if (locale === routing.defaultLocale) return defaultMessages;
        return deepMerge(defaultMessages, await readMessages(locale));
      })(),
    );
  }
  return mergedMessagesCache.get(locale);
}

async function readMessages(locale) {
  if (!rawMessagesCache.has(locale)) {
    rawMessagesCache.set(
      locale,
      (async () => {
        const filePath = path.join(projectRoot, "messages", `${locale}.json`);
        return JSON.parse(await readFile(filePath, "utf8"));
      })(),
    );
  }
  return rawMessagesCache.get(locale);
}

function deepMerge(base, override) {
  const result = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function collectStrings(value) {
  if (typeof value === "string") {
    return [normalizeSearchText(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

async function docsCodeSnippetsByHref() {
  const snippets = new Map();
  await Promise.all(
    flatNavItems(navItems).map(async (item) => {
      const sourcePath = docsPageSourcePath(item.href);
      try {
        snippets.set(
          item.href,
          extractCodeSnippets(await readFile(sourcePath, "utf8")),
        );
      } catch {
        snippets.set(item.href, []);
      }
    }),
  );
  return snippets;
}

function docsPageSourcePath(href) {
  const docsPath = href.replace(/^\//, "");
  return path.join(projectRoot, "app", "[locale]", docsPath, "page.tsx");
}

function extractCodeSnippets(sourceText) {
  const sourceFile = ts.createSourceFile(
    "page.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const constants = new Map();
  const snippets = [];

  function expressionText(expression) {
    if (ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (ts.isStringLiteral(expression)) {
      return expression.text;
    }
    if (ts.isIdentifier(expression)) {
      return constants.get(expression.text) ?? "";
    }
    if (ts.isTemplateExpression(expression)) {
      return expression
        .getText(sourceFile)
        .slice(1, -1)
        .replace(/\$\{[^}]+\}/g, " ");
    }
    return "";
  }

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const value = expressionText(node.initializer);
      if (value) constants.set(node.name.text, value);
    }

    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "CodeBlock"
    ) {
      for (const child of node.children) {
        if (ts.isJsxExpression(child) && child.expression) {
          const value = expressionText(child.expression);
          if (value) snippets.push(normalizeSearchText(value));
        } else if (ts.isJsxText(child)) {
          const value = normalizeSearchText(child.text);
          if (value) snippets.push(value);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return uniqueText(snippets);
}

async function docsHeadingsByHref() {
  const headings = new Map();
  await Promise.all(
    flatNavItems(navItems).map(async (item) => {
      const sourcePath = docsPageSourcePath(item.href);
      try {
        headings.set(item.href, extractDocsHeadings(await readFile(sourcePath, "utf8")));
      } catch {
        headings.set(item.href, []);
      }
    }),
  );
  return headings;
}

function extractDocsHeadings(sourceText) {
  const sourceFile = ts.createSourceFile(
    "page.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const headings = [];

  function visit(node) {
    if (ts.isJsxElement(node)) {
      const tagName = node.openingElement.tagName.getText(sourceFile);
      if (tagName === "DocsHeading") {
        const id = stringAttributeValue(node.openingElement, "id");
        const level = numberAttributeValue(node.openingElement, "level") ?? 2;
        const text = headingText(node.children);
        if (id && (text.key || text.text)) {
          headings.push({
            id,
            key: text.key,
            level,
            text: normalizeSearchText(text.text),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return headings;
}

function stringAttributeValue(openingElement, name) {
  const attribute = openingElement.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.text === name,
  );
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return "";
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteral(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text;
  }
  return "";
}

function numberAttributeValue(openingElement, name) {
  const attribute = openingElement.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.text === name,
  );
  if (
    !attribute ||
    !ts.isJsxAttribute(attribute) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return undefined;
  }
  const expression = attribute.initializer.expression;
  return ts.isNumericLiteral(expression) ? Number(expression.text) : undefined;
}

function headingText(children) {
  for (const child of children) {
    if (ts.isJsxText(child)) {
      const text = normalizeSearchText(child.text);
      if (text) return { text };
    }
    if (ts.isJsxExpression(child) && child.expression) {
      const key = translationKey(child.expression);
      if (key) return { key };
      const text = expressionLiteralText(child.expression);
      if (text) return { text };
    }
    if (ts.isJsxElement(child)) {
      const nested = headingText(child.children);
      if (nested.key || nested.text) return nested;
    }
  }
  return { text: "" };
}

function translationKey(expression) {
  if (
    ts.isCallExpression(expression) &&
    expression.expression.getText() === "t" &&
    expression.arguments.length > 0 &&
    ts.isStringLiteral(expression.arguments[0])
  ) {
    return expression.arguments[0].text;
  }
  return "";
}

function expressionLiteralText(expression) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return "";
}

async function changelogSearchText() {
  const markdown = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const markdownText = markdown
    .split("\n")
    .map((line) =>
      normalizeSearchText(
        line
          .replace(/^#+\s*/, "")
          .replace(/^-\s*/, "")
          .replace(/!\[[^\]]*]\([^)]+\)/g, "")
          .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
          .replace(/`([^`]+)`/g, "$1"),
      ),
    )
    .filter(Boolean);

  const mediaText = Object.values(changelogMedia).flatMap((version) => [
    version.title,
    ...(version.features ?? []).flatMap((feature) => [
      feature.title,
      feature.description,
    ]),
  ]);

  return uniqueText([...markdownText, ...mediaText]);
}

async function writePageHtml(page) {
  const filePath = path.join(siteDir, page.path.slice(1), "index.html");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, pageHtml(page));
}

function pageHtml(page) {
  const headings = page.headings
    .map((heading) => {
      const level = Math.min(Math.max(heading.level, 2), 3);
      return `<h${level} id="${escapeAttribute(heading.id)}">${escapeHtml(heading.text)}</h${level}>`;
    })
    .join("\n");
  const body = page.texts
    .map((text, index) => {
      const weight = index < 3 ? 4 : 1;
      return `<p data-pagefind-weight="${weight}">${escapeHtml(text)}</p>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(page.locale)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
</head>
<body>
  <main
    data-pagefind-body
    data-pagefind-meta="section:Docs"
    data-pagefind-filter="locale:${escapeHtml(page.locale)}"
  >
    <h1 data-pagefind-meta="title">${escapeHtml(page.title)}</h1>
    ${headings}
    ${body}
  </main>
</body>
</html>`;
}

async function runPagefind() {
  await runCommand(process.execPath, [
    "x",
    "pagefind",
    "--site",
    siteDir,
    "--output-path",
    outputDir,
    "--glob",
    "**/*.html",
  ]);
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function getObject(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return {};
    current = current[key];
  }
  return isRecord(current) ? current : {};
}

function getString(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? normalizeSearchText(current) : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSearchText(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueText(values) {
  const seen = new Set();
  const texts = [];

  for (const value of values) {
    const normalized = normalizeSearchText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    texts.push(normalized);
  }

  return texts;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
