// Operator ratings.
//
// Two properties matter more than the arithmetic: only a completed journey can
// leave a rating, and an average is not published until enough journeys have
// left one. A single five-star rating shown as "5,0" is not information, and
// the first operator to notice can manufacture it.
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/index.js';
import { migrate } from '../src/migrations.js';
import { dropDisposableSchema } from '../src/guards.js';
import { seed, demo } from '../src/seed.js';
import { serverConfig } from '@leroutier/config';
import { ratings, publicRating, RATING_PUBLIC_MINIMUM } from '../src/ratings.js';
import { transport } from '../src/transport.js';

const config = { ...serverConfig(), schema: 'lr_test_' + randomUUID().replaceAll('-', ''), demoLogin: true };
const db = createDatabase(config);
const rate = ratings(db), domain = transport(db);
const one = async (sql, args = []) => (await db.transaction(async tx => (await tx.query(sql, args)).rows[0]));

async function newPassenger() {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO users(id,auth_subject,auth_issuer,display_name,role,profile_completed_at)
      VALUES($1,$2,'test','Voyageur','passenger',now())`, [id, 'rate-' + id]);
    await tx.query('INSERT INTO passenger_profiles(user_id) VALUES($1)', [id]);
  });
  return { id, role: 'passenger' };
}
/**
 * A booking that really exists, advanced to a chosen state.
 *
 * Completing a journey releases its segments — that is what alighting does —
 * so the fixture does the same. Leaving them behind would hold seats the coach
 * has already emptied and trip the capacity trigger, which is the database
 * correctly refusing a state the domain never produces.
 */
async function bookingFor(passenger, state) {
  const booking = await domain.hold(passenger, { serviceId: demo.service, origin: 0, destination: 1 }, randomUUID());
  await db.transaction(async tx => {
    if (['completed', 'cancelled', 'expired'].includes(state)) {
      await tx.query('DELETE FROM booking_segments WHERE booking_id=$1', [booking.id]);
    }
    await tx.query('UPDATE bookings SET status=$2 WHERE id=$1', [booking.id, state]);
  });
  return booking.id;
}

before(async () => { await migrate(db); await seed(db); });
beforeEach(async () => {
  await db.transaction(async tx => {
    await tx.query('DELETE FROM operator_ratings');
    await tx.query('UPDATE operators SET rating_total=0,rating_count=0');
    await tx.query('DELETE FROM booking_segments');
    await tx.query("UPDATE bookings SET status='cancelled'");
    await tx.query("UPDATE services SET current_sequence=0,status='active'");
  });
});
after(async () => { try { await dropDisposableSchema(db); } finally { await db.close(); } });

test('an average is withheld until enough journeys have been rated', () => {
  assert.deepEqual(publicRating({ rating_total: 5, rating_count: 1 }), { count: 1, average: null, published: false },
    'one five-star rating is not a reputation');
  assert.deepEqual(publicRating({ rating_total: 0, rating_count: 0 }), { count: 0, average: null, published: false });
  const atFloor = publicRating({ rating_total: 22, rating_count: RATING_PUBLIC_MINIMUM });
  assert.equal(atFloor.published, true);
  assert.equal(atFloor.average, Math.round((22 / RATING_PUBLIC_MINIMUM) * 10) / 10);
});

test('only a completed journey can be rated, and only by the passenger who took it', async () => {
  const passenger = await newPassenger(), stranger = await newPassenger();
  const held = await bookingFor(passenger, 'confirmed');
  await assert.rejects(rate.rate(passenger, held, { score: 5 }), { code: 'RATING_NOT_AVAILABLE' });
  const state = await rate.forBooking(passenger, held);
  assert.equal(state.canRate, false);
  assert.equal(state.rating, null);

  const done = await bookingFor(passenger, 'completed');
  await assert.rejects(rate.rate(stranger, done, { score: 5 }), { code: 'FORBIDDEN' });
  await assert.rejects(rate.forBooking(stranger, done), { code: 'FORBIDDEN' });
  const saved = await rate.rate(passenger, done, { score: 4, comment: 'Depart a l heure.' });
  assert.equal(saved.score, 4);
  assert.equal((await rate.forBooking(passenger, done)).rating.score, 4);
});

test('one journey rates once: re-rating corrects rather than stacks', async () => {
  const passenger = await newPassenger();
  const done = await bookingFor(passenger, 'completed');
  await rate.rate(passenger, done, { score: 1 });
  let operator = await one('SELECT rating_total,rating_count FROM operators WHERE id=$1', [demo.operator]);
  assert.equal(operator.rating_count, 1);
  assert.equal(operator.rating_total, 1);
  // Correcting the score moves the total and leaves the count alone.
  await rate.rate(passenger, done, { score: 5 });
  operator = await one('SELECT rating_total,rating_count FROM operators WHERE id=$1', [demo.operator]);
  assert.equal(operator.rating_count, 1, 'still one journey, one rating');
  assert.equal(operator.rating_total, 5);
  assert.equal((await one('SELECT count(*)::integer AS n FROM operator_ratings WHERE booking_id=$1', [done])).n, 1);
});

test('the aggregate matches the rows behind it, including under concurrency', async () => {
  const passengers = await Promise.all(Array.from({ length: RATING_PUBLIC_MINIMUM }, () => newPassenger()));
  const bookings = [];
  for (const p of passengers) bookings.push([p, await bookingFor(p, 'completed')]);
  // Rated at the same moment: the aggregate is a read-modify-write, so this is
  // where a lost update would show up.
  await Promise.all(bookings.map(([p, id], i) => rate.rate(p, id, { score: (i % 5) + 1 })));
  const operator = await one('SELECT rating_total,rating_count FROM operators WHERE id=$1', [demo.operator]);
  const truth = await one('SELECT count(*)::integer AS n, coalesce(sum(score),0)::integer AS total FROM operator_ratings WHERE operator_id=$1', [demo.operator]);
  assert.equal(operator.rating_count, truth.n, 'no rating was lost');
  assert.equal(operator.rating_total, truth.total);
  assert.equal(publicRating(operator).published, true, 'the floor is reached, so the average is publishable');
});

test('a rating is refused outside 1..5, and a comment never reaches the event stream', async () => {
  const passenger = await newPassenger();
  const done = await bookingFor(passenger, 'completed');
  for (const score of [0, 6, 2.5, 'cinq', null]) {
    await assert.rejects(rate.rate(passenger, done, { score }), { code: 'INVALID_RATING' });
  }
  await assert.rejects(rate.rate(passenger, done, { score: 5, note: 'x' }), { code: 'INVALID_RATING' });
  await rate.rate(passenger, done, { score: 5, comment: 'Chauffeur tres courtois au depart de Cotonou.' });
  const events = await db.transaction(async tx => (await tx.query(
    "SELECT payload::text AS payload FROM outbox WHERE event_type='booking.rated' AND aggregate_id=$1", [done])).rows);
  assert.ok(events.length > 0, 'the rating is recorded as an event');
  assert.ok(!events.some(e => e.payload.includes('courtois')), 'the comment stays out of the notification stream');
});

test('an operator reads its own reputation and never who wrote it', async () => {
  const passenger = await newPassenger();
  const done = await bookingFor(passenger, 'completed');
  await rate.rate(passenger, done, { score: 3, comment: 'Correct sans plus.' });
  const ops = { id: demo.ops, role: 'ops', operator_id: demo.operator };
  const view = await rate.forOperator(ops);
  assert.equal(view.count, 1);
  assert.equal(view.average, null, 'below the floor, even its own operator sees no average');
  assert.equal(view.minimumForPublication, RATING_PUBLIC_MINIMUM);
  assert.equal(view.recent[0].comment, 'Correct sans plus.');
  const text = JSON.stringify(view);
  assert.ok(!text.includes(passenger.id), 'a rating must not become a way to find the passenger');
  // And one company cannot read another's.
  await assert.rejects(rate.forOperator({ id: demo.ops, role: 'ops', operator_id: randomUUID() }, demo.operator), { code: 'FORBIDDEN' });
  await assert.rejects(rate.forOperator({ id: passenger.id, role: 'passenger' }), { code: 'FORBIDDEN' });
});
