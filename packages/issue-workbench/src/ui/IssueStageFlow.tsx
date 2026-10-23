import styles from './workbench.module.css';
import { type Stage, stageNames } from './workbench-model';

const mainStages: Stage[] = ['new', 'analyzing', 'review', 'resolved'];
const displayNames = { ...stageNames, resolved: '已验收' };

/** Ordered progress, not an audit trail of visited or completed stages. */
export function IssueStageFlow({ stage }: { stage: Stage }) {
  const currentIndex = mainStages.indexOf(stage === 'waiting' ? 'analyzing' : stage);
  return (
    <section className={styles.stageFlow} aria-label="本地处理路线" data-testid="issue-stage-flow">
      <ol className={styles.stageMain} aria-label="处理阶段进度">
        {mainStages.map((mainStage, index) => {
          const value = mainStage === 'analyzing' && stage === 'waiting' ? 'waiting' : mainStage;
          const position = index < currentIndex ? 'past' : index === currentIndex ? 'current' : 'future';
          return (
            <li
              key={mainStage}
              className={styles.stageNode}
              data-stage={value}
              data-position={position}
              aria-current={position === 'current' ? 'step' : undefined}
            >
              <span className={styles.stageDot} aria-hidden="true" />
              <span aria-hidden="true">{displayNames[value]}</span>
              <span className={styles.srOnly}>
                {stageNames[value]}
                {position === 'current' ? '（当前）' : position === 'past' ? '（前序阶段）' : '（后续阶段）'}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
