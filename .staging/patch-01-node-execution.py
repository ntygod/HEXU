from pathlib import Path
import hashlib, lzma, json, subprocess

marker = Path('.staging/applied-01')
if marker.exists():
    raise SystemExit(0)
raw = b''.join(Path(f'.staging/e2b2-source.{i}').read_bytes() for i in range(1, 7))
assert hashlib.sha256(raw).hexdigest() == 'd9b85716793e8c435a5672a3dfcb3e701e9f4d4965553ab9487ffa59a2ee0665'
payload = json.loads(lzma.decompress(raw))
subprocess.run(['git', 'apply', '--check', '-'], input=payload['patch'], text=True, check=True)
subprocess.run(['git', 'apply', '-'], input=payload['patch'], text=True, check=True)
for path, content in payload['new'].items():
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('apps', 'packages', 'tests', 'docs')
    assert not p.exists(), path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
marker.write_text('E2b2 local source integrated; development transport only.\n')
