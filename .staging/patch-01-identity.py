from pathlib import Path
import hashlib, lzma, json, subprocess

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/e2a-source.{i}').read_bytes() for i in range(1, 6))
assert hashlib.sha256(raw).hexdigest() == '6550a1fbd0504b2966f78819a2d9f4eccac4040fd7c1d28993566db19a8dd6ad'
payload = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=payload['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=payload['patch'], text=True, check=True)
for path, content in payload['new'].items():
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('apps', 'packages', 'tests')
    assert not p.exists(), path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
marker.write_text('Applied locally checked E2a source; development transport only.\n')
