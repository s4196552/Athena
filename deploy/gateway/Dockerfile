# Small on purpose: this image holds a relay and an SDK, nothing else. None of
# Athena's parsing stack (Pillow, pypdf, python-docx, ffmpeg) belongs here --
# files are never uploaded to this service, only the text or downscaled JPEG
# the desktop app has already extracted locally.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

# Unbuffered so Railway's log view shows a request as it happens rather than
# when the buffer happens to flush.
ENV PYTHONUNBUFFERED=1

# Railway injects PORT; app.py reads it and falls back to 8080 locally.
EXPOSE 8080

# Not root. The container has no writable state worth protecting, but a relay
# holding an API key is the wrong place to make an exception.
RUN useradd --create-home --uid 10001 gateway
USER gateway

CMD ["python", "app.py"]
