import { normaliseSerial } from '@mps/core';
import { drmsEquipment, vantageEquipment, type Db } from '@mps/db';
import type { DrmsEquipment } from '@mps/drms';
import type { ListOptions, MeterReadingListOptions, SalesOrderListOptions, ScheduledWorkUnitListOptions, VantageRecord, WorkUnitListOptions } from '@mps/vantage';

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

export function fakeVantageMeters(readings: VantageRecord[] | Error, types: VantageRecord[] = []) {
  const calls: MeterReadingListOptions[] = [];
  return {
    calls,
    client: {
      async listMeterTypes() {
        return types;
      },
      async listMeterReadings(opts: MeterReadingListOptions) {
        calls.push(opts);
        if (readings instanceof Error) throw readings;
        return readings;
      },
    },
  };
}

/** A `listEquipmentContracts` stub that returns the rows, or throws the error it was handed. */
export function fakeVantageContracts(rows: VantageRecord[] | Error) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    client: {
      async listEquipmentContracts() {
        calls++;
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
  };
}

/** A `listWorkUnits` stub that records its options, or throws the error it was handed. */
export function fakeVantageWork(units: VantageRecord[] | Error) {
  const calls: WorkUnitListOptions[] = [];
  return {
    calls,
    client: {
      async listWorkUnits(opts: WorkUnitListOptions) {
        calls.push(opts);
        if (units instanceof Error) throw units;
        return units;
      },
    },
  };
}

/** A `listScheduledWorkUnits` stub that records its options, or throws the error it was handed. */
export function fakeVantageSchedule(units: VantageRecord[] | Error) {
  const calls: ScheduledWorkUnitListOptions[] = [];
  return {
    calls,
    client: {
      async listScheduledWorkUnits(opts: ScheduledWorkUnitListOptions) {
        calls.push(opts);
        if (units instanceof Error) throw units;
        return units;
      },
    },
  };
}

/** A `listEngineers` stub that throws the error it was handed. */
export function fakeVantageEngineers(rows: VantageRecord[] | Error) {
  return {
    client: {
      async listEngineers() {
        if (rows instanceof Error) throw rows;
        return rows;
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
