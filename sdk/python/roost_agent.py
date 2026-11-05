"""The roost agent protocol, Python client (one file, standard library only).

An agent run by roost (a profile with "protocol": true in the user's roost.json) finds
its job in its environment, says hello, reports its state, and takes replies:

    from roost_agent import RoostAgent

    def on_reply(reply):
        print("user said", reply.text)

    agent = RoostAgent.from_env("my-agent", version="1.0", on_reply=on_reply)
    if agent:
        agent.report("working", summary="reading the code")
        ...
        agent.report("done", summary="fixed the test")
        agent.close()

The protocol is in docs/protocol.md. Reports are full snapshots; the client resends the
latest one after a reconnect (a daemon restart), and the daemon resends unacked replies,
which reach on_reply once each, in order, one at a time, acked when it returns.
"""

import json
import os
import socket
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional

PROTOCOL_VERSION = 1

_ENV = {
    "id": ("ROOST_JOB_ID", "PI_JOB_ID"),
    "token": ("ROOST_JOB_TOKEN", "PI_JOB_TOKEN"),
    "socket": ("ROOST_SOCKET", "PI_DAEMON_SOCK"),
}

_STATUS = {"working": "busy", "blocked": "waiting", "done": "idle", "failed": "idle"}


@dataclass
class Reply:
    seq: int
    text: str
    # "steer": join the work under way; "followUp" or None: after it
    mode: Optional[str] = None


def _env(env, which):
    for name in _ENV[which]:
        v = env.get(name)
        if v:
            return v
    return None


class RoostAgent:
    def __init__(self, job_id, token, sock_path, name, version=None, capabilities=(), on_reply=None):
        self.job_id = job_id
        self._token = token
        self._sock_path = sock_path
        self._hello = {
            "protocol": PROTOCOL_VERSION,
            "agent": {"name": name, **({"version": version} if version else {})},
            "capabilities": sorted({"report", "replies", *capabilities}),
        }
        self._on_reply: Optional[Callable[[Reply], None]] = on_reply
        self.daemon: Optional[dict] = None
        self._latest: Optional[dict] = None
        self._sent: Optional[dict] = None
        self._lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._next_id = 0
        self._handled = 0  # handed to on_reply
        self._completed = 0  # on_reply returned (acked)
        self._send_lock = threading.Lock()
        self._closed = False
        self._wake = threading.Event()
        self._replies: List[Reply] = []
        self._replies_ready = threading.Condition()
        threading.Thread(target=self._run, name="roost-agent", daemon=True).start()
        threading.Thread(target=self._reply_loop, name="roost-agent-replies", daemon=True).start()

    @classmethod
    def from_env(cls, name, version=None, capabilities=(), on_reply=None, env=None):
        """The agent of this roost job, or None outside one."""
        env = os.environ if env is None else env
        job_id, token, sock = _env(env, "id"), _env(env, "token"), _env(env, "socket")
        if not (job_id and token and sock):
            return None
        return cls(job_id, token, sock, name, version, capabilities, on_reply)

    def report(self, state, **fields):
        """Its state now: working, blocked, done or failed; other fields as in docs/protocol.md."""
        if state not in _STATUS:
            raise ValueError("state is working, blocked, done or failed")
        report = {
            "state": state,
            "status": _STATUS[state],
            "waitingFor": "question" if state == "blocked" else None,
            "summary": None,
            "question": None,
            "choices": [],
            "tool": None,
            "error": None,
            "name": None,
            "model": None,
        }
        report.update(fields)
        json.dumps(report)  # raises here, not in the connection thread, if a field cannot be sent
        with self._lock:
            self._latest = report
        self._wake.set()

    def close(self, timeout=2.0):
        """Send the latest report (bounded wait), then disconnect."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if self._latest is None or self._latest is self._sent:
                    break
            time.sleep(0.05)
        self._closed = True
        self._wake.set()
        with self._replies_ready:
            self._replies_ready.notify_all()
        self._drop()

    # ---- the connection ------------------------------------------------------

    def _send(self, op, args):
        with self._lock:
            sock = self._sock
            self._next_id += 1
            rid = self._next_id
        if sock is None:
            raise ConnectionError("not connected")
        line = (json.dumps({"id": rid, "op": op, "args": args}) + "\n").encode()
        # three threads send (reports, acks from the reader and the reply thread): one line at a time
        with self._send_lock:
            sock.sendall(line)
        return rid

    def _drop(self):
        with self._lock:
            sock, self._sock = self._sock, None
            self._sent = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _run(self):
        retry = 0.5
        while not self._closed:
            with self._lock:
                pending = self._latest is not None
            if not pending:
                # nothing to say yet: a connection starts with the first report
                self._wake.wait(1.0)
                self._wake.clear()
                continue
            try:
                self._session()
                retry = 0.5
            except Exception:  # the connection thread never dies: it connects again
                pass
            self._drop()
            if self._closed:
                return
            time.sleep(retry)
            retry = min(retry * 2, 5.0)

    def _session(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(self._sock_path)
        with self._lock:
            self._sock = sock
        reader = threading.Thread(target=self._read, args=(sock,), daemon=True)
        reader.start()
        self._send("hello", self._hello)
        while not self._closed and reader.is_alive():
            with self._lock:
                latest, sent = self._latest, self._sent
            if latest is not None and latest is not sent:
                self._send("report", {"id": self.job_id, "token": self._token, "report": latest})
                with self._lock:
                    self._sent = latest
            self._wake.wait(0.5)
            self._wake.clear()

    def _read(self, sock):
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                self._message(msg)

    def _message(self, msg):
        if msg.get("event") == "deliver" and msg.get("id") == self.job_id:
            # agent items (peer messages) are pi's; a plain agent takes user replies only
            if msg.get("kind") in ("message", "report"):
                return
            seq = msg.get("seq")
            if not isinstance(seq, int):
                return
            if seq <= self._handled:
                # sent again (a reconnect): ack only what is finished; the rest is acked when it is
                if seq <= self._completed:
                    self._ack(seq)
                return
            self._handled = seq
            with self._replies_ready:
                self._replies.append(Reply(seq, str(msg.get("text", "")), msg.get("mode")))
                self._replies_ready.notify()
        elif "ok" in msg and msg.get("ok") and isinstance(msg.get("result"), dict) and "daemon" in msg["result"]:
            self.daemon = msg["result"]
        elif msg.get("ok") is False and msg.get("code") == "unauthorized":
            # not this job's agent (a stale token): nothing it says will count
            self._closed = True

    def _ack(self, seq):
        try:
            self._send("ack", {"id": self.job_id, "token": self._token, "seq": seq})
        except (OSError, ConnectionError):
            pass  # resent after a reconnect, and dropped by seq then

    def _reply_loop(self):
        while True:
            with self._replies_ready:
                while not self._replies and not self._closed:
                    self._replies_ready.wait()
                if self._closed and not self._replies:
                    return
                reply = self._replies.pop(0)
            try:
                if self._on_reply:
                    self._on_reply(reply)
            except Exception:  # an agent's handler failing must not stop the client
                pass
            self._completed = reply.seq
            self._ack(reply.seq)
