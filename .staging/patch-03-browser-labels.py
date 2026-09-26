from pathlib import Path
import json
marker=Path('.staging/applied-03')
if marker.exists(): raise SystemExit(0)
def change(path,old,new):
 p=Path(path);s=p.read_text();assert s.count(old)==1,(path,old[:90],s.count(old));p.write_text(s.replace(old,new))
change('apps/web/src/identity.tsx','                  name="password"\n                  type="password"','                  name="password"\n                  aria-label="密码"\n                  aria-describedby="account-password-help"\n                  type="password"')
change('apps/web/src/identity.tsx','                <small>\n                  {register','                <small id="account-password-help">\n                  {register')
change('tests/e2e/team.spec.ts',"    const spaceId = await page.getByLabel('当前工作空间').inputValue();\n    await expect(page.getByLabel('当前工作空间')).not.toHaveValue(/^personal-/);", "    await expect(page.getByLabel('当前工作空间')).not.toHaveValue(/^personal-/);\n    const spaceId = await page.getByLabel('当前工作空间').inputValue();")
change('apps/web/src/App.tsx','            <small>本地开发预览</small>',"            <small>{data.mode === 'team-local' ? '按项目权限协作' : '本地开发预览'}</small>")
for name in ['package.json','package-lock.json']:
 p=Path(name);s=json.loads(p.read_text());root=s if name=='package.json' else s['packages'][''];root['engines']['node']='>=24 <25';p.write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n')
change('scripts/start-e2e.mjs',"await teamApp.listen({ host: '127.0.0.1', port: 4311 });", "await teamApp.listen({ host: '127.0.0.1', port: 4311 });\nfor (const signal of ['SIGINT', 'SIGTERM'])\n  process.once(signal, () => { void teamApp.close(); });")
p=Path('AGENTS.md');s=p.read_text().replace('E1c remains a **local single-user developer preview**, not a hosted team platform.', 'E2a has two loopback-only modes: **preview** preserves the fictional single-user native-tool workbench; **team-local** uses real accounts and project data permissions but forbids host execution. Neither is a hosted team platform.').replace('Fastify local API. Binding is loopback-only until real identity is implemented.', 'Fastify local API. Binding stays loopback-only even with real identities until independent nodes and remote deployment controls are implemented.').replace('`packages/db`: local-preview SQLite repository, migrations, transactions and outbox.', '`packages/db`: mode-separated SQLite repository, request-scoped permissions, migrations, transactions and outbox.');p.write_text(s)
marker.write_text('Accessible auth input labels and deterministic browser transitions corrected.\n')
