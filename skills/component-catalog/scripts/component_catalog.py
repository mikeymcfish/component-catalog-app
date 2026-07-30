#!/usr/bin/env python3
"""Guarded command-line access to the local Component Catalog app."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable


DEFAULT_PROJECT_ROOT = Path.cwd()
CATEGORY_IDS = {
    "resistor": 1,
    "capacitor": 2,
    "ic": 3,
    "diode": 4,
    "transistor": 5,
    "inductor": 6,
    "crystal": 7,
    "connector": 8,
    "led": 9,
    "switch": 10,
    "sensor": 11,
    "other": 12,
}
CATEGORY_NAMES = {value: key for key, value in CATEGORY_IDS.items()}


class CatalogError(RuntimeError):
    pass


def normalize(value: Any) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").casefold()))


def compact(value: Any) -> str:
    return "".join(re.findall(r"[a-z0-9]+", str(value or "").casefold()))


def json_dump(value: Any, *, stream: Any = sys.stdout) -> None:
    json.dump(value, stream, indent=2, ensure_ascii=False)
    stream.write("\n")


class CatalogClient:
    def __init__(self, base_url: str | None = None, timeout: float = 5.0):
        self.timeout = timeout
        self.base_url = self._discover(base_url)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        if method.upper() == "DELETE":
            raise CatalogError("DELETE is forbidden by the Component Catalog skill")
        url = f"{self.base_url}{path}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise CatalogError(f"Component Catalog returned HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CatalogError(f"Cannot reach Component Catalog at {self.base_url}: {exc}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CatalogError(f"Component Catalog returned non-JSON data for {path}") from exc

    def _valid_health(self, base_url: str) -> bool:
        original = getattr(self, "base_url", None)
        self.base_url = base_url.rstrip("/")
        try:
            health = self._request("GET", "/api/health")
            return isinstance(health, dict) and health.get("app") == "component-catalog"
        except CatalogError:
            return False
        finally:
            if original is not None:
                self.base_url = original

    def _discover(self, explicit: str | None) -> str:
        configured = explicit or os.environ.get("COMPONENT_CATALOG_URL")
        if configured:
            candidate = configured.rstrip("/")
            if not self._valid_health(candidate):
                raise CatalogError(f"{candidate} is not a healthy Component Catalog instance")
            return candidate

        for port in range(5000, 5011):
            candidate = f"http://127.0.0.1:{port}"
            if self._valid_health(candidate):
                return candidate
        raise CatalogError(
            "No local Component Catalog instance found on ports 5000-5010. "
            "Start 'Launch Component Catalog.cmd' and retry."
        )

    def cases(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/api/cases")
        if not isinstance(result, list):
            raise CatalogError("Unexpected /api/cases response")
        return result

    def case_detail(self, case_id: int) -> dict[str, Any]:
        result = self._request("GET", f"/api/cases/{case_id}")
        if not isinstance(result, dict):
            raise CatalogError(f"Unexpected response for case {case_id}")
        return result

    def components(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/api/components")
        if not isinstance(result, list):
            raise CatalogError("Unexpected /api/components response")
        return result

    def patch_quantity(self, component_id: int, quantity: int) -> dict[str, Any]:
        # This method deliberately accepts no arbitrary update dictionary.
        result = self._request("PATCH", f"/api/components/{component_id}", {"quantity": quantity})
        if not isinstance(result, dict):
            raise CatalogError("Unexpected quantity update response")
        return result

    def create_component(self, payload: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "compartmentId", "name", "categoryId", "packageSize", "quantity",
            "minQuantity", "datasheetUrl", "photoUrl", "notes",
        }
        unexpected = set(payload) - allowed
        if unexpected:
            raise CatalogError(f"Unsafe create fields refused: {sorted(unexpected)}")
        result = self._request("POST", "/api/components", payload)
        if not isinstance(result, dict):
            raise CatalogError("Unexpected component creation response")
        return result


def select_case(client: CatalogClient, case_name: str) -> dict[str, Any]:
    active = [case for case in client.cases() if case.get("isActive") is not False]
    wanted = normalize(case_name)
    exact = [case for case in active if normalize(case.get("name")) == wanted]
    if len(exact) == 1:
        return exact[0]
    partial = [case for case in active if wanted and wanted in normalize(case.get("name"))]
    if len(partial) == 1:
        return partial[0]
    candidates = [case.get("name") for case in (exact or partial)]
    if candidates:
        raise CatalogError(f"Case name is ambiguous: {case_name!r}; matches {candidates}")
    raise CatalogError(f"Active case not found: {case_name!r}")


def catalog_entries(client: CatalogClient) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for case in client.cases():
        if case.get("isActive") is False:
            continue
        detail = client.case_detail(int(case["id"]))
        for compartment in detail.get("compartments", []):
            component = compartment.get("component")
            if not isinstance(component, dict):
                continue
            entries.append({
                "component": component,
                "case": detail,
                "compartment": compartment,
            })
    return entries


def score_entry(entry: dict[str, Any], query: str | None) -> int:
    if not query:
        return 1
    component = entry["component"]
    q_norm = normalize(query)
    q_compact = compact(query)
    name_norm = normalize(component.get("name"))
    name_compact = compact(component.get("name"))
    haystack = normalize(" ".join(str(component.get(key) or "") for key in (
        "name", "packageSize", "notes", "model3dName",
    )))
    hay_compact = compact(haystack)
    if q_compact and q_compact == name_compact:
        return 1000
    if q_compact and q_compact in name_compact:
        return 700
    if q_compact and q_compact in hay_compact:
        return 500
    tokens = [token for token in q_norm.split() if len(token) > 1]
    matched = sum(1 for token in tokens if token in haystack)
    if tokens and matched == len(tokens):
        return 300 + matched * 20
    if matched:
        return matched * 20
    return 0


def find_entries(
    client: CatalogClient,
    query: str | None = None,
    *,
    case_name: str | None = None,
    compartment: str | None = None,
    layer: str | None = None,
    component_id: int | None = None,
) -> list[dict[str, Any]]:
    if not any((query, case_name, compartment, layer, component_id)):
        raise CatalogError("Provide a query, location filter, or component ID")
    selected_case_id = int(select_case(client, case_name)["id"]) if case_name else None
    results = []
    for entry in catalog_entries(client):
        component = entry["component"]
        slot = entry["compartment"]
        case = entry["case"]
        if component_id is not None and int(component.get("id", -1)) != component_id:
            continue
        if selected_case_id is not None and int(case.get("id", -1)) != selected_case_id:
            continue
        if compartment and str(slot.get("position", "")).casefold() != compartment.casefold():
            continue
        if layer and str(slot.get("layer", "")).casefold() != layer.casefold():
            continue
        score = score_entry(entry, query)
        if score:
            results.append({**entry, "score": score})
    return sorted(
        results,
        key=lambda item: (-item["score"], normalize(item["component"].get("name")), item["component"].get("id", 0)),
    )


def public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    component = entry["component"]
    case = entry["case"]
    slot = entry["compartment"]
    return {
        "id": component.get("id"),
        "name": component.get("name"),
        "category": CATEGORY_NAMES.get(component.get("categoryId"), "unknown"),
        "categoryId": component.get("categoryId"),
        "packageSize": component.get("packageSize"),
        "quantity": component.get("quantity"),
        "minQuantity": component.get("minQuantity"),
        "caseName": case.get("name"),
        "caseId": case.get("id"),
        "compartment": slot.get("position"),
        "compartmentId": slot.get("id"),
        "layer": slot.get("layer"),
        "datasheetUrl": component.get("datasheetUrl"),
        "photoUrl": component.get("photoUrl"),
        "notes": component.get("notes"),
        "score": entry.get("score"),
    }


def resolve_one(client: CatalogClient, **filters: Any) -> dict[str, Any]:
    matches = find_entries(client, **filters)
    if not matches:
        raise CatalogError("No component matches the supplied identity and location")
    if len(matches) != 1:
        candidates = [
            {
                "id": item["component"].get("id"),
                "name": item["component"].get("name"),
                "case": item["case"].get("name"),
                "compartment": item["compartment"].get("position"),
                "layer": item["compartment"].get("layer"),
            }
            for item in matches[:12]
        ]
        raise CatalogError(f"Component target is ambiguous; refine the request. Candidates: {candidates}")
    return matches[0]


def locate(client: CatalogClient, *, limit: int = 20, **filters: Any) -> dict[str, Any]:
    matches = find_entries(client, **filters)
    return {
        "operation": "locate",
        "baseUrl": client.base_url,
        "matchCount": len(matches),
        "matches": [public_entry(item) for item in matches[:limit]],
        "truncated": len(matches) > limit,
    }


def set_quantity(
    client: CatalogClient,
    *,
    quantity: int,
    dry_run: bool = False,
    **filters: Any,
) -> dict[str, Any]:
    if quantity < 0:
        raise CatalogError("Quantity must be a nonnegative integer")
    match = resolve_one(client, **filters)
    before = dict(match["component"])
    location = public_entry(match)
    old_quantity = int(before.get("quantity", 0))
    result = {
        "operation": "set-quantity",
        "status": "dry-run" if dry_run else "pending",
        "id": before.get("id"),
        "name": before.get("name"),
        "caseName": location["caseName"],
        "compartment": location["compartment"],
        "layer": location["layer"],
        "oldQuantity": old_quantity,
        "newQuantity": quantity,
    }
    if old_quantity == quantity:
        result["status"] = "unchanged"
        return result
    if dry_run:
        return result

    updated = client.patch_quantity(int(before["id"]), quantity)
    before_metadata = {key: value for key, value in before.items() if key != "quantity"}
    after_metadata = {key: value for key, value in updated.items() if key != "quantity"}
    if before_metadata != after_metadata:
        changed = sorted(key for key in set(before_metadata) | set(after_metadata)
                         if before_metadata.get(key) != after_metadata.get(key))
        raise CatalogError(f"Quantity changed, but unexpected metadata also changed: {changed}")

    stored = next((item for item in client.components() if int(item.get("id", -1)) == int(before["id"])), None)
    if not stored or int(stored.get("quantity", -1)) != quantity:
        raise CatalogError("Quantity update was not persisted as requested")
    result["status"] = "updated"
    result["verifiedQuantity"] = stored["quantity"]
    return result


def resolve_compartment(
    client: CatalogClient,
    case_name: str,
    position: str,
    layer: str | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    case = select_case(client, case_name)
    detail = client.case_detail(int(case["id"]))
    matches = [
        slot for slot in detail.get("compartments", [])
        if str(slot.get("position", "")).casefold() == position.casefold()
        and (layer is None or str(slot.get("layer", "")).casefold() == layer.casefold())
    ]
    if not matches:
        raise CatalogError(f"Compartment not found: {case.get('name')} {position} {layer or ''}".strip())
    if len(matches) != 1:
        layers = sorted(str(slot.get("layer")) for slot in matches)
        raise CatalogError(f"Compartment exists on multiple layers {layers}; specify --layer")
    return detail, matches[0]


def add_item(
    client: CatalogClient,
    *,
    name: str,
    category: str,
    quantity: int,
    case_name: str,
    compartment: str,
    layer: str | None,
    package_size: str | None = None,
    min_quantity: int | None = None,
    datasheet_url: str | None = None,
    photo_url: str | None = None,
    notes: str | None = None,
    allow_existing_name: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    clean_name = name.strip()
    category_key = category.strip().casefold()
    if not clean_name:
        raise CatalogError("Item name cannot be blank")
    if category_key not in CATEGORY_IDS:
        raise CatalogError(f"Unsupported category {category!r}; choose from {sorted(CATEGORY_IDS)}")
    if quantity < 0:
        raise CatalogError("Quantity must be a nonnegative integer")
    if min_quantity is not None and min_quantity < 1:
        raise CatalogError("Minimum quantity must be at least 1")

    case, slot = resolve_compartment(client, case_name, compartment, layer)
    if isinstance(slot.get("component"), dict):
        occupant = slot["component"]
        raise CatalogError(
            f"Refusing to overwrite occupied compartment: {case.get('name')} {compartment} "
            f"{slot.get('layer')} contains {occupant.get('name')} (ID {occupant.get('id')})"
        )

    all_entries = catalog_entries(client)
    duplicates = [entry for entry in all_entries if normalize(entry["component"].get("name")) == normalize(clean_name)]
    if duplicates and not allow_existing_name:
        existing = [public_entry(entry) for entry in duplicates]
        raise CatalogError(
            "An exact-name component already exists. Refusing a possible duplicate; "
            f"use set-quantity or explicitly authorize a separate record. Existing: {existing}"
        )

    payload: dict[str, Any] = {
        "compartmentId": int(slot["id"]),
        "name": clean_name,
        "categoryId": CATEGORY_IDS[category_key],
        "quantity": quantity,
    }
    optional = {
        "packageSize": package_size,
        "minQuantity": min_quantity,
        "datasheetUrl": datasheet_url,
        "photoUrl": photo_url,
        "notes": notes,
    }
    payload.update({key: value for key, value in optional.items() if value is not None})

    result = {
        "operation": "add-item",
        "status": "dry-run" if dry_run else "pending",
        "caseName": case.get("name"),
        "caseId": case.get("id"),
        "compartment": slot.get("position"),
        "compartmentId": slot.get("id"),
        "layer": slot.get("layer"),
        "item": payload,
    }
    if dry_run:
        return result

    before_ids = {int(item["id"]) for item in client.components()}
    created = client.create_component(payload)
    created_id = int(created.get("id", -1))
    if created_id < 1 or created_id in before_ids:
        raise CatalogError("Component creation did not return a new ID")
    stored = next((item for item in client.components() if int(item.get("id", -1)) == created_id), None)
    if not stored:
        raise CatalogError("New component was not persisted")
    mismatched = sorted(key for key, value in payload.items() if stored.get(key) != value)
    if mismatched:
        raise CatalogError(f"New component persisted with unexpected values in: {mismatched}")
    result["status"] = "created"
    result["id"] = created_id
    result["verifiedQuantity"] = stored.get("quantity")
    return result


def datasheet_info(
    client: CatalogClient,
    *,
    project_root: Path,
    **filters: Any,
) -> dict[str, Any]:
    match = resolve_one(client, **filters)
    item = public_entry(match)
    url = match["component"].get("datasheetUrl")
    if not url:
        raise CatalogError(f"{item['name']} has no catalog datasheet")
    info: dict[str, Any] = {
        "operation": "datasheet",
        "id": item["id"],
        "name": item["name"],
        "caseName": item["caseName"],
        "compartment": item["compartment"],
        "layer": item["layer"],
        "catalogUrl": url,
    }
    if str(url).startswith("/uploads/"):
        root = project_root.resolve()
        local = (root / str(url).lstrip("/").replace("/", os.sep)).resolve()
        try:
            local.relative_to(root)
        except ValueError as exc:
            raise CatalogError("Catalog datasheet path escapes the project root") from exc
        info["localPath"] = str(local)
        info["exists"] = local.is_file()
        if not local.is_file():
            raise CatalogError(f"Catalog datasheet file is missing: {local}")
    else:
        info["remoteUrl"] = url
    return info


def common_filters(parser: argparse.ArgumentParser, *, query_positional: bool = False) -> None:
    if query_positional:
        parser.add_argument("query", nargs="?", help="Part name, MPN, description, or notes text")
    else:
        parser.add_argument("--query", help="Part name, MPN, description, or notes text")
    parser.add_argument("--case", dest="case_name", help="Case name")
    parser.add_argument("--compartment", help="Compartment such as A1")
    parser.add_argument("--layer", choices=("top", "bottom"))
    parser.add_argument("--component-id", type=int)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="Explicit Component Catalog base URL")
    parser.add_argument("--project-root", type=Path, default=Path(os.environ.get("COMPONENT_CATALOG_ROOT", DEFAULT_PROJECT_ROOT)))
    subparsers = parser.add_subparsers(dest="command", required=True)

    locate_parser = subparsers.add_parser("locate", help="Find components and exact locations")
    common_filters(locate_parser, query_positional=True)
    locate_parser.add_argument("--limit", type=int, default=20)

    quantity_parser = subparsers.add_parser("set-quantity", help="Change only one component's quantity")
    common_filters(quantity_parser)
    quantity_parser.add_argument("--quantity", type=int, required=True)
    quantity_parser.add_argument("--dry-run", action="store_true")

    add_parser = subparsers.add_parser("add-item", help="Add a new component to an empty compartment")
    add_parser.add_argument("--name", required=True)
    add_parser.add_argument("--category", required=True, choices=tuple(CATEGORY_IDS))
    add_parser.add_argument("--quantity", type=int, required=True)
    add_parser.add_argument("--case", dest="case_name", required=True)
    add_parser.add_argument("--compartment", required=True)
    add_parser.add_argument("--layer", choices=("top", "bottom"))
    add_parser.add_argument("--package-size")
    add_parser.add_argument("--min-quantity", type=int)
    add_parser.add_argument("--datasheet-url")
    add_parser.add_argument("--photo-url")
    add_parser.add_argument("--notes")
    add_parser.add_argument("--allow-existing-name", action="store_true")
    add_parser.add_argument("--dry-run", action="store_true")

    datasheet_parser = subparsers.add_parser("datasheet", help="Resolve an item's catalog datasheet")
    common_filters(datasheet_parser)
    return parser


def filter_kwargs(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "query": getattr(args, "query", None),
        "case_name": getattr(args, "case_name", None),
        "compartment": getattr(args, "compartment", None),
        "layer": getattr(args, "layer", None),
        "component_id": getattr(args, "component_id", None),
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        client = CatalogClient(args.base_url)
        if args.command == "locate":
            if args.limit < 1 or args.limit > 200:
                raise CatalogError("--limit must be between 1 and 200")
            result = locate(client, limit=args.limit, **filter_kwargs(args))
        elif args.command == "set-quantity":
            result = set_quantity(
                client,
                quantity=args.quantity,
                dry_run=args.dry_run,
                **filter_kwargs(args),
            )
        elif args.command == "add-item":
            result = add_item(
                client,
                name=args.name,
                category=args.category,
                quantity=args.quantity,
                case_name=args.case_name,
                compartment=args.compartment,
                layer=args.layer,
                package_size=args.package_size,
                min_quantity=args.min_quantity,
                datasheet_url=args.datasheet_url,
                photo_url=args.photo_url,
                notes=args.notes,
                allow_existing_name=args.allow_existing_name,
                dry_run=args.dry_run,
            )
        elif args.command == "datasheet":
            result = datasheet_info(client, project_root=args.project_root, **filter_kwargs(args))
        else:
            raise CatalogError(f"Unsupported command: {args.command}")
        json_dump(result)
        return 0
    except CatalogError as exc:
        json_dump({"status": "refused", "error": str(exc)}, stream=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
