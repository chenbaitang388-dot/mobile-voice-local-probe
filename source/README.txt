Synthetic spectral model source

generate_spectral_models.py contains the complete RealSpectral, RealStft and
RealIstft definitions used for the two candidate_real_*.onnx files. All graph
initializers are produced from trigonometric formulas and the Hann window;
there is no checkpoint, recording, user path, private reference, or model fetch.

To rebuild in a separate developer environment with PyTorch and ONNX installed:

  python source/generate_spectral_models.py

The original development export used PyTorch's legacy ONNX exporter at opset 17,
with input shapes wave=[1,256] and magnitude/phase=[1,9,65]. Exporter version
changes can change binary hashes without changing the mathematical graph.
The recorded export environment was Python 3.11.17, PyTorch 2.11.0+cu128,
ONNX 1.23.1 and ONNX Runtime 1.22.0. Only CPU tensors were used. The CUDA
package suffix does not mean that the browser or the rebuild requires CUDA.
The browser test checks numerical results; byte-identical regeneration across
different PyTorch versions is not promised. Rebuilding is not needed on iPhone.

The original experimental probe also compared methods dynamically extracted
from a local HiFT checkout. That private-path comparison harness and its reports
are deliberately excluded; the complete actual candidate and export path are
included here. Runtime inference uses only the exported public mathematical
graphs. See ../THIRD_PARTY_NOTICES.txt and ../licenses/Apache-2.0.txt.
