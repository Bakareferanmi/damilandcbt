// Keep the previous capacity until the corresponding database triggers are installed.
export async function questionBankCapacity(db: D1Database, previous: 70 | 80) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'expanded_question_banks'").first<{ value: string }>();
  return row?.value === '100' ? 100 : previous;
}
