import * as axe from 'axe-core';

/** WCAG 2.1 Level A and AA rules — the conformance target in docs/accessible-data-visualizations.md. */
const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Runs axe-core over rendered markup and returns one readable line per
 * violation, so a failing expectation lists exactly what broke (#206).
 */
export async function axeViolations(element: Element): Promise<string[]> {
  const results = await axe.run(element, { runOnly: { type: 'tag', values: WCAG_21_AA } });
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')} — ${node.failureSummary ?? violation.help}`),
  );
}
