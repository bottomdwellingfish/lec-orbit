/**
 * Orbit 平台通用 Nakama 联机赌约房插件（方案 F · Goja ES5.1 兼容单文件）
 *
 * 职责：
 * 1. 注册 RPC `orbit_create_wager_match`：核验当前成员身份与 Orbit 托管单 `locked` 状态，
 *    一单一房幂等创建或复用权威房间 `orbit_wager_room`；
 * 2. 透传全部游戏业务帧（OpCode 1 ~ 8999），游戏前端无需编写任何服务端代码或持有 App Secret；
 * 3. 提供平台保留控制 OpCode（9000+）：
 *    - 9001 (OP_REPORT_RESULT)：双方上报胜负/平局，一致即内网直调 Orbit 原子结算；冲突则挂起进入队长仲裁；
 *    - 9002 (OP_SURRENDER)：单方主动认输，立即判对方胜并结算；
 *    - 9003 (OP_WAGER_EVENT)：房间向客户端推送赌约状态事件；
 * 4. 实时盯防掉线：双方均曾进房后若一方掉线超宽限期（默认 30 秒，允许重连恢复），自动判在场方胜。
 */

var MODULE_NAME = 'orbit_wager_room';
var RPC_CREATE_WAGER_MATCH = 'orbit_create_wager_match';
var TICK_RATE = 20;
var OP_REPORT_RESULT = 9001;
var OP_SURRENDER = 9002;
var OP_WAGER_EVENT = 9003;
var DEFAULT_DISCONNECT_GRACE_SEC = 30;
var MIN_DISCONNECT_GRACE_SEC = 10;
var MAX_DISCONNECT_GRACE_SEC = 120;
var POST_FINALIZE_CLOSE_TICKS = TICK_RATE * 5;
var EMPTY_ROOM_IDLE_TICKS = TICK_RATE * 300;
var LEC_CUSTOM_ID_PREFIX = 'lec:';

/** 从 Nakama 账号读取对应的 Orbit 用户 ID（去掉 lec: 前缀）。 */
function resolveOrbitUserId(nk, nakamaUserId) {
  if (!nakamaUserId) return '';
  var account = nk.accountGetId(nakamaUserId);
  if (!account) return '';
  var customId =
    account.customId ||
    account.custom_id ||
    (account.user && (account.user.customId || account.user.custom_id)) ||
    '';
  if (typeof customId !== 'string') return '';
  if (customId.indexOf(LEC_CUSTOM_ID_PREFIX) === 0) {
    return customId.slice(LEC_CUSTOM_ID_PREFIX.length);
  }
  return '';
}

/** 读取并校验 Orbit 内网网关配置（通过 Nakama --runtime.env 注入）。 */
function readOrbitInternalConfig(ctx) {
  var env = (ctx && ctx.env) || {};
  var baseUrl = String(env.ORBIT_INTERNAL_URL || '').replace(/\/+$/, '');
  var token = String(env.ORBIT_INTERNAL_TOKEN || '');
  if (!baseUrl || !token) {
    throw new Error('Nakama 尚未配置 ORBIT_INTERNAL_URL 或 ORBIT_INTERNAL_TOKEN');
  }
  return { baseUrl: baseUrl, token: token };
}

