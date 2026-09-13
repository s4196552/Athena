"""Video and audio extractors.

PyAV is preferred over shelling out to the `ffmpeg` binary, for two reasons
specific to this application. First, it takes a file-like object, so the
decoder never receives a path it could write to -- `ffmpeg` given an output
template has a long history of dropping files next to their input. Second, a
subprocess per file is roughly 30ms of process spawn on Windows; across 20,000
videos that alone is ten minutes of pure overhead.

Video keyframing deliberately samples at fixed percentages of the duration
rather than decoding for scene changes. Scene detection is far better for a
contact sheet, but it means decoding the whole stream; percentile seeks touch
four keyframes. For an indexer whose job is to make a video *findable*, four
frames spread across it is the right trade.
"""

from __future__ import annotations

import contextlib
from typing import ClassVar

from ..core.facets import Facets
from ..core.safety import open_ro, reader_for
from .base import BaseExtractor, ExtractContext, Tier, register


@register
class VideoProbe(BaseExtractor):
    """Container, streams, duration, dimensions, rotation, capture time."""

    name: ClassVar[str] = "video.probe"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"video"})
    requires: ClassVar[tuple[str, ...]] = ("av",)

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import av

        # Streaming from the read-only handle rather than buffering the file:
        # a 4 GB video must not become 4 GB of RSS in a worker.
        with open_ro(ctx.path) as fh, av.open(fh, metadata_errors="ignore") as container:
            video = next((s for s in container.streams if s.type == "video"), None)
            audio = next((s for s in container.streams if s.type == "audio"), None)
            meta = {**container.metadata, **(video.metadata if video else {})}

            duration = (
                float(container.duration) / av.time_base if container.duration else None
            )
            rotation = _rotation(meta)
            width = video.codec_context.width if video else None
            height = video.codec_context.height if video else None
            # Phone video stores portrait as landscape plus a rotation matrix.
            # Reporting the stored dimensions would put every phone clip in the
            # wrong aspect bucket and crop every thumbnail incorrectly.
            if rotation in (90, 270) and width and height:
                width, height = height, width

            out.add(
                "video_meta",
                width=width,
                height=height,
                duration_s=round(duration, 3) if duration else None,
                fps=round(float(video.average_rate), 4)
                if video and video.average_rate else None,
                video_codec=video.codec_context.name if video else None,
                audio_codec=audio.codec_context.name if audio else None,
                bitrate=container.bit_rate or None,
                rotation=rotation,
                has_audio=int(audio is not None),
                stream_count=len(container.streams),
                container=container.format.name,
                captured_at=_quicktime_time(meta),
            )

            if video:
                out.tag("keyword", _resolution_label(width, height), self.source_id)

            # QuickTime location: "+37.7749-122.4194+010.000/"
            if loc := (meta.get("location") or meta.get("com.apple.quicktime.location.ISO6709")):
                if coords := _iso6709(str(loc)):
                    from .images import geohash

                    lat, lon = coords
                    out.add("geo", lat=lat, lon=lon, source="quicktime",
                            geohash=geohash(lat, lon))


