import type { AgentReceiverPrincipal } from './agent-receiver-connections.js';

/** Display only server-validated existing receiver choices; never infer new authority here. */
export type OAuthReceiverChoice = Pick<
  AgentReceiverPrincipal,
  | 'connectionId'
  | 'connectionRevision'
  | 'participantId'
  | 'projectId'
  | 'target'
  | 'scopes'
  | 'expiresAt'
>;

export interface OAuthConsentPageView {
  client: { id: string; name: string };
  account?: { name: string; email: string };
  resource: string;
  redirectUri: string;
  scopes: string[];
  consentId: string;
  expiresAt: string;
  businessAccess: string;
  receivers?: OAuthReceiverChoice[];
}

const escapeHTML = (value: string | number): string =>
  String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${escapeHTML(name)}" value="${escapeHTML(value)}">`;

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN" data-density="comfortable">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHTML(title)} · HEXU</title>
  <link rel="stylesheet" href="/collaboration-auth/tokens.css">
  <link rel="stylesheet" href="/collaboration-auth/pages.css">
</head>
<body>
  <main class="oauth-page" aria-labelledby="page-title">
    <header class="oauth-header">
      <div class="oauth-header-top">
        <p class="oauth-brand">HEXU · 有限协作连接</p>
        <label class="oauth-choice oauth-theme-choice" for="oauth-light">
          <input type="checkbox" id="oauth-light">
          <span>浅色外观</span>
        </label>
      </div>
      <h1 id="page-title">${escapeHTML(title)}</h1>
    </header>
    ${content}
    <footer class="oauth-footer">此页面仅用于确认有限协作访问，不会启动任务或执行代码。</footer>
  </main>
