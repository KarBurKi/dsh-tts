#!/usr/bin/env python
"""dsh-tts 用的 CosyVoice 本地服务。

官方仓库只给了 gradio webui 和 docker 示例，插件要的是一个
「POST 一段文字、拿回 wav 字节」的朴素接口，所以这里单独包一层，
除 CosyVoice 自身依赖外不额外引入任何包（标准库 http.server）。

    python cosyvoice_server.py --port 9883 \
        --model-dir pretrained_models/CosyVoice2-0.5B

接口：
    GET  /health  -> {"ok":true,"loaded":false,"model":"...","error":""}
    POST /tts     <- {"text":"...", "refAudio":"D:/x.wav", "promptText":"参考音频原文",
                      "instruct":"", "speed":1.0}
                  -> 200 audio/wav

环境变量：
    COSY_FP16=1   半精度推理（显存紧张时开）
    COSY_WARMUP=1 启动时就把模型读进显存（默认懒加载，首个 /tts 会慢）
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    "model": None,
    "sample_rate": 24000,
    "model_dir": "",
    "ref_audio": "",
    "error": "",
}
INFER_LOCK = threading.Lock()   # 串行推理，避免显存打架
LOAD_LOCK = threading.Lock()    # 防止并发重复加载模型


def log(msg: str) -> None:
    sys.stderr.write(f"[cosy] {msg}\n")
    sys.stderr.flush()


def load_model(model_dir: str, fp16: bool = False):
    """按「3.0 优先、2.0 兜底」的顺序构造引擎。

    CosyVoice3 的类名官方仓库还没最终统一，所以用 getattr 探测：
    有 CosyVoice3 就用，没有就退回 CosyVoice2（2.0/3.0 接口兼容）。
    """
    from cosyvoice.cli import cosyvoice as cosy_mod

    cls = getattr(cosy_mod, "CosyVoice3", None) or getattr(cosy_mod, "CosyVoice2", None)
    if cls is None:
        raise RuntimeError("cosyvoice.cli.cosyvoice 里找不到 CosyVoice2 / CosyVoice3")
    model = cls(model_dir, load_jit=False, load_trt=False, fp16=fp16)
    return model, int(getattr(model, "sample_rate", 24000) or 24000)


def ensure_model() -> None:
    if STATE["model"] is not None:
        return
    with LOAD_LOCK:
        if STATE["model"] is not None:
            return
        log(f"加载模型 {STATE['model_dir']} ...")
        model, sr = load_model(STATE["model_dir"], fp16=os.environ.get("COSY_FP16") == "1")
        STATE["model"] = model
        STATE["sample_rate"] = sr
        STATE["error"] = ""
        log(f"模型就绪，采样率 {sr}")


def load_prompt_16k(path: str):
    """参考音频规整：单声道、16k、最长 25 秒（官方 load_wav 要求 <30s）。"""
    import torchaudio
    from cosyvoice.utils.file_utils import load_wav

    if not path or not os.path.isfile(path):
        raise RuntimeError(f"参考音频不存在：{path!r}")

    wav, sr = torchaudio.load(path)
    if wav.dim() > 1 and wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    if sr != 16000:
        wav = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(wav)
    if wav.shape[-1] > 16000 * 25:
        wav = wav[..., : 16000 * 25]

    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        torchaudio.save(tmp, wav, 16000)
        return load_wav(tmp, 16000)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def synth(text: str, ref_audio: str, prompt_text: str, instruct: str, speed) -> bytes:
    import inspect
    import torch
    import torchaudio

    model = STATE["model"]
    if model is None:
        raise RuntimeError("模型还没加载")
    prompt = load_prompt_16k(ref_audio)

    if instruct:
        fn = model.inference_instruct2          # 自然语言控制：情感/方言/语速
        base_args = (text, instruct, prompt)
    else:
        fn = model.inference_zero_shot          # 3 秒极速复刻
        base_args = (text, prompt_text, prompt)

    # 不同版本的签名有出入（speed / text_frontend 是逐步加的），按实际签名取舍
    kwargs = {"stream": False}
    params = inspect.signature(fn).parameters
    if "speed" in params:
        kwargs["speed"] = float(speed or 1.0)
    if "text_frontend" in params:
        kwargs["text_frontend"] = True

    pieces = []
    for out in fn(*base_args, **kwargs):
        speech = out.get("tts_speech") if isinstance(out, dict) else out
        if speech is not None:
            pieces.append(speech)
    if not pieces:
        raise RuntimeError("模型没有返回音频")

    wav = pieces[0] if len(pieces) == 1 else torch.cat(pieces, dim=-1)
    buf = io.BytesIO()
    torchaudio.save(buf, wav.cpu(), STATE["sample_rate"], format="wav")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 覆盖默认的 stderr 访问日志
        log("%s - %s" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:
        if self.path.split("?")[0] in ("/health", "/"):
            self._json(200, {
                "ok": True,
                "model": STATE["model_dir"],
                "loaded": STATE["model"] is not None,
                "error": STATE["error"],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.split("?")[0] != "/tts":
            return self._json(404, {"error": "not found"})

        try:
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as exc:  # noqa: BLE001
            return self._json(400, {"error": f"bad json: {exc}"})

        text = str(body.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "text 为空"})

        ref = str(body.get("refAudio") or STATE["ref_audio"] or "")
        prompt_text = str(body.get("promptText") or "")
        instruct = str(body.get("instruct") or "")
        speed = body.get("speed") or 1.0

        try:
            ensure_model()
            with INFER_LOCK:
                wav = synth(text, ref, prompt_text, instruct, speed)
        except Exception as exc:  # noqa: BLE001
            STATE["error"] = f"{type(exc).__name__}: {exc}"
            log(traceback.format_exc())
            return self._json(500, {"error": STATE["error"]})

        self._send(200, wav, "audio/wav")


def main() -> None:
    ap = argparse.ArgumentParser(description="CosyVoice HTTP 服务（给 dsh-tts 用）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9883)
    ap.add_argument("--model-dir", required=True, help="如 pretrained_models/CosyVoice2-0.5B")
    ap.add_argument("--ref-audio", default="", help="默认参考音频（请求里不传时用）")
    ap.add_argument("--warmup", action="store_true", help="启动即加载模型")
    args = ap.parse_args()

    STATE["model_dir"] = args.model_dir
    STATE["ref_audio"] = args.ref_audio

    if args.warmup or os.environ.get("COSY_WARMUP") == "1":
        try:
            ensure_model()
        except Exception:  # noqa: BLE001
            log(traceback.format_exc())

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"listening http://{args.host}:{args.port}  model={args.model_dir}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("bye")
        srv.server_close()


if __name__ == "__main__":
    main()
