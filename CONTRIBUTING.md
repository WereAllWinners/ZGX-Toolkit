# Contributing

Thank you for your interest in contributing to this fork of the ZGX Toolkit.

## About this fork

This fork maintains full compatibility with the upstream
[HPInc/ZGX-Toolkit](https://github.com/HPInc/ZGX-Toolkit) and adds the
Manageability Engine layer. Contributions are welcome in both areas.

The project is distributed via
[GitHub Releases](https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine/releases).
There is no VS Code Marketplace listing.

## Getting started

```bash
git clone https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine.git
cd ZGX-Toolkit
npm install
npm run compile
npm run test:unit
```

See [docs/building.md](docs/building.md) for full setup instructions.

## Development workflow

```bash
# Watch mode during development
npm run watch

# Lint before committing
npm run lint

# Full verification suite (run before every PR)
npm run compile && npm run lint && npm run test:unit && npm run test:integration
```

## Submitting changes

1. Fork this repo and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature
   ```
2. Write tests for new functionality.
3. Ensure all tests pass: `npm run test:unit`
4. Open a pull request with a clear description of the change.

## Code style

- TypeScript throughout the VS Code extension source.
- Python (stdlib only, no third-party packages) for on-device collector
  scripts in `DGX_spark_management/bin/`.
- Follow existing patterns: services in `src/services/`, types in
  `src/types/`, views in `src/views/`.
- Add JSDoc to all exported functions and types.
- New files should carry your own name and year in the copyright header.
- Do not modify HP copyright headers on HP-authored files.

## Manageability engine rules

- **Collectors** are read-only. They must never modify device state.
- **Controllers** must always require explicit user confirmation before the
  service layer invokes them. The `ManageabilityService` enforces this —
  do not bypass it.
- The JSON envelope format must match the NVIDIA DGX Spark Manageability
  Guide spec exactly. See `src/types/manageability.ts`.

## Creating a release

Use the included release script:

```bash
bash scripts/release.sh 2.1.0
```

Then follow the printed instructions to tag, push, and create a GitHub
Release with the `.vsix` attached.

## Reporting issues

Open an issue at:
https://github.com/WereAllWinners/ZGX-Toolkit-Manageability-Engine/issues

Please include VS Code version, extension version, device model, DGX OS
version, steps to reproduce, and expected vs. actual behavior.

## License

By contributing, you agree that your contributions will be licensed under
the X11 (MIT) License. See [LICENSE](LICENSE) for details.
