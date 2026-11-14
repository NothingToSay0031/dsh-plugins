window.__ModuleLoader__.load({
  id: '@local/dsh-model-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { MenuItemButton, IconFlatListOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const NS = 'local-model-history';
    const PROJECTION = 'localModelRequestHistory';
    const VIEW_ID = 'model-history';
    const EMPTY = [];
    const en = {
      view: 'Model History',
      menu: 'Model history',
      title: 'Model requests of this conversation',
      subtitle: 'One row per configuration change: the model and reasoning effort the requests actually used.',
      count: '{count} records',
      empty: 'No model request has been recorded in this conversation yet.',
      column: 'No.', columnTime: 'Time', columnTurn: 'Turn', columnProvider: 'Provider', columnModel: 'Model', columnEffort: 'Effort', columnReason: 'Reason', columnSpan: 'Span',
      defaultEffort: 'Provider default',
      effortDefaulted: 'The adapter chose this effort',
      current: 'In use',
      reasonInitial: 'First', reasonResume: 'Resumed', reasonChange: 'Changed', reasonSeries: 'New series',
    };
    const zh = {
      view: '模型记录',
      menu: '模型记录',
      title: '本会话的模型请求',
      subtitle: '配置发生变化时记一条：请求实际使用的模型与思考强度。',
      count: '共 {count} 条',
      empty: '本会话还没有记录到模型请求。',
      column: '序号', columnTime: '时间', columnTurn: '轮次', columnProvider: '提供方', columnModel: '模型', columnEffort: '思考强度', columnReason: '原因', columnSpan: '持续',
      defaultEffort: '提供方默认',
      effortDefaulted: '该强度由适配器默认选定',
      current: '使用中',
      reasonInitial: '首次', reasonResume: '续接', reasonChange: '变更', reasonSeries: '新序列',
    };
    const CSS = `
.mh-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:calc(var(--dsh-composer-height,152px) + 8px);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12,12px/1.5 sans-serif)}
.mh-scroll{box-sizing:border-box;flex:1;height:100%;min-height:0;overflow-y:auto;padding:0 20px 16px}
.mh-head{padding:18px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mh-title{font-size:15px;font-weight:600;line-height:1.4;margin:0 0 4px;color:var(--dsw-alias-label-primary)}
.mh-subtitle{color:var(--dsw-alias-label-secondary);line-height:1.6;margin:0 0 8px;overflow-wrap:anywhere}
.mh-current{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mh-current-value{color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere}
.mh-badge{display:inline-flex;align-items:center;flex:none;padding:0 6px;height:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mh-badge-live{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.mh-empty{color:var(--dsw-alias-label-secondary);padding:28px 0;line-height:1.7}
.mh-table{table-layout:fixed;border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums;margin-top:12px}
.mh-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;vertical-align:bottom}
.mh-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;overflow-wrap:anywhere}
.mh-table tr.mh-row-current td{background:var(--dsw-alias-bg-layer-1)}
.mh-num{color:var(--dsw-alias-label-tertiary);width:44px}
.mh-time{white-space:nowrap;color:var(--dsw-alias-label-secondary);width:88px}
.mh-turn{white-space:nowrap;color:var(--dsw-alias-label-secondary);width:74px}
.mh-provider{color:var(--dsw-alias-label-secondary);width:110px}
.mh-model{color:var(--dsw-alias-label-primary);font-weight:500}
.mh-effort{white-space:nowrap;width:120px}
.mh-reason{white-space:nowrap;width:92px}
.mh-span{white-space:nowrap;color:var(--dsw-alias-label-tertiary);width:84px}
.mh-reason-tag{display:inline-block;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
@media(max-width:720px){.mh-scroll{padding:0 12px 16px}.mh-provider,.mh-span{display:none}.mh-table td,.mh-table th{padding:6px 4px}}
`;
    /** Two-digit clock parts for the recorded timestamp. */
    function pad(value) { return String(value).padStart(2, '0'); }
    /** Wall-clock time of one entry, in the browser's own zone. */
    function clockOf(time) {
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '—';
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
    /** Full date and time of one entry, used as the row tooltip. */
    function stampOf(time) {
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '—';
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clockOf(time)}`;
    }
    /** Human span between two entries, in the shortest readable unit. */
    function spanOf(from, to) {
      if (typeof from !== 'number' || typeof to !== 'number') return '—';
      const seconds = Math.max(0, Math.round((to - from) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    }
    /** One table row for one recorded configuration. */
    function HistoryRow({ entry, index, total, rows, t }) {
      const isCurrent = index === total - 1;
      const next = rows[index + 1];
      const effort = entry.reasoningEffort ?? t('defaultEffort');
      const effortTitle = entry.reasoningEffort === null && entry.effortDefaulted ? t('effortDefaulted') : effort;
      const turn = entry.turn === null ? '—' : `${entry.turn}${entry.step === null ? '' : ` / ${entry.step}`}`;
      const reason = t(`reason${entry.reason.charAt(0).toUpperCase()}${entry.reason.slice(1)}`);
      return h('tr', { key: `${entry.seq}-${index}`, className: isCurrent ? 'mh-row-current' : undefined },
        h('td', { className: 'mh-num' }, String(index + 1)),
        h('td', { className: 'mh-time', title: stampOf(entry.time) }, clockOf(entry.time)),
        h('td', { className: 'mh-turn' }, turn),
        h('td', { className: 'mh-provider', title: entry.provider }, entry.provider),
        h('td', { className: 'mh-model', title: entry.model }, entry.model),
        h('td', { className: 'mh-effort', title: effortTitle }, effort),
        h('td', { className: 'mh-reason' }, h('span', { className: 'mh-reason-tag' }, reason)),
        h('td', { className: 'mh-span' }, isCurrent ? '—' : spanOf(entry.time, next.time)));
    }
    /** The table of recorded configurations, oldest first. */
    function HistoryTable({ rows, t }) {
      const head = h('tr', null,
        h('th', { className: 'mh-num' }, t('column')),
        h('th', { className: 'mh-time' }, t('columnTime')),
        h('th', { className: 'mh-turn' }, t('columnTurn')),
        h('th', { className: 'mh-provider' }, t('columnProvider')),
        h('th', { className: 'mh-model' }, t('columnModel')),
        h('th', { className: 'mh-effort' }, t('columnEffort')),
        h('th', { className: 'mh-reason' }, t('columnReason')),
        h('th', { className: 'mh-span' }, t('columnSpan')));
      const body = rows.map((entry, index) => h(HistoryRow, { key: `${entry.seq}-${index}`, entry, index, total: rows.length, rows, t }));
      return h('table', { className: 'mh-table' }, h('thead', null, head), h('tbody', null, body));
    }
    /** The heading: what the panel is, and the configuration in force now. */
    function HistoryHead({ latest, count, t }) {
      const current = latest === undefined
        ? null
        : h('div', { className: 'mh-current' },
            h('span', null, `${t('columnProvider')} / ${t('columnModel')}: `),
            h('span', { className: 'mh-current-value' }, `${latest.provider} / ${latest.model}`),
            h('span', { className: 'mh-current-value' }, '·'),
            h('span', { className: 'mh-current-value' }, latest.reasoningEffort ?? t('defaultEffort')),
            h('span', { className: 'mh-badge mh-badge-live' }, t('current')));
      const badge = h('div', { className: 'mh-current' }, h('span', { className: 'mh-badge' }, t('count', { count })));
      return h('div', { className: 'mh-head' },
        h('h1', { className: 'mh-title' }, t('title')),
        h('p', { className: 'mh-subtitle' }, t('subtitle')),
        current,
        badge);
    }
    /**
     * The conversation view: every recorded model configuration of this
     * session, oldest first, with the newest one marked as still in use.
     */
    function ModelHistoryView({ useProjection, t }) {
      const entries = useProjection(PROJECTION, value => value ?? EMPTY);
      const rows = entries || EMPTY;
      const latest = rows[rows.length - 1];
      const body = rows.length === 0
        ? h('div', { className: 'mh-empty' }, t('empty'))
        : h(HistoryTable, { rows, t });
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'mh-root' },
          h('div', { className: 'mh-scroll' },
            h(HistoryHead, { latest, count: rows.length, t }),
            body)));
    }
    /**
     * The row in the View tab row's More menu. The folded-view rows already
     * list this View when the tab row has no room for it, so the explicit row
     * only appears while the View has its own tab.
     */
    function ModelHistoryMenuRow({ entries, onOpen, onDismiss, t }) {
      const folded = (entries || []).some(entry => entry.id === VIEW_ID);
      if (folded) return null;
      return h(MenuItemButton, {
        icon: h(IconFlatListOutlineRegular, { size: 16 }),
        onSelect: () => { onDismiss(); onOpen(VIEW_ID); },
      }, t('menu'));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-history: locale');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 30,
          locale: NS,
          label: () => t('view'),
        }, ModelHistoryView));
        ctx.slots.inject('conversation.session.header.views.actions', () => ctx.slots.register({
          name: 'conversation.session.header.views.actions',
          id: VIEW_ID,
          order: 50,
          locale: NS,
          label: () => t('menu'),
        }, ModelHistoryMenuRow));
      },
    };
  },
});
