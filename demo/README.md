# Captioned local walkthrough

`commitbook-walkthrough.mp4` is a 140-second walkthrough composed from actual
browser captures. It has burned-in captions and no audio. It is not a continuous
screen recording. It demonstrates the recorded local workflow and preserves
public Reactive execution as pending.

## Build

The builder uses Python's standard library, installed `ffmpeg` and `ffprobe`, and
DejaVu Sans regular and bold fonts. It requires all eight actual JPEG captures.
It does not generate substitute application screens or transaction hashes.

```bash
python3 scripts/build-walkthrough.py /workspace/shared/commitbook-video
```

An optional second positional argument selects the output file.

```bash
python3 scripts/build-walkthrough.py /path/to/browser-captures demo/commitbook-walkthrough.mp4
```

The default output is `demo/commitbook-walkthrough.mp4`, accompanied by
`demo/commitbook-walkthrough.metadata.json`. A successful rebuild atomically
replaces each previous output file. A failed render leaves the previous video
unchanged.

## Required captures and claims

| Capture | Required visible state | Seconds |
| --- | --- | ---: |
| `01-overview.jpg` | CommitBook's recorded local workflow overview | 17 |
| `02-plan.jpg` | The first actual Qwen proposal and its reviewable terms | 18 |
| `03-reserved.jpg` | Coordinator reserves 60 before grant delivery, 0 spent and 40 available | 17 |
| `04-blocked.jpg` | Runtime capacity recheck blocks the competing 60-unit proposal | 17 |
| `05-cancelled.jpg` | Closure receipt dropped, late grant rejected, 60 still reserved | 18 |
| `06-recovered.jpg` | Closure finalized after receipt recovery, 0 reserved and 100 available | 18 |
| `07-paid.jpg` | Replacement paid 55, repeated execution pays zero, 45 available | 18 |
| `08-submission.jpg` | Public AI proposal prepared, public execution awaiting testnet funding | 17 |

Capture each frame from the actual application or its evidence review. The
builder copies the input bytes before rendering, records their SHA-256 hashes,
and requires JPEG images of at least 800 by 450 pixels. A hash identifies a frame;
it does not establish the frame's provenance. Review the captures and captions
against the underlying evidence before sharing the result.

The 60-unit original reservation and 55-unit replacement belong to the local
recovery demonstration. Public deployment and the AI-linked public purchase have
separate evidence. This walkthrough must not be presented as proof that Reactive
Network has executed public transactions or callbacks.

## Render and verification

The output uses a 1920 by 1080 navy and teal layout at 12 frames per second. The
right panel fits the captured application without stretching or cropping it.
The left panel explains each state and its budget consequences.

The builder uses H.264 at CRF 28 with the still-image tuning preset. If the video
exceeds 8 MiB, it retries at CRF 31 and then 34. It rejects a result that still
exceeds the size target. All subprocesses use argument arrays. Captions are text
files with drawtext expansion disabled.

After concatenating the scenes, `ffprobe` checks the actual duration, dimensions,
frame rate and absence of audio. The adjacent metadata records those values,
video and frame hashes, encoding settings, caption claims and the explicit fields
`mode: "local-preview"` and `publicTestnetExecution: false`.

Inspect the rendered title, captions and application panel before using the
video. The closing scene intentionally says public execution is pending. After
the public loop succeeds, capture its actual transaction evidence and revise
the closing scene and metadata claims before producing a final submission video.
