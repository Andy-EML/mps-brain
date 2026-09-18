import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';

export const metadata = { title: 'Fleet overview · MPS Dashboard' };

export default function FleetOverviewPage() {
  return (
    <>
      <PageHeader title="Fleet overview" subtitle="Fleet summary, toner health and the device table." />
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nothing to show yet.
        </CardContent>
      </Card>
    </>
  );
}
