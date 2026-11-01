---
'cuttingfloor': patch
---

A nested timeline now renders inside another exactly as it does alone. Its picture and its linked sound were played from one shared renderer, which dropped inner scale and crop and lost overlay tracks; each use now has its own.
