from pathlib import Path
import hashlib, lzma, json, subprocess
marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/e2b-source.{i}').read_bytes() for i in range(1, 5))
assert hashlib.sha256(raw).hexdigest() == 'b49abd9483533a0c32b36659b6770374b33fefc4b940a428ca856ad3f942e54c'
payload = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=payload['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=payload['patch'], text=True, check=True)
for path, content in payload['new'].items():
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('apps', 'packages', 'tests', 'docs')
    assert not p.exists(), path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
for path, content in payload['replace'].items():
    assert path == 'docs/development/21-implementation-status.md'
    Path(path).write_text(content)
marker.write_text('Locally checked E2b1 source applied; development transport only.\n')
