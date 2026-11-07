/* 网络拓扑管理系统 · 图形化接口测试控制台（原生 JS，零依赖） */
'use strict';

const $ = id => document.getElementById(id);
const esc = v => v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = o => JSON.stringify(o, null, 2);
const dash = v => (v === null || v === undefined || v === '') ? '<span style="color:#94a3b8">—</span>' : esc(v);
const TYPE_LABEL = { SWITCH: '交换机', CAMERA: '摄像头', BROADCAST: '广播', PERSONNEL: '人员定位', NVR: 'NVR', SIGNAL: '生产信号' };

const state = {
  nodes: [],
  ports: new Map(),      // nodeId -> PortVO[]
  selected: null,
  view: 'overview',
  chainMode: 'full',     // 'current' 当前节点链路 | 'full' 完整链路（默认展示整个环网）
  chainView: 'ring',     // 'ring' 环形拓扑 | 'tree' 树形明细
  chainTrees: [],        // 后端原始采区树（旧后端兼容时用于从树边还原闭环）
  showRingPorts: true,   // 环形图上默认标注相接端口（含空闲端口清单）
  ringTopology: null,    // 核心环网独立接口 GET /api/topology/ring 的响应缓存
  ringSource: 'fallback',// 'api' 新后端环网接口 | 'fallback' 旧后端从展开树还原
  ringLinks: [],         // /api/ring-links 链路清单（环网链路管理页 + 节点详情计数）
  ringLinkEditId: null,  // 正在编辑的环网链路 id（null = 新增模式）
  fullChains: [],        // 完整链路缓存：[{ root, d }]
  currentChain: null,    // 当前节点链路接口响应缓存（切换展示规则时免于重新 ping）
  fullFailed: [],        // 完整链路中查询失败的树
  fullSource: 'backend', // 完整链路数据来源：backend 后端接口 | frontend 前端聚合回退
  editPortId: null,
  history: []
};

/* ---------------- 基础请求 ---------------- */
async function api(method, path, body) {
  const started = performance.now();
  const opt = { method, headers: {} };
  if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(method)) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  let resp, text, data;
  try {
    resp = await fetch(path, opt);
    text = await resp.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } catch (err) {
    return { ok: false, http: 0, ms: Math.round(performance.now() - started), raw: err.message, message: err.message, data: null };
  }
  const ms = Math.round(performance.now() - started);
  const bizOk = data && typeof data === 'object' && 'code' in data ? data.code === 0 : resp.ok;
  const r = {
    ok: resp.ok && bizOk, http: resp.status, ms, raw: text, data: data && data.data !== undefined ? data.data : data,
    message: data && data.message ? data.message : (resp.ok ? 'success' : resp.statusText),
    body: data
  };
  state.history.unshift({ method, path, ms, http: resp.status, ok: r.ok });
  state.history = state.history.slice(0, 12);
  $('footStatus').textContent = `${method} ${path} → HTTP ${resp.status} · ${ms} ms · ${r.ok ? '成功' : r.message}`;
  renderHistory();
  return r;
}

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast ' + kind; }, 3200);
}

function showResult(elId, r) {
  $(elId).textContent = r.raw === undefined ? fmt(r.body || { message: r.message }) : r.raw;
  if (!r.ok) toast('请求失败：' + r.message, 'err');
  else toast('操作成功（HTTP ' + r.http + '，' + r.ms + ' ms）', 'ok');
}

function tag(type) { return `<span class="tag t-${esc(type)}">${esc(TYPE_LABEL[type] || type)}</span>`; }
function topoTag(t) {
  if (t === 'RING') return '<span class="tag t-ring">环网</span>';
  return '';
}
/** 节点级别标签：0 核心环网专属 / 1 采区一级节点 / >=2 采区内部设备。 */
function levelTag(level) {
  if (level === null || level === undefined) return '';
  const lv = Number(level);
  if (Number.isNaN(lv)) return '';
  const cls = lv === 0 ? 'lv-core' : (lv === 1 ? 'lv-root' : 'lv-dev');
  const txt = lv === 0 ? '核心环网' : (lv === 1 ? '采区一级' : '采区' + lv + '级');
  return `<span class="tag ${cls}" title="节点级别 ${esc(lv)}">${esc(txt)}</span>`;
}
function statusTag(s) {
  const v = (s || 'UNKNOWN').toUpperCase();
  return `<span class="st ${esc(v)}"><i></i>${esc(v)}</span>`;
}

/* ---------------- 健康检查 ---------------- */
async function checkHealth() {
  try {
    const r = await fetch('/__health');
    const j = await r.json();
    $('healthDot').className = 'dot ' + (j.online ? 'on' : 'off');
    $('healthText').textContent = j.online ? `后端在线 · ${j.paths} 个路径` : '后端不可达';
    $('backendAddr').textContent = j.backend || '—';
    if (!j.online) toast('后端未连通，请确认 Spring Boot 服务在 ' + (j.backend || ':8080') + ' 运行', 'err');
  } catch (err) {
    $('healthDot').className = 'dot off';
    $('healthText').textContent = '代理服务异常';
  }
}

/* ---------------- 节点列表 ---------------- */
async function loadNodes() {
  const r = await api('GET', '/api/nodes?size=200');
  if (!r.ok) { $('nodeList').innerHTML = '<div class="empty">加载失败：' + esc(r.message) + '</div>'; return; }
  state.nodes = (r.data && r.data.records) || [];
  state.fullChains = [];   // 节点列表变化后，完整链路缓存作废，需重新枚举根节点
  state.fullFailed = [];
  $('nodeCount').textContent = state.nodes.length;
  renderNodeList();
  fillSelects();
}

function renderNodeList() {
  const kw = $('listSearch').value.trim().toLowerCase();
  const type = $('listType').value;
  const list = state.nodes.filter(n =>
    (!type || n.deviceType === type) &&
    (!kw || [n.deviceName, n.ipAddress, n.location, n.deviceModel].some(v => String(v || '').toLowerCase().includes(kw)))
  );
  $('nodeList').innerHTML = list.length ? list.map(n => `
    <div class="node-i ${state.selected === n.id ? 'active' : ''}" data-id="${n.id}">
      <div class="n1"><span class="nm">${esc(n.deviceName)}</span>${tag(n.deviceType)}${levelTag(n.nodeLevel)}</div>
      <div class="n2"><span class="mono">#${n.id}</span><span>${esc(n.ipAddress || '无 IP')}</span>${n.parentId ? '' : '<span class="root">● 独立</span>'}</div>
    </div>`).join('') : '<div class="empty">没有匹配的节点</div>';
  $('nodeList').querySelectorAll('.node-i').forEach(el =>
    el.addEventListener('click', () => selectNode(Number(el.dataset.id))));
}

async function selectNode(id) {
  state.selected = id;
  renderNodeList();
  renderDetail();
  fillLinkForm();
  if (state.view === 'overview') await onSelectedInChainView();
  if (state.view === 'ports') await refreshPortView();
}

function nodeById(id) { return state.nodes.find(n => n.id === id); }

/* ---------------- 下拉框 ---------------- */
function optionsHtml(list, valueFn, labelFn, placeholder) {
  return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(x => `<option value="${esc(valueFn(x))}">${esc(labelFn(x))}</option>`).join('');
}

function fillSelects() {
  const all = state.nodes;
  const switches = all.filter(n => n.deviceType === 'SWITCH');
  const ipLabel = n => `${n.deviceName} (${n.ipAddress || '无 IP'}) · ${TYPE_LABEL[n.deviceType]}`;
  const idLabel = n => `#${n.id} ${n.deviceName} (${n.ipAddress || '无 IP'})`;

  const cParent = $('c_parent'), lParent = $('l_parent');
  const keepC = cParent.value, keepL = lParent.value;
  cParent.innerHTML = optionsHtml(all.filter(n => n.ipAddress), n => n.ipAddress, ipLabel, '（不接入，作为独立一级节点）');
  lParent.innerHTML = optionsHtml(all.filter(n => n.ipAddress), n => n.ipAddress, ipLabel, '请选择上级设备');
  if (keepC) cParent.value = keepC;
  if (keepL) lParent.value = keepL;

  const lNode = $('l_node'), pSwitch = $('p_switch');
  const keepN = lNode.value, keepP = pSwitch.value;
  lNode.innerHTML = optionsHtml(all, n => n.id, idLabel, '请选择节点');
  pSwitch.innerHTML = optionsHtml(switches, n => n.id, idLabel, '请选择交换机');
  if (keepN) lNode.value = keepN;
  if (keepP) pSwitch.value = keepP;
  if (state.selected) { lNode.value = String(state.selected); if (switches.some(s => s.id === state.selected)) pSwitch.value = String(state.selected); }
  if (!pSwitch.value && switches.length) pSwitch.value = String(switches[0].id);

  // 环网链路表单：两端设备下拉（按 id 提交，后端要求两端均为交换机）
  const rlOpts = optionsHtml(switches, n => n.id, idLabel, '请选择交换机');
  const keepFrom = $('rl_from').value, keepTo = $('rl_to').value;
  $('rl_from').innerHTML = rlOpts;
  $('rl_to').innerHTML = rlOpts;
  if (keepFrom) $('rl_from').value = keepFrom;
  if (keepTo) $('rl_to').value = keepTo;
}

async function portsOf(nodeId) {
  if (state.ports.has(nodeId)) return state.ports.get(nodeId);
  const r = await api('GET', `/api/nodes/${nodeId}/ports`);
  const list = r.ok ? (r.data || []) : [];
  state.ports.set(nodeId, list);
  return list;
}

/** 上级选择变化时，按上级类型决定是否需要端口下拉。 */
async function onParentChange(parentIp, portSelect, inboundEl) {
  const parent = state.nodes.find(n => n.ipAddress === parentIp);
  if (!parent) { portSelect.innerHTML = '<option value="">请先选上级</option>'; portSelect.disabled = true; return; }
  if (parent.deviceType === 'SWITCH') {
    const ports = await portsOf(parent.id);
    portSelect.innerHTML = '<option value="">请选择上级端口（必填）</option>' +
      ports.map(p => `<option value="${esc(p.portNo)}">${esc(p.portNo)} · ${p.portType === 'OPTICAL' ? '光口' : '电口'}</option>`).join('');
    portSelect.disabled = false;
  } else {
    portSelect.innerHTML = '<option value="">上级是摄像头/广播，无需端口</option>';
    portSelect.disabled = true;
  }
  if (inboundEl) {
    const current = state.selected && nodeById(state.selected);
    inboundEl.placeholder = current && current.deviceType === 'SWITCH' ? '本级是交换机，必填（如 XGE0/1）' : '非交换机无需填写';
  }
}

/** 同时提交 id 形式字段，兼容「按 id 连接」的另一版后端；当前服务会忽略未知字段。 */
function compatLinkFields(payload, parentIp, parentPortNo, inboundPortNo, selfId) {
  const parent = state.nodes.find(n => n.ipAddress === parentIp);
  if (parent) {
    payload.parentId = parent.id;
    if (parentPortNo) {
      const p = (state.ports.get(parent.id) || []).find(x => x.portNo === parentPortNo);
      if (p) payload.parentPortId = p.id;
    }
  }
  if (inboundPortNo && selfId) {
    const p = (state.ports.get(selfId) || []).find(x => x.portNo === inboundPortNo);
    if (p) payload.inboundPortId = p.id;
  }
  return payload;
}

/* ---------------- 拓扑总览：当前节点链路 / 完整链路 ----------------
 * 后端 GET /api/nodes/{id}/chain 的语义是「从该节点回溯到一个最初父节点，
 * 再返回这一整棵子树」，并不是全网。因此这里把两种查询明确分开：
 *   - 查询当前节点链路：只调用一次 chain，展示选中节点所属的那棵树；
 *   - 查询完整链路：调用后端 GET /api/topology/full 一次拿到所有独立树；
 *     若后端尚未提供该接口，回退为前端枚举根节点逐个调用 chain。
 */
const CHAIN_MODE = {
  current: {
    label: '查询当前节点链路',
    desc: '只返回选中节点所属的那棵采区树，根节点为该采区的变电所',
    summary: '当前节点链路',
    treeTitle: '采区树 · 当前节点所属'
  },
  full: {
    label: '查询完整链路',
    desc: '调用 GET /api/topology/full，返回全部采区树，每棵树的根节点都是一个采区变电所',
    summary: '完整链路',
    treeTitle: '采区树 · 全部采区'
  }
};

function setChainMode(mode, extra) {
  state.chainMode = mode;
  const m = CHAIN_MODE[mode];
  $('chainModeTip').innerHTML = `<b>当前查询：${m.label}</b> · ${m.desc}${extra ? ' · ' + esc(extra) : ''}`;
  $('chainSummaryTitle').innerHTML = `链路摘要 <span class="hint">${m.summary}</span>`;
  $('chainTreeTitle').innerHTML = `${m.treeTitle} <span class="hint">点击节点查看详情</span>`;
  $('btnChain').className = 'btn ' + (mode === 'current' ? 'btn-primary' : 'btn-outline');
  $('btnFullChain').className = 'btn ' + (mode === 'full' ? 'btn-primary' : 'btn-outline');
}

function clearTreeNote() {
  $('treeNote').style.display = 'none';
  $('treeNote').innerHTML = '';
}

