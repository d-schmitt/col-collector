"""Preload source-listed climb starts for every pass without inventing route metrics."""

import argparse
import hashlib
import json
import re
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from import_catalogue import EXPORT, LAYERS, NS, SOURCE

DATA = Path(__file__).resolve().parents[1] / ".github/extensions/col-collector/data"
ANNOTATION = re.compile(
    r"^(?:also\b|asphalt\b|gravel\b|pavement\b|pass\b|road\b|side\b|walking\b|"
    r"high\b|highest\b|geographical\b|tunnel\b|end\b|track\b|incl\.|via\b|"
    r"fair\b|good\b|easy\b|R[1-3M](?:\b|-)|S south\b|some\b|all\b|"
    r"steepest\b|concrete\b|construction\b|section\b|old\b|should\b|"
    r"the road\b|nearby\b|includes\b|a bit\b|essentially\b|parking\b|"
    r"optionally\b|continues\b|walk\b|climb\b|S side\b|flat\b|earlier\b|"
    r"extremely\b|direct road\b|no water\b|regulated\b|[0-9])",
    re.IGNORECASE,
)

# Explicit variants in the source that cannot be split safely by punctuation alone.
VARIANTS = {
    "Gopplerlücke/Goppisbergeralp": {
        "Mörel": ["Mörel (via Betten)", "Mörel (via Goppisberg)"],
    },
    "Obergrünwald/Rosswagen": {
        "Bolzano/Bozen": ["Bolzano/Bozen (main road)", "Bolzano/Bozen (via Signat)", "Bolzano/Bozen (via Santa Maddalena)"],
    },
    "Auna di Sopra/Oberinn": {
        "Bolzano/Bozen": ["Bolzano/Bozen (via Wangen/Vanga)", "Bolzano/Bozen (main road)", "Bolzano/Bozen (via Signat)"],
    },
    "Le Ej/Ei": {
        "Fonzaso": ["Fonzaso (via S. Donato)", "Fonzaso (via Lamon)"],
    },
    "Plätzwiesensattel/Passo di Pratopiazza": {
        "Niederrasen/Rasun di Sotto": ["Niederrasen/Rasun di Sotto", "Niederrasen/Rasun di Sotto (Goste short-cut)"],
    },
    "Col de la Croix de Fer": {
        "St-Jean-de-Maurienne": ["St-Jean-de-Maurienne (main road)", "St-Jean-de-Maurienne (via D80b panorama road)"],
    },
}
PASS_ANNOTATIONS = {
    ("Avoriaz/Col de la Joux Verte", "Col de la Joux Verte"),
}
VERIFIED_ALIASES = {
    ("pass-f2c768b7d43bf42f", "Prato/Prad"): "stelvio-prad",
    ("pass-f2c768b7d43bf42f", "Bormio"): "stelvio-bormio",
    ("pass-f2c768b7d43bf42f", "Sta. Maria im Müstair"): "stelvio-santa-maria",
}


def split_notes(value):
    result, start, depth = [], 0, 0
    for index, character in enumerate(value):
        if character == "(":
            depth += 1
        elif character == ")":
            depth = max(0, depth - 1)
        elif character == "," and depth == 0:
            result.append(value[start:index].strip())
            start = index + 1
    result.append(value[start:].strip())
    return result


def normalize(value):
    return " ".join(unicodedata.normalize("NFC", value).replace("*", "").split()).strip()


def extract_starts(notes, pass_name, elevation):
    notes = normalize(notes)
    if "fr." in notes and not notes.startswith(("Beckenried ", "Großlobming ")):
        notes = notes.split("fr.", 1)[1].strip()
    starts, excluded, annotations_started = [], [], False
    chunks = [part for chunk in split_notes(notes) for part in re.split(r"\s+or\s+(?=[A-Z][^\d]*\d)", chunk)]
    for chunk in chunks:
        if annotations_started:
            excluded.append(chunk)
            continue
        if chunk.startswith("(both via "):
            excluded.append(chunk)
            continue
        if chunk.startswith("(Route de "):
            chunk = chunk.removeprefix("(").removesuffix(")")
        if not chunk or ANNOTATION.match(chunk) or chunk.startswith("("):
            excluded.append(chunk)
            # A bare elevation is another measurement of the preceding start.
            annotations_started = not (
                re.fullmatch(r"\d+(?:/\d+)*(?:\s*\(\d+hm\))?", chunk) or
                re.match(r"^\d.*\((?:via |main road)", chunk)
            )
            continue
        match = re.match(r"^(.+?)\s+(\d{1,4})(?=$|[\s/(+])(.+)?$", chunk)
        if not match:
            excluded.append(chunk)
            annotations_started = True
            continue
        name, height, tail = match.group(1).strip(), int(match.group(2)), match.group(3) or ""
        if (height >= elevation or re.search(r"\b(?:at$|pass at|is located|road reaches|pass/views)\b", name, re.I)
                or re.match(r"^\s+is\b", tail) or (pass_name, name) in PASS_ANNOTATIONS):
            excluded.append(chunk)
            annotations_started = True
            continue
        variants = VARIANTS.get(pass_name, {}).get(name)
        if variants:
            starts.extend(variants)
            continue
        routes = re.findall(r"\((via [^)]+|main road)\)", tail)
        if routes:
            starts.extend(f"{name} ({route})" for route in routes)
        elif re.match(r"^\s*(?:/\d+)*\s+via ", tail):
            route = re.split(r"\s*\(", tail.split("via ", 1)[1])[0].strip()
            starts.append(f"{name} (via {route})")
        else:
            qualifier = re.search(r"\(fr\. ([^)]+)\)", tail)
            starts.append(f"{name} ({qualifier.group(1)})" if qualifier else name)
        if re.search(r"\balso\b", tail):
            annotations_started = True
    return list(dict.fromkeys(starts)), excluded


