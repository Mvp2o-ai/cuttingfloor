"""cuttingfloor for Python scripts in code.run.

    from cuttingfloor import cf, file, out, progress
    info = cf.media.get(media_id="m_...")
    t = cf.timeline.create(name="cut", sequence={"width": 1080, "height": 1920, "fps": {"num": 30, "den": 1}})

Every tool is cf.<domain>.<verb>(**args) (or cf.call("domain.verb", {...})), called as the
job's owner. Long-running tools are followed through job.get to their result. Errors raise
CfError with .code, .message and .hint.
"""

import http.client
import json
import os
import socket
import time

__all__ = ["cf", "CfError", "file", "import_file", "out", "progress", "IN", "OUT"]

IN = os.environ.get("CF_IN", "in")
OUT = os.environ.get("CF_OUT", "out")


class CfError(Exception):
    def __init__(self, code, message, hint=None, detail=None):
        super().__init__(f"{code}: {message}" + (f" ({hint})" if hint else ""))
        self.code = code
        self.message = message
        self.hint = hint
        self.detail = detail


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self._path)


def _ask(path, body):
    sock = os.environ.get("CF_SOCKET")
    if not sock:
        raise CfError("engine_error", "CF_SOCKET is not set: this only works inside code.run")
    conn = _UnixConnection(sock)
    payload = json.dumps(body)
    conn.request(
        "POST",
        path,
        body=payload,
        headers={
            "authorization": "Bearer " + os.environ.get("CF_TOKEN", ""),
            "content-type": "application/json",
        },
    )
    reply = json.loads(conn.getresponse().read() or b"{}")
    conn.close()
    return reply


def _error(e, fallback):
    e = e or {}
    return CfError(e.get("code", "engine_error"), e.get("message", fallback), e.get("hint"), e.get("detail"))


def _structured(result):
    if "structuredContent" in result:
        return result["structuredContent"]
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    if result.get("isError"):
        return {"code": "bad_request", "message": texts[0] if texts else "failed"}
    for c in result.get("content", []):
        if c.get("type") == "text":
            try:
                return json.loads(c["text"])
            except ValueError:
                return {"text": c["text"]}
    return {}


def call(tool, args=None, poll=0.5):
    reply = _ask("/call", {"tool": tool, "args": args or {}})
    if "error" in reply:
        raise _error(reply["error"], tool + " failed")
    result = reply.get("result") or {}
    body = _structured(result)
    if result.get("isError"):
        raise _error(body, tool + " failed")
    if isinstance(body, dict) and body.get("job_id") and body.get("status") == "working" and tool != "job.get":
        while True:
            time.sleep(poll)
            job = call("job.get", {"job_id": body["job_id"]})
            if job.get("status") == "working":
                continue
            if job.get("status") == "completed" and not job.get("error"):
                return job.get("result", {})
            raise _error(job.get("error"), tool + " " + str(job.get("status")))
    return body


def file(id):
    """A media item's file (m_...) or a timeline's JSON (t_...) in in/; returns its path."""
    reply = _ask("/file", {"media_id": id} if id.startswith("m_") else {"timeline_id": id})
    if "error" in reply:
        raise _error(reply["error"], "file failed")
    return reply["result"]["path"]


def import_file(path, name=None):
    """Imports a file the script made as media now (to place with cf.clip.add); returns it."""
    body = {"path": os.path.abspath(path)}
    if name:
        body["name"] = name
    reply = _ask("/upload", body)
    if "error" in reply:
        raise _error(reply["error"], "import failed")
    return reply["result"]


def out(name):
    """A path in out/: files written there come back as media (or timelines, *.timeline.json)."""
    return os.path.join(OUT, os.path.basename(name))


def progress(fraction, message=""):
    _ask("/progress", {"fraction": fraction, "message": message})


class _Domain:
    def __init__(self, name):
        self._name = name

    def __getattr__(self, verb):
        if verb.startswith("__"):
            raise AttributeError(verb)
        return lambda args=None, **kw: call(self._name + "." + verb, {**(args or {}), **kw})


class _Cf:
    call = staticmethod(call)

    def __getattr__(self, domain):
        if domain.startswith("__"):
            raise AttributeError(domain)
        return _Domain(domain)


cf = _Cf()
