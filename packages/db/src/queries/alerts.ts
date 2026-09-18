import { desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceAlerts, drmsEquipment, users } from '../schema';

export interface AlertRow {
  id: number;
  drmsId: string;
  deviceName: string | null;
  serial: string | null;
  customerName: string | null;
  type: string;
  firstDetectedAt: Date;
  lastSeenReportAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
}

export async function listAlerts(db: Db, o: { includeCleared?: boolean; limit?: number } = {}): Promise<AlertRow[]> {
  const limit = o.limit ?? 50;
  const where = o.includeCleared ? undefined : isNull(deviceAlerts.clearedAt);

  return db
    .select({
      id: deviceAlerts.id,
      drmsId: deviceAlerts.drmsEquipmentId,
      deviceName: drmsEquipment.productName,
      serial: drmsEquipment.serial,
      customerName: drmsEquipment.customerName,
      type: deviceAlerts.type,
      firstDetectedAt: deviceAlerts.firstDetectedAt,
      lastSeenReportAt: deviceAlerts.lastSeenReportAt,
      acknowledgedAt: deviceAlerts.acknowledgedAt,
      acknowledgedByName: users.username,
    })
    .from(deviceAlerts)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, deviceAlerts.drmsEquipmentId))
    .leftJoin(users, eq(users.id, deviceAlerts.acknowledgedBy))
    .where(where)
    .orderBy(desc(deviceAlerts.firstDetectedAt))
    .limit(limit);
}
