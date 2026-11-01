---
'cuttingfloor': patch
---

Media whose frame rates drift apart by a fraction of a percent (screen and game recorders), whose frame count doesn't fit its length, or whose rate isn't a standard one is now conformed to a constant rate on import (conform `vfr`), so its fps and frame numbers are true. Before, a 20.36 fps recording was called 20 fps without being retimed.
