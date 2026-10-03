'use strict';

/**
 * 命名演练副本具名检查点 HTTP 集成测试。
 * 覆盖：原站场/运行中副本拒绝、暂停副本创建（重名/空白拒绝）、列表与详情、
 * 未知检查点 404、整体回退（盘面/等待顺位/序号水位/交接单合并/剩余时间冻结）、
 * 副本保持暂停、检查点可复用、其他站场与会话选择不受影响、
 * 已到期事项恢复后立即复核不重复、跨重启持久化。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3929;
const DB_PATH = process.env.SMOKE_DB_CHECKPOINT || path.join(__dirname, '..', 'data', 'checkpoint-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let server = null;

function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  console.log('  ✓', name);
  passed++;
}
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
      fs.rmSync(path.join(path.dirname(DB_PATH),
        path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards'),
        { recursive: true, force: true });
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}
async function api(url, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}
async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const r = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (r.status !== 200) throw new Error('登录失败: ' + r.data.error);
  return r.data.token;
}
function stepsFor(sections, waitSeconds = 1) {
  const steps = [];
  sections.forEach((sectionId) => {
    steps.push({ sectionId, action: 'occupy', waitSeconds });
    steps.push({ sectionId, action: 'clear', waitSeconds });
  });
  return steps;
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const a = await login('dispatcher', '检查点甲');
  const b = await login('dispatcher', '检查点乙');
  const c = await login('dispatcher', '检查点丙');

  console.log('\n[1] 原站场：创建/回退拒绝，列表为空');
  let r = await api('/api/admin/checkpoints', { token: admin, method: 'POST', body: { name: '基线' } });
  eq('原站场创建 400', r.status, 400);
  eq('原站场创建错误码', r.data.code, 'CHECKPOINT_ORIGINAL_FORBIDDEN');
  r = await api('/api/admin/checkpoints/1/restore', { token: admin, method: 'POST' });
  eq('原站场回退 400', r.status, 400);
  eq('原站场回退错误码', r.data.code, 'CHECKPOINT_ORIGINAL_FORBIDDEN');
  r = await api('/api/admin/checkpoints', { token: admin });
  eq('原站场列表 200', r.status, 200);
  eq('原站场列表为空', r.data.checkpoints.length, 0);

  console.log('\n[2] 运行中副本：创建/回退拒绝；未知检查点 404；越权拒绝');
  r = await api('/api/admin/yards', { token: admin, method: 'POST', body: { name: '检查点演练' } });
  eq('创建副本', r.status, 201);
  const yardId = r.data.yard.id;
  for (const token of [admin, a, b, c]) {
    r = await api('/api/auth/yard', { token, method: 'PUT', body: { yardId } });
    eq('会话切换到副本', r.status, 200);
  }
  r = await api('/api/admin/checkpoints', { token: admin, method: 'POST', body: { name: '运行中基线' } });
  eq('运行中副本创建 409', r.status, 409);
  eq('运行中副本创建错误码', r.data.code, 'CHECKPOINT_YARD_NOT_PAUSED');
  r = await api('/api/admin/checkpoints/1/restore', { token: admin, method: 'POST' });
  eq('运行中副本回退 409', r.status, 409);
  eq('运行中副本回退错误码', r.data.code, 'CHECKPOINT_YARD_NOT_PAUSED');
  r = await api('/api/admin/checkpoints/999', { token: admin });
  eq('未知检查点查看 404', r.status, 404);
  eq('未知检查点错误码', r.data.code, 'CHECKPOINT_NOT_FOUND');
  r = await api('/api/admin/checkpoints', { token: a, method: 'POST', body: { name: '越权' } });
  eq('值班员创建 403', r.status, 403);
  r = await api('/api/admin/checkpoints', { method: 'POST', body: { name: '未登录' } });
  eq('未登录创建 401', r.status, 401);

  console.log('\n[3] 构造副本盘面：开放进路/走行/等待/延时取消/计划/封锁/交接单');
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 3600 }
  });
  for (const id of ['9', '10']) {
    r = await api('/api/admin/sections', {
      token: admin, method: 'POST',
      body: { id, label: `独立线${id}`, x1: 40, y1: 360 + Number(id), x2: 240, y2: 360 + Number(id) }
    });
    eq(`新增独立区段 ${id}`, r.status, 200);
    await api(`/api/sections/${id}/state`, { token: a, method: 'POST', body: { action: 'clear' } });
  }
  r = await api('/api/admin/routes', {
    token: admin, method: 'POST',
    body: { id: 'R4', label: '独立进路9', origin: 'X9', destination: 'X99', steps: ['9'], switchReqs: [] }
  });
  eq('新增进路 R4', r.status, 200);
  r = await api('/api/admin/routes', {
    token: admin, method: 'POST',
    body: { id: 'R5', label: '独立进路10', origin: 'X10', destination: 'X100', steps: ['10'], switchReqs: [] }
  });
  eq('新增进路 R5', r.status, 200);

  const openR1 = await api('/api/routes/R1/open', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('开放 R1', openR1.status, 200);
  const i1 = openR1.data.instance.id;
  r = await api(`/api/instances/${i1}/events`, {
    token: a, method: 'POST', body: { seq: 1, sectionId: '1', action: 'occupy' }
  });
  eq('R1 首段占用', r.status, 200);

  const openR4 = await api('/api/routes/R4/open', { token: b, method: 'POST', body: {} });
  eq('开放 R4', openR4.status, 200);
  const i2 = openR4.data.instance.id;
  const cancel = await api(`/api/instances/${i2}/cancel-delayed`, { token: b, method: 'POST' });
  eq('延时取消提交', cancel.status, 201);
  const cancelId = cancel.data.cancellation.id;
  const releaseAt = cancel.data.cancellation.releaseAt;

  const openR5 = await api('/api/routes/R5/open', { token: a, method: 'POST', body: {} });
  eq('开放 R5', openR5.status, 200);
  const i3 = openR5.data.instance.id;
  const plan = await api(`/api/instances/${i3}/movement-plans`, {
    token: a, method: 'POST', body: { steps: stepsFor(['10'], 3600) }
  });
  eq('提交走行计划', plan.status, 201);
  const planId = plan.data.plan.id;
  const firstDueAt = plan.data.plan.nextStep.dueAt;

  const wait1 = await api('/api/routes/R2/waiting', {
    token: b, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('等待申请提交', wait1.status, 201);
  eq('等待申请保持等待', wait1.data.waiting.status, 'waiting');
  const w1 = wait1.data.waiting.id;

  const blk = await api('/api/admin/blockades', {
    token: admin, method: 'POST', body: { sectionId: '2', reason: '检查点测试封锁' }
  });
  eq('封锁提交', blk.status, 201);
  eq('封锁已生效', blk.data.blockade.status, 'active');
  const blockadeId = blk.data.blockade.id;

  const h1 = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单 H1 生成', h1.status, 201);
  const h1Id = h1.data.handover.id;
  r = await api(`/api/handovers/${h1Id}/sign`, { token: b, method: 'POST' });
  eq('H1 签收', r.status, 201);
  const h2 = await api('/api/handovers', { token: a, method: 'POST' });
  eq('交接单 H2 生成', h2.status, 201);
  const h2Id = h2.data.handover.id;

  console.log('\n[4] 暂停副本并创建检查点；重名/空白拒绝；列表与详情');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('暂停成功', r.status, 200);
  const pausedAt1 = r.data.yard.pausedAt;
  const cancelRemaining = releaseAt - pausedAt1;   // 检查点当时的取消剩余时间
  const planRemaining = firstDueAt - pausedAt1;    // 检查点当时的计划步剩余时间
  ok('取消剩余时间为正', cancelRemaining > 0, { cancelRemaining });
  ok('计划剩余时间为正', planRemaining > 0, { planRemaining });

  r = await api('/api/admin/checkpoints', { token: admin, method: 'POST', body: { name: '基线A' } });
  eq('创建检查点 201', r.status, 201);
  const cp = r.data.checkpoint;
  ok('检查点编号返回', Number.isInteger(cp.id) && cp.id >= 1, cp);
  eq('检查点名称', cp.name, '基线A');
  eq('检查点创建人', cp.createdBy, '管理员');
  ok('检查点创建时间返回', Number.isInteger(cp.createdAt), cp);
  const cpId = cp.id;
  eq('摘要-开放进路', cp.summary.openInstances, 3);
  eq('摘要-等待申请', cp.summary.waitingApplications, 1);
  eq('摘要-待处理取消', cp.summary.pendingCancellations, 1);
  eq('摘要-未结束封锁', cp.summary.unfinishedBlockades, 1);
  eq('摘要-活动计划', cp.summary.activeMovementPlans, 1);
  eq('摘要-待签收交接单', cp.summary.activeHandovers, 1);
  eq('摘要-已签收交接单', cp.summary.signedHandovers, 1);

  r = await api('/api/admin/checkpoints', { token: admin, method: 'POST', body: { name: '基线A' } });
  eq('重名拒绝 409', r.status, 409);
  eq('重名错误码', r.data.code, 'CHECKPOINT_NAME_DUPLICATE');
  r = await api('/api/admin/checkpoints', { token: admin, method: 'POST', body: { name: '   ' } });
  eq('空白名拒绝 400', r.status, 400);
  eq('空白名错误码', r.data.code, 'CHECKPOINT_NAME_INVALID');

  r = await api('/api/admin/checkpoints', { token: admin });
  eq('列表 200', r.status, 200);
  eq('列表含检查点', r.data.checkpoints.length, 1);
  eq('列表编号', r.data.checkpoints[0].id, cpId);
  eq('列表名称', r.data.checkpoints[0].name, '基线A');
  ok('列表创建时间文本', !!r.data.checkpoints[0].createdAtText, r.data.checkpoints[0]);
  r = await api(`/api/admin/checkpoints/${cpId}`, { token: admin });
  eq('详情 200', r.status, 200);
  eq('详情摘要-开放进路', r.data.checkpoint.summary.openInstances, 3);
  r = await api('/api/admin/checkpoints/999', { token: admin });
  eq('详情未知 404', r.status, 404);

  console.log('\n[5] 恢复后继续计时（为检查点后变更做准备）');
  r = await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('恢复成功', r.status, 200);
  eq('恢复平移取消', r.data.adjusted.cancellations, 1);
  eq('恢复平移计划步', r.data.adjusted.movementPlanSteps, 1);

  console.log('\n[6] 检查点后变更：走行/撤销等待/结束封锁/终止计划/新交接单/新等待');
  r = await api(`/api/instances/${i1}/events`, {
    token: a, method: 'POST', body: { seq: 2, sectionId: '1', action: 'clear' }
  });
  eq('R1 清空首段', r.status, 200);
  r = await api(`/api/waiting/${w1}/cancel`, { token: b, method: 'POST' });
  eq('撤销等待 W1', r.status, 200);
  r = await api(`/api/admin/blockades/${blockadeId}/end`, { token: admin, method: 'POST' });
  eq('结束封锁', r.status, 200);
  r = await api(`/api/movement-plans/${planId}/terminate`, { token: a, method: 'POST' });
  eq('终止计划', r.status, 200);
  const h3 = await api('/api/handovers', { token: c, method: 'POST' });
  eq('交接单 H3 生成', h3.status, 201);
  const h3Id = h3.data.handover.id;
  r = await api(`/api/handovers/${h3Id}/sign`, { token: a, method: 'POST' });
  eq('H3 签收（检查点后签收历史）', r.status, 201);
  const wait2 = await api('/api/routes/R3/waiting', {
    token: a, method: 'POST', body: { switchPositions: { SW7: 'R', SW8: 'N' } }
  });
  eq('检查点后新等待提交', wait2.status, 201);
  const w2 = wait2.data.waiting.id;

  console.log('\n[7] 再次暂停并回退到检查点');
  r = await api('/api/admin/yards/current/pause', { token: admin, method: 'POST' });
  eq('再次暂停', r.status, 200);
  const pausedAt2 = r.data.yard.pausedAt;
  ok('第二暂停纪元更晚', pausedAt2 > pausedAt1, { pausedAt1, pausedAt2 });

  r = await api(`/api/admin/checkpoints/${cpId}/restore`, { token: admin, method: 'POST' });
  eq('回退成功', r.status, 200);
  eq('回退后副本保持暂停', r.data.yard.paused, true);
  eq('回退后副本状态', r.data.yard.status, 'paused');
  eq('回退折算取消', r.data.detail.adjusted.cancellations, 1);
  eq('回退折算计划步', r.data.detail.adjusted.movementPlanSteps, 1);
  eq('回退过期未签收交接单', r.data.detail.handovers.expired, 1);
  eq('回退并入检查后交接单', r.data.detail.handovers.merged, 1);
  eq('回退保留已签收交接单', r.data.detail.handovers.signedRetained, 2);

  console.log('\n[8] 回退后盘面核验（副本仍暂停，只读）');
  r = await api('/api/admin/state', { token: admin });
  const st = r.data.state;
  eq('开放实例回到 3 条', st.openInstances.length, 3);
  const ri1 = st.openInstances.find((x) => x.id === i1);
  eq('R1 走行进度回退（下一序号=2）', ri1.nextSeq, 2);
  eq('R1 信号保持检查点时状态（首段占用后回红）', ri1.signalState, 'red');
  eq('区段1 恢复占用', st.sections.find((s) => s.id === '1').occ_state, 'occupied');
  const w1Row = st.waitingApplications.find((x) => x.id === w1);
  eq('W1 恢复等待中', w1Row && w1Row.status, 'waiting');
  eq('检查点后等待 W2 已回退消失',
    st.waitingApplications.some((x) => x.id === w2), false);
  const cRow = st.cancellationRequests.find((x) => x.id === cancelId);
  eq('取消恢复待处理', cRow && cRow.status, 'pending');
  eq('取消剩余时间=检查点当时剩余', cRow.remainingMs, cancelRemaining);
  eq('取消到期时刻折算到新暂停纪元', cRow.releaseAt, pausedAt2 + cancelRemaining);
  const pRow = st.movementPlans.find((x) => x.id === planId);
  eq('计划恢复活动（检查点后终止被回退）', pRow && pRow.status, 'active');
  eq('计划步剩余时间=检查点当时剩余', pRow.nextStep.remainingMs, planRemaining);
  eq('计划步到期时刻折算到新暂停纪元', pRow.nextStep.dueAt, pausedAt2 + planRemaining);
  const bRow = st.blockades.find((x) => x.id === blockadeId);
  eq('封锁恢复已生效（检查点后结束被回退）', bRow && bRow.status, 'active');

  r = await api('/api/handovers', { token: a });
  const h1Row = r.data.handovers.find((x) => x.id === h1Id);
  const h2Row = r.data.handovers.find((x) => x.id === h2Id);
  const h3Row = r.data.handovers.find((x) => x.id === h3Id);
  eq('H1 已签收保留', h1Row && h1Row.status, 'signed');
  eq('H2 未签收过期', h2Row && h2Row.status, 'expired');
  eq('H3 检查点后签收历史保留', h3Row && h3Row.status, 'signed');

  r = await api('/api/admin/checkpoints', { token: admin });
  eq('回退后检查点仍在（可再次使用）', r.data.checkpoints.length, 1);

  r = await api('/api/auth/yards', { token: a });
  eq('会话当前站场选择不受影响', r.data.currentYardId, yardId);
  await api('/api/auth/yard', { token: a, method: 'PUT', body: {} });
  r = await api('/api/state', { token: a });
  eq('原站场不受影响（无开放实例）', r.data.state.openInstances.length, 0);
  await api('/api/auth/yard', { token: a, method: 'PUT', body: { yardId } });

  console.log('\n[9] 已到期事项恢复后立即复核、不重复；后续编号不冲突');
  const yardFile = path.join(path.dirname(DB_PATH),
    path.basename(DB_PATH, path.extname(DB_PATH)) + '.yards', `yard-${yardId}.db`);
  const Database = require('better-sqlite3');
  const ydb = new Database(yardFile);
  ydb.prepare(`UPDATE cancellation_applications SET release_at=? WHERE id=?`)
    .run(pausedAt2 - 500, cancelId);
  ydb.prepare(`UPDATE movement_plan_steps SET due_at=? WHERE plan_id=? AND status='pending'`)
    .run(pausedAt2 - 500, planId);
  ydb.close();

  r = await api('/api/admin/yards/current/resume', { token: admin, method: 'POST' });
  eq('恢复成功', r.status, 200);
  eq('已到期取消不平移', r.data.adjusted.cancellations, 0);
  eq('已到期计划步不平移', r.data.adjusted.movementPlanSteps, 0);
  const resumedAt = r.data.yard.resumedAt;

  r = await api('/api/cancellations?scope=all', { token: a });
  const cAfter = r.data.cancellations.find((x) => x.id === cancelId);
  eq('已到期取消恢复后立即解除', cAfter.status, 'released');
  r = await api(`/api/movement-plans/${planId}`, { token: a });
  eq('已到期计划步恢复后立即注入', r.data.plan.steps[0].status, 'done');
  eq('计划步事件序号沿用走行序号', r.data.plan.steps[0].eventSeq, 1);
  eq('计划仍活动（未重复注入）', r.data.plan.status, 'active');
  ok('下一步重新计时', r.data.plan.nextStep.dueAt > resumedAt, r.data.plan.nextStep);
  r = await api('/api/admin/state', { token: admin });
  const ri3 = r.data.state.openInstances.find((x) => x.id === i3);
  eq('I3 仅注入一个事件（不重复执行）', ri3.events.length, 1);
  eq('I3 事件为计划首步', ri3.events[0].seq, 1);
  eq('I2 已解除', r.data.state.openInstances.some((x) => x.id === i2), false);

  const openR4Again = await api('/api/routes/R4/open', { token: b, method: 'POST', body: {} });
  eq('重新开放 R4', openR4Again.status, 200);
  eq('新实例编号从检查点水位继续（不冲突）', openR4Again.data.instance.id, 4);
  const wait3 = await api('/api/routes/R2/waiting', {
    token: b, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'R' } }
  });
  eq('新等待申请提交', wait3.status, 201);
  eq('新等待编号从检查点水位继续（不冲突）', wait3.data.waiting.id, 2);
  const h4 = await api('/api/handovers', { token: a, method: 'POST' });
  eq('新交接单生成', h4.status, 201);
  eq('新交接单编号不与保留历史冲突', h4.data.handover.id, 4);

  console.log('\n[10] 跨重启持久化；检查点可再次回退复用');
  await stopServer();
  await startServer(true);
  const admin2 = await login('admin');
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: { yardId } });
  r = await api('/api/admin/checkpoints', { token: admin2 });
  eq('重启后检查点仍在', r.data.checkpoints.length, 1);
  eq('重启后检查点编号不变', r.data.checkpoints[0].id, cpId);
  r = await api('/api/admin/checkpoints', { token: admin2, method: 'POST', body: { name: '重启后' } });
  eq('运行中副本重启后仍拒绝创建', r.status, 409);
  r = await api('/api/admin/yards/current/pause', { token: admin2, method: 'POST' });
  eq('重启后暂停', r.status, 200);
  r = await api(`/api/admin/checkpoints/${cpId}/restore`, { token: admin2, method: 'POST' });
  eq('检查点再次回退成功（可复用）', r.status, 200);
  eq('再次回退后副本保持暂停', r.data.yard.paused, true);
  r = await api('/api/admin/state', { token: admin2 });
  eq('再次回退开放实例回到 3 条', r.data.state.openInstances.length, 3);
  eq('再次回退 W1 恢复等待',
    r.data.state.waitingApplications.some((x) => x.id === w1 && x.status === 'waiting'), true);
  eq('再次回退封锁恢复已生效',
    r.data.state.blockades.some((x) => x.id === blockadeId && x.status === 'active'), true);
  r = await api('/api/admin/checkpoints/999/restore', { token: admin2, method: 'POST' });
  eq('未知检查点回退 404', r.status, 404);
  eq('未知检查点回退错误码', r.data.code, 'CHECKPOINT_NOT_FOUND');
  await api('/api/auth/yard', { token: admin2, method: 'PUT', body: {} });
  r = await api('/api/admin/checkpoints', { token: admin2, method: 'POST', body: { name: '原站场点' } });
  eq('原站场创建仍拒绝', r.status, 400);
  r = await api(`/api/admin/checkpoints/${cpId}/restore`, { token: admin2, method: 'POST' });
  eq('原站场回退仍拒绝', r.status, 400);

  await stopServer();
  console.log(`\n具名检查点 ${passed} 项断言通过 ✅`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  try { if (server) server.kill('SIGKILL'); } catch (_) {}
  process.exit(1);
});
