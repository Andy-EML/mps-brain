// Types only from @mps/db: this renders on the server (customer and device pages) and inside
// client components (the lazy loader for the PM views).
import type { AlertNoteRow, ContactInfo, ContactPersonRow } from '@mps/db/queries';
import { formatPhone, type PhoneSource } from '@mps/core';
import { Mail, Phone, Smartphone, TriangleAlert, User } from 'lucide-react';
import { cn } from 'cn';
import { formatDate } from '@/lib/format';

/** A typed number as a `tel:` link (plain text when it has too few digits to dial). */
function TelLink({ value, extension }: { value: string | null; extension?: string | null }) {
  const p = formatPhone(value);
  if (!p) return null;
  return (
    <>
      {p.href ? (
        <a href={p.href} className="font-medium text-brand hover:underline">
          {p.display}
        </a>
      ) : (
        <span>{p.display}</span>
      )}
      {extension ? <span className="text-muted-foreground"> ext. {extension}</span> : null}
    </>
  );
}

/**
 * The customer's phone number as a `tel:` link, labelled "Head office" when the site has none and
 * this is its head office's; nothing when there is neither.
 */
export function CustomerPhone({ phone, source, className }: { phone: string | null; source?: PhoneSource | null; className?: string }) {
  if (!formatPhone(phone)) return null;
  return (
    <p className={cn('flex items-center gap-1.5 text-[13px]', className)}>
      <Phone aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">Phone </span>
      <TelLink value={phone} />
      {source === 'headOffice' ? <span className="text-[11px] text-muted-foreground">Head office</span> : null}
    </p>
  );
}

/** One contact, compact: name · role, then phone (ext.), mobile and email links on one wrapping line. */
function ContactLine({ person, primary = false }: { person: ContactPersonRow; primary?: boolean }) {
  const hasPhone = formatPhone(person.phone) !== null;
  const hasMobile = formatPhone(person.mobile) !== null;
  return (
    <div className="text-[13px]">
      <p className="flex min-w-0 items-center gap-1.5">
        <User aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('shrink-0', primary && 'font-medium')}>{person.fullName ?? '(no name)'}</span>
        {person.role ? <span className="truncate text-[12px] text-muted-foreground">· {person.role}</span> : null}
        {primary ? <span className="shrink-0 text-[11px] text-muted-foreground">(primary)</span> : null}
      </p>
      {hasPhone || hasMobile || person.email ? (
        <p className="ml-5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {hasPhone ? (
            <span className="inline-flex items-center gap-1">
              <Phone aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="sr-only">Phone </span>
              <TelLink value={person.phone} extension={person.extension} />
            </span>
          ) : null}
          {hasMobile ? (
            <span className="inline-flex items-center gap-1">
              <Smartphone aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="sr-only">Mobile </span>
              <TelLink value={person.mobile} />
            </span>
          ) : null}
          {person.email ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Mail aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <a href={`mailto:${person.email}`} className="truncate text-brand hover:underline">
                {person.email}
              </a>
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The site's Vantage contacts: the primary contact in full, the rest collapsed under "Other
 * contacts (n)" (all of them under "Site contacts (n)" when nobody is primary). Nothing when none.
 */
export function SiteContacts({ contacts, className }: { contacts: ContactPersonRow[]; className?: string }) {
  if (contacts.length === 0) return null;
  const primary = contacts[0]?.isPrimary ? contacts[0] : null;
  const others = primary ? contacts.slice(1) : contacts;
  return (
    <section aria-label="Site contacts" className={cn('space-y-1', className)}>
      {primary ? <ContactLine person={primary} primary /> : null}
      {others.length > 0 ? (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-[12px] text-brand">
            {primary ? 'Other contacts' : 'Site contacts'} ({others.length})
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {others.map((p) => (
              <li key={p.personId}>
                <ContactLine person={p} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * Vantage alert notes (its popups: "call ahead", "no mobile phones on site") in an amber box, with
 * when and by whom each was logged in small text. Nothing when there are none. `showSource` labels
 * each note Machine or Customer — for device views, which show both.
 */
export function AlertNotes({ alerts, showSource = false, className }: { alerts: AlertNoteRow[]; showSource?: boolean; className?: string }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Vantage alert notes" className={cn('rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5', className)}>
      <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-warn">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        {alerts.length === 1 ? 'Vantage alert' : `Vantage alerts (${alerts.length})`}
      </p>
      <ul className="space-y-1.5">
        {alerts.map((a) => (
          <li key={a.noteId} className="text-[13px]">
            <p className="break-words whitespace-pre-line">{a.text?.trim() || '(no text)'}</p>
            <p className="text-[11px] text-muted-foreground">
              {[
                showSource ? (a.parentType === 'Equipment' ? 'Machine' : 'Customer') : null,
                a.loggedDate ? `Logged ${formatDate(a.loggedDate)}` : null,
                a.loggedBy ? `by ${a.loggedBy}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Phone, site contacts and alert notes together; nothing at all when there are none of them. */
export function CustomerContact({
  contact,
  showSource = false,
  className,
}: {
  contact: Pick<ContactInfo, 'phone' | 'phoneSource' | 'alerts' | 'contacts'>;
  showSource?: boolean;
  className?: string;
}) {
  const { phone, phoneSource, alerts, contacts } = contact;
  if (!formatPhone(phone) && alerts.length === 0 && contacts.length === 0) return null;
  return (
    <div className={cn('space-y-2', className)}>
      <CustomerPhone phone={phone} source={phoneSource} />
      <SiteContacts contacts={contacts} />
      <AlertNotes alerts={alerts} showSource={showSource} />
    </div>
  );
}
