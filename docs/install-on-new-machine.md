# 在另一台电脑上安装

这份文档假设你要把当前这台机器上跑通的「QQ 语音 / 点歌」整套搬到另一台 Windows 电脑。

仓库本身**只有代码和文档**，下面这些东西不在仓库里（体积大 / 含隐私 / 有授权限制），需要另外准备：

| 不在仓库里的东西 | 体积 | 从哪来 |
|---|---|---|
| GPT-SoVITS 源码 | ~10 MB | 上游 GitHub |
| GPT-SoVITS 预训练 + 微调权重 | ~2.7 GB | HuggingFace / 模型作者 |
| RVC 整合包 | ~10 GB | RVC-Project 发行包 |
| RVC 音色模型（`.pth` / `.index`） | ~200 MB | 模型作者 |
| 参考音频 `ref/*` | < 1 MB | 自己录制或模型作者提供 |
| `config.json`（含令牌） | 几 KB | 旧机器拷 / 按 `config.example.json` 重填 |
| GPT-SoVITS 的 venv | ~6 GB | 新机器重建（解释器路径绑定，不能直接拷） |

---

## 方案 A：从旧机器整体迁移（推荐，最省事）

适合两台机器都是 Windows、且你要一模一样的音色。

### 1. 旧机器上打包

```powershell
# 代码（可以先 clone 仓库，也可以直接拷目录）
git clone https://github.com/youxin484/qq-voice-workflow.git

# 要一起带走的东西
$out = 'D:\transfer'
New-Item -ItemType Directory -Force $out\gsv, $out\rvc, $out\ref, $out\cfg

# GPT-SoVITS 权重（源码重新 clone，权重直接拷）
robocopy 'D:\tools\gsv\GPT-SoVITS-main\GPT_SoVITS\pretrained_models' "$out\gsv\pretrained_models" /E
# RVC 音色 + 索引
Copy-Item 'D:\RVC\RVC1006Nvidia\assets\weights\*.pth'   "$out\rvc\" -Force
Copy-Item 'D:\RVC\RVC1006Nvidia\assets\indices\*.index' "$out\rvc\" -Force
# 参考音频（音色克隆的锚点）
Copy-Item 'C:\Users\liu\Documents\qq-bridge\ref\*' "$out\ref\" -Force
# 配置（含令牌，注意别外传）
Copy-Item 'C:\Users\liu\Documents\qq-bridge\config.json' "$out\cfg\" -Force
```

用移动硬盘 / 局域网共享拷到新机器。**`config.json` 里有网关令牌和 QQ 号，别传到任何公开位置。**

### 2. 新机器上装依赖

```powershell
winget install --id OpenJS.NodeJS.LTS --scope user --silent
winget install --id Git.Git --scope user --silent
winget install --id Python.Python.3.11 --scope user --silent
winget install --id GitHub.cli --scope user --silent
```

RVC 整合包：从 https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI 的发行页下载
（或在旧机器上整目录拷 `D:\RVC\RVC1006Nvidia`，但要重装 `runtime` 里的 CUDA 依赖，通常直接下新包更快）。

### 3. 放回数据

```powershell
# 代码
cd C:\Users\<你>\Documents
git clone https://github.com/youxin484/qq-voice-workflow.git qq-bridge
cd qq-bridge

# 参考音频
$dst = 'C:\Users\<你>\Documents\qq-bridge'
New-Item -ItemType Directory -Force "$dst\ref"
Copy-Item D:\transfer\ref\* "$dst\ref\" -Force

# 配置
Copy-Item D:\transfer\cfg\config.json "$dst\config.json"

# RVC 音色
Copy-Item D:\transfer\rvc\* 'D:\RVC\RVC1006Nvidia\assets\weights\' -Force
Copy-Item D:\transfer\rvc\*.index 'D:\RVC\RVC1006Nvidia\assets\indices\' -Force
```

### 4. GPT-SoVITS

```powershell
cd D:\tools
git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS
copy /Y D:\transfer\gsv\pretrained_models GPT_SoVITS\pretrained_models  # 用 robocopy /E 更稳
robocopy D:\transfer\gsv\pretrained_models GPT_SoVITS\pretrained_models /E
```

然后按 [setup-gsv.md](setup-gsv.md) 走：建 Python 3.11 venv → 装依赖（去掉 `pyopenjtalk` / `jieba_fast`、
补 `pyopenjtalk-plus`、`resampy`）→ 打两个补丁（`patches/` 里都有）→ 写 `gsv-local.yaml` → 起 `api_v2.py`。

