"""Image extractors: EXIF, GPS, colour, perceptual hash, thumbnail, OCR."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, ClassVar

from ..core.facets import Facets
from ..core.safety import reader_for
from .base import BaseExtractor, ExtractContext, Tier, register

# Pillow's decompression-bomb guard is a security control, not a nuisance: an
# 8 KB PNG can declare a 60,000 x 60,000 canvas and allocate 10 GB on decode.
# We raise the ceiling to cover legitimate gigapixel panoramas and let the
# resulting exception mark those few files as errors rather than OOM a worker.
_MAX_PIXELS = 300_000_000


def _pillow():
    from PIL import Image, ImageFile

    Image.MAX_IMAGE_PIXELS = _MAX_PIXELS
    # Partially-downloaded photos are common in real libraries. Decoding what
    # exists beats refusing the file outright.
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    return Image


def _open(ctx: ExtractContext):
    """Open through an in-memory buffer -- Pillow never sees the real path."""
    cached = ctx.shared.get("pil_image")
    if cached is not None:
        return cached
    Image = _pillow()
    img = Image.open(reader_for(ctx.path))
    ctx.shared["pil_image"] = img
    return img


# ---------------------------------------------------------------------------
# EXIF, dimensions, GPS
# ---------------------------------------------------------------------------


@register
class ImageExif(BaseExtractor):
    """Dimensions, camera settings, capture time and GPS.

    EXIF is read and never written. Orientation in particular is recorded as a
    number and applied logically when rendering thumbnails -- the tempting fix
    of rotating the file so every viewer agrees is exactly the kind of
    "helpful" mutation this product promises never to make.
    """

    name: ClassVar[str] = "image.exif"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"image"})
    requires: ClassVar[tuple[str, ...]] = ("PIL",)

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        from PIL import ExifTags

        img = _open(ctx)
        width, height = img.size
        frames = getattr(img, "n_frames", 1)

        exif: dict[str, Any] = {}
        try:
            raw = img.getexif()
            if raw:
                exif = {ExifTags.TAGS.get(k, k): v for k, v in raw.items()}
                ifd = raw.get_ifd(0x8769)  # ExifIFD holds most of the good tags
                exif.update({ExifTags.TAGS.get(k, k): v for k, v in ifd.items()})
        except Exception:  # noqa: BLE001 - a broken EXIF block costs EXIF only
            exif = {}

        out.add(
            "image_meta",
            width=width,
            height=height,
            megapixels=round(width * height / 1_000_000, 3),
            orientation=_as_int(exif.get("Orientation")) or 1,
            has_alpha=int(img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info),
            is_animated=int(bool(getattr(img, "is_animated", False))),
            frame_count=frames,
            color_space=img.mode,
            bit_depth=_bit_depth(img.mode),
            camera_make=_as_text(exif.get("Make")),
            camera_model=_as_text(exif.get("Model")),
            lens_model=_as_text(exif.get("LensModel")),
            iso=_as_int(exif.get("ISOSpeedRatings")),
            f_number=_as_float(exif.get("FNumber")),
            exposure_s=_as_float(exif.get("ExposureTime")),
            focal_length=_as_float(exif.get("FocalLength")),
            flash=_as_int(exif.get("Flash")),
            captured_at=_exif_datetime(exif),
        )

        if make := _as_text(exif.get("Make")):
            model = _as_text(exif.get("Model")) or ""
            out.tag("camera", f"{make} {model}".strip(), self.source_id)

        self._gps(img, out)

    def _gps(self, img, out: Facets) -> None:
        try:
            gps = img.getexif().get_ifd(0x8825)
        except Exception:  # noqa: BLE001
            return
        if not gps:
            return

        lat = _dms(gps.get(2), gps.get(1))
        lon = _dms(gps.get(4), gps.get(3))
        if lat is None or lon is None:
            return
        # A GPS block that reads exactly 0,0 is almost always a camera that
        # wrote the field without a fix, not a photo taken in the Atlantic.
        if abs(lat) < 1e-7 and abs(lon) < 1e-7:
            return

        out.add(
            "geo",
            lat=lat,
            lon=lon,
            altitude_m=_as_float(gps.get(6)),
            source="exif",
            geohash=geohash(lat, lon),
        )


# ---------------------------------------------------------------------------
# Dominant colour
# ---------------------------------------------------------------------------


@register
class ImageColor(BaseExtractor):
    """Dominant palette, stored as both exact Lab and a coarse filter bucket.

    Clustering happens in CIELAB rather than RGB. In RGB, two greens a user
    would never confuse can be numerically closer than a green and a grey, so
    RGB k-means reliably produces palettes that look wrong to the person
    looking at the photo. Lab is near-perceptually-uniform, so distance in it
    means roughly what the eye means.

    The image is downscaled to 128px first. Beyond that, extra pixels change
    the resulting palette by less than the quantisation step, and the cost is
    linear in pixels -- this is the difference between 4ms and 400ms per photo.
    """

    name: ClassVar[str] = "image.color"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"image"})
    requires: ClassVar[tuple[str, ...]] = ("PIL",)

    SAMPLE_PX: ClassVar[int] = 128
    PALETTE_SIZE: ClassVar[int] = 8
    KEEP: ClassVar[int] = 5

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        img = _open(ctx).copy()
        if getattr(img, "is_animated", False):
            img.seek(0)
        img = img.convert("RGB")
        img.thumbnail((self.SAMPLE_PX, self.SAMPLE_PX))

        quantised = img.quantize(colors=self.PALETTE_SIZE, method=2)  # 2 = MEDIANCUT
        palette = quantised.getpalette() or []
        counts = sorted(quantised.getcolors() or [], reverse=True)
        total = sum(c for c, _ in counts) or 1

        seen: set[str] = set()
        rank = 0
        for count, index in counts:
            if rank >= self.KEEP:
                break
            r, g, b = palette[index * 3 : index * 3 + 3]
            hex_code = f"#{r:02x}{g:02x}{b:02x}"
            if hex_code in seen:
                continue
            seen.add(hex_code)

            L, a, bb = rgb_to_lab(r, g, b)
            bucket = color_bucket(L, a, bb)
            proportion = count / total

            out.add(
                "color",
                rank=rank,
                hex=hex_code,
                r=r, g=g, b=b,
                lab_l=round(L, 2), lab_a=round(a, 2), lab_b=round(bb, 2),
                proportion=round(proportion, 4),
                bucket=bucket,
            )
            # Only genuinely dominant colours become searchable tags; otherwise
            # every photograph ends up tagged with every colour.
            if proportion >= 0.15:
                out.tag("keyword", bucket, self.source_id, confidence=proportion)
            rank += 1


# ---------------------------------------------------------------------------
# Perceptual hash + thumbnail
# ---------------------------------------------------------------------------


@register
class ImageThumb(BaseExtractor):
    """Grid thumbnail and a difference hash for near-duplicate grouping.

    Thumbnails are written content-addressed into the app cache directory --
    two levels of hex fan-out, because a single flat directory with 100k
    entries is pathological on NTFS and unpleasant everywhere else.
    """

    name: ClassVar[str] = "image.thumb"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"image"})
    requires: ClassVar[tuple[str, ...]] = ("PIL",)

    SIZE: ClassVar[int] = 512

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        from PIL import ImageOps

        img = _open(ctx).copy()
        if getattr(img, "is_animated", False):
            img.seek(0)
        # Honour EXIF orientation in the *thumbnail*, leaving the file alone.
        img = ImageOps.exif_transpose(img).convert("RGB")

        out.add("perceptual_hash", algo="dhash64", hash=dhash(img))

        img.thumbnail((self.SIZE, self.SIZE))
        key = ctx.shared.get("cache_key")
        if not key:
            return
        dest = ctx.cache_dir / str(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, "WEBP", quality=82, method=4)

        out.add(
            "thumbnail",
            kind="grid",
            width=img.width,
            height=img.height,
            fmt="webp",
            cache_key=str(key),
            bytes=dest.stat().st_size,
        )


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------


@register
class ImageOcr(BaseExtractor):
    """Text in photographs: signs, screenshots, whiteboards, receipts.

    RapidOCR is used rather than Tesseract. It ships as a pip wheel with ONNX
    weights bundled, so there is no system binary to install and no PATH to get
    wrong on Windows -- which for a desktop app is worth more than a marginal
    accuracy difference on clean scans, and it is in fact more accurate on the
    messy, angled, real-world photographs this extractor actually sees.
    """

    name: ClassVar[str] = "image.ocr"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.ML
    media_types: ClassVar[frozenset[str]] = frozenset({"image"})
    requires: ClassVar[tuple[str, ...]] = ("rapidocr_onnxruntime",)
    max_bytes: ClassVar[int] = 64 * 1024 * 1024

    MIN_CONFIDENCE: ClassVar[float] = 0.5
    MAX_EDGE: ClassVar[int] = 1600

    _engine = None  # process-global; loading the models costs ~1.5s

    @classmethod
    def engine(cls):
        if cls._engine is None:
            from rapidocr_onnxruntime import RapidOCR

            cls._engine = RapidOCR()
        return cls._engine

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import numpy as np

        img = _open(ctx).copy().convert("RGB")
        if max(img.size) > self.MAX_EDGE:
            img.thumbnail((self.MAX_EDGE, self.MAX_EDGE))

        result, _elapsed = self.engine()(np.asarray(img))
        if not result:
            return

        lines = [
            (text.strip(), float(score))
            for _box, text, score in result
            if float(score) >= self.MIN_CONFIDENCE and text.strip()
        ]
        if not lines:
            return

        body = "\n".join(text for text, _ in lines)
        mean_conf = sum(score for _, score in lines) / len(lines)
        out.text("image_ocr", body, confidence=round(mean_conf, 3))


# ---------------------------------------------------------------------------
# Colour science and hashing helpers
# ---------------------------------------------------------------------------

_D65 = (95.047, 100.000, 108.883)


def rgb_to_lab(r: int, g: int, b: int) -> tuple[float, float, float]:
    """sRGB (0-255) -> CIELAB, D65. Standard two-step, kept dependency-free."""

    def linear(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    rl, gl, bl = linear(r), linear(g), linear(b)
    x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) * 100
    y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) * 100
    z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) * 100

    def f(t: float) -> float:
        t /= 1.0
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t) + (16 / 116)

    fx, fy, fz = f(x / _D65[0]), f(y / _D65[1]), f(z / _D65[2])
    return (116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)


#: Hue bands in **HSV** degrees, not LCh.
#:
#: Clustering happens in Lab because Lab distance matches perceived
#: difference. *Naming* happens in HSV because Lab's hue angle does not match
#: what people call things. The decisive case is CIELAB's well-known blue hue
#: shift: pure blue (0,0,255) sits at LCh hue 306 degrees and violet
#: (138,43,226) at 271, so in Lab the two are interleaved and no set of
#: boundaries can separate "blue" from "purple". In HSV they are 240 and 271 --
#: cleanly apart, and in the order a person expects.
#:
#: So: Lab for distance, HSV for names. Using one space for both is the mistake
#: that produces a "blue" filter chip full of purple photographs.
_HUE_BANDS: tuple[tuple[float, str], ...] = (
    (12, "red"), (42, "orange"), (72, "yellow"), (165, "green"),
    (200, "teal"), (258, "blue"), (310, "purple"), (345, "pink"), (360, "red"),
)

#: Neutral cutoff. Below this Lab chroma, hue is noise and the colour is a grey.
_NEUTRAL_CHROMA = 12.0


def color_bucket(L: float, a: float, b: float) -> str:
    """Collapse a Lab colour into one of the eleven filter-chip buckets."""
    chroma = math.hypot(a, b)
    if chroma < _NEUTRAL_CHROMA:
        if L < 22:
            return "black"
        if L > 85:
            return "white"
        return "gray"
    if L < 12:
        return "black"

    hue = _hsv_hue(*lab_to_rgb(L, a, b))

    # Brown is not a hue -- it is dark, muted orange. Without this override the
    # entire "orange" chip fills with wood, leather and coffee, and users
    # looking for an orange photograph never find one.
    if 12 <= hue < 55 and L < 60 and chroma < 60:
        return "brown"

    for limit, name in _HUE_BANDS:
        if hue < limit:
            # Pink is the same trick as brown in the other direction: pale,
            # muted red. By hue alone (255,192,203) is simply a light red, so
            # without this the pink chip is empty and the red chip is full of
            # blossom and skin tones.
            if name == "red" and L > 70 and chroma < 45:
                return "pink"
            return name
    return "red"


def _hsv_hue(r: float, g: float, b: float) -> float:
    """Hue angle in degrees from 0-255 RGB. 0 = red, 120 = green, 240 = blue."""
    r, g, b = r / 255.0, g / 255.0, b / 255.0
    hi, lo = max(r, g, b), min(r, g, b)
    span = hi - lo
    if span < 1e-9:
        return 0.0
    if hi == r:
        hue = 60 * (((g - b) / span) % 6)
    elif hi == g:
        hue = 60 * (((b - r) / span) + 2)
    else:
        hue = 60 * (((r - g) / span) + 4)
    return hue % 360


def lab_to_rgb(L: float, a: float, b: float) -> tuple[float, float, float]:
    """Inverse of `rgb_to_lab`, so naming can happen in HSV. D65, clamped."""
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200

    def finv(t: float) -> float:
        return t**3 if t**3 > 0.008856 else (t - 16 / 116) / 7.787

    x, y, z = finv(fx) * _D65[0], finv(fy) * _D65[1], finv(fz) * _D65[2]
    x, y, z = x / 100, y / 100, z / 100

    rl = x * 3.2406 + y * -1.5372 + z * -0.4986
    gl = x * -0.9689 + y * 1.8758 + z * 0.0415
    bl = x * 0.0557 + y * -0.2040 + z * 1.0570

    def gamma(c: float) -> float:
        c = max(0.0, min(1.0, c))
        c = 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
        return max(0.0, min(255.0, c * 255))

    return gamma(rl), gamma(gl), gamma(bl)


def dhash(img, size: int = 8) -> int:
    """64-bit difference hash: resize to 9x8 grey, compare horizontal pairs.

    Chosen over DCT-based pHash because it needs no numpy, is a few
    microseconds, and is more than sufficient for the job here -- grouping
    resizes, re-encodes and light crops of the same photo. Signed to fit
    SQLite's INTEGER, which is what the top-bit fold below is for.
    """
    small = img.convert("L").resize((size + 1, size))
    # tobytes() on an 8-bit greyscale image is the raw pixel run, which is both
    # faster than getdata() and free of its Pillow 14 deprecation.
    pixels = small.tobytes()
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = (bits << 1) | int(pixels[base + col] > pixels[base + col + 1])
    return bits - (1 << 64) if bits >= (1 << 63) else bits


_GEOHASH_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lon: float, precision: int = 9) -> str:
    """Standard geohash. Prefix length is proximity: cheap clustering in SQL."""
    lat_range, lon_range = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        rng, val = (lon_range, lon) if even else (lat_range, lat)
        mid = (rng[0] + rng[1]) / 2
        if val > mid:
            ch = (ch << 1) | 1
            rng[0] = mid
        else:
            ch <<= 1
            rng[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(_GEOHASH_B32[ch])
            bit, ch = 0, 0
    return "".join(out)


def _dms(value, ref) -> float | None:
    """EXIF degrees/minutes/seconds triple -> signed decimal degrees."""
    if not value:
        return None
    try:
        d, m, s = (float(x) for x in value)
    except (TypeError, ValueError):
        return None
    dec = d + m / 60 + s / 3600
    if ref and str(ref).upper().startswith(("S", "W")):
        dec = -dec
    return round(dec, 7)


def _exif_datetime(exif: dict[str, Any]) -> int | None:
    for key in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
        raw = exif.get(key)
        if not raw:
            continue
        try:
            dt = datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    text = str(value).strip().strip("\x00")
    return text or None


def _as_int(value: Any) -> int | None:
    try:
        if isinstance(value, (tuple, list)):
            value = value[0]
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        if isinstance(value, tuple) and len(value) == 2:
            return round(value[0] / value[1], 6) if value[1] else None
        return round(float(value), 6)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _bit_depth(mode: str) -> int:
    return {"1": 1, "L": 8, "P": 8, "RGB": 24, "RGBA": 32, "CMYK": 32,
            "I;16": 16, "I": 32, "F": 32}.get(mode, 8)