/** 调用 Orbit 集群内网接口（/internal/v1/economy/*）。 */
function callOrbitInternal(ctx, nk, method, path, bodyObj) {
  var cfg = readOrbitInternalConfig(ctx);
  var url = cfg.baseUrl + path;
  var headers = {
    'Content-Type': 'application/json',
    'X-Orbit-Internal-Token': cfg.token,
  };
  var bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  var res = nk.httpRequest(url, method.toLowerCase(), headers, bodyStr, 5000);
  var parsed = null;
  if (res && res.body) {
    try {
      parsed = JSON.parse(res.body);
    } catch (_e) {
      parsed = { raw: res.body };
    }
  }
  if (!res || res.code < 200 || res.code >= 300) {
    var msg =
      (parsed && (parsed.message || parsed.error)) ||
      ('Orbit 内部接口返回 HTTP ' + (res ? res.code : 'unknown'));
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return parsed;
}

/** 构造用于精确查重与标签检索的房间 Label JSON。 */
function buildMatchLabel(orderId, appId) {
  return JSON.stringify({
    type: 'orbit_wager',
    appId: String(appId || ''),
    orderId: String(orderId || ''),
  });
}

/** 安全解码 Nakama 消息体为 UTF-8 字符串。 */
function decodeMessageData(nk, data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (nk && typeof nk.binaryToString === 'function') {
    return nk.binaryToString(data);
  }
  return '';
}

/** 向房间广播平台赌约状态事件（OpCode 9003）。 */
function broadcastWagerEvent(dispatcher, payload, recipients) {
  dispatcher.broadcastMessage(
    OP_WAGER_EVENT,
    JSON.stringify(payload),
    recipients || null,
    null,
    true,
  );
}

/** 规范化并校验单方提交的胜负结果。 */
function normalizeResultReport(raw, creatorOrbitId, opponentOrbitId) {
  if (!raw || typeof raw !== 'object') return null;
  var result = String(raw.result || '').toLowerCase();
  if (result !== 'win' && result !== 'draw' && result !== 'refund') {
    return null;
  }
  var winnerOrbitUserId = '';
  if (result === 'win') {
    winnerOrbitUserId = String(raw.winnerOrbitUserId || raw.winnerUserId || '').trim();
    if (winnerOrbitUserId !== creatorOrbitId && winnerOrbitUserId !== opponentOrbitId) {
      return null;
    }
  }
  var summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 160) : '';
  return {
    result: result,
    winnerOrbitUserId: winnerOrbitUserId,
    summary: summary,
  };
}

/** 判断两名参与者的结果上报是否完全一致。 */
function areReportsConsistent(a, b) {
  if (!a || !b) return false;
  if (a.result !== b.result) return false;
  if (a.result === 'win') {
    return a.winnerOrbitUserId === b.winnerOrbitUserId;
  }
  return true;
}

/** 统计指定 Orbit 用户在房间内当前活跃连接数。 */
function countOrbitUserSessions(state, orbitUserId) {
  var count = 0;
  for (var sid in state.presences) {
    if (Object.prototype.hasOwnProperty.call(state.presences, sid)) {
      if (state.presenceToOrbitUser[sid] === orbitUserId) {
        count += 1;
      }
    }
  }
  return count;
}

/** 判断指定 Orbit 用户是否为本笔赌约的两名参与方之一。 */
function isWagerParticipant(state, orbitUserId) {
  return (
    orbitUserId === state.creatorOrbitId || orbitUserId === state.opponentOrbitId
  );
}

/** 获取对手的 Orbit 用户 ID。 */
function getOpponentOrbitId(state, orbitUserId) {
  if (orbitUserId === state.creatorOrbitId) return state.opponentOrbitId;
  if (orbitUserId === state.opponentOrbitId) return state.creatorOrbitId;
  return '';
}

/** 调用 Orbit 内网完成结算并广播结果（幂等防重入）。 */
function finalizeSettle(ctx, logger, nk, dispatcher, tick, state, opts) {
  if (state.finalized) return;
  state.finalized = true;
  state.finalizedAtTick = tick;

  var body = {
    appId: state.appId,
    result: opts.result,
    summary: opts.summary || '',
  };
  if (opts.result === 'win' && opts.winnerOrbitUserId) {
    body.winnerUserId = opts.winnerOrbitUserId;
  }

  try {
    var dto = callOrbitInternal(
      ctx,
      nk,
      'post',
      '/internal/v1/economy/wagers/' + encodeURIComponent(state.orderId) + '/settle',
      body,
    );
    state.finalStatus = (dto && dto.status) || 'settled';
    broadcastWagerEvent(dispatcher, {
      event: 'settled',
      orderId: state.orderId,
      appId: state.appId,
      status: state.finalStatus,
      result: opts.result,
      reason: opts.reason || 'consensus',
      winnerOrbitUserId: opts.winnerOrbitUserId || null,
      summary: (dto && dto.summary) || opts.summary || '',
    });
  } catch (err) {
    // 结算请求临时失败时允许后续重试，同时通知客户端
    state.finalized = false;
    state.finalizedAtTick = 0;
    var msg = err && err.message ? err.message : String(err);
    logger.error('Orbit 赌约内部结算失败 orderId=%s err=%s', state.orderId, msg);
    broadcastWagerEvent(dispatcher, {
      event: 'settle_error',
      orderId: state.orderId,
      message: msg,
    });
  }
}

