# M31: the scripted agent of the conformance tests, on the Python client (see agent-ts.ts).
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdk", "python"))
from roost_agent import RoostAgent  # noqa: E402

handled = 0
done = threading.Event()


def on_reply(reply):
    global handled
    if reply.text == "exit":
        agent.report("done", summary="bye")
        done.set()
        return
    if reply.text == "board":
        # M47: the board through the client (answers routed by request id): put on, claimed, done
        agent.report("working", summary="on board")
        t = agent.add_task("from the agent", detail="a task it put on")
        agent.claim_task(t["id"])
        agent.task_done(t["id"], "done by the agent")
        agent.report("done", summary="board #%d" % t["id"])
        return
    handled += 1
    agent.report("working", summary="on " + reply.text)
    time.sleep(0.2)
    agent.report("done", summary="did %s (#%d)" % (reply.text, handled), model="scripted-1")


agent = RoostAgent.from_env("scripted-py", version="1.0", capabilities=["usage"], on_reply=on_reply)
if agent is None:
    print("not in a roost job", file=sys.stderr)
    sys.exit(2)
agent.report("blocked", waitingFor="first-prompt", summary="ready")
done.wait()
time.sleep(0.3)  # the reply is acked after on_reply returns
agent.close()
