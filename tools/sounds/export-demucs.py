# Exports Demucs v4 (htdemucs, MIT code and weights, github.com/facebookresearch/demucs) to ONNX
# for create.stems. Demucs takes its STFT and inverse STFT inside the network, as complex
# numbers, which ONNX cannot export; here they are swapped for real-valued equivalents (the
# transform as a matrix product on frames, the inverse as a matrix product and overlap-add),
# with complex spectra carried as a trailing (real, imaginary) pair. Everything else is the
# original model. The graph takes one 7.8 s training segment of 44.1 kHz stereo and returns
# the four sources (drums, bass, other, vocals); the caller splits, overlaps and normalises
# as demucs.apply does. The export checks itself against the original model.
#
#   python3 export-demucs.py CHECKPOINT OUT.onnx
import math
import sys
from fractions import Fraction

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from demucs.htdemucs import HTDemucs
from demucs.states import set_state

checkpoint, out = sys.argv[1:3]
package = torch.load(checkpoint, map_location="cpu", weights_only=False)
assert package["klass"].__name__ == "HTDemucs", package["klass"]


def load():
    m = HTDemucs(*package["args"], **package["kwargs"])
    set_state(m, package["state"])
    return m.eval()


model = load()
assert model.cac and model.use_train_segment and model.hop_length == model.nfft // 4
N = model.nfft
HOP = model.hop_length
FREQS = N // 2 + 1
LENGTH = int(model.segment * model.samplerate)

k = torch.arange(FREQS, dtype=torch.float64)[:, None]
n = torch.arange(N, dtype=torch.float64)[None, :]
angle = 2 * math.pi * k * n / N
WINDOW = torch.hann_window(N, dtype=torch.float64)
# torch.stft(normalized=True): the windowed DFT over sqrt(N).
FWD_RE = (torch.cos(angle) * WINDOW / math.sqrt(N)).T.contiguous().float()  # (N, F)
FWD_IM = (-torch.sin(angle) * WINDOW / math.sqrt(N)).T.contiguous().float()
# torch.istft(normalized=True): times sqrt(N), irfft (1/N, inner bins twice), windowed.
c = torch.full((FREQS, 1), 2.0, dtype=torch.float64)
c[0] = c[-1] = 1.0
INV_RE = (c * torch.cos(angle) * math.sqrt(N) / N * WINDOW).float()  # (F, N)
INV_IM = (-c * torch.sin(angle) * math.sqrt(N) / N * WINDOW).float()


def stft(x):
    """torch.stft(normalized, centred, reflect, hann) of (R, L) as (R, F, T, 2)."""
    x = F.pad(x.unsqueeze(1), (N // 2, N // 2), mode="reflect").squeeze(1)
    t = 1 + (x.shape[-1] - N) // HOP
    idx = torch.arange(t)[:, None] * HOP + torch.arange(N)[None, :]
    frames = x[:, idx]
    re = torch.matmul(frames, FWD_RE)
    im = torch.matmul(frames, FWD_IM)
    return torch.stack([re, im], dim=-1).transpose(1, 2)


def istft(z, length):
    """torch.istft(normalized, centred, hann, length) of (R, F, T, 2)."""
    re, im = z[..., 0].transpose(1, 2), z[..., 1].transpose(1, 2)  # (R, T, F)
    frames = torch.matmul(re, INV_RE) + torch.matmul(im, INV_IM)  # (R, T, N)
    r, t, _ = frames.shape
    parts = frames.reshape(r, t, N // HOP, HOP)
    total = (t - 1) * HOP + N
    y = 0
    for j in range(N // HOP):
        piece = parts[:, :, j, :].reshape(r, t * HOP)
        y = y + F.pad(piece, (j * HOP, total - t * HOP - j * HOP))
    env = torch.zeros(total, dtype=torch.float64)
    for i in range(t):
        env[i * HOP : i * HOP + N] += WINDOW**2
    y = y / env.float().clamp(min=1e-11)
    return y[:, N // 2 : N // 2 + length]


def _spec(self, x):
    le = int(math.ceil(x.shape[-1] / HOP))
    pad = HOP // 2 * 3
    x = F.pad(x, (pad, pad + le * HOP - x.shape[-1]), mode="reflect")
    *other, length = x.shape
    z = stft(x.reshape(-1, length))
    z = z.reshape(*other, FREQS, -1, 2)[..., :-1, :, :]
    return z[..., 2 : 2 + le, :]


def _magnitude(self, z):
    b, ch, fr, t, _ = z.shape
    return z.permute(0, 1, 4, 2, 3).reshape(b, ch * 2, fr, t)


def _mask(self, z, m):
    b, s, ch, fr, t = m.shape
    return m.view(b, s, -1, 2, fr, t).permute(0, 1, 2, 4, 5, 3)


def _ispec(self, z, length=None, scale=0):
    z = F.pad(z, (0, 0, 0, 0, 0, 1))
    z = F.pad(z, (0, 0, 2, 2))
    pad = HOP // 2 * 3
    le = HOP * int(math.ceil(length / HOP)) + 2 * pad
    *other, fr, t, _ = z.shape
    x = istft(z.reshape(-1, fr, t, 2), le).reshape(*other, le)
    return x[..., pad : pad + length]


reference = load()
for name, fn in [("_spec", _spec), ("_magnitude", _magnitude), ("_mask", _mask), ("_ispec", _ispec)]:
    setattr(model, name, fn.__get__(model))
model.segment = Fraction(model.segment)

mix = torch.randn(1, 2, LENGTH) * 0.1
with torch.no_grad():
    ref = reference(mix)
    err = float((ref - model(mix)).abs().max())
assert err < 1e-3, err
torch.onnx.export(
    model,
    (mix,),
    out,
    input_names=["mix"],
    output_names=["sources"],
    opset_version=17,
    dynamo=False,
)
got = ort.InferenceSession(out).run(None, {"mix": mix.numpy()})[0]
err2 = float(np.abs(got - ref.numpy()).max())
assert err2 < 1e-3, err2
print(f"htdemucs: {out} sources {model.sources}, {LENGTH} samples, diff {err:.2e} / {err2:.2e}")
