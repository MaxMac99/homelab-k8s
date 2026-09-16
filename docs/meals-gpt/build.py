#!/usr/bin/env python3
"""Build a ChatGPT-Actions-compatible schema for the Meals API.

The app's own /openapi.json is OpenAPI 3.1, ~103 KB and anyOf-heavy — Custom
GPT Actions reject it (≈100k-char limit, 3.1 validator issues). This script
fetches the live spec, keeps the household-loop paths, downconverts to
OpenAPI 3.0.3 and prunes unreachable schemas, writing openapi-gpt.json.

Usage:
    python3 build.py                 # fetch from the default public URL
    python3 build.py [spec.json]     # transform a local copy instead

Re-run (and re-paste into the GPT builder) whenever the meals app updates.
Auth on the ChatGPT side is an API-key Bearer action using a meals_ token —
no /auth endpoints are exported on purpose.
"""

import json
import sys
import urllib.request

SOURCE_URL = "https://meals.mvissing.de/openapi.json"
OUT = "openapi-gpt.json"
SIZE_BUDGET = 60000  # chars; ChatGPT's action-schema limit is ~100k — stay well under

# The household loop, per docs/meals-gpt/instructions.md. No /auth (the GPT
# uses the action's Bearer key), no /billing, no admin paths, and no DELETE on
# shopping-list items (the API guidance is "exclude, never delete").
KEEP_PATHS = {
    "/recipes": {"get", "post"},
    "/recipes/ingest": {"post"},
    "/recipes/{recipe_id}": {"get", "patch", "delete"},
    "/recipes/{recipe_id}/reparse": {"post"},
    "/meals": {"get", "post"},
    "/meals/{meal_id}": {"get", "patch", "delete"},
    "/plans": {"get", "post"},
    "/plans/current": {"get"},
    "/plans/{plan_id}": {"get"},
    "/plans/{plan_id}/archive": {"post"},
    "/plans/{plan_id}/meals": {"post"},
    "/plans/{plan_id}/meals/{plan_meal_id}": {"delete"},
    "/plans/{plan_id}/meals/{plan_meal_id}/cooked": {"post", "delete"},
    "/shopping-list": {"get"},
    "/shopping-list/archive": {"post"},
    "/shopping-list/items": {"post"},
    "/shopping-list/items/{item_id}": {"patch"},
    "/supermarkets": {"get", "post"},
    "/supermarkets/{supermarket_id}": {"patch"},
    "/freezer": {"get", "post"},
    "/freezer/{item_id}": {"patch", "delete"},
    "/freezer/{item_id}/take": {"post"},
    "/ingredients": {"get"},
    "/ingredients/duplicates": {"get"},
    "/ingredients/{ingredient_id}": {"patch"},
    "/ingredients/{ingredient_id}/merge": {"post"},
    "/limits": {"get"},
}

NULLABLE_31_ONLY_KEYS = ("$anchor", "$dynamicRef", "$dynamicAnchor", "$schema")


def collect_refs(node, found):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str) and v.startswith("#/components/"):
                found.append(v.split("/")[-1])
            else:
                collect_refs(v, found)
    elif isinstance(node, list):
        for item in node:
            collect_refs(item, found)


def downconvert(node):
    """3.1 -> 3.0.3 in-place-ish: nullable type arrays, null-in-anyOf, const."""
    if isinstance(node, dict):
        for key in NULLABLE_31_ONLY_KEYS:
            node.pop(key, None)
        t = node.get("type")
        if isinstance(t, list):
            non_null = [x for x in t if x != "null"]
            node["type"] = non_null[0] if non_null else "string"
            if len(t) != len(non_null):
                node["nullable"] = True
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            nulls = [b for b in any_of if isinstance(b, dict) and b.get("type") == "null"]
            rest = [b for b in any_of if b not in nulls]
            if nulls:
                downconvert(rest)
                # nullable on $ref is illegal in 3.0 — keep anyOf for refs
                if len(rest) == 1 and "$ref" not in rest[0]:
                    merged = downconvert(rest[0])
                    node.pop("anyOf")
                    node.update(merged)
                    node["nullable"] = True
                else:
                    node["anyOf"] = rest
                    node["nullable"] = True
        if "const" in node:
            node["enum"] = [node.pop("const")]
        if isinstance(node.get("examples"), list) and "example" not in node:
            node["example"] = node["examples"][0]
            node.pop("examples")
        for v in node.values():
            downconvert(v)
    elif isinstance(node, list):
        for item in node:
            downconvert(item)
    return node


def trim_descriptions(node, inside_schema=False):
    """Cap long descriptions (FastAPI copies whole docstrings into field
    descriptions; the instructions.md carries the semantics, so anything over
    ~200 chars in a schema is dead weight for the GPT)."""
    if isinstance(node, dict):
        for key in ("description",):
            v = node.get(key)
            if isinstance(v, str) and len(v) > 200:
                node[key] = v[:197].rstrip() + "..."
        for v in node.values():
            trim_descriptions(v, inside_schema)
    elif isinstance(node, list):
        for item in node:
            trim_descriptions(item, inside_schema)


def main():
    if len(sys.argv) > 1:
        spec = json.load(open(sys.argv[1]))
    else:
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "meals-gpt-builder"})
        spec = json.load(urllib.request.urlopen(req, timeout=30))

    paths = {}
    for path, ops in spec["paths"].items():
        keep = KEEP_PATHS.get(path, set())
        wanted = {m: op for m, op in ops.items() if m in keep}
        if wanted:
            paths[path] = wanted

    missing = set(KEEP_PATHS) - set(paths)
    if missing:
        sys.exit(f"API no longer has expected paths: {sorted(missing)} — update KEEP_PATHS")

    out = {
        "openapi": "3.0.3",
        "info": {
            "title": "Meals",
            "description": "Meal planning and shopping for this household. "
            "Metric units only (g, kg, ml, l or natural-unit counts).",
            "version": "gpt-1",
        },
        "servers": [{"url": "https://meals.mvissing.de"}],
        "security": [{"HTTPBearer": []}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "HTTPBearer": {"type": "http", "scheme": "bearer"},
            },
            "schemas": {},
        },
    }

    # prune components.schemas to what kept paths can reach
    refs = []
    collect_refs(paths, refs)
    schemas = {}
    while refs:
        name = refs.pop()
        if name in schemas:
            continue
        sch = spec.get("components", {}).get("schemas", {}).get(name)
        if sch is None:
            continue
        schemas[name] = json.loads(json.dumps(sch))
        collect_refs(schemas[name], refs)
    out["components"]["schemas"] = schemas

    downconvert(out)
    trim_descriptions(out)

    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    for bad in ('"type": [', '"const"', '"$anchor"', '"type": "null"'):
        assert bad not in text, f"3.1 construct survived: {bad}"
    assert len(text) <= SIZE_BUDGET, f"schema {len(text)} chars over budget {SIZE_BUDGET}"

    open(OUT, "w").write(text + "\n")
    print(f"wrote {OUT}: {len(text)} chars, {sum(len(v) for v in paths.values())} operations, "
          f"{len(schemas)} schemas — fits ChatGPT actions")


if __name__ == "__main__":
    main()
