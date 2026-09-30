import { useEffect, useState } from 'react';
import type { Run, Task } from '../../../packages/contracts/src/index.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import { MessageComposer } from './discussion.js';
import { NextInputPanel } from './next-inputs.js';
import './prompt-bar.css';

export function PromptBar({
  task,
  run,
  editable,
  executionDisabled = false,
  onConfigure,
  onContinue,
}: {
  task: Task;
  run?: Run;
  editable: boolean;
  executionDisabled?: boolean;
  onConfigure(): void;
  onContinue(): void;
}) {
  const hasNodeRun = run?.provider === 'node';
  const node = hasNodeRun && !run.node?.workBranch;
  const [intent, setIntent] = useState(node ? 'next' : 'discussion');
  useEffect(() => setIntent(node ? 'next' : 'discussion'), [node]);
  return (
    <div className="prompt-bar" aria-label="任务输入区">
      <div className="prompt-intents" aria-label="输入用途">
        <button aria-pressed={intent === 'discussion'} onClick={() => setIntent('discussion')}>
          任务讨论
        </button>
        {hasNodeRun && (
          <button aria-pressed={intent === 'next'} onClick={() => setIntent('next')}>
            下一轮要求
          </button>
        )}
        <span className="spacer" />
        <button
          className="text-button"
          disabled={!editable || executionDisabled || task.status === 'cancelled'}
          onClick={onConfigure}
        >
          <Icon name="settings" size={14} /> 工具与模型
        </button>
      </div>
      <div hidden={intent !== 'discussion'}>
        <MessageComposer taskId={task.id} />
        <p className="prompt-delivery">保存到任务讨论，不会作为即时输入发送给执行工具。</p>
      </div>
      {hasNodeRun && (
        <div hidden={intent !== 'next'}>
          <NextInputPanel run={run} editable={editable} allowCreate={!run.node?.workBranch} />
        </div>
      )}
      {node && (
        <div className="prompt-continue">
          <span>使用已保存的记录，明确选择下一轮材料。</span>
          <Button
            disabled={!editable || executionDisabled || task.status === 'cancelled'}
            onClick={onContinue}
          >
            沿原目录继续 <Icon name="arrow" size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}
