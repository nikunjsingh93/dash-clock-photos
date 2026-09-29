import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const photoRoot = path.resolve(process.env.PHOTO_ROOT || path.join(here, 'photos'));
const stateDir = path.resolve(process.env.STATE_DIR || path.join(here, 'state'));
const port = Number(process.env.PORT || 3080);
const photoTypes = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.gif', 'image/gif']]);
const staticTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const failures = new Map();
const weatherCache = new Map();

function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function send(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON required');
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 16384) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => {
      try {
        const body = JSON.parse(data);
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON object required');
        resolve(body);
      } catch (error) { reject(Object.assign(new Error(error.status ? error.message : 'Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function atomicWrite(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, user) {
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function validUsername(name) { return typeof name === 'string' && /^[a-z][a-z0-9_-]{2,31}$/.test(name); }
function validPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 128; }
function save() { atomicWrite(path.join(stateDir, 'users.json'), JSON.stringify(db, null, 2)); }

if (!fs.existsSync(path.join(photoRoot, '.dash-clock-photos'))) {
  throw new Error(`Photo mount is missing its .dash-clock-photos marker: ${photoRoot}`);
}
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, 'users.json');
const secretFile = path.join(stateDir, 'session.key');
if (!fs.existsSync(secretFile)) atomicWrite(secretFile, crypto.randomBytes(32).toString('hex'));
const secret = fs.readFileSync(secretFile, 'utf8').trim();
let db;
if (fs.existsSync(stateFile)) db = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
else {
  const name = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!validUsername(name) || !validPassword(password)) throw new Error('First start requires ADMIN_USERNAME and an ADMIN_PASSWORD of at least 8 characters');
  db = { users: [{ id: crypto.randomUUID(), username: name, folder: name, role: 'admin', sessionVersion: 1, weather: null, ...passwordHash(password) }] };
  save();
}

function cookieToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, version: user.sessionVersion, expires: Date.now() + 30 * 86400000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function sessionUser(req) {
  const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('dash_session='))?.slice(13);
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.expires <= Date.now()) return null;
    return db.users.find(u => u.id === data.id && u.sessionVersion === data.version) || null;
  } catch { return null; }
}
function requireUser(req) { return sessionUser(req) || fail(401, 'Please sign in'); }
function requireAdmin(user) { if (user.role !== 'admin') fail(403, 'Administrator access required'); }
function safeUser(user) { return { id: user.id, username: user.username, folder: user.folder, role: user.role, weather: user.weather }; }
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) fail(403, 'Invalid request origin'); }
    catch { fail(403, 'Invalid request origin'); }
  }
}
function resolveFolder(relative, allowRoot = false) {
  if (relative === '' && allowRoot) return photoRoot;
  if (typeof relative !== 'string' || !relative || relative.length > 512) return null;
  const pieces = relative.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.startsWith('.') || piece.includes('\\') || piece.includes('\0'))) return null;
  let folder = photoRoot;
  for (const piece of pieces) {
    folder = path.join(folder, piece);
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch { return null; }
  }
  return folder;
}
function getFolder(user) {
  return resolveFolder(user.folder);
}
function folderIsAvailable(relative, exceptId = null) {
  return !db.users.some(user => user.id !== exceptId && (user.folder === relative || user.folder.startsWith(`${relative}/`) || relative.startsWith(`${user.folder}/`)));
}
function photosFor(user) {
  const folder = getFolder(user);
  if (!folder) return [];
  const result = [];
  const stack = [[folder, '']];
  while (stack.length && result.length < 10000) {
    const [dir, rel] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push([path.join(dir, entry.name), nextRel]);
      else if (entry.isFile() && photoTypes.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = fs.statSync(path.join(dir, entry.name));
          result.push({ id: Buffer.from(nextRel).toString('base64url'), name: entry.name, modified: stat.mtimeMs, url: `/api/photo/${Buffer.from(nextRel).toString('base64url')}` });
        } catch { /* File changed during scan. */ }
      }
      if (result.length >= 10000) break;
    }
  }
  return result.sort((a, b) => b.modified - a.modified);
}
function photoPath(user, id) {
  const folder = getFolder(user);
  if (!folder || !/^[A-Za-z0-9_-]{1,2048}$/.test(id)) fail(404, 'Photo not found');
  const rel = Buffer.from(id, 'base64url').toString('utf8');
  const pieces = rel.split('/');
  if (!pieces.length || pieces.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || p.includes('\\'))) fail(404, 'Photo not found');
  let current = folder;
  for (const piece of pieces) {
    current = path.join(current, piece);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail(404, 'Photo not found'); }
    if (stat.isSymbolicLink()) fail(404, 'Photo not found');
  }
  if (!fs.statSync(current).isFile() || !photoTypes.has(path.extname(current).toLowerCase())) fail(404, 'Photo not found');
  return current;
}
async function weatherFor(user) {
  const location = user.weather;
  if (!location) return { configured: false };
  const key = `${location.latitude},${location.longitude},${location.unit},${location.timezone},${location.label}`;
  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const params = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), current: 'temperature_2m,weather_code,is_day', temperature_unit: location.unit === 'fahrenheit' ? 'fahrenheit' : 'celsius', timezone: 'auto' });
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Weather provider unavailable');
    const data = await response.json();
    const value = { configured: true, temperature: data.current.temperature_2m, code: data.current.weather_code, isDay: data.current.is_day, unit: location.unit === 'fahrenheit' ? '°F' : '°C', label: location.label, timezone: location.timezone };
    weatherCache.set(key, { value, expires: Date.now() + 15 * 60000 });
    return value;
  } catch { return cached?.value || { configured: true, unavailable: true, label: location.label, timezone: location.timezone }; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;
    if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'POST') checkOrigin(req);
    if (req.method === 'PUT' || req.method === 'DELETE') checkOrigin(req);
    if (req.method === 'POST' && route === '/api/login') {
      const { username, password } = await readBody(req);
      const key = `${req.socket.remoteAddress}:${String(username).toLowerCase()}`;
      const previous = failures.get(key) || { count: 0, until: 0 };
      if (previous.until > Date.now()) fail(429, 'Too many attempts; try again later');
      const user = db.users.find(u => u.username === username);
      if (!user || typeof password !== 'string' || !checkPassword(password, user)) {
        const count = previous.count + 1;
        failures.set(key, { count, until: count >= 5 ? Date.now() + 15 * 60000 : 0 });
        fail(401, 'Invalid username or password');
      }
      failures.delete(key);
      const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
      return send(res, 200, { user: safeUser(user) }, { 'Set-Cookie': `dash_session=${cookieToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}` });
    }
    if (req.method === 'POST' && route === '/api/logout') {
      const user = requireUser(req);
      user.sessionVersion++;
      save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'dash_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (req.method === 'GET' && route === '/api/me') return send(res, 200, { user: safeUser(requireUser(req)) });
    if (req.method === 'GET' && route === '/api/photos') {
      const user = requireUser(req);
      return send(res, 200, { photos: photosFor(user), folder: user.folder });
    }
    if (req.method === 'GET' && route.startsWith('/api/photo/')) {
      const user = requireUser(req);
      const file = photoPath(user, route.slice('/api/photo/'.length));
      const stat = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': photoTypes.get(path.extname(file).toLowerCase()), 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && route === '/api/weather') return send(res, 200, await weatherFor(requireUser(req)));
    if (req.method === 'GET' && route === '/api/locations') {
      requireUser(req);
      const query = url.searchParams.get('q')?.trim() || '';
      if (query.length < 2 || query.length > 80) fail(400, 'Enter at least two characters');
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query, count: '5', language: 'en' })}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) fail(502, 'Location search unavailable');
      const data = await response.json();
      return send(res, 200, { locations: (data.results || []).map(p => ({ label: [p.name, p.admin1, p.country].filter(Boolean).join(', '), latitude: p.latitude, longitude: p.longitude, timezone: p.timezone })) });
    }
    if (req.method === 'PUT' && route === '/api/settings') {
      const user = requireUser(req);
      const body = await readBody(req);
      if (body.weather === null) user.weather = null;
      else {
        const w = body.weather;
        if (!w || !Number.isFinite(w.latitude) || Math.abs(w.latitude) > 90 || !Number.isFinite(w.longitude) || Math.abs(w.longitude) > 180 || typeof w.label !== 'string' || w.label.length < 2 || w.label.length > 120 || typeof w.timezone !== 'string' || w.timezone.length > 80 || !['celsius', 'fahrenheit'].includes(w.unit)) fail(400, 'Invalid weather location');
        try { new Intl.DateTimeFormat('en', { timeZone: w.timezone }); } catch { fail(400, 'Invalid timezone'); }
        user.weather = { latitude: w.latitude, longitude: w.longitude, label: w.label, timezone: w.timezone, unit: w.unit };
      }
      save();
      return send(res, 200, { user: safeUser(user) });
    }
    if (req.method === 'PUT' && route === '/api/password') {
      const user = requireUser(req);
      requireAdmin(user);
      const { currentPassword, newPassword } = await readBody(req);
      if (!checkPassword(currentPassword || '', user)) fail(403, 'Current password is incorrect');
      if (!validPassword(newPassword)) fail(400, 'Use a password of 8 to 128 characters');
      Object.assign(user, passwordHash(newPassword));
      user.sessionVersion++;
      save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': `dash_session=${cookieToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}` });
    }
    if (req.method === 'GET' && route === '/api/users') {
      requireAdmin(requireUser(req));
      return send(res, 200, { users: db.users.map(safeUser) });
    }
    if (req.method === 'GET' && route === '/api/folders') {
      requireAdmin(requireUser(req));
      const relative = url.searchParams.get('path') || '';
      const folder = resolveFolder(relative, true);
      if (!folder) fail(404, 'Folder not found in mounted photo library');
      const folders = fs.readdirSync(folder, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
        .slice(0, 500)
        .map(entry => ({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { path: relative, parent: relative ? relative.split('/').slice(0, -1).join('/') : null, folders });
    }
    if (req.method === 'POST' && route === '/api/users') {
      requireAdmin(requireUser(req));
      const { username, password, folder } = await readBody(req);
      if (!validUsername(username) || !validPassword(password)) fail(400, 'Username must be 3–32 lowercase letters, digits, _ or -; password at least 8 characters');
      if (db.users.some(u => u.username === username)) fail(409, 'Username already exists');
      if (!resolveFolder(folder)) fail(400, 'Choose an existing folder from the mounted photo library');
      if (!folderIsAvailable(folder)) fail(409, 'That folder overlaps another account’s folder');
      const user = { id: crypto.randomUUID(), username, folder, role: 'user', sessionVersion: 1, weather: null, ...passwordHash(password) };
      db.users.push(user);
      save();
      return send(res, 201, { user: safeUser(user) });
    }
    const passwordRoute = route.match(/^\/api\/users\/([^/]+)\/password$/);
    if (req.method === 'PUT' && passwordRoute) {
      requireAdmin(requireUser(req));
      const target = db.users.find(user => user.id === passwordRoute[1] && user.role !== 'admin');
      if (!target) fail(404, 'Account not found');
      const { password } = await readBody(req);
      if (!validPassword(password)) fail(400, 'Use a password of 8 to 128 characters');
      Object.assign(target, passwordHash(password));
      target.sessionVersion++;
      save();
      return send(res, 200, { ok: true });
    }
    const folderRoute = route.match(/^\/api\/users\/([^/]+)\/folder$/);
    if (req.method === 'PUT' && folderRoute) {
      requireAdmin(requireUser(req));
      const target = db.users.find(user => user.id === folderRoute[1]);
      if (!target) fail(404, 'Account not found');
      const { folder } = await readBody(req);
      if (!resolveFolder(folder)) fail(400, 'Choose an existing folder from the mounted photo library');
      if (!folderIsAvailable(folder, target.id)) fail(409, 'That folder overlaps another account’s folder');
      target.folder = folder;
      save();
      return send(res, 200, { user: safeUser(target) });
    }
    if (req.method === 'DELETE' && route.startsWith('/api/users/')) {
      const caller = requireUser(req);
      requireAdmin(caller);
      const id = route.slice('/api/users/'.length);
      const target = db.users.find(u => u.id === id);
      if (!target || target.role === 'admin') fail(400, 'Cannot remove this account');
      db.users = db.users.filter(u => u.id !== id);
      save();
      return send(res, 200, { ok: true });
    }
    if (route.startsWith('/api/')) fail(404, 'Not found');
    if (req.method !== 'GET') fail(405, 'Method not allowed');
    const asset = route === '/' ? '/index.html' : route;
    if (!['/index.html', '/app.css', '/app.js'].includes(asset)) fail(404, 'Not found');
    const file = path.join(here, 'public', asset);
    res.writeHead(200, { 'Content-Type': staticTypes[path.extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    return fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    if (!error.status) console.error(error);
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Dash Clock Photos listening on ${port}`));
