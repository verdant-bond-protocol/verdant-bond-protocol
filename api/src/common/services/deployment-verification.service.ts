export interface DeploymentStep {
  id: string;
  version: string;
  status: 'deployed' | 'failed' | 'rolled_back';
  rollbackTo?: string;
  authorizedBy?: string;
}

export interface RollbackVerification {
  valid: boolean;
  errors: string[];
}

export function verifyRollback(steps: DeploymentStep[]): RollbackVerification {
  const errors: string[] = [];
  const ids = new Set<string>();
  steps.forEach((step) => {
    if (!step.id || ids.has(step.id)) errors.push(`duplicate deployment step: ${step.id || '<missing>'}`);
    ids.add(step.id);
  });
  const failed = steps.find((step) => step.status === 'failed');
  if (failed) {
    const previous = steps[steps.indexOf(failed) - 1];
    if (!previous || previous.status !== 'deployed') errors.push('failed deployment has no deployed rollback target');
    if (failed.rollbackTo !== previous?.version) errors.push('rollback target does not match the previous deployed version');
    if (!failed.authorizedBy) errors.push('rollback authorization is missing');
  }
  return { valid: errors.length === 0, errors };
}
