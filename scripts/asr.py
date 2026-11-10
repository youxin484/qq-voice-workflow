#!/usr/bin/env python
# 本地语音识别（ASR）—— B 站视频没有字幕时的兜底。
#
# 用 faster-whisper（CTranslate2 后端，CUDA/float16），模型默认 large-v3。
# 只做一件事：把音频/视频文件转成 JSON 文本，stdout 永远只有一行 JSON，方便 Node 侧解析。
#
# 用法：
#   python asr.py <media> [--model large-v3] [--device cuda] [--compute-type float16] [--language zh] [--max-chars 0]
#
# 输出：
#   {"ok": true, "language": "zh", "duration": 123.4, "chars": 812, "text": "……", "elapsedMs": 4321}
#   {"ok": false, "error": "……"}
#
# 模型缓存：默认 D:\asr\models（可用 ASR_MODEL_DIR 覆盖），避免把几 GB 权重塞进系统盘。
import argparse
import json
import os
import sys
import time


def main() -> int:
    # Windows 控制台默认 GBK：不强制 UTF-8 的话，重定向到文件/被 Node 捕获时会变成乱码。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--model", default=os.environ.get("ASR_MODEL", "large-v3"))
    ap.add_argument("--device", default=os.environ.get("ASR_DEVICE", "cpu"))
    ap.add_argument("--compute-type", default=os.environ.get("ASR_COMPUTE_TYPE", ""))
    ap.add_argument("--language", default=os.environ.get("ASR_LANGUAGE", "zh"))
    ap.add_argument("--segments", action="store_true", help="输出逐句时间戳 start/end（秒）")
    ap.add_argument("--max-chars", type=int, default=0, help=">0 时截断到该字符数")
    ap.add_argument("--model-dir", default=os.environ.get("ASR_MODEL_DIR", "D:/asr/models"))
    args = ap.parse_args()

    # device 决定默认精度：CPU 用 int8（快且省内存），GPU 用 float16。
    if not args.compute_type:
        args.compute_type = "int8" if args.device == "cpu" else "float16"

    started = time.time()
    # PyAV 兼容垫片：faster-whisper 1.1.x 会调 av.open(..., metadata_errors="ignore")，
    # 但 PyPI 上最新的 av（19.0.2）这个关键字不存在 → TypeError。这里把该参数吞掉，
    # 行为上只影响"容器元数据损坏时是否忽略"，对正常音轨无差别。
    try:
        import av

        _av_open = av.open

        def _av_open_shim(*args, **kwargs):
            kwargs.pop("metadata_errors", None)
            return _av_open(*args, **kwargs)

        av.open = _av_open_shim
    except Exception:  # noqa: BLE001
        pass
    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"faster-whisper 未安装：{error}"}, ensure_ascii=False))
        return 1

    if not os.path.exists(args.media):
        print(json.dumps({"ok": False, "error": f"文件不存在：{args.media}"}, ensure_ascii=False))
        return 1

    os.makedirs(args.model_dir, exist_ok=True)
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=args.model_dir,
        )
        segments, info = model.transcribe(
            args.media,
            language=None if args.language in ("", "auto") else args.language,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
        )
        pieces = []
        timing = []
        for seg in segments:
            text = str(getattr(seg, "text", "") or "").strip()
            if text:
                pieces.append(text)
                timing.append({
                    "start": round(float(getattr(seg, "start", 0) or 0), 2),
                    "end": round(float(getattr(seg, "end", 0) or 0), 2),
                    "text": text,
                })
        # 纯音乐/强伴奏会被 VAD 全部过滤（实测唱歌的成品整段返回 0 字）。
        # 这种情况再跑一次、关掉 VAD，宁可多花一半时间也要拿到歌词/人声。
        if not pieces:
            segments, info = model.transcribe(
                args.media,
                language=None if args.language in ("", "auto") else args.language,
                vad_filter=False,
                beam_size=5,
            )
            timing = []
            for seg in segments:
                text = str(getattr(seg, "text", "") or "").strip()
                if text:
                    pieces.append(text)
                    timing.append({
                        "start": round(float(getattr(seg, "start", 0) or 0), 2),
                        "end": round(float(getattr(seg, "end", 0) or 0), 2),
                        "text": text,
                    })
        text = "".join(pieces) if info.language in ("zh", "ja") else " ".join(pieces)
        if args.max_chars > 0 and len(text) > args.max_chars:
            text = text[: args.max_chars]
        print(json.dumps({
            "ok": True,
            "language": getattr(info, "language", None),
            "duration": round(float(getattr(info, "duration", 0) or 0), 2),
            "chars": len(text),
            "text": text,
            "model": args.model,
            "elapsedMs": int((time.time() - started) * 1000),
            # --segments 时附上逐句时间戳：点歌要把每句歌词贴在原曲的时间点上
            **({"segments": timing} if args.segments else {}),
        }, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error), "elapsedMs": int((time.time() - started) * 1000)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
