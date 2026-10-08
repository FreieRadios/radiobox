#!/usr/bin/env python3
"""Post-production of a studiobox recording: remaster, transcript, Mediathek text.

Usage:
    post.py <name>.multitrack.json [options]

Reads the dry multitrack beside the channel map (and the `.ohne-musik.json`
sidecar when there is one), writes into `--out` (default `post/<name>/` next to
the recording):

    <Title> <date> – <subtitle>.mp3                       full version
    <Title> <date> – <subtitle> (ohne Musik, mit Jingles).mp3
    <Title> <date> – <subtitle> (nur Wort).mp3
    <Title> <date> – <subtitle> – Transkript.{md,txt,vtt}  times of the full version
    <Title> <date> – <subtitle> – Mediathek-Text.txt       (with --facts and a model)
    work/                                                  every step's result

Steps (``--steps``): decode talker music breath mix asr tokens fillers render
encode transcript summary. A step whose result is in `work/` is skipped
unless ``--force``. See README.md.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from postprod import SR, asr, breath, encode, fillers, mix, music, recording, render, summary, talker, transcript  # noqa: E402
from postprod.levels import FPS, FRAME  # noqa: E402
from postprod.timeline import Timeline  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OFF_AIR_SEC = 10.0
STEPS = ["decode", "talker", "music", "breath", "mix", "asr", "tokens", "fillers", "render", "encode", "transcript", "summary"]


class Log:
    def __init__(self, path):
        self.f = open(path, "a")

    def __call__(self, msg):
        line = f"{dt.datetime.now():%H:%M:%S} {msg}"
        print(line, flush=True)
        self.f.write(line + "\n")
        self.f.flush()


def parse_pairs(items, what):
    out = []
    for s in items or []:
        if "=" not in s:
            raise SystemExit(f"--{what} expects from=to, got {s!r}")
        a, b = s.split("=", 1)
        out.append((a.strip(), b.strip()))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("recording", help="<name>.multitrack.json")
    ap.add_argument("--out", help="output directory (default: post/<name>/ beside the recording)")
    ap.add_argument("--title", help="show title for file names and tags (default: the FLAC's TITLE tag)")
    ap.add_argument("--subtitle", default="", help="episode subtitle, e.g. the guests' project")
    ap.add_argument("--date", help="YYYY-MM-DD (default: from the recording's name)")
    ap.add_argument("--speaker", action="append", metavar="CHANNEL=NAME", help="person at a mic, e.g. 'Gast 1=Maria' (repeatable)")
    ap.add_argument("--mics", help="comma-separated channel names to use (default: every mic with a signal)")
    ap.add_argument("--vocab", action="append", default=[], help="vocabulary file, one term per line (repeatable; vocab/radioz.txt is always used)")
    ap.add_argument("--fix", action="append", metavar="FROM=TO", help="text replacement in the transcript (repeatable)")
    ap.add_argument("--music", action="append", metavar="N=LABEL", help="label for music item N of work/items.json, e.g. '2=David Bowie – Changes'")
    ap.add_argument("--jingle-max-sec", type=float, default=30.0, help="music shorter than this is a jingle (default 30; the .ohne-musik.json sidecar wins)")
    ap.add_argument("--modes", default="full,talk,words", help="versions to render (default all three)")
    ap.add_argument("--facts", help="fact block for the Mediathek text (German, see README)")
    ap.add_argument("--llm-model", default=os.environ.get("POST_LLM_MODEL", "~/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), help="GGUF model for the summary")
    ap.add_argument("--llama-dir", default=os.environ.get("LLAMA_DIR", "~/opt/llama.cpp/vulkan-x64"), help="directory with llama-server")
    ap.add_argument("--ngl", type=int, default=99, help="GPU layers for llama-server (0 = CPU)")
    ap.add_argument("--no-think", action="store_true", help="summary without the model's thinking phase")
    ap.add_argument("--threads", type=int, default=max(2, (os.cpu_count() or 8) // 2), help="CPU threads for whisper")
    ap.add_argument("--token-beam", type=int, default=1, help="beam size of the per-token pass (1 = fastest)")
    ap.add_argument("--seconds", nargs=2, type=float, metavar=("FROM", "TO"), help="use only this span of the recording (to try things on a piece, or to trim)")
    ap.add_argument("--steps", help="comma-separated steps to run (default: all; summary only with --facts)")
    ap.add_argument("--force", action="store_true", help="redo the chosen steps even if their result exists")
    args = ap.parse_args(argv)

    rec = recording.load(args.recording)
    out = args.out or os.path.join(os.path.dirname(rec.json_path), "post", rec.base)
    work = os.path.join(out, "work")
    os.makedirs(work, exist_ok=True)
    log = Log(os.path.join(work, "post.log"))
    title = args.title or rec.tags.get("TITLE") or rec.base
    date = args.date or rec.date or ""
    name = f"{title} {date}".strip() + (f" – {args.subtitle}" if args.subtitle else "")
    speakers = dict(parse_pairs(args.speaker, "speaker"))
    fixes = parse_pairs(args.fix, "fix")
    labels = {int(k): v for k, v in parse_pairs(args.music, "music")}
    modes = [m for m in args.modes.split(",") if m]
    steps = args.steps.split(",") if args.steps else [s for s in STEPS if s != "summary" or args.facts]
    bad = [s for s in steps if s not in STEPS]
    if bad:
        raise SystemExit(f"unknown step(s): {bad}; known: {STEPS}")
    seconds = tuple(args.seconds) if args.seconds else None
    log(f"post-production of {rec.base} -> {out}" + (f" (seconds {seconds[0]:.0f}-{seconds[1]:.0f})" if seconds else ""))

    def want(step, *outputs):
        if step not in steps:
            return False
        if not args.force and outputs and all(os.path.exists(p) for p in outputs):
            log(f"{step}: done before, skipped")
            return False
        return True

    def p(*parts):
        return os.path.join(work, *parts)

    t_all = time.time()
    # ---------------------------------------------------------------- decode
    if "decode" in steps:
        t0 = time.time()
        recording.decode(rec, work, seconds, args.force)
        log(f"decode: {recording.length(work, rec) / SR / 60:.1f} min, {len(rec.channels)} channels ({time.time() - t0:.0f} s)")
    if not os.path.exists(p("decode.json")):
        raise SystemExit("decode first")
    T = recording.length(work, rec)
    NF = T // FRAME

    # ---------------------------------------------------------------- mics
    if args.mics:
        wanted = [s.strip() for s in args.mics.split(",")]
        mics = [c for c in rec.mics if c.name in wanted]
        missing = set(wanted) - {c.name for c in mics}
        if missing:
            raise SystemExit(f"no such mic channel(s): {sorted(missing)}")
    else:
        mics = recording.used_mics(rec, work)
    if len(mics) < 1:
        raise SystemExit("no mic carries a signal")
    names = [speakers.get(c.name, c.name) for c in mics]
    with open(p("channels.json"), "w") as f:
        json.dump([dict(channel=c.index + 1, name=c.name, speaker=n) for c, n in zip(mics, names)], f, indent=1, ensure_ascii=False)
    mic_audio = lambda: [recording.channel(work, c) for c in mics]  # noqa: E731

    # ---------------------------------------------------------------- talker
    if want("talker", p("talker.npz")):
        t0 = time.time()
        res = talker.label(mic_audio())
        np.savez(p("talker.npz"), **res)
        c = res["cls"]
        log(f"talker: {', '.join(f'{n} {(c == k).sum() / FPS:.0f} s' for k, n in enumerate(names))}, nobody {(c < 0).sum() / FPS:.0f} s ({time.time() - t0:.0f} s)")
    tk = np.load(p("talker.npz"))
    cls = np.concatenate([tk["cls"], np.full(max(0, NF - len(tk["cls"])), -1)])[:NF]
    anytalk = cls >= 0

    # ---------------------------------------------------------------- music
    if want("music", p("items.json")):
        if len(rec.music) >= 2:
            ml, mr = recording.channel(work, rec.music[0]), recording.channel(work, rec.music[1])
            items = music.find_items(ml, mr, args.jingle_max_sec, rec.ohne_musik_json, seconds[0] if seconds else 0.0)
        else:
            items = []
        with open(p("items.json"), "w") as f:
            json.dump([music.item_dict(i) for i in items], f, indent=1)
        log("music: " + (", ".join(f"{i + 1}. {it.kind} {it.start:.0f}-{it.end:.0f} s" for i, it in enumerate(items)) or "none"))
        if len(rec.programme) >= 2 and len(rec.music) >= 2:
            pl, pr = recording.channel(work, rec.programme[0]), recording.channel(work, rec.programme[1])
            air = music.on_air(pl, pr, ml, mr, items)
            np.save(p("onair.npy"), air)
            log(f"music: mics on air {air.sum() / FPS / 60:.1f} min of {len(air) / FPS / 60:.1f}")
    with open(p("items.json")) as f:
        items = [music.Item(**d) for d in json.load(f)]
    show_talk = anytalk
    if os.path.exists(p("onair.npy")):
        air = np.load(p("onair.npy"))
        air = np.concatenate([air, np.zeros(max(0, NF - len(air)), bool)])[:NF]
        show_talk = anytalk & air
    open_frames = ~music.closed_frames(items, anytalk, kinds=("song",))[:NF]
    open_frames = np.concatenate([open_frames, np.zeros(max(0, NF - len(open_frames)), bool)])
    if os.path.exists(p("onair.npy")):
        # mics off air for OFF_AIR_SEC or longer (songs, muted after the show): closed
        for a, b in music.runs(~air):
            if b - a >= OFF_AIR_SEC * FPS:
                open_frames[a:b] = False

    # ---------------------------------------------------------------- breath
    if want("breath", p("breath.npz")):
        t0 = time.time()
        res = {}
        for k, (m, n) in enumerate(zip(mic_audio(), names)):
            env, runs_ = breath.detect(m, cls == k)
            res[f"env{k}"] = env
            res[f"runs{k}"] = np.array(runs_)
            log(f"breath: {n}: {len(runs_)} breaths" + (f", median {np.median([r[2] for r in runs_]):.0f} dB under the voice" if runs_ else ""))
        np.savez(p("breath.npz"), **res)
        log(f"breath: done ({time.time() - t0:.0f} s)")

    # ---------------------------------------------------------------- mix
    mix_outputs = [p("bus.f32"), p("mix.npz")] + [p(f"mic-{k}.f32") for k in range(len(mics))]
    if want("mix", *mix_outputs):
        t0 = time.time()
        benv = None
        if os.path.exists(p("breath.npz")):
            bz = np.load(p("breath.npz"))
            benv = [breath.envelope_to_samples(bz[f"env{k}"], T) if f"env{k}" in bz else None for k in range(len(mics))]
        mx = mix.Mixer(mic_audio(), cls, open_frames, benv, log)
        bus, act = mx.run()
        bus.tofile(p("bus.f32"))
        for k, y in enumerate(mx.leveled):
            y.tofile(p(f"mic-{k}.f32"))
        np.savez(p("mix.npz"), act=act, open=open_frames, talks=np.stack(mx.talks, 1), gains=np.stack(mx.gains, 1))
        log(f"mix: done ({time.time() - t0:.0f} s)")
        del mx, bus

    vocab = asr.load_vocab([os.path.join(HERE, "vocab", "radioz.txt")] + args.vocab)
    hotwords = ", ".join(dict.fromkeys(list(speakers.values()) + ([title] if args.title else []) + vocab)) or None

    # ---------------------------------------------------------------- asr
    if "asr" in steps:
        mz = np.load(p("mix.npz"))
        for k, n in enumerate(names):
            if not want("asr", p(f"asr-{k}.json")):
                continue
            t0 = time.time()
            y = np.fromfile(p(f"mic-{k}.f32"), dtype="<f4")
            track = asr.gated_track(y, mz["talks"][:, k])
            asr.write_wav16(p(f"asr-{k}.wav"), track)
            words, lines = asr.transcribe_words(track, hotwords=hotwords, threads=args.threads, log=log)
            with open(p(f"asr-{k}.json"), "w") as f:
                json.dump(words, f, ensure_ascii=False)
            with open(p(f"asr-{k}.txt"), "w") as f:
                f.write("\n".join(lines) + "\n")
            log(f"asr: {n}: {len(words)} words ({time.time() - t0:.0f} s)")

    # ---------------------------------------------------------------- tokens
    if want("tokens", p("tokens.json")):
        t0 = time.time()
        bus = np.fromfile(p("bus.f32"), dtype="<f4")
        toks, lines = [], []
        chunks = asr.chunks_for_tokens(open_frames & anytalk)
        log(f"tokens: {len(chunks)} talk chunks, {sum(b - a for a, b in chunks) / 60:.0f} min")
        for a, b in chunks:
            seg = asr.to_16k(bus[int(a * SR) : int(b * SR)])
            words, ls = asr.transcribe_tokens(seg, threads=args.threads, beam=args.token_beam, log=log)
            toks += [dict(w, s=round(w["s"] + a, 3), e=round(w["e"] + a, 3)) for w in words]
            lines += [f"[{a:8.1f}+] " + l for l in ls]
            with open(p("tokens.partial.json"), "w") as f:  # progress; tokens.json only when complete
                json.dump(toks, f, ensure_ascii=False)
        with open(p("tokens.txt"), "w") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(p("tokens.partial.json"), p("tokens.json"))
        del bus
        log(f"tokens: {len(toks)} tokens ({(time.time() - t0) / 60:.0f} min)")

    # ---------------------------------------------------------------- fillers
    if want("fillers", p("cuts.json")):
        if not os.path.exists(p("tokens.json")):
            log("fillers: no tokens.json, no filler cuts")
        else:
            with open(p("tokens.json")) as f:
                toks = json.load(f)
            bus = np.fromfile(p("bus.f32"), dtype="<f4")
            cuts = fillers.cuts_from_tokens(toks, fillers.levels_10ms(bus))
            del bus
            with open(p("cuts.json"), "w") as f:
                json.dump(cuts, f)
            log(f"fillers: {len(cuts)} cuts, {sum(b - a for a, b in cuts):.1f} s")
    cuts = []
    if os.path.exists(p("cuts.json")):
        with open(p("cuts.json")) as f:
            cuts = json.load(f)

    # ---------------------------------------------------------------- render
    if want("render", *[p(f"render-{m}.f32") for m in modes]):
        t0 = time.time()
        bus = np.fromfile(p("bus.f32"), dtype="<f4")
        mz = np.load(p("mix.npz"))
        act = mz["act"]
        if len(rec.music) >= 2 and items:
            ml, mr = recording.channel(work, rec.music[0]), recording.channel(work, rec.music[1])
            n = min(len(ml), len(mr), T)
            mus = np.stack([ml[:n], mr[:n]], 1).astype(np.float32)
            if n < T:
                mus = np.concatenate([mus, np.zeros((T - n, 2), np.float32)])
            talk_lufs = render.integrated_lufs(bus)
            log(f"render: talk bus {talk_lufs:.1f} LUFS")
            gains = render.level_items(mus, items, talk_lufs, log)
            with open(p("items.json"), "w") as f:
                json.dump([music.item_dict(i) for i in items], f, indent=1)
        else:
            mus, gains = np.zeros((T, 2), np.float32), {}
        music_on = np.zeros(NF, bool)
        for it in items:
            music_on[int(it.start * FPS) : int(it.end * FPS)] = True
        for m in modes:
            audio, tl, closed = render.render(m, bus, act, mus, items, gains, anytalk, music_on, cuts, log, show_talk=show_talk)
            audio.tofile(p(f"render-{m}.f32"))
            tl.save(p(f"render-{m}.json"), mode=m, cuts=len(cuts), items=[music.item_dict(i) for i in items])
            del audio
        log(f"render: done ({time.time() - t0:.0f} s)")

    suffix = {"full": "", "talk": " (ohne Musik, mit Jingles)", "words": " (nur Wort)"}
    mp3s = {m: os.path.join(out, f"{name}{suffix[m]}.mp3") for m in modes}

    # ---------------------------------------------------------------- encode
    if want("encode", *mp3s.values()):
        t0 = time.time()
        tags = {
            "title": name + ("" if seconds else ""),
            "artist": rec.tags.get("ORGANIZATION", ""),
            "album": title,
            "date": date[:4] if date else "",
            "comment": f"Nachbearbeitet mit studiobox post ({dt.date.today():%d.%m.%Y})",
        }
        report = {}
        for m in modes:
            tags_m = dict(tags, title=name + suffix[m])
            encode.encode_mp3(p(f"render-{m}.f32"), mp3s[m], tags_m)
            meas = encode.measure(mp3s[m])
            report[m] = dict(file=os.path.basename(mp3s[m]), duration=encode.duration(mp3s[m]), **meas)
            log(f"encode: {os.path.basename(mp3s[m])}: {meas.get('lufs')} LUFS, {meas.get('true_peak')} dBTP, {transcript.hms(report[m]['duration'] or 0)}")
        with open(p("loudness.json"), "w") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
        log(f"encode: done ({time.time() - t0:.0f} s)")

    # ---------------------------------------------------------------- transcript
    tr_base = os.path.join(out, f"{name} – Transkript")
    if want("transcript", tr_base + ".md"):
        have = [k for k in range(len(mics)) if os.path.exists(p(f"asr-{k}.json"))]
        if not have:
            log("transcript: no asr results, skipped")
        else:
            words_by = {}
            for k in have:
                with open(p(f"asr-{k}.json")) as f:
                    words_by[names[k]] = json.load(f)
            mz = np.load(p("mix.npz"))
            utts, review, dropped = transcript.build(words_by, cls, mz["open"], {names[k]: k for k in have}, log)
            transcript.apply_fixes(utts, review, fixes)
            with open(p("dropped-fragments.txt"), "w") as f:
                f.write("\n".join(dropped) + "\n")
            ref_mode = "full" if "full" in modes else modes[0]
            tl, _ = Timeline.load(p(f"render-{ref_mode}.json"))
            rows = transcript.rows_for(utts, items, labels, tl)
            d = dt.date.fromisoformat(date) if date else None
            header = f"{title} – {d:%-d.%-m.%Y}" if d else title
            if args.subtitle:
                header += f": {args.subtitle}"
            who = ", ".join(names)
            intro = (
                f"Sprecher:innen: {who}. Maschinelles Transkript (Whisper large-v3-turbo, jede Stimme von ihrem eigenen Mikrofon), "
                f"bitte gegenlesen. Zeiten beziehen sich auf die Datei „{os.path.basename(mp3s.get(ref_mode, name + '.mp3'))}“."
            )
            transcript.write(rows, review, tl, tr_base, header, intro)
            with open(p("transcript-llm.txt"), "w") as f:
                f.write(transcript.plain(rows))
            log("transcript: " + transcript.stats(rows, review))

    # ---------------------------------------------------------------- summary
    sum_path = os.path.join(out, f"{name} – Mediathek-Text.txt")
    if want("summary", sum_path):
        if not args.facts:
            log("summary: no --facts, skipped")
        elif not os.path.exists(p("transcript-llm.txt")):
            log("summary: no transcript, skipped")
        else:
            with open(os.path.join(HERE, "prompts", "mediathek-system.txt")) as f:
                system = f.read()
            with open(args.facts) as f:
                facts = f.read()
            with open(p("transcript-llm.txt")) as f:
                tr = f.read()
            summary.run(args.llm_model, args.llama_dir, system, facts, tr, sum_path, side=p("summary"), think=not args.no_think, threads=args.threads, ngl=args.ngl, log=log)
    log(f"all done ({(time.time() - t_all) / 60:.1f} min) -> {out}")


if __name__ == "__main__":
    main()
