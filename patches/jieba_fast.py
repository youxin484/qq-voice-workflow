# jieba_fast shim
#
# GPT-SoVITS 的 text/tone_sandhi.py 里写的是 `import jieba_fast as jieba`，
# 但 jieba_fast 没有 cp311 的预编译 wheel，Windows 上装它需要 MSVC + C++ 工具链。
# 把它放到 venv 的 Lib/site-packages/jieba_fast.py，import 就会直接拿到纯 Python 的 jieba
# （接口兼容，只是分词慢一点，对 TTS 推理没有可感知影响）。
import sys

import jieba

sys.modules[__name__] = jieba
