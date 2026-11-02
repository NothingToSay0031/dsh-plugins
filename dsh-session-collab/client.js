window.__ModuleLoader__.load({
  id: '@local/dsh-session-collab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    const NS = 'local.session-collab';

    const zh = {
      panel: '自主协作',
      subtitle: '设置模型的难度顺序，查看 Agent 自主协作的通信记录。',
      ranking: '模型排序',
      logs: '通信日志',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在加载…',
      loadFailed: '加载失败',
      invalidSnapshot: 'Host 返回的快照不符合 v2 契约，请确认 Host 与 Client 版本一致。',
      invalidRanking: 'Host 返回的模型排序无效，当前未保存顺序没有被替换。',
      unknownError: '请求失败，请重试。',
      active: '可用模型',
      activeHelp: '从上到下：由简单任务到困难任务。Agent 按任务难度选择模型，也可以直接指定这里的一个模型；停用区模型不能被指定。',
      dragHelp: '拖动模型可调整顺序或在两个区域间移动；也可使用每行的上移、下移、停用和启用按钮。',
      inactive: '停用模型',
      inactiveHelp: '这里的模型不会被使用，也不能被 Agent 直接指定。拖回上方可用区或点击启用，可重新加入排序。',
      noActive: '尚未启用模型。请从下方拖入模型，或点击启用。',
      noInactive: '没有停用模型。将上方模型拖到这里即可停用。',
      noModels: 'Host 尚未提供模型名单。刷新后重试；此处不会创建或配置提供方。',
      dropAtEnd: '拖到这里，放在本区末尾',
      dropToDisable: '拖到这里停用',
      moveUp: '上移',
      moveDown: '下移',
      disable: '停用',
      enable: '启用',
      draggableModel: '可拖动的模型',
      position: '位置',
      unavailable: '当前不可用',
      unavailableHelp: '当前不可用的模型仍可排序、停用或启用；实际使用时以 Host 的可用性检查为准，不会静默改用停用模型。',
      highestEffort: '默认最高思考强度',
      effortHelp: '新建协作者时默认使用所选模型支持的最高思考强度，也可在创建时指定该模型支持的某一档；本页只调整模型排序，不切换思考强度。',
      autoSaveReady: '调整后自动保存',
      saving: '保存中…',
      saved: '排序已保存',
      saveFailed: '保存失败',
      retrySave: '重试保存当前顺序',
      reconciling: '正在读取最新版本并重试…',
      preserved: '未保存顺序已保留。重试会先读取最新版本，再保存你当前的完整顺序。',
      conflict: '排序已被其他页面修改，请重试保存当前顺序。',
      logsHelp: '只读记录自动协作中的通信与会话创建；本页不发送消息、不回复，也不手动创建会话。',
      logLimit: '显示快照中最近的最多 100 条记录。',
      moreLogs: '还有较早记录；此版本暂不提供历史分页。',
      noLogs: '暂无通信记录。',
      sendKind: '会话通信',
      createKind: '创建协作者',
      otherKind: '协作记录',
      from: '来自',
      to: '发送给',
      unnamedSession: '未命名会话',
      deletedSession: '已删除会话',
      admitted: '已进入处理步骤',
      notAdmitted: '尚未确认进入处理步骤',
      acceptanceHelp: '请求被接受不等于任务完成；消息可能仍在等待处理。',
      stateAccepted: '已接受',
      statePrepared: '已记录意图',
      stateUnknown: '结果未知／待对账',
      stateCreated: '已创建',
      stateRejected: '已拒绝',
      stateFailed: '失败',
      statePending: '等待处理',
      stateQueued: '已排队',
      stateDelivered: '已投递',
      stateOther: '状态未确认',
      selectedModel: '选用模型',
      messageBody: '展开完整内容',
      emptyBody: '此记录没有文本内容。',
      unknownTime: '时间未知',
      dateLocale: 'zh-CN',
    };

    const en = {
      panel: 'Autonomous Collaboration',
      subtitle: 'Rank models by task difficulty and review autonomous collaboration activity.',
      ranking: 'Model ranking',
      logs: 'Communication log',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Loading…',
      loadFailed: 'Loading failed',
      invalidSnapshot: 'The Host snapshot does not match the v2 contract. Check Host and Client versions.',
      invalidRanking: 'The Host returned an invalid ranking. Your unsaved order has not been replaced.',
      unknownError: 'The request failed. Please retry.',
      active: 'Active models',
      activeHelp: 'Top to bottom: simple tasks to difficult tasks. Agents choose a model by task difficulty.',
      dragHelp: 'Drag models to reorder or move between areas, or use each row’s Move up, Move down, Disable and Enable buttons.',
      inactive: 'Disabled models',
      inactiveHelp: 'These models are not used. Drag one back to the active area or choose Enable to use it again.',
      noActive: 'No active models. Drag a model here from below, or choose Enable.',
      noInactive: 'No disabled models. Drag an active model here to disable it.',
      noModels: 'The Host has not provided any models. Refresh to retry; this page does not configure providers.',
      dropAtEnd: 'Drop here to place at the end of this area',
      dropToDisable: 'Drop here to disable',
      moveUp: 'Move up',
      moveDown: 'Move down',
      disable: 'Disable',
      enable: 'Enable',
      draggableModel: 'Draggable model',
      position: 'Position',
      unavailable: 'Currently unavailable',
      unavailableHelp: 'Unavailable models can still be ranked, disabled or enabled. The Host checks availability at use time; disabled models are never silently substituted.',
      highestEffort: 'Highest reasoning effort by default',
      effortHelp: 'New collaborators default to the highest reasoning effort the chosen model supports; creation may name a supported level. This page ranks models and does not change effort.',
      autoSaveReady: 'Changes save automatically',
      saving: 'Saving…',
      saved: 'Ranking saved',
      saveFailed: 'Saving failed',
      retrySave: 'Retry saving the current order',
      reconciling: 'Reading the latest version and retrying…',
      preserved: 'Your unsaved order is preserved. Retry reads the latest revision, then saves your complete current order.',
      conflict: 'Another page changed the ranking. Retry to save your current order.',
      logsHelp: 'Read-only records of autonomous messages and Session creation. This page cannot send, reply or manually create Sessions.',
      logLimit: 'Showing up to the latest 100 records from the snapshot.',
      moreLogs: 'Older records exist; historical pagination is not available in this version.',
      noLogs: 'No communication records yet.',
      sendKind: 'Session message',
      createKind: 'Collaborator creation',
      otherKind: 'Collaboration record',
      from: 'From',
      to: 'To',
      unnamedSession: 'Unnamed Session',
      deletedSession: 'Deleted Session',
      admitted: 'Admitted to a processing step',
      notAdmitted: 'Admission to a processing step is not confirmed',
      acceptanceHelp: 'Acceptance is not task completion; a message may still be waiting for processing.',
      stateAccepted: 'Accepted',
      statePrepared: 'Intent recorded',
      stateUnknown: 'Unknown / reconciliation needed',
      stateCreated: 'Created',
      stateRejected: 'Rejected',
      stateFailed: 'Failed',
      statePending: 'Pending',
      stateQueued: 'Queued',
      stateDelivered: 'Delivered',
      stateOther: 'Status unconfirmed',
      selectedModel: 'Selected model',
      messageBody: 'Expand full content',
      emptyBody: 'This record has no text content.',
      unknownTime: 'Unknown time',
      dateLocale: 'en-US',
    };

    const css = `
      .sc-page {
        height: 100%; min-height: 0; overflow: auto; box-sizing: border-box;
        padding: 28px 36px; background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary); font-size: 14px;
      }
      .sc-page * { box-sizing: border-box; }
      .sc-content { max-width: 1080px; margin: 0 auto; }
      .sc-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 22px; }
      .sc-header h1 { margin: 0 0 6px; font-size: 23px; line-height: 1.4; font-weight: 650; }
      .sc-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
      .sc-tabs { display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 12px; margin-bottom: 20px; }
      .sc-button {
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 12px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        font: inherit; cursor: pointer; line-height: 1.4;
      }
      .sc-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
      .sc-button:focus-visible, .sc-model-row:focus-visible, .sc-log details > summary:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px;
      }
      .sc-button:disabled { opacity: .45; cursor: not-allowed; }
      .sc-button[aria-current=page] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .sc-small-button { padding: 6px 9px; font-size: 12px; }
      .sc-savebar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; min-height: 32px; }
      .sc-save-status { font-size: 12px; line-height: 1.7; }
      .sc-save-status[data-state=saving], .sc-save-status[data-state=saved] { color: var(--dsw-alias-brand-primary); }
      .sc-alert { border: 1px solid var(--dsw-alias-brand-primary); border-radius: 10px; padding: 13px 15px; margin-bottom: 16px; line-height: 1.7; overflow-wrap: anywhere; }
      .sc-alert-title { font-weight: 600; }
      .sc-alert .sc-button { margin-top: 10px; }
      .sc-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 18px; margin-bottom: 18px; background: var(--dsw-alias-bg-layer-1); }
      .sc-card-header { margin-bottom: 14px; }
      .sc-card h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.5; }
      .sc-count { margin-left: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
      .sc-instructions { margin: 0 0 16px; }
      .sc-model-list { list-style: none; padding: 0; margin: 0; }
      .sc-model-row { display: flex; align-items: center; gap: 12px; padding: 15px 0; border-top: 1px solid var(--dsw-alias-border-l1); min-width: 0; cursor: grab; }
      .sc-model-row:active { cursor: grabbing; }
      .sc-model-row[data-dragging=true] { opacity: .55; }
      .sc-model-row[data-drop-before=true] { box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary); }
      .sc-position { min-width: 26px; text-align: center; font-size: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .sc-grip { color: var(--dsw-alias-label-secondary); letter-spacing: -2px; flex-shrink: 0; user-select: none; }
      .sc-model-details { min-width: 0; flex: 1; }
      .sc-model-name { font-size: 14px; font-weight: 600; line-height: 1.6; overflow-wrap: anywhere; }
      .sc-badges, .sc-controls, .sc-log-meta { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
      .sc-badges { margin-top: 6px; }
      .sc-badge { display: inline-block; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; padding: 2px 7px; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .sc-badge-warning { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
      .sc-controls { flex-shrink: 0; justify-content: flex-end; }
      .sc-drop-zone { margin-top: 10px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; }
      .sc-drop-zone[data-drop-target=true] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .sc-empty { padding: 22px 12px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.8; }
      .sc-log-list { padding: 0; margin: 0; list-style: none; }
      .sc-log-meta { justify-content: space-between; margin-bottom: 10px; }
      .sc-log-names { display: flex; gap: 10px 20px; flex-wrap: wrap; line-height: 1.7; margin-bottom: 10px; overflow-wrap: anywhere; }
      .sc-log-name-label { color: var(--dsw-alias-label-secondary); margin-right: 6px; font-size: 12px; }
      .sc-log-body { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.75; margin: 12px 0 0; }
      .sc-log details > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 12px; }
      .sc-log-selection { margin: 8px 0; }
      @media (max-width: 760px) {
        .sc-page { padding: 20px 16px; }
        .sc-header { gap: 12px; }
        .sc-header h1 { font-size: 20px; }
        .sc-card { padding: 14px; }
        .sc-model-row { flex-wrap: wrap; gap: 10px; }
        .sc-model-details { flex-basis: calc(100% - 65px); }
        .sc-controls { width: 100%; justify-content: flex-start; padding-left: 36px; }
      }
    `;

    const routeKey = route => JSON.stringify([route.provider, route.model]);
    const routeOnly = route => ({ provider: route.provider, model: route.model });
    const isRoute = route => route && typeof route.provider === 'string' && route.provider.length > 0
      && typeof route.model === 'string' && route.model.length > 0;

    function parseRanking(value) {
      if (!value || !Array.isArray(value.active) || !Array.isArray(value.inactive)
        || !Number.isSafeInteger(value.revision) || value.revision < 0) return null;
      const seen = new Set();
      for (const route of [...value.active, ...value.inactive]) {
        if (!isRoute(route) || seen.has(routeKey(route))) return null;
        seen.add(routeKey(route));
      }
      return {
        active: value.active.map(routeOnly),
        inactive: value.inactive.map(routeOnly),
        revision: value.revision,
      };
    }

    function rankingEquals(left, right) {
      return ['active', 'inactive'].every(zone => left[zone].length === right[zone].length
        && left[zone].every((route, index) => routeKey(route) === routeKey(right[zone][index])));
    }

    // Catalog additions are displayed as disabled, never implicitly enabled or saved on load.
    function includeCatalog(ranking, models) {
      const seen = new Set([...ranking.active, ...ranking.inactive].map(routeKey));
      const inactive = ranking.inactive.slice();
      for (const model of models) {
        if (isRoute(model) && !seen.has(routeKey(model))) {
          seen.add(routeKey(model));
          inactive.push(routeOnly(model));
        }
      }
      return { active: ranking.active.slice(), inactive, revision: ranking.revision };
    }

    // Remove and insert as one operation. Drag start never removes an item.
    function transferRoute(ranking, key, zone, beforeKey = null) {
      if (zone !== 'active' && zone !== 'inactive') return ranking;
      const route = [...ranking.active, ...ranking.inactive].find(item => routeKey(item) === key);
      if (!route || beforeKey === key) return ranking;
      if (beforeKey !== null && !ranking[zone].some(item => routeKey(item) === beforeKey)) return ranking;
      const next = {
        active: ranking.active.filter(item => routeKey(item) !== key),
        inactive: ranking.inactive.filter(item => routeKey(item) !== key),
        revision: ranking.revision,
      };
      const index = beforeKey === null ? next[zone].length
        : next[zone].findIndex(item => routeKey(item) === beforeKey);
      next[zone].splice(index, 0, routeOnly(route));
      return rankingEquals(ranking, next) ? ranking : next;
    }

    function Icon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true,
      }, h('path', { d: 'M3 4h13v9H9l-4 4v-4H3z' }),
      h('path', { d: 'M18 9h3v10h-3v3l-4-3H9v-3' }));
    }

    function modelInfo(route, models) {
      return models.find(model => routeKey(model) === routeKey(route)) || {
        ...route, name: route.model, providerName: route.provider, available: false,
      };
    }

    function RankingArea({ zone, routes, models, dragging, dropTarget, onStart, onEnd, onOver, onDrop, onMove, t }) {
      const active = zone === 'active';
      return h('section', {
        className: 'sc-card', 'aria-labelledby': `sc-${zone}-title`,
        onDragOver: event => onOver(event, zone, null),
        onDrop: event => onDrop(event, zone, null),
      },
      h('header', { className: 'sc-card-header' },
        h('h2', { id: `sc-${zone}-title` }, t(active ? 'active' : 'inactive'),
          h('span', { className: 'sc-count' }, routes.length)),
        h('div', { className: 'sc-muted' }, t(active ? 'activeHelp' : 'inactiveHelp'))),
      h('ol', { className: 'sc-model-list', 'aria-label': t(active ? 'active' : 'inactive') },
        ...routes.map((route, index) => {
          const key = routeKey(route);
          const model = modelInfo(route, models);
          const name = model.name || route.model;
          const button = (action, onClick, disabled = false) => h('button', {
            key: action, type: 'button', className: 'sc-button sc-small-button',
            disabled, draggable: false, onClick,
            'aria-label': `${t(action)} · ${name}`,
          }, t(action));
          const rowTarget = event => {
            const rect = event.currentTarget.getBoundingClientRect();
            return event.clientY < rect.top + rect.height / 2
              ? key : (routes[index + 1] ? routeKey(routes[index + 1]) : null);
          };
          return h('li', {
            key, className: 'sc-model-row', draggable: true, tabIndex: 0,
            'aria-roledescription': t('draggableModel'), 'aria-describedby': 'sc-drag-help',
            'data-dragging': dragging === key,
            'data-drop-before': !!dropTarget && dropTarget.zone === zone && dropTarget.beforeKey === key,
            onDragStart: event => onStart(event, key), onDragEnd: onEnd,
            onDragOver: event => onOver(event, zone, rowTarget(event)),
            onDrop: event => onDrop(event, zone, rowTarget(event)),
          },
          h('span', { className: 'sc-grip', 'aria-hidden': true }, '⋮⋮'),
          active && h('span', { className: 'sc-position', 'aria-label': `${t('position')} ${index + 1}` }, index + 1),
          h('div', { className: 'sc-model-details' },
            h('div', { className: 'sc-model-name' }, name),
            h('div', { className: 'sc-muted' }, model.providerName || route.provider),
            h('div', { className: 'sc-badges' },
              h('span', { className: 'sc-badge' }, t('highestEffort'),
                model.highestEffort ? ` · ${model.highestEffort}` : ''),
              !model.available && h('span', { className: 'sc-badge sc-badge-warning' }, t('unavailable')))),
          h('div', { className: 'sc-controls' }, ...(active ? [
            button('moveUp', () => onMove(key, zone, index > 0 ? routeKey(routes[index - 1]) : null), index === 0),
            button('moveDown', () => onMove(key, zone, routes[index + 2] ? routeKey(routes[index + 2]) : null), index === routes.length - 1),
            button('disable', () => onMove(key, 'inactive', null)),
          ] : [button('enable', () => onMove(key, 'active', null))])));
        })),
      !routes.length && h('div', { className: 'sc-empty' }, t(active ? 'noActive' : 'noInactive')),
      h('div', {
        className: 'sc-drop-zone',
        'data-drop-target': !!dropTarget && dropTarget.zone === zone && dropTarget.beforeKey === null,
        onDragOver: event => onOver(event, zone, null),
        onDrop: event => onDrop(event, zone, null),
      }, t(active ? 'dropAtEnd' : 'dropToDisable')));
    }

    function sessionLabel(log, side, sessions, t) {
      const identity = log[side] || log[`${side}SessionId`];
      const name = typeof log[`${side}Name`] === 'string' ? log[`${side}Name`].trim() : '';
      if (name && name !== identity) return name;
      const deleted = log[`${side}Deleted`] === true
        || (identity && !sessions.some(session => session.sessionId === identity));
      return t(deleted ? 'deletedSession' : 'unnamedSession');
    }

    function LogList({ snapshot, t }) {
      const stateKeys = {
        accepted: 'stateAccepted', prepared: 'statePrepared', unknown: 'stateUnknown',
        created: 'stateCreated', rejected: 'stateRejected', failed: 'stateFailed',
        pending: 'statePending', queued: 'stateQueued', delivered: 'stateDelivered',
      };
      const logs = snapshot.logs.slice(0, 100);
      return h('section', { 'aria-label': t('logs') },
        h('div', { className: 'sc-instructions sc-muted' },
          h('div', null, t('logsHelp')), h('div', null, t('acceptanceHelp')),
          h('div', null, t('logLimit')),
          snapshot.logsHasMore && h('div', null, t('moreLogs'))),
        !logs.length ? h('div', { className: 'sc-empty' }, t('noLogs'))
          : h('ol', { className: 'sc-log-list' }, ...logs.map((log, index) => {
            const date = new Date(log.createdAt);
            const validDate = Number.isFinite(date.getTime());
            const time = validDate ? date.toLocaleString(t('dateLocale')) : t('unknownTime');
            const selection = log.selection;
            const selected = selection && isRoute(selection) ? modelInfo(selection, snapshot.models) : null;
            const body = typeof log.body === 'string' ? log.body : '';
            const bodyNode = body ? h('div', { className: 'sc-log-body' }, body)
              : h('div', { className: 'sc-muted' }, t('emptyBody'));
            return h('li', { key: log.id || index }, h('article', { className: 'sc-card sc-log' },
              h('div', { className: 'sc-log-meta' },
                h('div', { className: 'sc-badges' },
                  h('span', { className: 'sc-badge' }, t(log.kind === 'send' ? 'sendKind'
                    : log.kind === 'create' ? 'createKind' : 'otherKind')),
                  h('span', { className: 'sc-badge' }, t(stateKeys[log.state] || 'stateOther'))),
                h('time', { className: 'sc-muted', dateTime: validDate ? date.toISOString() : undefined }, time)),
              h('div', { className: 'sc-log-names' },
                h('div', null, h('span', { className: 'sc-log-name-label' }, t('from')),
                  sessionLabel(log, 'from', snapshot.sessions, t)),
                h('div', null, h('span', { className: 'sc-log-name-label' }, t('to')),
                  sessionLabel(log, 'to', snapshot.sessions, t))),
              log.kind === 'send' && h('div', { className: 'sc-muted' }, t(log.admitted === true ? 'admitted' : 'notAdmitted')),
              selected && h('div', { className: 'sc-muted sc-log-selection' },
                `${t('selectedModel')}: ${selected.providerName || selected.provider} / ${selected.name || selected.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ''}`),
              body.length > 1200 ? h('details', null, h('summary', null, t('messageBody')), bodyNode) : bodyNode));
          })));
    }

    function Page({ api, t }) {
      const [snapshot, setSnapshot] = useState(null);
      const [draft, setDraft] = useState(null);
      const [tab, setTab] = useState('ranking');
      const [loading, setLoading] = useState(false);
      const [loadError, setLoadError] = useState('');
      const [saveState, setSaveState] = useState('idle');
      const [saveError, setSaveError] = useState('');
      const [dirty, setDirty] = useState(false);
      const [dragging, setDragging] = useState(null);
      const [dropTarget, setDropTarget] = useState(null);
      const tRef = useRef(t);
      tRef.current = t;
      const alive = useRef(false);
      const lifetime = useRef(0);
      const snapshotRef = useRef(null);
      const draftRef = useRef(null);
      const revisionRef = useRef(null);
      const editVersion = useRef(0);
      const dirtyRef = useRef(false);
      const savingRef = useRef(false);
      const blockedRef = useRef(false);
      const reconcilingRef = useRef(false);
      const loadSequence = useRef(0);
      const dragRef = useRef(null);
      const pumpRef = useRef(null);

      const errorMessage = error => error && typeof error.message === 'string'
        ? error.message : tRef.current('unknownError');

      const decodeSnapshot = value => {
        const ranking = parseRanking(value && value.ranking);
        if (!value || value.version !== 2 || !ranking || !Array.isArray(value.models)
          || !Array.isArray(value.sessions) || !Array.isArray(value.logs)) {
          throw new Error(tRef.current('invalidSnapshot'));
        }
        return { ...value, ranking, models: value.models.filter(isRoute) };
      };

      // One writer at a time; edits during an in-flight request are coalesced into its successor.
      const pump = useCallback(async () => {
        if (!alive.current || savingRef.current || reconcilingRef.current || blockedRef.current || !dirtyRef.current) return;
        const owner = lifetime.current;
        savingRef.current = true;
        setSaveState('saving');
        try {
          while (alive.current && lifetime.current === owner && dirtyRef.current && !blockedRef.current) {
            const version = editVersion.current;
            const submitted = draftRef.current;
            const result = await api('ranking', {
              active: submitted.active.map(routeOnly),
              inactive: submitted.inactive.map(routeOnly),
              revision: revisionRef.current,
            });
            if (!alive.current || lifetime.current !== owner) return;
            const saved = parseRanking(result);
            if (!saved || saved.revision <= revisionRef.current) {
              throw new Error(tRef.current('invalidRanking'));
            }
            revisionRef.current = saved.revision;
            if (snapshotRef.current) {
              snapshotRef.current = { ...snapshotRef.current, ranking: saved };
              setSnapshot(snapshotRef.current);
            }
            if (editVersion.current === version) {
              draftRef.current = saved;
              setDraft(saved);
              dirtyRef.current = false;
              setDirty(false);
            }
            // Otherwise keep the newer local draft intact and save it using this acknowledgement's revision.
          }
          if (alive.current && lifetime.current === owner) {
            setSaveError('');
            setSaveState('saved');
          }
        } catch (error) {
          if (!alive.current || lifetime.current !== owner) return;
          blockedRef.current = true;
          setSaveError(error && error.code === 'REVISION_CONFLICT'
            ? tRef.current('conflict') : errorMessage(error));
          setSaveState('error');
        } finally {
          if (lifetime.current === owner) savingRef.current = false;
        }
      }, [api]);
      pumpRef.current = pump;

      const load = useCallback(async (reconcile = false) => {
        if (!alive.current || (reconcile && (savingRef.current || reconcilingRef.current))) return;
        const owner = lifetime.current;
        const sequence = ++loadSequence.current;
        const startedAtVersion = editVersion.current;
        if (reconcile) {
          reconcilingRef.current = true;
          setSaveState('reconciling');
        }
        setLoading(true);
        setLoadError('');
        let shouldSave = false;
        try {
          const next = decodeSnapshot(await api('snapshot', {}));
          if (!alive.current || lifetime.current !== owner || sequence !== loadSequence.current) return;
          snapshotRef.current = next;
          setSnapshot(next);
          if (reconcile) {
            // A failed call may already have committed. Read its revision without replacing local intent.
            revisionRef.current = next.ranking.revision;
            blockedRef.current = false;
            setSaveError('');
            if (draftRef.current && rankingEquals(draftRef.current, next.ranking)) {
              draftRef.current = { ...draftRef.current, revision: next.ranking.revision };
              setDraft(draftRef.current);
              dirtyRef.current = false;
              setDirty(false);
              setSaveState('saved');
            } else {
              shouldSave = dirtyRef.current;
            }
          } else if (!draftRef.current || (!dirtyRef.current && !savingRef.current
            && startedAtVersion === editVersion.current
            && next.ranking.revision >= revisionRef.current)) {
            revisionRef.current = next.ranking.revision;
            draftRef.current = next.ranking;
            setDraft(next.ranking);
          }
          // Normal refreshes update metadata and logs, never an in-flight or unsaved ordering.
        } catch (error) {
          if (!alive.current || lifetime.current !== owner || sequence !== loadSequence.current) return;
          setLoadError(errorMessage(error));
          if (reconcile) {
            blockedRef.current = true;
            setSaveState('error');
          }
        } finally {
          if (lifetime.current === owner && sequence === loadSequence.current) {
            reconcilingRef.current = false;
            if (alive.current) setLoading(false);
            if (shouldSave && alive.current) void pumpRef.current();
          }
        }
      }, [api]);

      useEffect(() => {
        alive.current = true;
        lifetime.current += 1;
        void load();
        return () => {
          alive.current = false;
          lifetime.current += 1;
          loadSequence.current += 1;
          dragRef.current = null;
        };
      }, [load]);

      const move = (key, zone, beforeKey = null) => {
        if (!draftRef.current || !snapshotRef.current) return;
        const current = includeCatalog(draftRef.current, snapshotRef.current.models);
        const route = [...current.active, ...current.inactive].find(item => routeKey(item) === key);
        if (!route) return;
        const next = transferRoute(current, key, zone, beforeKey);
        if (next === current) return;
        draftRef.current = next;
        editVersion.current += 1;
        dirtyRef.current = true;
        setDraft(next);
        setDirty(true);
        if (!blockedRef.current && !reconcilingRef.current) setSaveState('saving');
        void pumpRef.current();
      };

      const endDrag = () => {
        dragRef.current = null;
        setDragging(null);
        setDropTarget(null);
      };
      const startDrag = (event, key) => {
        // Buttons remain ordinary keyboard and pointer controls, not drag handles.
        if (event.target && event.target.closest && event.target.closest('button')) {
          event.preventDefault();
          return;
        }
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-dsh-session-collab-model', key);
        dragRef.current = key;
        setDragging(key);
      };
      const over = (event, zone, beforeKey) => {
        if (!dragRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setDropTarget(old => old && old.zone === zone && old.beforeKey === beforeKey
          ? old : { zone, beforeKey });
      };
      const drop = (event, zone, beforeKey) => {
        if (!dragRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const key = dragRef.current;
        endDrag();
        move(key, zone, beforeKey);
      };
      const visible = draft && snapshot ? includeCatalog(draft, snapshot.models) : null;
      const unavailable = visible && [...visible.active, ...visible.inactive]
        .some(route => !modelInfo(route, snapshot.models).available);
      const statusKey = {
        idle: 'autoSaveReady', saving: 'saving', saved: 'saved', error: 'saveFailed', reconciling: 'reconciling',
      }[saveState];

      return h('div', { className: 'sc-page' }, h('style', null, css),
        h('div', { className: 'sc-content' },
          h('header', { className: 'sc-header' },
            h('div', null, h('h1', null, t('panel')), h('div', { className: 'sc-muted' }, t('subtitle'))),
            h('button', {
              type: 'button', className: 'sc-button', disabled: loading,
              onClick: () => { void load(); },
            }, t(loading ? 'refreshing' : 'refresh'))),
          h('nav', { className: 'sc-tabs', 'aria-label': t('panel') },
            ...['ranking', 'logs'].map(id => h('button', {
              key: id, type: 'button', className: 'sc-button',
              'aria-current': tab === id ? 'page' : undefined,
              onClick: () => { endDrag(); setTab(id); },
            }, t(id)))),
          loadError && h('div', { className: 'sc-alert', role: 'alert' },
            h('div', { className: 'sc-alert-title' }, t('loadFailed')),
            h('div', null, loadError)),
          saveState === 'error' && h('div', { className: 'sc-alert', role: 'alert' },
            h('div', { className: 'sc-alert-title' }, t('saveFailed')),
            saveError && h('div', null, saveError),
            h('div', { className: 'sc-muted' }, t('preserved')),
            h('button', {
              type: 'button', className: 'sc-button', disabled: loading || !dirty,
              onClick: () => { void load(true); },
            }, t('retrySave'))),
          !snapshot ? h('div', { className: 'sc-empty', role: 'status' }, t(loadError ? 'loadFailed' : 'loading'))
            : h(React.Fragment, null,
              h('div', { className: 'sc-savebar' },
                h('div', {
                  className: 'sc-save-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': true,
                  'data-state': saveState,
                }, t(statusKey)),
                tab === 'ranking' && h('div', { className: 'sc-muted' }, t('effortHelp'))),
              tab === 'ranking' && visible && h(React.Fragment, null,
                h('p', { id: 'sc-drag-help', className: 'sc-instructions sc-muted' }, t('dragHelp')),
                !visible.active.length && !visible.inactive.length
                  && h('div', { className: 'sc-empty' }, t('noModels')),
                ...['active', 'inactive'].map(zone => h(RankingArea, {
                  key: zone, zone, routes: visible[zone], models: snapshot.models, dragging, dropTarget,
                  onStart: startDrag, onEnd: endDrag, onOver: over, onDrop: drop, onMove: move, t,
                })),
                unavailable && h('p', { className: 'sc-muted' }, t('unavailableHelp'))),
              tab === 'logs' && h(LogList, { snapshot, t }))));
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);
        const controller = new AbortController();
        ctx.effect(() => () => controller.abort());
        const api = async (method, args) => {
          const result = await ctx.connection.rpc.call(
            '/api', 'session-collab', { method, args }, controller.signal,
          );
          if (!result || !result.ok) {
            const detail = result && result.error;
            const error = new Error(detail && detail.message ? detail.message : t('unknownError'));
            if (detail && detail.code) error.code = detail.code;
            throw error;
          }
          return result.value;
        };
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'session-collab', locale: NS, inject: () => ({ api }),
        }, Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'session-collab', order: 15, label: () => t('panel'),
        }, Icon));
      },
    };
  },
});
