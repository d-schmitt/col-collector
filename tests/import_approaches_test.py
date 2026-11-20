import json
import sys
import unittest
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from import_approaches import build, cautions, extract_starts
from import_catalogue import load_overrides

DATA = Path(__file__).parents[1] / ".github/extensions/col-collector/data"


def source(notes, name="Test pass", longitude=10):
    return f"""<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>
    <name>Paved passes +2000</name><Placemark><name>{escape(name)}</name>
    <Point><coordinates>{longitude},46,0</coordinates></Point><ExtendedData>
    <Data name="other"><value>{escape(notes)}</value></Data>
    </ExtendedData></Placemark></Folder></Document></kml>"""


class ApproachTests(unittest.TestCase):
    def test_klausenpass_has_three_source_starts(self):
        names, _ = extract_starts("fr. Altdorf (Tell monument) 458 (1552hm), *Schattdorf 464, Linthal station 646 (1307hm)", "Klausenpass", 1948)
        self.assertEqual(names, ["Altdorf (Tell monument)", "Schattdorf", "Linthal station"])

    def test_notes_are_not_imported_as_routes(self):
        names, _ = extract_starts("fr. Alpha 400, 20m gravel to pass, earlier side road to Col Beta 1600", "Test pass", 1800)
        self.assertEqual(names, ["Alpha"])
        names, _ = extract_starts("fr. Alpha 400, Jaunpass at 1508, also Col de Bädermoos 1559", "Test pass", 1600)
        self.assertEqual(names, ["Alpha"])
        names, _ = extract_starts("fr. Alpha 400, Forcella Beta 1533 is 600m away", "Test pass", 1600)
        self.assertEqual(names, ["Alpha"])

    def test_variants_keep_distinct_routes_without_duplicate_elevations(self):
        names, _ = extract_starts("fr. Brixen/Bressanone 558 (via Eores/Afers) (1435hm)/562 (via Lüsen/Luson/Lijun) (1441hm)", "Passo di Éores", 1800)
        self.assertEqual(names, ["Brixen/Bressanone (via Eores/Afers)", "Brixen/Bressanone (via Lüsen/Luson/Lijun)"])
        names, _ = extract_starts("fr. Alpha 400/405/410, Beta 500", "Test pass", 1800)
        self.assertEqual(names, ["Alpha", "Beta"])

    def test_shared_qualifier_does_not_drop_later_starts(self):
        names, _ = extract_starts("fr. Strigno 352, Scurelle 378, (both via Passo Forcella 910 & Val Malene), Grigno 259", "Test pass", 1800)
        self.assertEqual(names, ["Strigno", "Scurelle", "Grigno"])

    def test_road_numbers_and_starred_unicode_names(self):
        names, _ = extract_starts("fr. *D6 Route de Gréolièrs 42, Cavalèse (SP232) 839, Sölden 1417", "Test pass", 2200)
        self.assertEqual(names, ["D6 Route de Gréolièrs", "Cavalèse (SP232)", "Sölden"])

    def test_surface_and_access_flags_are_not_silently_discarded(self):
        flags = cautions("fr. Alpha 400, gravel west, tunnel forbidden, very steep")
        self.assertEqual(len(flags), 3)

    def test_missing_pass_or_unparseable_start_fails_instead_of_filling_a_placeholder(self):
        catalogue = {"passes": [{"id": "test", "name": "Test pass", "longitude": 10, "latitude": 46, "elevation": 2100, "sourceUrl": None}]}
        with self.assertRaisesRegex(ValueError, "No unambiguous"):
            build(source("fr. unknown"), catalogue, [], {"additions": []})
        catalogue["passes"].append({**catalogue["passes"][0], "id": "missing", "name": "Missing pass"})
        with self.assertRaisesRegex(ValueError, "Missing source entries"):
            build(source("fr. Alpha 400"), catalogue, [], {"additions": []})

    def test_ids_are_stable_across_marker_formatting(self):
        catalogue = {"passes": [{"id": "test", "name": "Test pass", "longitude": 10, "latitude": 46, "elevation": 2100, "sourceUrl": None}]}
        first, _, _ = build(source("fr. *Alpha 400"), catalogue, [], {"additions": []})
        second, _, _ = build(source("fr. Alpha   400"), catalogue, [], {"additions": []})
        self.assertEqual(first, second)

    def test_reviewed_addition_approaches_survive_approach_import(self):
        overrides = load_overrides()
        catalogue = {
            "passes": [
                {"id": "test", "name": "Test pass", "longitude": 10, "latitude": 46, "elevation": 2100, "sourceUrl": None},
                *[item["pass"] for item in overrides["additions"]],
            ]
        }
        approaches, report, _ = build(source("fr. Alpha 400"), catalogue, [], overrides)
        reviewed = [item for item in approaches if item["sourceKind"] == "reviewed-addition"]
        self.assertEqual({item["passId"] for item in reviewed}, {"climb-alpe-dhuez", "climb-torri-di-fraele"})
        self.assertEqual(report["reviewedAdditionCount"], 2)
        self.assertEqual({item["name"] for item in reviewed}, {
            "From Bourg-d’Oisans (21 hairpins)",
            "From Bormio (via Premadio and Fior d’Alpe)",
        })
        self.assertEqual(report["passCount"], 3)
        self.assertIn("climb-torri-di-fraele", report["cautions"])

    def test_snapshot_coverage_and_no_placeholder_routes(self):
        catalogue = json.loads((DATA / "catalogue.json").read_text())
        approaches = json.loads((DATA / "approaches.json").read_text())
        report = json.loads((DATA / "approach-sources.json").read_text())
        self.assertEqual({a["passId"] for a in approaches}, {p["id"] for p in catalogue["passes"]})
        self.assertEqual(report["passCount"], 439)
        self.assertEqual(report["approachCount"], len(approaches))
        self.assertEqual(report["mapStartCount"] + report["verifiedRouteCount"] + report["reviewedAdditionCount"], len(approaches))
        self.assertTrue(all(a["name"].startswith("From ") and a["sourceUrl"] for a in approaches))
        self.assertFalse(any("unknown" in a["name"].lower() for a in approaches))


if __name__ == "__main__":
    unittest.main()
