import { llm } from '@grafana/llm';

import { GeneratedPanelSpec, SUPPORTED_PANEL_TYPES, SupportedPanelType } from './types';

/**
 * Asks the LLM (via the grafana-llm-app proxy) to turn a natural-language
 * request plus a ClickHouse schema into a {@link GeneratedPanelSpec}.
 */
export async function generatePanelSpec(userPrompt: string, schema: string): Promise<GeneratedPanelSpec> {
  const response = await llm.chatCompletions({
    model: llm.Model.LARGE,
    temperature: 0,
    messages: [
      { role: 'system', content: buildSystemPrompt(schema) },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '';
  return parseSpec(content);
}

function buildSystemPrompt(schema: string): string {
  const panelTypes = SUPPORTED_PANEL_TYPES.map((t) => `"${t}"`).join(' | ');

  return [
    'You convert a natural-language request into a single Grafana panel backed by a ClickHouse SQL query.',
    'Return ONLY a JSON object — no markdown fences, no commentary — matching this shape:',
    '{',
    `  "panelType": ${panelTypes},`,
    '  "title": "short human-readable panel title",',
    '  "rawSql": "a valid ClickHouse SQL query",',
    '  "timeFrom": "optional Grafana time expression like now-30d",',
    '  "timeTo": "optional Grafana time expression like now"',
    '}',
    '',
    'Rules:',
    '- Use ONLY the tables and columns from the schema below. Never invent names.',
    '- For "piechart": select a label column and a numeric value column (e.g. category, count()).',
    '- For "timeseries": the first selected column must be a time column, followed by numeric series.',
    '- If the user mentions a time window, apply it BOTH in the SQL WHERE clause and in timeFrom/timeTo.',
    '- Keep the query read-only (SELECT only).',
    '',
    'ClickHouse schema — table(column type, ...):',
    schema || '(schema unavailable — make a best effort, but do not guess exotic names)',
  ].join('\n');
}

/** Parse and validate the raw LLM reply into a typed spec. Exported for tests. */
export function parseSpec(content: string): GeneratedPanelSpec {
  let parsed: Partial<GeneratedPanelSpec>;

  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new Error(`The model did not return valid JSON. Raw reply: ${content.slice(0, 200)}`);
  }

  if (!isSupportedPanelType(parsed.panelType)) {
    throw new Error(`Unsupported panel type "${parsed.panelType}".`);
  }

  if (typeof parsed.rawSql !== 'string' || parsed.rawSql.trim() === '') {
    throw new Error('The model response is missing a SQL query.');
  }

  return {
    panelType: parsed.panelType,
    title: parsed.title?.trim() || 'AI panel',
    rawSql: parsed.rawSql.trim(),
    timeFrom: parsed.timeFrom,
    timeTo: parsed.timeTo,
  };
}

function isSupportedPanelType(value: unknown): value is SupportedPanelType {
  return typeof value === 'string' && SUPPORTED_PANEL_TYPES.some((panelType) => panelType === value);
}

/** Strip markdown fences and grab the outermost JSON object. */
function extractJson(content: string): string {
  const stripped = content.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    return stripped;
  }

  return stripped.slice(start, end + 1);
}
