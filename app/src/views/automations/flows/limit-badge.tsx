import { GaugeIcon } from "lucide-react";

import { Tip } from "@/components/tip";
import { Badge } from "@/components/ui/badge";
import { refusedLabel } from "@/lib/flows";

// LimitBadge says, while a flow's runs-per-hour limit is refusing its
// starts, how many it refused in the last hour, with the latest in its tip.
// Nothing once the hour holds none.
export function LimitBadge({ refused, last }: { refused?: number; last?: string }) {
  if (!refused) return null;
  return (
    <Tip label={last ? `Last refused ${new Date(last).toLocaleString()}` : "Refused by the runs-per-hour limit"}>
      <Badge variant="warning" size="sm" className="shrink-0" data-testid="flow-limit-badge">
        <GaugeIcon />
        {refusedLabel(refused)}
      </Badge>
    </Tip>
  );
}
