// Stored scores remain counts of correct and assigned questions, including older sittings.
// Convert once at the API boundary so results, slips and exports all use the same marks.
const MARKS_PER_QUESTION = 2;
export function asMarks<T extends { score: number; total: number }>(row: T): T {
  return { ...row, score: row.score * MARKS_PER_QUESTION, total: row.total * MARKS_PER_QUESTION };
}
