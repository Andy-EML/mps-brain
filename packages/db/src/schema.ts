import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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

export type SettingScope = 'default' | 'customer' | 'device';
export type ReplenishColour = 'black' | 'cyan' | 'magenta' | 'yellow' | 'waste';
export type ProposalTrigger = 'threshold' | 'alarm' | 'site_stock';
export type ProposalStatus = 'pending' | 'approved' | 'ordered' | 'failed' | 'rejected' | 'superseded';
export type OrderStatus = 'queued' | 'submitting' | 'submitted' | 'failed' | 'uncertain';

/**
 * Replenishment settings, cascading default → customer → device. A null column means "inherit";
 * the single `default` row (seeded by migration 0007) has no nulls. The cascade is resolved in one
 * place, `effectiveSettingsSubquery` (queries/settings.ts), never re-expressed elsewhere.
 *
 * A device's customer is the **Vantage** customer of its linked equipment, so `vantage_customer_id`
 * is the customer key; an unlinked device skips the customer level.
 */
export const replenishmentSettings = pgTable(
  'replenishment_settings',
  {
    id: serial('id').primaryKey(),
    scope: text('scope', { enum: ['default', 'customer', 'device'] }).notNull(),
    vantageCustomerId: integer('vantage_customer_id'),
    drmsEquipmentId: text('drms_equipment_id').references(() => drmsEquipment.drmsId),
    thresholdBlack: integer('threshold_black'),
    thresholdCyan: integer('threshold_cyan'),
    thresholdMagenta: integer('threshold_magenta'),
    thresholdYellow: integer('threshold_yellow'),
    autoReplenish: boolean('auto_replenish'),
    alertsEnabled: boolean('alerts_enabled'),
    updatedBy: integer('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replenishment_settings_default_uq').on(t.scope).where(sql`scope = 'default'`),
    uniqueIndex('replenishment_settings_customer_uq').on(t.vantageCustomerId).where(sql`scope = 'customer'`),
    uniqueIndex('replenishment_settings_device_uq').on(t.drmsEquipmentId).where(sql`scope = 'device'`),
    check(
      'replenishment_settings_scope_key',
      sql`(scope = 'default' and vantage_customer_id is null and drms_equipment_id is null)
       or (scope = 'customer' and vantage_customer_id is not null and drms_equipment_id is null)
       or (scope = 'device' and drms_equipment_id is not null and vantage_customer_id is null)`,
    ),
    check(
      'replenishment_settings_threshold_range',
      sql`coalesce(threshold_black, 0) between 0 and 100 and coalesce(threshold_cyan, 0) between 0 and 100
       and coalesce(threshold_magenta, 0) between 0 and 100 and coalesce(threshold_yellow, 0) between 0 and 100`,
    ),
  ],
);

