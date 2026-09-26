from pathlib import Path
import subprocess

marker = Path('.staging/applied-02')
if marker.exists():
    raise SystemExit(0)
patch = '''--- a/apps/web/src/node-execution.tsx
+++ b/apps/web/src/node-execution.tsx
@@ -27,8 +27,8 @@
     [workspaceId, setWorkspace] = useState(''),
     [mode, setMode] = useState<'read-only' | 'edit'>('read-only');
   const [prompt, setPrompt] = useState(''),
-    [consent, setConsent] = useState(false),
     [busy, setBusy] = useState(false);
+  const [confirmation, setConfirmation] = useState({ scope: '', approved: false });
   const [onActiveRun, setOnActiveRun] = useState<'wait' | 'request_stop'>('wait');
   const [continuation, setContinuation] = useState<NodeContinuationPreview | null>(null);
   const [notes, setNotes] = useState<NextInput[]>([]),
@@ -47,6 +47,32 @@
     }
   }
   const selectionVersion = selectedNotes.map((n) => `${n.id}:${n.revision}:${n.state}`).join(',');
+  // The preview and its task revision come from the same synchronous server read.
+  // A delayed parent snapshot cannot invalidate an already newer preview. A truly
+  // newer task still requires refreshing materials and explicit confirmation.
+  const previewTask = source ? continuation : null;
+  const expectedRevision = previewTask?.taskRevision ?? task.revision;
+  const taskStatus =
+    previewTask && previewTask.taskRevision >= task.revision ? previewTask.taskStatus : task.status;
+  const staleTask = !!previewTask && task.revision > previewTask.taskRevision;
+  const confirmationScope = JSON.stringify([
+    selected?.policyHash,
+    context,
+    Math.max(task.revision, expectedRevision),
+    taskStatus,
+    mode,
+    workspaceId,
+    prompt,
+    continuation?.contextHash,
+    selectionVersion,
+    onActiveRun,
+  ]);
+  // Invalidate during render, not a later effect that could clear a fresh click.
+  // Remembering the current scope also prevents A -> B -> A from restoring consent.
+  if (confirmation.scope !== confirmationScope)
+    setConfirmation({ scope: confirmationScope, approved: false });
+  const consent = confirmation.scope === confirmationScope && confirmation.approved;
+  const setConsent = (approved: boolean) => setConfirmation({ scope: confirmationScope, approved });
   useEffect(() => {
     let disposed = false;
     const load = async () => {
@@ -90,26 +116,13 @@
       clearInterval(timer);
     };
   }, [task.id, source?.id]);
-  useEffect(() => {
-    setConsent(false);
-  }, [
-    selected?.policyHash,
-    context,
-    task.revision,
-    mode,
-    workspaceId,
-    prompt,
-    continuation?.contextHash,
-    selectionVersion,
-    onActiveRun,
-  ]);
   return (
     <Dialog title={source ? '沿原目录继续' : '在我的节点上执行'} onClose={onClose} drawer>
       <form
         className="form-stack node-execution-form"
         onSubmit={async (e) => {
           e.preventDefault();
-          if (!selected || busy) return;
+          if (!selected || busy || !consent || staleTask) return;
           setBusy(true);
           setError('');
           try {
@@ -122,8 +135,8 @@
                 policyHash: selected.policyHash,
                 mode,
                 prompt,
-                expectedRevision: task.revision,
-                reopenTask: task.status === 'done',
+                expectedRevision,
+                reopenTask: taskStatus === 'done',
                 confirmExecution: consent,
                 ...(source && continuation
                   ? {
@@ -340,12 +353,19 @@
           <input
             type="checkbox"
             checked={consent}
-            disabled={busy}
+            disabled={
+              busy || !selected?.available || staleTask || (!!source && !continuation?.ready)
+            }
             onChange={(e) => setConsent(e.target.checked)}
           />
           我确认本次目录与模式，允许把任务材料发送给所选工具，使用本机 API
           账户计费，并把输出共享到项目任务。
         </label>
+        {staleTask && (
+          <p className="form-error" role="status">
+            任务版本已变化，正在重新整理材料；更新后请重新确认。
+          </p>
+        )}
         {materialError && (
           <p className="form-error" role="alert">
             {materialError}
@@ -366,6 +386,7 @@
             busy={busy}
             disabled={
               !consent ||
+              staleTask ||
               !!materialError ||
               chosen.length > 6 ||
               selectedNotes.some((n) => n.state !== 'queued') ||
@@ -376,7 +397,7 @@
             }
           >
             {source
-              ? task.status === 'done'
+              ? taskStatus === 'done'
                 ? '重开任务并接续'
                 : [
                       'queued',
@@ -390,7 +411,7 @@
                     ? '保存等待接续'
                     : '停止后接续'
                   : '确认同目录接续'
-              : task.status === 'done'
+              : taskStatus === 'done'
                 ? '重新打开并派发'
                 : '在节点上开始'}
           </Button>
--- a/packages/contracts/src/next-input.ts
+++ b/packages/contracts/src/next-input.ts
@@ -22,6 +22,8 @@
 export interface NodeContinuationPreview {
   sourceRunId: string;
   sourceTool: Tool;
+  taskRevision: number;
+  taskStatus: import('./index.js').TaskStatus;
   nodeId: string;
   workingCopyId: string;
   workingCopyName: string;
--- a/packages/db/src/node-execution.ts
+++ b/packages/db/src/node-execution.ts
@@ -305,6 +305,8 @@
     return {
       sourceRunId: source.id,
       sourceTool: source.requestedTool,
+      taskRevision: task.revision,
+      taskStatus: task.status,
       nodeId: source.node.nodeId,
       workingCopyId: source.node.workingCopyId,
       workingCopyName: source.node.workingCopyName,
--- a/tests/e2e/node-execution.spec.ts
+++ b/tests/e2e/node-execution.spec.ts
@@ -280,10 +280,10 @@
     await page.reload();
     await expect(page.locator('.next-input-item')).toContainText('保留订单数据');
     await page.getByRole('button', { name: '沿原目录继续', exact: true }).click();
-    await expect(
-      page.getByText('原执行尚未确认结束。可先保存下一轮要求，确认结束后再继续', { exact: true }),
-    ).toBeVisible();
-    await expect(page.getByRole('button', { name: '确认同目录接续', exact: true })).toBeDisabled();
+    await expect(page.getByLabel('原执行处理方式', { exact: true })).toHaveValue('wait');
+    await expect(page.getByRole('button', { name: '保存等待接续', exact: true })).toBeDisabled();
+    expect((await detail(page, f)).runs).toHaveLength(1);
+    expect((await detail(page, f)).runs[0].state).toBe('running');
     await page.getByRole('button', { name: '返回', exact: true }).click();
     await page.getByRole('button', { name: '停止节点执行', exact: true }).click();
     await expect
@@ -414,9 +414,16 @@
     await page.getByLabel('本次要求', { exact: true }).fill('重新打开后继续分析');
     await page.getByRole('checkbox', { name: /我确认本次目录与模式/ }).check();
     await page.getByRole('button', { name: '重开任务并接续', exact: true }).click();
-    await expect
-      .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
-      .toBe('succeeded');
+    // 202 saves an Operation first; the old completed source is not the new result.
+    await expect
+      .poll(
+        async () => {
+          const runs = (await detail(page, f)).runs;
+          return runs.length === 2 && runs[1].state === 'succeeded';
+        },
+        { timeout: 20000 },
+      )
+      .toBe(true);
     const next = await detail(page, f);
     expect(next.task.status).toBe('in_progress');
     expect(next.runs).toHaveLength(2);
@@ -540,6 +547,10 @@
     agent = await authorize(f);
     await startUI(page, 'FIXTURE_HANG');
     await page.getByRole('button', { name: '在节点上开始', exact: true }).click();
+    await page.route(`**/api/v1/tasks/${f.task.id}`, async (route) => {
+      await new Promise((resolve) => setTimeout(resolve, 400));
+      await route.continue();
+    });
     await expect
       .poll(async () => (await detail(page, f)).runs.at(-1)?.state, { timeout: 20000 })
       .toBe('running');
'''
subprocess.run(['git','apply','--check','-'], input=patch, text=True, check=True)
subprocess.run(['git','apply','-'], input=patch, text=True, check=True)
marker.write_text('Version-bound consent and async browser assertions applied.\n')
