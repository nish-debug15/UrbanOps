"""
UrbanOps photo masking service (PRD: AI-based photo masking).

Finds faces and vehicle number plates in a report photo with two YOLO models and
makes them unreadable, so bystanders are not identifiable in photos other people see.

    POST /mask     body = the image bytes (JPEG, PNG or WebP)
                   200  the masked image, same format; X-Faces / X-Plates = regions hidden
                   204  nothing to hide (same headers, both 0)
                   400  not a readable image      413  too large
    GET  /health   {"status": "ok"}

The service keeps nothing: no photo is written to disk or logged. It is only called
by the Express API (services/masking.js), never by browsers.
"""

import hmac
import os
import threading

# Refuse to decode absurdly large images (decompression bombs). Must be set before cv2 loads.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(40_000_000))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import FastAPI, HTTPException, Request, Response  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from ultralytics import YOLO, settings  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FACE_MODEL = os.environ.get("FACE_MODEL", os.path.join(HERE, "models", "face.pt"))
PLATE_MODEL = os.environ.get("PLATE_MODEL", os.path.join(HERE, "models", "plate.pt"))

# Low thresholds on purpose: blurring something harmless costs little, missing a face does not.
FACE_CONF = float(os.environ.get("FACE_CONF", "0.25"))
PLATE_CONF = float(os.environ.get("PLATE_CONF", "0.25"))
# Inference size. Larger finds smaller (more distant) faces and plates, but is slower.
IMGSZ = int(os.environ.get("MASK_IMGSZ", "960"))
MAX_BYTES = int(float(os.environ.get("MAX_IMAGE_MB", "10")) * 1024 * 1024)
# Optional shared secret; set the same value as MASKING_TOKEN on the API.
TOKEN = os.environ.get("MASKING_TOKEN", "")

# Grow each detected box by this share of its size, so hairlines and plate edges are covered.
FACE_PAD = 0.15
PLATE_PAD = 0.10
# A hidden region keeps at most this many colour samples per side: nothing readable survives.
BLOCKS = 6

try:
    settings.update({"sync": False})  # no usage analytics
except Exception:  # pragma: no cover - settings are a convenience, not required
    pass

_face = YOLO(FACE_MODEL)
_plate = YOLO(PLATE_MODEL)
_lock = threading.Lock()  # the models are not safe to call from two threads at once

app = FastAPI(title="UrbanOps photo masking", docs_url=None, redoc_url=None, openapi_url=None)


class NotAnImage(ValueError):
    pass


def _format_of(data: bytes):
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg", "image/jpeg", [cv2.IMWRITE_JPEG_QUALITY, 90]
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png", "image/png", []
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp", [cv2.IMWRITE_WEBP_QUALITY, 90]
    return None


def _detect(model, image, conf):
    result = model.predict(image, conf=conf, imgsz=IMGSZ, device="cpu", verbose=False)[0]
    return [[int(v) for v in box] for box in result.boxes.xyxy.cpu().numpy().tolist()]


def hide(image, box, pad):
    """Replace one region with a coarse blur of itself, in place."""
    height, width = image.shape[:2]
    x1, y1, x2, y2 = box
    dx, dy = int((x2 - x1) * pad), int((y2 - y1) * pad)
    x1, y1 = max(0, x1 - dx), max(0, y1 - dy)
    x2, y2 = min(width, x2 + dx), min(height, y2 + dy)
    if x2 <= x1 or y2 <= y1:
        return
    region = image[y1:y2, x1:x2]
    coarse = cv2.resize(region, (min(BLOCKS, x2 - x1), min(BLOCKS, y2 - y1)), interpolation=cv2.INTER_AREA)
    image[y1:y2, x1:x2] = cv2.resize(coarse, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LINEAR)


def process(data: bytes):
    """
    Returns (masked_bytes or None, media_type, faces, plates).
    masked_bytes is None when nothing was found. Raises NotAnImage for unreadable input.
    """
    fmt = _format_of(data)
    if fmt is None:
        raise NotAnImage("Photos must be JPEG, PNG or WebP images")
    extension, media_type, params = fmt
    try:
        # IMREAD_COLOR also applies the EXIF rotation, so the output needs no metadata.
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error:
        image = None
    if image is None:
        raise NotAnImage("The image could not be read")

    with _lock:
        faces = _detect(_face, image, FACE_CONF)
        plates = _detect(_plate, image, PLATE_CONF)
    if not faces and not plates:
        return None, media_type, 0, 0

    for box in faces:
        hide(image, box, FACE_PAD)
    for box in plates:
        hide(image, box, PLATE_PAD)
    ok, encoded = cv2.imencode(extension, image, params)
    if not ok:
        raise RuntimeError("Could not encode the masked image")
    return encoded.tobytes(), media_type, len(faces), len(plates)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/mask")
async def mask(request: Request):
    if TOKEN:
        sent = request.headers.get("authorization", "")
        if not hmac.compare_digest(sent.encode(), f"Bearer {TOKEN}".encode()):
            raise HTTPException(status_code=401, detail="Invalid token")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BYTES:
            raise HTTPException(status_code=413, detail="Image too large")
        chunks.append(chunk)

    try:
        masked, media_type, faces, plates = await run_in_threadpool(process, b"".join(chunks))
    except NotAnImage as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    headers = {"X-Faces": str(faces), "X-Plates": str(plates), "Cache-Control": "no-store"}
    if masked is None:
        return Response(status_code=204, headers=headers)
    return Response(content=masked, media_type=media_type, headers=headers)
