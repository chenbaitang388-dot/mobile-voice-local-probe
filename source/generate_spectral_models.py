# SPDX-License-Identifier: Apache-2.0
# Real-valued spectral operator implementation for this compatibility probe.
# This mathematical candidate was written for the probe. It contains no trained
# parameters or user/reference audio. It matches the n_fft=16/hop=4/periodic-Hann
# configuration compared against Apache-2.0 HiFT spectral methods.
# Corresponding upstream credit: Copyright (c) 2024 Alibaba Inc
# (authors: Xiang Lyu, Kai Hu), modules/hifigan/generator.py in Plachtaa/seed-vc.
# Changes: replace complex FFT arithmetic with fixed real convolution kernels;
# include only the public operator definitions and standalone ONNX export.
# License text: ../licenses/Apache-2.0.txt. Provenance: ../THIRD_PARTY_NOTICES.txt.
# This source never reads checkpoints, voice data, paths outside its output
# directory, or the network. Dependencies are developer-installed torch/onnx.
from pathlib import Path
import torch
from torch import nn
from torch.nn import functional as F

class RealSpectral(nn.Module):
    """Same n_fft=16/hop=4/periodic Hann/centered policy, real arithmetic only."""
    def __init__(self):
        super().__init__()
        n = torch.arange(16, dtype=torch.float64)
        k = torch.arange(9, dtype=torch.float64)[:, None]
        theta = 2 * torch.pi * k * n / 16
        window = torch.hann_window(16, periodic=True, dtype=torch.float64)
        forward = torch.cat((torch.cos(theta), -torch.sin(theta)), dim=0) * window
        self.register_buffer("forward_kernel", forward.float()[:, None, :])
        factors = torch.tensor([1, 2, 2, 2, 2, 2, 2, 2, 1], dtype=torch.float64)[:, None] / 16
        inverse = torch.cat((torch.cos(theta) * factors, -torch.sin(theta) * factors), dim=0) * window
        self.register_buffer("inverse_kernel", inverse.float()[:, None, :])
        self.register_buffer("window_power", (window ** 2).float()[None, None, :])

    def stft(self, x):
        x = F.pad(x[:, None, :], (8, 8), mode="reflect")
        y = F.conv1d(x, self.forward_kernel, stride=4)
        return y[:, :9, :], y[:, 9:, :]

    def istft(self, magnitude, phase):
        magnitude = torch.clamp(magnitude, max=100)
        real = magnitude * torch.cos(phase)
        imag = magnitude * torch.sin(phase)
        spectrum = torch.cat((real, imag), dim=1)
        result = F.conv_transpose1d(spectrum, self.inverse_kernel, stride=4)
        weight = F.conv_transpose1d(torch.ones_like(magnitude[:, :1, :]), self.window_power, stride=4)
        return (result[:, 0, 8:-8] / weight[:, 0, 8:-8])

class RealStft(RealSpectral):
    def forward(self, x):
        return self.stft(x)

class RealIstft(RealSpectral):
    def forward(self, magnitude, phase):
        return self.istft(magnitude, phase)

def main():
    torch.set_num_threads(1)
    target = Path(__file__).resolve().parent.parent / "models"
    target.mkdir(exist_ok=True)
    wave = torch.sin(torch.arange(256, dtype=torch.float32) * 0.12)[None, :]
    with torch.inference_mode():
        real, imag = RealStft().eval()(wave)
        magnitude = torch.sqrt(real * real + imag * imag)
        phase = torch.atan2(imag, real)
        cases = [
            ("candidate_real_stft.onnx", RealStft(), (wave,), ["wave"], ["real", "imag"]),
            ("candidate_real_istft.onnx", RealIstft(), (magnitude, phase), ["magnitude", "phase"], ["wave"]),
        ]
        for name, model, inputs, input_names, output_names in cases:
            torch.onnx.export(model.eval(), inputs, str(target / name),
                opset_version=17, dynamo=False, input_names=input_names, output_names=output_names)

if __name__ == "__main__":
    main()
