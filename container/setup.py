"""Best-effort repository setup, adapted to the sandbox's ordinary local checkout."""
import os
from pathlib import Path
import subprocess
import sys
import fcntl
from dependency_cache import eligible_key, publish, restore
from package_manager import selected_manager, install_command

# The DO may be evicted while its container remains alive. Join the original
# attempt and replay its result instead of running two installers in one tree.
# Direct invocations without --once remain useful for deliberate reinstalls.
if "--once" in sys.argv:
    with open("/workspace/setup.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = Path("/workspace/setup.exit")
        log = Path("/workspace/setup.log")
        if not result.exists():
            with log.open("wb") as output:
                completed = subprocess.run([sys.executable, __file__], stdout=output, stderr=subprocess.STDOUT)
            result.write_text(str(completed.returncode))
        with log.open("rb") as output:
            while chunk := output.read(32768):
                sys.stdout.buffer.write(chunk)
        sys.exit(int(result.read_text()))

hook = Path(".agents/setup")
custom_setup = hook.is_file()
if custom_setup:
    subprocess.run(["./" + str(hook)] if os.access(hook, os.X_OK) else ["sh", str(hook)], check=True)

manifest = Path("package.json")
if manifest.is_file():
    manager, executable = selected_manager()
    command = install_command(manager, executable)
    if manager == "yarn":
        # Keep modern Yarn's PnP archives inside the checkout, rather than in a
        # global store that would be absent in another session.
        os.environ["YARN_ENABLE_GLOBAL_CACHE"] = "false"
    key = None if custom_setup else eligible_key()
    if key is None or not restore(key):
        subprocess.run(command, check=True)
        if key is not None:
            publish(key)