/** 调用 Orbit 内网挂起争议订单并广播结果。 */
function finalizeDispute(ctx, logger, nk, dispatcher, tick, state, reason) {
  if (state.finalized) return;
  state.finalized = true;
  state.finalizedAtTick = tick;
  state.finalStatus = 'disputed';

  try {
    callOrbitInternal(
      ctx,
      nk,
      'post',
      '/internal/v1/economy/wagers/' + encodeURIComponent(state.orderId) + '/dispute',
      {
        appId: state.appId,
        reason: reason,
      },
    );
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    logger.error('Orbit 赌约标记争议失败 orderId=%s err=%s', state.orderId, msg);
  }

  broadcastWagerEvent(dispatcher, {
    event: 'disputed',
    orderId: state.orderId,
    appId: state.appId,
    status: 'disputed',
    reason: reason,
  });
}

// ── RPC: orbit_create_wager_match ──

function rpcCreateWagerMatch(ctx, logger, nk, payload) {
  if (!ctx || !ctx.userId) {
    throw new Error('缺少已登录的 Nakama 会话身份');
  }
  var input = {};
  if (payload) {
    try {
      input = JSON.parse(payload);
    } catch (_e) {
      throw new Error('RPC 参数必须为合法 JSON');
    }
  }
  var orderId = String(input.orderId || '').trim();
  if (!orderId) {
    throw new Error('缺少必填参数 orderId');
  }

  var callerOrbitId = resolveOrbitUserId(nk, ctx.userId);
  if (!callerOrbitId) {
    throw new Error('当前 Nakama 账号未绑定工作室 Orbit 身份（缺少 lec: custom_id）');
  }

  // 向 Orbit 服务端核验该笔赌约单真实存在、已锁仓且调用者为参与双方之一
  var order = callOrbitInternal(
    ctx,
    nk,
    'get',
    '/internal/v1/economy/wagers/' + encodeURIComponent(orderId),
    null,
  );
  if (!order || order.orderType !== 'escrow_wager') {
    throw new Error('目标订单不是有效的托管赌约单');
  }
  if (order.status !== 'locked') {
    throw new Error('托管赌约当前状态（' + order.status + '）不可开启对赌房，请先确保双方均已应战锁仓');
  }
  if (!order.creatorUserId || !order.opponentUserId) {
    throw new Error('托管赌约缺少完整的参与双方信息');
  }
  if (callerOrbitId !== order.creatorUserId && callerOrbitId !== order.opponentUserId) {
    throw new Error('你不是该托管赌约的参与方，无权创建或加入对赌房');
  }
  if (input.appId && String(input.appId).trim() !== order.appId) {
    throw new Error('传入的 appId 与托管赌约归属应用不匹配');
  }

  var graceSec = DEFAULT_DISCONNECT_GRACE_SEC;
  if (typeof input.disconnectGraceSeconds === 'number' && !isNaN(input.disconnectGraceSeconds)) {
    graceSec = Math.floor(input.disconnectGraceSeconds);
    if (graceSec < MIN_DISCONNECT_GRACE_SEC) graceSec = MIN_DISCONNECT_GRACE_SEC;
    if (graceSec > MAX_DISCONNECT_GRACE_SEC) graceSec = MAX_DISCONNECT_GRACE_SEC;
  }

  var allowSpectators = Boolean(input.allowSpectators);
  var labelJson = buildMatchLabel(orderId, order.appId);

  // 一单一房幂等查重：若对手已建好房间，直接返回同一 matchId
  var existing = nk.matchList(1, true, labelJson, null, null, null);
  if (existing && existing.length > 0 && existing[0].matchId) {
    return JSON.stringify({
      matchId: existing[0].matchId,
      orderId: orderId,
      appId: order.appId,
      creatorOrbitId: order.creatorUserId,
      opponentOrbitId: order.opponentUserId,
      asset: order.asset,
      amount: order.amount,
      created: false,
    });
  }

  var matchId = nk.matchCreate(MODULE_NAME, {
    orderId: orderId,
    appId: order.appId,
    creatorOrbitId: order.creatorUserId,
    opponentOrbitId: order.opponentUserId,
    asset: order.asset,
    amount: order.amount,
    disconnectGraceSeconds: graceSec,
    allowSpectators: allowSpectators,
  });

  logger.info(
    '已创建 Orbit 托管赌约房 matchId=%s orderId=%s appId=%s',
    matchId,
    orderId,
    order.appId,
  );

  return JSON.stringify({
    matchId: matchId,
    orderId: orderId,
    appId: order.appId,
    creatorOrbitId: order.creatorUserId,
    opponentOrbitId: order.opponentUserId,
    asset: order.asset,
    amount: order.amount,
    disconnectGraceSeconds: graceSec,
    created: true,
  });
}