function chainQuerying(text) {
  $('chainSummary').innerHTML = '查询中…';
  $('chainTree').innerHTML = '<div class="empty">' + esc(text) + '</div>';
  state.chainTrees = [];
  clearTreeNote();
  $('ringCanvas').innerHTML = '<div class="empty">' + esc(text) + '</div>';
  $('ringNote').textContent = '';
  $('ringLegend').innerHTML = '';
}

function chainFailed(msg) {
  $('chainSummary').innerHTML = '<span style="color:#dc2626">查询失败：' + esc(msg) + '</span>';
  $('chainTree').innerHTML = '<div class="empty">无数据</div>';
  state.chainTrees = [];
  clearTreeNote();
  $('ringCanvas').innerHTML = '<div class="empty">查询失败：' + esc(msg) + '</div>';
  $('ringNote').textContent = '';
  $('ringLegend').innerHTML = '';
}

/* ---------------- 采区树形视图：端口链路图 ----------------
 * 每棵树的根节点就是采区变电所（level=1），不需要前端重排 / 剪枝 / 开关。
 * 端口可视化语义（按「设备是否存在端口表」分成三条规则）：
 *   paired  上级有端口表 + 下级有端口表：上级「下联端口」(child.parentPortId/parentPortNo)
 *           与下级「接入端口」(child.inboundPortId/inboundPortNo) 成对标注，曲线相连；
 *   direct  上级有端口表 + 下级是无端口设备（视频监控 / 人员定位 / 应急广播 / NVR / 生产信号等）：
 *           只画上级下联端口，曲线从该端口直接接到下级设备节点卡，不画下级接入端口；
 *   plain   上级是无端口设备：这条连接的下联端口、接入端口都不展示，两台设备节点卡直接相连。
 *   设备其余端口照常展示：空闲端口、被核心环网 ring_link 占用的端口；
 *   根节点空闲端口列在左侧；非根节点右侧列空闲与下联端口。
 * 端口来源：链路树 NodeVO.ports（后端 enrich 已填充）；旧缓存缺字段时回退 /api/nodes/{id}/ports。
 */
const PG = {
  nodeW: 190, nodeH: 66, portW: 76, portH: 32,
  rowH: 42, gapToPort: 24, gapToChild: 58, gapToNode: 20,
  padX: 26, padY: 20, leftIdle: 104
};
const childNodeX = x => x + PG.nodeW + PG.gapToPort + PG.portW + PG.gapToChild + PG.portW + PG.gapToNode;
const rootNodeX = () => PG.padX + PG.leftIdle + PG.portW + PG.gapToPort;
const pgNum = v => Number(v).toFixed(1);
const pgBez = (x1, y1, x2, y2) => {
  const dx = Math.max(18, (x2 - x1) * 0.55);
  return `M${pgNum(x1)},${pgNum(y1)} C${pgNum(x1 + dx)},${pgNum(y1)} ${pgNum(x2 - dx)},${pgNum(y2)} ${pgNum(x2)},${pgNum(y2)}`;
};

/* 端口号稳定配色：与现场图纸一致（X1 红 / X2 橙 / X3 绿 / X4 青 / X5 蓝 / G1 紫 / G2 粉），其余按哈希取色。 */
const PORT_FIXED_COLORS = {
  X1: '#ef4444', X2: '#f97316', X3: '#10b981', X4: '#14b8a6',
  X5: '#3b82f6', G1: '#a855f7', G2: '#ec4899'
};
const PORT_PALETTE = ['#ef4444', '#f97316', '#10b981', '#14b8a6', '#3b82f6',
  '#a855f7', '#ec4899', '#6366f1', '#0ea5e9', '#f59e0b'];
function portColor(no) {
  const k = String(no === null || no === undefined ? '' : no).trim().replace(/口$/, '').toUpperCase();
  if (PORT_FIXED_COLORS[k]) return PORT_FIXED_COLORS[k];
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return PORT_PALETTE[h % PORT_PALETTE.length];
}
const portKey = p => p && p.id != null ? '#' + p.id : 'n:' + String((p && p.portNo) || '');
const portTypeName = p => p && p.portType === 'OPTICAL' ? '光口' : (p && p.portType ? '电口' : '');

/**
 * 兼容 v3.1 之前的后端：它忽略 scope 参数、返回整棵采区树且没有 hiddenBranches。
 * 这里按 ancestorPath 做与后端一致的裁剪：上级只保留路径上的那个子节点，查询节点的下级全部保留。
 * 这样页面在 8080 重启之前就能正确显示，重启后后端直接返回裁剪结果，本函数原样放行。
 */
function pruneChainTree(d) {
  if (!d || !d.tree) return d;
  if (Array.isArray(d.hiddenBranches)) { d.scope = d.scope || 'branch'; return d; }
  const path = Array.isArray(d.ancestorPath) ? d.ancestorPath.map(Number) : [];
  const target = Number(d.queriedNodeId);
  if (path.length < 2 || !Number.isFinite(target)) { d.hiddenBranches = []; return d; }
  const count = n => 1 + (n.children || []).reduce((s, c) => s + count(c), 0);
  const hidden = [];
  const walk = (node, idx) => {
    if (!node || idx >= path.length - 1) return;   // 到达查询节点：下级全部保留
    const next = path[idx + 1];
    const kids = node.children || [];
    node.children = kids.filter(c => {
      if (Number(c.id) === next) { walk(c, idx + 1); return true; }
      hidden.push({
        parentNodeId: node.id,
        parentPortId: c.parentPortId || null,
        parentPortNo: c.parentPortNo || null,
        nodeId: c.id,
        deviceName: c.deviceName || '',
        ipAddress: c.ipAddress || null,
        totalNodes: count(c)
      });
      return false;
    });
  };
  walk(d.tree, 0);
  d.scope = 'branch';
  d.hiddenBranches = hidden;
  d.totalHiddenNodes = hidden.reduce((s, h) => s + h.totalNodes, 0);
  d.totalNodes = count(d.tree);
  return d;
}

/**
 * 端口占用情况：ring = 核心环网链路占用；hidden = 本次「当前节点链路」裁剪掉的旁支占用。
 * 键统一用 'nodeId|portNo' 与 'nodeId|#portId' 两种，便于和节点/端口 id 任一形式匹配。
 * 被隐藏的旁支端口必须单独标注，否则会被误判成「空闲」。
 */
function ringPortUsage() {
  const ring = new Set(), hidden = new Map();
  const put = (nid, pno, pid, info) => {
    if (nid == null) return;
    const keys = [];
    if (pno) keys.push(nid + '|' + pno);
    if (pid != null) keys.push(nid + '|#' + pid);
    keys.forEach(k => info ? hidden.set(k, info) : ring.add(k));
  };
  (state.ringLinks || []).forEach(l => {
    put(l.fromNodeId, l.fromPortNo, l.fromPortId);
    put(l.toNodeId, l.toPortNo, l.toPortId);
  });
  if (state.chainMode === 'current') {
    (state.currentChain?.hiddenBranches || []).forEach(b =>
      put(b.parentNodeId, b.parentPortNo, b.parentPortId, b));
  }
  return { ring, hidden };
}

/** 设备是否存在端口表。只有登记过端口的交换机才有端口方块；
 *  视频监控 / 人员定位 / 应急广播 / NVR / 生产信号等一律是「无端口设备」。 */
const pgHasPorts = n => Array.isArray(n && n.ports) && n.ports.length > 0;

/** 判定一条上下级连接采用哪种端口展示模式（见本节顶部注释）。 */
function pgEdgeMode(parentA, childA) {
  if (!parentA.ports.length) return 'plain';
  return (childA.ports.length && childA.inbound && !childA.inbound.missing) ? 'paired' : 'direct';
}

/** 分析一台设备：下联端口 ↔ 下级设备、上联接入端口、空闲 / 环网占用端口。 */
function analyzePorts(node, isRoot, usage) {
  const ports = pgHasPorts(node) ? node.ports.filter(Boolean) : [];
  const match = (id, no) => ports.find(p =>
    (id != null && p.id != null && Number(p.id) === Number(id)) ||
    (no != null && no !== '' && String(p.portNo) === String(no))) || null;
  const children = (node.children || []).filter(c => c && c.id != null);
  const linked = children.map(c => {
    const p = match(c.parentPortId, c.parentPortNo);
    const label = c.parentPortNo || (c.parentPortId != null ? '端口#' + c.parentPortId : '—');
    return { port: p || { portNo: label, virtual: true }, child: c };
  });
  const used = new Set(linked.filter(x => !x.port.virtual).map(x => portKey(x.port)));

  let inbound = null;
  if (!isRoot) {
    inbound = match(node.inboundPortId, node.inboundPortNo)
      || (node.inboundPortNo ? { portNo: node.inboundPortNo, virtual: true } : null)
      || { portNo: '—', virtual: true, missing: true };
    if (!inbound.missing && !inbound.virtual) used.add(portKey(inbound));
  }

  const idle = ports.filter(p => !used.has(portKey(p))).map(p => {
    const k1 = node.id + '|' + p.portNo, k2 = node.id + '|#' + p.id;
    return {
      port: p,
      ring: usage.ring.has(k1) || usage.ring.has(k2),
      branch: usage.hidden.get(k1) || usage.hidden.get(k2) || null
    };
  });
  idle.sort((a, b) => String(a.port.portNo || '').localeCompare(String(b.port.portNo || ''), 'zh-CN', { numeric: true }));
  return { ports, linked, inbound, idle, leftIdle: isRoot ? idle : [], rightIdle: isRoot ? [] : idle };
}

/** 第一遍：测量每棵子树所需高度（下联行的高度取子树高度）。 */
function measurePortTree(node, depth, isRoot, usage) {
  const a = analyzePorts(node, isRoot, usage);
  const linkRows = a.linked.map(l => {
    const cm = measurePortTree(l.child, depth + 1, false, usage);
    return { h: Math.max(PG.rowH, cm.h + 4), cm };
  });
  const rowsH = linkRows.reduce((s, r) => s + r.h, 0) + a.rightIdle.length * PG.rowH;
  const h = Math.max(PG.nodeH + 14, rowsH + 14, a.leftIdle.length * PG.rowH + 14, 74);
  return { h, a, linkRows };
}

function pgBox(out, html, x, y, w, h) {
  out.boxes.push(html);
  out.maxRight = Math.max(out.maxRight, x + w);
  out.maxBottom = Math.max(out.maxBottom, y + h);
}
function pgPath(out, d, color, kind, title) {
  out.paths.push(`<path class="pg-link pg-link-${kind}" d="${d}" stroke="${color}"><title>${esc(title)}</title></path>`);
}
function pgPortBox(out, p, kind, x, cy, tip) {
  const color = p.missing ? '#94a3b8' : portColor(p.portNo);
  const text = p.missing ? '无端口'
    : { linked: '下联', inbound: '接入', idle: '空闲', ring: '环网', branch: '旁支' }[kind] || '';
  const y = cy - PG.portH / 2;
  pgBox(out, `<div class="pg-port pg-${kind}${p.missing ? ' pg-missing' : ''}" style="left:${pgNum(x)}px;top:${pgNum(y)}px;width:${PG.portW}px;--pc:${color}" title="${esc(tip)}">
      <b>${esc(p.portNo || '—')}</b><i>${esc(text)}</i></div>`, x, y, PG.portW, PG.portH);
}
function pgNodeBox(out, node, x, y, isRoot, a) {
  const sel = state.selected === node.id;
  const st = String(node.status || 'UNKNOWN').toUpperCase();
  const idle = a.idle.filter(p => !p.ring && !p.branch).length;
  const ring = a.idle.filter(p => p.ring && !p.branch).length;
  const branch = a.idle.filter(p => p.branch).length;
  const lvl = isRoot ? '根节点 · 采区变电所'
    : (node.nodeLevel != null ? '采区 ' + node.nodeLevel + ' 级设备' : '采区设备');
  const counts = a.ports.length
    ? `端口 ${a.ports.length} · 下联 ${a.linked.length} · 空闲 ${idle} · 环网 ${ring}`
      + (branch ? ` · 旁支 ${branch}` : '')
    : (isRoot ? '未登记端口' : '无端口表 · 与上级直连');
  pgBox(out, `<div class="pg-node${sel ? ' sel' : ''}${isRoot ? ' root' : ''}" data-id="${node.id}"
      style="left:${pgNum(x)}px;top:${pgNum(y)}px;width:${PG.nodeW}px" title="#${node.id} ${esc(node.deviceName || '')} · ${esc(counts)}">
      <div class="pg-n1"><span class="pg-id">#${esc(node.id)}</span><b>${esc(node.deviceName || '')}</b><span class="pg-st ${esc(st)}" title="状态 ${esc(st)}"></span></div>
      <div class="pg-n2">${esc(node.ipAddress || '无 IP')} · ${esc(lvl)}</div>
      <div class="pg-n3">${esc(counts)}</div>
    </div>`, x, y, PG.nodeW, PG.nodeH);
}

/** 第二遍：按测量结果生成绝对定位元素与 SVG 连线，返回本节点中心 y。
 *  showInbound 由上级那条连接决定：只有 paired 模式才在本节点左侧画「接入端口」。 */
