"""Writes the EdgeTAM parameters the video ONNX graphs leave to the caller, as JSON.

The memory bank is assembled outside the graphs (packages/engine/src/select-worker.ts). It needs
the temporal position table added to each memory block and the no-memory embedding added to the
seed frame's features. They come from the same checkpoint the graphs were exported from.

usage: python3 edgetam-constants.py <model.safetensors> <out.json>
"""

import json
import struct
import sys
from array import array

WANTED = ("memory_temporal_positional_encoding", "no_memory_embedding")

src, dest = sys.argv[1], sys.argv[2]
with open(src, "rb") as f:
    (n,) = struct.unpack("<Q", f.read(8))
    header = json.loads(f.read(n))
    base = 8 + n
    out = {}
    for name in WANTED:
        info = header[name]
        assert info["dtype"] == "F32", name
        start, end = info["data_offsets"]
        f.seek(base + start)
        values = array("f")
        values.frombytes(f.read(end - start))
        if sys.byteorder != "little":
            values.byteswap()
        out[name] = {"shape": info["shape"], "values": [float(v) for v in values]}
with open(dest, "w") as f:
    json.dump(out, f)
