from pathlib import Path
import hashlib, lzma, json, subprocess

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/session-source.{i}').read_bytes() for i in range(1, 4))
assert hashlib.sha256(raw).hexdigest() == '74e43e196021cdcb225885115637adcbb878c19bf5b7d8e635728c2033194014'
payload = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=payload['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=payload['patch'], text=True, check=True)
for path, content in payload['files'].items():
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('apps', 'docs')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
marker.write_text('Applied locally checked E2c1 source. Development transport only.\n')
