import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { Run, TaskStatus, User } from '../../contracts/src/index.js';
export function Icon({
  name,
  size = 18,
  ...rest
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    home: (
      <>
        <path d="m3 10 9-7 9 7v10H3z" />
        <path d="M9 20v-7h6v7" />
      </>
    ),
    folder: <path d="M3 5h6l2 3h10v12H3z" />,
    box: (
      <>
        <path d="M3 7h18v14H3zM2 3h20v4H2z" />
        <path d="M9 11h6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    chevron: <path d="m8 5 7 7-7 7" />,
    down: <path d="m6 9 6 6 6-6" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    people: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-2-4" />
      </>
    ),
    play: <path d="m7 4 14 8-14 8z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    chat: <path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5" />,
    file: (
      <>
        <path d="M5 3h9l5 5v13H5zM14 3v6h5" />
        <path d="M8 13h8M8 17h6" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />
      </>
    ),
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="18" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <path d="M6 7v10m0-4h6a6 6 0 0 0 6-6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="m9 2-.5 3-3 1-2-1-2 4 2.5 2v3L2 16l2 4 3-1 2 1 1 2h4l1-2 2-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-2-1-.5-3z" />
      </>
    ),
    bell: (
      <>
        <path d="M5 17h14l-2-3V9A5 5 0 0 0 7 9v5zM10 21h4" />
      </>
    ),
    board: (
      <>
        <rect x="3" y="4" width="7" height="16" rx="1" />
        <rect x="14" y="4" width="7" height="11" rx="1" />
      </>
    ),
    list: <path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1" />,
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    density: <path d="M4 5h16M4 12h16M4 19h16M8 8v1m0 6v1" />,
    external: (
      <>
        <path d="M13 3h8v8m0-8L10 14M9 4H4v16h16v-5" />
      </>
    ),
    upload: <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />,
    monitor: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M12 17v4M7 21h10" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
      </>
    ),
    moon: <path d="M20 14A8 8 0 0 1 10 4a8.5 8.5 0 1 0 10 10z" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    spark: <path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" />,
    warning: (
      <>
        <path d="m12 3 10 18H2zM12 9v5M12 17h.01" />
      </>
    ),
    link: (
      <>
        <path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name] ?? paths.file}
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <path fill="var(--hx-brand)" d="M3 4h7v13l12-7V4h7v24h-7V17l-12 7v4H3z" />
        <path fill="var(--hx-brand)" opacity="0.5" d="m10 9 12-5v6L10 17z" />
      </svg>
      <strong>HEXU</strong>
      <span>合序</span>
    </div>
  );
}
export function Button({
  children,
  variant = 'secondary',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${variant} ${props.className ?? ''}`}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
export function Avatar({ user, size = 'normal' }: { user?: User; size?: 'small' | 'normal' }) {
  return (
    <span className={`avatar ${user?.color ?? 'violet'} ${size}`} title={user?.name}>
      {user?.initial ?? '林'}
    </span>
  );
}
const statusText: Record<TaskStatus, string> = {
  todo: '待处理',
  in_progress: '进行中',
  done: '已完成',
  cancelled: '已取消',
};
export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge status-${status}`}>{statusText[status]}</span>;
}
const runText: Record<Run['state'], string> = {
  queued: '排队中',
  preparing: '准备中',
  running: '模拟运行中',
  waiting_input: '等待回复',
  waiting_approval: '等待模拟授权',
  stopping: '正在停止',
  succeeded: '本次模拟已结束',
  failed: '模拟执行失败',
  cancelled: '模拟执行已停止',
};
export function RunBadge({ run }: { run?: Run }) {
  return (
    <span className={`badge run-${run?.state ?? 'idle'}`}>
      {run
        ? run.observation === 'unknown'
          ? '连接未知 · 待核对'
          : run.provider === 'node'
            ? runText[run.state].replace('模拟', '节点')
            : run.provider === 'native'
              ? runText[run.state].replace('模拟', '原生')
              : runText[run.state]
        : '尚未开始执行'}
    </span>
  );
}
export function ToolMark({ tool }: { tool: 'claude-code' | 'codex' }) {
  return <span className={`toolmark ${tool}`}>{tool === 'claude-code' ? '✳' : '⌘'}</span>;
}
export function Dialog({
  title,
  children,
  onClose,
  drawer = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current
      ?.querySelector<HTMLElement>(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      )
      ?.focus();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${drawer ? 'drawer' : ''} ${wide ? 'wide' : ''}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">HEXU · 合序</span>
          <h2 id={id}>{title}</h2>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="folder" size={28} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
