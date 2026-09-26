from pathlib import Path
import hashlib, lzma, json, subprocess

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/e2b4-source.{i}').read_bytes() for i in range(1, 7))
assert hashlib.sha256(raw).hexdigest() == '05f4b2a139252979afaa9a7e09265dbff114913cf3cbfc97a80c264442d9a6b5'
data = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=data['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=data['patch'], text=True, check=True)
for name, content in data['new'].items():
    path = Path(name)
    assert not path.is_absolute() and '..' not in path.parts and path.parts[0] in ('apps', 'packages', 'tests')
    assert not path.exists(), name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
assert set(data['replace']) == {'docs/development/21-implementation-status.md'}
for name, content in data['replace'].items():
    path = Path(name)
    assert path.is_file()
    path.write_text(content)
marker.write_text('E2b4 local checked source applied; development transport only.\n')
