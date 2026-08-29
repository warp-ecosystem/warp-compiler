# Contributing to Warp Compiler

Thanks for taking the time to contribute! This project aims to be friendly and
welcoming to contributors of all experience levels. Please read our
[Code of Conduct](../CODE_OF_CONDUCT.md) before contributing — by
participating you agree to abide by its terms.

## Table of contents

- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [How things work](#how-things-work)
- [Submitting changes](#submitting-changes)
- [Code style](#code-style)
- [Testing](#testing)
- [Releasing](#releasing)

## Development setup

Warp Compiler requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
# Clone the repository
git clone https://github.com/warp-ecosystem/warp-compiler.git
cd warp-compiler

# Install dependencies
npm install

# Verify the CLI works
npm run build -- --help
```

> `npm run build` runs the compiler against the current directory, which is
> useful for manually checking the CLI. For day-to-day development you can also
> invoke it directly:

```bash
node ./bin/warp-compiler.js --help
node ./bin/warp-compiler.js init
node ./bin/warp-compiler.js build
```

## Project structure

```
.
├── bin/
│   └── warp-compiler.js   # CLI entrypoint (loads .product.json, calls runCli)
├── src/
│   ├── build.js           # Build pipeline (bundling, assets, meta, output)
│   ├── cli.js             # Centralized CLI (--help / --version / init / build)
│   ├── index.js           # Public API re-exports
│   ├── init.js            # `init` command (project scaffolding)
│   ├── logger.js          # picocolors output helpers (✓ - ⚠ ✗)
│   └── product.js         # Reads branding from .product.json
├── .product.json          # Single source of branding/identity strings
└── package.json
```

## How things work

- **Branding** lives in `.product.json`. The product name, CLI script name, and
  the runtime global object name are all read from there — never hard-coded in
  source (except `package.json` `bin`, which npm requires to be a literal).
- **`init`** scaffolds a new extension project in the current directory.
- **`build`** bundles `src/00-index.js` and its imports with
  [Rollup](https://rollupjs.org/) (`treeshake: false`), keeps every exported
  function plus those referenced by a block's `opcode`/`function` field, drops
  everything else, inlines only the assets actually referenced via the runtime
  global, and writes the result to `dist/<id>@<version>.js` formatted with
  [Prettier](https://prettier.io/).

## Submitting changes

1. [Fork](https://docs.github.com/en/get-started/quickstart/fork-a-repo) the
   repository and create a branch:

   ```bash
   git checkout -b my-feature
   ```

2. Make your changes, keeping the scope focused. A pull request should do one
   thing and do it well.
3. Run the checks described in [Testing](#testing) and make sure they pass.
4. Push your branch and open a pull request against `main`.
5. In the pull request description, explain what you changed and why. Link any
   related issues.

## Code style

This project uses [Prettier](https://prettier.io/) for formatting and
[ESLint](https://eslint.org/) for linting. Both are configured at the repo root;
there is no bikeshedding over style in reviews.

```bash
# Check formatting
npm run format:check

# Fix formatting
npm run format

# Lint
npm run lint
```

The repository's `.prettierrc` configures double quotes, trailing commas, and
`objectWrap: "collapse"`, so there is nothing to configure per-file. Please make
sure your changes are formatted and lint-clean before submitting.

> The generated extension output is also formatted with the same Prettier
> configuration, so the compiler's behavior is what you see in `dist/`.

## Testing

Run the automated test suite as your primary check:

```bash
npm test
```

You can also verify a change end-to-end with a manual CLI smoke test:

```bash
# Scaffold a scratch project somewhere outside the repo
mkdir -p /tmp/warp-smoke && cd /tmp/warp-smoke
node /path/to/warp-compiler/bin/warp-compiler.js init

# Add an asset the entry references, then build
mkdir -p assets
node /path/to/warp-compiler/bin/warp-compiler.js build

# Inspect the generated file
cat dist/*.js
```

Make sure the generated extension matches the documented behavior and stays
statically parseable. If your change touches the build pipeline, add a
description of any behavioral change to the pull request.

## Releasing

Maintainers create a git tag for the version being released; the
[release workflow](../.github/workflows/release.yml) publishes the package to
npm automatically. Contributors do not need to publish packages.

---

Thank you for contributing to Warp Compiler!
