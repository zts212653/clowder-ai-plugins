import json
import os
import pathlib
import re
import select
import signal
import subprocess
import sys
import time
import pty

root = pathlib.Path(os.environ['RUNNER_TEMP']) / 'feedback-recovery'
root.mkdir(mode=0o700, exist_ok=True)
encrypted = root / 'challenge.enc'
result = root / 'result.json'
public_key = pathlib.Path('.github/feedback-recovery/challenge-public.pem').resolve()


def finish(status, code=None):
    temporary = result.with_suffix('.tmp')
    temporary.write_text(json.dumps({'status': status, 'exitCode': code}) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, result)


def run_child(mode):
    if mode == 'mock':
        cmd = [sys.executable, '-u', '-c', "import time; print('Authenticate your account at:', flush=True); print('https://www.npmjs.com/auth/cli/mock-proof', flush=True); time.sleep(75)"]
        timeout = 120
    elif mode == 'publish':
        cmd = ['npm', 'publish', '.github/feedback-recovery/feedback.tgz', '--provenance-file', '.github/feedback-recovery/provenance.sigstore.json', '--tag', 'next', '--access', 'public', '--ignore-scripts', '--browser=false', '--loglevel=error']
        timeout = 780
    else:
        raise ValueError('invalid mode')
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    buffer = bytearray()
    deadline = time.monotonic() + timeout
    status = None
    while time.monotonic() < deadline:
        done_pid, child_status = os.waitpid(pid, os.WNOHANG)
        if done_pid:
            status = os.waitstatus_to_exitcode(child_status)
            break
        ready, _, _ = select.select([master], [], [], 1)
        if not ready:
            continue
        try:
            chunk = os.read(master, 8192)
        except OSError:
            continue
        buffer.extend(chunk)
        if len(buffer) > 262144:
            del buffer[:-131072]
        if not encrypted.exists():
            match = re.search(rb'(https://www\.npmjs\.com/auth/cli/[^\s\x1b\x00-\x1f]+)[\r\n]', buffer)
            if match:
                url = match.group(1)
                if len(url) > 300:
                    os.kill(pid, signal.SIGTERM)
                    finish('invalid-challenge')
                    return
                cipher = subprocess.run(['openssl', 'pkeyutl', '-encrypt', '-pubin', '-inkey', str(public_key), '-pkeyopt', 'rsa_padding_mode:oaep', '-pkeyopt', 'rsa_oaep_md:sha256'], input=url, capture_output=True, check=True).stdout
                temporary = encrypted.with_suffix('.tmp')
                temporary.write_bytes(cipher)
                os.chmod(temporary, 0o600)
                os.replace(temporary, encrypted)
                buffer.clear()
    if status is None:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
        finish('timed-out')
    elif status == 0:
        finish('completed', status)
    else:
        match = re.search(rb'npm error code ([A-Z0-9_]+)', buffer)
        finish('failed-' + (match.group(1).decode() if match else 'unknown'), status)
    os.close(master)


if __name__ == '__main__':
    action, mode = sys.argv[1:]
    if action == 'serve':
        run_child(mode)
    elif action == 'launch':
        subprocess.Popen([sys.executable, __file__, 'serve', mode], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(80):
            if encrypted.exists():
                print('Encrypted challenge is ready; no challenge or credential printed.')
                break
            if result.exists():
                print(result.read_text(), end='')
                break
            time.sleep(1)
        else:
            raise TimeoutError('No challenge or exit result after 80 seconds')
    elif action == 'wait':
        for _ in range(850):
            if result.exists():
                data = json.loads(result.read_text())
                print(json.dumps(data))
                sys.exit(0 if data['status'] == 'completed' else 1)
            time.sleep(1)
        raise TimeoutError('No final result before monitor deadline')
    else:
        raise ValueError('invalid action')
