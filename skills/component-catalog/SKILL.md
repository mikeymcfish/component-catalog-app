---
name: component-catalog
description: Safely work with the local Component Catalog inventory app. Use for locating owned electronic components by name, MPN, case, compartment, or layer; checking stock and item details; resolving and reviewing an item's datasheet; changing only an existing component's quantity; or adding a new component to an empty catalog compartment. Also trigger on requests such as "where is this part", "set the quantity in Case 1 A1", "review the datasheet for this item", and "add this new component". Never use this skill to delete, move, rename, replace, clear, or overwrite existing catalog records or metadata.
---

# Component Catalog

Use `scripts/component_catalog.py` as the only write path. It discovers the local app, joins components to case locations, rejects ambiguous writes, and verifies persistence.

## Non-negotiable safety policy

- Permit only two mutations:
  1. Set the `quantity` of one unambiguously resolved existing component.
  2. Create a new component in an empty compartment.
- Never issue HTTP `DELETE`, `PUT`, or a general metadata `PATCH`.
- Never edit `data/storage.json`, a database, or application files to change inventory.
- Never change an existing item's name, category, package, notes, location, datasheet, photo, model, checkout state, or minimum quantity.
- Never move, replace, clear, merge, or delete a component, compartment, case, tool, adapter, or component-book entry.
- Treat placeholder records such as `TBD` as occupied; do not replace them.
- If the requested target is ambiguous, stop and ask for the missing case, compartment, layer, or part identity.
- Report the resolved item, old/new quantity or new ID, and exact location after every write.

## Running the helper

Resolve the skill directory from this file. Use an available Python 3 executable; in the Codex desktop app, call `load_workspace_dependencies` when necessary to obtain the bundled Python path.

```powershell
& $python "$skillDir\scripts\component_catalog.py" <command> <arguments>
```

The helper discovers Component Catalog on local ports 5000-5010. Set
`COMPONENT_CATALOG_URL` or pass `--base-url` before the command only when
discovery is insufficient. If the app is stopped, run
`Launch Component Catalog.cmd` from the project root, then retry.

## Locate or inspect items

Search before making any change.

```powershell
& $python "$skillDir\scripts\component_catalog.py" locate "FPC" --case "Case 1" --compartment A1
& $python "$skillDir\scripts\component_catalog.py" locate "TPS61023"
& $python "$skillDir\scripts\component_catalog.py" locate --case "Case 1" --compartment A1 --layer top
```

Use `--component-id` when a prior result provides an exact ID. Do not infer that top or bottom is intended when both layers remain possible.

## Change quantity

Run `locate` first, then set an absolute nonnegative quantity. The helper sends a PATCH body containing only `quantity`, verifies all other metadata is unchanged, and re-reads the stored value.

```powershell
& $python "$skillDir\scripts\component_catalog.py" set-quantity --query "FPC" --quantity 3 --case "Case 1" --compartment A1
```

Use `--dry-run` for a preflight when the request is unclear. A request to add or subtract stock may be converted to an absolute quantity only after reading the current quantity and confirming the arithmetic.

## Add a new item

Require a name, supported category, quantity, case, compartment, and layer whenever the position exists on both halves. The target must be empty. Optional fields are `--package-size`, `--min-quantity`, `--datasheet-url`, `--photo-url`, and `--notes`.

```powershell
& $python "$skillDir\scripts\component_catalog.py" add-item `
  --name "TPS61023DRLR" --category ic --quantity 5 `
  --case "Case 1" --compartment A3 --layer top `
  --package-size "WSON-6 2x2 mm" --datasheet-url "https://www.ti.com/lit/ds/symlink/tps61023.pdf"
```

The helper refuses an exact existing name by default. Use `--allow-existing-name` only when the user explicitly asks to create a separate inventory record for the same part in a different empty compartment. This flag still never overwrites an existing record.

## Review a datasheet

Resolve the catalog record and datasheet first:

```powershell
& $python "$skillDir\scripts\component_catalog.py" datasheet --query "TPS61023" --case "Case 1"
```

Then use the `datasheets` skill as the electronics-specification authority on the returned local PDF or URL. For layout-sensitive PDF inspection, also use the PDF workflow. Cite page numbers, distinguish manufacturer evidence from catalog notes, and do not change catalog metadata during review.

## Output and failures

The helper emits JSON. Exit code 0 means the operation or dry run succeeded. Exit code 2 means the operation was refused or failed validation. Preserve that refusal; do not bypass it with raw API calls or file edits.
