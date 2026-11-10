# QQ 语音 / 点歌工作流

把 **QQ 里「说话」和「唱歌」两种能力**用全本地模型跑起来的完整工作流：

```
DeepSeek（只决定说什么 / 唱哪首）
        │  调用 MCP 工具
        ▼
┌───────────────────────────────────────────────┐
│ qq-voice-tts（MCP server）                     │
│                                               │
│  说话：GPT-SoVITS v2ProPlus ──► RVC 换音色     │
│         （本地 9880，CUDA）      （本地）       │
│                                               │
│  唱歌：B站搜歌 → yt-dlp 下载 → UVR5 分离       │
│         ├─ rvc 模式：原唱人声 ──► RVC 换声（保旋律）│
│         └─ gsv 模式：ASR 出歌词时间轴 ──► GSV 逐句念唱 │
│         → 混回伴奏 → 发 QQ 语音条               │
└───────────────────────────────────────────────┘
```

- **全部合成都在本机**：GPT-SoVITS / Piper / RVC / UVR5 / faster-whisper，没有一处调用在线 TTS。
- 大模型只负责「决策 + 调工具」，它不参与任何音频渲染。
- 两种发声共用一套音色模型（GPT-SoVITS 微调 + RVC 音色），所以说话和唱歌听起来是同一个人。

---

## 目录结构

```
src/
  mcp-voice-tts.js     MCP server：qq_say_voice / qq_sing / qq_list_voices
  sing.mjs             点歌流水线（rvc / gsv 双引擎）
  voice-core.js        音频校验（时长/体积/编码）、发送前检查
  send-voice-lib.js    QQ 语音发送封装
scripts/
  asr.py               faster-whisper 封装，支持 --segments 逐句时间戳
  send-voice.mjs       命令行发语音（sing.mjs 复用它发结果）
  start-tts.cmd.example  GPT-SoVITS api_v2 启动脚本模板
patches/
  gsv-version-assertion.patch  修上游 v2Pro/v2ProPlus 断言 bug
  jieba_fast.py        jieba_fast 编译失败时的等价垫片
docs/
  architecture.md      流水线细节、时延、显存预算
  setup-gsv.md         GPT-SoVITS 安装（含踩过的坑）
  setup-rvc.md         RVC 安装与音色模型放置
  troubleshooting.md   静音输出、16 kHz 假音频、看门狗等
```

---

## 快速开始

### 0. 前置

| 组件 | 用途 | 获取方式 |
|---|---|---|
| Node.js ≥ 20 | 运行 MCP server / sing.mjs | nodejs.org |
| Python 3.11 | GPT-SoVITS 运行时 | python.org |
| **GPT-SoVITS v2ProPlus** | 说话/念唱的音色模型 | 见 [docs/setup-gsv.md](docs/setup-gsv.md) |
| **RVC**（RVC1006Nvidia 之类） | 换音色 / 唱歌 | https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI |
| **UVR5 模型**（`HP2_all_vocals.pth`） | 点歌时分离人声/伴奏 | 随 RVC 包附带 |
| **faster-whisper** | gsv 模式取歌词时间轴、质量自检 | `pip install faster-whisper` |
| **Piper**（可选） | 本地兜底 TTS（默认关闭） | https://github.com/rhasspy/piper |

### 1. 准备参考音频

GPT-SoVITS 是 zero-shot 音色克隆，需要一段 3~10 秒的参考音频 + **逐字对应的文本**：

```
ref/reference.wav      # 3~10 秒，单人，干净
ref/REF_TEXT.txt       # 与上面音频逐字一致的内容
ref/REF_LANG.txt       # zh / ja / en ...（参考音频的语种）
```

文本和音频必须严格对应，否则克隆出来会跑调、口音错乱。

### 2. 起 GPT-SoVITS 服务

```powershell
# 改好路径后
scripts\start-tts.cmd.example  →  start-tts.cmd
start-tts.cmd                  # 监听 127.0.0.1:9880
```

