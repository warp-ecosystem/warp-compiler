import fs from "node:fs";
import path from "node:path";

import { success, skipped } from "./logger.js";

export const MANIFEST_FILE = "99-manifest.json";
export const ENTRY_FILE = "00-index.js";
export const ASSET_FILE = "hello-icon.svg";

export const assetTemplate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <circle cx="12" cy="12" r="10" fill="#4C97FF" />
</svg>`;

export const manifestTemplate = {
  class: "HelloWorld",
  name: "It works!",
  id: "helloworld",
  license: "LGPL-2.1",
  authors: [
    { name: "Author 1", url: "https://example.com" },
    { name: "Author 2" },
    { name: "Author 3", url: "https://example.com" },
  ],
  originalAuthors: [
    { name: "Original Author 1", url: "https://example.com" },
    { name: "Original Author 2" },
  ],
  description: "A description of the extension.",
  version: "0.1.0",
};

export const entryTemplate = `import { hello } from "./01-hello-world.js";

export function getInfo() {
  return {
    id: Warp.meta.id,
    name: Warp.meta.name,
    blockIconURI: Warp.assets["hello-icon.svg"],
    blocks: [
      {
        opcode: "hello",
        blockType: Scratch.BlockType.REPORTER,
        text: "Hello!",
      },
    ],
  };
}
`;

export const helloWorldTemplate = `export function hello() {
  return "World!";
}

export function unusedFunction() {
  return "This function is unused and should be removed by the compiler.";
}
`;

/**
 * Initialize a new extension project with scaffolded files.
 * @param {string} srcDir - Source directory path.
 * @returns {boolean} True if initialization was successful.
 */
export function initProject(srcDir) {
  const files = {};

  files[path.join(srcDir, MANIFEST_FILE)] =
    JSON.stringify(manifestTemplate, null, 2) + "\n";
  files[path.join(srcDir, ENTRY_FILE)] = entryTemplate;
  files[path.join(srcDir, "01-hello-world.js")] = helloWorldTemplate;

  fs.mkdirSync(srcDir, { recursive: true });

  const assetsDir = path.join(srcDir, "..", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  files[path.join(assetsDir, ASSET_FILE)] = assetTemplate;

  for (const [filePath, contents] of Object.entries(files)) {
    const display = path.relative(process.cwd(), filePath) || filePath;
    if (fs.existsSync(filePath)) {
      skipped(`Skipped ${display} (already exists)`);
      continue;
    }
    fs.writeFileSync(filePath, contents);
    success(`Created ${display}`);
  }

  return true;
}
