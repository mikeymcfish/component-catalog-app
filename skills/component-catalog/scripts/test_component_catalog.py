from __future__ import annotations

import importlib.util
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("component_catalog.py")
SPEC = importlib.util.spec_from_file_location("component_catalog", MODULE_PATH)
assert SPEC and SPEC.loader
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


class FakeClient:
    base_url = "http://127.0.0.1:5000"

    def __init__(self):
        self.component = {
            "id": 201,
            "compartmentId": 865,
            "name": "18-pin 0.5 mm FFC/FPC connector",
            "categoryId": 8,
            "packageSize": "SMD, P=0.5mm",
            "quantity": 10,
            "minQuantity": 5,
            "datasheetUrl": "/uploads/datasheets/fpc.pdf",
            "photoUrl": None,
            "notes": "MPN: SFV18R-4STBE1HLF",
            "checkedOut": False,
            "checkedOutBy": None,
            "checkedOutDate": None,
            "model3dUrl": None,
            "model3dName": None,
            "model3dSource": None,
            "model3dRotation": None,
        }
        self.created = []
        self.patch_payloads = []

    def cases(self):
        return [{"id": 8, "name": "Case 1", "isActive": True}]

    def case_detail(self, case_id):
        slots = [
            {"id": 865, "caseId": 8, "position": "A1", "layer": "top", "component": deepcopy(self.component)},
            {"id": 889, "caseId": 8, "position": "A1", "layer": "bottom"},
            {"id": 866, "caseId": 8, "position": "A2", "layer": "top"},
        ]
        for created in self.created:
            for slot in slots:
                if slot["id"] == created["compartmentId"]:
                    slot["component"] = deepcopy(created)
        return {"id": 8, "name": "Case 1", "isActive": True, "compartments": slots}

    def components(self):
        return [deepcopy(self.component), *deepcopy(self.created)]

    def patch_quantity(self, component_id, quantity):
        self.patch_payloads.append({"quantity": quantity})
        self.component["quantity"] = quantity
        return deepcopy(self.component)

    def create_component(self, payload):
        item = {
            **payload,
            "id": 900,
            "minQuantity": payload.get("minQuantity", 5),
            "packageSize": payload.get("packageSize"),
            "datasheetUrl": payload.get("datasheetUrl"),
            "photoUrl": payload.get("photoUrl"),
            "notes": payload.get("notes"),
        }
        self.created.append(item)
        return deepcopy(item)


class ComponentCatalogTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()

    def test_locates_by_query_and_location(self):
        result = catalog.locate(
            self.client,
            query="FPC",
            case_name="Case 1",
            compartment="A1",
            layer=None,
            component_id=None,
        )
        self.assertEqual(result["matchCount"], 1)
        self.assertEqual(result["matches"][0]["id"], 201)

    def test_quantity_patch_contains_only_quantity(self):
        result = catalog.set_quantity(
            self.client,
            query="FPC",
            quantity=3,
            case_name="Case 1",
            compartment="A1",
            layer="top",
            component_id=None,
        )
        self.assertEqual(result["status"], "updated")
        self.assertEqual(self.client.patch_payloads, [{"quantity": 3}])
        self.assertEqual(self.client.component["name"], "18-pin 0.5 mm FFC/FPC connector")

    def test_add_refuses_occupied_compartment(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.add_item(
                self.client,
                name="New connector",
                category="connector",
                quantity=1,
                case_name="Case 1",
                compartment="A1",
                layer="top",
            )

    def test_add_refuses_duplicate_name_by_default(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.add_item(
                self.client,
                name="18-pin 0.5 mm FFC/FPC connector",
                category="connector",
                quantity=1,
                case_name="Case 1",
                compartment="A2",
                layer="top",
            )

    def test_add_creates_new_record_without_overwriting(self):
        result = catalog.add_item(
            self.client,
            name="New connector",
            category="connector",
            quantity=4,
            case_name="Case 1",
            compartment="A2",
            layer="top",
            package_size="SMD",
        )
        self.assertEqual(result["status"], "created")
        self.assertEqual(result["id"], 900)
        self.assertEqual(self.client.component["id"], 201)
        self.assertEqual(len(self.client.created), 1)

    def test_layer_is_required_when_both_halves_match(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.resolve_compartment(self.client, "Case 1", "A1", None)

    def test_datasheet_resolves_local_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "uploads" / "datasheets" / "fpc.pdf"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"%PDF-1.4\n")
            result = catalog.datasheet_info(
                self.client,
                project_root=root,
                query="FPC",
                case_name="Case 1",
                compartment="A1",
                layer="top",
                component_id=None,
            )
            self.assertEqual(Path(result["localPath"]), target)
            self.assertTrue(result["exists"])

    def test_client_has_no_delete_or_general_update_method(self):
        self.assertFalse(hasattr(catalog.CatalogClient, "delete_component"))
        self.assertFalse(hasattr(catalog.CatalogClient, "update_component"))


if __name__ == "__main__":
    unittest.main()
