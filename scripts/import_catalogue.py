"""Import factual pass metadata from the two user-selected Google My Maps layers."""

import argparse
import hashlib
import json
import math
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

SOURCE = "https://www.google.com/maps/d/viewer?mid=1GPHWvjnIKIObSl2m5ykGzmm-BJd5aXWU"
EXPORT = "https://www.google.com/maps/d/kml?mid=1GPHWvjnIKIObSl2m5ykGzmm-BJd5aXWU&forcekml=1"
LAYERS = {"Paved passes +2000": "high", "Paved passes -2000": "low"}
NS = {"k": "http://www.opengis.net/kml/2.2"}
DESTINATION = Path(__file__).resolve().parents[1] / ".github/extensions/col-collector/data/catalogue.json"
DISPLAY_NAMES = {"pass-965d3e148f028ea0": "Mortirolo"}


def number(value):
    if value is None:
        return None
    try:
        result = float(value)
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def parse_catalogue(xml):
    root = ET.fromstring(xml)
    passes, seen, warnings, counts, references = [], set(), [], {}, {}
    for folder in root.findall(".//k:Folder", NS):
        layer = folder.findtext("k:name", namespaces=NS)
        if layer not in LAYERS:
            continue
        if layer in counts:
            raise ValueError(f"Duplicate source layer: {layer}")
        counts[layer] = 0
        for item in folder.findall("k:Placemark", NS):
            name = item.findtext("k:name", namespaces=NS)
            point = item.findtext("k:Point/k:coordinates", namespaces=NS)
            if not name or not point:
                raise ValueError(f"Missing name or point in {layer}: {name}")
            coords = [float(part) for part in point.strip().split(",")]
            lon, lat = coords[:2]
            if not all(math.isfinite(x) for x in (lon, lat)) or not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError(f"Invalid coordinates: {name}")
            fields = {
                field.attrib["name"]: field.findtext("k:value", namespaces=NS)
                for field in item.findall("k:ExtendedData/k:Data", NS)
            }
            # Identity does not depend on layer order or rounded display coordinates.
            centcols = fields.get("CentCols")
            identity = f"{name}|{lon:.6f}|{lat:.6f}"
            pass_id = "pass-" + hashlib.sha256(identity.encode()).hexdigest()[:16]
            if pass_id in seen:
                raise ValueError(f"Duplicate identity, needs manual review: {name}")
            seen.add(pass_id)
            if centcols:
                if centcols in references:
                    warnings.append(f"Shared CentCols reference {centcols}: {references[centcols]} / {name}; kept as distinct mapped points")
                references[centcols] = name
            elevation = number(fields.get("altitude"))
            if elevation is None:
                warnings.append(f"Missing numeric elevation: {name}")
            elif (LAYERS[layer] == "high" and elevation <= 2000) or (LAYERS[layer] == "low" and elevation >= 2000):
                warnings.append(f"Source-layer boundary exception: {name} ({elevation:g} m, {layer})")
            link = fields.get("presentation") or None
            if link and not re.match(r"^https?://", link):
                warnings.append(f"Unsupported source URL omitted: {name}")
                link = None
            passes.append({
                "id": pass_id,
                "name": name,
                **({"displayName": DISPLAY_NAMES[pass_id]} if pass_id in DISPLAY_NAMES else {}),
                "latitude": lat,
                "longitude": lon,
                "elevation": elevation,
                "group": LAYERS[layer],
                "sourceLayer": layer,
                "sourceUrl": link,
                "sourceClimbMetres": number(fields.get("climb (m)")),
                "centCols": centcols,
            })
            counts[layer] += 1
    if set(counts) != set(LAYERS) or any(count == 0 for count in counts.values()):
        raise ValueError("Both non-empty paved layers are required; refusing partial import.")
    return {
        "version": 1,
        "source": SOURCE,
        "sourceName": "Alps +1000m climbs +more / cycloclimbing.com",
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "counts": counts,
        "warnings": warnings,
        "passes": sorted(passes, key=lambda p: (-(p["elevation"] or 0), p["name"])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Read a previously downloaded KML instead.")
    args = parser.parse_args()
    if args.input:
        xml = args.input.read_bytes()
    else:
        with urllib.request.urlopen(EXPORT, timeout=30) as response:
            xml = response.read()
    catalogue = parse_catalogue(xml)
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"counts": catalogue["counts"], "warnings": catalogue["warnings"]}, indent=2))


if __name__ == "__main__":
    main()
