'use client';

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo, useRef, useState } from 'react';
import styles from './workbench.module.css';
import { type IssueFact, sourceTime } from './workbench-model';

function safeResourceUrl(value: string, sourceUrl: string): string | null {
  try {
    const url = new URL(value, sourceUrl);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeResourceAttribute(element: Element, attr: string, sourceUrl: string) {
  const value = element.getAttribute(attr);
  if (!value) return;
  const url = safeResourceUrl(value, sourceUrl);
  if (url) element.setAttribute(attr, url);
  else element.removeAttribute(attr);
}

// GitHub renders Markdown, including its image and details syntax. Sanitize that
// HTML again at our boundary; repository content never acquires Host UI authority.
export function sanitizeIssueHtml(html: string, sourceUrl: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'pre',
      'code',
      'blockquote',
      'strong',
      'em',
      'del',
      's',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'details',
      'summary',
      'div',
      'span',
      'kbd',
      'sup',
      'sub',
      'input',
      'video',
      'source',
    ],
    ALLOWED_ATTR: [
      'href',
      'src',
      'alt',
      'title',
      'type',
      'checked',
      'disabled',
      'controls',
      'colspan',
      'rowspan',
      'start',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  for (const element of fragment.querySelectorAll('[href], [src]')) {
    normalizeResourceAttribute(element, 'href', sourceUrl);
    normalizeResourceAttribute(element, 'src', sourceUrl);
  }
  for (const link of fragment.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') input.remove();
    else input.setAttribute('disabled', '');
  }
  for (const image of fragment.querySelectorAll('img')) {
    image.setAttribute('loading', 'lazy');
    image.setAttribute('referrerpolicy', 'no-referrer');
  }
  for (const video of fragment.querySelectorAll('video')) {
    video.setAttribute('controls', '');
    video.setAttribute('preload', 'none');
  }
  const holder = document.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

export function IssueContent({ body, html, url }: { body: string; html?: string; url: string }) {
  const sanitized = useMemo(
    () => sanitizeIssueHtml(html ?? marked.parse(body, { async: false, gfm: true }), url),
    [body, html, url],
  );
  return sanitized ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: GitHub HTML is sanitized with an explicit DOMPurify allowlist and URL validation above.
    <div className={styles.discussionMarkdown} dangerouslySetInnerHTML={{ __html: sanitized }} />
  ) : (
    <div className={styles.discussionPlain}>{body}</div>
  );
}

export function IssueDiscussion({
  fact,
  fetchedAt,
  newCommentIds = [],
  loadMore,
}: {
  fact: IssueFact;
  fetchedAt?: string;
  newCommentIds?: string[];
  loadMore?: (all?: boolean) => Promise<void>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState('');
  async function more(all = false) {
    if (!loadMore || loadingMore) return;
    setLoadingMore(true);
    setPageError('');
    try {
      await loadMore(all);
    } catch {
      setPageError('后续评论暂不可用，已读内容仍保留。');
    } finally {
      setLoadingMore(false);
    }
  }
  const bodyRef = useRef<HTMLElement>(null);
  const commentsRef = useRef<HTMLElement>(null);
  const comments = fact.comments;
  const complete = comments !== undefined && comments.length === fact.commentCount;
  return (
    <section aria-label="GitHub 问题与讨论" data-testid="issue-discussion">
      <div className={styles.discussionToolbar}>
        <div className={styles.row}>
          <button type="button" onClick={() => bodyRef.current?.scrollIntoView({ block: 'nearest' })}>
            问题正文
          </button>
          <button type="button" onClick={() => commentsRef.current?.scrollIntoView({ block: 'nearest' })}>
            评论 {fact.commentCount ?? '—'}
          </button>
        </div>
        <span className={styles.muted}>
          {fetchedAt ? `本条讨论核对于 ${sourceTime(fetchedAt)}（北京时间）` : '读取时间未知'} · 非实时
        </span>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: A bounded scrolling region must be keyboard-scrollable. */}
      <section className={styles.discussionReader} tabIndex={0} aria-label="正文和评论阅读区">
        <section ref={bodyRef} aria-label="问题正文" className={styles.discussionPost}>
          <header className={styles.postMeta}>
            <strong>{fact.author ?? '作者未知'}</strong>
            <span className={styles.sourceTag}>楼主 · 正文</span>
            {fact.createdAt && <time dateTime={fact.createdAt}>{sourceTime(fact.createdAt)}</time>}
          </header>
          {fact.body === undefined ? (
            <p className={styles.callout}>正文尚未载入。</p>
          ) : fact.body.trim() ? (
            <IssueContent body={fact.body} html={fact.bodyHTML} url={fact.url} />
          ) : (
            <p className={styles.muted}>作者未填写正文。</p>
          )}
        </section>
        <section ref={commentsRef} aria-label="历史讨论">
          <h3>
            GitHub 评论 · {comments?.length ?? '—'} / {fact.commentCount ?? '—'} 条
          </h3>
          <p className={styles.hint}>
            {complete
              ? '已载入此快照全部可见评论 · 按时间从早到晚'
              : '评论数据尚未完整载入，请勿把缺失内容当成没有讨论。'}
          </p>
          {complete && comments.length === 0 && <p className={styles.empty}>暂无 GitHub 评论。</p>}
          {!complete && loadMore && (
            <div className={styles.row}>
              <button type="button" disabled={loadingMore} onClick={() => void more()}>
                {loadingMore ? '正在加载评论…' : '加载更多评论'}
              </button>
              <button type="button" disabled={loadingMore} onClick={() => void more(true)}>
                加载全部评论
              </button>
            </div>
          )}
          {pageError && <p role="status">{pageError}</p>}
          {comments?.map((comment) => (
            <article key={comment.id} data-comment-id={comment.id} className={styles.discussionPost}>
              {newCommentIds.includes(comment.id) && <span className={styles.pill}>更新后新增</span>}
              <header className={styles.postMeta}>
                <strong>{comment.author}</strong>
                {comment.author === fact.author && <span className={styles.sourceTag}>楼主</span>}
                <time dateTime={comment.createdAt}>{sourceTime(comment.createdAt)}</time>
                {comment.lastEditedAt && <span>已编辑 {sourceTime(comment.lastEditedAt)}</span>}
                <a href={comment.url} target="_blank" rel="noreferrer">
                  原链接 ↗
                </a>
              </header>
              {comment.body.trim() ? (
                <IssueContent body={comment.body} html={comment.bodyHTML} url={comment.url} />
              ) : (
                <p className={styles.muted}>此评论没有可见正文。</p>
              )}
            </article>
          ))}
        </section>
      </section>
    </section>
  );
}
