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
  fs.writeFileSync(path.join(photos, '.dash-clock-photos'), '');
  fs.writeFileSync(path.join(photos, 'admin', 'secret.jpg'), 'admin photo');
  fs.writeFileSync(path.join(photos, 'alex', 'own.jpg'), 'alex photo');
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
    const create = await request('/api/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: 'alex', password: 'a-strong-password-123' }) });
    assert.equal(create.status, 201);
    const alexLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alex', password: 'a-strong-password-123' }) });
    assert.equal(alexLogin.status, 200);
    const alexCookie = alexLogin.headers.get('set-cookie').split(';')[0];
    const alexList = await (await request('/api/photos', { headers: { Cookie: alexCookie } })).json();
    assert.deepEqual(alexList.photos.map(p => p.name), ['own.jpg']);
    const adminList = await (await request('/api/photos', { headers: { Cookie: adminCookie } })).json();
    assert.deepEqual(adminList.photos.map(p => p.name), ['secret.jpg']);
    assert.equal((await request(adminList.photos[0].url, { headers: { Cookie: alexCookie } })).status, 404);
    assert.equal((await request(alexList.photos[0].url, { headers: { Cookie: alexCookie } })).status, 200);
    assert.equal((await request('/api/users', { headers: { Cookie: alexCookie } })).status, 403);
    const traversal = Buffer.from('../admin/secret.jpg').toString('base64url');
    assert.equal((await request(`/api/photo/${traversal}`, { headers: { Cookie: alexCookie } })).status, 404);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
