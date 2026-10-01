import { format } from 'date-fns';

import type { Timestamp } from '../../rayfin/data/Timestamp';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface TimestampTableProps {
  timestamps: Timestamp[];
  loading?: boolean;
}

export function TimestampTable({ timestamps, loading }: TimestampTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        Loading timestamps...
      </div>
    );
  }

  if (timestamps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-muted-foreground">No timestamps yet.</p>
        <p className="text-sm text-muted-foreground">
          Click &quot;Send Timestamp&quot; to record your first timestamp.
        </p>
      </div>
    );
  }

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Timestamp</TableHead>
          <TableHead>Created At</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {timestamps.map((ts) => (
          <TableRow key={ts.id}>
            <TableCell className="font-mono text-xs truncate" title={ts.id}>
              {ts.id}
            </TableCell>
            <TableCell className="truncate">
              {format(new Date(ts.timestamp), 'MMM d, yyyy HH:mm:ss')}
            </TableCell>
            <TableCell className="truncate">
              {format(new Date(ts.createdAt), 'MMM d, yyyy HH:mm:ss')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
