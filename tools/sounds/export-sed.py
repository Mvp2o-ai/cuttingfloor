# Exports a PretrainedSED frame-level MobileNet (MIT, github.com/fschmid56/PretrainedSED,
# arXiv 2409.09546) to ONNX for media.analyze sounds, mel front end included, so the graph
# takes 10 s of 16 kHz mono and gives the 447 AudioSet-strong class probabilities per 40 ms.
# The front end's STFT is a convolution here, which ONNX can export; the export checks itself
# against the original model.
#
#   python3 export-sed.py REPO CHECKPOINT NAME OUT.onnx
#
# REPO is a checkout of PretrainedSED, CHECKPOINT its frame_mn*_strong_1.pt (checked by the
# caller), NAME frame_mn10 or frame_mn06.
import sys

import numpy as np
import onnxruntime as ort
import torch
import torchaudio

repo, checkpoint, name, out = sys.argv[1:5]
sys.path.insert(0, repo)

from data_util import audioset_classes  # noqa: E402
from models.frame_mn.Frame_MN_wrapper import FrameMNWrapper  # noqa: E402
from models.frame_mn.utils import NAME_TO_WIDTH  # noqa: E402
from models.prediction_wrapper import PredictionsWrapper  # noqa: E402

base = FrameMNWrapper(NAME_TO_WIDTH(name))
embed_dim = base.state_dict()["frame_mn.features.16.1.bias"].shape[0]
model = PredictionsWrapper(base, checkpoint=None, embed_dim=embed_dim)
state = torch.load(checkpoint, map_location="cpu", weights_only=True)
missing, unexpected = model.load_state_dict(state, strict=False)
assert not unexpected and all("mel" in k for k in missing), (missing, unexpected)
model.eval()


class DftMel(torch.nn.Module):
    """The model's own mel front end (AugmentMelSTFT in eval mode) with the STFT as a
    convolution: same window, padding, mel banks and normalisation."""

    def __init__(self, mel):
        super().__init__()
        n_fft, win = mel.n_fft[0], mel.win_length[0]
        window = getattr(mel, f"window_{win}")
        left = (n_fft - win) // 2
        padded = torch.zeros(n_fft)
        padded[left : left + win] = window
        k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)[:, None]
        n = torch.arange(n_fft, dtype=torch.float64)[None, :]
        angle = 2 * torch.pi * k * n / n_fft
        self.register_buffer("cos", (torch.cos(angle) * padded).float()[:, None, :])
        self.register_buffer("sin", (-torch.sin(angle) * padded).float()[:, None, :])
        banks, _ = torchaudio.compliance.kaldi.get_mel_banks(
            mel.n_mels, n_fft, mel.sr, mel.fmin, mel.fmax,
            vtln_low=100.0, vtln_high=-500.0, vtln_warp_factor=1.0,
        )
        self.register_buffer("banks", torch.nn.functional.pad(banks, (0, 1)))
        self.register_buffer("pre", mel.preemphasis_coefficient)
        self.hop, self.half = mel.hopsize, n_fft // 2
        assert mel.preamp and mel.padding == "center" and mel.fast_norm

    def forward(self, wave):
        x = torch.nn.functional.conv1d(wave.unsqueeze(1), self.pre)
        x = torch.nn.functional.pad(x, (self.half, self.half), mode="reflect")
        re = torch.nn.functional.conv1d(x, self.cos, stride=self.hop)
        im = torch.nn.functional.conv1d(x, self.sin, stride=self.hop)
        power = re * re + im * im
        mels = torch.log(torch.clip(torch.matmul(self.banks, power), min=1e-7))
        return ((mels + 4.5) / 5.0).unsqueeze(1)


class Sed(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
        self.mel = DftMel(m.model.mel)

    def forward(self, wave):
        strong, _ = self.m(self.mel(wave))
        return torch.sigmoid(strong)


net = Sed(model).eval()
wave = torch.randn(1, 160_000) * 0.1
with torch.no_grad():
    mel_ref = model.mel_forward(wave)
    mel_err = float((net.mel(wave) - mel_ref).abs().max())
    assert mel_err < 1e-3, mel_err
    ref = torch.sigmoid(model(mel_ref)[0])
assert ref.shape == (1, len(audioset_classes.as_strong_train_classes), 250), ref.shape
torch.onnx.export(
    net,
    (wave,),
    out,
    input_names=["wave"],
    output_names=["probabilities"],
    dynamic_axes={"wave": {0: "batch"}, "probabilities": {0: "batch"}},
    opset_version=17,
    dynamo=False,
)
got = ort.InferenceSession(out).run(None, {"wave": wave.numpy()})[0]
err = float(np.abs(got - ref.numpy()).max())
assert err < 1e-3, err
print(f"{name}: {out} max diff {err:.2e}")
