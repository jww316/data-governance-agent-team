/**
 * generator.ts — implements the scenarios.yaml generator namespace (IMPLEMENTATION
 * §9). `faker.<provider>` calls the real Faker library; `custom.<helper>` calls a
 * helper defined here. The point of the custom helpers is to slip *undeclared*
 * PII into free text so the Classification agent has something real to catch.
 */

import { faker } from "@faker-js/faker";
import { Scenario, ScenarioField } from "./governance";

export type OutputFormat = "json" | "csv" | "other";

/**
 * Map the Python-Faker-style provider names used in scenarios.yaml to the real
 * faker-js implementation. These ARE real Faker calls — only the provider name
 * differs between the Python and JS ports of the library.
 */
const FAKER_PROVIDERS: Record<string, () => unknown> = {
  email: () => faker.internet.email().toLowerCase(),
  word: () => faker.lorem.word(),
  pydecimal: () => faker.number.float({ min: 0, max: 9999, fractionDigits: 2 }),
  currency_code: () => faker.finance.currencyCode(),
  uuid4: () => faker.string.uuid(),
  name: () => faker.person.fullName(),
};

function callFaker(provider: string): unknown {
  const fn = FAKER_PROVIDERS[provider];
  if (!fn) {
    throw new Error(
      `Unknown faker provider "${provider}". Add it to FAKER_PROVIDERS in lib/generator.ts.`
    );
  }
  return fn();
}

// --- Custom helpers ---------------------------------------------------------

/** custom.pattern: fill '#' -> digit, '?' -> letter from the pattern string. */
function customPattern(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "#") out += String(faker.number.int({ min: 0, max: 9 }));
    else if (ch === "?")
      out += faker.string.alpha({ length: 1, casing: "upper" });
    else out += ch;
  }
  return out;
}

/**
 * custom.contact_sentence: free text with a real-looking email and/or phone
 * embedded — the undeclared PII the Classification agent must detect.
 */
function customContactSentence(): string {
  const email = faker.internet.email().toLowerCase();
  const phone = faker.phone.number({ style: "national" });
  const templates = [
    `Customer wrote in from ${email} and asked us to call them back on ${phone} about the charge.`,
    `Follow-up needed: reached out via ${email}; left a voicemail at ${phone}.`,
    `Spoke with the account holder; preferred contact is ${email} or ${phone} after 5pm.`,
    `Ticket raised by ${email}. Phone on file is ${phone} — confirm before closing.`,
  ];
  return faker.helpers.arrayElement(templates);
}

/** custom.fixed: return the supplied constant `value`. */
function customFixed(field: ScenarioField): unknown {
  return field.value;
}

/** custom.choice: random pick from `options`. */
function customChoice(field: ScenarioField): unknown {
  if (!field.options || field.options.length === 0) {
    throw new Error(`custom.choice on "${field.name}" requires an options list`);
  }
  return faker.helpers.arrayElement(field.options);
}

// --- Field & record generation ----------------------------------------------

function generateField(field: ScenarioField): unknown {
  const [ns, provider] = field.generator.split(".");
  if (ns === "faker") return callFaker(provider);
  if (ns === "custom") {
    switch (provider) {
      case "pattern":
        return customPattern(field.pattern ?? "");
      case "contact_sentence":
        return customContactSentence();
      case "fixed":
        return customFixed(field);
      case "choice":
        return customChoice(field);
      default:
        throw new Error(`Unknown custom helper "${provider}"`);
    }
  }
  throw new Error(`Unknown generator namespace "${ns}" in "${field.generator}"`);
}

export interface GeneratedData {
  records: Record<string, unknown>[];
  fieldMeta: ScenarioField[];
}

/** Generate N rows for a scenario (default ~10). */
export function generateRecords(scenario: Scenario, count = 10): GeneratedData {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};
    for (const field of scenario.fields) {
      row[field.name] = generateField(field);
    }
    records.push(row);
  }
  return { records, fieldMeta: scenario.fields };
}

// --- Output framing ---------------------------------------------------------

export function formatRecords(
  records: Record<string, unknown>[],
  format: OutputFormat
): string {
  if (format === "csv") return toCsv(records);
  // "other" maps to JSON (IMPLEMENTATION.md §9).
  return JSON.stringify(records, null, 2);
}

function toCsv(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const rec of records) {
    lines.push(headers.map((h) => escape(rec[h])).join(","));
  }
  return lines.join("\n");
}
