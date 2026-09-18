import { normaliseSerial } from '@mps/core';
import { drmsEquipment, vantageEquipment, type Db } from '@mps/db';
import type { DrmsEquipment } from '@mps/drms';
import type { ListOptions, SalesOrderListOptions, VantageRecord } from '@mps/vantage';

/** A `listSalesOrders` stub that records its options, or throws the error it was handed. */
export function fakeVantageOrders(orders: VantageRecord[] | Error) {
  const calls: SalesOrderListOptions[] = [];
  return {
    calls,
    client: {
      async listSalesOrders(opts: SalesOrderListOptions = {}) {
        calls.push(opts);
        if (orders instanceof Error) throw orders;
        return orders;
      },
    },
  };
}

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

export function drmsDevice(id: string, extra: Partial<DrmsEquipment> = {}): DrmsEquipment {
  return {
    Id: id,
    ErpId: null,
    SerialNumber: `ser-${id}`,
    ModelName: 'bizhub C300i',
    Status: 'Registered',
    CustomerErpId: 'C1',
    CustomerName: 'Cust 1',
    ...extra,
  };
}

export async function seedDrms(
  db: Db,
  rows: Array<Partial<typeof drmsEquipment.$inferInsert> & { drmsId: string }>,
): Promise<void> {
  await db.insert(drmsEquipment).values(
    rows.map((r) => ({ status: 'Registered', raw: {}, ...r, serialNorm: normaliseSerial(r.serial) })),
  );
}

export async function seedVantage(
  db: Db,
  rows: Array<Partial<typeof vantageEquipment.$inferInsert> & { vantageId: number }>,
): Promise<void> {
  await db.insert(vantageEquipment).values(rows.map((r) => ({ raw: {}, ...r, serialNorm: normaliseSerial(r.serial) })));
}
