Corresponding source for the two generic Seed-VC ONNX components

License: GPL-3.0. See GPL-3.0.txt and ../../COMPONENT_NOTICES.txt.
Upstream code commit: 51383efd921027683c89e5348211d93ff12ac2a8.
Hugging Face checkpoint revision: 257283f9f41585055e8f858fba4fd044e5caed6e.
The official model card itself states gpl-3.0; this is not inferred solely
from the GitHub code license.

This directory includes the exact six needed upstream modules, their source
hashes, config.yml, and the full standalone export_components.py recipe.
Only these component classes are instantiated; unrelated GUI, audio input,
speaker-reference extraction and cloud-download paths are not used.

Obtain the unmodified source checkpoint (142112203 bytes) at no charge:
https://huggingface.co/Plachta/Seed-VC/resolve/257283f9f41585055e8f858fba4fd044e5caed6e/DiT_uvit_tat_xlsr_ema.pth
SHA256: c853ea578b409f625f961bcb15d5cff1f8ef9a75f3209ec21d9b7c73ab422e88
Full original code:
https://github.com/Plachtaa/seed-vc/tree/51383efd921027683c89e5348211d93ff12ac2a8

Use a separate development environment. Recorded component exports used
Python 3.11.17, PyTorch 2.11.0+cu128 (CPU tensors), ONNX 1.23.1 and ONNX
Runtime 1.22.0. The conversion source also imports NumPy, PyYAML, munch,
einops and tqdm. No CUDA is needed to rebuild; no dependency or model is
automatically downloaded by this recipe.

  python export_components.py --checkpoint /your/local/DiT_uvit_tat_xlsr_ema.pth --component lr --output-dir ./exported
  python export_components.py --checkpoint /your/local/DiT_uvit_tat_xlsr_ema.pth --component dit --output-dir ./exported

The original source definitions and forward wrappers are retained. Changed
behavior is documented in source-provenance.json: defer an unused DAC import,
fix input shapes, rebuild two deterministic non-trained buffers, use integer
instead of bool token flags for ONNX export, and omit debug metadata.
All checkpoint trained keys are loaded strictly. The DiT wrapper uses a
synthetic 16-frame prompt and CFG 0.5; it is not the private fixed-voice graph.

This packaging phase syntax-checked the standalone recipe and compared its
forward wrappers to the original export source; it did not repeat an expensive
export. Prior exported graph computations were independently tested. Exporter
version/graph naming differences may change byte hashes; bit-identical rebuild
on an arbitrary toolchain is not promised. The phone does not run this Python
recipe: it only runs the optional exported graphs in the browser.
