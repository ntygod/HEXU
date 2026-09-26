import { useAppearance } from './appearance.js';
import { NativeResources } from './native.js';
import { NodeResources } from './nodes.js';
import { TeamSettings } from './team.js';
import { useApp } from './state.js';
import { Button, Icon } from '../../../packages/ui/src/index.js';
import './resources.css';

export function Settings() {
  const { theme, density, toggleTheme, toggleDensity } = useAppearance();
  const { data, connected } = useApp();
  const team = data.mode === 'team-local';
  return (
    <div className="settings-workspace">
      <nav className="settings-navigation" aria-label="设置分区">
        <span className="eyebrow">资源与设置</span>
        <a href="#settings-account">
          <Icon name="people" size={16} />
          {team ? '空间与账号' : '当前环境'}
        </a>
        <a href="#settings-resources">
          <Icon name="monitor" size={16} />
          {team ? '节点与目录' : '工具与目录'}
        </a>
        <a href="#settings-appearance">
          <Icon name="density" size={16} />
          外观与连接
        </a>
      </nav>
      <div className="settings-content">
        <section id="settings-account">
          {team ? (
            <TeamSettings />
          ) : (
            <>
              <header className="work-page-heading">
                <div>
                  <span className="eyebrow">本机预览</span>
                  <h1>资源与设置</h1>
                  <p>查看可用的工具、授权目录和当前环境。</p>
                </div>
              </header>
              <div className="resource-notice">
                <Icon name="monitor" />
                <div>
                  <strong>{data.user.name} · 示例身份</strong>
                  <p>当前为本机开发预览，尚未登录真实个人账号。真实账号使用独立的本机团队模式。</p>
                </div>
              </div>
            </>
          )}
        </section>
        <section id="settings-resources">
          {team ? (
            <NodeResources />
          ) : (
            <>
              <NativeResources />
              <article className="resource-row">
                <Icon name="spark" />
                <div>
                  <h3>模拟适配器</h3>
                  <p>用于体验等待、回复、停止和失败，不调用模型或生成真实代码。</p>
                </div>
                <span className="badge neutral">交互演示</span>
              </article>
            </>
          )}
        </section>
        <section id="settings-appearance" className="preferences-surface">
          <h2>外观与连接</h2>
          <div className="preference-row">
            <div>
              <strong>显示主题</strong>
              <p>当前为{theme === 'dark' ? '深色' : '浅色'}主题</p>
            </div>
            <Button onClick={toggleTheme}>
              {theme === 'light' ? '使用深色主题' : '使用浅色主题'}
            </Button>
          </div>
          <div className="preference-row">
            <div>
              <strong>信息密度</strong>
              <p>调整文字、间距和控件大小</p>
            </div>
            <Button onClick={toggleDensity}>
              {density === 'compact' ? '使用舒适密度' : '使用紧凑密度'}
            </Button>
          </div>
          <div className="preference-row">
            <div>
              <strong>事件连接</strong>
              <p>连接状态与任务执行状态分别显示</p>
            </div>
            <span className={`badge ${connected ? 'neutral' : 'amber'}`}>
              {connected ? '已连接' : '正在重新连接'}
            </span>
          </div>
          <div className="preference-row">
            <div>
              <strong>模型用量与费用</strong>
              <p>当前没有完整费用账本。以工具报告及提供方账单为准。</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
