const assert = require('node:assert/strict');
const test = require('node:test');

const { MARKDOWN_SANITIZE_SCHEMA } = require('../.tmp-tests/utils/markdownSanitize.js');

async function createMarkdownProcessor() {
  const [
    { unified },
    { default: remarkParse },
    { default: remarkGfm },
    { default: remarkRehype },
    { default: rehypeRaw },
    { default: rehypeSanitize },
  ] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('remark-rehype'),
    import('rehype-raw'),
    import('rehype-sanitize'),
  ]);

  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA);
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function elements(tree, tagName) {
  const matches = [];
  walk(tree, (node) => {
    if (node.type === 'element' && (!tagName || node.tagName === tagName)) matches.push(node);
  });
  return matches;
}

function textContent(node) {
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(textContent).join('');
}

test('Markdown raw HTML is sanitized while supported preview features survive', async () => {
  const processor = await createMarkdownProcessor();
  const markdown = [
    '<script>alert("script-ran")</script>',
    '<a href="javascript:alert(1)" onclick="alert(2)" style="color:red">raw-js</a>',
    '<a href="vbscript:msgbox(1)">raw-vb</a>',
    '<img alt="danger" src="data:text/html;base64,PHNjcmlwdD4=" onerror="alert(3)" style="display:none">',
    '[markdown-js](javascript:alert(4))',
    '![local](./assets/chart.png)',
    '| Name | Value |\n| --- | --- |\n| safe | yes |',
    '- [x] completed',
    '```mermaid\ngraph TD\n  A --> B\n```',
  ].join('\n\n');

  const tree = await processor.run(processor.parse(markdown));
  const allElements = elements(tree);

  assert.equal(elements(tree, 'script').length, 0);
  for (const element of allElements) {
    for (const property of Object.keys(element.properties ?? {})) {
      assert.doesNotMatch(property, /^on/i, `${element.tagName}.${property} must be removed`);
      assert.notEqual(property.toLowerCase(), 'style', `${element.tagName}.style must be removed`);
    }
  }

  const unsafeLinks = elements(tree, 'a').filter((node) =>
    ['raw-js', 'raw-vb', 'markdown-js'].includes(textContent(node)),
  );
  assert.equal(unsafeLinks.length, 3);
  for (const link of unsafeLinks) assert.equal(link.properties.href, undefined);

  const images = elements(tree, 'img');
  const dangerousImage = images.find((node) => node.properties.alt === 'danger');
  const localImage = images.find((node) => node.properties.alt === 'local');
  assert.ok(dangerousImage);
  assert.equal(dangerousImage.properties.src, undefined);
  assert.ok(localImage);
  assert.equal(localImage.properties.src, './assets/chart.png');

  assert.equal(elements(tree, 'table').length, 1);
  const checkbox = elements(tree, 'input').find((node) => node.properties.type === 'checkbox');
  assert.ok(checkbox);
  assert.equal(checkbox.properties.checked, true);
  assert.equal(checkbox.properties.disabled, true);

  const mermaidCode = elements(tree, 'code').find((node) =>
    (node.properties.className ?? []).includes('language-mermaid'),
  );
  assert.ok(mermaidCode);
});
