export function reportWorkflowEvidence(evidence) {
  const stages = (expected) => [
    ...new Set(
      evidence.fetches
        .filter((item) => item.expectedStage === expected)
        .flatMap((item) => item.steps.map((step) => step.stage)),
    ),
  ];
  console.log(
    'Synthetic real-execution phase evidence:',
    JSON.stringify({
      preparationStages: stages(2),
      postMergeStages: stages(5),
      initialUserSteps: evidence.initialUserSteps.size,
      finalUserSteps: evidence.finalUserSteps.size,
      nextPR: evidence.newDelivery.source.number,
      manualSurvivedReload: evidence.manualSurvivedReload,
      newDeliveryInheritedOldExpansion: evidence.newDeliveryInheritedOldExpansion,
    }),
  );
}
