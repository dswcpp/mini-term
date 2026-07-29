import { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';

export const MARKDOWN_LANGUAGE_CLASS_PATTERN = /^language-[\w#+.-]+$/i;

/** 在 GitHub 默认安全集合上，仅放行受限的 Markdown 代码语言类名。 */
export function createMarkdownSanitizeSchema(baseSchema: SanitizeSchema): SanitizeSchema {
  return {
    ...baseSchema,
    attributes: {
      ...baseSchema.attributes,
      code: [['className', MARKDOWN_LANGUAGE_CLASS_PATTERN]],
    },
  };
}

export const MARKDOWN_SANITIZE_SCHEMA = createMarkdownSanitizeSchema(defaultSchema);
