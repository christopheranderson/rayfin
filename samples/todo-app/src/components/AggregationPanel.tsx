import { useCallback, useEffect, useState } from 'react';

import { useTodos } from '../hooks/useTodos';
import { ServiceContainer } from '../services/ServiceContainer';
import {
  TodoAggregationRow,
  TodoGroupByField,
} from '../services/interfaces/ITodoService';

const GROUP_OPTIONS: { value: TodoGroupByField; label: string }[] = [
  { value: 'priority', label: 'priority' },
  { value: 'isCompleted', label: 'isCompleted' },
  { value: 'none', label: 'none (grand total)' },
];

function formatNumber(value: number | null): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatGroup(
  group: TodoAggregationRow['group'],
  groupBy: TodoGroupByField
): string {
  if (groupBy === 'none') return 'ALL';
  const value = group[groupBy];
  if (value === null || value === undefined) return '(null)';
  return String(value);
}

/**
 * Shows a simple table of grouped `sum`/`avg`/`min`/`max`/`count`
 * aggregations over the current user's todos, using the type-safe GraphQL
 * aggregation API. Results refresh automatically as todos change.
 */
export function AggregationPanel() {
  const { allTodos } = useTodos();

  const [groupBy, setGroupBy] = useState<TodoGroupByField>('priority');
  const [rows, setRows] = useState<TodoAggregationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAggregation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const todoService = ServiceContainer.create().todoService;
      const result = await todoService.aggregateTodos(groupBy);
      setRows(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to run aggregation'
      );
    } finally {
      setLoading(false);
    }
  }, [groupBy]);

  // Re-run whenever the grouping changes or the underlying todos change.
  useEffect(() => {
    void runAggregation();
  }, [runAggregation, allTodos]);

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-gray-900">Aggregations</h2>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Group by
          <select
            value={groupBy}
            disabled={loading}
            onChange={(e) => setGroupBy(e.target.value as TodoGroupByField)}
            className="px-2 py-1 border border-gray-300 rounded-md text-sm"
          >
            {GROUP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border border-gray-200">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Group</th>
              <th className="px-3 py-2 text-right font-semibold">
                count(points)
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                sum(points)
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                avg(percentComplete)
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                min(points)
              </th>
              <th className="px-3 py-2 text-right font-semibold">
                max(points)
              </th>
            </tr>
          </thead>
          <tbody>
            {!rows || rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                  {loading ? 'Loading…' : 'No todos to aggregate yet.'}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {formatGroup(row.group, groupBy)}
                  </td>
                  <td className="px-3 py-2 text-right">{row.countPoints}</td>
                  <td className="px-3 py-2 text-right">
                    {formatNumber(row.sumPoints)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatNumber(row.avgPercentComplete)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatNumber(row.minPoints)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatNumber(row.maxPoints)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
