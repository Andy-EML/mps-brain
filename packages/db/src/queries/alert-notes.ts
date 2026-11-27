import { pickContactPhone, type ContactPhone, type PhoneSource } from '@mps/core';
import { and, asc, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { vantageAlertNotes, vantageCustomerPeople, vantageCustomers, vantageEquipment } from '../schema';

/** A note the keyword search has not found for this many days is gone (no longer an alert, or deleted). */
export const ALERT_NOTE_STALE_DAYS = 7;

export interface AlertNoteRow {
  noteId: number;
  /** `Customer` notes are the customer's; `Equipment` ones belong to the machine itself. */
  parentType: 'Customer' | 'Equipment';
  parentReference: string | null;
  text: string | null;
  loggedDate: Date | null;
  loggedBy: string | null;
}

/** One live site contact (`vantage_customer_people`). */
export interface ContactPersonRow {
  personId: number;
  fullName: string | null;
  role: string | null;
  phone: string | null;
  extension: string | null;
  mobile: string | null;
  email: string | null;
  isPrimary: boolean;
}

/** Phone, alert notes and site contacts for one customer, or for a machine plus its customer. */
export interface ContactInfo {
  vantageCustomerId: number | null;
  /**
   * The site's `raw->>'PhoneNumber'`, trimmed, or when that is empty its head office's
   * (`phoneSource` says which); null when neither has one.
   */
  phone: string | null;
  phoneSource: PhoneSource | null;
  alerts: AlertNoteRow[];
  /** The site's live contacts, primary first, then by name. Never the head office's people. */
  contacts: ContactPersonRow[];
}

const columns = {
  noteId: vantageAlertNotes.noteId,
  parentType: vantageAlertNotes.parentType,
  parentReference: vantageAlertNotes.parentReference,
  text: vantageAlertNotes.text,
  loggedDate: vantageAlertNotes.loggedDate,
  loggedBy: vantageAlertNotes.loggedBy,
};

function freshSince(now: Date): Date {
  return new Date(now.getTime() - ALERT_NOTE_STALE_DAYS * 86_400_000);
}

/** The customer's own alert notes (not its machines'), newest first. */
export async function getCustomerAlerts(db: Db, vantageCustomerId: number, now: Date = new Date()): Promise<AlertNoteRow[]> {
  return db
    .select(columns)
    .from(vantageAlertNotes)
    .where(
      and(
        eq(vantageAlertNotes.parentType, 'Customer'),
        eq(vantageAlertNotes.parentId, vantageCustomerId),
        gte(vantageAlertNotes.lastSeenAt, freshSince(now)),
      ),
    )
    .orderBy(sql`${vantageAlertNotes.loggedDate} desc nulls last`, desc(vantageAlertNotes.noteId));
}

/**
 * A machine's alert notes plus its customer's (the customer from `vantage_equipment`), the
 * machine's own first, each newest first.
 */
export async function getDeviceAlerts(
  db: Db,
  { vantageEquipmentId }: { vantageEquipmentId: number },
  now: Date = new Date(),
): Promise<AlertNoteRow[]> {
  const customerId = await equipmentCustomerId(db, vantageEquipmentId);
  return deviceAlerts(db, vantageEquipmentId, customerId, now);
}

async function equipmentCustomerId(db: Db, vantageEquipmentId: number): Promise<number | null> {
  const [eqRow] = await db
    .select({ customerId: vantageEquipment.vantageCustomerId })
    .from(vantageEquipment)
    .where(eq(vantageEquipment.vantageId, vantageEquipmentId));
  return eqRow?.customerId ?? null;
}

async function deviceAlerts(db: Db, vantageEquipmentId: number, customerId: number | null, now: Date): Promise<AlertNoteRow[]> {
  const own = and(eq(vantageAlertNotes.parentType, 'Equipment'), eq(vantageAlertNotes.parentId, vantageEquipmentId));
  const parent =
    customerId === null ? own : or(own, and(eq(vantageAlertNotes.parentType, 'Customer'), eq(vantageAlertNotes.parentId, customerId)));
  return db
    .select(columns)
    .from(vantageAlertNotes)
    .where(and(parent, gte(vantageAlertNotes.lastSeenAt, freshSince(now))))
    .orderBy(
      sql`case when ${vantageAlertNotes.parentType} = 'Equipment' then 0 else 1 end`,
      sql`${vantageAlertNotes.loggedDate} desc nulls last`,
      desc(vantageAlertNotes.noteId),
    );
}

/** The phone number on the Vantage customer record, trimmed; null when missing or blank. */
export async function getCustomerPhone(db: Db, vantageCustomerId: number): Promise<string | null> {
  const [row] = await db
    .select({ phone: sql<string | null>`nullif(btrim(${vantageCustomers.raw}->>'PhoneNumber'), '')` })
    .from(vantageCustomers)
    .where(eq(vantageCustomers.vantageId, vantageCustomerId));
  return row?.phone ?? null;
}

const headOffice = alias(vantageCustomers, 'head_office');
const trimmedPhone = (raw: AnyPgColumn) => sql<string | null>`nullif(btrim(${raw}->>'PhoneNumber'), '')`;
/** `raw->'HeadOfficeId'` as an int, only when Vantage sent a number. */
const headOfficeIdOf = (raw: AnyPgColumn) =>
  sql<number | null>`case when jsonb_typeof(${raw}->'HeadOfficeId') = 'number' then (${raw}->>'HeadOfficeId')::int end`;

/**
 * The number to show for a customer (a site): its own, else its head office's (`HeadOfficeId`),
 * labelled. Null when neither has one or the customer is not synced. See `pickContactPhone`.
 */
export async function getContactPhone(db: Db, vantageCustomerId: number): Promise<ContactPhone | null> {
  const [row] = await db
    .select({
      sitePhone: trimmedPhone(vantageCustomers.raw),
      headOfficeId: headOfficeIdOf(vantageCustomers.raw),
      headOfficePhone: trimmedPhone(headOffice.raw),
    })
    .from(vantageCustomers)
    .leftJoin(headOffice, eq(headOffice.vantageId, headOfficeIdOf(vantageCustomers.raw)))
    .where(eq(vantageCustomers.vantageId, vantageCustomerId));
  if (!row) return null;
  return pickContactPhone({ customerId: vantageCustomerId, ...row });
}

/** The site's live contacts (not deleted), primary first, then by name. */
export async function getCustomerPeople(db: Db, vantageCustomerId: number): Promise<ContactPersonRow[]> {
  return db
    .select({
      personId: vantageCustomerPeople.personId,
      fullName: vantageCustomerPeople.fullName,
      role: vantageCustomerPeople.role,
      phone: vantageCustomerPeople.phone,
      extension: vantageCustomerPeople.extension,
      mobile: vantageCustomerPeople.mobile,
      email: vantageCustomerPeople.email,
      isPrimary: vantageCustomerPeople.isPrimary,
    })
    .from(vantageCustomerPeople)
    .where(and(eq(vantageCustomerPeople.customerId, vantageCustomerId), isNull(vantageCustomerPeople.deletedAt)))
    .orderBy(
      desc(vantageCustomerPeople.isPrimary),
      sql`lower(${vantageCustomerPeople.fullName}) asc nulls last`,
      asc(vantageCustomerPeople.personId),
    );
}

async function siteContact(db: Db, customerId: number | null): Promise<Pick<ContactInfo, 'phone' | 'phoneSource' | 'contacts'>> {
  if (customerId === null) return { phone: null, phoneSource: null, contacts: [] };
  const [phone, contacts] = await Promise.all([getContactPhone(db, customerId), getCustomerPeople(db, customerId)]);
  return { phone: phone?.phone ?? null, phoneSource: phone?.source ?? null, contacts };
}

/** Customer page: its phone (or its head office's), its own alert notes and its contacts. */
export async function getCustomerContact(db: Db, vantageCustomerId: number, now: Date = new Date()): Promise<ContactInfo> {
  const [site, alerts] = await Promise.all([siteContact(db, vantageCustomerId), getCustomerAlerts(db, vantageCustomerId, now)]);
  return { vantageCustomerId, phone: site.phone, phoneSource: site.phoneSource, alerts, contacts: site.contacts };
}

/**
 * Device views: the machine's customer's phone (or its head office's) and contacts, and the
 * machine's plus the customer's alert notes.
 */
export async function getDeviceContact(
  db: Db,
  { vantageEquipmentId }: { vantageEquipmentId: number },
  now: Date = new Date(),
): Promise<ContactInfo> {
  const customerId = await equipmentCustomerId(db, vantageEquipmentId);
  const [site, alerts] = await Promise.all([siteContact(db, customerId), deviceAlerts(db, vantageEquipmentId, customerId, now)]);
  return { vantageCustomerId: customerId, phone: site.phone, phoneSource: site.phoneSource, alerts, contacts: site.contacts };
}
