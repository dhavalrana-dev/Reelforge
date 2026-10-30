import type { GenerativeApp } from "./provider";

/**
 * Licences REELFORGE treats as safe for customers' commercial videos without
 * further review. Everything else (community licences with revenue caps,
 * non-commercial, unknown) needs an explicit acceptance per run, because the
 * product promises customers commercial use of what they make.
 */
const PERMISSIVE = [/^MIT$/i, /^Apache-2\.0$/i, /^BSD-[23]-Clause$/i, /^CC-BY-4\.0$/i, /^CC0-1\.0$/i, /^Unlicense$/i, /^ISC$/i];

export function isPermissive(license: string | null): boolean {
  return !!license && PERMISSIVE.some((re) => re.test(license.trim()));
}

/**
 * Apps whose purpose is putting someone's face, body or voice into footage.
 * They are refused unless explicitly allowed, and the person running them is
 * responsible for the consent of everyone shown.
 */
export const SENSITIVE_APP_PATTERNS = [
  /face-?swap/i,
  /character/i,
  /recast/i,
  /motion-transfer/i,
  /influencer/i,
  /^dub$/i,
  /^speak$/i,
  /^talking$/i,
  /headshot/i,
];

export function isSensitive(appId: string): boolean {
  return SENSITIVE_APP_PATTERNS.some((re) => re.test(appId));
}

export interface PolicyOptions {
  /** The caller has reviewed the non-permissive licences listed for this app. */
  acceptLicense?: boolean;
  /** The caller confirms consent for apps that alter a person's likeness or voice. */
  allowSensitive?: boolean;
}

export interface PolicyVerdict {
  allowed: boolean;
  /** Models whose licence needs review before commercial use. */
  reviewLicenses: { name: string; license: string | null }[];
  sensitive: boolean;
  reasons: string[];
}

export function checkPolicy(app: GenerativeApp, opts: PolicyOptions = {}): PolicyVerdict {
  const reviewLicenses = app.models.filter((m) => !isPermissive(m.license)).map((m) => ({ name: m.name, license: m.license }));
  const sensitive = isSensitive(app.id);
  const reasons: string[] = [];
  if (!app.runnable) reasons.push(`${app.id} is not runnable on this server (a draft or without a workflow)`);
  if (reviewLicenses.length && !opts.acceptLicense) {
    const list = reviewLicenses.map((m) => `${m.name} (${m.license ?? "no licence stated"})`).join(", ");
    reasons.push(`models need a licence review for commercial use: ${list}. Pass --accept-license once reviewed`);
  }
  if (sensitive && !opts.allowSensitive) {
    reasons.push(`${app.id} alters a person's likeness or voice; pass --allow-sensitive only with the consent of everyone shown`);
  }
  return { allowed: reasons.length === 0, reviewLicenses, sensitive, reasons };
}
