# Package Version Bump

This prompt has been replaced by a deterministic script.
**Use the script — do not perform these steps yourself.**

- Script: [scripts/bump-npm-version/index.ts](../../scripts/bump-npm-version/index.ts)
- Full docs: [scripts/bump-npm-version/README.md](../../scripts/bump-npm-version/README.md)
- Run:

  ```bash
  npm run bump:npm -- --help
  ```

The script enforces the no-`[skip ci]` rule, derives the publishable-package
list from [rush.json](../../rush.json), and gates pushing and PR creation
behind explicit `--push` and `--pr` flags.
See the README for prerequisites, the full flag reference, and the phase
descriptions.