function buildPortTree(node, x, top, depth, isRoot, usage, m, out, showInbound) {
  const a = m.a, cy = top + m.h / 2;
  pgNodeBox(out, node, x, cy - PG.nodeH / 2, isRoot, a);

  // 左侧：根节点列全部空闲 / 环网端口；非根节点仅在 paired 连接下列上联「接入端口」
  if (isRoot) {
    const list = a.leftIdle, n = list.length;
    list.forEach((it, i) => {
      const ly = top + m.h * (i + 0.5) / n;
      const lx = PG.padX + 14;
      const kind = it.branch ? 'branch' : (it.ring ? 'ring' : 'idle');
      const label = it.branch
        ? `其它链路占用（已隐藏旁支 #${it.branch.nodeId} ${it.branch.deviceName || ''}）`
        : (it.ring ? '核心环网链路占用' : '空闲端口');
      pgPortBox(out, it.port, kind, lx, ly,
        `端口 ${it.port.portNo} · ${portTypeName(it.port)} · ${label}${it.port.remark ? ' · ' + it.port.remark : ''}`);
      pgPath(out, pgBez(lx + PG.portW, ly, x, cy), portColor(it.port.portNo), 'idle',
        `${node.deviceName || ''} 的${label} ${it.port.portNo}`);
    });
  } else if (showInbound && a.inbound) {
    const ux = x - PG.gapToNode - PG.portW, p = a.inbound;
    pgPortBox(out, p, 'inbound', ux, cy,
      p.missing ? '该设备未登记接入端口'
        : `本机接入端口 ${p.portNo} · ${portTypeName(p)} · 连接上级设备`);
    pgPath(out, pgBez(ux + PG.portW, cy, x, cy), p.missing ? '#94a3b8' : portColor(p.portNo), 'short',
      `接入端口 ${p.portNo} → #${node.id} ${node.deviceName || ''}`);
  }

  let ry = top + 7;
  // 右侧：按连接模式决定端口胶囊与连线（paired 成对 / direct 端口直连设备 / plain 设备直连）
  m.linkRows.forEach((row, i) => {
    const l = a.linked[i];
    const py = ry + row.h / 2;
    const px = x + PG.nodeW + PG.gapToPort;
    const color = portColor(l.port.portNo);
    const childA = row.cm.a;
    const mode = pgEdgeMode(a, childA);
    const paired = mode === 'paired';
    const cx = childNodeX(x);
    const childCy = buildPortTree(l.child, cx, ry + (row.h - row.cm.h) / 2,
      depth + 1, false, usage, row.cm, out, paired);

    if (mode === 'plain') {
      // 上级是无端口设备：下联端口与接入端口都不展示，两台设备节点卡直接相连
      pgPath(out, pgBez(x + PG.nodeW, cy, cx, childCy), '#94a3b8', 'plain',
        `#${node.id} ${node.deviceName || ''} → #${l.child.id} ${l.child.deviceName || ''} · 上级无端口表，设备直连`);
    } else {
      const upNo = paired ? childA.inbound.portNo : (l.child.inboundPortNo || '—');
      pgPortBox(out, l.port, 'linked', px, py,
        paired
          ? `上级端口 ${l.port.portNo} · ${portTypeName(l.port)} → 下级 #${l.child.id} ${l.child.deviceName || ''} 的接入端口 ${upNo}`
          : `上级端口 ${l.port.portNo} · ${portTypeName(l.port)} → 直接接入下级 #${l.child.id} ${l.child.deviceName || ''}（无端口表设备）`);
      pgPath(out, pgBez(x + PG.nodeW, cy, px, py), color, 'short', `#${node.id} → 上级端口 ${l.port.portNo}`);

      // paired 连到下级接入端口胶囊，direct 直接连到下级设备节点卡
      const endX = paired ? cx - PG.gapToNode - PG.portW : cx;
      pgPath(out, pgBez(px + PG.portW, py, endX, childCy), color, 'main',
        paired
          ? `上级端口 ${l.port.portNo} ↔ 下级接入端口 ${upNo} · #${node.id} ${node.deviceName || ''} → #${l.child.id} ${l.child.deviceName || ''}`
          : `上级端口 ${l.port.portNo} → 直接接到 #${l.child.id} ${l.child.deviceName || ''}（该设备无端口表）`);
      out.labels.push({
        x: (px + PG.portW + endX) / 2,
        y: (py + childCy) / 2,
        color,
        text: paired ? '↔' : '→',
        title: paired ? `${l.port.portNo} ↔ ${upNo}` : `${l.port.portNo} → 直连无端口设备`
      });
    }
    ry += row.h;
  });
  // 右侧：空闲 / 环网占用端口（短枝，不接下级）
  a.rightIdle.forEach(it => {
    const py = ry + PG.rowH / 2, px = x + PG.nodeW + PG.gapToPort;
    const kind = it.branch ? 'branch' : (it.ring ? 'ring' : 'idle');
    const label = it.branch
      ? `其它链路占用（已隐藏旁支 #${it.branch.nodeId} ${it.branch.deviceName || ''}）`
      : (it.ring ? '核心环网链路占用' : '空闲端口');
    pgPortBox(out, it.port, kind, px, py,
      `端口 ${it.port.portNo} · ${portTypeName(it.port)} · ${label}${it.port.remark ? ' · ' + it.port.remark : ''}`);
    pgPath(out, pgBez(x + PG.nodeW, cy, px, py), portColor(it.port.portNo), 'idle',
      `${node.deviceName || ''} 的${label} ${it.port.portNo}`);
    ry += PG.rowH;
  });
  return cy;
}

/** 生成一棵采区树的端口链路图（HTML 元素 + 底层 SVG 连线）。 */
function portGraphHtml(tree, usage) {
  const m = measurePortTree(tree, 0, true, usage);
  const out = { boxes: [], paths: [], labels: [], maxRight: 0, maxBottom: 0 };
  buildPortTree(tree, rootNodeX(), PG.padY, 0, true, usage, m, out, false);
  const W = Math.ceil(out.maxRight + PG.padX), H = Math.ceil(out.maxBottom + PG.padY);
  return `<div class="pg-scroll"><div class="pg-canvas" style="width:${W}px;height:${H}px">
    <svg class="pg-links" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${out.paths.join('')}
      ${out.labels.map(l => `<text class="pg-arrow" x="${pgNum(l.x)}" y="${pgNum(l.y + 4)}" text-anchor="middle" fill="${l.color}"><title>${esc(l.title)}</title>${esc(l.text || '↔')}</text>`).join('')}
    </svg>${out.boxes.join('')}
  </div></div>`;
}

/** 旧缓存里的链路树可能不含 ports 字段，按需并发补齐（portsOf 自带缓存）。 */
async function ensureTreePorts(trees) {
  const missing = [];
  const walk = n => {
    if (!n) return;
    if (n.deviceType === 'SWITCH' && !Array.isArray(n.ports)) missing.push(n);
    (n.children || []).forEach(walk);
  };
  trees.forEach(walk);
  if (!missing.length) return;
  await Promise.all(missing.map(async n => { n.ports = await portsOf(n.id); }));
}

/** 树中是否包含某节点（用于高亮当前节点所属的采区树）。 */
function containsIdIn(t, id) {
  return !!t && (t.id === id || (t.children || []).some(c => containsIdIn(c, id)));
}

/** 根节点以下的设备台数（采区内部设备）。 */
function countDescendants(t) {
  return (t.children || []).reduce((s, c) => s + 1 + countDescendants(c), 0);
}

/** 树形卡片统一入口：直接渲染后端返回的每棵采区树，端口成对连线展示。 */
async function renderTreeCard() {
  const source = state.chainTrees;
  const trees = (source || []).filter(Boolean);
  $('chainTreeTitle').innerHTML = `${CHAIN_MODE[state.chainMode].treeTitle}`
    + ' <span class="hint">根节点为采区变电所 · 端口直连 / 成对连线 · 点击节点查看详情</span>';
  const note = $('treeNote');
  note.style.display = 'block';
  note.innerHTML = '<b>端口链路图</b>：每棵树的<b>根节点就是采区变电所（level=1）</b>。'
    + '① 上下级<b>都有端口表</b>：上级<b>下联端口 ↔ 下级接入端口</b>成对标注并连线；'
    + '② <b>上级有端口表、下级是无端口设备</b>（视频监控 / 人员定位 / 应急广播 / NVR / 生产信号等）：'
    + '只展示上级<b>下联端口</b>，由该端口<b>直接接到下级设备</b>，不画接入端口；'
    + '③ <b>上级是无端口设备</b>：接入端口与下联端口<b>都不展示</b>，两台设备直接相连。'
    + '空闲端口虚线短枝展示，被核心环网占用的端口标为「环网」；核心环网（level=0）不进树状图，只在「◉ 环形」视图展示。'
    + (state.chainMode === 'current'
        ? ' <b>当前节点链路</b>：上级只保留「采区变电所 → … → 查询节点」这条主干，'
          + '<b>查询节点的下级全部展开</b>；上级其它端口挂的旁支已隐藏，'
          + '其端口标为「旁支」而不是空闲。点「查询完整链路」查看全部采区树。'
        : '');
  $('portLegend').innerHTML = `
    <span class="pk"><i class="sw" style="background:#ef4444;color:#fff">下联</i>上级端口（接下级）</span>
    <span class="pk"><i class="sw" style="background:#fff;border:1.5px solid #f97316;color:#f97316">接入</i>下级接入端口</span>
    <span class="pk"><i class="sw" style="background:#fff;border:1.5px dashed #10b981;color:#10b981">空闲</i>空闲端口</span>
    <span class="pk"><i class="sw" style="background:#f5f3ff;border:1.5px dashed #a78bfa;color:#7c3aed">环网</i>核心环网占用</span>
    <span class="pk"><i class="sw" style="background:#fff7ed;border:1.5px dashed #fb923c;color:#c2410c">旁支</i>上级其它端口的链路（本次已隐藏）</span>
    <span class="pk"><i class="sw line"></i>端口 ↔ 端口（都有端口表）</span>
    <span class="pk"><i class="sw line" style="border-top-color:#94a3b8"></i>端口 → 设备 / 设备直连（无端口表）</span>`;
  if (!trees.length) {
    $('chainTree').innerHTML = '<div class="empty">无采区树数据</div>';
    return;
  }
  await ensureTreePorts(trees);
  if (state.chainTrees !== source) return;   // 异步补端口期间已有更新的查询结果，放弃这次重绘
  const usage = ringPortUsage();
  const hidden = state.chainMode === 'current' ? (state.currentChain?.hiddenBranches || []) : [];
  const hiddenTip = hidden.length
    ? `<div class="tree-hidden-note">已隐藏 <b>${hidden.length}</b> 条旁支链路（共 <b>${hidden.reduce((s, h) => s + (h.totalNodes || 0), 0)}</b> 台设备，挂在上级其它端口下）：`
      + hidden.slice(0, 6).map(h => `#${esc(h.parentNodeId)} ${esc(h.parentPortNo || '—')} → #${esc(h.nodeId)} ${esc(h.deviceName || '')}`).join('；')
      + (hidden.length > 6 ? ' …' : '')
      + '。这些端口在图上标为「旁支」，不会被当作空闲端口。</div>'
    : '';
  $('chainTree').innerHTML = trees.map((t, i) => {
    const focus = state.selected != null && containsIdIn(t, state.selected);
    return `<div class="tree-group${focus ? ' focus' : ''}">
      <div class="tree-group-head">采区树 ${i + 1}/${trees.length} · 根节点 #${esc(t.id)} ${esc(t.deviceName || '')}
        <span class="cnt">${state.chainMode === 'current' ? '本链路设备' : '采区内设备'} ${countDescendants(t)} 台</span>${focus ? '<span class="focus-tag">当前节点所属</span>' : ''}</div>
      <div class="tree-root">● 根节点 · 采区变电所（左侧为未用于采区链路的端口）</div>
      ${hiddenTip}
      ${portGraphHtml(t, usage)}
    </div>`;
  }).join('');
  $('chainTree').querySelectorAll('.pg-node').forEach(el =>
    el.addEventListener('click', () => selectNode(Number(el.dataset.id))));
}

/* ---------------- 环形拓扑视图 ---------------- */
/*
 * 新版后端：核心环网是独立方法 GET /api/topology/ring，数据来自 ring_link 表，
 *   直接给出环网设备、全部物理链路（含两端端口）、主闭环节点顺序与直连弦。
 * 旧版后端兼容：该接口不存在时，退回「从链路树的 parent_id 树边」尝试还原闭环。
 * 两种数据源最终都转成同一张无向图，复用 SVG 排布逻辑。
 */

/** 加载核心环网独立接口；不可用时置空，由 renderRingView 走兼容模式。 */
async function loadRingTopology() {
  const r = await api('GET', '/api/topology/ring');
  state.ringTopology = (r.ok && r.data && Array.isArray(r.data.links)) ? r.data : null;
  if (state.chainView === 'ring') renderRingView();
}

/** 把 /api/topology/ring 的返回转换成环形渲染所需的无向图。 */
function collectRingGraph(ring) {
  const nodes = new Map(), edges = new Map(), adj = new Map(), groupOf = new Map();
  (ring.nodes || []).forEach(n => {
    nodes.set(n.id, n);
    adj.set(n.id, new Set());
    groupOf.set(n.id, n.nodeLevel === 0 ? 2 : 0);
  });
  (ring.links || []).forEach(l => {
    const a = Math.min(l.fromNodeId, l.toNodeId), b = Math.max(l.fromNodeId, l.toNodeId);
    const k = a + '-' + b;
    if (!edges.has(k)) {
      edges.set(k, { a, b, labels: [], kinds: new Set(), ringNo: l.ringNo, linkType: l.linkType });
    }
    edges.get(k).labels.push((l.fromPortNo || '?') + ' ↔ ' + (l.toPortNo || '?'));
    if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); }
    // 节点圆点配色：左环绿 / 右环红（核心节点由度数判定为紫色，不受此影响）
    if (l.ringNo === 'GREEN') { groupOf.set(l.fromNodeId, 0); groupOf.set(l.toNodeId, 0); }
    else if (l.ringNo === 'RED') { groupOf.set(l.fromNodeId, 1); groupOf.set(l.toNodeId, 1); }
  });
  return { nodes, edges, adj, groupOf };
}

