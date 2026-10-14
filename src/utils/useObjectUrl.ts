import { useEffect, useState } from "react";

/**
 * A blob: URL for a Blob, revoked when the Blob changes or the component goes.
 *
 * Created inside the effect rather than in a memo: React runs effects twice in
 * development, and a memoised URL revoked by the first cleanup leaves the
 * player pointing at nothing.
 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
