#!/usr/bin/env python3
"""Console entry point packaged for Chrome Native Messaging.

Chrome launches this executable directly from the native-host manifest.  It
must not write logs or banners to stdout because stdout is reserved for binary
Native Messaging frames.
"""

import sys

from openstill_desktop import DesktopApplication, default_data_dir, native_loop


if __name__ == "__main__":
    caller_origin = next((argument for argument in sys.argv[1:] if argument.startswith("chrome-extension://")), None)
    raise SystemExit(native_loop(DesktopApplication(default_data_dir()), caller_origin))
