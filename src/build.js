import fs from "node:fs";
import path from "node:path";
import * as rollup from "rollup";
import { parse } from "acorn";
import prettier from "prettier";

import { success, warn, error } from "./logger.js";

const MANIFEST = "99-manifest.json";
const ENTRY = "00-index.js";
const SRC_DIR = "src";
const ASSETS_DIR = "assets";
const DIST_DIR = "dist";

export async function runBuild(product) {
  const { bin, runtimeGlobal } = product;

  const srcDir = path.resolve(process.cwd(), SRC_DIR);
  const manifestPath = path.join(srcDir, MANIFEST);
  const entryPath = path.join(srcDir, ENTRY);

  if (!fs.existsSync(manifestPath)) {
    error(`No project, run '${bin} init' first`);
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    error(`Failed to parse ${path.join(SRC_DIR, MANIFEST)}: ${e.message}`);
    return 1;
  }

  const className = manifest.class;
  if (!className || typeof className !== "string") {
    error(`Manifest is missing a "class" field with the extension class name.`);
    return 1;
  }

  for (const field of ["id", "version"]) {
    const value = manifest[field];
    if (typeof value !== "string" || value.length === 0) {
      error(
        `Manifest is missing a "${field}" field with a non-empty string value.`,
      );
      return 1;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
      error(
        `Manifest "${field}" (${JSON.stringify(value)}) must use only letters, digits, dots, dashes, and underscores, with no path separators or traversal sequences.`,
      );
      return 1;
    }
  }

  if (!fs.existsSync(entryPath)) {
    error(`Missing entry file ${path.join(SRC_DIR, ENTRY)}.`);
    return 1;
  }

  const assets = loadAssets();

  const bundleCode = await bundleEntry(entryPath);
  if (bundleCode instanceof Error) {
    error(bundleCode.message);
    return 1;
  }

  let ast;
  try {
    ast = parse(bundleCode, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    error(`Failed to parse the bundled output: ${e.message}`);
    return 1;
  }

  const retained = retainFunctions(ast, manifest, bundleCode);
  if (retained instanceof Error) {
    error(retained.message);
    return 1;
  }

  const referencedAssets = collectReferencedAssets(ast, runtimeGlobal, assets);
  if (referencedAssets instanceof Error) {
    error(referencedAssets.message);
    return 1;
  }

  const built = await assembleOutput({
    runtimeGlobal,
    className,
    manifest,
    retained,
    assets: referencedAssets,
  });

  const outputPath = path.join(
    process.cwd(),
    DIST_DIR,
    `${manifest.id}@${manifest.version}.js`,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, built);

  runConsistencyChecks(manifest, ast);

  success(`Built ${path.relative(process.cwd(), outputPath)}`);
  return 0;
}

function loadAssets() {
  const assetsDir = path.resolve(process.cwd(), ASSETS_DIR);
  if (!fs.existsSync(assetsDir)) {
    return new Map();
  }

  const map = new Map();
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const data = fs.readFileSync(full);
        const type = mimeType(full);
        const base64 = data.toString("base64");
        map.set(rel, `data:${type};base64,${base64}`);
      }
    }
  };
  walk(assetsDir);
  return map;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".txt": "text/plain",
    ".css": "text/css",
    ".js": "text/javascript",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  return table[ext] || "application/octet-stream";
}

async function bundleEntry(entryPath) {
  let bundle;
  try {
    bundle = await rollup.rollup({
      input: entryPath,
      treeshake: false,
      onwarn() {},
    });
    const { output } = await bundle.generate({ format: "es" });
    return output[0].code;
  } catch (e) {
    return new Error(
      `Failed to bundle ${path.join(SRC_DIR, ENTRY)}: ${e.message}`,
    );
  } finally {
    if (bundle) await bundle.close();
  }
}

