# 安装 RVC（换音色 / 唱歌）

## 1. 包与目录约定

用 `RVC1006Nvidia` 之类的整合包（自带 ffmpeg、runtime/python.exe、rmvpe、UVR5 模型）。默认路径 `D:\RVC\RVC1006Nvidia`，可用 `RVC_ROOT` 覆盖。

```
RVC_ROOT/
  runtime/python.exe     # 跑 infer_cli.py 的解释器
  ffmpeg.exe ffprobe.exe
  assets/weights/<音色>.pth
  assets/indices/<音色>.index
  assets/rmvpe/rmvpe.pt
  tools/infer_cli.py     # 单文件变声
  tools/uvr_cli.py       # UVR5 分离
  song/                  # 点歌工作目录（临时文件）
```

## 2. 放音色模型

```powershell
Copy-Item <音色>.pth   "$env:RVC_ROOT\assets\weights\"
Copy-Item <音色>.index "$env:RVC_ROOT\assets\indices\"
```

然后在工作流里指定（或直接改默认值）：

```
RVC_MODEL=Roxy.pth
RVC_INDEX=D:\RVC\RVC1006Nvidia\assets\indices\Roxy.index
```

> `.pth` 是音色模型，`.index` 是特征检索库。两者要同源，否则音色会飘。
> 没有 `.index` 也能跑，只是相似度检索关闭，音色稳定性下降。

## 3. 单文件变声（工作流用的就是这条）

```powershell
$env:weight_root = "D:\RVC\RVC1006Nvidia\assets\weights"
runtime\python.exe tools\infer_cli.py `
  --input_path in.wav --opt_path out.wav `
  --model_name Roxy.pth --index_path assets\indices\Roxy.index `
  --f0up_key 0 --device cuda:0 --is_half True --f0method rmvpe
```

- `--f0up_key`：升降调半音数。说话用 0；唱歌按原唱音高自适应算（见 `docs/architecture.md`）。
- `--f0method rmvpe`：基频提取算法，比 harvest/pm 稳。
- 输出 40 kHz，混伴奏前统一转 44.1 kHz。

## 4. 分离人声/伴奏（点歌用）

```powershell
runtime\python.exe tools\uvr_cli.py <inputDir> <fileName> <vocalOutDir> <instrOutDir> HP2_all_vocals 10
```

产物命名是 `vocal_<name>.wav` / `instrument_<name>.wav`。`HP2_all_vocals.pth` 是纯人声分离模型，要求输入目录里只放当前这一首（它会扫整个目录）。

## 5. 定调

固定 +12 会把女声原曲顶破音。用 `tools/f0probe.py` 先测原唱基频：

```powershell
runtime\python.exe tools\f0probe.py vocal_xxx.wav
# {"ok": true, "p50": 221.4, "p95": 562.1, ...}
```

再按目标中位音高（默认 325 Hz）、上限（默认 640 Hz）算 `f0up_key`。工作流里已经自动化，见 `sing.mjs` 的「音高自适应」段。

## 6. 显存

RVC 跑起来约 2.5 GB。和本地聊天模型（8B/40k ≈ 8 GB）同卡时，跑 RVC 前要腾地方：

```powershell
# 让 Ollama 卸载聊天模型
curl.exe -s -X POST http://127.0.0.1:11434/api/generate `
  -H "content-type: application/json" -d '{\"model\":\"qq-local:8b\",\"keep_alive\":0}'
# 轮询到真正释放（要 5~15 秒）
curl.exe -s http://127.0.0.1:11434/api/ps
```

工作流会在跑之前先查 `nvidia-smi` 剩余显存，够用就跳过卸载（省 18 秒）。
