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

With on_message (M50) it also takes messages, reports and notices from other sessions
(a task the hub hands over is a message): they come in seq order with the replies, one
at a time, and send/peers/watch reach other sessions.
"""

import json
import os
import socket
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

PROTOCOL_VERSION = 1

_ENV = {
    "id": ("ROOST_JOB_ID", "PI_JOB_ID"),
    "token": ("ROOST_JOB_TOKEN", "PI_JOB_TOKEN"),
    "socket": ("ROOST_SOCKET", "PI_DAEMON_SOCK"),
    "dir": ("ROOST_JOB_DIR", "PI_JOB_DIR"),
}

_STATUS = {"working": "busy", "blocked": "waiting", "done": "idle", "failed": "idle"}


class RoostError(Exception):
    """The daemon refused a request: code (conflict, blocked, not_found, bad_request, unsupported, …) and message."""

    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


@dataclass
class Reply:
    seq: int
    text: str
    # "steer": join the work under way; "followUp" or None: after it
    mode: Optional[str] = None


@dataclass
class Message:
    """M50: from another session: kind is message, report or notice; text is the daemon's envelope."""

    seq: int
    kind: str
    text: str
    sender: str
    relation: str


def _env(env, which):
    for name in _ENV[which]:
        v = env.get(name)
        if v:
            return v
    return None


