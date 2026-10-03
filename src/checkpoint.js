'use strict';

/**
 * 命名演练副本的具名检查点。
 *
 * 存储模型：
 *  - 检查点 = 副本业务库的整体一致快照文件（VACUUM INTO 单文件）+
 *    主库 yard_checkpoints 注册行（编号/名称/创建人/创建时刻/状态摘要/
 *    创建时副本的暂停时刻）。快照文件放在业务库目录的 checkpoints/ 子目录。
 *  - 仅允许在【已暂停的命名演练副本】上创建与回退：暂停期间该副本没有任何
 *    业务写入与定时扫描（写操作统一 409 YARD_PAUSED、调度器跳过暂停副本），
 *    快照天然一致。原站场与运行中副本一律拒绝。
 *
 * 快照覆盖该副本业务库的全部内容：站场定义、区段与道岔状态、进路实例及
 * 锁闭与事件、等待申请（含提交顺位）、延时取消、临时封锁、定时走行计划与
 * 步骤、交接班交接单、meta 设置（含延时取消保护时长），以及各自增序列水位
 * （sqlite_sequence）——回退后后续编号从检查点水位继续递增，不会与检查点
 * 保留的申请顺位、实例与事件序号冲突。
 *
 * 回退语义（整体回退，失败时原状态不变）：
 *  1) 先把当前业务库复制为回滚备份；快照先复制到临时文件并做完整性校验，
 *     再原子改名替换业务库——替换前任何失败都不触碰原状态；
 *  2) 替换后在恢复出的业务库上以单个事务完成：
 *     a. 待处理延时取消 release_at 与活动计划已排期步骤 due_at 按"检查点
 *        当时的剩余时间"折算到当前暂停纪元（恢复副本后继续冻结计时；
 *        检查点当时已到期的事项保持到期，恢复后立即按现有规则复核，
 *        状态机保证不重复执行）；
 *     b. 交接单合并：未签收单（含快照带回的与回退前库中的）一律过期；
 *        已签收单（含检查点之后签收的）全部保留；交接单序号水位同步抬升，
 *        后续编号不冲突；
 *  3) 合并事务失败则用回滚备份还原业务库，原状态不变。
 *  回退不触碰主库 yards/sessions：副本保持暂停，其他站场与各会话的当前
 *  站场选择不受影响；检查点注册行与快照文件保留，可反复回退复用。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  ORIGINAL_YARD_ID, getMainDb, getYardConnection, dropYardConnection,
  yardsDir, yardDbPath
} = require('./db');
const { InterlockError } = require('./interlocking');

const NAME_RE = /^\S(?:.*\S)?$/;
const MAX_NAME_LEN = 30;

/* ------------------------------ 路径工具 ------------------------------ */

/** 检查点快照目录：业务库目录下的 checkpoints/ 子目录 */
function checkpointsDir() {
  return path.join(yardsDir(), 'checkpoints');
}

function checkpointFileName(yardId, checkpointId) {
  return `yard-${yardId}.checkpoint-${checkpointId}.db`;
}

function checkpointFilePath(file) {
  return path.join(checkpointsDir(), file);
}

/** 删除 SQLite 侧车文件（-wal/-shm），忽略不存在 */
function cleanupSidecars(filePath) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(filePath + ext); } catch (_) {}
  }
}

/* ------------------------------ 注册行 ------------------------------ */

function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function rowToCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    yardId: row.yard_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    createdAtText: new Date(Number(row.created_at)).toLocaleString('zh-CN', { hour12: false }),
    summary: safeParse(row.summary, {})
  };
}

function getCheckpointRow(yardId, checkpointId) {
  return getMainDb().prepare(
    `SELECT * FROM yard_checkpoints WHERE yard_id=? AND id=?`
  ).get(yardId, checkpointId) || null;
}

/**
 * 校验当前站场是"已暂停的命名演练副本"并返回注册行。
 * 原站场与运行中副本的创建/回退一律拒绝。
 */
function pausedCopyOrThrow(yardId) {
  const row = getMainDb().prepare(`SELECT * FROM yards WHERE id=?`).get(yardId);
  if (!row) {
    throw new InterlockError(404, 'YARD_NOT_FOUND', '未知演练副本：该站场不存在');
  }
  if (row.id === ORIGINAL_YARD_ID || row.kind === 'original') {
    throw new InterlockError(400, 'CHECKPOINT_ORIGINAL_FORBIDDEN',
      '原站场不支持检查点：只能在已暂停的命名演练副本上创建或回退检查点');
  }
  if (row.status !== 'paused') {
    throw new InterlockError(409, 'CHECKPOINT_YARD_NOT_PAUSED',
      '仅已暂停的命名演练副本可创建/回退检查点；请先在顶栏暂停该副本' +
      '（暂停期间盘面冻结、无业务写入，检查点快照保持一致）');
  }
  return row;
}

