"""A tiny, safe expression DSL. No `eval`: `ast.parse` + a hard node whitelist.

Inputs (event aggregates) are computed elsewhere and passed in as a name->number
binding. The expression only composes those numbers arithmetically plus a few
whitelisted functions. Anything outside the whitelist raises with the offending
position, so a bad formula fails validation instead of executing.
"""
from __future__ import annotations

import ast
from typing import Mapping


class DslError(ValueError):
    def __init__(self, msg: str, pos: int | None = None):
        super().__init__(msg if pos is None else f"{msg} (позиция {pos})")
        self.pos = pos


def _ratio(a, b):
    if a is None or b is None:
        return None
    return a / b if b else None  # divide-by-zero -> null, never a lie


_FUNCS = {
    "ratio": _ratio,
    "sum": lambda *xs: sum(x for x in xs if x is not None),
    "min": lambda *xs: min(x for x in xs if x is not None),
    "max": lambda *xs: max(x for x in xs if x is not None),
}

_ALLOWED_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div)


def _eval(node: ast.AST, env: Mapping[str, float]):
    if isinstance(node, ast.Expression):
        return _eval(node.body, env)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        raise DslError("разрешены только числовые литералы", getattr(node, "col_offset", None))
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise DslError(f"неизвестный вход '{node.id}'", node.col_offset)
        return env[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, _ALLOWED_BINOPS):
        a, b = _eval(node.left, env), _eval(node.right, env)
        if a is None or b is None:
            return None
        if isinstance(node.op, ast.Add):
            return a + b
        if isinstance(node.op, ast.Sub):
            return a - b
        if isinstance(node.op, ast.Mult):
            return a * b
        return a / b if b else None
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        v = _eval(node.operand, env)
        return None if v is None else -v
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise DslError("недопустимый вызов", node.col_offset)
        fname = node.func.id
        if node.keywords:
            raise DslError("именованные аргументы не поддерживаются", node.col_offset)
        if fname == "prev":
            # prev(alias): value of alias over the previous period (for honest deltas)
            if len(node.args) != 1 or not isinstance(node.args[0], ast.Name):
                raise DslError("prev(alias) ожидает один вход", node.col_offset)
            return env.get("__prev__", {}).get(node.args[0].id)
        if fname not in _FUNCS:
            raise DslError("вызов разрешён только для ratio/sum/min/max/prev", node.col_offset)
        args = [_eval(a, env) for a in node.args]
        return _FUNCS[fname](*args)
    raise DslError("недопустимый узел в выражении", getattr(node, "col_offset", None))


def evaluate(expression: str, env: Mapping[str, float], prev_env: Mapping[str, float] | None = None):
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        raise DslError(f"синтаксис: {e.msg}", e.offset) from e
    full = dict(env)
    full["__prev__"] = dict(prev_env or {})  # type: ignore[assignment]
    return _eval(tree, full)


def validate(expression: str, allowed_names: set[str]) -> str | None:
    """Return an error string if invalid, else None."""
    try:
        env = {n: 1.0 for n in allowed_names}
        evaluate(expression, env, prev_env=env)
        return None
    except DslError as e:
        return str(e)


# ---------------------------------------------------------------------------
# Logic-input kind/params validator
# ---------------------------------------------------------------------------

# All compute kinds this engine actually handles.
VALID_KINDS: frozenset[str] = frozenset({
    "unique",
    "count",
    "funnel",
    "retained",
    "mau",
    "median_gap_days",
    "logic",
})

# Required params per kind + expected Python type (or tuple of types as in isinstance).
# A missing key or wrong type is a 422, not a 500 inside _aggregate.
_KIND_REQUIRED: dict[str, dict[str, type | tuple[type, ...]]] = {
    "unique":          {"event": str},
    "count":           {"event": str},
    "funnel":          {"from": str, "to": str, "within_days": (int, float)},
    "retained":        {"base": str, "ret": str, "after_days": (int, float)},
    "mau":             {"days": (int, float)},
    "median_gap_days": {"from": str, "to": str},
    "logic":           {"ref": str},
}


def validate_inputs(inputs) -> str | None:
    """Validate a sequence of Input(-like) objects for kind and params shape.

    Returns an error string if invalid, else None.  Both the REST and MCP
    create_logic paths call this before persisting anything.
    """
    for inp in inputs:
        kind = inp.kind
        if kind not in VALID_KINDS:
            return f"unknown input kind '{kind}'; allowed: {', '.join(sorted(VALID_KINDS))}"
        required = _KIND_REQUIRED.get(kind, {})
        for key, expected_type in required.items():
            if key not in inp.params:
                return f"input kind '{kind}' is missing required param '{key}'"
            val = inp.params[key]
            if not isinstance(val, expected_type):
                type_name = expected_type.__name__ if isinstance(expected_type, type) else " or ".join(t.__name__ for t in expected_type)
                return f"input kind '{kind}' param '{key}' must be {type_name}, got {type(val).__name__}"
    return None
