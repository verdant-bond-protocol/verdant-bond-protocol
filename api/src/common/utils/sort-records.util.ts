/**
 * Deterministic sort for mixed-status records and events (#414).
 *
 * The primary sort key is a caller-supplied status priority map so the
 * ordering contract is explicit rather than depending on enum declaration
 * order (which changes as variants are added).  Secondary key is
 * `createdAt` ascending (oldest first), tertiary is `id` lexicographic —
 * both as tiebreakers that guarantee a stable, reproducible sequence even
 * when two records share status and timestamp.
 */

export interface SortableRecord {
  id: string;
  status: string;
  createdAt: string | Date;
}

/**
 * Sort `records` by (statusPriority[status] ASC, createdAt ASC, id ASC).
 *
 * Statuses absent from `statusPriority` are sorted after all known statuses
 * (priority = Infinity) to avoid silent data loss when new variants arrive.
 *
 * Returns a new array; does not mutate the input.
 */
export function sortRecords<T extends SortableRecord>(
  records: T[],
  statusPriority: Record<string, number>,
): T[] {
  return [...records].sort((a, b) => {
    const pa = statusPriority[a.status] ?? Infinity;
    const pb = statusPriority[b.status] ?? Infinity;
    if (pa !== pb) return pa - pb;

    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return ta - tb;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Bond-specific status priority used by the bonds list endpoint. */
export const BOND_STATUS_PRIORITY: Record<string, number> = {
  Active:    0,
  Pending:   1,
  Matured:   2,
  Cancelled: 3,
  Archived:  4,
};
