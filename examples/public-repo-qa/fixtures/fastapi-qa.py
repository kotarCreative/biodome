import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

input_data = json.loads(os.environ.get("BIODOME_ACTION_INPUT", "{}"))
output = pathlib.Path(json.loads(os.environ["BIODOME_ACTION_OUTPUTS"])[0])
checks = []
status = "running"


def emit(report):
    print("BIODOME_EVENT " + json.dumps(report), flush=True)


def save():
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"status": status, "checks": checks}, indent=2))


def check(name, passed):
    checks.append({"name": name, "status": "passed" if passed else "failed"})
    emit({"type": "check", "name": name, "status": checks[-1]["status"], "message": name})
    save()
    if not passed:
        raise AssertionError(name)


def request(path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request("http://localhost:8000" + path, data=body, headers={"Content-Type": "application/json"})
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    return response.status, json.loads(response.read())


try:
    save()
    emit({"type": "progress", "message": "Checking the pinned FastAPI request-body tutorial"})
    code, body = request("/openapi.json")
    check("OpenAPI describes the items endpoint", code == 200 and "/items/" in body["paths"])
    code, body = request("/items/", {"name": "Milk", "price": 2.5})
    check("Valid request round trips", code == 200 and body["name"] == "Milk" and body["price"] == 2.5)
    code, body = request("/items/", {"name": "Milk"})
    check("Missing price is rejected", code == 422 and any(item["loc"][-1] == "price" for item in body["detail"]))
    code, body = request("/items/", {"name": "Milk", "price": "invalid"})
    check("Invalid price type is rejected", code == 422)
    code, body = request("/items/", {"name": "Milk", "price": "2.50"})
    check("Numeric price string is coerced", code == 200 and body["price"] == 2.5)
    if input_data.get("forceFailure"):
        check("Intentional negative control (not an upstream defect)", False)
    status = "passed"
except Exception as error:
    status = "failed"
    emit({"type": "progress", "message": str(error)})
finally:
    save()
    emit({"type": "artifact", "message": "API QA evidence written", "path": str(output)})
if status != "passed":
    sys.exit(7)
