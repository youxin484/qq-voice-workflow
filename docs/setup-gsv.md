# 安装 GPT-SoVITS（v2ProPlus）

目标是：本地 `127.0.0.1:9880` 起一个 `api_v2`，能接受 `/tts` 请求，支持「中文文本 + 日文参考音频」这种跨语种合成。

## 1. 源码与 Python 环境

```powershell
git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git
cd GPT-SoVITS

# 用独立 Python 3.11（3.13 装不上 torch/pyopenjtalk 那套）
py -3.11 -m venv ..\venv
..\venv\Scripts\python.exe -m pip install -U pip wheel
```

## 2. 依赖（有坑，按下面来）

官方 `requirements.txt` 里有两行在 Windows 上装不动，先剔掉：

```powershell
grep -v "^--no-binary=opencc" requirements.txt |
  grep -v -i "^pyopenjtalk" |
  grep -v -i "^jieba_fast" > req.txt
```

- `--no-binary=opencc` 会尝试源码编译 opencc，Windows 没装 MSVC 必失败 → 用预编译 wheel。
- `pyopenjtalk` 要 cmake + C++ 工具链 → 改用有 wheel 的 fork：

```powershell
..\venv\Scripts\python.exe -m pip install pyopenjtalk-plus
```

`pyopenjtalk-plus` 装的模块名仍然是 `pyopenjtalk`，代码不用改。

- `jieba_fast` 没有 cp311 wheel → 用垫片（丢到 venv 的 `Lib/site-packages/jieba_fast.py`）：

```python
import sys, jieba
sys.modules[__name__] = jieba
```

然后：

```powershell
..\venv\Scripts\python.exe -m pip install -r req.txt
..\venv\Scripts\python.exe -m pip install resampy      # 新版 api_v2 需要
```

> 新版上游代码还要求 `torch >= 2.6`（transformers 的安全检查，CVE-2025-32434）：
> `pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124`

## 3. 预训练权重

从 HuggingFace `lj1995/GPT-SoVITS` 拉，落到 `GPT_SoVITS/pretrained_models/`：

| 文件 | 用途 |
|---|---|
| `chinese-hubert-base/` | 语义特征 |
| `chinese-roberta-wwm-ext-large/` | 文本特征 |
| `s1v3.ckpt` | GPT（Pro/ProPlus 共用） |
| `s2Gv2ProPlus.pth` | SoVITS 底模（LoRA 微调时必需） |
| `v2Pro/s2Gv2ProPlus.pth`、`sv/pretrained_eres2netv2w24s4ep4.ckpt` | ProPlus 用 |

```powershell
$B = 'https://huggingface.co/lj1995/GPT-SoVITS/resolve/main'
foreach ($f in @(
  'chinese-roberta-wwm-ext-large/config.json','chinese-roberta-wwm-ext-large/tokenizer.json','chinese-roberta-wwm-ext-large/pytorch_model.bin',
  'chinese-hubert-base/config.json','chinese-hubert-base/preprocessor_config.json','chinese-hubert-base/pytorch_model.bin',
  's1v3.ckpt','v2Pro/s2Gv2ProPlus.pth','sv/pretrained_eres2netv2w24s4ep4.ckpt')) {
  New-Item -ItemType Directory -Force (Split-Path "GPT_SoVITS/pretrained_models/$f") | Out-Null
  curl.exe -L -o "GPT_SoVITS/pretrained_models/$f" "$B/$f"
}
```

## 4. 修一个上游 bug：v2Pro / v2ProPlus 必定断言失败

`GPT_SoVITS/TTS_infer_pack/TTS.py` 里先 `.lower()` 再和混合大小写的列表比较：

```python
version = configs.get("version", "v2").lower()
assert version in ["v1", "v2", "v3", "v4", "v2Pro", "v2ProPlus"]   # "v2pro" 永远不在里面
```

改成大小写无关并还原规范名（后面 `self.version` 用的是精确比较）：

```python
_CANON = {n.lower(): n for n in ["v1","v2","v3","v4","v2Pro","v2ProPlus"]}
version = _CANON.get(str(configs.get("version","v2")).strip().lower(), "v2")
```

补丁见 [../patches/gsv-version-assertion.patch](../patches/gsv-version-assertion.patch)。

## 5. 推理配置

```yaml
# gsv-local.yaml
version: v2ProPlus
custom:
  device: cuda
  is_half: true
  t2s_weights_path: GPT_SoVITS/pretrained_models/roxy/Roxy3.0.ckpt   # 你的 GPT 微调
  vits_weights_path: GPT_SoVITS/pretrained_models/roxy/Roxy3.0.pth   # 你的 SoVITS 微调
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
```

启动：

```powershell
$env:PATH = "D:\RVC\RVC1006Nvidia;$env:PATH"   # 提供 ffmpeg
..\venv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c gsv-local.yaml
```

## 6. 微调权重的前两个字节

社区分发的 SoVITS 权重开头是 `06` / `05` 这样的**版本头**，不是 `PK`：

```python
head2version = {
  b"05": ["v2", "v2Pro", False],
  b"06": ["v2", "v2ProPlus", False],
  ...
}
```

**不要**把它补成 `PK`！补了之后加载器会走「按体积猜版本」的老路径，把 ProPlus 当成 v2 加载 → 合成出 1 秒 16 kHz 的全零音频（体积还达标，很容易被当成成功）。加载器自己会补 `PK` 再解包，保持原样即可。

## 7. 自检

```powershell
curl.exe -s -o out.wav -X POST http://127.0.0.1:9880/tts -H "content-type: application/json" `
  --data-binary "@payload.json" -w "%{http_code} %{time_total}s`n"

# payload.json
{
  "text": "你好，这是一次自检。",
  "text_lang": "zh",
  "ref_audio_path": "C:/path/to/ref/reference.wav",
  "prompt_text": "（与参考音频逐字一致）",
  "prompt_lang": "ja",
  "media_type": "wav",
  "streaming_mode": false
}
```

期望：`200`、`32 kHz`、时长与文本长度相称、峰值不为 0。

```powershell
ffprobe -v error -show_entries stream=sample_rate -show_entries format=duration -of default=nw=1 out.wav
ffmpeg -i out.wav -af volumedetect -f null - 2>&1 | Select-String "max_volume"
```