/** 旧后端兼容：仅从链路树的 parent_id 树边还原无向图（v2 起环网由 ring_link 提供）。 */
function collectChainGraph(trees) {
  const nodes = new Map(), edges = new Map(), groupOf = new Map();
  const addEdge = (a, b, label, kind) => {
    if (a == null || b == null || a === b) return;
    const k = a < b ? a + '-' + b : b + '-' + a;
    if (!edges.has(k)) edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), labels: [], kinds: new Set() });
    const e = edges.get(k);
    e.labels.push(label); e.kinds.add(kind);
  };
  (trees || []).forEach((tree, gi) => {
    const walk = n => {
      if (!n || n.id == null) return;
      if (!nodes.has(n.id)) nodes.set(n.id, n);
      if (!groupOf.has(n.id)) groupOf.set(n.id, gi);
      if (n.parentId != null) addEdge(n.parentId, n.id,
        (n.parentPortNo || '?') + ' ↔ ' + (n.inboundPortNo || '?'), 'tree');
      (n.children || []).forEach(walk);
    };
    walk(tree);
  });
  const adj = new Map();
  nodes.forEach((_, id) => adj.set(id, new Set()));
  edges.forEach(e => {
    if (adj.has(e.a) && adj.has(e.b)) { adj.get(e.a).add(e.b); adj.get(e.b).add(e.a); }
  });
  return { nodes, edges, adj, groupOf };
}

/** 在 allowed 节点集内 DFS 枚举简单环，返回覆盖节点最多的那个。 */
function findMainCycle(g, allowed) {
  const ok = allowed || new Set(g.nodes.keys());
  const ids = [...ok].filter(id => g.adj.has(id)).sort((a, b) => a - b);
  let best = [], steps = 0, found = 0;
  const MAX_STEPS = 60000, MAX_CYCLES = 300;
  for (const start of ids) {
    if (steps > MAX_STEPS || found > MAX_CYCLES) break;
    const path = [start], onPath = new Set([start]);
    const dfs = cur => {
      if (++steps > MAX_STEPS) return;
      for (const nb of g.adj.get(cur) || []) {
        if (!ok.has(nb)) continue;
        if (nb === start && path.length >= 3) {
          found++;
          if (path.length > best.length) best = path.slice();
          continue;
        }
        // 只枚举「start 为环内最小 id」的环，避免同一个环被重复搜索
        if (nb < start || onPath.has(nb)) continue;
        onPath.add(nb); path.push(nb);
        dfs(nb);
        path.pop(); onPath.delete(nb);
      }
    };
    dfs(start);
  }
  return best;
}

