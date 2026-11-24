import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { Store, createStore } from '../server/store.js';

const count = async (store, sql, params = []) => Number((await store.pool.query(sql, params)).rows[0].count);
const invoice = number => ({ type: 'invoice', number, totalMinor: 12000, currency: 'GBP' });

test('production store never silently falls back to an in-memory database', async () => {
  await assert.rejects(createStore({ production: true }), /Production requires PostgreSQL/);
});

test('PostgreSQL-backed store maintains isolation, transactions and idempotent workflows', async t => {
  const store = await createStore(loadConfig({ APP_MODE: 'demo' }));
  t.after(() => store.close());
  await store.init({ skipLock: true });
  await store.ready();

  await t.test('same state, product and order keys remain isolated between shops', async () => {
    await store.set('uk', 'shipping', { priceMinor: 990 });
    await store.set('eu', 'shipping', { priceMinor: 1290 });
    assert.deepEqual(await store.get('uk', 'shipping'), { priceMinor: 990 });
    assert.deepEqual(await store.get('eu', 'shipping'), { priceMinor: 1290 });
    assert.equal(await store.get('other', 'shipping', 'fallback'), 'fallback');
    for (const table of ['products', 'orders']) {
      await store.upsert(table, 'uk', 'shared-id', { name: 'UK fixture' });
      await store.upsert(table, 'eu', 'shared-id', { name: 'EU fixture' });
      assert.equal((await store.list(table, 'uk'))[0].data.name, 'UK fixture');
      assert.equal((await store.list(table, 'eu'))[0].data.name, 'EU fixture');
      assert.deepEqual(await store.list(table, 'other'), []);
    }
    await assert.rejects(store.list('products; DROP TABLE orders', 'uk'), /Invalid table/);
  });

  await t.test('CAS allows one stale-revision contender and rejects the other with 409', async () => {
    assert.equal(await store.put('uk', 'settings', { label: 'initial' }, 0), 1);
    assert.equal(await store.put('uk', 'settings', { label: 'second' }, 1), 2);
    await assert.rejects(store.put('uk', 'settings', { label: 'stale' }, 1), error => error.status === 409);
    const results = await Promise.allSettled([
      store.put('uk', 'settings', { label: 'tab-one' }, 2),
      store.put('uk', 'settings', { label: 'tab-two' }, 2),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
    assert.equal((await store.state('uk')).settings.revision, 3);
    assert.equal(await store.get('eu', 'settings'), null);
  });

  await t.test('OAuth nonces are shop-scoped, expire and can only be consumed once', async () => {
    await store.nonce('nonce-fixture', 'uk', new Date(Date.now() + 60000));
    assert.equal(await store.consumeNonce('nonce-fixture', 'eu'), false);
    assert.equal(await store.consumeNonce('nonce-fixture', 'uk'), true);
    assert.equal(await store.consumeNonce('nonce-fixture', 'uk'), false);
    await store.nonce('expired-fixture', 'uk', new Date(Date.now() - 1000));
    assert.equal(await store.consumeNonce('expired-fixture', 'uk'), false);
    assert.equal(await store.throttle('login-one', 2), true);
    assert.equal(await store.throttle('login-one', 2), true);
    assert.equal(await store.throttle('login-one', 2), false);
    assert.equal(await store.throttle('login-two', 2), true);
  });

  await t.test('document retries return one snapshot and allocate one number', async () => {
    let calls = 0;
    const documents = await Promise.all(Array.from({ length: 6 }, () => store.createDocument('uk', 'order:same', 'invoice', number => {
      calls++; return invoice(number);
    })));
    assert.equal(new Set(documents.map(document => document.id)).size, 1);
    assert.equal(calls, 1);
    assert.match(documents[0].snapshot.number, /^INV-\d{4}-000001$/);
    assert.equal(await count(store, 'SELECT count(*) FROM documents WHERE shop_id=$1', ['uk']), 1);
    assert.equal(await store.document('eu', documents[0].id), null);
    const otherShop = await store.createDocument('eu', 'order:same', 'invoice', invoice);
    assert.match(otherShop.snapshot.number, /^INV-\d{4}-000001$/);
    assert.notEqual(otherShop.id, documents[0].id);
  });

  await t.test('distinct concurrent documents receive unique numbers and failed creation rolls back the sequence', async () => {
    const documents = await Promise.all(Array.from({ length: 4 }, (_, index) => store.createDocument('uk', `order:distinct:${index}`, 'invoice', invoice)));
    assert.equal(new Set(documents.map(document => document.snapshot.number)).size, 4);
    assert.deepEqual(documents.map(document => Number(document.snapshot.number.split('-').at(-1))).sort((a, b) => a - b), [2, 3, 4, 5]);
    await assert.rejects(store.createDocument('rollback-shop', 'order:broken', 'invoice', () => { throw new Error('snapshot validation failed'); }), /snapshot validation/);
    assert.equal(await count(store, 'SELECT count(*) FROM documents WHERE shop_id=$1', ['rollback-shop']), 0);
    const afterFailure = await store.createDocument('rollback-shop', 'order:valid', 'invoice', invoice);
    assert.match(afterFailure.snapshot.number, /^INV-\d{4}-000001$/);
    const quote = await store.createDocument('uk', 'quote:one', 'quote', number => ({ type: 'quote', number }));
    assert.match(quote.snapshot.number, /^QUO-\d{4}-000001$/);
  });

  await t.test('parallel claims never return one pending job to two workers', async () => {
    for (let index = 0; index < 4; index++) await store.enqueue(index % 2 ? 'uk' : 'eu', 'fixture', { index }, `claim:${index}`);
    await store.enqueue('uk', 'fixture', { changed: true }, 'claim:0');
    assert.equal(await count(store, 'SELECT count(*) FROM jobs WHERE id LIKE $1', ['claim:%']), 4);
    const claims = await Promise.all([store.claim(3), store.claim(3)]);
    const jobs = claims.flat();
    assert.equal(jobs.length, 4);
    assert.equal(new Set(jobs.map(job => job.id)).size, 4);
    assert.ok(jobs.every(job => job.status === 'running' && job.attempts === 1 && job.lease_token));
    assert.deepEqual(await store.claim(3), []);
    for (const job of jobs) await store.finish(job);
    assert.equal(await count(store, "SELECT count(*) FROM jobs WHERE status='done'"), 4);
    assert.equal((await store.list('jobs', 'uk')).every(job => job.shop_id === 'uk'), true);
  });

  await t.test('failed jobs back off, retry at most five times, then stay terminal', async () => {
    await store.enqueue('uk', 'retry-fixture', {}, 'retry:one');
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [job] = await store.claim(1);
      assert.equal(job.id, 'retry:one');
      assert.equal(job.attempts, attempt);
      await store.finish(job, new Error('synthetic delivery failure'));
      const current = (await store.pool.query('SELECT *,run_at>now() AS has_backoff FROM jobs WHERE id=$1', [job.id])).rows[0];
      assert.equal(current.status, attempt === 5 ? 'failed' : 'pending');
      assert.equal(current.lease_until, null);
      assert.equal(current.has_backoff, true);
      assert.deepEqual(await store.claim(1), []);
      if (attempt < 5) await store.pool.query("UPDATE jobs SET run_at=now()-interval '1 second' WHERE id=$1", [job.id]);
    }
    assert.deepEqual(await store.claim(1), []);
  });

  await t.test('an expired lease can be reclaimed and the old worker cannot complete the new lease', async () => {
    await store.enqueue('uk', 'lease-fixture', {}, 'lease:one');
    const [oldJob] = await store.claim(1);
    await store.pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [oldJob.id]);
    const [newJob] = await store.claim(1);
    assert.equal(newJob.id, oldJob.id);
    assert.notEqual(newJob.lease_token, oldJob.lease_token);
    assert.equal(newJob.attempts, 2);
    await store.finish(oldJob);
    const stillRunning = (await store.pool.query('SELECT status,lease_token FROM jobs WHERE id=$1', [newJob.id])).rows[0];
    assert.equal(stillRunning.status, 'running');
    assert.equal(stillRunning.lease_token, newJob.lease_token);
    await store.finish(newJob);
    assert.equal((await store.pool.query('SELECT status FROM jobs WHERE id=$1', [newJob.id])).rows[0].status, 'done');
  });

  await t.test('a worker crash on its final attempt cannot leave an expired job running forever', async () => {
    await store.enqueue('uk', 'crash-fixture', {}, 'crash:final');
    await store.pool.query('UPDATE jobs SET attempts=4 WHERE id=$1', ['crash:final']);
    const [job] = await store.claim(1);
    assert.equal(job.id, 'crash:final');
    assert.equal(job.attempts, 5);
    await store.pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    assert.deepEqual(await store.claim(1), []);
    assert.equal((await store.pool.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0].status, 'failed');
  });

  await t.test('webhook receipt and job insertion are atomic and deduplicated per shop', async () => {
    let failInsert = true;
    const failingPool = {
      query: (...args) => store.pool.query(...args),
      async connect() {
        const client = await store.pool.connect();
        return {
          query(sql, params) {
            if (failInsert && /INSERT INTO jobs/.test(sql)) throw new Error('injected enqueue failure');
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    };
    const injectedStore = new Store(failingPool);
    await assert.rejects(injectedStore.receipt('uk', 'event-atomic', 'orders/create', { id: 'order-fixture' }), /injected enqueue failure/);
    assert.equal(await count(store, 'SELECT count(*) FROM webhook_receipts WHERE event_id=$1', ['event-atomic']), 0);
    assert.equal(await count(store, 'SELECT count(*) FROM jobs WHERE id=$1', ['webhook:uk:event-atomic']), 0);
    failInsert = false;
    const accepted = await Promise.all([
      injectedStore.receipt('uk', 'event-atomic', 'orders/create', { id: 'order-fixture' }),
      injectedStore.receipt('uk', 'event-atomic', 'orders/create', { id: 'order-fixture' }),
    ]);
    assert.deepEqual(accepted.sort(), [false, true]);
    assert.equal(await count(store, 'SELECT count(*) FROM webhook_receipts WHERE shop_id=$1 AND event_id=$2', ['uk', 'event-atomic']), 1);
    assert.equal(await count(store, 'SELECT count(*) FROM jobs WHERE id=$1', ['webhook:uk:event-atomic']), 1);
    assert.equal(await store.receipt('eu', 'event-atomic', 'orders/create', { id: 'other-order' }), true);
    assert.equal(await count(store, 'SELECT count(*) FROM jobs WHERE id=$1', ['webhook:eu:event-atomic']), 1);
  });

  await t.test('repeat subscriptions retain stable IDs, reactivate safely and unsubscribe only the matching shop', async () => {
    const input = { email: 'subscriber@example.com', variantId: 'variant-one', market: 'GB', language: 'en', restockConsent: true };
    const first = await store.subscribe('uk', input);
    const second = await store.subscribe('uk', { ...input, language: 'de' });
    assert.equal(second.id, first.id);
    assert.equal(second.data.id, first.id);
    assert.equal(second.data.createdAt, first.data.createdAt);
    assert.equal(second.data.language, 'de');
    const other = await store.subscribe('eu', input);
    assert.notEqual(other.id, first.id);
    assert.equal(await store.subscription('eu', first.id), null);
    await store.unsubscribe('eu', first.id);
    assert.equal((await store.subscription('uk', first.id)).active, true);
    await store.unsubscribe('uk', first.id);
    assert.equal((await store.subscription('uk', first.id)).active, false);
    assert.equal((await store.subscription('eu', other.id)).active, true);
    const reactivated = await store.subscribe('uk', input);
    assert.equal(reactivated.id, first.id);
    assert.equal(reactivated.data.id, first.id);
    assert.equal(reactivated.active, true);
    assert.equal(await count(store, 'SELECT count(*) FROM subscriptions WHERE shop_id=$1', ['uk']), 1);
  });
});
