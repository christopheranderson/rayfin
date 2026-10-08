import {
  ClockIcon,
  Loader2Icon,
  LogOutIcon,
  RefreshCwIcon,
  SendIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { TimestampTable } from '@/components/TimestampTable';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/AuthContext';
import { useTimestamps } from '@/hooks/useTimestamps';

export function Dashboard() {
  const { user, signOut } = useAuth();
  const { timestamps, loading, error, addTimestamp, refresh } = useTimestamps();
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleSendTimestamp = async () => {
    setIsSending(true);
    try {
      await addTimestamp();
      toast.success('Timestamp sent successfully!');
    } catch {
      toast.error('Failed to send timestamp');
    } finally {
      setIsSending(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refresh();
      toast.success('Timestamps refreshed');
    } catch {
      toast.error('Failed to refresh timestamps');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <ClockIcon className="h-6 w-6" />
            <span className="text-lg font-semibold">Timestamp Tracker</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOutIcon className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto py-8 px-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Your Timestamps</CardTitle>
                <CardDescription>
                  Send timestamps to the database and view your history
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={isRefreshing || loading}
                >
                  {isRefreshing ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="h-4 w-4" />
                  )}
                  <span className="ml-2">Refresh</span>
                </Button>
                <Button
                  size="sm"
                  onClick={handleSendTimestamp}
                  disabled={isSending}
                >
                  {isSending ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : (
                    <SendIcon className="h-4 w-4" />
                  )}
                  <span className="ml-2">Send Timestamp</span>
                </Button>
              </div>
            </div>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <TimestampTable timestamps={timestamps} loading={loading} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
