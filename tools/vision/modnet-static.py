# Writes fixed-size copies of the MODNet matting model: OpenCV's DNN module can't run its
# dynamic-shape graph, and with the input and output sizes pinned it runs exactly.
#   python3 modnet-static.py MODEL OUT_DIR
import sys

import onnx
from onnx.tools import update_model_dims

SIZES = {"landscape": (288, 512), "portrait": (512, 288), "square": (512, 512)}

src, out = sys.argv[1], sys.argv[2]
for name, (h, w) in SIZES.items():
    model = onnx.load(src)
    fixed = update_model_dims.update_inputs_outputs_dims(
        model, {"input": [1, 3, h, w]}, {"output": [1, 1, h, w]}
    )
    onnx.checker.check_model(fixed)
    onnx.save(fixed, f"{out}/modnet-{name}.onnx")
