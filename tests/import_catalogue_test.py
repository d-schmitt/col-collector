import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("importer", Path(__file__).parents[1] / "scripts/import_catalogue.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def document(first_name="High", first_altitude="2100", duplicate=False):
    def point(name, altitude):
        return f"""<Placemark><name>{name}</name><Point><coordinates>10,46,0</coordinates></Point>
        <ExtendedData><Data name="altitude"><value>{altitude}</value></Data></ExtendedData></Placemark>"""
    high = point(first_name, first_altitude)
    if duplicate:
        high += high
    return f"""<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Folder><name>Paved passes +2000</name>{high}</Folder>
    <Folder><name>Paved passes -2000</name>{point("Low", "1500")}</Folder>
    <Folder><name>Gravel road climbs</name>{point("Gravel", "2200")}</Folder>
    </Document></kml>"""


class ImportTests(unittest.TestCase):
    def test_mortirolo_display_name_preserves_source_identity(self):
        source_name = "Passo della Foppa/Pas de la Foppa (Passo del Mortirolo)"
        xml = document(first_name=source_name).replace("10,46,0", "10.2985193,46.2479856,0")
        result = importer.parse_catalogue(xml)
        mortirolo = next(p for p in result["passes"] if p["name"] == source_name)
        self.assertEqual(mortirolo["id"], "pass-965d3e148f028ea0")
        self.assertEqual(mortirolo["displayName"], "Mortirolo")

    def test_only_selected_layers(self):
        result = importer.parse_catalogue(document())
        self.assertEqual(len(result["passes"]), 2)

    def test_reviewed_additions_survive_catalogue_import_without_changing_source_ids(self):
        source = importer.parse_catalogue(document())
        original_ids = {item["id"] for item in source["passes"]}
        result = importer.apply_overrides(source)
        additions = {item["id"]: item for item in result["passes"] if item["id"].startswith("climb-")}
        self.assertEqual(set(additions), {"climb-alpe-dhuez", "climb-torri-di-fraele"})
        self.assertEqual({item["id"] for item in result["passes"]} - set(additions), original_ids)
        self.assertEqual(additions["climb-alpe-dhuez"]["elevation"], 1860)
        self.assertEqual(additions["climb-torri-di-fraele"]["elevation"], 1930)
        self.assertTrue(all(addition["sources"]["coordinates"] and addition["sources"]["elevation"]
                            for addition in importer.load_overrides()["additions"]))

    def test_source_membership_preserved_at_boundary(self):
        result = importer.parse_catalogue(document(first_altitude="2000"))
        high = next(p for p in result["passes"] if p["name"] == "High")
        self.assertEqual(high["group"], "high")
        self.assertEqual(len(result["warnings"]), 1)

    def test_duplicate_identity_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            importer.parse_catalogue(document(duplicate=True))

    def test_missing_layer_rejected(self):
        with self.assertRaisesRegex(ValueError, "Both non-empty"):
            importer.parse_catalogue(document().replace("Paved passes -2000", "Other"))

    def test_missing_elevation_is_explicit(self):
        result = importer.parse_catalogue(document(first_altitude="unknown"))
        high = next(p for p in result["passes"] if p["name"] == "High")
        self.assertIsNone(high["elevation"])
        self.assertIn("Missing numeric elevation", result["warnings"][0])


if __name__ == "__main__":
    unittest.main()
