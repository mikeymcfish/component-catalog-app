# Contributing to Component Catalog

Contributions are welcome through issues and pull requests.

## Protect private catalog data

Never include real inventory records, storage locations, checkout names,
purchase/order notes, BOMs, reports, local paths, service identifiers, tokens,
or managed uploads in an issue or pull request.

In particular, do not commit:

- `data/`
- `uploads/`
- `attached_assets/`
- `output/`
- `tmp/`
- `.env*` files other than intentionally sanitized examples
- screenshots made from a real catalog

Use synthetic components, fictional cases, and temporary directories in tests
and documentation. Public screenshots must be captured from synthetic data.
Datasheets, product photos, CAD models, and other third-party files require
explicit redistribution permission before they can be added.

## Development setup

Use Node.js 20.19 or newer.

```powershell
npm ci
npm run dev
```

The default app binds to localhost and creates JSON storage on first run.
Keep test or demo state separate from any personal catalog by setting
`STORAGE_FILE` and `UPLOADS_DIR` to disposable paths.

## Pull-request workflow

1. Fork the public repository and create a focused branch.
2. Make the smallest coherent change.
3. Add or update automated verification for behavior changes.
4. Update documentation when setup, storage, network exposure, or user-visible
   behavior changes.
5. Run the required checks.
6. Open a pull request describing the problem, the change, and verification.

Do not mix generated files, formatting-only rewrites, or private data cleanup
with an unrelated feature.

## Required checks

```powershell
npm run check
npm test
npm run build
```

Run focused checks when relevant:

```powershell
npm run test:3d
npm run test:phone
npm run test:lan-launcher
python -m unittest skills/component-catalog/scripts/test_component_catalog.py
```

`test:lan-launcher` requires Windows.

## Storage and migration changes

- Preserve JSON-file compatibility unless a documented breaking migration is
  intentional.
- Test with isolated temporary storage; never use `data/storage.json` from a
  real catalog.
- PostgreSQL schema changes must update Drizzle schema definitions and include
  an appropriate incremental migration.
- Remember that managed uploads are filesystem data even when PostgreSQL stores
  the catalog records.

## Network and security changes

The full UI has no sign-in. Changes involving host binding, LAN access, CORS,
Host validation, uploads, OAuth, MCP tools, or logging require explicit
security-focused tests and documentation.

Do not open a public issue containing a vulnerability exploit, access token, or
private inventory. Use the repository's private security-reporting channel
after it is enabled for the public release.

## Pull-request checklist

- [ ] No personal catalog data, credentials, or unlicensed binary assets are
      included.
- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] Relevant focused tests pass.
- [ ] User-facing behavior and configuration are documented.
- [ ] Screenshots and fixtures use synthetic data.
