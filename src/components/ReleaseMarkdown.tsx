import type { ReactNode } from 'react';

type Props = { source: string };

const safeHref = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

function renderInline(text: string): ReactNode[] {
  // React renders text as text, so raw HTML from release notes is never interpreted.
  const tokenPattern = /(\[[^\]]+\]\([^\s)]+(?:\s+[^)]*)?\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\x60[^\x60]+\x60)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const link = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/.exec(token);
    if (link) {
      const href = safeHref(link[2]);
      nodes.push(href
        ? <a key={key++} href={href} target="_blank" rel="noreferrer" className="text-accent-300 underline decoration-accent-300/40 underline-offset-2 hover:text-accent-200">{link[1]}</a>
        : link[1]);
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      nodes.push(<strong key={key++} className="font-semibold text-zinc-100">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key++}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key++} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.9em] text-accent-200">{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export default function ReleaseMarkdown({ source }: Props) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={key++} className="my-3 break-words leading-6 first:mt-0 last:mb-0">{paragraph.map((line, index) => <span key={index}>{index > 0 && <br />}{renderInline(line)}</span>)}</p>);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const fence = /^\s*```/.exec(line);
    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i++]);
      blocks.push(<pre key={key++} className="my-3 max-w-full overflow-x-auto rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-5 text-zinc-200"><code>{codeLines.join('\n')}</code></pre>);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const classes = level <= 2 ? 'mt-5 mb-2 text-base font-semibold text-white' : 'mt-4 mb-2 text-sm font-semibold text-zinc-100';
      const children = renderInline(heading[2]);
      if (level === 1) blocks.push(<h1 key={key++} className={classes}>{children}</h1>);
      else if (level === 2) blocks.push(<h2 key={key++} className={classes}>{children}</h2>);
      else if (level === 3) blocks.push(<h3 key={key++} className={classes}>{children}</h3>);
      else if (level === 4) blocks.push(<h4 key={key++} className={classes}>{children}</h4>);
      else if (level === 5) blocks.push(<h5 key={key++} className={classes}>{children}</h5>);
      else blocks.push(<h6 key={key++} className={classes}>{children}</h6>);
      continue;
    }

    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      blocks.push(<hr key={key++} className="my-4 border-white/10" />);
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoteLines = [line.replace(/^\s*>\s?/, '')];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quoteLines.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key++} className="my-3 border-l-2 border-accent-400/50 pl-3 text-zinc-400">{quoteLines.map((quoteLine, index) => <p key={index}>{renderInline(quoteLine)}</p>)}</blockquote>);
      continue;
    }

    const unordered = /^\s*[-+*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items = [(unordered || ordered)![1]];
      while (i + 1 < lines.length) {
        const next = isOrdered ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[i + 1]) : /^\s*[-+*]\s+(.+)$/.exec(lines[i + 1]);
        if (!next) break;
        items.push(next[1]);
        i++;
      }
      const itemClass = "my-1 pl-1";
      blocks.push(isOrdered
        ? <ol key={key++} className="my-3 list-decimal space-y-1 pl-5">{items.map((item, index) => <li key={index} className={itemClass}>{renderInline(item)}</li>)}</ol>
        : <ul key={key++} className="my-3 list-disc space-y-1 pl-5">{items.map((item, index) => <li key={index} className={itemClass}>{renderInline(item)}</li>)}</ul>);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return <div className="break-words text-sm leading-6 text-zinc-300">{blocks.length ? blocks : <p>No release notes were added for this version.</p>}</div>;
}