/* ------------------------------ 状态摘要 ------------------------------ */

/** 创建时刻的盘面摘要（各类数量；列表/详情接口随检查点返回） */
function buildSummary(conn) {
  const count = (sql) => conn.prepare(sql).get().n;
  return {
    sections: count(`SELECT COUNT(*) AS n FROM sections`),
    switches: count(`SELECT COUNT(*) AS n FROM switches`),
    signals: count(`SELECT COUNT(*) AS n FROM signals`),
    routes: count(`SELECT COUNT(*) AS n FROM routes`),
    openInstances: count(`SELECT COUNT(*) AS n FROM route_instances WHERE status='open'`),
    waitingApplications: count(`SELECT COUNT(*) AS n FROM waiting_applications WHERE status='waiting'`),
    pendingCancellations: count(`SELECT COUNT(*) AS n FROM cancellation_applications WHERE status='pending'`),
    unfinishedBlockades: count(`SELECT COUNT(*) AS n FROM blockade_applications WHERE status IN ('pending','active')`),
    activeMovementPlans: count(`SELECT COUNT(*) AS n FROM movement_plans WHERE status='active'`),
    activeHandovers: count(`SELECT COUNT(*) AS n FROM handover_documents WHERE status='active'`),
    signedHandovers: count(`SELECT COUNT(*) AS n FROM handover_documents WHERE status='signed'`)
  };
}

/* ------------------------------ 创建 ------------------------------ */

/**
 * 在当前（已暂停）命名演练副本上创建具名检查点。
 * @returns {Object} 检查点（编号/名称/创建时间/状态摘要）
 */
