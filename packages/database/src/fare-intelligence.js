// Fare Intelligence: deterministic market analytics on LeRoutier's own data.
//
// Every published fare, completed platform transaction and recorded public
// observation becomes a historical row; a price change never overwrites the
// previous one. Recommendations are computed with robust statistics only —
// Gemini may explain a recommendation afterwards, but it never computes it.
//
// Advisory only: the operator remains responsible for the final fare. Nothing
// here blocks or synchronizes prices; this is comparison + recommendation,
// never centralized price control.

import { invariant, uuid } from '@leroutier/domain';

const DAY_MS = 86_400_000;
export const FARE_TYPES = ['passenger', 'parcel_standard', 'parcel_express'];
const SOURCE_TYPES = ['leroutier_published', 'leroutier_transaction', 'external_public'];

// Nearest-rank quantiles: a single extreme fare can never drag the quartiles
// toward itself, so the "typical range" stays typical.
const quantile = (sorted, q) => {
  const n = sorted.length;
  if (n === 0) return null;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
};

// Recency-weighted median: an observation two months old counts for less than
// one recorded yesterday, without letting a single outlier move the centre.
const weightedMedian = (pairs) => {
  const sorted = [...pairs].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((sum, p) => sum + p.weight, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= total / 2) return p.price;
  }
  return sorted.at(-1).price;
};

