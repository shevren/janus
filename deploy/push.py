"""Push Janus to /opt/janus. Leaves other vhosts on the host alone."""
from __future__ import annotations

import os
import posixpath
import sys
from urllib.parse import urlparse

import paramiko

HOST = os.environ.get("JANUS_VPS_HOST", "")
KEY = os.environ.get("JANUS_VPS_KEY", r"C:\vex\ssh\hermes_vps")
REMOTE = "/opt/janus"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = {
    "node_modules",
    ".git",
    "dist",
    "data",
    "app/build",
    ".gradle",
    "__pycache__",
}
SKIP_FILES = {".env", ".env.local"}


def public_url(host: str) -> str:
    env = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if env:
        return env
    return f"http://{host}.sslip.io"


def server_names(host: str, url: str) -> str:
    env = os.environ.get("JANUS_SERVER_NAME", "").strip()
    if env:
        return env
    parsed = urlparse(url)
    names = {f"{host}.sslip.io", f"janus.{host}.sslip.io"}
    if parsed.hostname:
        names.add(parsed.hostname)
    return " ".join(sorted(names))


def client():
    if not HOST:
        raise SystemExit("JANUS_VPS_HOST is not set")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username="root", key_filename=KEY, timeout=25, allow_agent=False, look_for_keys=False)
    return c


def run(c, cmd, timeout=600):
    _, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    sys.stdout.write(out)
    if err.strip():
        sys.stdout.write(err)
    return code


def put_dir(sftp, local, remote):
    try:
        sftp.stat(remote)
    except FileNotFoundError:
        sftp.mkdir(remote)
    for name in os.listdir(local):
        if name in SKIP or name in SKIP_FILES:
            continue
        lp = os.path.join(local, name)
        rp = posixpath.join(remote, name)
        if os.path.isdir(lp):
            put_dir(sftp, lp, rp)
        else:
            sftp.put(lp, rp)


def main():
    url = public_url(HOST)
    names = server_names(HOST, url)
    c = client()
    try:
        run(c, "mkdir -p /opt/janus /opt/janus/deploy /opt/janus/data")
        sftp = c.open_sftp()
        put_dir(sftp, ROOT, REMOTE)
        conf = open(os.path.join(ROOT, "deploy", "nginx-janus.conf"), encoding="utf-8").read()
        conf = conf.replace("server_name localhost;", f"server_name {names};")
        with sftp.file("/opt/janus/deploy/nginx-janus.conf", "w") as f:
            f.write(conf)
        sftp.close()
        for cmd in [
            "command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)",
            "test -f /opt/janus/.env || (cp /opt/janus/.env.example /opt/janus/.env && "
            "sed -i \"s/change-me-to-a-long-random-string/$(openssl rand -hex 32)/\" /opt/janus/.env && "
            "sed -i \"s/change-me-to-32-byte-base64-or-hex/$(openssl rand -hex 32)/\" /opt/janus/.env)",
            f"grep -q '^PUBLIC_URL=' /opt/janus/.env && sed -i 's|^PUBLIC_URL=.*|PUBLIC_URL={url}|' /opt/janus/.env "
            f"|| echo PUBLIC_URL={url} >> /opt/janus/.env",
            "cp /opt/janus/deploy/nginx-janus.conf /etc/nginx/sites-available/janus",
            "ln -sfn /etc/nginx/sites-available/janus /etc/nginx/sites-enabled/janus",
            "nginx -t && systemctl reload nginx",
            "cd /opt/janus && docker compose -f deploy/compose.yml up -d --build",
            "cp /opt/janus/deploy/janus.service /etc/systemd/system/janus.service",
            "systemctl daemon-reload && systemctl enable janus",
            "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/healthz || true",
        ]:
            print("===", cmd)
            run(c, cmd)
    finally:
        c.close()


if __name__ == "__main__":
    main()
