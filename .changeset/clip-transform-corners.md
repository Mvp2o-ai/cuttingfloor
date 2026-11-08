---
'@cuttingfloor/schema': minor
'@cuttingfloor/core': minor
'@cuttingfloor/engine': minor
'@cuttingfloor/server': minor
---

clip.set_transform takes `corners`: four points in the fitted frame the picture maps onto, keyframable with the same ease machinery as the other fields. The bundled avfilter perspective filter renders it, and a warped clip's placement reports the quad instead of only its box.
