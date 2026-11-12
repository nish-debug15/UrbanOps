"""
End-to-end check of the masking service with the real models:

    python smoke_test.py

Uses a sample photo that ships with the ultralytics package (two people, faces
visible). Number plates have no bundled sample, so only the plate model's loading
and the "nothing found" path are covered for them here.
"""

import sys

import cv2
import numpy as np
from fastapi.testclient import TestClient
from ultralytics.utils import ASSETS

import app as service

client = TestClient(service.app)


def decode(data):
    return cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)


def main():
    assert client.get("/health").json() == {"status": "ok"}

    # 1. A photo with faces comes back changed, same size, with the faces counted.
    original = (ASSETS / "zidane.jpg").read_bytes()
    res = client.post("/mask", content=original)
    assert res.status_code == 200, res.text
    faces = int(res.headers["x-faces"])
    assert faces >= 2, f"expected both faces to be found, got {faces}"
    assert res.headers["content-type"] == "image/jpeg"
    before, after = decode(original), decode(res.content)
    assert before.shape == after.shape
    assert not np.array_equal(before, after)

    # 2. Masking the result again finds no face: they are really gone, not just softened.
    again = client.post("/mask", content=res.content)
    assert again.status_code == 204 or int(again.headers["x-faces"]) == 0, again.headers

    # 3. Nothing to hide: 204 and no body.
    ok, plain = cv2.imencode(".png", np.full((480, 640, 3), 127, dtype=np.uint8))
    assert ok
    res = client.post("/mask", content=plain.tobytes())
    assert res.status_code == 204, res.status_code
    assert (res.headers["x-faces"], res.headers["x-plates"]) == ("0", "0")

    # 4. Not an image, and a truncated image, are 400s rather than crashes.
    assert client.post("/mask", content=b"<script>alert(1)</script>").status_code == 400
    assert client.post("/mask", content=original[:200]).status_code == 400

    # 5. Too large is refused.
    too_big = b"\xff\xd8\xff" + b"0" * service.MAX_BYTES
    assert client.post("/mask", content=too_big).status_code == 413

    print(f"masking smoke test passed ({faces} faces hidden in the sample photo)")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as err:
        print(f"masking smoke test FAILED: {err}", file=sys.stderr)
        sys.exit(1)
