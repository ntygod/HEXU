import { useMemo, useState } from 'react';
import { Button, Icon } from '../../../packages/ui/src/index.js';
const orders = [
  { id: 'OD-0925-103', name: '演示客户 A', amount: 1280, status: 'paid', month: '2026-09' },
  { id: 'OD-0925-104', name: '演示客户 B', amount: 468, status: 'paid', month: '2026-09' },
  { id: 'OD-0925-105', name: '演示客户 C', amount: 2350, status: 'pending', month: '2026-09' },
  { id: 'OD-0925-106', name: '演示客户 D', amount: 680, status: 'paid', month: '2026-09' },
  { id: 'OD-0925-107', name: '演示客户 E', amount: 1560, status: 'paid', month: '2026-09' },
  { id: 'OD-0925-108', name: '演示客户 F', amount: 980, status: 'pending', month: '2026-09' },
];
export function OrderPreview() {
  const [status, setStatus] = useState('all'),
    [month, setMonth] = useState('2026-09'),
    [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      orders.filter(
        (order) => order.month === month && (status === 'all' || order.status === status),
      ),
    [status, month],
  );
  const rows = filtered.slice((page - 1) * 5, page * 5);
  function download() {
    const csv =
      '\uFEFF' +
      [
        ['订单编号', '客户', '订单金额', '状态'],
        ...filtered.map((order) => [
          order.id,
          order.name,
          order.amount.toFixed(2),
          order.status === 'paid' ? '已支付' : '待支付',
        ]),
      ]
        .map((row) => row.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(','))
        .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `orders-${month}-demo.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="order-preview">
      <div className="preview-address">
        <Icon name="monitor" size={14} />
        <span>preview / orders / export</span>
        <span>演示业务页面</span>
      </div>
      <div className="preview-inner">
        <div className="preview-heading">
          <div>
            <h3>订单管理</h3>
            <p>查看订单，按月份导出所需数据。</p>
          </div>
          <span className="badge neutral">虚构订单</span>
        </div>
        <div className="preview-filters">
          <label>
            订单月份
            <select
              aria-label="订单月份"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
            >
              <option value="2026-09">2026 年 9 月</option>
              <option value="2026-08">2026 年 8 月</option>
            </select>
          </label>
          <label>
            订单状态
            <select
              aria-label="订单状态"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部状态</option>
              <option value="paid">已支付</option>
              <option value="pending">待支付</option>
            </select>
          </label>
          <Button variant="primary" onClick={download}>
            <Icon name="upload" size={15} />
            导出 CSV
          </Button>
        </div>
        <div className="table-scroll">
          <table className="order-table">
            <thead>
              <tr>
                <th>订单编号</th>
                <th>客户</th>
                <th>订单金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr key={order.id}>
                  <td>{order.id}</td>
                  <td>{order.name}</td>
                  <td>¥ {order.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
                  <td>
                    <span className={`badge ${order.status === 'paid' ? 'status-done' : 'amber'}`}>
                      {order.status === 'paid' ? '已支付' : '待支付'}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="table-empty">
                    没有匹配的演示订单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="preview-pagination">
          <span>共 {filtered.length} 条演示订单</span>
          <div>
            <button aria-label="上一页" disabled={page === 1} onClick={() => setPage(page - 1)}>
              <Icon name="back" size={13} />
            </button>
            <span className="current-page">{page}</span>
            <button
              aria-label="下一页"
              disabled={page * 5 >= filtered.length}
              onClick={() => setPage(page + 1)}
            >
              <Icon name="chevron" size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