/** 连通分量：多组彼此独立的环网各自成环。 */
function graphComponents(g) {
  const seen = new Set(), comps = [];
  for (const id of g.nodes.keys()) {
    if (seen.has(id)) continue;
    const stack = [id], comp = [];
    seen.add(id);
    while (stack.length) {
      const x = stack.pop(); comp.push(x);
      for (const nb of g.adj.get(x) || []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    comps.push(new Set(comp));
  }
  return comps;
}

const RING_COLORS = ['#059669', '#dc2626', '#2563eb', '#ea580c'];
const ringGroupColor = gi => RING_COLORS[(gi || 0) % RING_COLORS.length];
const ringEdgeKey = (a, b) => a < b ? a + '-' + b : b + '-' + a;

/** 生成单个环的 SVG。 */
function ringSvg(cycle, g, comp) {
  const n = cycle.length;
  const W = 900, H = 580, cx = W / 2, cy = H / 2, R = 196;
  // 逆时针排布：绿色左环在左、红色右环在右，与现场图纸方向一致
  const angle = i => -Math.PI / 2 - 2 * Math.PI * i / n;
  const pos = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  const idx = new Map(cycle.map((id, i) => [id, i]));
  const parts = [];

  // 环上相邻边：沿圆周画短弧，两端留出让节点圆不被线穿过的间隙
  const gap = Math.asin(Math.min(0.5, 15 / R));
  for (let i = 0; i < n; i++) {
    const a = cycle[i], b = cycle[(i + 1) % n];
    const e = g.edges.get(ringEdgeKey(a, b));
    const ga = g.groupOf.get(a), gb = g.groupOf.get(b);
    // 新接口直接给出环编号：GREEN 左环绿 / RED 右环红 / 其余紫；旧兼容模式按独立树分组
    const color = e && e.ringNo
      ? (e.ringNo === 'GREEN' ? '#059669' : e.ringNo === 'RED' ? '#dc2626' : '#2563eb')
      : (ga === gb ? ringGroupColor(ga) : '#2563eb');
    const x1 = cx + R * Math.cos(angle(i) - gap), y1 = cy + R * Math.sin(angle(i) - gap);
    const x2 = cx + R * Math.cos(angle(i + 1) + gap), y2 = cy + R * Math.sin(angle(i + 1) + gap);
    parts.push(`<path class="ring-edge" d="M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 0 0 ${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${color}"><title>#${a} ↔ #${b} · ${esc(e ? e.labels.join(' / ') : '环上链路')}</title></path>`);
    if (state.showRingPorts && e) {
      const [px, py] = pos(i + 0.5, R + 14);
      const raw = e.labels.length > 1 ? e.labels[0] + ' +' + (e.labels.length - 1) : (e.labels[0] || '');
      const label = raw.replace(/\s*↔\s*/g, '↔');
      const w = Math.max(32, label.length * 4.7 + 8);
      parts.push(`<rect x="${(px - w / 2).toFixed(1)}" y="${(py - 7).toFixed(1)}" width="${w.toFixed(1)}" height="14" rx="3" fill="#fff" opacity=".92"/>`);
      parts.push(`<text class="ring-port" x="${px.toFixed(1)}" y="${(py + 3.4).toFixed(1)}" text-anchor="middle">${esc(label)}<title>相接端口：${esc(label)}</title></text>`);
    }
  }

  // 非环边：不参与闭环的直连链路，画成穿过环内的紫色虚线弦
  let chords = 0;
  g.edges.forEach(e => {
    if (!comp.has(e.a) || !comp.has(e.b)) return;
    if (!idx.has(e.a) || !idx.has(e.b)) return;
    const ia = idx.get(e.a), ib = idx.get(e.b);
    if ((ia - ib + n) % n === 1 || (ib - ia + n) % n === 1) return;  // 已在环上
    const [x1, y1] = pos(ia, R - 16), [x2, y2] = pos(ib, R - 16);
    parts.push(`<line class="ring-chord" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"><title>#${e.a} ↔ #${e.b} · ${esc(e.labels.join(' / '))}</title></line>`);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    parts.push(`<rect x="${(mx - 42).toFixed(1)}" y="${(my - 10).toFixed(1)}" width="84" height="15" rx="3" fill="#fff" opacity=".92"/>`);
    parts.push(`<text class="ring-chord-label" x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle">${esc(e.labels.join(' / ') || '直连')}</text>`);
    chords++;
  });

  // 节点圆点 + 环外名称
  cycle.forEach((id, i) => {
    const node = g.nodes.get(id) || {};
    const [x, y] = pos(i, R);
    const deg = (g.adj.get(id) || new Set()).size;
    const isCore = deg > 2;
    const sel = state.selected === id;
    const color = isCore ? '#7c3aed' : ringGroupColor(g.groupOf.get(id));
    const r = isCore ? 13 : 10;
    const [lx, ly] = pos(i, R + 40);
    const c = Math.cos(angle(i)), s = Math.sin(angle(i));
    const anchor = c > 0.28 ? 'start' : (c < -0.28 ? 'end' : 'middle');
    const baseY = ly + (s > 0.35 ? -4 : (s < -0.35 ? 4 : 0));
    const raw = String(node.deviceName || ('#' + id));
    // 长名称两行均分，避免「7 字 + 1 字」这种单字独占一行的情况
    const mid = Math.ceil(raw.length / 2);
    const lines = raw.length > 7
      ? [raw.slice(0, mid), raw.slice(mid, mid + 8) + (raw.length > mid + 8 ? '…' : '')]
      : [raw];
    const tspan = lines.map((t, k) => `<tspan x="${lx.toFixed(1)}" dy="${k ? 13 : 0}">${esc(t)}</tspan>`).join('')
      + (node.ipAddress ? `<tspan class="ring-ip" x="${lx.toFixed(1)}" dy="12">${esc(node.ipAddress)}</tspan>` : '');
    const st = node.status === 'ONLINE' ? '#059669' : (node.status === 'OFFLINE' ? '#dc2626' : '#cbd5e1');
    parts.push(`<g class="ring-node" data-id="${id}">
      <title>#${id} ${esc(node.deviceName || '')} · ${esc(node.ipAddress || '无 IP')} · ${esc(node.status || 'UNKNOWN')}${isCore ? ' · 核心枢纽' : ''}</title>
      ${sel ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 7}" fill="#dbeafe" opacity=".9"/>` : ''}
      <circle class="rn-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${sel ? '#2563eb' : (isCore ? '#f5f3ff' : '#fff')}" stroke="${sel ? '#1d4ed8' : color}" stroke-width="${sel ? 3.5 : 2.5}"/>
      <text class="ring-id" x="${x.toFixed(1)}" y="${(y + 3.3).toFixed(1)}" text-anchor="middle" fill="${sel ? '#fff' : '#334155'}">${id}</text>
      <circle cx="${(x + r * 0.75).toFixed(1)}" cy="${(y - r * 0.75).toFixed(1)}" r="3.2" fill="${st}" stroke="#fff" stroke-width="1"/>
      <text class="ring-label" x="${lx.toFixed(1)}" y="${baseY.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle">${tspan}</text>
    </g>`);
  });
  return { html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="环网拓扑图">${parts.join('')}</svg>`, nodes: n, chords };
}

/** 切换树形 / 环形展示。 */
function setChainView(v) {
  state.chainView = v;
  $('btnViewRing').className = 'btn btn-sm ' + (v === 'ring' ? 'btn-primary' : 'btn-outline');
  $('btnViewTree').className = 'btn btn-sm ' + (v === 'tree' ? 'btn-primary' : 'btn-outline');
  $('ringCard').hidden = v !== 'ring';
  $('treeCard').hidden = v === 'ring';
  $('chainCols').classList.toggle('ring-mode', v === 'ring');
  if (v === 'ring') renderRingView();
}

/** 用核心环网接口（优先）或旧后端展开树（兼容）重绘环形图。 */
function renderRingView() {
  const box = $('ringCanvas'), note = $('ringNote'), legend = $('ringLegend');
  if (!box) return;
  const ring = state.ringTopology;
  const useApi = !!(ring && Array.isArray(ring.links) && ring.links.length);
  const g = useApi ? collectRingGraph(ring) : collectChainGraph(state.chainTrees);
  state.ringSource = useApi ? 'api' : 'fallback';
  renderRingPortList(useApi ? ring : null);
  if (!g.nodes.size) {
    box.innerHTML = '<div class="empty">暂无环网数据' + (useApi ? '' : '（旧后端兼容模式：请先点「查询完整链路」）') + '</div>';
    note.textContent = ''; legend.innerHTML = '';
    return;
  }
  const svgs = [], offRing = [], shownCycles = [];
  if (useApi) {
    // 后端已按环基识别全部独立环：主环 + 挂在环上节点的小环，每个环单独成图
    const cycles = (Array.isArray(ring.cycles) && ring.cycles.length)
      ? ring.cycles
      : (Array.isArray(ring.mainCycle) && ring.mainCycle.length >= 3
          ? [{ nodeIds: ring.mainCycle, sharedNodeIds: [], main: true }] : []);
    cycles.forEach(c => {
      if (!Array.isArray(c.nodeIds) || c.nodeIds.length < 3) return;
      svgs.push(ringSvg(c.nodeIds, g, new Set(c.nodeIds)));
      shownCycles.push(c);
    });
    if (!cycles.length && (ring.chords || []).length) offRing.push((ring.nodes || []).length);
  } else {
    graphComponents(g).forEach(comp => {
      const cycle = findMainCycle(g, comp);
      if (cycle.length < 3) { offRing.push(comp.size); return; }
      svgs.push(ringSvg(cycle, g, comp));
      shownCycles.push({ nodeIds: cycle, sharedNodeIds: [], main: true });
    });
  }
  if (!svgs.length) {
    box.innerHTML = '<div class="empty">当前链路里没有检测到闭合环。<br>可到「◎ 环网链路」页检查链路，或切到「树形」视图查看采区链路树。</div>';
    note.textContent = ''; legend.innerHTML = '';
    return;
  }
  box.innerHTML = svgs.map((s, i) => {
    const c = shownCycles[i] || {};
    const shared = (c.sharedNodeIds || []).map(id => {
      const n = g.nodes.get(id) || {};
      return `#${id} ${n.deviceName || ''}${n.ipAddress ? ' (' + n.ipAddress + ')' : ''}`;
    });
    const head = (svgs.length > 1 || shared.length)
      ? `<div class="ring-group-title">${c.main && svgs.length > 1 ? '主环' : '环状结构'} ${i + 1}/${svgs.length}`
        + ` · ${s.nodes} 台设备` + (shared.length ? ` · 跨环共享节点：${esc(shared.join('、'))}` : '') + '</div>'
      : '';
    return head + s.html;
  }).join('');
  const totalNodes = svgs.reduce((a, x) => a + x.nodes, 0);
  const totalChords = svgs.reduce((a, x) => a + x.chords, 0);
  note.innerHTML = `<b>${svgs.length}</b> 个环状结构 · 图上 <b>${totalNodes}</b> 个节点位（跨环共享节点会在各环重复出现）`
    + ` · <b>${totalChords}</b> 条非环直连弦`
    + (offRing.length ? ` · <b>${offRing.reduce((a, b) => a + b, 0)}</b> 台未入环` : '')
    + ' · 圆弧为环上物理链路（悬停查看相接端口），节点标注名称与 IP，紫色虚线为直连弦 · 点击节点查看详情'
    + (useApi
      ? ' · <b>数据来源：GET /api/topology/ring（ring_link 独立建模）</b>'
      : ' · <b>数据来源：旧后端兼容模式（从展开树还原）</b>');
  legend.innerHTML = (useApi
    ? '<span class="lg"><i class="sw" style="border-color:#2563eb"></i>环上物理链路（悬停看连接端口）</span>'
      + '<span class="lg"><i class="sw p" style="border-color:#7c3aed"></i>非环直连弦</span>'
    : Array.from({ length: Math.min(4, Math.max(1, new Set(g.groupOf.values()).size)) }, (_, i) =>
        `<span class="lg"><i class="sw" style="border-color:${ringGroupColor(i)}"></i>独立树 ${i + 1} 环段</span>`).join('')
      + '<span class="lg"><i class="sw" style="border-color:#7c3aed"></i>跨树闭合链路</span>'
      + '<span class="lg"><i class="sw p" style="border-color:#7c3aed"></i>非环边（直连）</span>')
    + '<span class="lg"><i class="dotc core"></i>跨环枢纽 / 核心节点</span>'
    + '<span class="lg"><i class="dotc"></i>环网交换机</span>'
    + '<span class="lg"><i class="dotc sel"></i>当前选中</span>';
  bindRingClicks();
}

/**
 * 环形视图的设备端口清单：每个端口都列出来，
 * 已被 ring_link 占用的端口标注对端设备与端口，其余明确标为「空闲」。
 */
async function renderRingPortList(ring) {
  const box = $('ringPortList');
  if (!box) return;
  if (!ring || !(ring.nodes || []).length) {
    box.innerHTML = '<div class="empty">端口清单需要新版后端的 GET /api/topology/ring（含每台设备全部端口）</div>';
    return;
  }
  await ensureTreePorts(ring.nodes || []);
  const nameOf = new Map((ring.nodes || []).map(n => [n.id, n.deviceName || ('#' + n.id)]));
  const used = new Map();
  (ring.links || []).forEach(l => {
    if (l.fromPortNo) used.set(l.fromNodeId + '|' + l.fromPortNo,
      (nameOf.get(l.toNodeId) || '#' + l.toNodeId) + ' · ' + (l.toPortNo || '—'));
    if (l.toPortNo) used.set(l.toNodeId + '|' + l.toPortNo,
      (nameOf.get(l.fromNodeId) || '#' + l.fromNodeId) + ' · ' + (l.fromPortNo || '—'));
  });
  const nodes = (ring.nodes || []).slice().sort((a, b) => a.id - b.id);
  box.innerHTML = nodes.map(n => {
    const ports = Array.isArray(n.ports) ? n.ports : [];
    const chips = ports.length ? ports.map(p => {
      const peer = used.get(n.id + '|' + p.portNo) || used.get(n.id + '|#' + p.id);
      const c = portColor(p.portNo);
      return `<span class="rp-chip ${peer ? 'used' : 'idle'}" style="--pc:${c}"
        title="${esc(p.portNo)} · ${p.portType === 'OPTICAL' ? '光口' : '电口'} · ${peer ? '接到 ' + esc(peer) : '空闲'}${p.remark ? ' · ' + esc(p.remark) : ''}">
        <b>${esc(p.portNo || '—')}</b><i>${peer ? '↔ ' + esc(peer) : '空闲'}</i></span>`;
    }).join('') : '<span class="hint">未录入端口</span>';
    return `<div class="rp-row">
      <div class="rp-name"><b>#${esc(n.id)} ${esc(n.deviceName || '')}</b><span>${esc(n.ipAddress || '无 IP')} · ${ports.length} 个端口</span></div>
      <div class="rp-chips">${chips}</div>
    </div>`;
  }).join('');
}

function bindRingClicks() {
  $('ringCanvas').querySelectorAll('.ring-node').forEach(el =>
    el.addEventListener('click', () => selectNode(Number(el.dataset.id))));
}

/** 查询当前节点链路：当前选中节点所属的那棵树。 */
async function showCurrentChain() {
  setChainMode('current');
  // 核心环网专属节点（level=0）不属于采区树：后端会返回 400，前端直接给出引导
  const picked = nodeById(state.selected);
  if (picked && picked.nodeLevel === 0) {
    $('chainSummary').innerHTML = '<span style="color:#7c3aed"><b>当前选中的是核心环网专属节点（level=0）</b>，不属于采区树。'
      + '请切到「◉ 环形」视图查看核心环网拓扑，或在左侧选择采区一级节点及其下级设备。</span>';
    $('chainTree').innerHTML = '<div class="empty">核心环网节点不参与采区链路查询</div>';
    state.chainTrees = [];
    state.currentChain = null;
    clearTreeNote();
    if (state.chainView === 'ring') renderRingView();
    return;
  }
  if (!state.selected) {
    $('chainSummary').innerHTML = '请先在左侧节点列表选择一个节点，再点「查询当前节点链路」。';
    $('chainTree').innerHTML = '<div class="empty">未选择节点</div>';
    state.chainTrees = [];
    state.currentChain = null;
    clearTreeNote();
    renderRingView();
    return;
  }
  chainQuerying('当前节点链路查询中（含设备 ping 探测）…');
  const r = await api('GET', `/api/nodes/${state.selected}/chain?scope=branch`);
  if (!r.ok) return chainFailed(r.message);
  // v3.1 之前的后端会忽略 scope、仍返回整棵采区树：前端按祖先链兜底裁剪，页面无需重启后端即可正确显示
  state.currentChain = pruneChainTree(r.data);
  state.chainTrees = r.data.tree ? [r.data.tree] : [];
  await renderCurrentChain();
  if (state.chainView === 'ring') renderRingView();
}

/** 用缓存重绘当前节点链路（切换展示规则时不重新 ping）。 */
async function renderCurrentChain() {
  const d = state.currentChain;
  if (!d) return;
  const sum = d.statusSummary || {};
  $('chainSummary').innerHTML = `
    <span class="kv"><b>查询节点</b> #${esc(d.queriedNodeId)}</span>
    <span class="kv"><b>根节点（采区变电所）</b> #${esc(d.rootId)}</span>
    <span class="kv"><b>本链路节点数</b> ${esc(d.totalNodes)}</span>
    <span class="kv"><b>已隐藏旁支</b> ${esc((d.hiddenBranches || []).length)} 条 / ${esc(d.totalHiddenNodes || 0)} 台设备</span>
    <span class="kv"><b>查询节点到根的路径</b> ${esc((d.ancestorPath || []).map(x => '#' + x).join(' → '))}</span>
    <span class="kv"><b>在线/离线/未知</b> ${esc(sum.ONLINE || 0)} / ${esc(sum.OFFLINE || 0)} / ${esc(sum.UNKNOWN || 0)}</span>
    <span class="kv"><b>生成时间</b> ${esc(String(d.generatedAt || '').replace('T', ' '))}</span>`;
  await renderTreeCard();
}

/** 查询完整链路：优先调用后端 GET /api/topology/full，失败时回退到前端聚合。 */
async function showFullChain() {
  setChainMode('full', '正在查询全局链路…');
  chainQuerying('完整链路查询中：正在调用后端全局链路接口（含设备 ping 探测）…');

  // 后端新增的全局接口：一次返回所有独立树
  const full = await api('GET', '/api/topology/full');
  if (full.ok && full.data && Array.isArray(full.data.chains)) {
    state.fullChains = full.data.chains.map(c => ({
      root: state.nodes.find(n => n.id === c.rootId) || {
        id: c.rootId, deviceName: (c.tree && c.tree.deviceName) || ''
      },
      d: c
    }));
    state.fullFailed = [];
    state.fullSource = 'backend';
    await renderFullChain();
    return;
  }

  // 兼容尚未升级的后端：前端自行枚举根节点并逐个调用 /chain
  state.fullSource = 'frontend';
  const list = await api('GET', '/api/nodes?size=200');
  if (!list.ok) return chainFailed(list.message);
  const roots = ((list.data && list.data.records) || [])
    .filter(n => !n.parentId)
    .sort((a, b) => a.id - b.id);
  if (!roots.length) {
    $('chainSummary').innerHTML = '没有找到一级节点（parentId 为空）。';
    $('chainTree').innerHTML = '<div class="empty">无链路数据</div>';
    state.chainTrees = [];
    clearTreeNote();
    if (state.chainView === 'ring') renderRingView();
    return;
  }
  const results = await Promise.all(roots.map(async root => ({
    root,
    r: await api('GET', `/api/nodes/${root.id}/chain`)
  })));
  state.fullChains = results.filter(x => x.r.ok).map(x => ({ root: x.root, d: x.r.data }));
  state.fullFailed = results.filter(x => !x.r.ok);
  await renderFullChain();
}

/** 用缓存重绘完整链路（点选节点时只更新高亮，不重复 ping）。 */
async function renderFullChain() {
  const chains = state.fullChains, failed = state.fullFailed;
  setChainMode('full', `共 ${chains.length} 棵独立树`);
  if (!chains.length) {
    $('chainSummary').innerHTML = '<span style="color:#dc2626">所有链路查询均失败</span>';
    $('chainTree').innerHTML = '<div class="empty">无链路数据</div>';
    state.chainTrees = [];
    clearTreeNote();
    if (state.chainView === 'ring') renderRingView();
    return;
  }
  const total = chains.reduce((s, x) => s + (x.d.totalNodes || 0), 0);
  const acc = { ONLINE: 0, OFFLINE: 0, UNKNOWN: 0 };
  chains.forEach(x => {
    const s = x.d.statusSummary || {};
    Object.keys(acc).forEach(k => acc[k] += (s[k] || 0));
  });
  const rootsText = chains.map(x => '#' + x.root.id + ' ' + (x.root.deviceName || '')).join('、');
  $('chainSummary').innerHTML = `
    <span class="kv"><b>采区树数量</b> ${chains.length}</span>
    <span class="kv"><b>节点总数</b> ${esc(total)}</span>
    <span class="kv"><b>根节点（采区变电所）</b> ${esc(rootsText)}</span>
    <span class="kv"><b>在线/离线/未知</b> ${acc.ONLINE} / ${acc.OFFLINE} / ${acc.UNKNOWN}</span>
    ${failed.length ? `<span class="kv" style="color:#dc2626"><b>查询失败</b> ${failed.length} 棵树</span>` : ''}
    <span class="kv"><b>数据来源</b> ${state.fullSource === 'backend' ? '后端 /api/topology/full' : '前端聚合（旧后端）'}</span>
    <span class="kv"><b>说明</b> 每棵树的根节点均为采区变电所（level=1）；核心环网见「◉ 环形」视图</span>`;
  state.chainTrees = chains.map(x => x.d.tree).filter(Boolean);
  await renderTreeCard();
  if (state.chainView === 'ring') renderRingView();
}

/** 视图切换、手动刷新时按当前模式重新请求。 */
async function refreshChainView() {
  if (state.view !== 'overview') return;
  await loadRingTopology();
  if (state.chainMode === 'full') await showFullChain();
  else if (state.selected) await showCurrentChain();
}

/** 选中节点变化：完整链路模式只重绘高亮；当前节点链路模式重新查询。 */
async function onSelectedInChainView() {
  if (state.view !== 'overview') return;
  if (state.chainMode === 'full') {
    if (state.fullChains.length) await renderFullChain();
    else await showFullChain();
  } else if (state.selected) {
    await showCurrentChain();
  }
}

async function renderDetail() {
  const id = state.selected;
  if (!id) return;
  const r = await api('GET', `/api/nodes/${id}`);
  if (!r.ok) { $('nodeDetail').innerHTML = '<div class="empty">' + esc(r.message) + '</div>'; return; }
  const n = r.data;
  $('detailTitle').textContent = `#${n.id} ${n.deviceName}`;
  const ports = await portsOf(id);
  const children = await api('GET', `/api/nodes/${id}/children`);
  $('nodeDetail').innerHTML = `
    <dl class="detail-grid">
      <dt>设备名称</dt><dd>${dash(n.deviceName)}</dd>
      <dt>类型</dt><dd>${tag(n.deviceType)}</dd>
      <dt>拓扑类型</dt><dd>${n.topologyType === 'RING' ? '<span style="color:#7c3aed">环网（STP）</span>' : '树形（采区）'}</dd>
      <dt>节点级别</dt><dd>${levelTag(n.nodeLevel)} ${n.nodeLevelLabel ? esc(n.nodeLevelLabel) : ''}
        ${n.nodeLevel === 0 ? '<span class="hint">· 核心环网专属，只在「◉ 环形」视图展示，不参与采区链路查询</span>' : ''}</dd>
      <dt>型号</dt><dd>${dash(n.deviceModel)}</dd>
      <dt>地点</dt><dd>${dash(n.location)}</dd>
      <dt>IP</dt><dd class="mono">${dash(n.ipAddress)}</dd>
      <dt>上级</dt><dd>${n.parentIp ? `#${esc(n.parentId)} · ${esc(n.parentIp)}` : '<span style="color:#059669">独立一级节点</span>'}</dd>
      <dt>上级端口</dt><dd>${dash(n.parentPortNo)}</dd>
      <dt>本机接入</dt><dd>${dash(n.inboundPortNo)}</dd>
      <dt>环网链路</dt><dd>${ringLinkCountOf(id)} 条 ${ringLinkCountOf(id) ? '<span class="hint">· 到「环网链路」页维护</span>' : '<span style="color:#64748b">无</span>'}</dd>
      <dt>端口数</dt><dd>${ports.length}</dd>
      <dt>直接子节点</dt><dd>${(children.data || []).length} 个 ${(children.data || []).length ? '· ' + (children.data || []).map(c => '#' + c.id + ' ' + esc(c.deviceName)).join('、') : ''}</dd>
    </dl>`;
}

/* ---------------- 新增节点 ---------------- */
function addPortRow(data = {}) {
  const row = document.createElement('div');
  row.className = 'port-row';
  row.innerHTML = `
    <input class="input input-sm p-no" placeholder="端口号，如 GE0/1" value="${esc(data.portNo || '')}">
    <select class="input input-sm p-type"><option value="ELECTRICAL">电口</option><option value="OPTICAL">光口</option></select>
    <input class="input input-sm p-remark" placeholder="备注（可选）" value="${esc(data.remark || '')}">
    <button class="icon-btn" title="删除该行">×</button>`;
  if (data.portType) row.querySelector('.p-type').value = data.portType;
  row.querySelector('.icon-btn').addEventListener('click', () => { row.remove(); syncPortDatalist(); });
  row.querySelectorAll('input').forEach(i => i.addEventListener('input', syncPortDatalist));
  $('c_portRows').appendChild(row);
  syncPortDatalist();
}

function collectPortRows() {
  return [...$('c_portRows').querySelectorAll('.port-row')].map(r => ({
    portNo: r.querySelector('.p-no').value.trim(),
    portType: r.querySelector('.p-type').value,
    remark: r.querySelector('.p-remark').value.trim()
  })).filter(p => p.portNo);
}

function syncPortDatalist() {
  $('c_portNoList').innerHTML = collectPortRows().map(p => `<option value="${esc(p.portNo)}">`).join('');
}

function onTypeChange() {
  const isSwitch = $('c_type').value === 'SWITCH';
  const isRing = $('c_topo').value === 'RING';
  $('c_portsCard').style.display = isSwitch ? '' : 'none';
  $('c_inbound').disabled = !isSwitch || isRing;
  if (!isSwitch || isRing) $('c_inbound').value = '';
}

/** 插入位置下拉：只列 RING 环上链路（CHORD 不参与闭环，不能用来插节点）。 */
function fillInsertLinkSelect() {
  const keep = $('c_insertLink').value;
  const edges = (state.ringLinks || []).filter(l => l.linkType === 'RING');
  const label = l => `#${l.id} · ${l.ringNo || 'MAIN'} 序 ${l.seqNo ?? '—'} · `
    + `#${l.fromNodeId} ${l.fromNodeName || ''} ↔ #${l.toNodeId} ${l.toNodeName || ''}`;
  $('c_insertLink').innerHTML = optionsHtml(edges, l => l.id, label, '请选择环上链路');
  if (keep && edges.some(l => String(l.id) === String(keep))) $('c_insertLink').value = keep;
}

/** 拓扑类型切换：环网节点走「插入环网」，只有树形节点才用上级连接。 */
function onTopoChange() {
  const isRing = $('c_topo').value === 'RING';
  $('c_parentCard').style.display = isRing ? 'none' : '';
  $('c_ringCard').style.display = isRing ? '' : 'none';
  if (isRing) {
    $('c_parent').value = '';
    $('c_parentPort').innerHTML = '<option value="">无需 / 请先选上级</option>';
    $('c_parentPort').disabled = true;
    $('c_inbound').value = '';
    $('c_inbound').disabled = true;
    fillInsertLinkSelect();
  } else {
    $('c_inbound').disabled = $('c_type').value !== 'SWITCH';
  }
  $('c_hint').textContent = isRing ? '新节点将插入选定的环上链路，不写入采区树' : '';
  onTypeChange();
}

async function createNode() {
  const name = $('c_name').value.trim();
  if (!name) return toast('设备名称必填', 'err');
  const type = $('c_type').value;
  const topo = $('c_topo').value;
  const level = $('c_level').value;
  const payload = {
    deviceName: name, deviceType: type,
    deviceModel: $('c_model').value.trim() || undefined,
    location: $('c_location').value.trim() || undefined,
    ipAddress: $('c_ip').value.trim() || undefined,
    topologyType: topo
  };
  // 节点级别留空 = 后端自动推导（环网插入默认 1 采区一级节点）
  if (level !== '') payload.nodeLevel = Number(level);
  if (type === 'SWITCH') {
    const ports = collectPortRows();
    if (ports.length) payload.ports = ports;
  }
  if (topo === 'RING') return createRingMember(payload, type);

  const parentIp = $('c_parent').value;
  const parentPortNo = $('c_parentPort').value;
  const inboundPortNo = $('c_inbound').value.trim();
  if (parentIp) {
    payload.parentIp = parentIp;
    if (parentPortNo) payload.parentPortNo = parentPortNo;
  }
  if (type === 'SWITCH' && inboundPortNo) payload.inboundPortNo = inboundPortNo;
  compatLinkFields(payload, parentIp, parentPortNo, inboundPortNo, null);
  const r = await api('POST', '/api/nodes', payload);
  showResult('createResult', r);
  if (r.ok) {
    state.ports.clear();
    await loadNodes();
    if (r.data && r.data.id) await selectNode(r.data.id);
  }
}

/** 环网成员新增：把新交换机插入选定环边中间，A↔B 拆成 A↔新↔B，闭环扩大一台。 */
async function createRingMember(payload, type) {
  if (type !== 'SWITCH') return toast('环网节点必须是交换机', 'err');
  const linkId = $('c_insertLink').value;
  if (!linkId) return toast('请选择要拆开的环上链路（插入位置）', 'err');
  const fromPortNo = $('c_ringPortA').value.trim();
  const toPortNo = $('c_ringPortB').value.trim();
  if (fromPortNo && toPortNo && fromPortNo === toPortNo) {
    return toast('连接 A / B 两端请使用两个不同的本机端口', 'err');
  }
  if (fromPortNo) payload.fromPortNo = fromPortNo;
  if (toPortNo) payload.toPortNo = toPortNo;
  const remark = $('c_ringRemark').value.trim();
  if (remark) payload.remark = remark;

  const r = await api('POST', `/api/ring-links/${linkId}/insert-node`, payload);
  showResult('createResult', r);
  if (!r.ok) {
    if (r.http === 404) toast('后端还没有环网插入接口，请在 IDEA 重新 Build / Restart 后端', 'err');
    return;
  }
  state.ports.clear();
  await loadNodes();
  await loadRingLinks();
  await loadRingTopology();
  renderRingView();
  if (r.data && r.data.id) await selectNode(r.data.id);
  toast('新节点已插入环网，闭环已更新', 'ok');
}

function resetCreate() {
  ['c_name', 'c_model', 'c_location', 'c_ip', 'c_inbound'].forEach(id => $(id).value = '');
  $('c_type').value = 'SWITCH';
  $('c_topo').value = 'TREE';
  $('c_level').value = '';
  $('c_parent').value = '';
  $('c_parentPort').innerHTML = '<option value="">无需 / 请先选上级</option>';
  $('c_parentPort').disabled = true;
  ['c_ringPortA', 'c_ringPortB', 'c_ringRemark'].forEach(id => $(id).value = '');
  $('c_insertLink').value = '';
  $('c_portRows').innerHTML = '';
  syncPortDatalist();
  onTopoChange();
  $('c_hint').textContent = '';
}

/* ---------------- 连接管理 ---------------- */
function fillLinkForm() {
  const n = nodeById(state.selected);
  $('l_current').innerHTML = n ? `
    <span class="kv"><b>#${n.id}</b> ${esc(n.deviceName)}</span>${tag(n.deviceType)}${topoTag(n.topologyType)}${levelTag(n.nodeLevel)}
    <span class="kv"><b>IP</b> ${esc(n.ipAddress || '—')}</span>
    <span class="kv"><b>上级</b> ${n.parentIp || '独立节点'}</span>
    <span class="kv"><b>上级端口</b> ${esc(n.parentPortNo || '—')}</span>
    <span class="kv"><b>环网链路</b> ${ringLinkCountOf(n.id)} 条</span>` : '请选择一个节点';
  if (!n) return;
  $('u_name').value = n.deviceName || '';
  // 设备类型 / IP 仅作只读回显，不参与修改提交
  $('u_type').value = n.deviceType || 'SWITCH';
  $('u_model').value = n.deviceModel || '';
  $('u_location').value = n.location || '';
  $('u_ip').value = n.ipAddress || '';
  $('l_inbound').value = n.inboundPortNo || '';
  $('l_node').value = String(n.id);
  portsOf(n.id).then(list => {
    let dl = document.getElementById('l_inboundList');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'l_inboundList'; document.body.appendChild(dl); }
    dl.innerHTML = list.map(p => `<option value="${esc(p.portNo)}">`).join('');
    $('l_inbound').setAttribute('list', 'l_inboundList');
  });
}

async function updateNode() {
  const id = state.selected;
  if (!id) return toast('请先选择节点', 'err');
  const deviceName = $('u_name').value.trim();
  if (!deviceName) return toast('设备名称不能为空', 'err');
  // 后端 NodeUpdateRequest 只接受这三个字段；设备类型 / IP 不可修改，不发送
  const payload = {
    deviceName,
    deviceModel: $('u_model').value.trim(),
    location: $('u_location').value.trim()
  };
  const r = await api('PUT', `/api/nodes/${id}`, payload);
  showResult('linkResult', r);
  if (r.ok) { state.ports.clear(); await loadNodes(); await selectNode(id); }
}

async function afterTopologyChange(id) {
  state.ports.clear();
  await loadNodes();          // 会作废完整链路缓存
  await selectNode(id);       // 按当前查询模式重新渲染（结构已变，重新请求）
}

async function detachNode() {
  const id = state.selected;
  if (!id) return toast('请先选择节点', 'err');
  const r = await api('POST', `/api/nodes/${id}/detach`);
  showResult('linkResult', r);
  if (r.ok) await afterTopologyChange(id);
}

async function attachNode() {
  const id = state.selected;
  if (!id) return toast('请先选择节点', 'err');
  const parentIp = $('l_parent').value;
  if (!parentIp) return toast('请选择上级设备 IP', 'err');
  const parentPortNo = $('l_parentPort').value;
  const inboundPortNo = $('l_inbound').value.trim();
  const payload = { parentIp };
  if (parentPortNo) payload.parentPortNo = parentPortNo;
  if (inboundPortNo) payload.inboundPortNo = inboundPortNo;
  compatLinkFields(payload, parentIp, parentPortNo, inboundPortNo, id);
  const r = await api('POST', `/api/nodes/${id}/attach`, payload);
  showResult('linkResult', r);
  if (r.ok) await afterTopologyChange(id);
}

async function deleteNode() {
  const id = state.selected;
  if (!id) return toast('请先选择节点', 'err');
  const n = nodeById(id);
  if (!confirm(`确认删除节点 #${id} ${n ? n.deviceName : ''}？\n若存在子节点，后端会拒绝删除。`)) return;
  const r = await api('DELETE', `/api/nodes/${id}`);
  showResult('linkResult', r);
  if (r.ok) {
    state.selected = null; state.ports.clear();
    await loadNodes();
    await loadRingLinks();          // 设备删除会级联删除其 ring_link 链路
    await loadRingTopology();
    if (state.nodes[0]) await selectNode(state.nodes[0].id);
  }
}

/* ---------------- 环网链路管理（ring_link） ---------------- */
/** 某台设备参与的环网链路条数（节点详情 / 连接管理用）。 */
function ringLinkCountOf(nodeId) {
  return state.ringLinks.filter(l => l.fromNodeId === nodeId || l.toNodeId === nodeId).length;
}

function ringColor(no) {
  return no === 'GREEN' ? '#059669' : no === 'RED' ? '#dc2626' : no === 'CORE' ? '#7c3aed' : '#64748b';
}

async function loadRingLinks() {
  const r = await api('GET', '/api/ring-links');
  state.ringLinks = r.ok ? (r.data || []) : [];
  renderRingLinks();
  fillInsertLinkSelect();          // 新增节点页「插入位置」下拉同步
  renderRingAdjustOptions();       // 环网调整面板的设备 / 链路下拉同步
  if (!r.ok) toast('环网链路接口不可用：' + r.message, 'err');
}

function renderRingLinks() {
  const tb = $('rl_table').querySelector('tbody');
  $('ringLinkCount').textContent = state.ringLinks.length;
  if (!state.ringLinks.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">暂无环网链路，可在下方新增；或用后端 db/init-ring-20261105.sql 导入初始环网</td></tr>';
    return;
  }
  tb.innerHTML = state.ringLinks.map(l => `
    <tr>
      <td class="mono">#${esc(l.id)}</td>
      <td><b style="color:${ringColor(l.ringNo)}">${esc(l.ringNo)}</b></td>
      <td>${esc(l.seqNo ?? '—')}</td>
      <td>#${esc(l.fromNodeId)} ${esc(l.fromNodeName || '')}<br><span class="hint mono">${esc(l.fromPortNo || '未指定端口')}</span></td>
      <td>#${esc(l.toNodeId)} ${esc(l.toNodeName || '')}<br><span class="hint mono">${esc(l.toPortNo || '未指定端口')}</span></td>
      <td>${l.linkType === 'CHORD'
        ? '<span style="color:#7c3aed">CHORD · 直连弦</span>'
        : '<span style="color:#1d4ed8">RING · 环上</span>'}</td>
      <td>${esc(l.remark || '—')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" data-act="edit" data-id="${esc(l.id)}">编辑</button>
        <button class="btn btn-danger btn-sm" data-act="del" data-id="${esc(l.id)}">删除</button>
      </td>
    </tr>`).join('');
  tb.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'edit') editRingLink(id); else deleteRingLink(id);
  }));
}