function retainFunctions(ast, manifest, source) {
  const exportNames = new Set();
  const topLevelFunctions = new Map();
  const topLevelDecls = new Map();

  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration" && node.specifiers) {
      for (const spec of node.specifiers) {
        exportNames.add(spec.local.name);
      }
    }
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      if (node.declaration.type === "FunctionDeclaration") {
        exportNames.add(node.declaration.id.name);
        topLevelFunctions.set(node.declaration.id.name, node.declaration);
      }
    }
    if (node.type === "FunctionDeclaration") {
      if (node.id) topLevelFunctions.set(node.id.name, node);
    }
    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) {
        if (decl.id.type === "Identifier") {
          topLevelDecls.set(decl.id.name, node);
        }
      }
    }
  }

  const blockNames = new Set();

  const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
  for (const block of blocks) {
    if (typeof block === "object" && block !== null) {
      if (typeof block.opcode === "string") blockNames.add(block.opcode);
      if (typeof block.function === "string") blockNames.add(block.function);
    }
  }

  const visitBlockKeys = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Property") {
      const keyName =
        n.key.type === "Identifier"
          ? n.key.name
          : n.key.type === "Literal"
            ? String(n.key.value)
            : null;
      if (
        (keyName === "opcode" || keyName === "function") &&
        n.value.type === "Literal" &&
        typeof n.value.value === "string"
      ) {
        blockNames.add(n.value.value);
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visitBlockKeys(c);
      } else if (child && typeof child.type === "string") {
        visitBlockKeys(child);
      }
    }
  };
  for (const node of ast.body) visitBlockKeys(node);

  const entryRoots = [...exportNames].filter((n) => topLevelFunctions.has(n));
  const blockRoots = [...blockNames].filter(
    (n) => topLevelFunctions.has(n) && !exportNames.has(n),
  );

  const referenced = (fnNode) => {
    const names = new Set();
    const visit = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "Identifier") names.add(n.name);
      for (const key of Object.keys(n)) {
        if (key === "parent") continue;
        const child = n[key];
        if (Array.isArray(child)) {
          for (const c of child) visit(c);
        } else if (child && typeof child.type === "string") {
          visit(child);
        }
      }
    };
    visit(fnNode);
    return names;
  };

  const allTopLevel = new Map([...topLevelFunctions, ...topLevelDecls]);
  const refMap = new Map();
  for (const [name, node] of allTopLevel) {
    const refs = new Set();
    for (const used of referenced(node)) {
      if (allTopLevel.has(used)) refs.add(used);
    }
    refMap.set(name, refs);
  }

  const roots = [...entryRoots, ...blockRoots];
  const retainedSet = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of refMap.get(cur) || []) {
      if (!retainedSet.has(next)) {
        retainedSet.add(next);
        queue.push(next);
      }
    }
  }

  const ordered = [];
  for (const name of entryRoots) {
    if (retainedSet.has(name)) ordered.push(name);
  }
  for (const name of blockRoots) {
    if (retainedSet.has(name) && !ordered.includes(name)) ordered.push(name);
  }
  for (const name of allTopLevel.keys()) {
    if (retainedSet.has(name) && !ordered.includes(name)) ordered.push(name);
  }

  const methods = ordered
    .filter((name) => topLevelFunctions.has(name))
    .map((name) => ({ name, node: topLevelFunctions.get(name) }));

  const statements = ordered
    .filter((name) => topLevelDecls.has(name) && !topLevelFunctions.has(name))
    .map((name) => topLevelDecls.get(name));

  return { methods, statements, source };
}

function slice(src, node) {
  return src.slice(node.start, node.end);
}

function fmtFunctionMethod(node, src) {
  let text = slice(src, node).trim();
  text = text.replace(
    /^(async\s+)?function(\s*\*)?\s*/,
    (_, asyncKw, starKw) => {
      const asyncPrefix = asyncKw ? "async " : "";
      return starKw ? `${asyncPrefix}* ` : asyncPrefix;
    },
  );
  return text;
}

