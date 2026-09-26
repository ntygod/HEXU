import { NodeResources } from './nodes.js';
import { useState } from 'react';
import type { Project } from '../../../packages/contracts/src/index.js';
import type { ProjectRole, SpaceMember } from '../../../packages/contracts/src/identity.js';
import { request } from '../../../packages/client/src/index.js';
import { Avatar, Button, Dialog, Icon } from '../../../packages/ui/src/index.js';
import { useIdentity } from './identity.js';
import { useApp, useLoad, time } from './state.js';
const roleLabel: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  view: '只读',
  edit: '可编辑',
  manage: '项目管理',
};
export function TeamSettings() {
  const { data, refresh, notice } = useApp(),
    identity = useIdentity();
  const space = data.space!;
  const { value: members } = useLoad<{ items: SpaceMember[] }>(`/spaces/${space.id}/members`);
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<SpaceMember | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false),
    [currentPassword, setCurrentPassword] = useState(''),
    [newPassword, setNewPassword] = useState('');
  const manage = space.kind === 'team' && ['owner', 'admin'].includes(space.role);
  return (
    <div className="page team-settings">
      <div className="page-heading">
        <div>
          <span className="eyebrow">共同工作，边界清楚</span>
          <h1>空间与账号</h1>
          <p>个人工作只对自己可见；团队项目按项目成员权限开放。</p>
        </div>
        <span className="badge neutral">E2b1 · 本机团队模式</span>
      </div>
      <div className="team-settings-grid">
        <section className="panel team-card">
          <div className="team-card-heading">
            <Icon name="people" />
            <div>
              <h2>{space.name}</h2>
              <p>
                {space.kind === 'personal' ? '个人空间' : '团队空间'} · {roleLabel[space.role]}
              </p>
            </div>
          </div>
          <div className="team-members">
            {members?.items.map((member) => (
              <div className="team-member" key={member.id}>
                <Avatar user={data.members.find((m) => m.id === member.id)} />
                <div>
                  <strong>
                    {member.name}
                    {member.id === data.user.id ? '（你）' : ''}
                  </strong>
                  <small>{member.email}</small>
                </div>
                <span className="badge neutral">{roleLabel[member.role]}</span>
                {space.kind === 'team' &&
                  member.role !== 'owner' &&
                  (manage || member.id === data.user.id) && (
                    <Button onClick={() => setRemove(member)}>
                      {member.id === data.user.id ? '退出空间' : '移除成员'}
                    </Button>
                  )}
              </div>
            ))}
          </div>
          {space.kind === 'personal' ? (
            <p className="team-note">
              <Icon name="file" />
              这个空间不会因为你加入团队而自动公开。
            </p>
          ) : (
            <p className="team-note">加入空间不自动获得全部项目权限；请在项目页分配访问范围。</p>
          )}
        </section>
        <section className="panel team-card">
          <div className="team-card-heading">
            <Avatar user={data.user} />
            <div>
              <h2>{data.user.name}</h2>
              <p>{identity.state.user?.email}</p>
            </div>
          </div>
          <p className="muted">
            登录状态通过 HttpOnly Cookie 保留。退出或撤销会话后，服务端会重新检查访问。
          </p>
          <div className="team-account-actions">
            <Button onClick={() => setPasswordOpen(true)}>修改密码</Button>
            <Button onClick={() => void identity.signOut().catch((e) => notice(e.message, true))}>
              退出登录
            </Button>
            <Button
              onClick={async () => {
                try {
                  await request('/identity/revoke-sessions', { method: 'POST', body: {} });
                  await identity.refresh();
                } catch (e) {
                  notice((e as Error).message, true);
                }
              }}
            >
              退出所有会话
            </Button>
          </div>
        </section>
        {manage && <InvitationManager spaceId={space.id} />}
        <section className="panel team-card">
          <div className="team-card-heading">
            <Icon name="folder" />
            <div>
              <h2>建立新的团队空间</h2>
              <p>只需一个名称，不必先配置组织架构或开发环境。</p>
            </div>
          </div>
          <form
            className="team-inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const space = await request<{ id: string }>('/spaces', {
                  method: 'POST',
                  body: { name },
                });
                await identity.refresh(space.id);
                history.replaceState({}, '', '/');
                window.dispatchEvent(new PopStateEvent('popstate'));
              } catch (e) {
                notice((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              团队空间名称
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：产品研发"
              />
            </label>
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
              创建空间
            </Button>
          </form>
        </section>
      </div>
      <div className="notice-box team-execution-boundary">
        <Icon name="monitor" />
        <div>
          <strong>开发环境尚未接入，不共享宿主机执行权限。</strong>
          <p>
            这里可以真实管理任务、讨论、成果和成员。独立
            Runner、远程部署与真实模型联调仍未完成；团队模式不启用模拟或原生执行，也不读取宿主机工具配置。
          </p>
        </div>
      </div>
      <NodeResources key={space.id} />
      {remove && (
        <Dialog
          title={remove.id === data.user.id ? '退出团队空间' : '移除空间成员'}
          onClose={() => !busy && setRemove(null)}
        >
          <div className="dialog-body">
            <p>
              确认{remove.id === data.user.id ? '退出' : `移除「${remove.name}」`}
              ？此空间及项目的新访问会立即撤销，已有任务和讨论仍保留。
            </p>
            <p className="muted">不会删除对方账号，也不能收回此前已经看到的内容。</p>
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setRemove(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request(`/spaces/${space.id}/members/${remove.id}/remove`, {
                    method: 'POST',
                    body: {},
                  });
                  const self = remove.id === data.user.id;
                  setRemove(null);
                  if (self) await identity.refresh('');
                  else await refresh();
                } catch (e) {
                  notice((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认{remove.id === data.user.id ? '退出' : '移除'}
            </Button>
          </div>
        </Dialog>
      )}
      {passwordOpen && (
        <Dialog title="修改账号密码" onClose={() => !busy && setPasswordOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await request('/identity/change-password', {
                  method: 'POST',
                  body: { currentPassword, newPassword },
                });
                setCurrentPassword('');
                setNewPassword('');
                setPasswordOpen(false);
                notice('密码已修改，其他会话已撤销');
              } catch (e) {
                notice((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="dialog-body">
              <label className="field">
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </label>
              <label className="field">
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <p>修改后撤销其他登录会话。当前版本未接入邮箱找回。</p>
            </div>
            <div className="dialog-footer">
              <Button type="button" onClick={() => setPasswordOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy}>
                保存新密码
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
interface InviteRow {
  id: string;
  email: string;
  expiresAt: string;
  acceptedBy: string | null;
  revoked: number;
}
function InvitationManager({ spaceId }: { spaceId: string }) {
  const { refresh, notice } = useApp(),
    { value } = useLoad<{ items: InviteRow[] }>(`/spaces/${spaceId}/invitations`);
  const [email, setEmail] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel team-card invitation-card">
      <div className="team-card-heading">
        <Icon name="people" />
        <div>
          <h2>邀请同事</h2>
          <p>邀请绑定邮箱，48 小时内有效。链接仅显示一次。</p>
        </div>
      </div>
      <form
        className="team-inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const invite = await request<{ token: string | null }>(
              `/spaces/${spaceId}/invitations`,
              { method: 'POST', body: { email } },
            );
            setLink(invite.token ? `${location.origin}/join#${invite.token}` : '');
            await refresh();
            if (!invite.token) notice('这次邀请已生成过，原链接不再显示，请撤销后重新邀请');
          } catch (e) {
            notice((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          受邀邮箱
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
          />
        </label>
        <Button type="submit" variant="primary" busy={busy}>
          生成邀请链接
        </Button>
      </form>
      {link && (
        <div className="invitation-link-box">
          <strong>请通过可信渠道发给对应同事</strong>
          <input aria-label="邀请链接" readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                notice('邀请链接已复制');
              } catch {
                notice('请选中链接手动复制', true);
              }
            }}
          >
            复制链接
          </Button>
          <p>链接是加入凭证，不要贴入公开任务或截图。当前未发送邮件。</p>
        </div>
      )}
      <div className="invitation-history">
        {value?.items.map((invite) => (
          <div key={invite.id}>
            <div>
              <strong>{invite.email}</strong>
              <small>
                {invite.revoked
                  ? '已撤销'
                  : invite.acceptedBy
                    ? '已加入'
                    : Date.parse(invite.expiresAt) <= Date.now()
                      ? '已过期'
                      : `有效至 ${time(invite.expiresAt)}`}
              </small>
            </div>
            {!invite.revoked && !invite.acceptedBy && (
              <Button
                onClick={async () => {
                  try {
                    await request(`/spaces/${spaceId}/invitations/${invite.id}/revoke`, {
                      method: 'POST',
                      body: {},
                    });
                    setLink('');
                    await refresh();
                  } catch (e) {
                    notice((e as Error).message, true);
                  }
                }}
              >
                撤销邀请
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
export function ProjectAccess({ project }: { project: Project }) {
  const { data, refresh, notice } = useApp();
  const { value, error } = useLoad<{
    items: (Omit<SpaceMember, 'role'> & { role: ProjectRole })[];
  }>(`/projects/${project.id}/members`);
  const [target, setTarget] = useState(''),
    [role, setRole] = useState<ProjectRole>('edit'),
    [busy, setBusy] = useState(false);
  const change = async (id: string, value: ProjectRole | null) => {
    setBusy(true);
    try {
      await request(`/projects/${project.id}/members/${id}`, {
        method: 'POST',
        body: { role: value },
      });
      await refresh();
    } catch (e) {
      notice((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const managed = project.access === 'manage';
  return (
    <details className="project-access panel">
      <summary>
        <Icon name="people" />
        <strong>项目访问</strong>
        <span>
          {value?.items.length ?? 0} 位成员 · 你拥有{roleLabel[project.access ?? 'view']}权限
        </span>
        <Icon name="down" size={14} />
      </summary>
      <div className="project-access-body">
        {error && <p role="alert">{error}</p>}
        {value?.items.map((member) => (
          <div className="project-access-member" key={member.id}>
            <span>
              <strong>{member.name}</strong>
              <small>{member.email}</small>
            </span>
            {managed ? (
              <>
                <select
                  aria-label={`${member.name}的项目权限`}
                  disabled={busy}
                  value={member.role}
                  onChange={(e) => void change(member.id, e.target.value as ProjectRole)}
                >
                  <option value="view">只读</option>
                  <option value="edit">可编辑</option>
                  <option value="manage">项目管理</option>
                </select>
                <Button disabled={busy} onClick={() => void change(member.id, null)}>
                  移除项目访问
                </Button>
              </>
            ) : (
              <span className="badge neutral">{roleLabel[member.role]}</span>
            )}
          </div>
        ))}
        {managed && (
          <form
            className="team-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void change(target, role);
            }}
          >
            <label className="field">
              添加空间成员
              <select
                aria-label="添加空间成员"
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择成员</option>
                {data.members
                  .filter((m) => !value?.items.some((existing) => existing.id === m.id))
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              访问权限
              <select
                aria-label="访问权限"
                value={role}
                onChange={(e) => setRole(e.target.value as ProjectRole)}
              >
                <option value="view">只读</option>
                <option value="edit">可编辑</option>
                <option value="manage">项目管理</option>
              </select>
            </label>
            <Button type="submit" busy={busy} disabled={!target}>
              添加项目成员
            </Button>
          </form>
        )}
        <p className="team-note">
          空间角色不自动授予项目访问；私有任务不会因为拥有项目管理权限而被公开。
        </p>
      </div>
    </details>
  );
}