// ── Authoritative Match Handler: orbit_wager_room ──

function matchInit(_ctx, _logger, _nk, params) {
  var p = params || {};
  var graceSec = Number(p.disconnectGraceSeconds || DEFAULT_DISCONNECT_GRACE_SEC);
  if (isNaN(graceSec) || graceSec < MIN_DISCONNECT_GRACE_SEC) {
    graceSec = DEFAULT_DISCONNECT_GRACE_SEC;
  }
  var labelJson = buildMatchLabel(p.orderId, p.appId);
  var state = {
    orderId: String(p.orderId || ''),
    appId: String(p.appId || ''),
    creatorOrbitId: String(p.creatorOrbitId || ''),
    opponentOrbitId: String(p.opponentOrbitId || ''),
    asset: String(p.asset || 'coin'),
    amount: Number(p.amount || 0),
    allowSpectators: Boolean(p.allowSpectators),
    disconnectGraceSeconds: graceSec,
    disconnectGraceTicks: graceSec * TICK_RATE,
    presences: {},
    presenceToOrbitUser: {},
    everJoined: {},
    bothJoined: false,
    disconnectedAtTick: {},
    reports: {},
    finalized: false,
    finalizedAtTick: 0,
    finalStatus: '',
    emptyTicks: 0,
  };
  return {
    state: state,
    tickRate: TICK_RATE,
    label: labelJson,
  };
}

function matchJoinAttempt(_ctx, _logger, nk, _dispatcher, _tick, state, presence, _metadata) {
  if (state.finalized) {
    return { state: state, accept: false, rejectMessage: '本局赌约已结束结算' };
  }
  var orbitUid = resolveOrbitUserId(nk, presence.userId);
  if (!orbitUid) {
    return { state: state, accept: false, rejectMessage: '未绑定工作室 Orbit 身份' };
  }
  if (!isWagerParticipant(state, orbitUid) && !state.allowSpectators) {
    return { state: state, accept: false, rejectMessage: '该房间仅限赌约参与双方进入' };
  }
  return { state: state, accept: true };
}

function matchJoin(_ctx, _logger, nk, dispatcher, _tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    var orbitUid = resolveOrbitUserId(nk, p.userId);
    state.presences[p.sessionId] = p;
    state.presenceToOrbitUser[p.sessionId] = orbitUid;

    if (isWagerParticipant(state, orbitUid)) {
      state.everJoined[orbitUid] = true;
      if (state.disconnectedAtTick[orbitUid]) {
        delete state.disconnectedAtTick[orbitUid];
        broadcastWagerEvent(dispatcher, {
          event: 'opponent_reconnected',
          orderId: state.orderId,
          orbitUserId: orbitUid,
        });
      }
    }
  }

  state.emptyTicks = 0;

  if (
    !state.bothJoined &&
    state.everJoined[state.creatorOrbitId] &&
    state.everJoined[state.opponentOrbitId]
  ) {
    state.bothJoined = true;
    broadcastWagerEvent(dispatcher, {
      event: 'matched',
      orderId: state.orderId,
      appId: state.appId,
      creatorOrbitId: state.creatorOrbitId,
      opponentOrbitId: state.opponentOrbitId,
      disconnectGraceSeconds: state.disconnectGraceSeconds,
    });
  }

  return { state: state };
}

