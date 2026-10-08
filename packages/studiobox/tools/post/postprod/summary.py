"""Mediathek text draft from the transcript via a local llama-server.

Runs `llama-server` with the given GGUF model, asks once (system prompt from
`prompts/mediathek-system.txt`, the fact block the editor wrote plus the
transcript) and writes the answer. The GPU (Vulkan build) needs the user in
the `render` group — run under `sg render -c '…'` after adding it.
"""
import json
import os
import re
import subprocess
import time
import urllib.request

PORT = 8091


def run(model: str, llama_dir: str, system: str, facts: str, transcript: str, out_txt: str, side: str | None = None, think=True, threads=8, ngl=99, ctx=32768, log=print):
    """`side`: base path for the server log and the timings (default: beside `out_txt`)."""
    side = side or out_txt
    bin_ = os.path.join(os.path.expanduser(llama_dir), "llama-server")
    if not os.path.exists(bin_):
        raise FileNotFoundError(bin_)
    user = facts.strip() + "\n\nTranskript der Sendung:\n\n" + transcript.strip() + "\n\nSchreibe jetzt den Mediathek-Text im vorgegebenen Format."
    with open(side + ".server.log", "w") as slog:
        srv = subprocess.Popen(
            [bin_, "-m", os.path.expanduser(model), "-c", str(ctx), "--port", str(PORT), "-t", str(threads), "--jinja", "--no-webui", "-np", "1", "-ngl", str(ngl)],
            stdout=subprocess.DEVNULL,
            stderr=slog,
        )
    try:
        t0 = time.time()
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2).read()
                break
            except Exception:
                if srv.poll() is not None:
                    raise RuntimeError("llama-server died, see " + side + ".server.log")
                time.sleep(2)
        load = time.time() - t0
        body = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.4,
            "top_p": 0.9,
            "max_tokens": 4000 if think else 1200,
            "chat_template_kwargs": {"enable_thinking": think},
        }
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        t1 = time.time()
        r = json.loads(urllib.request.urlopen(req, timeout=7200).read())
        text = r["choices"][0]["message"].get("content") or ""
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
        tm = r.get("timings", {})
        info = {
            "model": os.path.basename(model),
            "load_s": round(load, 1),
            "wall_s": round(time.time() - t1, 1),
            "prompt_tokens": tm.get("prompt_n"),
            "gen_tokens": tm.get("predicted_n"),
            "gen_tok_s": round(tm.get("predicted_per_second", 0), 2),
            "words": len(text.split()),
            "thinking": think,
        }
        with open(out_txt, "w") as f:
            f.write(text + "\n")
        with open(side + ".json", "w") as f:
            json.dump(info, f, indent=1)
        log(f"summary: {info['words']} words in {info['wall_s']} s ({info['gen_tok_s']} tok/s)")
        return text
    finally:
        srv.terminate()
        srv.wait()