**不需要重训模型**，权重直接从旧机器拷。

### 5. 把路径对上

新建的机器用户名/盘符可能不同，逐项确认：

```powershell
# 这些默认值写在工作流里，路径不同就设环境变量或在 config 里改
$env:RVC_ROOT  = 'D:\RVC\RVC1006Nvidia'
$env:ASR_PY    = 'D:\asr\venv\Scripts\python.exe'
$env:GPT_SOVITS_URL = 'http://127.0.0.1:9880'
```

faster-whisper（gsv 模式取歌词时间轴、质量自检要用）：

```powershell
py -3.11 -m venv D:\asr\venv
D:\asr\venv\Scripts\python.exe -m pip install faster-whisper
$env:ASR_MODEL_DIR = 'D:\asr\models'
```

### 6. 接进 agent + 开机自启

MCP 注册（DSH 的写法，其它 agent 用标准 stdio 配置即可）：

```yaml
- insert:
    - id: qq-voice-tts
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: voice-tts
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args: ["C:\\Users\\<你>\\Documents\\qq-bridge\\src\\mcp-voice-tts.js"]
```

开机自启（QQ 网关 / 桥接 / TTS 都要起来）：

```powershell
# 登录时执行
$cmd = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\<你>\Documents\qq-bridge\start-stack.ps1"'
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'qq-bridge-stack' -Value $cmd
```

`start-stack.ps1` 和 `watchdog.ps1` 就在旧机器的 `qq-bridge` 目录里 —— 如果那两个文件没进仓库，
从旧机器 `Documents\qq-bridge\` 一起拷过来（它们跟本工作流配套）。

### 7. 验证清单

```powershell
# 1) GPU 可见
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# 2) GPT-SoVITS 在线
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:9880/docs     # 期望 200

# 3) 合成不是静音（关键）
#    用 docs/setup-gsv.md 第 7 节的 payload.json
ffprobe -v error -show_entries stream=sample_rate -show_entries format=duration -of default=nw=1 out.wav
ffmpeg -i out.wav -af volumedetect -f null - 2>&1 | Select-String "max_volume"   # 不能是 -inf

# 4) RVC 能跑
D:\RVC\RVC1006Nvidia\runtime\python.exe D:\RVC\RVC1006Nvidia\tools\infer_cli.py --help | Select-Object -First 3

# 5) 桥接 + 网关
curl.exe -s http://127.0.0.1:3100/api/status -H "x-console-token: <你的 consoleToken>"
#   看 snowluma.connected / good / dshReady
```

---

## 方案 B：完全从零（没有旧机器可拷）

1. 按上面的第 2 步装 Node / Python 3.11 / RVC。
2. `git clone` 本仓库 → 按 [setup-gsv.md](setup-gsv.md) 装 GPT-SoVITS、下 HuggingFace 预训练权重。
3. 音色模型：去模型作者页面下载 `.pth` + `.index`，或自己用 GPT-SoVITS 训练（需要 30 分钟以上的干净录音）。
4. 参考音频：自己录 3~10 秒，写逐字对应的 `ref/REF_TEXT.txt` 和 `ref/REF_LANG.txt`。
5. `config.example.json` → `config.json`，填 QQ 号、网关令牌、`consoleToken`。
6. 验证清单同上。

---

## 常见坑（换机器时最容易中）

| 现象 | 原因 |
|---|---|
| `AssertionError` 启动就崩 | GPT-SoVITS 源码没打 `patches/gsv-version-assertion.patch`，见 setup-gsv.md 第 4 节 |
| `No module named 'jieba_fast'` | 垫片没放进 venv 的 site-packages |
| 合成出来 1 秒 / 16 kHz / 无声 | 权重开头的版本头（`06`/`05`）被改成 `PK` 了，或服务跑在旧代码目录 |
| 语音能出但没声音 | `ref/REF_TEXT.txt` 和 `reference.wav` 不匹配 |
| 群消息收不到但状态 `good: true` | 那是网关自评；要看 `snowluma.connected` |
| 点歌报 `normalize not found` | 用了带 `normalize` 参数的 amix；仓库版本已去掉 |
| 显存 OOM | 本地聊天模型和 RVC/GSV 同时常驻；确认 `RVC_MIN_FREE_MIB` 逻辑生效 |
| 迁移后 `venv` 直接拷过来不能用 | venv 里写死了旧路径的解释器，必须在新机器重建 |