/** 选中某端设备后，按该设备的端口清单刷新对应端口下拉。 */
async function onRingNodeChange(side) {
  const nodeSel = $(side === 'from' ? 'rl_from' : 'rl_to');
  const portSel = $(side === 'from' ? 'rl_fromPort' : 'rl_toPort');
  const id = Number(nodeSel.value);
  if (!id) { portSel.innerHTML = '<option value="">（不指定端口）</option>'; return; }
  const ports = await portsOf(id);
  portSel.innerHTML = '<option value="">（不指定端口）</option>' +
    ports.map(p => `<option value="${esc(p.id)}">${esc(p.portNo)} · ${p.portType === 'OPTICAL' ? '光口' : '电口'}</option>`).join('');
}

function resetRingLinkForm() {
  state.ringLinkEditId = null;
  $('rl_formTitle').textContent = '新增环网链路';
  $('rl_ringNo').value = 'GREEN';
  $('rl_seqNo').value = '';
  $('rl_linkType').value = 'RING';
  $('rl_remark').value = '';
  $('rl_from').value = '';
  $('rl_to').value = '';
  $('rl_fromPort').innerHTML = '<option value="">（不指定端口）</option>';
  $('rl_toPort').innerHTML = '<option value="">（不指定端口）</option>';
  $('btnRingLinkCancel').style.display = 'none';
}

