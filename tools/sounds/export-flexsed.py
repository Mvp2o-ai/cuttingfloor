# Exports FlexSED (MIT code and weights, github.com/JHU-LCAP/FlexSED, arXiv 2509.18606) to ONNX
# for media.listen: open-vocabulary sound event detection. The graph takes 10 s of 16 kHz mono
# and N query embeddings (CLAP htsat-unfused text embeddings of "The sound of <words>") and gives
# each query's probability per 40 ms. The mel front end is in the graph, its STFT as a
# convolution so ONNX can export it, and so is the peak normalisation FlexSED applies. The
# export checks itself against the original model.
#
#   python3 export-flexsed.py REPO CHECKPOINT OUT.onnx
import sys

import numpy as np
import onnxruntime as ort
import torch
import yaml

repo, checkpoint, out = sys.argv[1:4]
sys.path.insert(0, repo)

from src.models.sed_decoder import Decoder, TSED_Wrapper  # noqa: E402
from src.models.transformer import Dasheng_Encoder  # noqa: E402

with open(f"{repo}/src/configs/model.yml") as f:
    text = "\n".join(line for line in f if "!include" not in line)
params = yaml.safe_load(text)
model = TSED_Wrapper(
    Dasheng_Encoder(**params["encoder"]),
    Decoder(**params["decoder"]),
    params["ft_blocks"],
    params["frozen_encoder"],
)
state = torch.load(checkpoint, map_location="cpu", weights_only=False)
model.load_state_dict(state["model"])
model.eval()


class DftMel(torch.nn.Module):
    """torchaudio's MelSpectrogram (power 1, centred, reflect padding) with the STFT as a
    convolution: same window, mel banks and output."""

    def __init__(self, mel):
        super().__init__()
        spec = mel.spectrogram
        assert spec.center and spec.power == 1.0 and spec.pad_mode == "reflect"
        n_fft, win = spec.n_fft, spec.win_length
        left = (n_fft - win) // 2
        padded = torch.zeros(n_fft)
        padded[left : left + win] = spec.window
        k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)[:, None]
        n = torch.arange(n_fft, dtype=torch.float64)[None, :]
        angle = 2 * torch.pi * k * n / n_fft
        self.register_buffer("cos", (torch.cos(angle) * padded).float()[:, None, :])
        self.register_buffer("sin", (-torch.sin(angle) * padded).float()[:, None, :])
        self.register_buffer("fb", mel.mel_scale.fb.T.contiguous())
        self.hop, self.half = spec.hop_length, n_fft // 2

    def forward(self, wave):
        x = torch.nn.functional.pad(wave.unsqueeze(1), (self.half, self.half), mode="reflect")
        re = torch.nn.functional.conv1d(x, self.cos, stride=self.hop)
        im = torch.nn.functional.conv1d(x, self.sin, stride=self.hop)
        return torch.matmul(self.fb, torch.sqrt(re * re + im * im))


class Listen(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
        self.mel = DftMel(m.encoder.front_end[0])

    def forward(self, wave, query):
        wave = wave / (wave.abs().amax(dim=-1, keepdim=True) + 1e-9)
        n = query.shape[1]
        logits = self.m(self.mel(wave), query)  # (B*N, 1, T)
        return torch.sigmoid(logits.reshape(wave.shape[0], n, -1))


net = Listen(model).eval()
wave = torch.randn(1, 160_000) * 0.1
query = torch.randn(1, 3, 512)
with torch.no_grad():
    mel_err = float((net.mel(wave) - model.forward_to_spec(wave)).abs().max())
    assert mel_err < 1e-2, mel_err
    w = wave / (wave.abs().max() + 1e-9)
    ref = torch.sigmoid(model(model.forward_to_spec(w), query)).reshape(1, 3, -1)
    assert ref.shape == (1, 3, 250), ref.shape
torch.onnx.export(
    net,
    (wave, query),
    out,
    input_names=["wave", "query"],
    output_names=["probabilities"],
    dynamic_axes={"query": {1: "queries"}, "probabilities": {1: "queries"}},
    opset_version=17,
    dynamo=False,
)
got = ort.InferenceSession(out).run(None, {"wave": wave.numpy(), "query": query.numpy()})[0]
err = float(np.abs(got - ref.numpy()).max())
assert err < 1e-3, err
print(f"flexsed: {out} mel diff {mel_err:.2e}, max diff {err:.2e}")
