// Parses ATS location strings such as
//   "Toronto, Ontario, Canada"   "San Francisco, CA • New York, NY • United States"   "Remote - Canada"
export interface ParsedPlace {
  city: string | null;
  region: string | null;
  country: string | null;
}

const COUNTRY_ONLY = /^(united states|usa|u\.s\.|us|canada|united kingdom|uk|germany|france|ireland|india|australia|mexico|brazil|netherlands|spain|singapore|japan|china)$/i;

function parsePlace(segment: string): ParsedPlace {
  const parts = segment.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1) return COUNTRY_ONLY.test(parts[0]) ? { city: null, region: null, country: parts[0] } : { city: parts[0], region: null, country: null };
  if (parts.length === 2) return COUNTRY_ONLY.test(parts[1]) ? { city: parts[0], region: null, country: parts[1] } : { city: parts[0], region: parts[1], country: null };
  return { city: parts[0], region: parts[1], country: parts[parts.length - 1] };
}

export function parseLocationList(raw: string): { primary: ParsedPlace; others: string[]; remote: boolean } {
  const remote = /\bremote\b/i.test(raw);
  const segments = raw
    .split(/\s*(?:[•;|/]|\s-\s|\band\b)\s*/i)
    .map((x) => x.replace(/\(?\bremote\b\)?/gi, "").replace(/^[-–,\s]+|[-–,\s]+$/g, "").trim())
    .filter(Boolean);
  const primary = segments[0] ? parsePlace(segments[0]) : { city: null, region: null, country: null };
  return { primary, others: segments.slice(1), remote };
}
