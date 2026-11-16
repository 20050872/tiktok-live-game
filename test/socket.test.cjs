const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createBackendServer } = require('../dist/server.js');
const { getPrismaClient, disconnectPrismaClient } = require('../dist/database/prisma.js');

async function startTestServer() {
  const backend = createBackendServer();
  await new Promise((resolve, reject) => {
    backend.httpServer.once('error', reject);
    backend.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = backend.httpServer.address();
  return { ...backend, url: `http://127.0.0.1:${address.port}` };
}

function connect(url, token) {
  const client = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    query: { token },
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

async function stopTestServer(backend) {
  await new Promise((resolve) => backend.io.close(resolve));
}

async function createTestPublisher() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  return getPrismaClient().user.create({
    data: {
      tiktokUsername: `test_${suffix}`,
      subscription: {
        create: {
          status: 'trial',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    },
  });
}

async function cleanupTestPublishers(users) {
  const prisma = getPrismaClient();
  for (const user of users) {
    await prisma.subscription.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

test('health endpointi PostgreSQL bağlantı durumunu bildirir', async (t) => {
  const backend = await startTestServer();
  t.after(async () => {
    await stopTestServer(backend);
    await disconnectPrismaClient();
  });

  const response = await fetch(`${backend.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    message: 'TikTokLiveGame backend çalışıyor',
    db: 'connected',
  });
});

test('publisher info token ile yayıncı ve abonelik bilgisini döndürür', async (t) => {
  const backend = await startTestServer();
  const users = [];
  t.after(async () => {
    await cleanupTestPublishers(users);
    await stopTestServer(backend);
    await disconnectPrismaClient();
  });
  const user = await createTestPublisher();
  users.push(user);

  const response = await fetch(`${backend.url}/api/publisher/info/${user.overlayToken}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.publisher.id, user.id);
  assert.equal(body.publisher.tiktokUsername, user.tiktokUsername);
  assert.equal(body.subscription.status, 'trial');
  assert.ok(body.subscription.remainingMs > 0);
  assert.equal(body.subscription.isActive, true);

  const unknown = await fetch(`${backend.url}/api/publisher/info/00000000-0000-4000-8000-000000000000`);
  assert.equal(unknown.status, 404);
});

test('register endpointi korunur ve yeni yayıncı için trial aboneliği üretir', async (t) => {
  const backend = await startTestServer();
  const username = `reg_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let createdUserId;
  t.after(async () => {
    if (createdUserId) await cleanupTestPublishers([{ id: createdUserId }]);
    await stopTestServer(backend);
    await disconnectPrismaClient();
  });

  const response = await fetch(`${backend.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiktokUsername: username }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  createdUserId = body.user.id;
  assert.equal(body.user.tiktokUsername, username);
  assert.match(body.user.overlayToken, /^[0-9a-f-]{36}$/i);
  assert.equal(body.subscription.status, 'trial');
  assert.ok(Math.abs(new Date(body.subscription.expiresAt).getTime() - Date.now() - 7 * 86400000) < 5000);

  const duplicate = await fetch(`${backend.url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tiktokUsername: username }),
  });
  assert.equal(duplicate.status, 409);
});

test('simüle event oyun durumunu günceller ve yalnızca hedef yayıncı odasına gider', async (t) => {
  const backend = await startTestServer();
  const users = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await cleanupTestPublishers(users);
    await stopTestServer(backend);
    await disconnectPrismaClient();
  });

  const targetPublisher = await createTestPublisher();
  const otherPublisher = await createTestPublisher();
  users.push(targetPublisher, otherPublisher);
  const targetSocket = await connect(backend.url, targetPublisher.overlayToken);
  const otherSocket = await connect(backend.url, otherPublisher.overlayToken);
  clients.push(targetSocket, otherSocket);

  let leaked = false;
  otherSocket.once('game:state', () => { leaked = true; });
  const targetStateEvent = once(targetSocket, 'game:state');
  const response = await fetch(`${backend.url}/api/test/simulate-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      overlayToken: targetPublisher.overlayToken,
      eventType: 'CHAT',
      user: { userId: 'simulated-viewer-1', username: 'viewer1', displayName: 'Viewer One' },
      payload: { message: 'Test yorumu' },
    }),
  });
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  const [broadcastState] = await targetStateEvent;
  assert.equal(responseBody.event.type, 'CHAT');
  assert.equal(responseBody.gameState.bossHealth, 999);
  assert.equal(responseBody.gameState.players[0].username, 'viewer1');
  assert.deepEqual(broadcastState, responseBody.gameState);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(leaked, false);
});

test('Socket.IO token doğrular, yayıncı odasını izole eder ve geçersiz tokenı reddeder', async (t) => {
  const backend = await startTestServer();
  const users = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await cleanupTestPublishers(users);
    await stopTestServer(backend);
    await disconnectPrismaClient();
  });

  const publisherA = await createTestPublisher();
  const publisherB = await createTestPublisher();
  users.push(publisherA, publisherB);

  const first = await connect(backend.url, publisherA.overlayToken);
  const second = await connect(backend.url, publisherA.overlayToken);
  const otherPublisher = await connect(backend.url, publisherB.overlayToken);
  clients.push(first, second, otherPublisher);
  assert.equal(backend.io.sockets.adapter.rooms.get(publisherA.id)?.size, 2);

  let leakedAcrossRooms = false;
  otherPublisher.once('test:message', () => { leakedAcrossRooms = true; });
  const firstMessage = once(first, 'test:message');
  const secondMessage = once(second, 'test:message');
  first.emit('test:send', 'oda izolasyonu testi');
  const [[payloadA], [payloadB]] = await Promise.all([firstMessage, secondMessage]);
  assert.equal(payloadA.message, 'oda izolasyonu testi');
  assert.deepEqual(payloadB, payloadA);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(leakedAcrossRooms, false);

  const invalidClient = createClient(backend.url, {
    transports: ['websocket'],
    reconnection: false,
    query: { token: '00000000-0000-4000-8000-000000000000' },
  });
  const [connectionError] = await once(invalidClient, 'connect_error');
  assert.equal(connectionError.message, 'unauthorized');
  invalidClient.close();

  const disconnected = once(second, 'disconnect');
  second.disconnect();
  const [reason] = await disconnected;
  assert.equal(reason, 'io client disconnect');
});