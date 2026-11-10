# 架构与时延

## 说话（qq_say_voice）

```
text
 │
 ├─1) GPT-SoVITS POST /tts ───────────────► 32 kHz wav
 │      ref_audio_path / prompt_text / prompt_lang 来自 ref/
 │      失败才往下走（默认链路里下面是关的）
 │
 ├─2) Piper（PIPER_ENABLED=1 才启用）────► 22.05 kHz wav
 │
 ├─3) edge-tts（ALLOW_CLOUD_TTS=1 才启用）─► 在线合成，默认禁用
 │
 ├─ 静音守卫：按 WAV 头算时长，短于「字数×0.08s」判失败
 │
 ├─4) RVC 变声 ──────────────────────────► 40 kHz wav
 │      ffmpeg 转 44.1k/单声道 → infer_cli.py --f0method rmvpe
 │
 └─5) 发送：校验时长/体积 → QQ 网关 → 回读确认是语音段
```

关键点：

- **RVC 之前的显存检查**：`nvidia-smi --query-gpu=memory.free`，≥ `RVC_MIN_FREE_MIB`(4500) 直接开跑，否则才卸载 Ollama 里加载着的聊天模型并轮询 `/api/ps` 直到释放。省下的最多 18 秒就是用户感知的延迟。
- **WAV 头解析**不依赖 ffprobe：读 `fmt ` 的 byteRate 和 `data` 的 size 算时长，避免为了校验再起一个进程。
- 发送前 `voice-core.js` 会做时长/体积/扩展名检查，超限直接拒绝而不是让网关报错。

## 唱歌（qq_sing）

```
song name
  │
  ├─ bili-cli 搜 3 个候选（B站）
  ├─ 逐个试：yt-dlp 下载 → ffmpeg 截段（默认 30 s，从 25% 处起）
  ├─ UVR5 分离：HP2_all_vocals → vocal_*.wav / instrument_*.wav
  │    分离不出伴奏 → 换下一个候选（不发干声）
  │
  ├─ engine=rvc（默认）
  │    f0probe 测原唱 p50/p95 → 自动定调（目标中位 325 Hz，上限 640 Hz）
  │    RVC infer_cli.py 换声（f0up 自动，rmvpe 提取基频）
  │
  └─ engine=gsv
       faster-whisper --segments 拿到逐句 start/end
       合并成 ≤14 段（每段 2~4 秒）
       逐段 POST /tts 合成（同一个人音色）
       每段 atempo 拉伸到原句时长 → adelay 贴回原曲时间轴
       （单段走 atrim+apad，多段才 amix —— RVC 自带的 ffmpeg 不认 normalize 参数）

  → 混伴奏：[人声 volume=2.0] + [伴奏 volume=0.9] amix → 44.1k 立体声
  → 发送（同样走 send-voice）
```

### 为什么 gsv 模式必须用 ASR

GPT-SoVITS 只吃文本，不知道原曲的节奏。要让「念出来的歌词」不至于和伴奏完全错拍，只能：

1. 用 ASR 从原唱人声里取**每句的起止时间**；
2. 让每句合成音频用 `atempo` 拉伸/压缩到该句的时长；
3. 用 `adelay` 把它推到原来的时间点。

所以 gsv 模式的音准/节奏完全依赖伴奏，人声只贡献音色和字。

### 自动定调（rvc 模式）

固定 `+12` 会把女声原曲顶到 900 Hz 以上直接破音。改成：

```
k = round(12 * log2(TARGET / p50))     # TARGET 默认 325 Hz
k = clamp(k, -6, +12)
while p95 * 2^(k/12) > CAP: k -= 1     # CAP 默认 640 Hz
```

## 时延参考（RTX 3060 12 GB / i5-13400F）

| 环节 | 耗时 |
|---|---|
| GPT-SoVITS 冷启动（加载权重） | 60~80 s |
| GPT-SoVITS 热态（4 s 音频） | 1.5~2 s |
| RVC（5 s 音频） | 2~3 s |
| 卸载本地聊天模型（必要时） | 5~15 s |
| UVR5 分离（30 s 音频） | 10~20 s |
| faster-whisper（30 s 音频） | 20~40 s |
| 整条语音 | 3~6 s |
| 整首点歌（rvc / gsv） | 30~60 s / 60~120 s |

## 显存预算

| 组件 | 显存 |
|---|---|
| GPT-SoVITS v2ProPlus 推理 | ≈ 3 GB |
| RVC（rmvpe） | ≈ 2.5 GB |
| 本地聊天模型 8B / 40k ctx | ≈ 8 GB |
| 本地视觉模型（可选） | ≈ 6 GB |

12 GB 卡上「聊天模型 + 语音」不能同时常驻，所以有了显存检查那一步：优先跑语音，聊天模型按需退出（下一次对话会重新预填充，约 40 秒）。
