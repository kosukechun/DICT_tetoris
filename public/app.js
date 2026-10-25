import { fits, GARBAGE_FALL_MS, CLEAR_FEEDBACK_MS, WIDTH, HEIGHT } from '/shared/engine.js';
const $ = (id) => document.getElementById(id);
const views = ['home', 'game', 'history', 'guide', 'tournament'];
const colors = [
  '#000000',
  '#00a9bd',
  '#e6a51d',
  '#7156d9',
  '#dc3f78',
  '#28a96d',
  '#397bd1',
  '#dc6d24',
  '#66758a'
];
let user = null,
  socket = null,
  connecting = null,
  active = null;
let queued = false,
  history = [],
  pendingIntent = null,
  resultId = null,
  cheatEnabled = false;
let room = null,
  adminAuthorized = false,
  adminCheatEnabled = false,
  playAvailability = null,
  cheatKind = 'normal';
let toastTimer, countdownTimer;
const held = new Map();

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 6000);
}
function showView(name) {
  for (const view of views) $(view + '-view').hidden = view !== name;
  document.body.classList.toggle('game-mode', name === 'game');
  if (name === 'game') requestAnimationFrame(fitBoards);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function navigate(name) {
  if (active && name !== 'game') {
    $('confirm-dialog').showModal();
    return;
  }
  if (queued) return;
  if (room) {
    showView('tournament');
    return;
  }
  if (name === 'history') loadHistory();
  else showView(name);
}
window.addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  navigate(views.includes(route) ? route : 'home');
});
document.querySelectorAll('.back-home').forEach((button) =>
  button.addEventListener('click', () => {
    location.hash = 'home';
    showView(room ? 'tournament' : 'home');
  })
);
async function api(path, data) {
  const response = await fetch('/api/' + path, {
    ...(data
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        }
      : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '通信に失敗しました。');
  return result;
}
function updateAccount() {
  $('player-label').textContent = user ? user.nickname : 'GUEST PLAYER';
  $('account-button').textContent = user ? '名前を変更' : '名前を登録';
  adminAuthorized = user?.nickname === 'chun';
  updateAdmin();
}
function updateCheatButton() {
  for (const [id, enabled] of [
    ['cheat-button', cheatEnabled],
    ['admin-cheat-button', adminCheatEnabled]
  ]) {
    const button = $(id);
    button.classList.toggle('is-active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('b').textContent = enabled ? 'ON' : 'OFF';
  }
}
function openCheat(kind = 'normal') {
  cheatKind = kind;
  $('cheat-error').textContent = '';
  $('cheat-form').reset();
  $('cheat-dialog').querySelector('h2').textContent =
    kind === 'admin' ? 'adminチートをONにする' : 'チートモードをONにする';
  $('cheat-dialog').querySelector('p.subtle').textContent =
    kind === 'admin'
      ? '5秒ごとに自分の盤面を最大3個消し、相手へお邪魔を2個送ります。通常チートとの併用でも攻撃は2個です。'
      : '対戦中、5秒ごとに相手へお邪魔ブロックを2個送ります。';
  $('cheat-dialog').showModal();
  $('cheat-form').elements.password.focus();
}
function openAuth() {
  $('auth-error').textContent = '';
  $('auth-dialog').showModal();
}
$('account-button').addEventListener('click', async () => {
  if (active || queued || room) {
    toast('対戦・待機を終了してから名前を変更してください。');
    return;
  }
  $('auth-form').elements.nickname.value = user?.nickname || '';
  openAuth();
});
$('auth-close').addEventListener('click', () => {
  pendingIntent = null;
  $('auth-dialog').close();
});
$('auth-dialog').addEventListener('cancel', () => {
  pendingIntent = null;
});
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('auth-error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    user = (await api('register', data)).user;
    $('auth-dialog').close();
    $('auth-form').reset();
    updateAccount();
    const intent = pendingIntent;
    pendingIntent = null;
    if (intent === 'history') await loadHistory();
    else if (intent === 'cheat') openCheat();
    else if (intent === 'admin-cheat') openCheat('admin');
    else if (intent === 'tournament') openTournament();
    else if (intent === 'admin') openAdmin();
    else if (intent) await startBattle(intent);
  } catch (error) {
    $('auth-error').textContent = error.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
    );
    socket = ws;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('接続がタイムアウトしました。'));
    }, 10000);
    let ready = false;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        updateAvailability(message.availability);
        if (message.adminAuthorized !== undefined) {
          adminAuthorized = message.adminAuthorized;
          updateAdmin(message.availability);
        }
        resolve();
      } else handleMessage(message);
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      if (socket === ws) socket = null;
      cheatEnabled = false;
      adminCheatEnabled = false;
      updateAdmin();
      updateCheatButton();
      if (!ready)
        reject(
          new Error('接続できません。同じブラウザーの別タブを閉じて、もう一度お試しください。')
        );
      if (active || queued || room) {
        clearInterval(countdownTimer);
        $('countdown').textContent = '';
        clearHeld();
        active = null;
        room = null;
        queued = false;
        $('queue-dialog').close();
        $('confirm-dialog').close();
        showView('home');
        toast('接続が切れました。試合中の場合は切断による敗北となります。履歴を確認してください。');
      }
    });
    ws.addEventListener('error', () => {
      /* close reports the actionable error */
    });
  }).finally(() => {
    connecting = null;
  });
  return connecting;
}
async function startBattle(mode) {
  if (!user) {
    pendingIntent = mode;
    openAuth();
    return;
  }
  if (active || queued || room) return;
  $('cpu-button').disabled = $('online-button').disabled = true;
  try {
    await connect();
    send({
      type: 'join',
      mode,
      difficulty: document.querySelector('[name=difficulty]:checked').value
    });
  } catch (error) {
    toast(error.message);
  } finally {
    $('cpu-button').disabled = $('online-button').disabled = false;
    updateAvailability(playAvailability);
  }
}
$('online-button').addEventListener('click', () => startBattle('online'));
$('cpu-button').addEventListener('click', () => startBattle('cpu'));
for (const [id, kind] of [
  ['cheat-button', 'normal'],
  ['admin-cheat-button', 'admin']
])
  $(id).addEventListener('click', () => {
    if (active || queued || room) {
      toast('対戦・待機を終了してからチートモードを切り替えてください。');
      return;
    }
    if (!user) {
      pendingIntent = kind === 'admin' ? 'admin-cheat' : 'cheat';
      openAuth();
      return;
    }
    if (kind === 'admin' ? adminCheatEnabled : cheatEnabled) {
      send({ type: kind === 'admin' ? 'admin_cheat' : 'cheat', enabled: false });
      return;
    }
    openCheat(kind);
  });
