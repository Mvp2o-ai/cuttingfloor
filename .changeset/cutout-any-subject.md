---
"cuttingfloor": minor
---

`create.cutout` cuts out any subject, not just people: `subject: "any"` uses BiRefNet lite (MIT, on ONNX Runtime) for products, animals and objects, and is the default for pictures; `subject: "people"` keeps MODNet, fast enough for video and the default there.
