from pathlib import Path
import hashlib, lzma, json, subprocess

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/e2b3-source.{i}').read_bytes() for i in range(1, 5))
assert hashlib.sha256(raw).hexdigest() == 'e4348b12518db59fd16e7124a52e5bb319061ab78c5cc85588aaa45fa206f8dc'
payload = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=payload['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=payload['patch'], text=True, check=True)
for path, content in payload['files'].items():
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('apps', 'packages', 'tests', 'docs')
    assert path == 'docs/development/21-implementation-status.md' or not p.exists(), path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
marker.write_text('Reviewed E2b3 integration; development transport only.\n')