function matchLeave(_ctx, _logger, _nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    var orbitUid = state.presenceToOrbitUser[p.sessionId];
    delete state.presences[p.sessionId];
    delete state.presenceToOrbitUser[p.sessionId];

    if (
      !state.finalized &&
      state.bothJoined &&
      orbitUid &&
      isWagerParticipant(state, orbitUid) &&
      countOrbitUserSessions(state, orbitUid) === 0
    ) {
      state.disconnectedAtTick[orbitUid] = tick;
      broadcastWagerEvent(dispatcher, {
        event: 'opponent_disconnected',
        orderId: state.orderId,
        orbitUserId: orbitUid,
        graceSeconds: state.disconnectGraceSeconds,
      });
    }
  }

  return { state: state };
}

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  // 1. 已终态：保留短窗口让客户端收到 9003 广播后优雅退出
  if (state.finalized) {
    if (tick - state.finalizedAtTick >= POST_FINALIZE_CLOSE_TICKS) {
      return null;
    }
    return { state: state };
  }

  // 2. 处理房间收到的消息（业务帧透传 + 保留控制 OpCode 9001/9002）
  if (messages && messages.length > 0) {
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var senderSid = msg.sender && msg.sender.sessionId;
      var senderOrbitId = senderSid ? state.presenceToOrbitUser[senderSid] : '';

      // 业务帧（1 ~ 8999）：原样转发给同房除发送者外的所有成员
      if (msg.opCode >= 1 && msg.opCode < 9000) {
        var recipients = [];
        for (var sid in state.presences) {
          if (Object.prototype.hasOwnProperty.call(state.presences, sid) && sid !== senderSid) {
            recipients.push(state.presences[sid]);
          }
        }
        if (recipients.length > 0) {
          dispatcher.broadcastMessage(msg.opCode, msg.data, recipients, msg.sender, true);
        }
        continue;
      }

      // 控制帧仅允许参与双方发送（观战者静默忽略）
      if (!isWagerParticipant(state, senderOrbitId)) {
        continue;
      }

      if (msg.opCode === OP_SURRENDER) {
        var winnerId = getOpponentOrbitId(state, senderOrbitId);
        finalizeSettle(ctx, logger, nk, dispatcher, tick, state, {
          result: 'win',
          winnerOrbitUserId: winnerId,
          reason: 'surrender',
          summary: '对手主动认输，系统自动结算',
        });
        break;
      }

      if (msg.opCode === OP_REPORT_RESULT) {
        var rawText = decodeMessageData(nk, msg.data);
        var parsed = null;
        try {
          parsed = JSON.parse(rawText);
        } catch (_e) {
          parsed = null;
        }
        var report = normalizeResultReport(parsed, state.creatorOrbitId, state.opponentOrbitId);
        if (!report) {
          broadcastWagerEvent(
            dispatcher,
            { event: 'report_rejected', orderId: state.orderId, message: '无效的结算上报格式' },
            msg.sender ? [msg.sender] : null,
          );
          continue;
        }

        state.reports[senderOrbitId] = report;
        broadcastWagerEvent(dispatcher, {
          event: 'result_reported',
          orderId: state.orderId,
          reporterOrbitUserId: senderOrbitId,
          result: report.result,
          winnerOrbitUserId: report.winnerOrbitUserId || null,
        });

        var reportA = state.reports[state.creatorOrbitId];
        var reportB = state.reports[state.opponentOrbitId];
        if (reportA && reportB) {
          if (areReportsConsistent(reportA, reportB)) {
            finalizeSettle(ctx, logger, nk, dispatcher, tick, state, {
              result: reportA.result,
              winnerOrbitUserId: reportA.winnerOrbitUserId || undefined,
              reason: 'consensus',
              summary: reportA.summary || reportB.summary || '双方共识确认结算',
            });
          } else {
            var reason =
              '双方上报胜负冲突：发起方报 ' +
              reportA.result +
              (reportA.winnerOrbitUserId ? '(' + reportA.winnerOrbitUserId + ')' : '') +
              '，应战方报 ' +
              reportB.result +
              (reportB.winnerOrbitUserId ? '(' + reportB.winnerOrbitUserId + ')' : '');
            finalizeDispute(ctx, logger, nk, dispatcher, tick, state, reason);
          }
          break;
        }
      }
    }
  }

  if (state.finalized) {
    return { state: state };
  }

  // 3. 掉线宽限期判定：仅在双方均曾进房、且恰好一方掉线超时而另一方仍在场时判负
  if (state.bothJoined) {
    var creatorOnline = countOrbitUserSessions(state, state.creatorOrbitId) > 0;
    var opponentOnline = countOrbitUserSessions(state, state.opponentOrbitId) > 0;

    if (!creatorOnline && opponentOnline && state.disconnectedAtTick[state.creatorOrbitId] !== undefined) {
      if (tick - state.disconnectedAtTick[state.creatorOrbitId] >= state.disconnectGraceTicks) {
        finalizeSettle(ctx, logger, nk, dispatcher, tick, state, {
          result: 'win',
          winnerOrbitUserId: state.opponentOrbitId,
          reason: 'disconnect_forfeit',
          summary: '对手中途掉线超过 ' + state.disconnectGraceSeconds + ' 秒未重连，自动判负',
        });
        return { state: state };
      }
    } else if (
      creatorOnline &&
      !opponentOnline &&
      state.disconnectedAtTick[state.opponentOrbitId] !== undefined
    ) {
      if (tick - state.disconnectedAtTick[state.opponentOrbitId] >= state.disconnectGraceTicks) {
        finalizeSettle(ctx, logger, nk, dispatcher, tick, state, {
          result: 'win',
          winnerOrbitUserId: state.creatorOrbitId,
          reason: 'disconnect_forfeit',
          summary: '对手中途掉线超过 ' + state.disconnectGraceSeconds + ' 秒未重连，自动判负',
        });
        return { state: state };
      }
    }
  }

  // 4. 空房回收：超过 5 分钟无人在线自动销毁释放内存（资金由 Orbit 定时任务兜底退还）
  var totalOnline = 0;
  for (var k in state.presences) {
    if (Object.prototype.hasOwnProperty.call(state.presences, k)) {
      totalOnline += 1;
    }
  }
  if (totalOnline === 0) {
    state.emptyTicks += 1;
    if (state.emptyTicks >= EMPTY_ROOM_IDLE_TICKS) {
      return null;
    }
  } else {
    state.emptyTicks = 0;
  }

  return { state: state };
}

function matchTerminate(_ctx, _logger, _nk, _dispatcher, _tick, state, _graceSeconds) {
  return { state: state };
}

function matchSignal(_ctx, _logger, _nk, _dispatcher, _tick, state, _data) {
  return { state: state, data: JSON.stringify({ orderId: state.orderId, finalized: state.finalized }) };
}

/** Nakama JS Runtime 标准入口函数。 */
function InitModule(_ctx, logger, _nk, initializer) {
  initializer.registerRpc(RPC_CREATE_WAGER_MATCH, rpcCreateWagerMatch);
  initializer.registerMatch(MODULE_NAME, {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });
  logger.info('Orbit 通用联机赌约房插件已注册: RPC=%s Match=%s', RPC_CREATE_WAGER_MATCH, MODULE_NAME);
}

// 兼容 Bun / Node 本地单元测试导出（Nakama Goja 运行时自动忽略）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    InitModule: InitModule,
    rpcCreateWagerMatch: rpcCreateWagerMatch,
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
    OP_REPORT_RESULT: OP_REPORT_RESULT,
    OP_SURRENDER: OP_SURRENDER,
    OP_WAGER_EVENT: OP_WAGER_EVENT,
    TICK_RATE: TICK_RATE,
  };
}
