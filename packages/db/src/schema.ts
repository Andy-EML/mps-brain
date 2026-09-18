import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
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

/**
 * Vantage sales orders, pulled read-only by the `vantage-orders` job so the device page can answer
 * "has a toner already gone out, and when?".
 *
 * `completedDate` is the open/closed flag (null = open); `isOnHold` is separate. `typeName` is
 * either `Consumable order` or `Equipment deal`.
 *
 * Deliberately no foreign key to `vantage_equipment`: an order can reference equipment we have not
 * synced (or none at all — `vantageEquipmentId` is often null, with the link only on the lines).
 * Date columns are `timestamptz` like every other `vantage_*` date, so whatever time component
 * Vantage sends survives the round trip and display stays a Europe/London concern.
 */
export const vantageSalesOrders = pgTable(
  'vantage_sales_orders',
  {
    vantageId: integer('vantage_id').primaryKey(),
    reference: text('reference'),
    orderDate: ts('order_date'),
    /** Null while the order is open; set once Vantage completes it. */
    completedDate: ts('completed_date'),
    isOnHold: boolean('is_on_hold'),
    isNonStock: boolean('is_non_stock'),
    typeId: integer('type_id'),
    typeName: text('type_name'),
    /**
     * Set by sub-project 3 for orders this app raises in Vantage, so the dashboard can badge them
     * as "raised here". The pull never overwrites it — see `excluded(..., ['createdByMps'])`.
     */
    createdByMps: boolean('created_by_mps').notNull().default(false),
    vantageEquipmentId: integer('vantage_equipment_id'),
    contractId: integer('contract_id'),
    customerSellToId: integer('customer_sell_to_id'),
    customerShipToId: integer('customer_ship_to_id'),
    raw: jsonb('raw').notNull(),
    modifiedDate: ts('modified_date'),
    deletedDate: ts('deleted_date'),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [index('vantage_sales_orders_equipment_date_idx').on(t.vantageEquipmentId, t.orderDate.desc())],
);

export const vantageSalesOrderLines = pgTable(
  'vantage_sales_order_lines',
  {
    vantageId: integer('vantage_id').primaryKey(),
    salesOrderId: integer('sales_order_id').notNull(),
    /** A line can name the equipment even when the order header does not, so both link paths exist. */
    vantageEquipmentId: integer('vantage_equipment_id'),
    itemId: integer('item_id'),
    itemPartNumber: text('item_part_number'),
    itemDescription: text('item_description'),
    quantity: numeric('quantity'),
    returnedDate: ts('returned_date'),
    /**
     * The line's `Details` free text. Filled in even for `MISC` parts (a machine another reseller
     * supplies), which is why the UI shows it verbatim rather than the item description.
     */
    details: text('details'),
    /** The line's `Comment`, when Vantage sends one. Kept for sub-project 3; not displayed. */
    comment: text('comment'),
    /** Derived on insert by `classifyOrderLine` (@mps/core) so queries need not re-parse text. */
    colour: text('colour'),
    colourSource: text('colour_source'),
    raw: jsonb('raw').notNull(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    index('vantage_sales_order_lines_order_idx').on(t.salesOrderId),
    index('vantage_sales_order_lines_equipment_part_idx').on(t.vantageEquipmentId, t.itemPartNumber),
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
    /**
     * Whether the device prints in colour, derived from `modelName` by `isColourModel` (@mps/core)
     * on every DRMS pull. Stored rather than derived in SQL so the pivot and the fleet counts can
     * filter on it without re-expressing the naming rule in Postgres, and so there is one column to
     * override by hand later if KM ever ships a model the name does not describe.
     *
     * Defaults to false because mono is the safe default: hiding CMY on a colour device loses a
     * reading, while the reverse invents three cartridges the device has never had.
     */
    isColour: boolean('is_colour').notNull().default(false),
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
    /** The operator who unlinked it by hand, from `unlinkDevice`; null for the linker's automatic closes. */
    unlinkedBy: integer('unlinked_by').references(() => users.id),
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
    // Supports the latest-snapshot-per-device pivot (max(id) grouped by device) used by the
    // fleet/devices/device queries.
    index('counter_snapshots_device_id_idx').on(t.drmsEquipmentId, t.id),
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

export const deviceAlarms = pgTable(
  'device_alarms',
  {
    // DRMS `AlarmId` (a Guid) is a natural dedupe key — reruns of an overlapping window just no-op.
    alarmId: text('alarm_id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    receivedTime: ts('received_time').notNull(),
    fcCode: text('fc_code'),
    scCode: text('sc_code'),
    description: text('description'),
    status: text('status'),
    totalCount: bigint('total_count', { mode: 'number' }),
    totalColorCount: bigint('total_color_count', { mode: 'number' }),
    raw: jsonb('raw').notNull(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    // Derived on insert by classifyAlarm() (@mps/core) from fcCode/description, so the UI can
    // filter without re-parsing descriptions.
    category: text('category'),
  },
  (t) => [
    index('device_alarms_device_received_idx').on(t.drmsEquipmentId, t.receivedTime),
    index('device_alarms_category_received_idx').on(t.category, t.receivedTime),
    index('device_alarms_status_idx').on(t.status),
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
