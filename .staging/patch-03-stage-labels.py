from pathlib import Path
marker=Path('.staging/applied-03')
if marker.exists(): raise SystemExit(0)
p=Path('apps/web/src/App.tsx');s=p.read_text()
assert "'本机团队模式 · 节点仅同步状态'" in s
s=s.replace("'本机团队模式 · 节点仅同步状态'", "'本机团队模式 · 本人授权节点执行'")
s=s.replace('E2b1 · 真实账号 / 节点状态', 'E2b2 · 真实账号 / 本人节点执行').replace('开发预览 E2b1 · 示例数据', '开发预览 E2b2 · 示例数据').replace('E2b1 · 本机预览', 'E2b2 · 本机预览')
p.write_text(s)
p=Path('tests/e2e/node-execution.spec.ts');s=p.read_text()
old="    await page.screenshot({ path: 'artifacts/25-node-execution-mobile-dark.png', fullPage: true });"
assert s.count(old)==1
s=s.replace(old, "    await expect(page.locator('.toast')).not.toBeVisible();\n"+old)
p.write_text(s)
marker.write_text('Stage labels reflect actual node execution; screenshot no longer obscured by toast.\n')