</body>
</html>`;
}

function errorNotice(error?: string): string {
  return error ? `<div class="oauth-error" role="alert"><p>${escapeHTML(error)}</p></div>` : '';
}

function fact(label: string, value: string | number): string {
  return `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`;
}

function expiry(label: string, value: string): string {
  return `<div><dt>${escapeHTML(label)}</dt><dd><time datetime="${escapeHTML(value)}">${escapeHTML(value)}</time></dd></div>`;
}

export function renderOAuthSignIn(query: string, error?: string): string {
  return page(
    '登录以确认连接',
    `<p class="oauth-intro">使用现有 HEXU 账号登录。登录后，你可以查看应用、权限和接收连接，再决定是否授权。</p>
    ${errorNotice(error)}
    <form method="post" action="/collaboration-auth/sign-in" class="oauth-form">
      ${hidden('oauthQuery', query)}
      <div class="oauth-field">
        <label for="email">邮箱</label>
        <input id="email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required>
      </div>
      <div class="oauth-field">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <p class="oauth-help">登录本身不会批准应用访问。此入口不提供注册或密码重置。</p>
      <div class="oauth-actions">
        <button type="submit" class="oauth-primary">登录并查看授权</button>
      </div>
    </form>`,
  );
}

function receiverChoice(receiver: OAuthReceiverChoice, index: number): string {
  const id = `receiver-${index}`;
  const value = JSON.stringify({
    connectionId: receiver.connectionId,
    connectionRevision: receiver.connectionRevision,
  });
  return `<article class="oauth-receiver">
    <label class="oauth-choice" for="${id}">
      <input type="radio" id="${id}" name="receiver" value="${escapeHTML(value)}" aria-describedby="${id}-details" required>
      <span>接收连接 <span class="oauth-identifier">${escapeHTML(receiver.connectionId)}</span></span>
    </label>
    <dl class="oauth-facts oauth-receiver-facts" id="${id}-details">
      ${fact('连接修订', receiver.connectionRevision)}
      ${fact('项目 ID', receiver.projectId)}
      ${fact('参与者 ID', receiver.participantId)}
      ${fact('能力 ID', receiver.target.capabilityId)}
      ${fact('能力版本', receiver.target.capabilityVersion)}
      ${fact('端点修订', receiver.target.endpointRevision)}
      ${fact('委托授权 ID', receiver.target.grantId)}
      ${fact('委托授权修订', receiver.target.grantRevision)}
      ${fact('现有连接权限', receiver.scopes.join(' '))}
      ${expiry('连接到期时间', receiver.expiresAt)}
    </dl>
  </article>`;
}

export function renderOAuthConsent(
  view: OAuthConsentPageView,
  query: string,
  error?: string,
): string {
  const receivers = view.receivers ?? [];
  const canAccept = view.businessAccess === 'select_existing_receiver' && receivers.length > 0;
  return page(
    '确认协作访问',
    `<p class="oauth-intro">请核对应用和访问范围，并明确选择一个现有接收连接。</p>
    ${errorNotice(error)}
    ${
      view.account
        ? `<section class="oauth-section oauth-account" aria-labelledby="account-title">
      <h2 id="account-title">当前账号</h2>
      <dl class="oauth-facts">
        ${fact('姓名', view.account.name)}
        ${fact('邮箱', view.account.email)}
      </dl>
      <p class="oauth-help">请确认这是你希望用于本次授权的账号。</p>
    </section>`
        : ''
    }
    <section class="oauth-section" aria-labelledby="application-title">
      <h2 id="application-title">请求连接的应用</h2>
      <dl class="oauth-facts">
        ${fact('应用名称', view.client.name)}
        ${fact('客户端 ID', view.client.id)}
        ${fact('返回地址', view.redirectUri)}
        ${fact('资源地址', view.resource)}
        ${fact('请求权限', view.scopes.join(' '))}
        ${expiry('本次确认到期时间', view.expiresAt)}
      </dl>
    </section>
    <form method="post" action="/collaboration-auth/consent" class="oauth-form">
      ${hidden('oauthQuery', query)}
      ${hidden('consentId', view.consentId)}
      <fieldset class="oauth-section">
        <legend>允许的操作</legend>
        ${hidden('scopes', 'hexu:material_read')}
        <label class="oauth-choice" for="scope-material-read">
          <input type="checkbox" id="scope-material-read" checked disabled>
          <span>读取已授权的协助材料（必需）<span class="oauth-scope">hexu:material_read</span></span>
        </label>
        ${
          view.scopes.includes('hexu:respond')
            ? `<label class="oauth-choice" for="scope-respond">
          <input type="checkbox" id="scope-respond" name="scopes" value="hexu:respond">
          <span>提交协助回复（可选）<span class="oauth-scope">hexu:respond</span></span>
        </label>`
            : ''
        }
        <p class="oauth-help">操作仍受所选连接的现有权限限制。勾选不会扩大连接或委托授权范围。</p>
      </fieldset>
      <fieldset class="oauth-section" aria-describedby="receiver-help">
        <legend>选择现有接收连接（必选）</legend>
        <p class="oauth-help" id="receiver-help">以下使用真实标识和固定修订。请核对项目、参与者、能力、委托授权及到期时间。</p>
        ${
          canAccept
            ? receivers.map(receiverChoice).join('\n')
            : '<p class="oauth-notice" role="status">当前没有可用的现有接收连接，无法批准访问。你仍可以拒绝本次请求。</p>'
        }
      </fieldset>
      <section class="oauth-boundary" aria-labelledby="boundary-title">
        <h2 id="boundary-title">授权边界</h2>
        <ul>
          <li>仅限所选现有连接已获授权的协助范围，不授予父级 Task 或完整 Project 访问权。</li>
          <li>访问令牌最长有效 300 秒；连接或授权失效时，访问会提前结束。</li>
          <li>本次确认不授予后台长期访问或自动续期权限，也不会创建新的接收连接。</li>
        </ul>
      </section>
      <div class="oauth-actions">
        <button type="submit" name="accept" value="true" class="oauth-primary"${canAccept ? '' : ' disabled'}>批准本次访问</button>
        <button type="submit" name="accept" value="false" formnovalidate>拒绝</button>
      </div>
    </form>`,
  );
}

export function renderOAuthError(_status?: number): string {
  return page(
    '无法继续连接',
    '<div class="oauth-error" role="alert"><p>连接请求无效、已到期或已被使用。请关闭此页，从原客户端重新发起连接。</p></div>',
  );
}

/** Served as same-origin CSS; all palette and typography values come from W1 tokens.css. */
export const OAUTH_PAGE_CSS = `
* { box-sizing: border-box; }
html { min-inline-size: 0; background: var(--hx-bg-app); }
body {
  margin: 0;
  color: var(--hx-text-primary);
  font-family: var(--hx-font-ui);
  font-size: var(--hx-font-body);
  line-height: var(--hx-line-height-body);
}
.oauth-page {
  inline-size: calc(100% - var(--hx-space-6));
  max-inline-size: 52rem;
  margin: var(--hx-space-6) auto;
  padding: var(--hx-panel-padding);
  background: var(--hx-surface-panel);
  border: 1px solid var(--hx-border-subtle);
  border-radius: var(--hx-radius-panel);
  overflow-wrap: anywhere;
}
h1, h2, p { margin-block: 0 var(--hx-space-3); }
h1 { font-size: var(--hx-font-page-title); font-weight: 600; }
h2, legend { font-size: var(--hx-font-subtitle); font-weight: 600; }
.oauth-brand { color: var(--hx-brand-text); font-weight: 600; }
.oauth-header-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--hx-space-2) var(--hx-space-4); margin-block-end: var(--hx-space-3); }
.oauth-header-top .oauth-brand { margin: 0; }
.oauth-theme-choice { color: var(--hx-text-secondary); }
.oauth-intro { color: var(--hx-text-secondary); margin-block-end: var(--hx-space-5); }
.oauth-form { display: grid; gap: var(--hx-space-5); min-inline-size: 0; }
.oauth-field { display: grid; gap: var(--hx-space-2); min-inline-size: 0; }
.oauth-field label { font-weight: 600; }
input, button { font: inherit; }
.oauth-field input {
  inline-size: 100%;
  min-inline-size: 0;
  min-block-size: var(--hx-touch-target);
  padding: var(--hx-space-2) var(--hx-space-3);
  color: var(--hx-text-primary);
  background: var(--hx-surface-raised);
  border: 1px solid var(--hx-text-secondary);
  border-radius: var(--hx-radius-control);
}
.oauth-section { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
section.oauth-section { margin-block-end: var(--hx-space-5); }
.oauth-account { padding: var(--hx-space-4); border-radius: var(--hx-radius-control); background: var(--hx-surface-raised); }
legend { padding: 0; margin-block-end: var(--hx-space-3); max-inline-size: 100%; }
.oauth-facts { margin: 0; }
.oauth-facts > div {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr);
  gap: var(--hx-space-2) var(--hx-space-4);
  padding-block: var(--hx-space-2);
  border-block-end: 1px solid var(--hx-border-subtle);
}
dt { color: var(--hx-text-secondary); }
dd { margin: 0; min-inline-size: 0; }
.oauth-choice {
  display: flex;
  align-items: flex-start;
  gap: var(--hx-space-3);
  min-block-size: var(--hx-touch-target);
  padding-block: var(--hx-space-2);
  cursor: pointer;
}
.oauth-choice > span { min-inline-size: 0; }
.oauth-choice input {
  flex-shrink: 0;
  inline-size: var(--hx-space-4);
  block-size: var(--hx-space-4);
  margin: var(--hx-space-1) 0 0;
  accent-color: var(--hx-brand);
}
.oauth-scope, .oauth-identifier {
  display: block;
  color: var(--hx-text-secondary);
  font-family: var(--hx-font-code);
  font-size: var(--hx-font-code-size);
}
.oauth-receiver {
  margin-block-start: var(--hx-space-3);
  padding: var(--hx-space-4);
  border: 1px solid var(--hx-border-subtle);
  border-radius: var(--hx-radius-control);
  background: var(--hx-surface-raised);
}
.oauth-receiver:has(input:checked) { border-color: var(--hx-brand); }
.oauth-receiver-facts > div:last-child { border-block-end: 0; }
.oauth-help, .oauth-footer { color: var(--hx-text-secondary); }
.oauth-help { margin: var(--hx-space-2) 0 0; }
.oauth-footer {
  margin-block-start: var(--hx-space-5);
  padding-block-start: var(--hx-space-4);
  border-block-start: 1px solid var(--hx-border-subtle);
}
.oauth-error, .oauth-notice, .oauth-boundary {
  padding: var(--hx-space-4);
  border-radius: var(--hx-radius-control);
}
.oauth-error {
  margin-block-end: var(--hx-space-5);
  color: var(--hx-danger-text);
  background: var(--hx-danger-soft);
  border: 1px solid var(--hx-danger-marker);
}
.oauth-error p { margin: 0; }
.oauth-notice { color: var(--hx-pending-text); background: var(--hx-pending-soft); }
.oauth-boundary { background: var(--hx-surface-raised); }
.oauth-boundary ul { margin: 0; padding-inline-start: var(--hx-space-5); }
.oauth-boundary li + li { margin-block-start: var(--hx-space-2); }
.oauth-actions { display: flex; flex-wrap: wrap; gap: var(--hx-space-3); }
button {
  min-block-size: var(--hx-touch-target);
  padding: var(--hx-space-2) var(--hx-space-4);
  color: var(--hx-text-primary);
  background: var(--hx-surface-raised);
  border: 1px solid var(--hx-text-secondary);
  border-radius: var(--hx-radius-control);
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--hx-surface-hover); }
.oauth-primary { color: var(--hx-brand-foreground); background: var(--hx-brand); border-color: var(--hx-brand); }
.oauth-primary:hover:not(:disabled) { background: var(--hx-brand); text-decoration: underline; }
button:disabled { color: var(--hx-text-secondary); background: var(--hx-surface-raised); border-color: var(--hx-border-subtle); cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--hx-brand); outline-offset: var(--hx-space-1); }
@media (max-width: 40rem) {
  .oauth-page { padding: var(--hx-space-4); margin-block: var(--hx-space-4); }
  .oauth-facts > div { grid-template-columns: minmax(0, 1fr); gap: var(--hx-space-1); }
  .oauth-actions { flex-direction: column; }
  .oauth-actions button { inline-size: 100%; }
}
`;