/** Who changed what. One row per write — a bulk edit of 400 devices is one row listing 400 ids. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: integer('user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityIds: jsonb('entity_ids').notNull().default([]),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [index('audit_log_entity_at_idx').on(t.entity, t.at)],
);

/** Sent (or to be sent) to Vantage as one CreateConsumableOrder call: one device, 1..n components. */
export const replenishmentOrders = pgTable(
  'replenishment_orders',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id').notNull(),
    status: text('status', { enum: ['queued', 'submitting', 'submitted', 'failed', 'uncertain'] }).notNull(),
    /** Exactly the body POSTed (or about to be). */
    request: jsonb('request').notNull(),
    response: jsonb('response'),
    vantageSalesOrderId: integer('vantage_sales_order_id'),
    vantageReference: text('vantage_reference'),
    isOnHold: boolean('is_on_hold'),
    error: text('error'),
    createdBy: integer('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    submittedAt: ts('submitted_at'),
    /** Set when an operator settles an `uncertain` order by hand. */
    resolvedBy: integer('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    index('replenishment_orders_status_idx').on(t.status),
    index('replenishment_orders_device_idx').on(t.drmsEquipmentId, t.createdAt),
  ],
);

/** A cartridge family: the models that share one set of cartridges (spec: site stock, "Data"). */
export const cartridgeFamilies = pgTable('cartridge_families', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  isColour: boolean('is_colour').notNull(),
  /** Rated page yield per consumable; null when unknown. */
    ratedYieldBlack: integer('rated_yield_black'),
    ratedYieldCyan: integer('rated_yield_cyan'),
    ratedYieldMagenta: integer('rated_yield_magenta'),
    ratedYieldYellow: integer('rated_yield_yellow'),
    ratedYieldWaste: integer('rated_yield_waste'),
  notes: text('notes'),
  updatedBy: integer('updated_by').references(() => users.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Exact `drms_equipment.model_name` to family. */
export const cartridgeFamilyModels = pgTable('cartridge_family_models', {
  model: text('model').primaryKey(),
  familyId: integer('family_id')
    .notNull()
    .references(() => cartridgeFamilies.id, { onDelete: 'cascade' }),
});

/** Cartridges held on a customer's shelf, per family; one row per customer + family. */
export const siteStockShelves = pgTable(
  'site_stock_shelves',
  {
    id: serial('id').primaryKey(),
    vantageCustomerId: integer('vantage_customer_id').notNull(),
    familyId: integer('family_id')
      .notNull()
      .references(() => cartridgeFamilies.id),
    holdingBlack: integer('holding_black').notNull().default(0),
    holdingCyan: integer('holding_cyan').notNull().default(0),
    holdingMagenta: integer('holding_magenta').notNull().default(0),
    holdingYellow: integer('holding_yellow').notNull().default(0),
    holdingWaste: integer('holding_waste').notNull().default(0),
    usedBlack: integer('used_black').notNull().default(0),
    usedCyan: integer('used_cyan').notNull().default(0),
    usedMagenta: integer('used_magenta').notNull().default(0),
    usedYellow: integer('used_yellow').notNull().default(0),
    usedWaste: integer('used_waste').notNull().default(0),
    countingFrom: ts('counting_from').notNull(),
    createdBy: integer('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedBy: integer('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('site_stock_shelves_customer_family_uq').on(t.vantageCustomerId, t.familyId),
    check(
      'site_stock_shelves_holding',
      sql`holding_black between 0 and 20 and holding_cyan between 0 and 20 and holding_magenta between 0 and 20 and holding_yellow between 0 and 20 and holding_waste between 0 and 20`,
    ),
    check(
      'site_stock_shelves_used',
      sql`used_black >= 0 and used_cyan >= 0 and used_magenta >= 0 and used_yellow >= 0 and used_waste >= 0`,
    ),
  ],
);

/**
 * When a device joined a shelf. Only its alarms from then on count against the shelf, so a device
 * that joins later (model added to the family, relinked, moved customer) brings no old Empties.
 */
export const siteStockMembers = pgTable(
  'site_stock_members',
  {
    shelfId: integer('shelf_id')
      .notNull()
      .references(() => siteStockShelves.id, { onDelete: 'cascade' }),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    since: ts('since').notNull(),
    /** Set when the pair stopped being current (device on no shelf); cleared on return. */
    leftAt: ts('left_at'),
  },
  (t) => [primaryKey({ columns: [t.shelfId, t.drmsEquipmentId] })],
);

/** One row per alarm seen for a shelf, counted or not, so a recount is explainable. */
export const siteStockEvents = pgTable(
  'site_stock_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    shelfId: integer('shelf_id')
      .notNull()
      .references(() => siteStockShelves.id, { onDelete: 'cascade' }),
    alarmId: text('alarm_id').notNull(),
    drmsEquipmentId: text('drms_equipment_id').references(() => drmsEquipment.drmsId),
    colour: text('colour', { enum: ['black', 'cyan', 'magenta', 'yellow', 'waste'] }),
    receivedAt: ts('received_at').notNull(),
    counted: boolean('counted').notNull(),
    reason: text('reason').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('site_stock_events_shelf_alarm_uq').on(t.shelfId, t.alarmId)],
);

/** One per device + colour per episode; see the status table in the spec. */
export const replenishmentProposals = pgTable(
  'replenishment_proposals',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id'),
    colour: text('colour', { enum: ['black', 'cyan', 'magenta', 'yellow', 'waste'] }).notNull(),
    trigger: text('trigger', { enum: ['threshold', 'alarm', 'site_stock'] }).notNull(),
    /** Toner % when proposed; null for waste (DRMS has no waste counter). */
    level: doublePrecision('level'),
    threshold: integer('threshold'),
    alarmId: text('alarm_id'),
    alarmDescription: text('alarm_description'),
    quantity: integer('quantity').notNull().default(1),
    status: text('status', {
      enum: ['pending', 'approved', 'ordered', 'failed', 'rejected', 'superseded'],
    }).notNull(),
    orderId: integer('order_id').references(() => replenishmentOrders.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedBy: integer('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    note: text('note'),
    /** Set for a site-stock top-up; those are live independently of a device's own proposal. */
    shelfId: integer('shelf_id').references(() => siteStockShelves.id),
  },
  (t) => [
    uniqueIndex('replenishment_proposals_live_uq')
      .on(t.drmsEquipmentId, t.colour)
      .where(sql`status in ('pending', 'approved') and shelf_id is null`),
    uniqueIndex('replenishment_proposals_shelf_live_uq')
      .on(t.shelfId, t.colour)
      .where(sql`status in ('pending', 'approved') and shelf_id is not null`),
    index('replenishment_proposals_status_idx').on(t.status, t.createdAt),
    check('replenishment_proposals_quantity', sql`quantity between 1 and 20`),
  ],
);

export type RegistrationStatus = 'awaiting_approval' | 'waiting' | 'approved' | 'registered' | 'failed' | 'rejected';
export const REGISTRATION_STATUSES = ['awaiting_approval', 'waiting', 'approved', 'registered', 'failed', 'rejected'] as const;

/**
 * The DRMS registration queue and its log (spec: "auto-register new machines in DRMS", REVISED).
 *
 * `drms-registration-scan` keeps one live `awaiting_approval` or `waiting` row per Discovered device
 * (upserted every night); a person approves (`approved`) or rejects it; `drms-registration-submit`
 * sends approved rows to DRMS one at a time and records `registered` or `failed`. Every attempt is
 * a row: a retry of a failed registration is a new `approved` row with `retry_requested_*` set,
 * and the failed one stays as history.
 */
export const drmsRegistrations = pgTable(
  'drms_registrations',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    serial: text('serial'),
    deviceName: text('device_name'),
    /** The customer DRMS holds for the device (`CustomerName`); what is sent to DRMS. */
    drmsCustomerName: text('drms_customer_name'),
    vantageEquipmentId: integer('vantage_equipment_id'),
    vantageCustomerId: integer('vantage_customer_id'),
    vantageCustomerName: text('vantage_customer_name'),
    status: text('status', { enum: REGISTRATION_STATUSES }).notNull(),
    /** Why a row is `waiting` (the rule not met yet). */
    reason: text('reason'),
    customerMatch: text('customer_match', { enum: ['match', 'mismatch', 'no_shared_words'] }),
    /** Exactly the `EquipmentRequest/Register` body sent (or to be sent once approved). */
    request: jsonb('request'),
    /** The DRMS equipment request id. Once set, the row is only ever polled — never re-sent. */
    requestId: text('request_id'),
    /** The last DRMS answer: the register response, then the final `EquipmentRequest/{id}`. */
    response: jsonb('response'),
    drmsStatusAfter: text('drms_status_after'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** When the scan last evaluated a live row. */
    checkedAt: ts('checked_at').notNull().defaultNow(),
    decidedBy: integer('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    note: text('note'),
    /** Set just before the POST; with no `request_id` it marks a send whose outcome is unknown. */
    submittedAt: ts('submitted_at'),
    finishedAt: ts('finished_at'),
    retryRequestedBy: integer('retry_requested_by').references(() => users.id),
    retryRequestedAt: ts('retry_requested_at'),
  },
  (t) => [
    uniqueIndex('drms_registrations_live_uq')
      .on(t.drmsEquipmentId)
      .where(sql`status in ('awaiting_approval', 'waiting', 'approved')`),
    index('drms_registrations_status_idx').on(t.status, t.createdAt),
    index('drms_registrations_device_idx').on(t.drmsEquipmentId, t.id),
    check(
      'drms_registrations_status',
      sql`status in ('awaiting_approval', 'waiting', 'approved', 'registered', 'failed', 'rejected')`,
    ),
  ],
);

/**
 * Devices an operator has hidden by hand: out of contract, scrapped, or otherwise no longer ours
 * to look after. Present means hidden; unhiding deletes the row, and `audit_log` keeps the history.
 *
 * A table of its own rather than columns on `drms_equipment`, because the DRMS pull overwrites that
 * table's rows wholesale: a separate row can never be clobbered by an upsert that forgot to protect
 * it. Nothing here is sent to DRMS — hiding is purely an in-app decision. Every list, count, alert
 * and proposal that should ignore a hidden device goes through `notHiddenDevice`
 * (queries/hidden-devices.ts), never its own copy of the test.
 */
export const hiddenDevices = pgTable('hidden_devices', {
  drmsEquipmentId: text('drms_equipment_id')
    .primaryKey()
    .references(() => drmsEquipment.drmsId),
  hiddenBy: integer('hidden_by').references(() => users.id),
  hiddenAt: ts('hidden_at').notNull().defaultNow(),
  reason: text('reason'),
});
