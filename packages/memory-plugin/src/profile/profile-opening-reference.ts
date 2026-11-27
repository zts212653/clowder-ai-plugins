import { parse } from 'yaml';
import { z } from 'zod';

const coordinate = z
  .object({
    threadId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    messageId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  })
  .strict();
const excerpt = { text: z.string().trim().min(1).max(600), source: coordinate };
export const profileOpeningReferenceSchema = z
  .object({
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const parsed = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }),
    excerpts: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ ...excerpt, kind: z.literal('relationship') }).strict(),
          z
            .object({ ...excerpt, kind: z.literal('model_capability'), model: z.string().trim().min(1).max(120) })
            .strict(),
        ]),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (value) =>
      [
        ...value.excerpts
          .map((item) => item.text)
          .join('')
          .replace(/\s/g, ''),
      ].length <= 300,
  );

/** A selected part of the existing approved primer, never a new memory or approval owner. */
export function readProfileOpeningReference(content: string) {
  if (content.length > 20_000) return null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter?.[1]) return null;
  try {
    const raw: unknown = parse(frontmatter[1], { maxAliasCount: 0 });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const parsed = profileOpeningReferenceSchema.safeParse((raw as Record<string, unknown>).opening);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ProfileOpeningReference = z.infer<typeof profileOpeningReferenceSchema>;