export function fareIntelligence(db, { windowDays = 180, freshDays = 90, minFresh = 3 } = {}) {
  invariant(Number.isInteger(windowDays) && Number.isInteger(freshDays) && Number.isInteger(minFresh) &&
    windowDays >= freshDays && freshDays >= 1 && minFresh >= 1, 'Fare intelligence windows are invalid.');

  function observation(input) {
    invariant(input && typeof input === 'object', 'INVALID_OBSERVATION', 'Observation fields are invalid.');
    const { originStopId, destinationStopId, fareType, priceMinor, sourceType, sourceReference = null,
      operatorId = null, routeId = null, segmentSequence = null, operatorType = null, effectiveFrom = null, observedAt = null } = input;
    uuid(originStopId); uuid(destinationStopId);
    if (routeId) uuid(routeId);
    invariant(originStopId !== destinationStopId, 'INVALID_OBSERVATION', 'Origin and destination must differ.', 409);
    invariant(FARE_TYPES.includes(fareType) && SOURCE_TYPES.includes(sourceType), 'INVALID_OBSERVATION', 'Fare or source type is invalid.', 409);
    invariant(Number.isInteger(priceMinor) && priceMinor >= 0, 'INVALID_OBSERVATION', 'Price must be a non-negative integer.', 409);
    invariant(sourceType !== 'leroutier_published' || (operatorId && operatorType), 'INVALID_OBSERVATION', 'A published fare belongs to an operator.', 409);
    invariant(sourceType === 'external_public' || operatorId, 'INVALID_OBSERVATION', 'Internal observations belong to an operator.', 409);
    invariant(sourceType !== 'external_public' || (typeof sourceReference === 'string' && sourceReference.length > 0 && sourceReference.length <= 2000),
      'INVALID_OBSERVATION', 'A public observation needs its source reference.', 409);
    invariant(segmentSequence === null || Number.isInteger(segmentSequence), 'INVALID_OBSERVATION', 'Segment sequence is invalid.', 409);
    return { ...input, sourceReference, observedAt: observedAt ?? new Date().toISOString(), effectiveFrom: effectiveFrom ?? new Date().toISOString() };
  }

  return {
    async currentPublished(tx, { operatorId, originStopId, destinationStopId, fareType }) {
      return (await tx.query(`SELECT * FROM fare_observations WHERE operator_id=$1 AND origin_stop_id=$2
        AND destination_stop_id=$3 AND fare_type=$4 AND source_type='leroutier_published' AND effective_to IS NULL
        ORDER BY effective_from DESC LIMIT 1`, [operatorId, originStopId, destinationStopId, fareType])).rows[0] ?? null;
    },

    // A published fare opens a new effective period and closes the previous
    // one: history accumulates, the open row is the current published price.
    async recordPublished(tx, input) {
      const o = observation(input);
      await tx.query(`UPDATE fare_observations SET effective_to=$2 WHERE operator_id=$1 AND origin_stop_id=$3
        AND destination_stop_id=$4 AND fare_type=$5 AND source_type='leroutier_published' AND effective_to IS NULL`,
      [o.operatorId, o.effectiveFrom, o.originStopId, o.destinationStopId, o.fareType]);
      return (await tx.query(`INSERT INTO fare_observations(operator_id,origin_stop_id,destination_stop_id,route_id,segment_sequence,
        fare_type,price_minor,currency,operator_type,source_type,source_reference,effective_from,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'XOF',$8,$9,$10,$11,$12)
        ON CONFLICT (operator_id,source_type,source_reference) WHERE source_reference IS NOT NULL AND operator_id IS NOT NULL DO NOTHING
        RETURNING *`, [o.operatorId, o.originStopId, o.destinationStopId, o.routeId ?? null, o.segmentSequence ?? null,
        o.fareType, o.priceMinor, o.operatorType, o.sourceType, o.sourceReference, o.effectiveFrom, o.observedAt])).rows[0];
    },

    // Completed transactions are evidence, never overwritten and never
    // deduplicated away: duplicate events do not duplicate observations.
    async recordTransaction(tx, input) {
      const o = observation({ ...input, sourceType: 'leroutier_transaction' });
      return (await tx.query(`INSERT INTO fare_observations(operator_id,origin_stop_id,destination_stop_id,route_id,segment_sequence,
        fare_type,price_minor,currency,operator_type,source_type,source_reference,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'XOF',$8,'leroutier_transaction',$9,$10)
        ON CONFLICT (operator_id,source_type,source_reference) WHERE source_reference IS NOT NULL AND operator_id IS NOT NULL DO NOTHING
        RETURNING *`, [o.operatorId, o.originStopId, o.destinationStopId, o.routeId ?? null, o.segmentSequence ?? null,
        o.fareType, o.priceMinor, o.operatorType ?? null, o.sourceReference, o.observedAt])).rows[0];
    },

    // Manually recorded public-market evidence. External rows carry no
    // operator: they are never mixed into any operator's own history.
    async recordExternal(tx, input) {
      const o = observation({ ...input, sourceType: 'external_public' });
      return (await tx.query(`INSERT INTO fare_observations(operator_id,origin_stop_id,destination_stop_id,fare_type,
        price_minor,currency,source_type,source_reference,observed_at)
        VALUES(NULL,$1,$2,$3,$4,'XOF','external_public',$5,$6) RETURNING *`,
      [o.originStopId, o.destinationStopId, o.fareType, o.priceMinor, o.sourceReference, o.observedAt])).rows[0];
    },

    async marketStats({ originStopId, destinationStopId, fareType, ownOperatorId = null, now = new Date() }) {
      uuid(originStopId); uuid(destinationStopId);
      invariant(FARE_TYPES.includes(fareType), 'INVALID_OBSERVATION', 'Fare type is invalid.', 409);
      const nowMs = now.getTime();
      const rows = (await db.transaction(async tx => (await tx.query(`SELECT price_minor,observed_at,source_type,operator_id
        FROM fare_observations WHERE origin_stop_id=$1 AND destination_stop_id=$2 AND fare_type=$3
          AND observed_at>$4 AND (effective_to IS NULL OR effective_to>$4)
        ORDER BY observed_at DESC LIMIT 1000`,
      [originStopId, destinationStopId, fareType, new Date(nowMs - windowDays * DAY_MS).toISOString()])).rows));
      const age = r => Math.max(0, (nowMs - new Date(r.observed_at).getTime()) / DAY_MS);
      const fresh = rows.filter(r => age(r) <= freshDays);
      const weight = r => Math.max(0, 1 - age(r) / windowDays);
      const own = rows.filter(r => r.operator_id === ownOperatorId);
      const txns = rows.filter(r => r.source_type === 'leroutier_transaction' && r.operator_id !== ownOperatorId);
      const prices = fresh.map(r => r.price_minor).sort((a, b) => a - b);
      const stats = {
        count: rows.length,
        freshCount: fresh.length,
        ownCount: own.length,
        transactionCount: txns.length,
        min: prices.length ? prices[0] : null,
        max: prices.length ? prices.at(-1) : null,
        median: quantile(prices, 0.5),
        lowerQuartile: quantile(prices, 0.25),
        upperQuartile: quantile(prices, 0.75),
        ownRange: own.length ? [Math.min(...own.map(r => r.price_minor)), Math.max(...own.map(r => r.price_minor))] : null,
        transactionRange: txns.length ? [Math.min(...txns.map(r => r.price_minor)), Math.max(...txns.map(r => r.price_minor))] : null,
        weightedMedian: weightedMedian(fresh.map(r => ({ price: r.price_minor, weight: weight(r) }))),
        windowDays, freshDays,
      };
      return stats;
    },

    async recommend({ originStopId, destinationStopId, fareType, ownOperatorId, now = new Date() }) {
      const stats = await this.marketStats({ originStopId, destinationStopId, fareType, ownOperatorId, now });
      if (stats.freshCount < minFresh) {
        return { status: 'insufficient_data', message: 'Pas encore assez de données pour une recommandation fiable.',
          ...stats, suggestedPriceMinor: null, advice: null, currentPriceMinor: null };
      }
      const current = await db.transaction(tx => this.currentPublished(tx, { operatorId: ownOperatorId, originStopId, destinationStopId, fareType }));
      const currentPriceMinor = current?.price_minor ?? null;
      const typical = [stats.lowerQuartile, stats.upperQuartile];
      let suggestedPriceMinor = stats.weightedMedian;
      let advice = null;
      if (currentPriceMinor !== null) {
        if (currentPriceMinor > stats.upperQuartile) advice = 'above';
        else if (currentPriceMinor < stats.lowerQuartile) advice = 'below';
        else { advice = 'within_range'; suggestedPriceMinor = currentPriceMinor; }
      }
      return { status: 'recommended', suggestedPriceMinor, typicalRange: typical,
        currentPriceMinor, advice, ...stats, message: null };
    },
  };
}