$('cheat-close').addEventListener('click', () => $('cheat-dialog').close());
$('cheat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = event.currentTarget.elements.password.value;
  $('cheat-submit').disabled = true;
  $('cheat-error').textContent = '';
  try {
    await connect();
    send({ type: cheatKind === 'admin' ? 'admin_cheat' : 'cheat', enabled: true, password });
  } catch (error) {
    $('cheat-error').textContent = error.message;
  } finally {
    $('cheat-submit').disabled = false;
  }
});
$('queue-cancel').addEventListener('click', () => send({ type: 'cancel' }));
$('queue-cpu').addEventListener('click', () => {
  send({ type: 'cancel' });
  send({
    type: 'join',
    mode: 'cpu',
    difficulty: document.querySelector('[name=difficulty]:checked').value
  });
});
$('queue-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  send({ type: 'cancel' });
});
function handleMessage(message) {
  if (message.type === 'availability') {
    updateAvailability(message.availability);
  } else if (message.type === 'admin') {
    adminAuthorized = Boolean(message.authorized);
    updateAdmin(message.availability);
    $('admin-error').textContent = message.message || '';
    if (message.saved) toast('ゲーム禁止時間帯を保存しました。');
    if (message.stopped !== undefined)
      toast(
        message.stopped
          ? 'ゲーム全体を停止しました。'
          : '即時停止を解除しました。時間帯の制限は引き続き適用されます。'
      );
  } else if (message.type === 'tournament') {
    room = message.room;
    $('tournament-dialog').close();
    renderRoom();
    if (!active && !$('result-dialog').open) showView('tournament');
  } else if (message.type === 'tournament_left') {
    room = null;
    $('result-room').hidden = true;
    if (!active) showView('home');
  } else if (message.type === 'queued') {
    queued = true;
    if (!$('queue-dialog').open) $('queue-dialog').showModal();
  } else if (message.type === 'canceled') {
    queued = false;
    $('queue-dialog').close();
  } else if (message.type === 'cheat' || message.type === 'admin_cheat') {
    const admin = message.type === 'admin_cheat';
    if (admin) adminCheatEnabled = message.enabled;
    else cheatEnabled = message.enabled;
    updateCheatButton();
    if (message.message) {
      $('cheat-error').textContent = message.message;
      toast(message.message);
    } else if (message.enabled) {
      $('cheat-dialog').close();
      $('cheat-form').reset();
      toast((admin ? 'adminチート' : 'チートモード') + 'をONにしました。');
    } else toast((admin ? 'adminチート' : 'チートモード') + 'をOFFにしました。');
  } else if (message.type === 'start') {
    active = message;
    cheatEnabled = Boolean(message.cheatEnabled);
    adminCheatEnabled = Boolean(message.adminCheatEnabled);
    updateCheatButton();
    resetFeedback();
    queued = false;
    $('queue-dialog').close();
    $('result-dialog').close();
    $('confirm-dialog').close();
    $('tournament-dialog').close();
    $('admin-dialog').close();
    showView('game');
    $('self-name').textContent = message.players[message.seat].nickname;
    $('rival-name').textContent = message.players[1 - message.seat].nickname;
    $('battle-title').textContent = message.tournament
      ? 'TOURNAMENT / ' + message.tournament.code
      : message.difficulty
        ? 'CPU CHALLENGE / ' + message.difficulty.toUpperCase()
        : 'ONLINE COLOR BATTLE';
    clearInterval(countdownTimer);
    const startsAt = performance.now() + message.startsAt - message.serverNow;
    const countdown = () => {
      const remaining = Math.ceil((startsAt - performance.now()) / 1000);
      $('countdown').textContent = remaining > 0 ? remaining : '';
      if (remaining <= 0) clearInterval(countdownTimer);
    };
    countdown();
    countdownTimer = setInterval(countdown, 100);
  } else if (message.type === 'state' && active) {
    renderPlayer('self', message.states[active.seat]);
    renderPlayer('rival', message.states[1 - active.seat]);
    const seconds = Math.floor(message.elapsed / 1000);
    $('timer').textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  } else if (message.type === 'result' && active) {
    const seat = active.seat;
    resultId = message.id;
    active = null;
    clearHeld();
    clearInterval(countdownTimer);
    $('countdown').textContent = '';
    $('confirm-dialog').close();
    $('admin-dialog').close();
    const draw = message.winner === null;
    $('result-title').textContent = draw
      ? 'DRAW'
      : message.winner === seat
        ? 'YOU WIN!'
        : 'NEXT CHALLENGE!';
    const reasons = {
      disconnect: '接続切れ',
      forfeit: '途中終了',
      topout: 'ブロックが上まで到達',
      time: '5分経過',
      restricted: 'ゲーム禁止時間帯のため終了',
      admin_stop: '管理者によるゲーム停止',
      server_shutdown: 'サーバー再起動'
    };
    $('result-detail').textContent =
      message.reason === 'time'
        ? `${reasons.time} / 盤面ブロック あなた ${message.blockCounts[seat]}個 : 相手 ${message.blockCounts[1 - seat]}個（少ない方が勝利）`
        : `${reasons[message.reason]} / あなた ${message.scores[seat].toLocaleString()} : 相手 ${message.scores[1 - seat].toLocaleString()}`;
    $('save-status').textContent = '対戦ログを保存しています…';
    $('result-room').hidden = !room;
    $('result-dialog').showModal();
  } else if (message.type === 'saved' && message.id === resultId) {
    $('save-status').textContent = '対戦ログを保存しました。';
    if (!$('history-view').hidden) loadHistory();
  } else if (message.type === 'error') {
    toast(message.message);
    if ($('admin-dialog').open) $('admin-error').textContent = message.message;
    if ($('tournament-dialog').open) $('room-error').textContent = message.message;
    if ($('result-dialog').open) $('save-status').textContent = message.message;
  }
}
function updateAvailability(availability) {
  if (!availability) return;
  playAvailability = availability;
  const notice = $('availability-notice');
  notice.hidden = !availability.blocked;
  notice.textContent = availability.paused
    ? '管理者がゲーム全体を停止しています。再開をお待ちください。'
    : `現在はゲーム禁止時間帯です（毎日 ${availability.start}〜${availability.end}・日本時間）。`;
  if (adminAuthorized) updateAdmin();
  for (const id of ['cpu-button', 'online-button', 'tournament-button'])
    $(id).disabled = availability.blocked;
}
async function refreshAvailability() {
  if (document.hidden || socket?.readyState === WebSocket.OPEN) return;
  try {
    updateAvailability(await api('availability'));
  } catch {
    /* next poll retries */
  }
}
setInterval(refreshAvailability, 15000);
document.addEventListener('visibilitychange', refreshAvailability);
function updateAdmin(availability) {
  $('admin-button').hidden = !adminAuthorized;
  $('admin-name-notice').hidden = adminAuthorized;
  $('admin-controls').hidden = !adminAuthorized;
  if (!adminAuthorized) $('admin-dialog').close();
  const status = availability || playAvailability;
  $('admin-play-status').textContent = status?.paused
    ? '状態：管理者が停止中'
    : status?.blocked
      ? '状態：ゲーム禁止時間帯'
      : '状態：プレイ可能';
  $('admin-stop-button').disabled = Boolean(status?.paused);
  $('admin-resume-button').disabled = !status?.paused;
  if (availability) {
    const form = $('admin-schedule-form');
    form.elements.enabled.checked = availability.enabled;
    form.elements.start.value = availability.start;
    form.elements.end.value = availability.end;
  }
}
function requireRegistration(intent) {
  if (user) return false;
  pendingIntent = intent;
  openAuth();
  return true;
}
async function openAdmin() {
  if (!adminAuthorized) return;
  $('admin-error').textContent = '';
  $('admin-dialog').showModal();
  try {
    await connect();
    updateAdmin(playAvailability);
  } catch (error) {
    $('admin-error').textContent = error.message;
  }
}
$('admin-button').addEventListener('click', openAdmin);
$('admin-close').addEventListener('click', () => $('admin-dialog').close());
for (const [id, paused] of [
  ['admin-stop-button', true],
  ['admin-resume-button', false]
])
  $(id).addEventListener('click', async () => {
    try {
      await connect();
      send({ type: 'admin_pause', paused });
    } catch (error) {
      $('admin-error').textContent = error.message;
    }
  });
