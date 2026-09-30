const $ = id => document.getElementById(id);
const state = { user: null, photos: [], sequence: [], index: 0, active: 0, playing: true, sleeping: false, timer: null, weatherTimer: null, weather: null };
const prefs = { interval: Number(localStorage.getItem('dash-interval')) || 30, order: localStorage.getItem('dash-order') || 'shuffle', clockFormat: localStorage.getItem('dash-clock-format') || '12' };
const displayDefaults = { sleepStart: '00:00', clockSize: 'medium', weatherSize: 'medium', infoPosition: 'bottom-left' };
let displaySave = Promise.resolve();
let persistedDisplay = displayDefaults;
let displayVersion = 0;
let folderTargetUserId = null;
let browsedFolder = '';

async function api(route, options = {}) {
  const response = await fetch(route, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  let data;
  try { data = await response.json(); } catch { throw new Error('Server response could not be read'); }
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function setVisible(id, visible) { $(id).hidden = !visible; }
function showLogin() {
  state.user = null;
  displayVersion++;
  state.sleeping = false;
  $('display').classList.remove('sleeping');
  setVisible('sleep-view', false);
  clearInterval(state.timer);
  clearInterval(state.weatherTimer);
  setVisible('display', false);
  setVisible('login', true);
  closePanel();
}
async function showDisplay(user) {
  state.user = user;
  displayVersion++;
  persistedDisplay = { ...displayDefaults, ...user.display };
  state.sleeping = false;
  $('display').classList.remove('sleeping', 'has-photos');
  setVisible('sleep-view', false);
  setVisible('login', false);
  setVisible('display', true);
  $('account-name').textContent = `Signed in as ${user.username}`;
  $('admin-account-section').hidden = user.role !== 'admin';
  $('admin-section').hidden = user.role !== 'admin';
  $('unit').value = user.weather?.unit || 'fahrenheit';
  $('current-location').textContent = user.weather?.label || 'No location set';
  $('interval').value = String(prefs.interval);
  $('order').value = prefs.order;
  $('clock-format').value = prefs.clockFormat;
  applyDisplayPrefs();
  updateClock();
  await Promise.all([loadPhotos(), loadWeather()]);
  clearInterval(state.weatherTimer);
  state.weatherTimer = setInterval(loadWeather, 15 * 60000);
  if (user.role === 'admin') loadUsers();
}
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
function makeSequence() {
  state.sequence = prefs.order === 'shuffle' ? shuffle(state.photos) : [...state.photos];
  state.index = 0;
}
function showPhoto() {
  const photo = state.sequence[state.index];
  if (!photo) return;
  const next = state.active ? $('photo-a') : $('photo-b');
  const previous = state.active ? $('photo-b') : $('photo-a');
  next.onload = () => { next.classList.add('active'); previous.classList.remove('active'); state.active = state.active ? 0 : 1; };
  next.onerror = () => { next.onload = null; next.classList.remove('active'); };
  next.src = photo.url;
  next.alt = photo.name;
  $('photo-count').textContent = `${state.index + 1} / ${state.sequence.length}`;
}
function movePhoto(direction) {
  if (state.sequence.length < 2) return;
  state.index = (state.index + direction + state.sequence.length) % state.sequence.length;
  showPhoto();
  schedule();
}
function schedule() {
  clearInterval(state.timer);
  if (!state.sleeping && state.playing && state.sequence.length > 1) state.timer = setInterval(() => movePhoto(1), prefs.interval * 1000);
}
async function loadPhotos() {
  try {
    const { photos, folder } = await api('/api/photos');
    state.photos = photos;
    makeSequence();
    const hasPhotos = photos.length > 0;
    $('display').classList.toggle('has-photos', hasPhotos);
    setVisible('empty', !hasPhotos);
    $('folder-hint').textContent = `/photos/${folder}`;
    $('library-info').textContent = `${photos.length.toLocaleString()} photo${photos.length === 1 ? '' : 's'} in /photos/${folder}`;
    $('photo-count').textContent = hasPhotos ? `1 / ${photos.length}` : '';
    if (hasPhotos) showPhoto();
    else { $('photo-a').removeAttribute('src'); $('photo-b').removeAttribute('src'); $('photo-a').classList.remove('active'); $('photo-b').classList.remove('active'); }
    schedule();
  } catch (error) { if (error.message === 'Please sign in') showLogin(); else $('library-info').textContent = error.message; }
}
function weatherText(code, isDay) {
  if (code === 0) return isDay ? 'Sunny' : 'Clear night';
  if (code <= 3) return 'Partly cloudy';
  if ([45, 48].includes(code)) return 'Foggy';
  if (code >= 51 && code <= 67) return 'Rainy';
  if (code >= 71 && code <= 77) return 'Snowy';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 95) return 'Thunderstorms';
  return 'Current weather';
}
function weatherIcon(code, isDay) {
  if (code === 0) return isDay ? '☀' : '☾';
  if (code <= 3) return '⛅';
  if (code >= 71 && code <= 77) return '❄';
  if (code >= 95) return '⚡';
  return '☁';
}
async function loadWeather() {
  try {
    state.weather = await api('/api/weather');
    if (!state.weather.configured) { $('temp').textContent = 'Weather off'; $('weather-description').textContent = 'Set your location in settings'; }
    else if (state.weather.unavailable) { $('temp').textContent = 'Weather unavailable'; $('weather-description').textContent = state.weather.label; }
    else { $('temp').textContent = `${weatherIcon(state.weather.code, state.weather.isDay)} ${Math.round(state.weather.temperature)}${state.weather.unit}`; $('weather-description').textContent = `${weatherText(state.weather.code, state.weather.isDay)} in ${state.weather.label}`; }
    updateSleepWeather();
    updateClock();
  } catch { $('temp').textContent = 'Weather unavailable'; $('weather-description').textContent = ''; updateSleepWeather(); }
}
function updateSleepWeather() {
  const description = $('weather-description').textContent;
  $('sleep-weather').textContent = description && !['Set your location in settings', ''].includes(description)
    ? `${$('temp').textContent} · ${description}` : $('temp').textContent;
}
function applyDisplayPrefs() {
  const display = { ...displayDefaults, ...state.user?.display };
  $('sleep-start').value = display.sleepStart;
  $('clock-size').value = display.clockSize;
  $('weather-size').value = display.weatherSize;
  $('info-position').value = display.infoPosition;
  $('display').dataset.clockSize = display.clockSize;
  $('display').dataset.weatherSize = display.weatherSize;
  $('display').dataset.infoPosition = display.infoPosition;
}
function sleepActive(now, timezone, start) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timezone ? { timeZone: timezone } : {}) }).formatToParts(now);
  const value = type => Number(parts.find(part => part.type === type)?.value);
  const minute = value('hour') * 60 + value('minute');
  const [hour, minutes] = start.split(':').map(Number);
  const from = hour * 60 + minutes;
  const until = 6 * 60;
  if (from === until) return false;
  return from < until ? minute >= from && minute < until : minute >= from || minute < until;
}
function updateClock() {
  if (!state.user) return;
  const timezone = state.user.weather?.timezone;
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: prefs.clockFormat === '12', ...(timezone ? { timeZone: timezone } : {}) }).formatToParts(now);
  const value = type => time.find(part => part.type === type)?.value || '';
  $('clock').textContent = `${value('hour')}:${value('minute')}`;
  $('ampm').textContent = prefs.clockFormat === '12' ? value('dayPeriod') : '';
  $('sleep-clock').textContent = $('clock').textContent;
  $('sleep-ampm').textContent = $('ampm').textContent;
  $('date').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...(timezone ? { timeZone: timezone } : {}) }).format(now);
  const sleeping = sleepActive(now, timezone, state.user.display?.sleepStart || displayDefaults.sleepStart);
  if (sleeping !== state.sleeping) {
    state.sleeping = sleeping;
    $('display').classList.toggle('sleeping', sleeping);
    setVisible('sleep-view', sleeping);
    schedule();
  }
}
function openPanel() { $('panel').classList.add('open'); $('panel').setAttribute('aria-hidden', 'false'); setVisible('panel-backdrop', true); }
function closePanel() { $('panel').classList.remove('open'); $('panel').setAttribute('aria-hidden', 'true'); setVisible('panel-backdrop', false); }
function message(id, value, isError = false) { $(id).textContent = value; $(id).style.color = isError ? '#b93c32' : '#3a7550'; }
async function loadFolders(relative) {
  try {
    const data = await api(`/api/folders?path=${encodeURIComponent(relative)}`);
    browsedFolder = data.path;
    $('folder-current').textContent = `/photos${data.path ? `/${data.path}` : ''}`;
    $('folder-up').disabled = data.parent === null;
    $('folder-use').disabled = !data.path;
    $('folder-error').textContent = '';
    const list = $('folder-list'); list.replaceChildren();
    if (!data.folders.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No subfolders here.'; list.append(empty);
    }
    for (const folder of data.folders) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `▱  ${folder.name}`;
      button.addEventListener('click', () => loadFolders(folder.path));
      list.append(button);
    }
  } catch (error) {
    if (relative) {
      await loadFolders('');
      $('folder-error').textContent = 'That folder is not available on the mounted drive. Choose another folder.';
    } else $('folder-error').textContent = error.message;
  }
}
function openFolderPicker(user = null) {
  folderTargetUserId = user?.id || null;
  setVisible('folder-backdrop', true);
  setVisible('folder-dialog', true);
  loadFolders(user?.folder || '');
}
function closeFolderPicker() {
  setVisible('folder-backdrop', false);
  setVisible('folder-dialog', false);
  folderTargetUserId = null;
}
async function loadUsers() {
  try {
    const { users } = await api('/api/users');
    const list = $('users-list'); list.replaceChildren();
    for (const user of users) {
      const row = document.createElement('div'); row.className = 'user-row';
      const info = document.createElement('div'); info.textContent = user.username;
      const folder = document.createElement('small'); folder.textContent = `/photos/${user.folder}`; info.append(folder); row.append(info);
      const actions = document.createElement('div'); actions.className = 'user-actions';
      const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Change folder'; choose.addEventListener('click', () => openFolderPicker(user)); actions.append(choose);
      if (user.role !== 'admin') {
        const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset password';
        const resetForm = document.createElement('form'); resetForm.className = 'reset-form'; resetForm.hidden = true;
        const input = document.createElement('input'); input.type = 'password'; input.minLength = 8; input.maxLength = 128; input.required = true; input.placeholder = 'New password (8+)'; input.autocomplete = 'new-password';
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Save password';
        resetForm.append(input, submit);
        reset.addEventListener('click', () => { resetForm.hidden = !resetForm.hidden; if (!resetForm.hidden) input.focus(); });
        resetForm.addEventListener('submit', async event => {
          event.preventDefault();
          try {
            await api(`/api/users/${user.id}/password`, { method: 'PUT', body: JSON.stringify({ password: input.value }) });
            input.value = ''; resetForm.hidden = true; message('user-message', `Password reset for ${user.username}. Existing sessions were signed out.`);
          } catch (error) { message('user-message', error.message, true); }
        });
        actions.append(reset);
        const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'danger';
        remove.addEventListener('click', async () => {
          if (!confirm(`Remove account ${user.username}? Photos on disk will remain.`)) return;
          try { await api(`/api/users/${user.id}`, { method: 'DELETE' }); await loadUsers(); } catch (error) { message('user-message', error.message, true); }
        }); actions.append(remove);
        row.append(actions, resetForm);
      } else {
        row.append(actions);
      }
      list.append(row);
    }
  } catch (error) { message('user-message', error.message, true); }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button'); button.disabled = true;
  $('login-error').textContent = '';
  try {
    const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset(); await showDisplay(user);
  } catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('settings-open').addEventListener('click', openPanel);
$('sleep-settings').addEventListener('click', openPanel);
$('settings-close').addEventListener('click', closePanel);
$('panel-backdrop').addEventListener('click', closePanel);
$('refresh').addEventListener('click', loadPhotos);
$('empty-refresh').addEventListener('click', loadPhotos);
$('previous').addEventListener('click', () => movePhoto(-1));
$('next').addEventListener('click', () => movePhoto(1));
$('play-pause').addEventListener('click', () => { state.playing = !state.playing; $('play-pause').textContent = state.playing ? 'Ⅱ' : '▶'; $('play-pause').title = state.playing ? 'Pause slideshow' : 'Play slideshow'; $('play-pause').setAttribute('aria-label', $('play-pause').title); schedule(); });
$('fullscreen').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else $('display').requestFullscreen?.(); });
$('interval').addEventListener('change', event => { prefs.interval = Number(event.target.value); localStorage.setItem('dash-interval', prefs.interval); schedule(); });
$('order').addEventListener('change', event => { prefs.order = event.target.value; localStorage.setItem('dash-order', prefs.order); makeSequence(); showPhoto(); schedule(); });
$('clock-format').addEventListener('change', event => { prefs.clockFormat = event.target.value; localStorage.setItem('dash-clock-format', prefs.clockFormat); updateClock(); });
for (const id of ['sleep-start', 'clock-size', 'weather-size', 'info-position']) {
  $(id).addEventListener('change', () => {
    const userId = state.user.id;
    const version = ++displayVersion;
    const display = { sleepStart: $('sleep-start').value, clockSize: $('clock-size').value, weatherSize: $('weather-size').value, infoPosition: $('info-position').value };
    if (!/^\d{2}:\d{2}$/.test(display.sleepStart)) { message('display-message', 'Choose a valid sleep time.', true); return; }
    $('display').dataset.clockSize = display.clockSize;
    $('display').dataset.weatherSize = display.weatherSize;
    $('display').dataset.infoPosition = display.infoPosition;
    state.user.display = display;
    updateClock();
    displaySave = displaySave.catch(() => {}).then(async () => {
      if (state.user?.id !== userId) return;
      try {
        const response = await api('/api/display', { method: 'PUT', body: JSON.stringify({ display }) });
        if (state.user?.id !== userId) return;
        persistedDisplay = response.user.display;
        if (version === displayVersion) state.user.display = response.user.display;
        message('display-message', 'Display settings saved.');
      } catch (error) {
        if (state.user?.id !== userId) return;
        if (version === displayVersion) {
          state.user.display = persistedDisplay;
          applyDisplayPrefs();
          updateClock();
        }
        message('display-message', error.message, true);
      }
    });
  });
}
$('location-form').addEventListener('submit', async event => {
  event.preventDefault();
  const results = $('location-results'); results.replaceChildren(); results.textContent = 'Searching…';
  try {
    const data = await api(`/api/locations?q=${encodeURIComponent($('location-query').value)}`);
    results.replaceChildren();
    if (!data.locations.length) results.textContent = 'No locations found.';
    for (const location of data.locations) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = location.label;
      button.addEventListener('click', async () => {
        try {
          const weather = { ...location, unit: $('unit').value };
          const response = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ weather }) });
          state.user = response.user;
          $('current-location').textContent = weather.label;
          results.replaceChildren();
          await loadWeather();
        } catch (error) { results.textContent = error.message; }
      }); results.append(button);
    }
  } catch (error) { results.textContent = error.message; }
});
$('unit').addEventListener('change', async event => {
  if (!state.user.weather) return;
  try { const response = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ weather: { ...state.user.weather, unit: event.target.value } }) }); state.user = response.user; await loadWeather(); }
  catch (error) { $('current-location').textContent = error.message; }
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/password', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); message('password-message', 'Password updated.'); }
  catch (error) { message('password-message', error.message, true); }
});
$('user-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('new-user-folder').value) { message('user-message', 'Choose a photo folder first.', true); return; }
  try { const data = await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); $('new-user-folder-label').textContent = 'No folder selected'; message('user-message', `Created ${data.user.username} with /photos/${data.user.folder}.`); await loadUsers(); }
  catch (error) { message('user-message', error.message, true); }
});
$('choose-new-user-folder').addEventListener('click', () => openFolderPicker());
$('folder-close').addEventListener('click', closeFolderPicker);
$('folder-backdrop').addEventListener('click', closeFolderPicker);
$('folder-up').addEventListener('click', () => loadFolders(browsedFolder.split('/').slice(0, -1).join('/')));
$('folder-use').addEventListener('click', async () => {
  if (!browsedFolder) return;
  if (folderTargetUserId) {
    try {
      const response = await api(`/api/users/${folderTargetUserId}/folder`, { method: 'PUT', body: JSON.stringify({ folder: browsedFolder }) });
      if (state.user.id === response.user.id) { state.user = response.user; await loadPhotos(); }
      closeFolderPicker(); await loadUsers(); message('user-message', `${response.user.username} now uses /photos/${browsedFolder}.`);
    } catch (error) { $('folder-error').textContent = error.message; }
  } else {
    $('new-user-folder').value = browsedFolder;
    $('new-user-folder-label').textContent = `/photos/${browsedFolder}`;
    closeFolderPicker();
  }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } finally { showLogin(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (!$('folder-dialog').hidden) closeFolderPicker(); else closePanel(); }
  if (!state.user || $('panel').classList.contains('open') || ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (event.key === 'ArrowRight') movePhoto(1);
  if (event.key === 'ArrowLeft') movePhoto(-1);
  if (event.key === ' ') { event.preventDefault(); $('play-pause').click(); }
});
setInterval(updateClock, 1000);
api('/api/me').then(data => showDisplay(data.user)).catch(showLogin);