@register
class VideoThumb(BaseExtractor):
    """Poster frame plus a colour palette sampled from it.

    Seeking to 10% of the duration rather than frame zero: the first frame of a
    real video is very often black, a fade-in, or a slate, which would make an
    entire library of grey tiles.
    """

    name: ClassVar[str] = "video.thumb"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"video"})
    requires: ClassVar[tuple[str, ...]] = ("av", "PIL")

    SIZE: ClassVar[int] = 512
    SEEK_FRACTION: ClassVar[float] = 0.10

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import av

        from .images import ImageColor, color_bucket, dhash, rgb_to_lab

        with open_ro(ctx.path) as fh, av.open(fh, metadata_errors="ignore") as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                raise NotImplementedError("no video stream")
            stream.thread_type = "AUTO"

            offset_us = 0
            if container.duration:
                offset_us = int(container.duration * self.SEEK_FRACTION)
                with contextlib.suppress(av.AVError):
                    container.seek(offset_us, stream=stream)

            frame = next(container.decode(stream), None)
            if frame is None:
                raise ValueError("no decodable frame")
            image = frame.to_image().convert("RGB")

        out.add("perceptual_hash", algo="vhash64", hash=dhash(image))

        palette = image.copy()
        palette.thumbnail((ImageColor.SAMPLE_PX, ImageColor.SAMPLE_PX))
        quantised = palette.quantize(colors=ImageColor.PALETTE_SIZE, method=2)
        entries = sorted(quantised.getcolors() or [], reverse=True)[: ImageColor.KEEP]
        table = quantised.getpalette() or []
        total = sum(c for c, _ in entries) or 1
        for rank, (count, index) in enumerate(entries):
            r, g, b = table[index * 3 : index * 3 + 3]
            L, a, bb = rgb_to_lab(r, g, b)
            out.add(
                "color", rank=rank, hex=f"#{r:02x}{g:02x}{b:02x}", r=r, g=g, b=b,
                lab_l=round(L, 2), lab_a=round(a, 2), lab_b=round(bb, 2),
                proportion=round(count / total, 4), bucket=color_bucket(L, a, bb),
            )

        key = ctx.shared.get("cache_key")
        if not key:
            return
        image.thumbnail((self.SIZE, self.SIZE))
        dest = ctx.cache_dir / str(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        image.save(dest, "WEBP", quality=82, method=4)
        out.add(
            "thumbnail", kind="grid", width=image.width, height=image.height,
            fmt="webp", cache_key=str(key), t_ms=offset_us // 1000,
            bytes=dest.stat().st_size,
        )


@register
class AudioTags(BaseExtractor):
    """ID3 / Vorbis / RIFF tags and stream properties.

    Mutagen is a read/write library, and its `save()` will rewrite tag frames in
    place. It is only ever constructed here from an in-memory buffer, which
    leaves no path for that to reach the original file even by mistake.
    """

    name: ClassVar[str] = "audio.tags"
    version: ClassVar[int] = 1
    tier: ClassVar[int] = Tier.CHEAP
    media_types: ClassVar[frozenset[str]] = frozenset({"audio"})
    requires: ClassVar[tuple[str, ...]] = ("mutagen",)
    max_bytes: ClassVar[int] = 512 * 1024 * 1024

    LOSSLESS: ClassVar[frozenset[str]] = frozenset({"flac", "wav", "aiff", "alac", "ape"})

    def run(self, ctx: ExtractContext, out: Facets) -> None:
        import mutagen

        audio = mutagen.File(reader_for(ctx.path), easy=True)
        if audio is None:
            raise ValueError("mutagen could not identify the stream")

        info = audio.info
        codec = type(audio).__name__.lower()
        out.add(
            "audio_meta",
            duration_s=round(float(getattr(info, "length", 0)), 3) or None,
            sample_rate=getattr(info, "sample_rate", None),
            channels=getattr(info, "channels", None),
            bit_depth=getattr(info, "bits_per_sample", None),
            bitrate=getattr(info, "bitrate", None),
            codec=codec,
            lossless=int(any(fmt in codec for fmt in self.LOSSLESS)),
            title=_first(audio, "title"),
            artist=_first(audio, "artist"),
            album=_first(audio, "album"),
            album_artist=_first(audio, "albumartist"),
            track_no=_number(_first(audio, "tracknumber")),
            disc_no=_number(_first(audio, "discnumber")),
            year=_number((_first(audio, "date") or "")[:4]),
            genre=_first(audio, "genre"),
            has_cover_art=int(bool(getattr(audio, "pictures", None))),
        )

        for field, kind in (("genre", "genre"), ("artist", "entity"), ("album", "entity")):
            if value := _first(audio, field):
                out.tag(kind, value, self.source_id)

        # Lyrics and comments are real search targets -- people look for the
        # song whose chorus they half-remember.
        for field in ("lyrics", "comment"):
            if value := _first(audio, field):
                out.text("id3", value)


def _first(audio, key: str) -> str | None:
    try:
        values = audio.get(key)
    except Exception:  # noqa: BLE001
        return None
    if not values:
        return None
    value = values[0] if isinstance(values, list) else values
    text = str(value).strip()
    return text[:500] or None


def _number(value: str | None) -> int | None:
    if not value:
        return None
    digits = "".join(c for c in str(value).split("/")[0] if c.isdigit())
    return int(digits) if digits else None


def _rotation(meta: dict) -> int:
    for key in ("rotate", "rotation"):
        if key in meta:
            with contextlib.suppress(ValueError, TypeError):
                return int(float(meta[key])) % 360
    return 0


def _quicktime_time(meta: dict) -> int | None:
    from datetime import datetime, timezone

    for key in ("creation_time", "com.apple.quicktime.creationdate", "date"):
        raw = meta.get(key)
        if not raw:
            continue
        text = str(raw).replace("Z", "+00:00")
        with contextlib.suppress(ValueError):
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
    return None


def _iso6709(value: str) -> tuple[float, float] | None:
    """Parse '+37.7749-122.4194+010.000/' into (lat, lon)."""
    numbers: list[str] = []
    current = ""
    for ch in value:
        if ch in "+-":
            if current:
                numbers.append(current)
            current = ch
        elif ch.isdigit() or ch == ".":
            current += ch
        else:
            if current:
                numbers.append(current)
            current = ""
    if current:
        numbers.append(current)
    if len(numbers) < 2:
        return None
    try:
        lat, lon = float(numbers[0]), float(numbers[1])
    except ValueError:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def _resolution_label(width: int | None, height: int | None) -> str:
    if not width or not height:
        return "unknown resolution"
    shortest = min(width, height)
    for threshold, label in ((2000, "8k"), (1400, "4k"), (1000, "1440p"),
                             (700, "1080p"), (500, "720p"), (400, "480p")):
        if shortest >= threshold:
            return label
    return "low resolution"
