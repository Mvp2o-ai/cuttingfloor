# Exports Real-ESRGAN's compact general model (realesr-general-x4v3, BSD-3-Clause,
# github.com/xinntao/Real-ESRGAN) to ONNX for create.upscaled: RGB 0-1 in, four times the size
# out, any height and width. Real-ESRGAN's own denoise strength is a blend of the weights of
# realesr-general-x4v3 (strong) and realesr-general-wdn-x4v3 (weak); each strength is its own
# file. The network is SRVGGNetCompact as realesrgan/archs/srvgg_arch.py defines it, loaded
# strictly from the checkpoints; the export checks itself against the PyTorch model.
#
#   python3 export-realesrgan.py STRONG.pth WEAK.pth STRENGTH OUT.onnx
import sys

import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F

strong, weak, strength, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]


class SRVGGNetCompact(nn.Module):
    def __init__(self, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(3, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, 3 * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        y = x
        for layer in self.body:
            y = layer(y)
        y = self.upsampler(y)
        return y + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


def params(path):
    state = torch.load(path, map_location="cpu", weights_only=True)
    return state["params"] if "params" in state else state


a, b = params(strong), params(weak)
assert a.keys() == b.keys()
blended = {k: strength * a[k] + (1 - strength) * b[k] for k in a}
model = SRVGGNetCompact()
model.load_state_dict(blended, strict=True)
model.eval()

example = torch.rand(1, 3, 64, 96)
torch.onnx.export(
    model,
    (example,),
    out,
    input_names=["image"],
    output_names=["upscaled"],
    dynamic_axes={"image": {2: "height", 3: "width"}, "upscaled": {2: "height4", 3: "width4"}},
    opset_version=17,
    dynamo=False,
)

check = torch.rand(1, 3, 45, 70)
with torch.no_grad():
    want = model(check).numpy()
got = ort.InferenceSession(out).run(None, {"image": check.numpy()})[0]
assert got.shape == (1, 3, 180, 280), got.shape
err = float(np.abs(got - want).max())
assert err < 1e-3, err
print(f"{out}: strength {strength}, max difference {err:.2e}")
