# Demo video voiceover

Ready-to-record narration for the ≤5-minute demo video. Generated from
[`../VIDEO_SCRIPT.md`](../VIDEO_SCRIPT.md); play each clip while showing the
matching on-screen section (clips have ~no leading silence, so leave 1–2
seconds of screen before speaking).

| File | Video section | Approx. on-screen window |
| --- | --- | --- |
| `01-intro.mp3` | Problem + who it is for | 0:00–0:35 |
| `02-trust-model.mp3` | Signed mandate + tool design | 0:35–1:05 |
| `03-cycle-one.mp3` | Cycle 1: 1 decision, 2 blocks, injection | 1:05–2:20 |
| `04-approval-and-capture.mp3` | Human moment 1 + sweep capture | 2:20–2:55 |
| `05-short-delivery.mp3` | Short delivery, 403 refusal, human refund | 2:55–3:55 |
| `06-audit.mp3` | Hash chain + signed checkpoints | 3:55–4:20 |
| `07-close.mp3` | Closing | 4:20–4:30 |

`steward-voiceover-full.mp3` is all seven clips concatenated in order (~1 MB),
for a single-track screen recording. It is a frame-level concat of the
constant-encoder clips; re-export through any editor to get smooth joins and
pauses between sections.

## Recording workflow

1. Start screen capture at the repo root.
2. Run `npm run demo`; the total run takes ~20 seconds, so pre-run it and
   restart for clean takes, or record section by section using the timings in
   `VIDEO_SCRIPT.md` (the demo is deterministic).
3. Mute the terminal (it prints no sound); play the matching clip per section,
   or lay `steward-voiceover-full.mp3` on the timeline and cut screen to match.
4. Title/description must mention **Agents for Humans** (builder.aws bonus
   rule also applies to blog post titles).
