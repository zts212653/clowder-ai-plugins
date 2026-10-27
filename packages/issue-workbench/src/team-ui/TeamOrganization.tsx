import { memberDescription } from '../classification/member-profile';
import type { TeamSummary } from '../ports/team.js';
import styles from './team.module.css';

export function TeamOrganization({ group, showMembers = false }: { group: TeamSummary['group']; showMembers?: boolean }) {
  if (!group) return null;
  if (group.error) return <p className={styles.notice}>{group.error}</p>;
  if (!group.organization) return null;
  return <section aria-label="GitHub 组织成员">
    <p><a href={`https://github.com/${group.organization}`} target="_blank" rel="noreferrer">
      GitHub 组织：{group.organization} · {group.members.length} 位成员
    </a></p>
    {!group.members.length && <p>组织成员名单为空，请核对组织成员与读取权限后刷新。</p>}
    {showMembers && <ul className={styles.members}>{group.members.map(member => <li key={member}>
      <a href={`https://github.com/${member}`} target="_blank" rel="noreferrer">@{member}</a> · {memberDescription(group.profiles?.find(profile => profile.login === member))}
    </li>)}</ul>}
  </section>;
}