function createCheckpoint(yardId, rawName, operator) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name || !NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    throw new InterlockError(400, 'CHECKPOINT_NAME_INVALID',
      `检查点名称需为 1~${MAX_NAME_LEN} 字非空白字符`);
  }
  const yard = pausedCopyOrThrow(yardId);

  const main = getMainDb();
  if (main.prepare(`SELECT 1 FROM yard_checkpoints WHERE yard_id=? AND name=?`).get(yardId, name)) {
    throw new InterlockError(409, 'CHECKPOINT_NAME_DUPLICATE',
      `该副本已存在名为"${name}"的检查点，同一副本内重名拒绝，请更换名称`);
  }

  const dir = checkpointsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 1) 暂停副本无并发写入：VACUUM INTO 得到整体一致的单文件快照
  //    （含定义/状态/锁与事件/申请/计划/交接单/设置与自增水位）
  const conn = getYardConnection(yardId);
  const summary = buildSummary(conn);
  const tmpPath = path.join(dir, `.creating-${yardId}-${Date.now()}.tmp`);
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  conn.prepare(`VACUUM INTO ?`).run(tmpPath);
  // 收尾为 DELETE 日志模式：快照单文件自洽（WAL 内容回卷主文件），
  // 之后可安全复制/原子改名，只读打开也不需要侧车文件
  const finalize = new Database(tmpPath);
  try { finalize.pragma('journal_mode = DELETE'); } finally { finalize.close(); }
  cleanupSidecars(tmpPath);

  // 2) 主库注册（同一副本内重名由 UNIQUE(yard_id,name) 兜底）
  let checkpointId;
  try {
    checkpointId = main.transaction(() => {
      const info = main.prepare(
        `INSERT INTO yard_checkpoints(yard_id,name,file,summary,paused_at,created_by,created_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(yardId, name, '', JSON.stringify(summary),
        yard.paused_at == null ? null : Number(yard.paused_at), operator, Date.now());
      const id = Number(info.lastInsertRowid);
      main.prepare(`UPDATE yard_checkpoints SET file=? WHERE id=?`)
        .run(checkpointFileName(yardId, id), id);
      return id;
    })();
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (String(e.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new InterlockError(409, 'CHECKPOINT_NAME_DUPLICATE',
        `该副本已存在名为"${name}"的检查点，同一副本内重名拒绝，请更换名称`);
    }
    throw e;
  }

  // 3) 快照文件落位；改名失败则删除注册行与临时文件，保持可重试
  try {
    fs.renameSync(tmpPath, checkpointFilePath(checkpointFileName(yardId, checkpointId)));
  } catch (e) {
    try { main.prepare(`DELETE FROM yard_checkpoints WHERE id=?`).run(checkpointId); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }

  return rowToCheckpoint(getCheckpointRow(yardId, checkpointId));
}

/* ------------------------------ 查看 ------------------------------ */

/** 当前站场的检查点列表（编号/名称/创建时间/状态摘要；原站场恒为空表） */
function listCheckpoints(yardId) {
  return getMainDb().prepare(
    `SELECT * FROM yard_checkpoints WHERE yard_id=? ORDER BY id`
  ).all(yardId).map(rowToCheckpoint);
}

/** 查看单个检查点；未知检查点（含其他副本的检查点）一律 404 */
function getCheckpoint(yardId, checkpointId) {
  const id = Number(checkpointId);
  if (!Number.isInteger(id) || id < 1) {
    throw new InterlockError(404, 'CHECKPOINT_NOT_FOUND',
      `未知检查点：该副本不存在检查点 ${checkpointId}`);
  }
  const row = getCheckpointRow(yardId, id);
  if (!row) {
    throw new InterlockError(404, 'CHECKPOINT_NOT_FOUND',
      `未知检查点 #${id}：该副本不存在此检查点`);
  }
  return rowToCheckpoint(row);
}

/* ------------------------------ 回退 ------------------------------ */

/**
 * 把当前（已暂停）副本整体回退到指定检查点。
 * 失败时原状态不变；成功后检查点保留可再次使用，副本保持暂停，
 * 其他站场与各会话的当前站场选择不受影响。
 *
 * @returns {{checkpoint:Object, detail:Object}} 检查点与回退明细
 */
function restoreCheckpoint(yardId, checkpointId, operator) {
  const yard = pausedCopyOrThrow(yardId);            // 原站场/运行中副本拒绝
  const checkpoint = getCheckpoint(yardId, checkpointId); // 未知检查点 404
  const cpRow = getCheckpointRow(yardId, checkpoint.id);

  const srcPath = checkpointFilePath(cpRow.file);
  if (!fs.existsSync(srcPath)) {
    throw new InterlockError(500, 'CHECKPOINT_FILE_MISSING',
      `检查点 #${cpRow.id} 的快照文件缺失，回退未执行，副本状态保持不变`);
  }

  const nowPausedAt = Number(yard.paused_at);        // 当前暂停纪元
  const cpPausedAt = cpRow.paused_at == null ? nowPausedAt : Number(cpRow.paused_at);

  // 1) 回退前读取当前业务库中的交接单（用于"未签收过期、已签收保留"合并）
  const handoversBefore = getYardConnection(yardId)
    .prepare(`SELECT * FROM handover_documents`).all();

  // 2) 干净关闭当前业务库连接（关闭时 WAL 已回卷主文件）
  dropYardConnection(yardId);
  const dbPath = yardDbPath(yardId);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) {} }
  const backupPath = `${dbPath}.before-restore-${Date.now()}.tmp`;
  const tmpPath = `${dbPath}.restoring-${Date.now()}.tmp`;
  try {
    // 3) 回滚备份（合并事务失败时还原，保证原状态不变）
    try { fs.unlinkSync(backupPath); } catch (_) {}
    fs.copyFileSync(dbPath, backupPath);

    // 4) 快照 → 临时文件，落位前做完整性校验（失败则原状态不变）
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    fs.copyFileSync(srcPath, tmpPath);
    const probe = new Database(tmpPath, { readonly: true });
    try {
      const check = probe.pragma('quick_check');
      const verdict = check && check[0] ? String(Object.values(check[0])[0]) : '';
      if (verdict !== 'ok') throw new Error(`quick_check=${verdict}`);
      probe.prepare(`SELECT COUNT(*) AS n FROM sections`).get();
    } finally {
      probe.close();
    }

    // 5) 原子改名替换业务库
    fs.renameSync(tmpPath, dbPath);
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) {} }

    // 6) 在恢复出的业务库上以单个事务完成剩余时间折算与交接单合并
    const conn = getYardConnection(yardId); // 重新打开新文件
    const detail = conn.transaction(() =>
      mergeRestoredInTxn(conn, cpRow, handoversBefore, nowPausedAt, cpPausedAt))();
    return { checkpoint, detail, operator };
  } catch (e) {
    // 回退失败：用回滚备份还原业务库，副本原状态不变
    try { dropYardConnection(yardId); } catch (_) {}
    try {
      fs.copyFileSync(backupPath, dbPath);
      for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) {} }
    } catch (restoreErr) {
      console.error('[checkpoint] 回退失败后还原业务库失败:', restoreErr);
    }
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (e instanceof InterlockError) throw e;
    throw new InterlockError(500, 'CHECKPOINT_RESTORE_FAILED',
      `回退到检查点 #${cpRow.id} 失败：${e.message}；副本原状态保持不变`);
  } finally {
    try { fs.unlinkSync(backupPath); } catch (_) {}
  }
}