function collectReferencedAssets(ast, runtimeGlobal, assets) {
  const referenced = new Set();
  let detectedError = null;

  const record = (e) => {
    if (detectedError === null) detectedError = e;
  };

  const visit = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (detectedError !== null) return;
    if (n.type === "MemberExpression") {
      let current = n;
      while (current.object && current.object.type === "MemberExpression") {
        current = current.object;
      }
      const obj = current.object;
      if (
        obj &&
        obj.type === "Identifier" &&
        obj.name === runtimeGlobal &&
        current.property &&
        current.property.type === "Identifier" &&
        current.property.name === "assets"
      ) {
        const keyNode = n.property;
        if (n.computed) {
          if (keyNode.type !== "Literal" || typeof keyNode.value !== "string") {
            record(
              new Error(
                `Asset keys must be static string literals (e.g. ${runtimeGlobal}.assets["icon.svg"]) so assets can be tree-shaken.`,
              ),
            );
            return;
          }
          referenced.add(keyNode.value);
        } else if (keyNode.type === "Identifier" && n !== current) {
          referenced.add(keyNode.name);
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === "string") visit(c);
        }
      } else if (child && typeof child.type === "string") {
        visit(child);
      }
    }
  };
  for (const node of ast.body) visit(node);

  if (detectedError !== null) return detectedError;

  const result = new Map();
  for (const key of referenced) {
    if (!assets.has(key)) {
      return new Error(
        `Asset "${key}" is referenced by the source but does not exist in the ${ASSETS_DIR}/ directory.`,
      );
    }
    result.set(key, assets.get(key));
  }
  return result;
}

async function assembleOutput({
  runtimeGlobal,
  className,
  manifest,
  retained,
  assets,
}) {
  const metaLiteral = JSON.stringify(manifest, null, 2);
  const assetEntries = [...assets.entries()]
    .map(([key, uri]) => `    ${JSON.stringify(key)}: ${JSON.stringify(uri)}`)
    .join(",\n");
  const assetsLiteral = assetEntries ? `{\n${assetEntries},\n  }` : "{}";

  const methodLines = retained.methods.map((m) => {
    let body = fmtFunctionMethod(m.node, retained.source);
    return `    ${body}`;
  });

  const statementLines = retained.statements.map(
    (s) => `    ${slice(retained.source, s).trim().replace(/\n/g, "\n    ")}`,
  );

  const parts = [];
  parts.push(`(function (Scratch) {`);
  parts.push(`  "use strict";`);
  parts.push(``);
  parts.push(`  const ${runtimeGlobal} = {`);
  parts.push(`    meta: ${metaLiteral},`);
  parts.push(`    assets: ${assetsLiteral}`);
  parts.push(`  };`);
  if (statementLines.length) {
    parts.push(``);
    parts.push(...statementLines);
  }
  parts.push(``);
  parts.push(`  class ${className} {`);
  parts.push(methodLines.join("\n\n"));
  parts.push(`  }`);
  parts.push(``);
  parts.push(`  Scratch.extensions.register(new ${className}());`);
  parts.push(`})(Scratch);`);

  const code = parts.join("\n");
  return prettier.format(code, {
    parser: "babel",
    singleQuote: false,
    trailingComma: "all",
    objectWrap: "collapse",
  });
}

function runConsistencyChecks(manifest, ast) {
  const stringLiterals = [];
  const visit = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Property") {
      const keyName =
        n.key.type === "Identifier"
          ? n.key.name
          : n.key.type === "Literal"
            ? String(n.key.value)
            : null;
      if (
        (keyName === "id" || keyName === "name") &&
        n.value.type === "Literal" &&
        typeof n.value.value === "string"
      ) {
        stringLiterals.push({ keyName, value: n.value.value });
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else if (child && typeof child.type === "string") {
        visit(child);
      }
    }
  };
  for (const node of ast.body) visit(node);

  for (const { keyName, value } of stringLiterals) {
    const expected = manifest[keyName];
    if (expected !== undefined && String(expected) !== String(value)) {
      warn(
        `Hardcoded ${keyName} "${value}" in the source does not match the manifest ${keyName} "${expected}". Consider using ${keyName === "id" ? "Warp.meta.id" : "Warp.meta.name"}.`,
      );
    }
  }

  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }

  const fields = ["version", "license", "description"];
  for (const field of fields) {
    const pkgValue = pkg[field];
    const manifestValue = manifest[field];
    if (
      pkgValue !== undefined &&
      manifestValue !== undefined &&
      String(pkgValue) !== String(manifestValue)
    ) {
      warn(
        `package.json ${field} ("${pkgValue}") does not match the manifest ${field} ("${manifestValue}")`,
      );
    }
  }
}
