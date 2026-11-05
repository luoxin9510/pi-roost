"""M41: a protocol agent driven by a model, for the evals: pi's print mode behind the
Python client. Each reply (the first task included) is one `pi -p` turn in a session of
its own, so a later reply has the earlier ones' context; what pi printed is the report.

    python3 pi_agent.py --node <node> --pi <cli.js> --session-dir <dir> [--model m] [--thinking t]
"""

import os
import subprocess
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdk", "python"))
from roost_agent import RoostAgent  # noqa: E402


def arg(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default


NODE = arg("--node", "node")
PI = arg("--pi", "pi")
SESSION = os.path.join(arg("--session-dir", os.getcwd()), "agent.jsonl")
MODEL = arg("--model")
THINKING = arg("--thinking")
turns = 0


def on_reply(reply):
    global turns
    turns += 1
    agent.report("working", summary="turn %d: %s" % (turns, reply.text[:80]), model=MODEL)
    cmd = [NODE, PI, "-ne", "-p", "--session", SESSION]
    if MODEL:
        cmd += ["--model", MODEL]
    if THINKING:
        cmd += ["--thinking", THINKING]
    cmd.append(reply.text)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        agent.report("failed", summary="pi took too long", error="pi -p timed out", model=MODEL)
        return
    if out.returncode != 0:
        agent.report("failed", summary="pi failed", error=(out.stderr or out.stdout)[-500:], model=MODEL)
        return
    lines = [l for l in out.stdout.splitlines() if l.strip()]
    answer = lines[-1] if lines else ""
    agent.report("done", summary=answer[:500], model=MODEL)


agent = RoostAgent.from_env("pi-print", version="1.0", on_reply=on_reply)
if not agent:
    print("not in a roost job", file=sys.stderr)
    sys.exit(2)
agent.report("blocked", waitingFor="first-prompt", summary="ready", model=MODEL)
threading.Event().wait()
