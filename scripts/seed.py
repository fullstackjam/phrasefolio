"""Generate the initial D1 migration from the original UTF-8 export."""
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = (
    "id", "expression", "original_sentence", "meaning_zh", "usage_note",
    "example", "source", "added_date", "interval_days", "next_review",
    "ease", "review_count", "seen_count", "scene_zh",
)
NUMBERS = {
    "id": int, "interval_days": int, "ease": float,
    "review_count": int, "seen_count": int,
}


def literal(value):
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return str(value)


with (ROOT / "notebook.csv").open(encoding="utf-8-sig", newline="") as file:
    reader = csv.DictReader(file)
    if tuple(reader.fieldnames or ()) != COLUMNS:
        raise SystemExit("Unexpected CSV columns")
    rows = list(reader)

keys = [row["expression"].strip().lower() for row in rows]
if len(rows) != 422 or len(set(keys)) != len(rows) or not all(keys):
    raise SystemExit("Expected 422 distinct, nonempty expressions")
if len({int(row["id"]) for row in rows}) != len(rows):
    raise SystemExit("Duplicate IDs")

columns = ", ".join((*COLUMNS, "expression_key"))
lines = ["-- Generated from notebook.csv by scripts/seed.py."]
for row, key in zip(rows, keys):
    values = [NUMBERS.get(col, str)(row[col]) for col in COLUMNS]
    sql_values = ", ".join(map(literal, [*values, key]))
    lines.append(f"INSERT INTO entries ({columns}) VALUES ({sql_values});")

(ROOT / "migrations" / "0002_seed.sql").write_text(
    "\n".join(lines) + "\n", encoding="utf-8"
)
print(f"Generated {len(rows)} rows")
