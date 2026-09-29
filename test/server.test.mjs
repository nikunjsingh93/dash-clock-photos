import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('accounts see only their own HDD folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-clock-test-'));
  const photos = path.join(root, 'photos'); const state = path.join(root, 'state');
  fs.mkdirSync(path.join(photos, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(photos, 'alex'));
  fs.mkdirSync(path.join(photos, 'family', 'alex'), { recursive: true });
  fs.writeFileSync(path.join(photos, '.dash-clock-photos'), '');
  fs.writeFileSync(path.join(photos, 'admin', 'secret.jpg'), 'admin photo');
  fs.writeFileSync(path.join(photos, 'alex', 'own.jpg'), 'alex photo');
  fs.writeFileSync(path.join(photos, 'family', 'alex', 'family.jpg'), 'family photo');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), PHOTO_ROOT: photos, STATE_DIR: state, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-horse-battery' }, stdio: 'pipe' });
  const base = `http://127.0.0.1:${port}`;
  async function request(url, options = {}) { return fetch(base + url, options); }
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { if ((await request('/api/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(ready, true, 'server started');
    assert.equal((await request('/api/photos')).status, 401);
    const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
    assert.equal(login.status, 200);
    const adminCookie = login.headers.get('set-cookie').split(';')[0];
    const adminHeaders = { Cookie: adminCookie, 'Content-Type': 'application/json' };
    const folders = await (await request('/api/folders', { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(folders.folders.map(folder => folder.name), ['admin', 'alex', 'family']);
    const tooShort = await request('/api/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: 'short', password: 'seven77', folder: 'alex' }) });
    assert.equal(tooShort.status, 400);
    const create = await request('/api/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: 'alex', password: 'eight888', folder: 'alex' }) });
    assert.equal(create.status, 201);
    const alex = (await create.json()).user;
    const alexLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'eight888' }) });
    assert.equal(alexLogin.status, 200);
    const alexCookie = alexLogin.headers.get('set-cookie').split(';')[0];
    const alexList = await (await request('/api/photos', { headers: { Cookie: alexCookie } })).json();
    assert.deepEqual(alexList.photos.map(p => p.name), ['own.jpg']);
    const adminList = await (await request('/api/photos', { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(adminList.photos.map(p => p.name), ['secret.jpg']);
    assert.equal((await request(adminList.photos[0].url, { headers: { Cookie: alexCookie } })).status, 404);
    assert.equal((await request(alexList.photos[0].url, { headers: { Cookie: alexCookie } })).status, 200);
    assert.equal((await request('/api/users', { headers: { Cookie: alexCookie } })).status, 403);
    assert.equal((await request('/api/folders', { headers: { Cookie: alexCookie } })).status, 403);
    assert.equal((await request('/api/password', { method: 'PUT', headers: { Cookie: alexCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'eight888', newPassword: 'change123' }) })).status, 403);
    const traversal = Buffer.from('../admin/secret.jpg').toString('base64url');
    assert.equal((await request(`/api/photo/${traversal}`, { headers: { Cookie: alexCookie } })).status, 404);
    assert.equal((await request(`/api/users/${alex.id}/folder`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ folder: 'admin' }) })).status, 409);
    assert.equal((await request(`/api/users/${alex.id}/folder`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ folder: '../admin' }) })).status, 400);
    assert.equal((await request(`/api/users/${alex.id}/folder`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ folder: 'family/alex' }) })).status, 200);
    const reassigned = await (await request('/api/photos', { headers: { Cookie: alexCookie } })).json();
    assert.deepEqual(reassigned.photos.map(p => p.name), ['family.jpg']);
    assert.equal((await request(`/api/users/${alex.id}/password`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ password: 'reset888' }) })).status, 200);
    assert.equal((await request('/api/me', { headers: { Cookie: alexCookie } })).status, 401);
    const newLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'reset888' }) });
    assert.equal(newLogin.status, 200);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