健康检查：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9880/docs   # 期望 200
```

### 3. 配置

```bash
cp config.example.json config.json     # 填入你自己的 QQ / 网关配置
```

关键环境变量（都有默认值，按需覆盖）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GPT_SOVITS_URL` | `http://127.0.0.1:9880` | GPT-SoVITS api_v2 地址 |
| `GPT_SOVITS_REF` | `<root>/ref/reference.wav` | 参考音频 |
| `GPT_SOVITS_REF_TEXT` | 读 `ref/REF_TEXT.txt` | 参考文本 |
| `GPT_SOVITS_REF_LANG` | 读 `ref/REF_LANG.txt` | 参考音频语种 |
| `RVC_ROOT` | `D:\RVC\RVC1006Nvidia` | RVC 安装目录 |
| `RVC_MODEL` / `RVC_INDEX` | `Roxy.pth` / `Roxy.index` | 唱歌用的音色模型 |
| `ASR_PY` | `D:\asr\venv\Scripts\python.exe` | faster-whisper 的 python |
| `PIPER_ENABLED` | `0`（关） | 设为 `1` 才启用 Piper 兜底 |
| `ALLOW_CLOUD_TTS` | `0`（关） | 设为 `1` 才允许 edge-tts 在线兜底 |
| `OLLAMA_UNLOAD_BEFORE_RVC` | `1` | RVC 前把本地聊天模型请出显存 |
| `RVC_MIN_FREE_MIB` | `4500` | 显存够这个值就跳过卸载（省 18 秒） |
| `SYNC_SING` | `0` | 设为 `1` 让 `qq_sing` 等唱完再返回 |
| `SING_ENGINE` | `rvc` | 点歌默认引擎，可设 `gsv` |

### 4. 接进 MCP

DeepSeek Harness（Cordis patch）：

```yaml
- insert:
    - id: qq-voice-tts
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: voice-tts
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args:
          - C:\path\to\qq-voice-workflow\src\mcp-voice-tts.js
```

其它 agent 用标准 stdio MCP 写法即可。

### 5. 用

```
qq_say_voice(text, target)              # 发一条语音（3~6 秒出）
qq_sing(song, target, start?, engine?)  # 点歌（立即返回，唱完自动补发）
qq_list_voices()                        # 看语音库里有哪些现成文件
```

---

## 两种唱歌引擎的区别（重要）

| | `engine=rvc`（默认） | `engine=gsv` |
|---|---|---|
| 人声来源 | 原唱人声换声 | GPT-SoVITS 逐句念唱 |
| 旋律 | **保留原曲旋律**（真唱） | 无音高控制，旋律只来自伴奏 |
| 听感 | 像这个人在唱 | 像这个人在念歌词 |
| 耗时 | 30~60 s | 60~120 s |
| 适合 | 正常点歌 | 朗诵 / 念白 / 纯音乐填词 |

> GPT-SoVITS 是 **TTS**，没有音高/换气/滑音控制，所以 `gsv` 模式天生「唱不出旋律」。
> 要真的唱，靠的是 RVC（从原唱搬旋律和咬字，只换音色）。

---

## 时延与显存（实测，RTX 3060 12 GB）

| 环节 | 数值 |
|---|---|
| GPT-SoVITS 热态合成 | 4 秒音频 ≈ **1.5~2 秒** |
| RVC 变声 | 5 秒音频 ≈ **2~3 秒** |
| 一条语音端到端 | **3~6 秒** |
| 点歌（rvc） | 30~60 秒 |
| 点歌（gsv） | 60~120 秒 |
| GPT-SoVITS 常驻显存 | ≈ 3 GB |
| RVC 峰值 | ≈ 2.5 GB |
| 本地聊天模型（8B / 40k ctx） | ≈ 8 GB |

显存不足时的策略：跑 RVC/UVR5 前检查剩余显存，够用就不动本地聊天模型；不够才 `POST /api/generate {keep_alive:0}` 把它请出去并轮询到真正释放。

---

## 设计上的几个硬约束

1. **绝不上云**：`ALLOW_CLOUD_TTS` 不显式打开时，本地渲染失败直接报错，不会偷偷换成在线合成。
2. **静音守卫**：模型/配置不对时某些加载器会返回「1 秒 / 16 kHz / 全 0」的 WAV，体积达标能骗过旧校验。现在按 WAV 头算真实时长，明显短于「字数 × 0.08 秒」就判失败。
3. **参考文本必须匹配**：`REF_TEXT.txt` 与 `reference.wav` 不一致是最常见的翻车原因。
4. **点歌必须带伴奏**：分离不出伴奏就换下一个候选，绝不发干声。

---

## License

MIT（见 [LICENSE](LICENSE)）。音色模型不随仓库分发，请遵守其原始授权。
