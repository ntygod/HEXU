from pathlib import Path
marker = Path('.staging/applied-02')
if marker.exists(): raise SystemExit(0)
p = Path('tests/e2e/node-execution.spec.ts')
s = p.read_text()
a = "await expect(way.locator('option[value=\"resume\"]')).toBeEnabled({ timeout: 15000 });"
b = "await expect(way.locator('option[value=\"resume\"]')).toHaveJSProperty('disabled', false, { timeout: 15000 });"
assert s.count(a) == 1
s = s.replace(a,b)
a = "await expect(page.getByLabel('接续会话方式').locator('option[value=\"resume\"]')).toBeDisabled();"
b = "await expect(page.getByLabel('接续会话方式').locator('option[value=\"resume\"]')).toHaveJSProperty('disabled', true);"
assert s.count(a) == 1
s = s.replace(a,b)
a = "    await expect(page.getByLabel('接续会话方式')).toHaveValue('new');\n"
b = a + """    await page.getByLabel('本次执行模式', { exact: true }).selectOption('edit');
    await page.getByLabel('本次要求', { exact: true }).fill('CODEX_WRITE');
    await expect(page.getByRole('checkbox').last()).toBeEnabled();
    await page.getByRole('checkbox').last().check();
    await page.getByRole('button', { name: '确认同目录接续', exact: true }).click();
    await expect.poll(async () => (await detail(page, f)).runs.length, { timeout: 20000 }).toBe(3);
    await expect.poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 }).toBe('succeeded');
    expect(await readFile(join(f.root, 'actual-starts.txt'), 'utf8')).toBe('one\\none\\n');
    expect((await detail(page, f)).runs.at(-1).node.nativeSession.ref).not.toBe(ref);
"""
assert s.count(a) == 1
s = s.replace(a,b)
p.write_text(s)
p = Path('apps/web/src/App.tsx')
p.write_text(p.read_text().replace('E2b4','E2c1'))
marker.write_text('Option-state regression clarified; explicit new-session path exercised.\n')
