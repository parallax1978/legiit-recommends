"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { suggestCampaignTimezone } from "@/lib/actions/campaigns";

const noop = () => () => {};

/**
 * Rendered for a draft that has no timezone yet: stores the one the browser reports, then
 * reloads the page, whose plan and checklist depend on it. The timezone stays an ordinary
 * setting that can be changed in the editor, and one that is already set is never replaced.
 */
export function SuggestTimezone({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const zone = useSyncExternalStore(
    noop,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );

  useEffect(() => {
    if (!zone) return;
    // Whichever run of this effect stored the timezone, the page has to be read again: in
    // development effects run twice, and the second call finds it already set.
    suggestCampaignTimezone(campaignId, zone)
      .then((stored) => {
        if (stored) router.refresh();
      })
      // Nothing is lost when this fails: the page keeps asking for a timezone, as before.
      .catch(() => undefined);
  }, [campaignId, zone, router]);

  return null;
}
