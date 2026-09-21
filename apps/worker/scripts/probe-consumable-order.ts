/**
 * Raises ONE real consumable order in live Vantage, to learn the exact path and response shape.
 * Usage (repo root):  npx tsx --env-file=.env apps/worker/scripts/probe-consumable-order.ts <vantageEquipmentId> <type 1-5> [qty]
 * Only run with the user present, on a device they chose because it genuinely needs that toner.
 * Prints status and body; never retries (an uncertain result must be checked in Vantage by hand).
 */
import { createVantageClient, type ConsumableType } from '@mps/vantage';

const [idArg, typeArg, qtyArg] = process.argv.slice(2);
const equipmentId = Number(idArg);
const type = Number(typeArg) as ConsumableType;
if (!Number.isInteger(equipmentId) || ![1, 2, 3, 4, 5].includes(type)) {
  console.error('usage: probe-consumable-order.ts <vantageEquipmentId> <type 1-5> [qty]');
  process.exit(2);
}
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const vantage = createVantageClient({
  baseUrl: env('VANTAGE_BASE_URL'),
  username: env('VANTAGE_USER'),
  password: env('VANTAGE_PASS'),
  apiVersion: process.env.VANTAGE_API_VERSION ?? '1.22',
});
const res = await vantage.createConsumableOrder(equipmentId, [
  { Type: type, RequestedQuantity: qtyArg ? Number(qtyArg) : null },
]);
console.log(JSON.stringify(res, null, 2));
