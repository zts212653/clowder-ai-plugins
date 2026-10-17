export function attachIssueRequirements(plans) {
  for (const [index, plan] of plans.entries()) {
    for (const issue of plan.issues) {
      const closer = plans.findIndex(
        (entry, position) =>
          position >= index &&
          entry.issues.some((other) => other.sourceId === issue.sourceId && other.relation === 'closes'),
      );
      const end = closer < index ? index : closer;
      issue.requiredTargets = plans
        .slice(0, end + 1)
        .filter((entry) => entry.issues.some((other) => other.sourceId === issue.sourceId))
        .map((entry) => entry.target);
    }
  }
}
