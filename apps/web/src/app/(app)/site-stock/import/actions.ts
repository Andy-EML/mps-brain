'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { parseCsv, validateImport, type ImportError } from '@mps/core';
import { SiteStockError, applyImport, previewImport, type ImportPreviewRow } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { decodeImportRows, encodeImportRows, importResultParam, uploadProblem } from '@/lib/site-stock-import';

/**
 * `/site-stock/import`: *Preview* reads the uploaded CSV and says what each row would do; *Apply*
 * writes it. Both call `requireUser()` first — an action is a public POST endpoint — and Apply
 * takes the user id from the session, never the form. Preview writes nothing.
 */

export interface ImportPreviewState {
  /** The upload itself was unusable (no file, not .csv, too big). */
  fileError?: string;
  fileName?: string;
  /** Problems `validateImport` found; the file cannot be applied until they are fixed. */
  errors?: ImportError[];
  preview?: ImportPreviewRow[];
  /** The validated rows for Apply's hidden field; only set when nothing in the preview is an error. */
  payload?: string;
}

export interface ImportApplyState {
  error?: string;
}

/** UTF-8 (our export, Excel's "CSV UTF-8"); Excel's plain "CSV" is Windows-1252, so fall back to that. */
function decodeUpload(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export async function previewImportAction(_prev: ImportPreviewState, formData: FormData): Promise<ImportPreviewState> {
  await requireUser();
  const file = formData.get('file');
  const problem = uploadProblem(file);
  if (problem || !(file instanceof File)) return { fileError: problem ?? 'Choose a CSV file to import.' };

  const fileName = file.name;
  const text = decodeUpload(await file.arrayBuffer());

  const { rows, errors } = validateImport(parseCsv(text));
  if (errors.length > 0) return { fileName, errors };
  if (rows.length === 0) return { fileName, fileError: 'The file has a header but no rows to import.' };

  const preview = await previewImport(getDb(), rows);
  const ok = preview.every((p) => p.action !== 'error');
  return { fileName, preview, payload: ok ? encodeImportRows(rows) : undefined };
}

export async function applyImportAction(_prev: ImportApplyState, formData: FormData): Promise<ImportApplyState> {
  const user = await requireUser();
  const rows = decodeImportRows(formData.get('rows'));
  if (!rows) return { error: 'The preview could not be read back. Upload the file again.' };

  let result: Awaited<ReturnType<typeof applyImport>>;
  try {
    result = await applyImport(getDb(), { rows, userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) {
      // applyImport re-checks inside its transaction, so this is something that changed since the preview.
      return { error: `Nothing was imported: something changed since the preview (${err.message.replace(/\.$/, '')}). Upload the file again.` };
    }
    throw err;
  }
  // The list, every shelf page, and the device pages that show a shelf badge.
  revalidatePath('/site-stock', 'layout');
  revalidatePath('/devices', 'layout');
  redirect(`/site-stock?imported=${importResultParam(result)}`);
}