$('admin-schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('admin-error').textContent = '';
  const schedule = {
    enabled: form.elements.enabled.checked,
    start: form.elements.start.value,
    end: form.elements.end.value
  };
  try {
    await connect();
    send({ type: 'admin_schedule', schedule });
  } catch (error) {
    $('admin-error').textContent = error.message;
  }
});
function openTournament() {
  if (active || queued) return;
  if (room) {
    showView('tournament');
    return;
  }
  if (requireRegistration('tournament')) return;
  $('room-error').textContent = '';
  $('tournament-dialog').showModal();
}
$('tournament-button').addEventListener('click', openTournament);
$('tournament-close').addEventListener('click', () => $('tournament-dialog').close());
for (const operation of ['create', 'join']) {
  $(`room-${operation}-form`).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data =
      operation === 'create'
        ? { capacity: Number(form.elements.capacity.value) }
        : { code: form.elements.code.value.trim().toUpperCase() };
    try {
      await connect();
      send({ type: 'tournament', operation, ...data });
    } catch (error) {
      $('room-error').textContent = error.message;
    }
  });
}
for (const operation of ['leave', 'start', 'ready'])
  $(`room-${operation}`).addEventListener('click', () => send({ type: 'tournament', operation }));
function renderRoom() {
  if (!room) return;
  $('room-code').textContent = room.code;
  $('room-status').textContent =
    room.status === 'lobby'
      ? `${room.members.length} / ${room.capacity}人が参加中`
      : room.status === 'finished'
        ? `優勝：${room.champion.nickname}`
        : room.status === 'canceled'
          ? '大会は中止されました。部屋を退出してください。'
          : '大会進行中 / 次の対戦者は準備完了を押してください。引き分けは再試合です。';
  $('room-members').replaceChildren(
    ...room.members.map((member) => {
      const item = document.createElement('li');
      item.textContent =
        member.nickname +
        (member.username === room.host ? '（主催者）' : '') +
        (!member.connected ? '（退出）' : '');
      return item;
    })
  );
  $('room-start').hidden = room.status !== 'lobby' || room.host !== user.username;
  $('room-start').disabled = room.members.length !== room.capacity;
  $('room-ready').hidden = !room.canReady;
  $('room-ready').disabled = room.ready.includes(user.username);
  $('room-ready').textContent = room.ready.includes(user.username)
    ? '相手の準備完了を待っています…'
    : '次の試合の準備完了 →';
  $('room-bracket').replaceChildren(
    ...room.rounds.map((round, index) => {
      const section = document.createElement('section');
      section.className = 'bracket-round';
      const heading = document.createElement('h2');
      heading.textContent = round.length === 1 ? '決勝' : `${index + 1}回戦`;
      section.append(heading);
      for (const entry of round) {
        const card = document.createElement('article');
        card.className = 'bracket-match';
        for (const player of entry.players) {
          const line = document.createElement('p');
          line.textContent = player ? player.nickname : 'シード枠';
          if (player && entry.winner?.username === player.username) line.className = 'winner';
          card.append(line);
        }
        const status = document.createElement('small');
        status.textContent =
          entry.reason === 'bye'
            ? 'シードで進出'
            : entry.reason === 'draw'
              ? '引き分け・再試合の準備待ち'
              : entry.status === 'done'
                ? '試合終了'
                : entry.status === 'playing'
                  ? '対戦中'
                  : '準備完了待ち';
        card.append(status);
        section.append(card);
      }
      return section;
    })
  );
}
function drawCell(ctx, x, y, size, value, ghost = false) {
  ctx.fillStyle = colors[value];
  if (ghost) {
    ctx.globalAlpha = 0.27;
    ctx.strokeStyle = colors[value];
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
    ctx.globalAlpha = 1;
    return;
  }
  const glass = ctx.createLinearGradient(x, y, x + size, y + size);
  glass.addColorStop(0, colors[value]);
  glass.addColorStop(1, colors[value]);
  ctx.fillStyle = glass;
  ctx.fillRect(x + 0.35, y + 0.35, size - 0.7, size - 0.7);
  ctx.strokeStyle = '#ffffffcc';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(x + 1.05, y + 1.05, size - 2.1, size - 2.1);
  ctx.fillStyle = '#ffffff55';
  ctx.fillRect(x + 3, y + 3, size - 6, 4);
  ctx.fillStyle = '#00000018';
  ctx.fillRect(x + 3, y + size - 7, size - 6, 4);
  if (value !== 8) {
    ctx.fillStyle = '#ffffffee';
    ctx.font = `bold ${size * 0.38}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(['', '●', '◆', '＋', '■', '◊', '○', '△'][value], x + size / 2, y + size * 0.65);
  }
}
const playerStates = new Map();
function fitBoards() {
  const desktop = matchMedia('(min-width: 901px)').matches;
  for (const area of document.querySelectorAll('.board-and-side')) {
    const wrap = area.querySelector('.board-wrap');
    if (desktop && !$('game-view').hidden) {
      const width = Math.max(
        1,
        Math.floor(Math.min(600, area.clientHeight / (HEIGHT / WIDTH), area.clientWidth - 156))
      );
      wrap.style.width = `${width}px`;
    } else wrap.style.removeProperty('width');
  }
}
const boardObserver = new ResizeObserver(fitBoards);
document.querySelectorAll('.board-and-side').forEach((area) => boardObserver.observe(area));
window.addEventListener('resize', fitBoards);
const feedbackStates = new Map();
const clearEffects = new Map();
function resetFeedback() {
  playerStates.clear();
  clearEffects.clear();
  for (const feedback of feedbackStates.values()) clearTimeout(feedback.timer);
  feedbackStates.clear();
  for (const prefix of ['self', 'rival']) {
    $(prefix + '-cancel').hidden = true;
    $(prefix + '-pending')
      .closest('.stat')
      .classList.remove('is-canceling');
  }
}
function showCancellation(prefix, cancellation) {
  if (!cancellation || feedbackStates.get(prefix)?.id === cancellation.id) return;
  clearTimeout(feedbackStates.get(prefix)?.timer);
  const notice = $(prefix + '-cancel');
  notice.querySelector('b').textContent = `${cancellation.count}個 打ち消した！`;
  notice.querySelector('small').textContent =
    `予告 ${cancellation.before}個 → 残り ${cancellation.remaining}個` +
    (cancellation.sent ? ` ／ 相手へ ${cancellation.sent}個` : '');
  notice.hidden = false;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    notice.animate(
      [
        { opacity: 0, transform: 'scale(0.8)' },
        { opacity: 1, transform: 'scale(1)' }
      ],
      { duration: 100, easing: 'ease-out' }
    );
  }
  const meter = $(prefix + '-pending').closest('.stat');
  meter.classList.add('is-canceling');
  const timer = setTimeout(() => {
    notice.hidden = true;
    meter.classList.remove('is-canceling');
  }, 250);
  feedbackStates.set(prefix, { id: cancellation.id, timer });
}
function renderPlayer(prefix, state) {
  if (state.clearEffect && clearEffects.get(prefix)?.id !== state.clearEffect.id)
    clearEffects.set(prefix, { ...state.clearEffect, startedAt: performance.now() });
  playerStates.set(prefix, { state, receivedAt: performance.now() });
  paintBoard(prefix, state);
  updateStats(prefix, state);
}
function paintBoard(prefix, state, extraMs = 0) {
  const canvas = $(prefix + '-board'),
    ctx = canvas.getContext('2d'),
    size = canvas.width / WIDTH;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1b2a3a66';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= WIDTH; x++) {
    ctx.beginPath();
    ctx.moveTo(x * size, 0);
    ctx.lineTo(x * size, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= HEIGHT; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * size);
    ctx.lineTo(canvas.width, y * size);
    ctx.stroke();
  }
  state.board.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell) drawCell(ctx, x * size, y * size, size, cell);
    })
  );
  let ghostY = state.y;
  while (state.matrix.length && fits(state.board, state.matrix, state.x, ghostY + 1)) ghostY++;
  state.matrix.forEach((row, dy) =>
    row.forEach((cell, dx) => {
      if (cell) {
        drawCell(ctx, (state.x + dx) * size, (ghostY + dy) * size, size, cell, true);
        drawCell(ctx, (state.x + dx) * size, (state.y + dy) * size, size, cell);
      }
    })
  );
  if (state.fallingGarbage) {
    const block = state.fallingGarbage;
    const t = Math.min(1, (block.elapsed + extraMs) / GARBAGE_FALL_MS);
    const y = -1 + (block.targetY + 1) * t * t;
    drawCell(ctx, block.x * size, y * size, size, 8);
  }
  const effect = clearEffects.get(prefix);
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 60 : CLEAR_FEEDBACK_MS;
  const progress = effect ? (performance.now() - effect.startedAt) / duration : 1;
  if (progress < 1) {
    ctx.save();
    const fade = 1 - progress;
    for (const [x, y, color] of effect.cells) {
      const inset = 3 + progress * size * 0.16;
      ctx.globalAlpha = fade * 0.78;
      ctx.fillStyle = colors[color];
      ctx.fillRect(x * size + inset, y * size + inset, size - inset * 2, size - inset * 2);
      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x * size + inset, y * size + inset, size - inset * 2, size - inset * 2);
      ctx.globalAlpha = fade * 0.4;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x * size + inset, y * size + inset, size - inset * 2, (size - inset * 2) * 0.3);
    }
    ctx.restore();
  }
}
function updateStats(prefix, state) {
  const nextCanvas = $(prefix + '-next');
  const nextCtx = nextCanvas.getContext('2d');
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  state.next.forEach((matrix, i) =>
    matrix.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (cell)
          drawCell(
            nextCtx,
            (nextCanvas.width - matrix[0].length * 28) / 2 + x * 28,
            i * 86 + y * 28 + 10,
            28,
            cell
          );
      })
    )
  );
  $(prefix + '-score').textContent = state.score.toLocaleString();
  $(prefix + '-lines').textContent = state.lines;
  $(prefix + '-pending').textContent = state.pending;
  const dots = $(prefix + '-garbage');
  if (dots.dataset.count !== String(state.pending)) {
    dots.dataset.count = state.pending;
    dots.replaceChildren(
      ...Array.from({ length: state.pending }, () => document.createElement('i'))
    );
  }
  showCancellation(prefix, state.cancellation);
  $(prefix + '-combo').textContent = state.canceled
    ? `相殺！ お邪魔 ${state.canceled} 個を打ち消した`
    : state.garbageActive
      ? 'お邪魔が1個ずつ落下中…'
      : state.lastChains >= 2
        ? `${state.lastChains} CHAIN · ${state.lastClear} BLOCKS CLEARED`
        : state.combo >= 1
          ? `${state.combo} COMBO · ${state.lastClear} BLOCKS CLEARED`
          : state.lastClear
            ? `${state.lastClear} BLOCKS CLEARED!`
            : state.pending
              ? `お邪魔 ${state.pending} 個が接近中`
              : '同じ色を4つつなげよう';
  if (prefix === 'self') {
    $('shield-button').disabled = !state.shield;
    $('shield-button').textContent = state.shieldMs
      ? `SHIELD ${Math.ceil(state.shieldMs / 1000)}s`
      : state.shield
        ? 'F9 SHIELD [F]'
        : 'SHIELD USED';
  }
}
function animateBoards(now) {
  if (active) {
    for (const [prefix, { state, receivedAt }] of playerStates) {
      const effect = clearEffects.get(prefix);
      // Repaint once more after the fade expires to remove its last frame.
      if (state.fallingGarbage || (effect && !effect.painted)) {
        paintBoard(prefix, state, now - receivedAt);
        if (effect && now - effect.startedAt >= CLEAR_FEEDBACK_MS) effect.painted = true;
      }
    }
  }
  requestAnimationFrame(animateBoards);
}
requestAnimationFrame(animateBoards);
const keyActions = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'rotate',
  ArrowDown: 'down',
  Space: 'drop',
  KeyF: 'shield'
};
function action(action) {
  if (active) send({ type: 'action', action });
}
function clearHeld() {
  held.clear();
}
document.addEventListener('keydown', (event) => {
  if (!active || document.querySelector('dialog[open]') || event.target.matches('input,textarea'))
    return;
  const command = keyActions[event.code];
  if (!command) return;
  event.preventDefault();
  if (event.repeat || held.has(event.code)) return;
  action(command);
  if (['left', 'right', 'down'].includes(command))
    held.set(event.code, {
      command,
      next: performance.now() + (command === 'down' ? 80 : 160)
    });
});
document.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', clearHeld);
document.addEventListener('visibilitychange', clearHeld);
setInterval(() => {
  for (const value of held.values())
    if (performance.now() >= value.next) {
      action(value.command);
      value.next = performance.now() + (value.command === 'down' ? 60 : 80);
    }
}, 20);
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    const command = button.dataset.action;
    action(command);
    if (['left', 'right', 'down'].includes(command))
      held.set('touch', {
        command,
        next: performance.now() + (command === 'down' ? 80 : 160)
      });
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    button.addEventListener(event, () => held.delete('touch'));
});
$('shield-button').addEventListener('click', () => action('shield'));
$('forfeit-button').addEventListener('click', () => {
  clearHeld();
  $('confirm-dialog').showModal();
});
$('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-forfeit').addEventListener('click', () => {
  action('forfeit');
  $('confirm-dialog').close();
});
$('result-home').addEventListener('click', () => {
  $('result-dialog').close();
  showView(room ? 'tournament' : 'home');
});
$('result-history').addEventListener('click', () => {
  $('result-dialog').close();
  loadHistory();
});
$('result-dialog').addEventListener('cancel', () => showView(room ? 'tournament' : 'home'));
$('result-room').addEventListener('click', () => {
  $('result-dialog').close();
  showView(room ? 'tournament' : 'home');
});
$('history-nav').addEventListener('click', () => navigate('history'));
async function loadHistory() {
  if (!user) {
    pendingIntent = 'history';
    openAuth();
    return;
  }
  showView('history');
  $('history-list').textContent = '読み込み中…';
  $('opponent-stats-list').textContent = '集計中…';
  $('export-button').disabled = true;
  try {
    const data = await api('history');
    history = data.matches;
    renderOpponentStats(data.opponentStats || []);
    $('history-list').replaceChildren();
    if (!history.length) {
      const p = document.createElement('p');
      p.className = 'history-empty';
      p.textContent = 'まだ対戦履歴がありません。最初のバトルに挑戦しよう。';
      $('history-list').append(p);
    }
    for (const match of history) {
      const seat = match.players.findIndex((player) => player.username === user.username),
        row = document.createElement('article');
      row.className = 'history-row';
      const result = document.createElement('strong');
      result.textContent = match.winner === null ? 'DRAW' : match.winner === seat ? 'WIN' : 'LOSE';
      const details = document.createElement('div');
      details.textContent = 'vs ' + match.players[1 - seat].nickname;
      const date = document.createElement('small');
      date.textContent =
        new Date(match.startedAt).toLocaleString('ja-JP') +
        ' / ' +
        (match.tournament
          ? '大会 ' + match.tournament.code
          : match.difficulty
            ? 'CPU ' + match.difficulty
            : 'オンライン');
      details.append(date);
      const score = document.createElement('b');
      score.textContent =
        match.reason === 'time' && match.blockCounts
          ? `${match.blockCounts[seat]}個`
          : match.scores[seat].toLocaleString();
      score.title = match.reason === 'time' ? '終了時の盤面ブロック数' : 'スコア';
      row.append(result, details, score);
      $('history-list').append(row);
    }
    $('export-button').disabled = !history.length;
  } catch (error) {
    $('history-list').textContent = error.message;
    $('opponent-stats-list').textContent = '戦績を読み込めませんでした。';
  }
}
function formatPlayTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${hours}時間` : '',
    minutes ? `${minutes}分` : '',
    seconds || (!hours && !minutes) ? `${seconds}秒` : ''
  ]
    .filter(Boolean)
    .join('');
}
function formatJapaneseWinRate(rate) {
  const percent = Math.round(Math.max(0, Math.min(1, rate)) * 100);
  const wari = Math.floor(percent / 10),
    bu = percent % 10;
  return `${wari}割${bu ? `${bu}分` : ''}`;
}
function renderOpponentStats(stats) {
  const list = $('opponent-stats-list');
  list.replaceChildren();
  if (!stats.length) {
    const empty = document.createElement('p');
    empty.className = 'opponent-stats-empty';
    empty.textContent = 'オンライン対戦をすると、相手ごとの勝率やプレイ時間が表示されます。';
    list.append(empty);
    return;
  }
  for (const statsForOpponent of stats) {
    const card = document.createElement('article');
    card.className = 'opponent-card';
    const heading = document.createElement('div');
    heading.className = 'opponent-card-heading';
    const name = document.createElement('h3');
    name.textContent = `vs ${statsForOpponent.opponent.nickname}`;
    const rate = document.createElement('strong');
    rate.textContent = `勝率 ${formatJapaneseWinRate(statsForOpponent.winRate)}`;
    rate.title = `${(statsForOpponent.winRate * 100).toFixed(1)}%`;
    heading.append(name, rate);

    const meter = document.createElement('div');
    meter.className = 'win-rate-meter';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', `${statsForOpponent.opponent.nickname}との勝率`);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(Math.round(statsForOpponent.winRate * 100)));
    const fill = document.createElement('i');
    fill.style.width = `${statsForOpponent.winRate * 100}%`;
    meter.append(fill);

    const facts = document.createElement('dl');
    for (const [label, value] of [
      ['プレイ回数', `${statsForOpponent.games}回`],
      [
        '戦績',
        `${statsForOpponent.wins}勝 ${statsForOpponent.losses}敗 ${statsForOpponent.draws}分`
      ],
      ['ゲーム時間', `合計 ${formatPlayTime(statsForOpponent.totalDuration)}`],
      ['平均時間', formatPlayTime(statsForOpponent.averageDuration)]
    ]) {
      const term = document.createElement('dt'),
        description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      facts.append(term, description);
    }
    card.append(heading, meter, facts);
    list.append(card);
  }
}
$('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dict-f9-battle-log.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('beforeunload', (event) => {
  if (active || room) {
    event.preventDefault();
    event.returnValue = '';
  }
});
try {
  const account = await api('me');
  user = account.user;
  updateAvailability(account.availability);
  updateAccount();
} catch {
  toast('サーバーに接続できません。ページを再読み込みしてください。');
}
const initial = location.hash.slice(1);
if (['guide', 'history'].includes(initial)) navigate(initial);
