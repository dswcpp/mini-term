const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];

export function isMarkdownFilePath(path: string) {
  const normalized = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
