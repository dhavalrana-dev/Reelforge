import { writeFile } from "node:fs/promises";
import { FreefieldProvider } from "./freefield";
import { checkPolicy, type PolicyOptions } from "./policy";
import type { GenerativeApp, GenerativeProvider, GenerativeResult, GenerativeRunOptions, GenerativeValue } from "./provider";

export * from "./provider";
export * from "./policy";
export { FreefieldProvider, buildForm, type FreefieldOptions } from "./freefield";

/**
 * The configured provider, or null when generative features are off (the
 * default). Set REELFORGE_FREEFIELD_URL to the Freefield web server, and
 * REELFORGE_FREEFIELD_PASSCODE for a hosted demo.
 */
export function configuredProvider(env: NodeJS.ProcessEnv = process.env): GenerativeProvider | null {
  const url = env.REELFORGE_FREEFIELD_URL;
  if (!url) return null;
  return new FreefieldProvider({ baseUrl: url, passcode: env.REELFORGE_FREEFIELD_PASSCODE || undefined });
}

/**
 * Runs an app after the licence and likeness policy allows it, and writes a
 * provenance record next to each output: provider, app, models with their
 * licences, settings. That record is what a licence review needs later.
 */
export async function generate(
  provider: GenerativeProvider,
  app: GenerativeApp,
  values: Record<string, GenerativeValue>,
  opts: GenerativeRunOptions & PolicyOptions,
): Promise<GenerativeResult & { provenance: string[] }> {
  const verdict = checkPolicy(app, opts);
  if (!verdict.allowed) throw new Error(verdict.reasons.join("\n"));
  const result = await provider.run(app.id, values, opts);
  const provenance: string[] = [];
  for (const out of result.outputs) {
    const file = `${out.path}.provenance.json`;
    await writeFile(
      file,
      JSON.stringify(
        {
          generatedBy: { provider: result.provider, app: app.id, appName: app.name, runId: result.runId },
          createdAt: new Date().toISOString(),
          output: { type: out.type, name: out.name },
          models: app.models,
          licenseReview: verdict.reviewLicenses.length
            ? { acceptedBy: "operator (--accept-license)", models: verdict.reviewLicenses }
            : { required: false },
          likenessConsent: verdict.sensitive ? "confirmed by operator (--allow-sensitive)" : "not applicable",
          values: result.values,
          gpuSeconds: result.seconds,
        },
        null,
        2,
      ),
    );
    provenance.push(file);
  }
  return { ...result, provenance };
}
