from pathlib import Path
marker = Path('.staging/applied-04')
if marker.exists(): raise SystemExit(0)
p = Path('apps/web/src/team.tsx')
s = p.read_text()
old = '<select required value={target} onChange={(e) => setTarget(e.target.value)}>'
assert s.count(old) == 1
s = s.replace(old, '<select aria-label="添加空间成员" required value={target} onChange={(e) => setTarget(e.target.value)}>')
old = '<select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>'
assert s.count(old) == 1
s = s.replace(old, '<select aria-label="访问权限" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>')
p.write_text(s)
marker.write_text('Explicit accessible names for project permission controls.\n')
