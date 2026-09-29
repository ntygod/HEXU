import { useState } from 'react';
import type {
  RestoreResultReport,
  RestoreResultView,
} from '../../../packages/contracts/src/checkpoint-restore-results.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time } from './state.js';
import { useAssistanceRead } from './assistance-common.js';
import './checkpoint-restore-results.css';
const states: Record<RestoreResultReport['state'], string> = {
  preparing: '已记录恢复意图',
  writing: '最后记录：暂存写入中',
  verified: '暂存已核验，未发布',
  publishing: '发布已开始，结果未确认',
  restored: '文件已发布（本机报告）',
  cancelled: '恢复已取消',
  failed: '恢复失败',
  interrupted: '恢复中断，结果未知',
};
const materials: Record<RestoreResultReport['materialState'], string> = {
  none: '没有保留材料',
  staging: '暂存仍保留',
  published: '已发布到新目录',
  unknown: '材料位置或发布结果未确认',
};
const cleanup: Record<RestoreResultReport['cleanup'], string> = {
  not_needed: '不需清理暂存',
  retained: '暂存保留，需本机明确处置',
  cleaning: '最后记录：清理中',
  cleaned: '本次暂存已清理',
  needs_attention: '清理需本机核对，未自动删除',
};
interface Page<T> {
  items: T[];
  nextCursor: number | null;
}
function Summary({ report }: { report: RestoreResultReport }) {
  return (
    <>
      <strong>{states[report.state]}</strong>
      <p>
        {materials[report.materialState]} · {cleanup[report.cleanup]}
      </p>
      <p>
        {report.completedFiles} / {report.totalFiles} 个文件 ·{' '}
        {report.writtenBytes.toLocaleString()} / {report.totalBytes.toLocaleString()} 字节
      </p>
      <p>
        暂存核验：{report.verifiedAt ? time(report.verifiedAt) : '此记录没有单独核验时间'}
        ；最后本机记录：{time(report.recordedAt)}
      </p>
    </>
  );
}
function History({ path }: { path: string }) {
  const [cursor, setCursor] = useState<number | null>(null);
  const read = useAssistanceRead<
    Page<Pick<RestoreResultView, 'report' | 'sequence' | 'resultHash' | 'receivedAt'>>
  >(path + (cursor ? `?cursor=${cursor}` : ''), 0);
  if (read.denied) return <p role="alert">报告历史权限已失效，内容已清除。</p>;
  return (
    <section aria-label="恢复报告历史">
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读报告历史</Button>
        </p>
      )}
      {!read.value ? (
        <p role="status">正在读取报告历史…</p>
      ) : (
        read.value.items.map((r) => (
          <article key={r.sequence}>
            <p>
              报告 #{r.sequence} · 服务收到 {time(r.receivedAt)}
            </p>
            <Summary report={r.report} />
          </article>
        ))
      )}
      <div className="checkpoint-actions">
        {cursor && <Button onClick={() => setCursor(null)}>回到最新报告</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>更早报告</Button>
        )}
      </div>
    </section>
  );
}
function Result({ result, path }: { result: RestoreResultView; path: string }) {
  const [history, setHistory] = useState(false);
  return (
    <article className="restore-result-card" aria-label="恢复结果记录">
      {result.sourceKind === 'transfer' && (
        <p>
          <strong>接收节点恢复 · 最后报告</strong>
        </p>
      )}
      <Summary report={result.report} />
      {!result.nodeAuthorized && (
        <p className="form-error">
          原节点授权已失效。以下仅为历史，不能据此操作节点或判断文件可用。
        </p>
      )}
      <p>
        服务收到报告 #{result.sequence}：{time(result.receivedAt)}
      </p>
      <details>
        <summary>恢复来源与指纹</summary>
        <p>
          恢复记录 <code>{result.id}</code>
        </p>
        <p>
          节点 <code>{result.nodeId}</code>
        </p>
        <p>
          来源提交 <code>{result.commit}</code>
        </p>
        <p>
          {result.sourceKind === 'transfer' ? '接收传输' : '保留请求'}{' '}
          <code>{result.requestId}</code>
        </p>
        {result.sourceKind === 'transfer' && (
          <>
            <p>
              原保留请求 <code>{result.sourceRequestId}</code>
            </p>
            <p>
              发送节点 <code>{result.sourceNodeId}</code>；恢复使用的是接收节点自己的身份。
            </p>
          </>
        )}
        <p>来源对象保留至 {time(result.retentionExpiresAt)}，这不是输出目录的有效期限。</p>
        <p>
          计划指纹 <code>{result.report.planHash}</code>
        </p>
        <p>
          报告指纹 <code>{result.resultHash}</code>
        </p>
      </details>
      <Button onClick={() => setHistory((v) => !v)}>
        {history ? '收起报告历史' : '查看报告历史'}
      </Button>
      {history && <History path={`${path}/${encodeURIComponent(result.id)}/reports`} />}
    </article>
  );
}
export function CheckpointRestoreResults({
  retentionPath,
  editable,
  sourceKind,
}: {
  retentionPath: string;
  editable: boolean;
  sourceKind?: 'transfer';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen((v) => !v)}>{open ? '收起恢复记录' : '查看恢复记录'}</Button>
      {open && (
        <Results path={retentionPath + '/restores'} editable={editable} sourceKind={sourceKind} />
      )}
    </>
  );
}
function Results({
  path,
  editable,
  sourceKind,
}: {
  path: string;
  editable: boolean;
  sourceKind?: 'transfer';
}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const read = useAssistanceRead<Page<RestoreResultView>>(
    path + (cursor ? `?cursor=${cursor}` : ''),
    3000,
  );
  if (read.denied) return <p role="alert">恢复记录权限已失效，内容已清除。</p>;
  return (
    <section className="restore-results" aria-label="本机恢复结果">
      <div className="checkpoint-notice">
        <strong>节点最后报告，不是实时文件检测</strong>
        <p>报告不证明目录现在存在或内容未被修改。文件发布不等于接手、模型执行或任务完成。</p>
        <p>仅普通文件快照，不含 Git 历史、未提交内容及 LFS／子模块实体。</p>
      </div>
      {editable && (
        <details>
          <summary>在本机报告或确认丢失的回执</summary>
          <p>
            {sourceKind === 'transfer' ? '接收节点' : '原节点'}
            使用原状态目录及恢复时选择的目标；逐次确认
            REPORT。待确认时只重发原报告，不恢复文件或清理目录。
          </p>
          <pre>
            {
              'npm run runner:restore-report -- --state /path/to/private-state --target /original/restore-target'
            }
          </pre>
          <p>路径只在本机使用，不向网页提交。</p>
        </details>
      )}
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读恢复记录</Button>
        </p>
      )}
      {!read.value ? (
        <p role="status">正在读取恢复报告…</p>
      ) : !read.value.items.length ? (
        <p>尚无已确认的本机恢复报告；不代表没有本机恢复或文件。</p>
      ) : (
        read.value.items.map((r) => <Result key={r.id} result={r} path={path} />)
      )}
      <div className="checkpoint-actions">
        {cursor && <Button onClick={() => setCursor(null)}>回到最新恢复记录</Button>}
        {read.value?.nextCursor && (
          <Button onClick={() => setCursor(read.value!.nextCursor)}>更早恢复记录</Button>
        )}
      </div>
    </section>
  );
}
