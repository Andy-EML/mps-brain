import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator'] }).notNull().default('operator'),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const vantageCustomers = pgTable('vantage_customers', {
  vantageId: integer('vantage_id').primaryKey(),
  reference: text('reference'),
  name: text('name'),
  isActive: boolean('is_active'),
  isOnStop: boolean('is_on_stop'),
  modifiedDate: ts('modified_date'),
  deletedDate: ts('deleted_date'),
  raw: jsonb('raw').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const vantageEquipment = pgTable(
  'vantage_equipment',
  {
    vantageId: integer('vantage_id').primaryKey(),
    serial: text('serial'),
    serialNorm: text('serial_norm'),
    assetNumber: text('asset_number'),
    description: text('description'),
    itemPartNumber: text('item_part_number'),
    vantageCustomerId: integer('vantage_customer_id'),
    customerReference: text('customer_reference'),
    customerName: text('customer_name'),
    location: text('location'),
    installDate: ts('install_date'),
    modifiedDate: ts('modified_date'),
    deletedDate: ts('deleted_date'),
    raw: jsonb('raw').notNull(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    index('vantage_equipment_serial_norm_idx').on(t.serialNorm),
    index('vantage_equipment_customer_idx').on(t.vantageCustomerId),
  ],
);

export const drmsEquipment = pgTable(
  'drms_equipment',
  {
    drmsId: text('drms_id').primaryKey(),
    erpId: text('erp_id'),
    serial: text('serial'),
    serialNorm: text('serial_norm'),
    modelName: text('model_name'),
    productName: text('product_name'),
    status: text('status'),
    communicationType: text('communication_type'),
    customerErpId: text('customer_erp_id'),
    customerName: text('customer_name'),
    customerCsrcId: text('customer_csrc_id'),
    registrationTime: ts('registration_time'),
    initialConnectionTime: ts('initial_connection_time'),
    lastCounterReceivedTime: ts('last_counter_received_time'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    missingSince: ts('missing_since'),
    lastSnapshotFetchAt: ts('last_snapshot_fetch_at'),
    raw: jsonb('raw').notNull(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    index('drms_equipment_serial_norm_idx').on(t.serialNorm),
    index('drms_equipment_erp_id_idx').on(t.erpId),
  ],
);

export const drmsCustomers = pgTable('drms_customers', {
  drmsId: text('drms_id').primaryKey(),
  erpId: text('erp_id'),
  name: text('name'),
  csrcIds: text('csrc_ids').array(),
  raw: jsonb('raw').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const deviceLinks = pgTable(
  'device_links',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id')
      .notNull()
      .references(() => vantageEquipment.vantageId),
    method: text('method', { enum: ['erp_id', 'serial', 'manual'] }).notNull(),
    linkedBy: integer('linked_by').references(() => users.id),
    linkedAt: ts('linked_at').notNull().defaultNow(),
    unlinkedAt: ts('unlinked_at'),
    unlinkedReason: text('unlinked_reason'),
  },
  (t) => [
    uniqueIndex('device_links_active_drms_uq').on(t.drmsEquipmentId).where(sql`unlinked_at is null`),
    uniqueIndex('device_links_active_vantage_uq')
      .on(t.vantageEquipmentId)
      .where(sql`unlinked_at is null`),
  ],
);

export const customerLinks = pgTable('customer_links', {
  id: serial('id').primaryKey(),
  customerErpId: text('customer_erp_id').notNull().unique(),
  vantageCustomerId: integer('vantage_customer_id').notNull(),
  method: text('method', { enum: ['derived', 'manual'] }).notNull(),
  deviceCount: integer('device_count').notNull().default(0),
  linkedBy: integer('linked_by').references(() => users.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const linkIssues = pgTable(
  'link_issues',
  {
    id: serial('id').primaryKey(),
    issueKey: text('issue_key').notNull().unique(),
    type: text('type').notNull(),
    drmsEquipmentId: text('drms_equipment_id'),
    vantageEquipmentId: integer('vantage_equipment_id'),
    details: jsonb('details').notNull().default({}),
    status: text('status', { enum: ['open', 'resolved', 'ignored'] }).notNull().default('open'),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    resolvedBy: integer('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    note: text('note'),
  },
  (t) => [index('link_issues_status_type_idx').on(t.status, t.type)],
);

export const counterSnapshots = pgTable(
  'counter_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    counterId: text('counter_id').notNull(),
    receivedTime: ts('received_time'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    raw: jsonb('raw').notNull(),
  },
  (t) => [
    uniqueIndex('counter_snapshots_device_counter_uq').on(t.drmsEquipmentId, t.counterId),
    index('counter_snapshots_device_received_idx').on(t.drmsEquipmentId, t.receivedTime),
  ],
);

export const counterValues = pgTable(
  'counter_values',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    snapshotId: bigint('snapshot_id', { mode: 'number' })
      .notNull()
      .references(() => counterSnapshots.id, { onDelete: 'cascade' }),
    itemNumber: text('item_number'),
    name: text('name').notNull(),
    value: doublePrecision('value'),
    colorMode: text('color_mode'),
    mode: text('mode'),
  },
  (t) => [
    index('counter_values_snapshot_idx').on(t.snapshotId),
    index('counter_values_name_idx').on(t.name),
  ],
);

export const counterNames = pgTable('counter_names', {
  name: text('name').primaryKey(),
  firstSeen: ts('first_seen').notNull().defaultNow(),
  sampleValue: doublePrecision('sample_value'),
  category: text('category', { enum: ['meter', 'supply', 'other'] }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const deviceAlerts = pgTable(
  'device_alerts',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    type: text('type').notNull(),
    firstDetectedAt: ts('first_detected_at').notNull().defaultNow(),
    lastSeenReportAt: ts('last_seen_report_at'),
    clearedAt: ts('cleared_at'),
    acknowledgedBy: integer('acknowledged_by').references(() => users.id),
    acknowledgedAt: ts('acknowledged_at'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    uniqueIndex('device_alerts_open_uq').on(t.drmsEquipmentId, t.type).where(sql`cleared_at is null`),
    index('device_alerts_type_cleared_idx').on(t.type, t.clearedAt),
  ],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: serial('id').primaryKey(),
    job: text('job').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    status: text('status', { enum: ['running', 'success', 'partial', 'failed'] }).notNull(),
    stats: jsonb('stats').notNull().default({}),
    errorSample: text('error_sample'),
  },
  (t) => [index('sync_runs_job_started_idx').on(t.job, t.startedAt)],
);

export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