/**
 * 在恢复出的业务库上执行的同事务合并（调用方已开启事务）：
 *  a. 待处理延时取消与活动计划已排期步骤：到期时刻按"检查点当时的剩余
 *     时间"折算到当前暂停纪元（= 当前 pausedAt + 检查点剩余）。检查点
 *     当时已到期（<= 检查点暂停时刻）的事项保持原值，恢复副本后立即
 *     到期并按现有规则复核；pending/done 状态机保证不重复执行。
 *  b. 交接单：未签收一律过期（快照带回的与回退前库中的同样处理）；
 *     已签收历史全部保留（含检查点之后签收的单据，按其原编号并入）；
 *     交接单自增水位抬升到合并后最大编号，后续编号不冲突。
 */
function mergeRestoredInTxn(conn, cpRow, handoversBefore, nowPausedAt, cpPausedAt) {
  // a) 剩余时间折算（同一暂停纪元内回退时 nowPausedAt===cpPausedAt，为恒等改写）
  const shift = { now: nowPausedAt, cp: cpPausedAt };
  const adjustedCancellations = conn.prepare(
    `UPDATE cancellation_applications
        SET release_at = @now + (release_at - @cp)
      WHERE status='pending' AND release_at > @cp`
  ).run(shift).changes;
  const adjustedPlanSteps = conn.prepare(
    `UPDATE movement_plan_steps
        SET due_at = @now + (due_at - @cp)
      WHERE status='pending' AND due_at IS NOT NULL AND due_at > @cp
        AND plan_id IN (SELECT id FROM movement_plans WHERE status='active')`
  ).run(shift).changes;

  // b) 交接单合并
  const expireReason = JSON.stringify({
    reason: `检查点回退（#${cpRow.id}「${cpRow.name}」）：未签收交接单过期；已签收单保留供复盘`,
    categories: [], changes: [], checkpointRestore: true
  });
  const expiredFromSnapshot = conn.prepare(
    `UPDATE handover_documents SET status='expired', expire_reason=? WHERE status='active'`
  ).run(expireReason).changes;

  const restoredRows = new Map(
    conn.prepare(`SELECT * FROM handover_documents`).all().map((r) => [r.id, r]));
  const markSigned = conn.prepare(
    `UPDATE handover_documents SET status='signed', to_name=?, signed_at=?, expire_reason=NULL
      WHERE id=?`);
  const insertHandover = conn.prepare(
    `INSERT INTO handover_documents
       (id,from_name,to_name,status,generated_at,signed_at,snapshot,expire_reason,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`);
  let merged = 0;
  let expiredMerged = 0;
  for (const row of handoversBefore) {
    const existing = restoredRows.get(row.id);
    if (existing) {
      // 同一编号：检查点之后已签收的，保留签收结果（已签收历史不丢）
      if (row.status === 'signed' && existing.status !== 'signed') {
        markSigned.run(row.to_name, row.signed_at, row.id);
      }
      continue;
    }
    // 检查点之后产生的交接单：已签收保留；未签收按回退过期；已过期原样并入
    const status = row.status === 'signed' ? 'signed'
      : row.status === 'active' ? 'expired' : row.status;
    insertHandover.run(row.id, row.from_name, row.to_name, status,
      row.generated_at, row.signed_at, row.snapshot,
      row.status === 'active' ? expireReason : row.expire_reason, row.created_at);
    merged++;
    if (row.status === 'active') expiredMerged++;
  }

  // 交接单序号水位：不低于合并后最大编号，后续编号不冲突
  const maxHandoverId = conn.prepare(
    `SELECT COALESCE(MAX(id),0) AS m FROM handover_documents`).get().m;
  conn.prepare(
    `INSERT INTO sqlite_sequence(name,seq)
       SELECT 'handover_documents', ?
        WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='handover_documents')`
  ).run(maxHandoverId);
  conn.prepare(
    `UPDATE sqlite_sequence SET seq=? WHERE name='handover_documents' AND seq<?`
  ).run(maxHandoverId, maxHandoverId);

  const signedRetained = conn.prepare(
    `SELECT COUNT(*) AS n FROM handover_documents WHERE status='signed'`).get().n;

  return {
    adjusted: {
      cancellations: adjustedCancellations,
      movementPlanSteps: adjustedPlanSteps
    },
    handovers: {
      expired: expiredFromSnapshot + expiredMerged, // 回退过期的未签收单
      signedRetained,                               // 回退后保留的已签收单总数
      merged                                        // 检查点之后产生、并入回退结果的单数
    }
  };
}

module.exports = {
  MAX_NAME_LEN,
  createCheckpoint,
  listCheckpoints,
  getCheckpoint,
  restoreCheckpoint
};