class RoostAgent:
    def __init__(self, job_id, token, sock_path, name, version=None, capabilities=(), on_reply=None, job_dir=None, on_message=None):
        self.job_id = job_id
        self._token = token
        self._sock_path = sock_path
        self._hello = {
            "protocol": PROTOCOL_VERSION,
            "agent": {"name": name, **({"version": version} if version else {})},
            "capabilities": sorted({"report", "replies", *(("agent-items", "peers") if on_message else ()), *capabilities}),
        }
        self._on_reply: Optional[Callable[[Reply], None]] = on_reply
        self._on_message: Optional[Callable[[Message], None]] = on_message
        self.daemon: Optional[dict] = None
        self._latest: Optional[dict] = None
        self._sent: Optional[dict] = None
        self._lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._next_id = 0
        self._waiters = {}  # request id -> (Event, box) for an answer awaited (request)
        self._handled = 0  # handed to on_reply
        self._completed = 0  # on_reply returned (acked)
        self._send_lock = threading.Lock()
        # the last finished seq, kept so a restarted agent does not redo a reply whose ack was lost
        self._mark = os.path.join(job_dir, "agent.json") if job_dir else None
        if self._mark:
            try:
                with open(self._mark) as f:
                    done = json.load(f).get("handled")
                if isinstance(done, int) and done > 0:
                    self._handled = self._completed = done
            except (OSError, ValueError, AttributeError):
                pass
        self._closed = False
        self._wake = threading.Event()
        self._replies: list = []  # Reply or Message, in seq order
        self._replies_ready = threading.Condition()
        threading.Thread(target=self._run, name="roost-agent", daemon=True).start()
        threading.Thread(target=self._reply_loop, name="roost-agent-replies", daemon=True).start()

    @classmethod
    def from_env(cls, name, version=None, capabilities=(), on_reply=None, env=None, on_message=None):
        """The agent of this roost job, or None outside one."""
        env = os.environ if env is None else env
        job_id, token, sock = _env(env, "id"), _env(env, "token"), _env(env, "socket")
        if not (job_id and token and sock):
            return None
        return cls(job_id, token, sock, name, version, capabilities, on_reply, _env(env, "dir"), on_message)

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
        if self._on_message:
            report["agentItems"] = True  # the daemon sends agent items only to a connection that takes them
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

    # ---- any op (M47) ----------------------------------------------------------

    def request(self, op, args=None, timeout=15.0):
        """Any op of the protocol (docs/protocol.md), as this job: its result (a dict), or
        RoostError when the daemon refuses it (code `disconnected` when the connection was
        lost meanwhile); TimeoutError when no answer comes in time. The connection is made
        for the first report(): before it, or while reconnecting, ConnectionError."""
        event = threading.Event()
        box = {}
        self._send(op, args or {}, waiter=(event, box))
        if not event.wait(timeout):
            with self._lock:
                self._waiters = {k: v for k, v in self._waiters.items() if v[1] is not box}
            raise TimeoutError("%s: no answer in %ss" % (op, timeout))
        msg = box["msg"]
        if not msg.get("ok"):
            raise RoostError(msg.get("code") or "error", msg.get("message") or op)
        return msg.get("result") or {}

    # ---- the shared task board (M47) ------------------------------------------

    # M50: other sessions (with on_message)

    def peers(self):
        """The sessions this one can reach."""
        return self.request("peers", {})["peers"]

    def send(self, to, message):
        """A message to a session (an id, or a name peers lists): the result says delivered, queued or started."""
        return self.request("send", {"to": to, "message": message})

    def watch(self, session_id, when):
        """Be told once (a notice to on_message) when that session is next idle, or has ended."""
        return self.request("watch", {"id": session_id, "when": when})

    def tasks(self):
        """The board: every task (dicts as in docs/protocol.md), oldest first."""
        return self.request("task", {"action": "list"})["tasks"]

    def claim_task(self, task_id):
        """Take an open task: this job holds it until task_done or release_task. RoostError
        conflict (another live session holds it), blocked (it waits on tasks not done),
        bad_request (done or dropped), not_found."""
        return self.request("task", {"action": "claim", "id": task_id})["task"]

    def task_done(self, task_id, result=None):
        """Mark the task this job holds done, with its result."""
        args = {"action": "done", "id": task_id}
        if result:
            args["result"] = result
        return self.request("task", args)["task"]

    def release_task(self, task_id):
        """Give the task this job holds back to the board."""
        return self.request("task", {"action": "release", "id": task_id})["task"]

    def add_task(self, title, detail=None, after=None):
        """Put a task on the board for any session; after: the ids it waits on."""
        args = {"action": "add", "title": title}
        if detail:
            args["detail"] = detail
        if after:
            args["after"] = list(after)
        return self.request("task", args)["task"]

    # ---- the connection ------------------------------------------------------

    def _send(self, op, args, waiter=None):
        with self._lock:
            sock = self._sock
            self._next_id += 1
            rid = self._next_id
            if waiter is not None and sock is not None:
                self._waiters[rid] = waiter  # before the line goes: the answer may come at once
        if sock is None:
            raise ConnectionError("not connected")
        line = (json.dumps({"id": rid, "op": op, "args": args}) + "\n").encode()
        # three threads send (reports, acks from the reader and the reply thread): one line at a time
        try:
            with self._send_lock:
                sock.sendall(line)
        except (OSError, ConnectionError):
            if waiter is not None:
                with self._lock:
                    self._waiters.pop(rid, None)
            raise
        return rid

    def _drop(self):
        with self._lock:
            sock, self._sock = self._sock, None
            self._sent = None
            waiters, self._waiters = self._waiters, {}
        # an answer awaited over this connection will not come
        for event, box in waiters.values():
            box["msg"] = {"ok": False, "code": "disconnected", "message": "the connection was lost"}
            event.set()
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
        # an answer to a request (M47): handed to the thread that waits for it
        if "event" not in msg and isinstance(msg.get("id"), int):
            with self._lock:
                waiter = self._waiters.pop(msg["id"], None)
            if waiter is not None:
                event, box = waiter
                box["msg"] = msg
                event.set()
                return
        if msg.get("event") == "deliver" and msg.get("id") == self.job_id:
            kind = msg.get("kind")
            item = kind in ("message", "report", "notice")
            # agent items go only to an agent that takes them (on_message); a digest is the concierge's
            if kind == "digest":
                if isinstance(msg.get("seq"), int):
                    self._ack(msg["seq"], True)  # the concierge's: acked, not kept
                return
            if item and not self._on_message:
                return
            seq = msg.get("seq")
            if not isinstance(seq, int):
                return
            if seq <= self._handled:
                # sent again (a reconnect): ack only what is finished; the rest is acked when it is
                if seq <= self._completed:
                    self._ack(seq, item)
                return
            self._handled = seq
            with self._replies_ready:
                if item:
                    self._replies.append(Message(seq, kind, str(msg.get("text", "")), str(msg.get("from") or "?"), str(msg.get("relation") or "external")))
                else:
                    self._replies.append(Reply(seq, str(msg.get("text", "")), msg.get("mode")))
                self._replies_ready.notify()
        elif "ok" in msg and msg.get("ok") and isinstance(msg.get("result"), dict) and "daemon" in msg["result"]:
            self.daemon = msg["result"]
        elif msg.get("ok") is False and msg.get("code") == "unauthorized":
            # not this job's agent (a stale token): nothing it says will count
            self._closed = True

    def _ack(self, seq, exact=False):
        # a user reply's ack covers every reply up to it; an agent item is acked by itself
        try:
            self._send("ack", {"id": self.job_id, "token": self._token, "seq": seq, **({"exact": True} if exact else {})})
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
            is_item = isinstance(reply, Message)
            try:
                if is_item:
                    if self._on_message:
                        self._on_message(reply)
                elif self._on_reply:
                    self._on_reply(reply)
            except Exception:  # an agent's handler failing must not stop the client
                pass
            self._completed = reply.seq
            if self._mark:  # kept before the ack (see __init__)
                try:
                    tmp = self._mark + ".tmp"
                    with open(tmp, "w") as f:
                        json.dump({"handled": reply.seq}, f)
                    os.replace(tmp, self._mark)
                except OSError:
                    pass
            self._ack(reply.seq, is_item)
