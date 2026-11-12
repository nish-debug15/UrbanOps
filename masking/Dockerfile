# syntax=docker/dockerfile:1
# UrbanOps photo masking service (FastAPI + YOLO, CPU only)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    YOLO_CONFIG_DIR=/tmp/ultralytics \
    YOLO_AUTOINSTALL=false

# Shared libraries OpenCV needs on a slim image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# CPU-only PyTorch first, so the multi-gigabyte GPU build is never pulled in.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Model weights are baked into the image (no downloads at run time) and pinned by
# checksum, so a changed file upstream fails the build instead of being trusted.
#   face:  github.com/akanametov/yolo-face (GPL-3.0)
#   plate: huggingface.co/morsetechlab/yolov11-license-plate-detection (AGPL-3.0)
RUN mkdir -p /app/models
ADD --chmod=644 --checksum=sha256:9420a9d4933940d2202f511d45df1750e3c1546dd9efc7a3985caae3bbbf7ed2 \
    https://github.com/akanametov/yolo-face/releases/download/1.0.0/yolov11n-face.pt /app/models/face.pt
ADD --chmod=644 --checksum=sha256:0aec75976c56eb6f26dfb274c430620ec65137915ff1ae47c3a48c7af8afb7b2 \
    https://huggingface.co/morsetechlab/yolov11-license-plate-detection/resolve/main/license-plate-finetune-v1n.pt /app/models/plate.pt

COPY app.py smoke_test.py ./

RUN useradd --create-home masker
USER masker
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