async function editRingLink(id) {
  const l = state.ringLinks.find(x => String(x.id) === String(id));
  if (!l) return toast('链路不存在', 'err');
  state.ringLinkEditId = l.id;
  $('rl_formTitle').textContent = `编辑环网链路 #${l.id}`;
  $('rl_ringNo').value = l.ringNo || 'MAIN';
  $('rl_seqNo').value = l.seqNo ?? '';
  $('rl_linkType').value = l.linkType || 'RING';
  $('rl_remark').value = l.remark || '';
  $('rl_from').value = String(l.fromNodeId);
  $('rl_to').value = String(l.toNodeId);
  await Promise.all([onRingNodeChange('from'), onRingNodeChange('to')]);
  $('rl_fromPort').value = l.fromPortId == null ? '' : String(l.fromPortId);
  $('rl_toPort').value = l.toPortId == null ? '' : String(l.toPortId);
  $('btnRingLinkCancel').style.display = '';
}

async function saveRingLink() {
  const fromNodeId = Number($('rl_from').value), toNodeId = Number($('rl_to').value);
  if (!fromNodeId || !toNodeId) return toast('请选择 A/B 两端设备', 'err');
  if (fromNodeId === toNodeId) return toast('两端不能是同一台设备', 'err');
  const seq = $('rl_seqNo').value.trim();
  const payload = {
    fromNodeId, toNodeId,
    ringNo: $('rl_ringNo').value,
    seqNo: seq === '' ? null : Number(seq),
    fromPortId: $('rl_fromPort').value ? Number($('rl_fromPort').value) : null,
    toPortId: $('rl_toPort').value ? Number($('rl_toPort').value) : null,
    linkType: $('rl_linkType').value,
    remark: $('rl_remark').value.trim() || null
  };
  const id = state.ringLinkEditId;
  const r = id
    ? await api('PUT', `/api/ring-links/${id}`, payload)
    : await api('POST', '/api/ring-links', payload);
  showResult('ringLinkResult', r);
  if (!r.ok) return;
  resetRingLinkForm();
  await loadRingLinks();
  await loadRingTopology();
  toast(id ? '环网链路已更新' : '环网链路已新增', 'ok');
}

async function deleteRingLink(id) {
  if (!confirm(`确认删除环网链路 #${id}？删除后 /api/topology/ring 会按剩余链路重算闭环。`)) return;
  const r = await api('DELETE', `/api/ring-links/${id}`);
  showResult('ringLinkResult', r);
  if (!r.ok) return;
  if (state.ringLinkEditId === id) resetRingLinkForm();
  await loadRingLinks();
  await loadRingTopology();
  toast('环网链路已删除', 'ok');
}

/* ---------------- 环网调整：摘除节点 / 改接链路 ----------------
 * 两个操作都在后端单事务完成；前端只负责选设备、预览影响、执行后刷新数据与环形图。
 */
function ringDeviceList() {
  const m = new Map();
  (state.ringTopology?.nodes || []).forEach(n => m.set(n.id, n));
  (state.ringLinks || []).forEach(l => {
    [[l.fromNodeId, l.fromNodeName], [l.toNodeId, l.toNodeName]].forEach(([id, name]) => {
      if (id == null || m.has(id)) return;
      m.set(id, nodeById(id) || { id, deviceName: name || ('#' + id), ipAddress: '' });
    });
  });
  return [...m.values()].sort((a, b) => a.id - b.id);
}
const raLabel = n => `#${n.id} ${n.deviceName || ''} · ${n.ipAddress || '无 IP'}`;
const portOpts = (ports, placeholder) => `<option value="">${esc(placeholder)}</option>` +
  ports.map(p => `<option value="${esc(p.id)}">${esc(p.portNo)} · ${p.portType === 'OPTICAL' ? '光口' : '电口'}</option>`).join('');
const raLink = () => (state.ringLinks || []).find(l => String(l.id) === String($('ra_rw_link').value));

function renderRingAdjustOptions() {
  if (!$('ra_op')) return;
  const setOpts = (id, list, valueFn, labelFn, placeholder) => {
    const old = $(id).value;
    $(id).innerHTML = optionsHtml(list, valueFn, labelFn, placeholder);
    if (old) $(id).value = old;
  };
  setOpts('ra_bp_node', ringDeviceList(), n => n.id, raLabel, '请选择环网节点');
  setOpts('ra_rw_new', state.nodes.filter(n => n.deviceType === 'SWITCH'), n => n.id, raLabel, '请选择交换机');
  setOpts('ra_rw_link', (state.ringLinks || []).slice().sort((a, b) => a.id - b.id), l => l.id,
    l => `#${l.id} ${l.fromNodeName || '#' + l.fromNodeId} (${l.fromPortNo || '—'}) ↔ `
      + `${l.toNodeName || '#' + l.toNodeId} (${l.toPortNo || '—'})`, '请选择链路');
  syncRewireEnds();
  previewBypass();
  previewRewire();
}

function switchRingAdjustOp() {
  const op = $('ra_op').value;
  ['bypass', 'rewire'].forEach(k => {
    const el = $('ra_' + k), show = op === k;
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  });
}

function syncRewireEnds() {
  const l = raLink(), sel = $('ra_rw_old');
  if (!l) {
    sel.innerHTML = '<option value="">请先选择链路</option>';
    $('ra_rw_keepPort').innerHTML = portOpts([], '（继承原端口）');
    return;
  }
  const prev = sel.value;
  const ends = [
    { id: l.fromNodeId, name: l.fromNodeName, portNo: l.fromPortNo },
    { id: l.toNodeId, name: l.toNodeName, portNo: l.toPortNo }
  ];
  sel.innerHTML = ends.map(e => `<option value="${esc(e.id)}">#${esc(e.id)} ${esc(e.name || '')} · ${esc(e.portNo || '未指定端口')}</option>`).join('');
  if (prev && ends.some(e => String(e.id) === prev)) sel.value = prev;
  syncKeepPort();
}

/** 先用链路自带端口同步填充下拉（接口慢/不可用时仍可用，且默认继承原值），再异步补全全部端口。 */
function syncKeepPort() {
  const l = raLink(), sel = $('ra_rw_keepPort');
  const oldId = Number($('ra_rw_old').value);
  const fromSide = l && String(l.fromNodeId) === String(oldId);
  const keepId = l ? (fromSide ? l.toNodeId : l.fromNodeId) : null;
  const inherited = l ? (fromSide ? l.toPortId : l.fromPortId) : null;
  const inheritedNo = l ? (fromSide ? l.toPortNo : l.fromPortNo) : null;
  sel.innerHTML = portOpts([], '（继承原端口）')
    + (inherited != null ? `<option value="${esc(inherited)}">${esc(inheritedNo || ('端口#' + inherited))} · 原端口</option>` : '');
  if (inherited != null) sel.value = String(inherited);
  if (!keepId) return;
  portsOf(keepId).then(ports => {
    // 用户已切换链路或端点时丢弃过期结果；接口无数据时保留上面的同步项
    if (!ports.length || raLink() !== l || Number($('ra_rw_old').value) !== oldId) return;
    const keep = sel.value;
    sel.innerHTML = portOpts(ports, '（继承原端口）');
    sel.value = keep;
  }).catch(() => {});
}

async function onRewireNewChange() {
  const id = Number($('ra_rw_new').value), sel = $('ra_rw_newPort');
  sel.innerHTML = portOpts(id ? await portsOf(id) : [], '（不指定端口）');
  previewRewire();
}

function previewBypass() {
  const box = $('ra_bp_preview');
  if (!box) return;
  const id = Number($('ra_bp_node').value);
  if (!id) { box.innerHTML = '选择节点后显示将要删除与新建的链路'; return; }
  const rel = (state.ringLinks || []).filter(l =>
    String(l.fromNodeId) === String(id) || String(l.toNodeId) === String(id));
  const ring = rel.filter(l => (l.linkType || 'RING') !== 'CHORD');
  const chords = rel.filter(l => l.linkType === 'CHORD');
  if (ring.length !== 2) {
    box.innerHTML = `<b style="color:#dc2626">当前匹配 ${ring.length} 条环上链路</b>，摘除要求恰好 2 条`
      + `（另有 ${chords.length} 条直连弦会一并删除）。枢纽节点请先在上方链路清单中调整，或改用「改接链路」。`;
    return;
  }
  const a = String(ring[0].fromNodeId) === String(id) ? ring[0].toNodeId : ring[0].fromNodeId;
  const b = String(ring[1].fromNodeId) === String(id) ? ring[1].toNodeId : ring[1].fromNodeId;
  box.innerHTML = `将删除 <b>${rel.length}</b> 条链路（环上 ${ring.map(l => '#' + l.id).join('、')}`
    + (chords.length ? `，直连弦 ${chords.map(l => '#' + l.id).join('、')}` : '')
    + `），并新建 <b>#${esc(a)} ↔ #${esc(b)}</b> 保持闭环，两侧端口继承原链路。`;
}

function previewRewire() {
  const box = $('ra_rw_preview');
  if (!box) return;
  const l = raLink();
  if (!l) { box.innerHTML = '选择链路后显示改接前后对比'; return; }
  const oldId = Number($('ra_rw_old').value), newId = Number($('ra_rw_new').value);
  const keepId = String(l.fromNodeId) === String(oldId) ? l.toNodeId : l.fromNodeId;
  box.innerHTML = `原链路 <b>#${esc(l.id)}</b>：#${esc(l.fromNodeId)} ↔ #${esc(l.toNodeId)}；`
    + `改接后 <b>#${esc(keepId)} ↔ ${newId ? '#' + esc(newId) : '（请选择新设备）'}</b>`
    + `（#${esc(oldId)} 端被替换）。环编号 / 顺序 / 类型沿用原链路，连接端口见两侧下拉。`;
}

async function refreshAfterRingAdjust() {
  state.ports.clear();
  await loadNodes();
  await loadRingLinks();
  await loadRingTopology();
  renderRingAdjustOptions();
}

async function execBypass() {
  const id = Number($('ra_bp_node').value);
  if (!id) return toast('请选择要摘除的环网节点', 'err');
  if (!confirm(`确认摘除环网节点 #${id}？\n该设备全部环网链路会被删除，两个邻居自动直连以保持闭环。\n设备本身保留在库中，只是脱离环网。`)) return;
  const remark = $('ra_bp_remark').value.trim();
  const r = await api('POST', `/api/ring-links/nodes/${id}/bypass`, remark ? { remark } : {});
  showResult('ra_result', r);
  if (!r.ok) return;
  await refreshAfterRingAdjust();
  toast((r.data && r.data.message) || '节点已摘除', 'ok');
}

