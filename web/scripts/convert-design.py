"""Turn the Claude Design export (design/Pricing Lab.dc.html) into a React view (src/ui/View.tsx).

The export is a template: plain HTML with inline styles, {{ path }} placeholders, <sc-if> and
<sc-for>. This script translates it mechanically so the markup in the app is exactly the
markup that was designed. Re-run it after every new export:

    python scripts/convert-design.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "Pricing Lab.dc.html"
OUT = ROOT / "src" / "ui" / "View.tsx"

VOID = {"input", "br", "hr", "img", "meta", "link"}
TOKEN = re.compile(r"<!--.*?-->|</?[a-zA-Z][^>]*>|[^<]+", re.S)
ATTR = re.compile(r'([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?')
EXPR = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
RENAME = {"for": "htmlFor", "class": "className", "stroke-width": "strokeWidth", "text-anchor": "textAnchor",
          "font-size": "fontSize", "font-family": "fontFamily", "stroke-dasharray": "strokeDasharray",
          "stroke-linejoin": "strokeLinejoin", "stroke-linecap": "strokeLinecap"}
BOOLEAN = {"disabled", "checked"}
NUMERIC = {"tabIndex", "maxLength", "rows"}
DROP = {"hint-placeholder-count", "hint-placeholder-val", "hint-size"}


def ref(path: str, scope: list[str]) -> str:
    """{{ a.b }} -> a?.b for a loop variable, v.a?.b for a view-model value."""
    if path in ("true", "false"):
        return path
    head, *rest = path.split(".")
    base = head if head in scope else f"v.{head}"
    return base + "".join(f"?.{p}" for p in rest)


def interpolate(text: str, scope: list[str]) -> str:
    """A JS expression for text that may contain placeholders."""
    whole = EXPR.fullmatch(text.strip())
    if whole:
        return ref(whole.group(1), scope)
    parts, last = [], 0
    for m in EXPR.finditer(text):
        parts.append(text[last:m.start()].replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${"))
        parts.append("${" + ref(m.group(1), scope) + ' ?? ""}')
        last = m.end()
    parts.append(text[last:].replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${"))
    return "`" + "".join(parts) + "`"


def css_name(name: str) -> str:
    name = name.strip()
    if name.startswith("--"):
        return name
    if name.startswith("-"):
        name = name[1:]
        head, *rest = name.split("-")
        return head.capitalize() + "".join(p.capitalize() for p in rest)
    head, *rest = name.split("-")
    return head + "".join(p.capitalize() for p in rest)


def style(value: str, scope: list[str]) -> str:
    props = []
    for decl in value.split(";"):
        if ":" not in decl:
            continue
        name, val = decl.split(":", 1)
        val = val.strip()
        js = interpolate(val, scope) if EXPR.search(val) else json.dumps(val, ensure_ascii=False)
        props.append(f"{json.dumps(css_name(name))}: {js}")
    return "{{ " + ", ".join(props) + " }}"


def attrs(raw: str, scope: list[str]) -> str:
    out = []
    for name, value in ATTR.findall(raw):
        if name in DROP:
            continue
        value = value or ""
        jsx = RENAME.get(name, name)
        if name == "style":
            out.append(f"style={style(value, scope)}")
        elif jsx in BOOLEAN:
            out.append(f"{jsx}={{!!({interpolate(value, scope)})}}" if EXPR.search(value) else jsx)
        elif EXPR.search(value):
            out.append(f"{jsx}={{{interpolate(value, scope)}}}")
        elif jsx in NUMERIC:
            out.append(f"{jsx}={{{int(value)}}}")
        else:
            out.append(f"{jsx}={json.dumps(value, ensure_ascii=False)}")
    return (" " + " ".join(out)) if out else ""


def text_node(text: str, scope: list[str]) -> str:
    if not text.strip():
        return "" if "\n" in text else '{" "}'
    text = re.sub(r"\s+", " ", text)
    out, last = [], 0
    for m in EXPR.finditer(text):
        if m.start() > last:
            out.append("{" + json.dumps(text[last:m.start()], ensure_ascii=False) + "}")
        out.append("{" + ref(m.group(1), scope) + "}")
        last = m.end()
    if last < len(text):
        out.append("{" + json.dumps(text[last:], ensure_ascii=False) + "}")
    return "".join(out)


def convert(body: str) -> str:
    out: list[str] = []
    stack: list[tuple[str, str | None]] = []       # (tag, loop variable it introduced)
    scope: list[str] = []
    for tok in TOKEN.findall(body):
        if tok.startswith("<!--"):
            continue
        if tok.startswith("</"):
            tag = tok[2:-1].strip()
            open_tag, var = stack.pop()
            if open_tag != tag:
                sys.exit(f"Template is not well formed: </{tag}> closes <{open_tag}>")
            if tag == "sc-if":
                out.append("</>) : null}")
            elif tag == "sc-for":
                scope.remove(var)
                out.append("</Fragment>))}")
            else:
                out.append(f"</{tag}>")
        elif tok.startswith("<"):
            m = re.match(r"<([a-zA-Z][\w-]*)(.*?)/?>$", tok, re.S)
            tag, raw = m.group(1), m.group(2)
            found = dict(ATTR.findall(raw))
            if tag == "sc-if":
                out.append("{" + ref(EXPR.search(found["value"]).group(1), scope) + " ? (<>")
                stack.append((tag, None))
            elif tag == "sc-for":
                var = found["as"]
                idx = f"{var}Index"
                out.append("{(" + ref(EXPR.search(found["list"]).group(1), scope) + f" ?? []).map(({var}, {idx}) => (<Fragment key={{{idx}}}>")
                scope.append(var)
                stack.append((tag, var))
            elif tag in VOID:
                out.append(f"<{tag}{attrs(raw, scope)} />")
            else:
                out.append(f"<{tag}{attrs(raw, scope)}>")
                stack.append((tag, None))
        else:
            out.append(text_node(tok, scope))
    if stack:
        sys.exit(f"Template is not well formed: <{stack[-1][0]}> is never closed")
    return "".join(out)


def main() -> None:
    html = SRC.read_text(encoding="utf-8")
    template = html.split('<script type="text/x-dc"')[0]
    body = template[template.index("</helmet>") + len("</helmet>"):template.rindex("</x-dc>")]
    jsx = convert(body)
    OUT.write_text(
        "// @ts-nocheck\n"
        "/* GENERATED by scripts/convert-design.py from design/Pricing Lab.dc.html. Do not edit by hand:\n"
        "   change the design, export it again, and re-run the script. */\n"
        'import { Fragment } from "react";\n\n'
        "export default function View({ v }) {\n  return (<>" + jsx + "</>);\n}\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({len(jsx):,} characters)")


if __name__ == "__main__":
    main()