def cautions(notes):
    result = []
    if re.search(r"gravel|unpaved|cobbleston|\bR[1-3M]\b|\btrack\b|\bwalking\b|\bwalk\b|\bpath\b", notes, re.I):
        result.append("The source mentions unpaved sections or walking on this pass or connected routes. Check the original reference for your chosen approach.")
    if re.search(r"forbidden|private road|regulated traffic|closed|destroyed|not rebuilt", notes, re.I):
        result.append("The source flags access restrictions, closures or road damage. Check current cycling access before riding.")
    if re.search(r"steep|impossible with road bike", notes, re.I):
        result.append("The source flags very steep or difficult sections. Check the route and gearing before riding.")
    return result


def build(xml, catalogue, verified):
    root = ET.fromstring(xml)
    by_location = {(p["name"], round(p["longitude"], 6), round(p["latitude"], 6)): p for p in catalogue["passes"]}
    approaches = [{**a, "sourceKind": "verified-route"} for a in verified]
    verified_ids = {a["id"] for a in verified}
    seen, audit, warnings = set(), [], {}
    for folder in root.findall(".//k:Folder", NS):
        if folder.findtext("k:name", namespaces=NS) not in LAYERS:
            continue
        for item in folder.findall("k:Placemark", NS):
            name = item.findtext("k:name", namespaces=NS)
            coordinates = item.findtext("k:Point/k:coordinates", namespaces=NS)
            lon, lat = [float(part) for part in coordinates.strip().split(",")[:2]]
            point = by_location.get((name, round(lon, 6), round(lat, 6)))
            if not point:
                raise ValueError(f"Source/catalogue mismatch: {name}; refresh and review the pass catalogue first")
            if point["id"] in seen:
                raise ValueError(f"Repeated source pass: {name}")
            seen.add(point["id"])
            fields = {
                field.attrib["name"]: field.findtext("k:value", namespaces=NS)
                for field in item.findall("k:ExtendedData/k:Data", NS)
            }
            notes = fields.get("other")
            if not notes:
                raise ValueError(f"No source-listed starting points for {name}")
            starts, excluded = extract_starts(notes, name, point["elevation"])
            if not starts:
                raise ValueError(f"No unambiguous starting points for {name}; needs source review")
            for start in starts:
                existing = VERIFIED_ALIASES.get((point["id"], start))
                if existing:
                    if existing not in verified_ids:
                        raise ValueError(f"Missing preserved approach ID: {existing}")
                    continue
                label = f"From {start}"
                if len(label) > 160:
                    raise ValueError(f"Overlong approach name: {label}")
                identity = f"{point['id']}|{normalize(start).casefold()}"
                approaches.append({
                    "id": "map-start-" + hashlib.sha256(identity.encode()).hexdigest()[:20],
                    "passId": point["id"],
                    "name": label,
                    "sourceUrl": point["sourceUrl"] or SOURCE,
                    "sourceKind": "map-start",
                })
            flags = cautions(notes)
            if flags:
                warnings[point["id"]] = flags
            audit.append({"pass": name, "starts": starts, "excluded": excluded})
    if seen != {p["id"] for p in catalogue["passes"]}:
        raise ValueError("Missing source entries; refusing a partially populated catalogue")
    if len({a["id"] for a in approaches}) != len(approaches):
        raise ValueError("Duplicate approach identifiers")
    if {a["passId"] for a in approaches} != seen:
        raise ValueError("Every catalogue pass must have at least one preloaded approach")
    report = {
        "sourceUrl": SOURCE,
        "sourceName": "cycloclimbing.com / selected Google My Maps layers",
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "passCount": len(seen),
        "approachCount": len(approaches),
        "mapStartCount": sum(a["sourceKind"] == "map-start" for a in approaches),
        "verifiedRouteCount": len(verified),
        "cautions": warnings,
    }
    return sorted(approaches, key=lambda a: (a["passId"], a["name"])), report, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Previously downloaded source KML")
    parser.add_argument("--audit", type=Path, help="Write an extraction audit for review outside the repository")
    args = parser.parse_args()
    if args.input:
        xml = args.input.read_bytes()
    else:
        with urllib.request.urlopen(EXPORT, timeout=30) as response:
            xml = response.read()
    catalogue = json.loads((DATA / "catalogue.json").read_text())
    verified = json.loads((DATA / "verified-approaches.json").read_text())
    approaches, report, audit = build(xml, catalogue, verified)
    (DATA / "approaches.json").write_text(json.dumps(approaches, ensure_ascii=False, indent=2) + "\n")
    (DATA / "approach-sources.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if args.audit:
        args.audit.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "cautions"}, indent=2))


if __name__ == "__main__":
    main()
