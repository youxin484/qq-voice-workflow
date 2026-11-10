# 排障手册

按「症状 → 原因 → 处理」组织。这些都是实际踩过的坑。

## 1. 发出去的语音没声音（静音）

**症状**：QQ 里能看到语音条，时长也有，但听不到任何内容。

**原因**：GPT-SoVITS 返回了「1 秒 / 16 kHz / 全 0」的 WAV。体积 32 044 字节，比 `> 1000 字节` 的旧校验大得多，所以能蒙混过关。

**两条根因**：

1. **SoVITS 权重的版本头被改坏**。社区权重开头是 `06`（= v2ProPlus），加载器靠它决定架构。把它补成 `PK` 就会走「按体积猜版本」的老路径，ProPlus 被当 v2 加载，输出全零。
   → 保持原始字节，不要手工修 `PK`。

2. **服务跑在旧代码上**。`watchdog` 之类的外部脚本如果把启动路径指向旧目录（旧代码不认识新权重），服务一起来就是坏的。
   → 检查 9880 进程的命令行 `cwd` 是不是你期望的目录。

**现在的护栏**：`mcp-voice-tts.js` 按 WAV 头算真实时长，短于 `字数 × 0.08 秒` 直接判失败，不会发出去。

**自检**：

```powershell
ffprobe -v error -show_entries stream=sample_rate -show_entries format=duration -of default=nw=1 out.wav
ffmpeg -i out.wav -af volumedetect -f null - 2>&1 | Select-String "max_volume"   # 别是 -inf
```

## 2. 合成出来只有 1 秒 / 16 kHz

同上第 1 条：架构识别错了。确认权重开头字节：

```powershell
Get-Content -AsByteStream -TotalCount 2 .\Roxy3.0.pth   # 应该是 48 54（即 "06"），不是 80 75（"PK"）
```

## 3. `AssertionError`（版本断言）

```
version = configs.get("version", "v2").lower()
assert version in ["v1","v2","v3","v4","v2Pro","v2ProPlus"]
```

上游 bug：小写永远匹配不上 `v2Pro`。见 `docs/setup-gsv.md` 第 4 节。

## 4. `ModuleNotFoundError: No module named 'jieba_fast'`

没有 C++ 工具链编不出 `jieba_fast`。放垫片到 site-packages：

```python
# Lib/site-packages/jieba_fast.py
import sys, jieba
sys.modules[__name__] = jieba
```

## 5. `Cache directory not found ... pretrained_models/fast_langdetect`

新版代码把 fast_langdetect 的 cache_dir 指到这个目录却没建。手动建一次，它首次会自动下载模型：

```powershell
New-Item -ItemType Directory -Force GPT_SoVITS\pretrained_models\fast_langdetect
```

## 6. `No module named 'resampy'`

```powershell
pip install resampy
```

## 7. `ValueError: ... require users to upgrade torch to at least v2.6`

transformers 的 CVE-2025-32434 硬检查。

```powershell
pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
```

## 8. `Option 'normalize' not found`（点歌失败）

RVC 自带的 ffmpeg 构建没有 `amix` 的 `normalize` 参数。工作流已去掉该参数，并且单段音频不走 amix（走 `atrim + apad`）。

## 9. 语音明显变慢（比平时多十几秒）

**原因**：发语音前无条件卸载本地聊天模型 + 轮询 `/api/ps`，最多白等 18 秒。

**现在的处理**：先查 `nvidia-smi` 剩余显存，`≥ RVC_MIN_FREE_MIB`(4500) 直接开跑；不够才卸载。唱歌阈值是 `SING_MIN_FREE_MIB`(6000)。

## 10. 点歌要等一分钟才回复

默认 `SYNC_SING=0`：工具立刻返回「已经开唱了」，渲染在后台跑，唱完自动发语音。想要旧行为（等唱完再返回）：`SYNC_SING=1`。

## 11. 群里 @ 它没反应，但桥接进程活着、状态接口 good

**症状**：QQ 网关正常、`/api/status` 里 `good: true`，但一条消息都收不到。

**原因**：`good` 是 **SnowLuma 对「QQ→hook」链路的自评**，不代表「桥接 ↔ SnowLuma 的 WebSocket 连上了」。真正要看的是 `connected` 字段。

**处理**：

1. 看 `connected`：
   ```bash
   curl -s http://127.0.0.1:3100/api/status -H "x-console-token: $(cat state/console-token)" \
     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.snowluma.connected,j.snowluma.good)})"
   ```
2. `false` 就重启桥接；如果反复，检查网关的 HTTP token（默认 3000 端口）是否可用——WS token 与 HTTP token 是两个不同的值。
3. 工作流里的护栏：桥接内部每 60 秒 `connect()` 重试；外部看门狗发现 `connected === false` 超过 3 分钟会重启桥接。

## 12. 看门狗自己「消失」

**症状**：桥接/TTS 挂了没人拉，`watchdog.log` 在某一行之后不再增长。

**原因**：看门狗循环里调外部命令（如端口同步脚本）没有超时，子进程卡住就把整个循环冻住。

**处理**：所有外部调用都要有硬超时（PowerShell 用 `System.Diagnostics.Process` + `WaitForExit(ms)`），每圈写一行 `tick` 心跳便于判断是否卡死；再用计划任务每 5 分钟兜底拉起看门狗本身。

## 13. 参考音频对了，但音色还是不对

检查三件事：

1. `ref/REF_TEXT.txt` 与 `reference.wav` **逐字一致**（含标点/语气词）。
2. `ref/REF_LANG.txt` 写对（日文 `ja`、中文 `zh`）。用中文 G2P 解析日文参考文本会直接崩。
3. 参考音频 3~10 秒、单人、无背景音乐。

## 14. 跨语种合成没问题，但中文发音怪

微调模型如果只在日文语料上训练（很常见），说中文时音色对、个别字会飘。这是模型本身的限制，不是流水线问题。缓解：换中文语料更足的模型，或在 `text_lang` 上试 `all_zh`。
