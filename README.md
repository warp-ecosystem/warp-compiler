# Warp Compiler (`warp-compiler`)

> [!WARNING]
> **Support for Node.js v18** Support for Node.js 18 may end soon. Warp Compiler may still work with Node.js v18, but releases may no longer test for compatability with Node.js v18.

## Overview

Warp Compiler is a Node tool to compile multiple JavaScript files into a single, highly readable TurboWarp extension. It is designed with larger extensions in mind.

## Features

- **Compile many files into one** — Bundles `src/00-index.js` and anything it
  imports into a single, readable TurboWarp extension file.
- **Keeps only what you need** — Retains every exported function and any
  function referenced by a block's `opcode`/`function`, while dropping
  unreachable code so the output stays small and clean.
- **Inline assets** — Auto-embeds referenced files from `assets/` as base64
  data URIs, preserving nested folder paths. Unreferenced assets are left out,
  and dynamic asset lookups are rejected so tree-shaking stays reliable.
- **Runtime metadata** — Emits a statically parseable
  `<runtimeGlobal> = { meta, assets }` object (no comment header), so the
  manifest stays in sync with the extension at runtime.
- **Consistency checks** — Warns (without failing) when source or
  `package.json` values drift from the manifest.
- **Beautiful output** — The result is formatted with Prettier for readability.
- **Minimal dependencies** — Only four runtime packages, the ones
  `src/build.js` actually imports (`rollup`, `acorn`, `prettier`, and
  `picocolors`); nothing heavier is pulled in.

## Installation

To install Warp Compiler with `npm`, run:

```bash
npm install --save-dev @warp-ecosystem/warp-compiler
# Ensure it installed properly
npx warp-compiler -v
```

### Installing locally

You can also install Warp Compiler locally with `git` and `npm`:

```bash
git clone https://github.com/warp-ecosystem/warp-compiler.git
cd warp-compiler
npm install
```

## Usage

1. To initialize your project:

   ```bash
   npx warp-compiler init
   ```

2. To compile your extension:

   ```bash
   npx warp-compiler build
   ```

## Contributing

Contributions are welcome! Please read the
[CONTRIBUTING.md](docs/CONTRIBUTING.md) for details on the process for
submitting pull requests, and our [Code of Conduct](CODE_OF_CONDUCT.md) for
community guidelines.

## License

Warp Compiler is proud to be Free Software. It is licensed under the [Apache 2.0 license](LICENSE).
