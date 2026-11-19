#!/usr/bin/env python3
"""Build a captioned local walkthrough from eight actual browser captures.

Python standard library only. Requires installed ffmpeg, ffprobe and DejaVu Sans.
The output is a composed walkthrough of captured stills, not a screen recording
and not evidence of public Reactive execution.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT, FPS = 1920, 1080, 12
TARGET_BYTES = 8 * 1024 * 1024
FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
BOLD_FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

SCENES = [
    {
        "file": "01-overview.jpg", "seconds": 17, "eyebrow": "THE SHARED BUDGET",
        "title": "One budget.\nAcross chains.",
        "body": "CommitBook counts pending commitments as well as completed payments. This recorded local run uses a 100-unit cap and valueless demo tokens.",
        "card_title": "A 100-unit spending cap",
        "card_body": "Spent + reserved must stay\nwithin the owner's budget.",
    },
    {
        "file": "02-plan.jpg", "seconds": 18, "eyebrow": "MODEL PROPOSAL",
        "title": "A model proposes.\nReview the terms.",
        "body": "Actual Qwen inference turns the purchase goal into a typed recommendation. Approved catalog terms and owner policy determine payment authority.",
        "card_title": "Qwen2.5 1.5B",
        "card_body": "Actual local inference.\nHuman review remains required.",
    },
    {
        "file": "03-reserved.jpg", "seconds": 17, "eyebrow": "CAPACITY RESERVED",
        "title": "Reserve 60.\nSpend nothing yet.",
        "body": "The coordinator reserves 60 units before the delayed grant reaches the vault. Available capacity falls to 40. The purchase counts before its supplier is paid.",
        "ledger": {"Reserved": "60", "Spent": "0", "Available": "40"},
    },
    {
        "file": "04-blocked.jpg", "seconds": 17, "eyebrow": "COMPETING REQUEST",
        "title": "The next 60\ncannot fit.",
        "body": "A second 60-unit request would require 120 units in combined capacity. The runtime rechecks live capacity and blocks the proposal because only 40 units remain.",
        "card_title": "60 + 60 = 120",
        "card_body": "Budget cap: 100.\nThe second request is blocked.",
    },
    {
        "file": "05-cancelled.jpg", "seconds": 18, "eyebrow": "DROPPED RECEIPT",
        "title": "A lost receipt\nkeeps funds held.",
        "body": "The first operation closes, but its receipt is dropped. A late grant cannot reopen the closed permit. Capacity stays reserved until closure is verified.",
        "ledger": {"Reserved": "60", "Spent": "0", "Available": "40"},
    },
    {
        "file": "06-recovered.jpg", "seconds": 18, "eyebrow": "FINALIZED CLOSURE",
        "title": "Verify closure.\nRelease the 60.",
        "body": "Recovering the receipt alone still holds the reservation. The local finalizer confirms zero consumption and finalized closure. Only then does capacity return.",
        "ledger": {"Reserved": "0", "Spent": "0", "Available": "100"},
    },
    {
        "file": "07-paid.jpg", "seconds": 18, "eyebrow": "REPLACEMENT PAYMENT",
        "title": "Pay 55 once.\nA retry pays zero.",
        "body": "The approved replacement pays 55 units on the local Unichain EVM. Repeating execution transfers nothing. The final budget has 45 units available.",
        "ledger": {"Reserved": "0", "Spent": "55", "Available": "45"},
    },
    {
        "file": "08-submission.jpg", "seconds": 17, "eyebrow": "PUBLIC READINESS",
        "title": "The public\nloop is next.",
        "body": "The public AI proposal is prepared. The isolated test wallet still needs funding for Base Sepolia and Lasna. Public on-chain proof remains pending.",
        "card_title": "Awaiting testnet funding",
        "card_body": "This local walkthrough does not\nprove public Reactive execution.",
    },
]


def run(arguments: list[str], *, capture: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(arguments, text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        detail = (result.stderr or "").strip()[-4000:]
        raise RuntimeError(f"{Path(arguments[0]).name} failed with exit {result.returncode}: {detail}")
    return result


def probe(file: Path) -> dict:
    return json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                           "-of", "json", str(file)]).stdout)


def sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def filter_value(value: str | Path) -> str:
    # Filter syntax is separate from shell syntax. subprocess always receives an
    # argument array; drawtext reads captions from files with expansion disabled.
    return "'" + str(value).replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:") + "'"


def caption_filter(work: Path, scene_number: int, label: str, text: str, *, x: int, y: int,
                   size: int, color: str = "0xe9f1f5", bold: bool = False, spacing: int = 8) -> str:
    text_file = work / f"caption-{scene_number:02d}-{label}.txt"
    text_file.write_text(text, encoding="utf-8")
    return (f"drawtext=fontfile={filter_value(BOLD_FONT if bold else FONT)}:"
            f"textfile={filter_value(text_file)}:expansion=none:x={x}:y={y}:"
            f"fontsize={size}:fontcolor={color}:line_spacing={spacing}")


def wrap(text: str, width: int = 29) -> str:
    return "\n".join(textwrap.wrap(text, width=width, break_long_words=False,
                                   break_on_hyphens=False))


def render_scene(work: Path, number: int, scene: dict, frame: Path, crf: int) -> Path:
    parts = [
        "drawbox=x=48:y=101:w=1824:h=2:color=0x244554:t=fill",
        "drawbox=x=558:y=134:w=1332:h=868:color=0x244554:t=2",
        "drawbox=x=48:y=819:w=464:h=181:color=0x102d3d:t=fill",
    ]
    add = lambda label, text, **kwargs: parts.append(caption_filter(work, number, label, text, **kwargs))
    add("brand", "COMMITBOOK", x=48, y=42, size=34, bold=True)
    add("mode", "CAPTIONED LOCAL WALKTHROUGH", x=1392, y=53, size=20, color="0x7fd8c5")
    add("scene", f"{number:02d} / {len(SCENES):02d}", x=48, y=143, size=22, color="0x94aebc")
    add("eyebrow", scene["eyebrow"], x=48, y=190, size=20, color="0x7fd8c5", bold=True)
    add("title", scene["title"], x=48, y=242, size=45, bold=True, spacing=12)
    add("body", wrap(scene["body"]), x=48, y=412, size=28, color="0xc0d2dc", spacing=11)
    if "ledger" in scene:
        add("ledger_heading", "100-unit cap", x=72, y=843, size=23, color="0x94aebc")
        for column, (label, value) in enumerate(scene["ledger"].items()):
            x = 72 + 144 * column
            add(f"ledger_label_{column}", label, x=x, y=892, size=21, color="0x94aebc")
            add(f"ledger_value_{column}", value, x=x, y=932, size=34, bold=True,
                color="0x7fd8c5" if label == "Available" else "0xe9f1f5")
    else:
        add("card_title", scene["card_title"], x=72, y=847, size=25, color="0x7fd8c5", bold=True)
        add("card_body", scene["card_body"], x=72, y=902, size=23, color="0xc0d2dc", spacing=10)
    add("footer", "Captured application stills. Local EVM evidence. Public Reactive execution is pending.",
        x=48, y=1034, size=21, color="0x94aebc")
    filter_graph = (
        "[1:v]scale=1328:864:force_original_aspect_ratio=decrease:flags=lanczos,"
        "pad=1328:864:(ow-iw)/2:(oh-ih)/2:color=0x0b2030,setsar=1[shot];"
        "[0:v][shot]overlay=x=560:y=136:shortest=1," + ",".join(parts) + "[out]"
    )
    destination = work / f"segment-{number:02d}.mp4"
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-filter_complex_threads", "1", "-f", "lavfi", "-i",
        f"color=c=0x071827:s={WIDTH}x{HEIGHT}:r={FPS}",
        "-loop", "1", "-framerate", str(FPS), "-i", str(frame),
        "-filter_complex", filter_graph, "-map", "[out]", "-an", "-t", str(scene["seconds"]),
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", str(crf),
        "-threads", "2", "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", "240",
        "-map_metadata", "-1", "-movflags", "+faststart", str(destination),
    ])
    return destination


def build(input_dir: Path, output: Path) -> dict:
    for executable in ("ffmpeg", "ffprobe"):
        if not shutil.which(executable):
            raise ValueError(f"Required executable is unavailable: {executable}")
    if not FONT.is_file() or not BOLD_FONT.is_file():
        raise ValueError("DejaVu Sans regular and bold fonts are required at /usr/share/fonts/truetype/dejavu")
    missing = [scene["file"] for scene in SCENES if not (input_dir / scene["file"]).is_file()]
    if missing:
        raise ValueError("Missing actual browser captures: " + ", ".join(missing))
    if output.suffix.lower() != ".mp4":
        raise ValueError("Output must have the .mp4 extension")
    output.parent.mkdir(parents=True, exist_ok=True)
    metadata_file = output.with_suffix(".metadata.json")
    with tempfile.TemporaryDirectory(prefix="commitbook-walkthrough-") as temporary:
        work = Path(temporary)
        frames = []
        frame_evidence = []
        # Freeze input bytes for this build so an overwritten browser capture
        # cannot change a later segment without changing the recorded frame hash.
        for number, scene in enumerate(SCENES, 1):
            source = input_dir / scene["file"]
            frame = work / f"frame-{number:02d}.jpg"
            shutil.copyfile(source, frame)
            streams = [stream for stream in probe(frame)["streams"] if stream["codec_type"] == "video"]
            if len(streams) != 1 or streams[0]["codec_name"] != "mjpeg":
                raise ValueError(f"Capture must be an actual JPEG image: {scene['file']}")
            stream = streams[0]
            if stream["width"] < 800 or stream["height"] < 450:
                raise ValueError(f"Capture is too small for a readable walkthrough: {scene['file']}")
            frames.append(frame)
            frame_evidence.append({
                "file": scene["file"], "sha256": sha256(frame), "width": stream["width"],
                "height": stream["height"], "durationSeconds": scene["seconds"],
                "title": scene["title"], "caption": scene["body"],
            })
        joined = work / "walkthrough.mp4"
        for crf in (28, 31, 34):
            for number, (scene, frame) in enumerate(zip(SCENES, frames), 1):
                render_scene(work, number, scene, frame, crf)
                print(f"Rendered scene {number}/{len(SCENES)} at CRF {crf}", flush=True)
            playlist = work / "segments.txt"
            playlist.write_text("".join(f"file 'segment-{number:02d}.mp4'\n" for number in range(1, len(SCENES) + 1)), encoding="utf-8")
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1",
                 "-i", str(playlist), "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart", str(joined)])
            if joined.stat().st_size <= TARGET_BYTES:
                break
        if joined.stat().st_size > TARGET_BYTES:
            raise ValueError("Video exceeds the 8 MiB delivery target even at CRF 34; existing output remains unchanged")
        details = probe(joined)
        videos = [stream for stream in details["streams"] if stream["codec_type"] == "video"]
        duration = float(details["format"]["duration"])
        expected_duration = sum(scene["seconds"] for scene in SCENES)
        if len(videos) != 1 or (videos[0]["width"], videos[0]["height"]) != (WIDTH, HEIGHT):
            raise ValueError("Rendered video has unexpected dimensions or streams")
        if any(stream["codec_type"] == "audio" for stream in details["streams"]):
            raise ValueError("Captioned walkthrough unexpectedly contains audio")
        if not 0 < duration < 180 or abs(duration - expected_duration) > 1 / FPS:
            raise ValueError(f"Unexpected video duration: {duration}")
        if videos[0]["avg_frame_rate"] != f"{FPS}/1":
            raise ValueError(f"Unexpected video frame rate: {videos[0]['avg_frame_rate']}")
        metadata = {
            "schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
            "mode": "local-preview", "publicTestnetExecution": False,
            "artifactType": "captioned walkthrough from captured application stills",
            "screenRecording": False, "audio": False, "videoFile": output.name,
            "videoSha256": sha256(joined), "videoBytes": joined.stat().st_size,
            "durationSeconds": duration, "dimensions": {"width": WIDTH, "height": HEIGHT},
            "frameRate": videos[0]["avg_frame_rate"], "codec": videos[0]["codec_name"],
            "encoding": {"crf": crf, "preset": "veryfast", "tune": "stillimage"},
            "ffmpegVersion": run(["ffmpeg", "-version"]).stdout.splitlines()[0],
            "sourceFrames": frame_evidence,
            "claims": {
                "localBudgetCap": 100, "initialReservation": 60,
                "competingRequest": 60, "replacementPayment": 55,
                "finalReserved": 0, "finalSpent": 55, "finalAvailable": 45,
                "duplicateExecutionTransfers": 0,
                "publicAiProposal": "prepared", "publicExecution": "awaiting testnet funding",
            },
            "limitations": [
                "The video composes captured browser stills; it is not continuous screen-recording evidence.",
                "The local workflow does not prove public Reactive transport or source-chain finality.",
                "The builder hashes supplied captures but does not attest to their provenance or validate caption claims.",
                "The closing scene explicitly preserves public execution as pending; replace it after verified public execution.",
            ],
        }
        staged_video = output.with_name(f".{output.name}.tmp")
        staged_metadata = metadata_file.with_name(f".{metadata_file.name}.tmp")
        try:
            shutil.copyfile(joined, staged_video)
            staged_metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            os.replace(staged_video, output)
            os.replace(staged_metadata, metadata_file)
        finally:
            staged_video.unlink(missing_ok=True)
            staged_metadata.unlink(missing_ok=True)
    return {"video": str(output), "metadata": str(metadata_file), "durationSeconds": duration,
            "bytes": metadata["videoBytes"], "sha256": metadata["videoSha256"],
            "mode": "local-preview", "publicTestnetExecution": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_dir", type=Path, help="Directory containing all eight named actual browser JPG captures")
    parser.add_argument("output_file", type=Path, nargs="?", default=ROOT / "demo/commitbook-walkthrough.mp4")
    arguments = parser.parse_args()
    try:
        result = build(arguments.input_dir.resolve(), arguments.output_file.resolve())
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"Walkthrough build failed: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