async function execRewire() {
  const linkId = Number($('ra_rw_link').value);
  const oldNodeId = Number($('ra_rw_old').value);
  const newNodeId = Number($('ra_rw_new').value);
  if (!linkId || !oldNodeId || !newNodeId) return toast('请选择链路、被替换端与新设备', 'err');
  if (!confirm(`确认把链路 #${linkId} 的 #${oldNodeId} 端改接到 #${newNodeId}？\n旧链路删除与新链路创建在同一事务内，失败自动回滚。`)) return;
  const payload = {
    oldNodeId, newNodeId,
    newPortId: $('ra_rw_newPort').value ? Number($('ra_rw_newPort').value) : null,
    keepPortId: $('ra_rw_keepPort').value ? Number($('ra_rw_keepPort').value) : null,
    remark: $('ra_rw_remark').value.trim() || null
  };
  const r = await api('POST', `/api/ring-links/${linkId}/rewire`, payload);
  showResult('ra_result', r);
  if (!r.ok) return;
  await refreshAfterRingAdjust();
  toast((r.data && r.data.message) || '链路已改接', 'ok');
}

/* ---------------- 端口管理 ---------------- */
/**
 * 后端 PortUpdateRequest 只接受 remark，端口修改 = 只允许改备注。
 * 状态是预留字段，任何模式都不可写；编辑时端口号 / 类型也锁定为只读。
 */
function lockPortFields(editing) {
  $('p_portNo').disabled = editing;
  $('p_portType').disabled = editing;
  $('p_status').disabled = true;
}

async function refreshPortView() {
  const id = Number($('p_switch').value);
  if (!id) return;
  state.ports.delete(id);
  const list = await portsOf(id);
  $('p_table').querySelector('tbody').innerHTML = list.length ? list.map(p => `
    <tr><td class="mono">#${p.id}</td><td class="mono"><b>${esc(p.portNo)}</b></td>
      <td><span class="tag t-${esc(p.portType)}">${p.portType === 'OPTICAL' ? '光口' : '电口'}</span></td>
      <td>${esc(p.status || 'UNKNOWN')}</td><td>${dash(p.remark)}</td>
      <td><div class="ops">
        <button class="link-btn" data-act="edit" data-id="${p.id}">改备注</button>
        <button class="link-btn" data-act="status" data-id="${p.id}">状态</button>
        <button class="link-btn del" data-act="del" data-id="${p.id}">删除</button>
      </div></td></tr>`).join('') : '<tr><td colspan="6" class="empty">该交换机暂无端口</td></tr>';

  $('p_table').querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async () => {
    const pid = Number(btn.dataset.id), p = list.find(x => x.id === pid);
    if (btn.dataset.act === 'edit') {
      state.editPortId = pid;
      // 只读回显，仅 remark 可编辑
      $('p_portNo').value = p.portNo; $('p_portType').value = p.portType;
      $('p_status').value = p.status || ''; $('p_remark').value = p.remark || '';
      lockPortFields(true);
      $('p_editInfo').innerHTML = `端口 #${pid}（${esc(p.portNo)} · ${p.portType === 'OPTICAL' ? '光口' : '电口'}）：<b>只允许修改备注</b>，端口号 / 类型 / 状态只读，提交时仅发送 remark。`;
      $('p_editInfo').style.display = '';
      $('p_formTitle').textContent = `修改备注 · 端口 #${pid}`;
      $('btnPortSave').textContent = '保存备注';
      $('btnPortCancel').style.display = '';
      $('p_remark').focus();
    } else if (btn.dataset.act === 'status') {
      showResult('portResult', await api('GET', `/api/ports/${pid}/status`));
    } else {
      if (!confirm(`删除端口 ${p.portNo}？若被链路引用后端会拒绝。`)) return;
      const r = await api('DELETE', `/api/ports/${pid}`);
      showResult('portResult', r);
      if (r.ok) await refreshPortView();
    }
  }));
}

function resetPortForm() {
  state.editPortId = null;
  ['p_portNo', 'p_status', 'p_remark'].forEach(id => $(id).value = '');
  $('p_portType').value = 'ELECTRICAL';
  lockPortFields(false);
  $('p_editInfo').style.display = 'none';
  $('p_editInfo').textContent = '';
  $('p_formTitle').textContent = '新增端口';
  $('btnPortSave').textContent = '新增端口';
  $('btnPortCancel').style.display = 'none';
}

async function savePort() {
  const switchId = Number($('p_switch').value);
  if (!switchId) return toast('请先选择交换机', 'err');
  let r;
  if (state.editPortId) {
    // 只提交备注；空字符串用于清空备注（不用 undefined，否则后端会跳过不更新）
    r = await api('PUT', `/api/ports/${state.editPortId}`, { remark: $('p_remark').value.trim() });
  } else {
    const portNo = $('p_portNo').value.trim();
    if (!portNo) return toast('端口号必填', 'err');
    r = await api('POST', `/api/nodes/${switchId}/ports`, {
      portNo, portType: $('p_portType').value, remark: $('p_remark').value.trim() || undefined
    });
  }
  showResult('portResult', r);
  if (r.ok) { resetPortForm(); state.ports.clear(); await refreshPortView(); }
}

/* ---------------- 接口调试 ---------------- */
const QUICK = [
  ['GET', '/api/nodes?size=20', ''],
  ['GET', '/api/nodes/1', ''],
  ['GET', '/api/nodes/1/chain', ''],
  ['GET', '/api/nodes/1/children', ''],
  ['GET', '/api/nodes/1/ports', ''],
  ['GET', '/api/nodes/1/status', ''],
  ['GET', '/api/topology/full', ''],
  ['GET', '/api/topology/ring', ''],
  ['GET', '/api/ring-links', ''],
  ['GET', '/api/ring-links?ringNo=GREEN', ''],
  ['GET', '/api/ports/1/status', ''],
  ['POST', '/api/status/refresh', ''],
  ['POST', '/api/nodes', '{"deviceName":"调试-广播","deviceType":"BROADCAST","ipAddress":"10.9.9.9"}'],
  ['POST', '/api/ring-links/1/insert-node', '{"deviceName":"调试-环网节点","deviceType":"SWITCH","ports":[{"portNo":"XGE0/1","portType":"OPTICAL"},{"portNo":"XGE0/2","portType":"OPTICAL"}]}'],
  ['POST', '/api/nodes/1/detach', ''],
  ['POST', '/api/nodes/1/attach', '{"parentIp":"10.0.0.1"}'],
  ['POST', '/api/nodes/1/ports', '{"portNo":"GE0/9","portType":"ELECTRICAL"}'],
  ['PUT', '/api/ports/1', '{"remark":"控制台修改"}'],
  ['DELETE', '/api/ports/999', ''],
  ['GET', '/v3/api-docs', '']
];

function initQuickApis() {
  $('quickApis').innerHTML = QUICK.map(([m, p, b], i) =>
    `<span class="chip ${m.toLowerCase()}" data-i="${i}"><span class="m">${m}</span>${esc(p)}</span>`).join('');
  $('quickApis').querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
    const [m, p, b] = QUICK[Number(el.dataset.i)];
    $('d_method').value = m; $('d_path').value = p; $('d_body').value = b;
  }));
}

async function sendDebug() {
  const m = $('d_method').value, p = $('d_path').value.trim();
  if (!p.startsWith('/')) return toast('路径需以 / 开头', 'err');
  const raw = $('d_body').value.trim();
  let body;
  if (raw) {
    try { body = JSON.parse(raw); } catch (e) { return toast('请求体不是合法 JSON：' + e.message, 'err'); }
  }
  const r = await api(m, p, body);
  $('d_meta').textContent = `HTTP ${r.http} · ${r.ms} ms · ${r.ok ? '业务成功' : '失败：' + r.message}`;
  let pretty;
  try { pretty = fmt(JSON.parse(r.raw)); } catch { pretty = r.raw || '(空响应)'; }
  $('d_result').textContent = pretty;
}

function renderHistory() {
  $('d_history').innerHTML = state.history.length ? state.history.map((h, i) =>
    `<span class="chip" data-i="${i}" title="${esc(h.path)} · ${h.ms} ms">${h.method} ${esc(h.path.split('?')[0])}</span>`).join('') : '<span class="muted">暂无记录</span>';
  $('d_history').querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
    const h = state.history[Number(el.dataset.i)];
    $('d_method').value = h.method; $('d_path').value = h.path; $('d_body').value = '';
  }));
}

/* ---------------- 视图切换 / 事件 ---------------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-i').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === view));
  if (view === 'ports') refreshPortView();
  if (view === 'overview') refreshChainView();
  if (view === 'link') fillLinkForm();
  if (view === 'ringlinks') loadRingLinks();
  if (view === 'create') { fillSelects(); fillInsertLinkSelect(); onTopoChange(); }
}

function bindEvents() {
  $('nav').addEventListener('click', e => {
    const b = e.target.closest('.nav-i');
    if (b) switchView(b.dataset.view);
  });
  ['listSearch', 'listType'].forEach(id => $(id).addEventListener('input', renderNodeList));
  $('btnRefreshAll').addEventListener('click', async () => { await checkHealth(); state.ports.clear(); await loadNodes(); await loadRingLinks(); await loadRingTopology(); if (state.selected) await renderDetail(); await refreshChainView(); toast('数据已刷新', 'ok'); });
  $('btnChain').addEventListener('click', showCurrentChain);
  $('btnFullChain').addEventListener('click', showFullChain);
  $('btnViewRing').addEventListener('click', () => setChainView('ring'));
  $('btnViewTree').addEventListener('click', () => setChainView('tree'));
  $('chkRingPorts').addEventListener('change', e => {
    state.showRingPorts = e.target.checked;
    renderRingView();
  });
  $('btnPing').addEventListener('click', async () => {
    if (!state.selected) return toast('请先选择节点', 'err');
    $('nodeStatus').innerHTML = '<div class="empty">ICMP 探测中…</div>';
    const r = await api('GET', `/api/nodes/${state.selected}/status`);
    const d = r.data || {};
    $('nodeStatus').innerHTML = r.ok ? `<div class="summary">${statusTag(d.status)} &nbsp; <b>${esc(d.ipAddress || '')}</b><br>
      <span class="kv"><b>说明</b> ${esc(d.message || '—')}</span>
      <span class="kv"><b>缓存命中</b> ${d.cached ? '是' : '否'}</span>
      <span class="kv"><b>检测时间</b> ${esc(String(d.checkedAt || '').replace('T', ' '))}</span></div>`
      : `<div class="summary" style="color:#dc2626">${esc(r.message)}</div>`;
  });
  $('btnRefreshStatus').addEventListener('click', async () => {
    const r = await api('POST', '/api/status/refresh');
    toast(r.ok ? '状态缓存已清空，下次查询将重新探测' : r.message, r.ok ? 'ok' : 'err');
    await refreshChainView();
  });

  // 新增节点
  $('c_type').addEventListener('change', onTypeChange);
  $('c_topo').addEventListener('change', onTopoChange);
  $('c_parent').addEventListener('change', () => onParentChange($('c_parent').value, $('c_parentPort'), $('c_inbound')));
  $('btnAddPortRow').addEventListener('click', () => addPortRow());
  $('btnCreate').addEventListener('click', createNode);
  $('btnCreateReset').addEventListener('click', resetCreate);

  // 连接管理
  $('l_node').addEventListener('change', () => selectNode(Number($('l_node').value)));
  $('l_parent').addEventListener('change', () => onParentChange($('l_parent').value, $('l_parentPort'), $('l_inbound')));
  $('btnUpdate').addEventListener('click', updateNode);
  $('btnDetach').addEventListener('click', detachNode);
  $('btnAttach').addEventListener('click', attachNode);
  $('btnDelete').addEventListener('click', deleteNode);

  // 环网链路
  $('btnReloadRingLinks').addEventListener('click', loadRingLinks);
  $('rl_from').addEventListener('change', () => onRingNodeChange('from'));
  $('rl_to').addEventListener('change', () => onRingNodeChange('to'));
  $('btnRingLinkSave').addEventListener('click', saveRingLink);
  $('btnRingLinkCancel').addEventListener('click', resetRingLinkForm);

  // 环网调整（摘除节点 / 改接链路）
  switchRingAdjustOp();
  $('ra_op').addEventListener('change', switchRingAdjustOp);
  $('ra_bp_node').addEventListener('change', previewBypass);
  $('ra_bp_exec').addEventListener('click', execBypass);
  $('ra_rw_link').addEventListener('change', () => { syncRewireEnds(); previewRewire(); });
  $('ra_rw_old').addEventListener('change', () => { syncKeepPort(); previewRewire(); });
  $('ra_rw_new').addEventListener('change', onRewireNewChange);
  $('ra_rw_exec').addEventListener('click', execRewire);

  // 端口管理
  $('p_switch').addEventListener('change', () => { resetPortForm(); refreshPortView(); });
  $('btnPortSave').addEventListener('click', savePort);
  $('btnPortCancel').addEventListener('click', resetPortForm);

  // 接口调试
  $('btnSend').addEventListener('click', sendDebug);
  $('d_path').addEventListener('keydown', e => { if (e.key === 'Enter') sendDebug(); });
}

async function boot() {
  bindEvents();
  setChainView('ring');   // 默认进入环形拓扑视图
  initQuickApis();
  renderHistory();
  resetCreate();
  resetRingLinkForm();
  await checkHealth();
  await loadNodes();
  await loadRingLinks();                                         // ring_link 链路清单
  await loadRingTopology();                                      // 核心环网独立接口
  if (state.nodes.length) await selectNode(state.nodes[0].id);   // 会自动按模式查询链路
  else await refreshChainView();
}

boot();
