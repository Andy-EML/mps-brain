import type { ListOptions, VantageRecord } from '@mps/vantage';

export function fakeVantage(customers: VantageRecord[], equipment: VantageRecord[]) {
  const calls: { entity: 'customer' | 'equipment'; opts: ListOptions }[] = [];
  return {
    calls,
    client: {
      async listCustomers(opts: ListOptions = {}) {
        calls.push({ entity: 'customer', opts });
        return customers;
      },
      async listEquipment(opts: ListOptions = {}) {
        calls.push({ entity: 'equipment', opts });
        return equipment;
      },
    },
  };
}
